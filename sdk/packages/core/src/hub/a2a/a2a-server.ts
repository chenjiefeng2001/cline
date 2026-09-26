/**
 * A2A server over the hub bus [roadmap P2-1].
 *
 * Exposes the hub session bus through A2A request semantics (per the P0-3
 * freeze mapping §3): a new message creates a session and then starts a run;
 * an existing task receives `session.send_input`; `tasks/get` maps to
 * `session.get`; `tasks/cancel` maps to `run.abort`; `tasks/list` maps to
 * `session.list`. The Agent Card is built from hub-derived capabilities.
 *
 * Transport-decoupled: handlers accept structural hub command and event clients
 * (`NodeHubClient` and `HubServerTransport` both satisfy them).
 */

import type { HubEventEnvelope } from "@cline/shared";
import { parseRuntimeConfigExtensions } from "@cline/shared";
import { RUNTIME_INTERNAL_RECOVERY_OWNER } from "../../runtime/host/runtime-host";
import {
	buildAgentCard,
	type MapSessionToTaskOptions,
	mapSessionStatusToTaskState,
	mapSessionToTask,
} from "./a2a-mapping";
import {
	type A2AStreamEvent,
	buildArtifactUpdateEvent,
	buildStatusUpdateEvent,
	isTerminalA2ATaskState,
	mapHubEventToStreamDelta,
	parseA2AApprovalDescriptor,
} from "./a2a-sse";
import type { A2AAgentCard, A2AAgentSkill, A2ATask } from "./a2a-types";

export interface A2AHubCommandClient {
	command(
		command:
			| "session.list"
			| "session.create"
			| "session.get"
			| "session.send_input"
			| "run.start"
			| "run.abort"
			| "approval.respond",
		payload?: Record<string, unknown>,
		sessionId?: string,
	): Promise<unknown>;
}

/**
 * Event subscription surface the hub client satisfies (`NodeHubClient` and
 * `HubServerTransport` are both structural matches): a listener on the
 * `HubEventEnvelope` stream scoped to a session.
 */
export interface A2AHubEventClient {
	subscribe(
		listener: (event: HubEventEnvelope) => void,
		options?: { sessionId?: string },
	): () => void;
}

export interface A2AStreamOptions {
	/** Terminal A2A states end the stream; idle streams close after a timeout. */
	idleTimeoutMs?: number;
	onClose?: () => void;
}

export interface A2ASendMessageInput {
	/** User prompt (A2A message parts collapsed to text). */
	prompt: string;
	/** Existing task; when absent a new session/task is created. */
	sessionId?: string;
	/** Session/run options merged with trusted server defaults. */
	config?: Record<string, unknown>;
	/** Source marker for the created session metadata. */
	source?: string;
}

export interface A2AApprovalDecisionInput {
	approvalId: string;
	approved: boolean;
	reason?: string;
	sessionId: string;
}

export interface A2AServerOptions {
	/** Agent Card identity; hub-derived capabilities are always set. */
	agentCard: {
		name: string;
		description?: string;
		url?: string;
		version: string;
		skills?: A2AAgentSkill[];
	};
	defaultSessionConfig?: Record<string, unknown>;
	recoveryOwner?: string;
}

export interface A2APreparedMessage {
	task: A2ATask;
	start: () => Promise<A2ATask>;
}

/** Loose hub session projection used by the handlers. */
interface A2ASessionProjection {
	sessionId: string;
	status?: string;
	conversationId?: string;
	source?: string;
}

