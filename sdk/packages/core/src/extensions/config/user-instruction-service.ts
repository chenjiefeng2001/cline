import { createHash } from "node:crypto";
import type { AgentExtension } from "@cline/shared";
import type { SkillsExecutorWithMetadata } from "../tools";
import {
	type AvailableRuntimeCommand,
	listAvailableRuntimeCommandsFromWatcher,
	resolveRuntimeSlashCommandFromWatcher,
} from "./runtime-commands";
import {
	type CreateUserInstructionConfigWatcherOptions,
	createUserInstructionConfigWatcher,
	type UserInstructionConfig,
	type UserInstructionConfigType,
	type UserInstructionConfigWatcher,
} from "./user-instruction-config-loader";
import {
	type CreateUserInstructionPluginOptions,
	createUserInstructionPlugin,
	createUserInstructionSkillsExecutor,
	getConfiguredSkillsFromWatcher,
} from "./user-instruction-plugin";

export interface UserInstructionConfigRecord<
	TConfig extends UserInstructionConfig = UserInstructionConfig,
> {
	type: UserInstructionConfigType;
	id: string;
	filePath: string;
	contentHash?: string;
	item: TConfig;
}

export interface UserInstructionSourceReference {
	readonly version: 1;
	readonly algorithm: "sha256";
	readonly digest: string;
}

export interface UserInstructionSourceItem {
	readonly name: string;
	readonly description?: string;
	readonly disabled?: boolean;
	readonly instructions: string;
}

export interface UserInstructionSourceRecord<
	TItem extends UserInstructionSourceItem = UserInstructionSourceItem,
> {
	type: UserInstructionConfigType;
	id: string;
	contentHash: string;
	item: TItem;
}

export interface UserInstructionSourceReader {
	getSnapshot(
		type: UserInstructionConfigType,
	): ReadonlyMap<string, { readonly item: UserInstructionSourceItem }>;
}

export interface UserInstructionSourceSnapshot
	extends UserInstructionSourceReader {
	getSnapshot(
		type: UserInstructionConfigType,
	): ReadonlyMap<string, UserInstructionSourceRecord>;
	readonly reference: UserInstructionSourceReference;
}

function createSourceReference(
	groups: ReadonlyArray<{
		type: UserInstructionConfigType;
		records: ReadonlyArray<{ id: string; contentHash: string }>;
	}>,
): UserInstructionSourceReference {
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				domain: "cline.user-instruction-source-reference.v1",
				groups,
			}),
		)
		.digest("hex");
	return Object.freeze({
		version: 1,
		algorithm: "sha256",
		digest,
	});
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value && typeof value === "object" && !seen.has(value)) {
		seen.add(value);
		for (const nested of Object.values(value)) {
			deepFreeze(nested, seen);
		}
		Object.freeze(value);
	}
	return value;
}

function freezeSourceItem(
	item: UserInstructionConfig,
): UserInstructionSourceItem {
	const description = "description" in item ? item.description : undefined;
	return deepFreeze({
		name: item.name,
		description,
		disabled: item.disabled,
		instructions: item.instructions,
	});
}

export interface CreateUserInstructionConfigServiceOptions
	extends CreateUserInstructionConfigWatcherOptions {}

export interface UserInstructionConfigService {
	start(): Promise<void>;
	stop(): void;
	refreshType(type: UserInstructionConfigType): Promise<void>;
	listRecords<TConfig extends UserInstructionConfig = UserInstructionConfig>(
		type: UserInstructionConfigType,
	): UserInstructionConfigRecord<TConfig>[];
	listRuntimeCommands(): AvailableRuntimeCommand[];
	resolveRuntimeSlashCommand(input: string): string;
	hasConfiguredSkills(allowedSkillNames?: ReadonlyArray<string>): boolean;
	getSourceReference?(
		types: ReadonlyArray<UserInstructionConfigType>,
	): UserInstructionSourceReference | undefined;
	captureSourceSnapshot?(
		types: ReadonlyArray<UserInstructionConfigType>,
	): UserInstructionSourceSnapshot | undefined;
	createSkillsExecutor?(
		allowedSkillNames?: ReadonlyArray<string>,
		sourceReader?: UserInstructionSourceReader,
	): SkillsExecutorWithMetadata;
	createExtension(
		options: Omit<
			CreateUserInstructionPluginOptions,
			"watcher" | "watcherReady"
		>,
		sourceReader?: UserInstructionSourceReader,
	): AgentExtension;
}

class DefaultUserInstructionConfigService
	implements UserInstructionConfigService
{
	private readonly watcher: UserInstructionConfigWatcher;
	private ready: Promise<void> | undefined;
	private stopped = false;

	constructor(options?: CreateUserInstructionConfigServiceOptions) {
		this.watcher = createUserInstructionConfigWatcher(options);
	}

	start(): Promise<void> {
		if (!this.ready) {
			this.stopped = false;
			this.ready = this.watcher.start();
		}
		return this.ready;
	}

	stop(): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.watcher.stop();
		this.ready = undefined;
	}

	async refreshType(type: UserInstructionConfigType): Promise<void> {
		await this.start();
		await this.watcher.refreshType(type);
	}

	listRecords<TConfig extends UserInstructionConfig = UserInstructionConfig>(
		type: UserInstructionConfigType,
	): UserInstructionConfigRecord<TConfig>[] {
		return [...this.watcher.getSnapshot(type).entries()].map(
			([id, record]) => ({
				type,
				id,
				filePath: record.filePath,
				contentHash: record.contentHash,
				item: record.item as TConfig,
			}),
		);
	}

	captureSourceSnapshot(
		types: ReadonlyArray<UserInstructionConfigType>,
	): UserInstructionSourceSnapshot | undefined {
		const selectedTypes = [...new Set(types)].sort();
		const allSnapshots = this.watcher.getAllSnapshots();
		const snapshots = new Map<
			UserInstructionConfigType,
			Map<string, UserInstructionSourceRecord>
		>();
		const groups: Array<{
			type: UserInstructionConfigType;
			records: Array<{ id: string; contentHash: string }>;
		}> = [];
		for (const type of selectedTypes) {
			const sourceRecords = [...(allSnapshots.get(type)?.entries() ?? [])];
			const records: UserInstructionSourceRecord[] = [];
			for (const [id, sourceRecord] of sourceRecords) {
				const contentHash = sourceRecord.contentHash;
				if (!contentHash) {
					return undefined;
				}
				records.push(
					Object.freeze({
						type,
						id,
						contentHash,
						item: freezeSourceItem(sourceRecord.item),
					}),
				);
			}
			records.sort((left, right) =>
				left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
			);
			snapshots.set(
				type,
				new Map(records.map((record) => [record.id, record])),
			);
			groups.push({
				type,
				records: records.map(({ id, contentHash }) => ({ id, contentHash })),
			});
		}
		return Object.freeze({
			reference: createSourceReference(groups),
			getSnapshot: (type: UserInstructionConfigType) =>
				new Map(snapshots.get(type) ?? []),
		});
	}

	getSourceReference(
		types: ReadonlyArray<UserInstructionConfigType>,
	): UserInstructionSourceReference | undefined {
		const selectedTypes = [...new Set(types)].sort();
		const groups: Array<{
			type: UserInstructionConfigType;
			records: Array<{ id: string; contentHash: string }>;
		}> = [];
		for (const type of selectedTypes) {
			const records: Array<{ id: string; contentHash: string }> = [];
			for (const [id, record] of this.watcher.getSnapshot(type).entries()) {
				if (!record.contentHash) {
					return undefined;
				}
				records.push({ id, contentHash: record.contentHash });
			}
			records.sort((left, right) =>
				left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
			);
			groups.push({ type, records });
		}
		return createSourceReference(groups);
	}

	listRuntimeCommands(): AvailableRuntimeCommand[] {
		return listAvailableRuntimeCommandsFromWatcher(this.watcher);
	}

	resolveRuntimeSlashCommand(input: string): string {
		return resolveRuntimeSlashCommandFromWatcher(input, this.watcher);
	}

	hasConfiguredSkills(allowedSkillNames?: ReadonlyArray<string>): boolean {
		return getConfiguredSkillsFromWatcher(this.watcher, allowedSkillNames).some(
			(skill) => !skill.disabled,
		);
	}

	createSkillsExecutor(
		allowedSkillNames?: ReadonlyArray<string>,
		sourceReader: UserInstructionSourceReader = this.watcher,
	): SkillsExecutorWithMetadata {
		return createUserInstructionSkillsExecutor(
			sourceReader,
			(this.ready ?? Promise.resolve()).catch(() => {}),
			allowedSkillNames,
		);
	}

	createExtension(
		options: Omit<
			CreateUserInstructionPluginOptions,
			"watcher" | "watcherReady"
		>,
		sourceReader: UserInstructionSourceReader = this.watcher,
	): AgentExtension {
		return createUserInstructionPlugin({
			...options,
			watcher: sourceReader,
			watcherReady: (this.ready ?? Promise.resolve()).catch(() => {}),
		});
	}
}

export function createUserInstructionConfigService(
	options?: CreateUserInstructionConfigServiceOptions,
): UserInstructionConfigService {
	return new DefaultUserInstructionConfigService(options);
}