function extractPayload(reply: unknown): Record<string, unknown> | undefined {
	if (
		reply &&
		typeof reply === "object" &&
		"payload" in reply &&
		(reply as { payload?: unknown }).payload &&
		typeof (reply as { payload?: unknown }).payload === "object"
	) {
		return (reply as { payload: Record<string, unknown> }).payload;
	}
	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function assertHubCommandSucceeded(reply: unknown, command: string): void {
	const record = asRecord(reply);
	if (!record || record.ok !== false) {
		return;
	}
	const error = asRecord(record.error);
	const message = asString(error?.message);
	throw new Error(`${command} failed${message ? `: ${message}` : ""}`);
}

function extractRunFinishReason(
	payload: Record<string, unknown> | undefined,
): string | undefined {
	return asString(asRecord(payload?.result)?.finishReason);
}

function extractSessionProjection(
	payload: Record<string, unknown> | undefined,
): A2ASessionProjection | undefined {
	const session =
		payload?.session && typeof payload.session === "object"
			? (payload.session as Record<string, unknown>)
			: undefined;
	const sessionId = asString(session?.sessionId);
	if (!session || !sessionId) {
		return undefined;
	}
	const metadata =
		session.metadata && typeof session.metadata === "object"
			? (session.metadata as Record<string, unknown>)
			: undefined;
	return {
		sessionId,
		status: asString(session.status),
		conversationId: asString(metadata?.conversationId),
		source: asString(metadata?.source),
	};
}

export class A2AServer {
	private readonly client: A2AHubCommandClient;
	private readonly events?: A2AHubEventClient;
	private readonly card: A2AAgentCard;
	private readonly defaultSessionConfig: Record<string, unknown>;
	private readonly recoveryOwner?: string;

	constructor(
		client: A2AHubCommandClient,
		options: A2AServerOptions,
		events?: A2AHubEventClient,
	) {
		this.client = client;
		this.events = events;
		this.defaultSessionConfig = options.defaultSessionConfig ?? {};
		this.recoveryOwner = options.recoveryOwner?.trim() || undefined;
		this.card = buildAgentCard({
			...options.agentCard,
			// The card reflects the real capability: without a bound event
			// source `message/stream` fails, so the card must not claim it.
			streaming: events !== undefined,
		});
	}

	/** A2A Agent Card (discovery document). */
	getAgentCard(): A2AAgentCard {
		return this.card;
	}

	async prepareMessage(
		input: A2ASendMessageInput,
	): Promise<A2APreparedMessage | undefined> {
		if (input.sessionId) {
			const task = mapSessionToTask(
				{ sessionId: input.sessionId, status: "running" },
				{ hasPendingApproval: false },
			);
			return task
				? {
						task,
						start: () => this.startMessage(input, "session.send_input", task),
					}
				: undefined;
		}

		const reply = await this.client.command(
			"session.create",
			this.buildSessionCreatePayload(input),
		);
		assertHubCommandSucceeded(reply, "session.create");
		const projection = extractSessionProjection(extractPayload(reply));
		const task = mapSessionToTask(
			projection ? { ...projection, status: "idle" } : undefined,
		);
		return task
			? { task, start: () => this.startMessage(input, "run.start", task) }
			: undefined;
	}

	async sendMessage(input: A2ASendMessageInput): Promise<A2ATask | undefined> {
		const prepared = await this.prepareMessage(input);
		return prepared ? prepared.start() : undefined;
	}

	async respondToApproval(
		input: A2AApprovalDecisionInput,
	): Promise<A2ATask | undefined> {
		const reply = await this.client.command(
			"approval.respond",
			{
				approvalId: input.approvalId,
				approved: input.approved,
				...(input.reason ? { reason: input.reason } : {}),
			},
			input.sessionId,
		);
		assertHubCommandSucceeded(reply, "approval.respond");
		return this.getTask(input.sessionId);
	}

	private buildSessionConfig(input: A2ASendMessageInput): Record<
		string,
		unknown
	> & {
		[RUNTIME_INTERNAL_RECOVERY_OWNER]?: string;
	} {
		const requested = asRecord(input.config) ?? {};
		const config = {
			...this.defaultSessionConfig,
		} as Record<string, unknown> & {
			[RUNTIME_INTERNAL_RECOVERY_OWNER]?: string;
		};
		const trustedConfigExtensions = parseRuntimeConfigExtensions(
			this.defaultSessionConfig.configExtensions,
		);
		const trustedSkills = Array.isArray(this.defaultSessionConfig.skills)
			? this.defaultSessionConfig.skills.filter(
					(skill): skill is string => typeof skill === "string",
				)
			: undefined;
		for (const key of [
			"providerId",
			"modelId",
			"systemPrompt",
			"mode",
			"maxIterations",
			"enableTools",
		] as const) {
			if (requested[key] !== undefined) {
				config[key] = requested[key];
			}
		}
		const trustedRoot =
			asString(this.defaultSessionConfig.cwd) ??
			asString(this.defaultSessionConfig.workspaceRoot);
		if (trustedRoot) {
			config.cwd = trustedRoot;
			config.workspaceRoot = trustedRoot;
		} else {
			delete config.cwd;
			delete config.workspaceRoot;
		}
		config.enableSpawnAgent = false;
		config.enableAgentTeams = false;
		delete config.teamName;
		const metadata = {
			...(asRecord(this.defaultSessionConfig.metadata) ?? {}),
			...(asRecord(requested.metadata) ?? {}),
		};
		for (const key of [
			"prompt",
			"source",
			"provider",
			"model",
			"systemPrompt",
			"teamName",
			"pid",
			"sessionId",
			"workspaceRoot",
		]) {
			delete metadata[key];
		}
		metadata.source = "a2a";
		config.metadata = metadata;
		const sessionConfig: Record<string, unknown> = {
			providerId: config.providerId,
			modelId: config.modelId,
			cwd: config.cwd,
			workspaceRoot: config.workspaceRoot,
			systemPrompt: config.systemPrompt,
			mode: config.mode,
			maxIterations: config.maxIterations,
			enableTools: config.enableTools,
			enableSpawnAgent: false,
			enableAgentTeams: false,
			...(trustedSkills ? { skills: trustedSkills } : {}),
		};
		if (typeof config.apiKey === "string") {
			sessionConfig.apiKey = config.apiKey;
		}
		config.sessionConfig = sessionConfig;
		config.runtimeOptions = {
			enableTools: config.enableTools,
			enableSpawn: false,
			enableTeams: false,
			...(trustedConfigExtensions
				? { configExtensions: trustedConfigExtensions }
				: {}),
			systemPrompt: config.systemPrompt,
			mode: config.mode,
			maxIterations: config.maxIterations,
		};
		if (this.recoveryOwner) {
			config[RUNTIME_INTERNAL_RECOVERY_OWNER] = this.recoveryOwner;
		}
		return config;
	}

	private buildSessionCreatePayload(
		input: A2ASendMessageInput,
	): Record<string, unknown> {
		return this.buildSessionConfig(input);
	}

	private async startMessage(
		input: A2ASendMessageInput,
		command: "session.send_input" | "run.start",
		task: A2ATask,
	): Promise<A2ATask> {
		const reply = await this.client.command(
			command,
			{ ...this.buildSessionConfig(input), prompt: input.prompt },
			task.id,
		);
		assertHubCommandSucceeded(reply, command);
		const finishReason = extractRunFinishReason(extractPayload(reply));
		if (!finishReason) {
			return task;
		}
		const status =
			finishReason === "aborted"
				? "cancelled"
				: finishReason === "error" || finishReason === "failed"
					? "failed"
					: "completed";
		return {
			...task,
			status: {
				...task.status,
				state: mapSessionStatusToTaskState(status),
			},
		};
	}

	/** A2A `tasks/get`: hub session projected onto the A2A lifecycle. */
	async getTask(sessionId: string): Promise<A2ATask | undefined> {
		const reply = await this.client.command(
			"session.get",
			undefined,
			sessionId,
		);
		const payload = extractPayload(reply);
		const projection = extractSessionProjection(payload);
		const approval = parseA2AApprovalDescriptor(payload?.approval);
		return mapSessionToTask(projection, {
			hasPendingApproval:
				payload?.pendingApproval === true || approval !== undefined,
			...(approval ? { approval } : {}),
		});
	}

	/**
	 * A2A `CancelTask`: aborts the hub run (`run.abort`). Returns the task
	 * after the abort; a missing task yields `undefined` (→ TaskNotFound)
	 * and an already-terminal task yields `{ canceled: false }` (→
	 * TaskNotCancelable per v1.0 §3.1.5).
	 */
	async cancelTask(
		sessionId: string,
	): Promise<{ canceled: boolean; task?: A2ATask }> {
		const before = await this.getTask(sessionId);
		if (!before) {
			return { canceled: false };
		}
		if (isTerminalA2ATaskState(before.status.state)) {
			return { canceled: false, task: before };
		}
		await this.client.command("run.abort", { sessionId }, sessionId);
		return { canceled: true, task: (await this.getTask(sessionId)) ?? before };
	}

	/**
	 * A2A `ListTasks`: hub sessions projected onto tasks. `pageSize` bounds
	 * the hub fetch; `contextId`/`status` filter the projected tasks. Hub
	 * sessions carry no cursor pagination, so `totalSize` is the filtered
	 * count and callers must leave `pageToken` empty (the dispatcher rejects
	 * it with InvalidParams).
	 */
	async listTasks(
		options?: {
			pageSize?: number;
			contextId?: string;
			status?: string;
		} & MapSessionToTaskOptions,
	): Promise<A2ATask[]> {
		const reply = await this.client.command("session.list", {
			limit: options?.pageSize ?? 200,
		});
		const sessions = Array.isArray(
			(reply as { payload?: { sessions?: unknown[] } }).payload?.sessions,
		)
			? ((reply as { payload: { sessions: Record<string, unknown>[] } }).payload
					.sessions as Record<string, unknown>[])
			: [];
		const tasks: A2ATask[] = [];
		for (const session of sessions) {
			const projection = extractSessionProjection({ session });
			const task = mapSessionToTask(projection, options);
			if (!task) {
				continue;
			}
			if (options?.contextId && task.contextId !== options.contextId) {
				continue;
			}
			if (options?.status && task.status.state !== options.status) {
				continue;
			}
			tasks.push(task);
		}
		return tasks;
	}

	async streamMessage(
		input: A2ASendMessageInput,
		onEvent: (event: A2AStreamEvent) => void,
		options: A2AStreamOptions = {},
	): Promise<() => void> {
		if (!this.events) {
			options.onClose?.();
			return () => {};
		}
		let prepared: A2APreparedMessage | undefined;
		try {
			prepared = await this.prepareMessage(input);
		} catch (error) {
			options.onClose?.();
			throw error;
		}
		if (!prepared) {
			options.onClose?.();
			return () => {};
		}
		const finish = this.streamTask(
			prepared.task.id,
			prepared.task,
			onEvent,
			options,
		);
		try {
			await prepared.start();
		} catch (error) {
			finish();
			throw error;
		}
		return finish;
	}

	/** Whether an event source was bound at construction (SSE capability). */
	supportsStreaming(): boolean {
		return this.events !== undefined;
	}

	streamTask(
		sessionId: string,
		task: A2ATask,
		onEvent: (event: A2AStreamEvent) => void,
		options: A2AStreamOptions = {},
	): () => void {
		if (!this.events) {
			options.onClose?.();
			return () => {};
		}
		let closed = false;
		let ready = false;
		let unsubscribe: (() => void) | undefined;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const pendingEvents: HubEventEnvelope[] = [];
		const contextId = task.contextId || sessionId;
		let sawArtifactText = false;
		const finish = (): void => {
			if (closed) {
				return;
			}
			closed = true;
			clearTimeout(idleTimer);
			try {
				unsubscribe?.();
			} finally {
				options.onClose?.();
			}
		};
		const emit = (event: A2AStreamEvent, final: boolean): void => {
			if (closed) {
				return;
			}
			try {
				onEvent(event);
			} catch (error) {
				finish();
				throw error;
			}
			if (final) {
				finish();
			}
		};
		const emitArtifact = (text: string, lastChunk: boolean): void => {
			emit(
				buildArtifactUpdateEvent(sessionId, text, {
					contextId,
					append: sawArtifactText,
					lastChunk,
				}),
				false,
			);
			sawArtifactText = true;
		};
		const processHubEvent = (event: HubEventEnvelope): void => {
			if (closed) {
				return;
			}
			armIdleTimer();
			const mapping = mapHubEventToStreamDelta(event.event, event.payload);
			const state = mapping.statusState;
			if (mapping.artifactText !== undefined) {
				emitArtifact(mapping.artifactText, false);
			}
			if (!state) {
				return;
			}
			const final = isTerminalA2ATaskState(state);
			if (final && sawArtifactText) {
				emitArtifact("", true);
			}
			emit(
				buildStatusUpdateEvent(sessionId, state, contextId, mapping.metadata),
				final,
			);
		};
		const armIdleTimer = (): void => {
			if (options.idleTimeoutMs === undefined) {
				return;
			}
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => finish(), options.idleTimeoutMs);
		};
		try {
			unsubscribe = this.events.subscribe(
				(event) => {
					if (closed) {
						return;
					}
					if (
						typeof event.sessionId === "string" &&
						event.sessionId !== sessionId
					) {
						return;
					}
					if (ready) {
						processHubEvent(event);
						return;
					}
					pendingEvents.push(event);
				},
				{ sessionId },
			);
			emit(task, isTerminalA2ATaskState(task.status.state));
			if (closed) {
				return finish;
			}
			ready = true;
			armIdleTimer();
			for (const event of pendingEvents) {
				if (closed) {
					break;
				}
				processHubEvent(event);
			}
			pendingEvents.length = 0;
		} catch (error) {
			finish();
			throw error;
		}
		return finish;
	}
}

export type {
	A2AStreamEvent,
	A2ATaskStatusUpdateEvent,
} from "./a2a-sse";
export type {
	A2AAgentCard,
	A2AAgentSkill,
	A2ATask,
	A2ATaskState,
} from "./a2a-types";
