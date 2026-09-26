import type {
	AgentMode,
	AgentRunBudget,
	RuntimeConfigExtensionKind,
	ToolPolicy,
} from "@cline/shared";
import { normalizeAgentRunBudget } from "@cline/shared";
import type { UserInstructionSourceReference } from "../../extensions/config";
import { hashToolInput } from "../ledger/idempotency-key";

export const RUN_RECOVERY_SNAPSHOT_KIND = "cline.run-recovery";
export const RUN_RECOVERY_SNAPSHOT_VERSION = 1 as const;
export const MAX_RECOVERY_SYSTEM_PROMPT_LENGTH = 64_000;

export type RunRecoveryToolOrigin = "core-builtin" | "unknown";

const RECOVERY_CONFIG_EXTENSIONS = new Set<RuntimeConfigExtensionKind>([
	"rules",
	"skills",
	"workflows",
]);
const MAX_RECOVERY_SKILLS = 64;
const MAX_RECOVERY_SKILL_NAME_LENGTH = 128;

export interface RunRecoveryServerRuntime {
	configExtensions: RuntimeConfigExtensionKind[];
	skills?: string[];
	sourceReference?: UserInstructionSourceReference;
}
export type RunRecoveryIneligibilityReason =
	| "eligible"
	| "client_contribution"
	| "non_root"
	| "team_or_subagent"
	| "a2a"
	| "custom_tool"
	| "parallel_or_ambiguous"
	| "config_unavailable"
	| "unknown_origin";

export interface RunRecoverySnapshot {
	kind: typeof RUN_RECOVERY_SNAPSHOT_KIND;
	version: typeof RUN_RECOVERY_SNAPSHOT_VERSION;
	capturedAt: string;
	sessionId: string;
	source: string;
	recoveryOwner?: string;
	interactive: boolean;
	toolName: string;
	toolOrigin: RunRecoveryToolOrigin;
	clientContributionsPresent: boolean;
	run: {
		runId: string;
		agentId: string;
		conversationId: string;
		iteration: number;
		toolCallIndex: number;
		assistantMessageId: string;
		toolCallId: string;
		approvalId: string;
	};
	preparedInputHash: string;
	transcript: {
		messageCount: number;
		lastMessageId: string;
		transcriptHash: string;
		systemPromptHash: string;
	};
	config: {
		providerId: string;
		modelId: string;
		cwd: string;
		workspaceRoot: string;
		systemPrompt: string;
		mode: AgentMode;
		enableTools: boolean;
		enableSpawnAgent: boolean;
		enableAgentTeams: boolean;
		maxIterations?: number;
		/**
		 * Run budget recorded for the interrupted run, so a resumed run keeps
		 * the guardrail that stopped the original one. Optional and additive.
		 */
		budget?: AgentRunBudget;
		toolExecution: "sequential" | "parallel";
		maxParallelToolCalls?: number;
		toolPolicies?: Record<string, ToolPolicy>;
	};
	serverRuntime?: RunRecoveryServerRuntime;
	eligibility: {
		autoRecover: boolean;
		reason: RunRecoveryIneligibilityReason;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(
			`Run recovery snapshot ${field} must be a non-empty string`,
		);
	}
	return value;
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`Run recovery snapshot ${field} must be boolean`);
	}
	return value;
}

function requireIndex(value: unknown, field: string): number {
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new Error(
			`Run recovery snapshot ${field} must be a non-negative integer`,
		);
	}
	return value as number;
}

function requirePositiveInteger(value: unknown, field: string): number {
	if (
		!Number.isInteger(value) ||
		(value as number) < 1 ||
		(value as number) > 64
	) {
		throw new Error(`Run recovery snapshot ${field} must be a bounded integer`);
	}
	return value as number;
}

function requirePositiveIndex(value: unknown, field: string): number {
	const index = requireIndex(value, field);
	if (index < 1) {
		throw new Error(`Run recovery snapshot ${field} must be positive`);
	}
	return index;
}

function requireReason(value: unknown): RunRecoveryIneligibilityReason {
	if (
		value !== "eligible" &&
		value !== "client_contribution" &&
		value !== "non_root" &&
		value !== "team_or_subagent" &&
		value !== "a2a" &&
		value !== "custom_tool" &&
		value !== "parallel_or_ambiguous" &&
		value !== "config_unavailable" &&
		value !== "unknown_origin"
	) {
		throw new Error("Run recovery snapshot has an invalid eligibility reason");
	}
	return value;
}

export function parseRunRecoveryServerRuntime(
	value: unknown,
): RunRecoveryServerRuntime | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error("Run recovery snapshot serverRuntime must be an object");
	}
	for (const key of Object.keys(value)) {
		if (
			key !== "configExtensions" &&
			key !== "skills" &&
			key !== "sourceReference"
		) {
			throw new Error(
				`Run recovery snapshot serverRuntime contains unsupported field: ${key}`,
			);
		}
	}
	if (!Array.isArray(value.configExtensions)) {
		throw new Error(
			"Run recovery snapshot serverRuntime.configExtensions must be an array",
		);
	}
	if (value.configExtensions.length > 8) {
		throw new Error(
			"Run recovery snapshot serverRuntime.configExtensions is too large",
		);
	}
	const configExtensions: RuntimeConfigExtensionKind[] = [];
	for (const item of value.configExtensions) {
		if (
			typeof item !== "string" ||
			!RECOVERY_CONFIG_EXTENSIONS.has(item as RuntimeConfigExtensionKind)
		) {
			throw new Error(
				"Run recovery snapshot serverRuntime.configExtensions contains an unsupported kind",
			);
		}
		if (!configExtensions.includes(item as RuntimeConfigExtensionKind)) {
			configExtensions.push(item as RuntimeConfigExtensionKind);
		}
	}
	let skills: string[] | undefined;
	if (value.skills !== undefined) {
		if (
			!Array.isArray(value.skills) ||
			value.skills.length > MAX_RECOVERY_SKILLS
		) {
			throw new Error(
				"Run recovery snapshot serverRuntime.skills must be a bounded string array",
			);
		}
		skills = [];
		for (const item of value.skills) {
			if (
				typeof item !== "string" ||
				item.trim().length === 0 ||
				item.length > MAX_RECOVERY_SKILL_NAME_LENGTH
			) {
				throw new Error(
					"Run recovery snapshot serverRuntime.skills contains an invalid name",
				);
			}
			const normalized = item.trim();
			if (!skills.includes(normalized)) {
				skills.push(normalized);
			}
		}
	}
	let sourceReference: UserInstructionSourceReference | undefined;
	if (value.sourceReference !== undefined) {
		if (!isRecord(value.sourceReference)) {
			throw new Error(
				"Run recovery snapshot serverRuntime.sourceReference must be an object",
			);
		}
		for (const key of Object.keys(value.sourceReference)) {
			if (key !== "version" && key !== "algorithm" && key !== "digest") {
				throw new Error(
					`Run recovery snapshot serverRuntime.sourceReference contains unsupported field: ${key}`,
				);
			}
		}
		if (
			value.sourceReference.version !== 1 ||
			value.sourceReference.algorithm !== "sha256" ||
			typeof value.sourceReference.digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.sourceReference.digest)
		) {
			throw new Error(
				"Run recovery snapshot serverRuntime.sourceReference is invalid",
			);
		}
		sourceReference = Object.freeze({
			version: 1,
			algorithm: "sha256",
			digest: value.sourceReference.digest,
		});
	}
	return {
		configExtensions,
		...(skills ? { skills } : {}),
		...(sourceReference ? { sourceReference } : {}),
	};
}

export function serializeRunRecoverySnapshot(
	snapshot: RunRecoverySnapshot,
): string {
	return JSON.stringify(snapshot);
}

export function parseRunRecoverySnapshot(value: string): RunRecoverySnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Run recovery snapshot is not valid JSON");
	}
	if (!isRecord(parsed)) {
		throw new Error("Run recovery snapshot must be an object");
	}
	if (
		parsed.kind !== RUN_RECOVERY_SNAPSHOT_KIND ||
		parsed.version !== RUN_RECOVERY_SNAPSHOT_VERSION
	) {
		throw new Error("Unsupported run recovery snapshot schema");
	}
	if (
		!isRecord(parsed.run) ||
		!isRecord(parsed.transcript) ||
		!isRecord(parsed.config) ||
		!isRecord(parsed.eligibility)
	) {
		throw new Error("Run recovery snapshot is malformed");
	}
	const run = parsed.run;
	const transcript = parsed.transcript;
	const config = parsed.config;
	const eligibility = parsed.eligibility;
	const toolPolicies = config.toolPolicies;
	if (toolPolicies !== undefined && !isRecord(toolPolicies)) {
		throw new Error("Run recovery snapshot toolPolicies must be an object");
	}
	const cwd = requireText(config.cwd, "config.cwd");
	const workspaceRoot =
		typeof config.workspaceRoot === "string" && config.workspaceRoot.trim()
			? config.workspaceRoot
			: cwd;
	const systemPrompt = config.systemPrompt;
	if (
		typeof systemPrompt !== "string" ||
		systemPrompt.length > MAX_RECOVERY_SYSTEM_PROMPT_LENGTH
	) {
		throw new Error("Run recovery snapshot systemPrompt is invalid");
	}
	const mode = config.mode;
	if (mode !== "act" && mode !== "plan" && mode !== "yolo" && mode !== "zen") {
		throw new Error("Run recovery snapshot mode is invalid");
	}
	if (
		config.toolExecution !== "sequential" &&
		config.toolExecution !== "parallel"
	) {
		throw new Error("Run recovery snapshot toolExecution is invalid");
	}
	const maxParallelToolCalls =
		config.maxParallelToolCalls === undefined
			? undefined
			: requirePositiveInteger(
					config.maxParallelToolCalls,
					"config.maxParallelToolCalls",
				);
	if (
		maxParallelToolCalls !== undefined &&
		((config.toolExecution === "parallel" && maxParallelToolCalls < 2) ||
			(config.toolExecution === "sequential" && maxParallelToolCalls > 1))
	) {
		throw new Error(
			"Run recovery snapshot maxParallelToolCalls is inconsistent with toolExecution",
		);
	}
	const budget = normalizeAgentRunBudget(config.budget);
	if (parsed.toolOrigin !== "core-builtin" && parsed.toolOrigin !== "unknown") {
		throw new Error("Run recovery snapshot toolOrigin is invalid");
	}
	const autoRecover = requireBoolean(eligibility.autoRecover, "autoRecover");
	const reason = requireReason(eligibility.reason);
	if (autoRecover !== (reason === "eligible")) {
		throw new Error("Run recovery snapshot eligibility is inconsistent");
	}
	const recoveryOwner =
		parsed.recoveryOwner === undefined
			? undefined
			: requireText(parsed.recoveryOwner, "recoveryOwner");
	const serverRuntime = parseRunRecoveryServerRuntime(parsed.serverRuntime);
	return {
		kind: RUN_RECOVERY_SNAPSHOT_KIND,
		version: RUN_RECOVERY_SNAPSHOT_VERSION,
		capturedAt: requireText(parsed.capturedAt, "capturedAt"),
		sessionId: requireText(parsed.sessionId, "sessionId"),
		source: requireText(parsed.source, "source"),
		...(recoveryOwner ? { recoveryOwner } : {}),
		interactive: requireBoolean(parsed.interactive, "interactive"),
		toolName: requireText(parsed.toolName, "toolName"),
		toolOrigin:
			parsed.toolOrigin === "core-builtin" ? "core-builtin" : "unknown",
		clientContributionsPresent: requireBoolean(
			parsed.clientContributionsPresent,
			"clientContributionsPresent",
		),
		run: {
			runId: requireText(run.runId, "run.runId"),
			agentId: requireText(run.agentId, "run.agentId"),
			conversationId: requireText(run.conversationId, "run.conversationId"),
			iteration: requirePositiveIndex(run.iteration, "run.iteration"),
			toolCallIndex: requireIndex(run.toolCallIndex, "run.toolCallIndex"),
			assistantMessageId: requireText(
				run.assistantMessageId,
				"run.assistantMessageId",
			),
			toolCallId: requireText(run.toolCallId, "run.toolCallId"),
			approvalId: requireText(run.approvalId, "run.approvalId"),
		},
		preparedInputHash: requireText(
			parsed.preparedInputHash,
			"preparedInputHash",
		),
		transcript: {
			messageCount: requireIndex(
				transcript.messageCount,
				"transcript.messageCount",
			),
			lastMessageId: requireText(
				transcript.lastMessageId,
				"transcript.lastMessageId",
			),
			transcriptHash: requireText(
				transcript.transcriptHash,
				"transcript.transcriptHash",
			),
			systemPromptHash: requireText(
				transcript.systemPromptHash,
				"transcript.systemPromptHash",
			),
		},
		config: {
			providerId: requireText(config.providerId, "config.providerId"),
			modelId: requireText(config.modelId, "config.modelId"),
			cwd,
			workspaceRoot,
			systemPrompt,
			mode,
			enableTools: requireBoolean(config.enableTools, "config.enableTools"),
			enableSpawnAgent: requireBoolean(
				config.enableSpawnAgent,
				"config.enableSpawnAgent",
			),
			enableAgentTeams: requireBoolean(
				config.enableAgentTeams,
				"config.enableAgentTeams",
			),
			...(typeof config.maxIterations === "number"
				? { maxIterations: config.maxIterations }
				: {}),
			...(budget ? { budget } : {}),
			toolExecution: config.toolExecution,
			...(maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls }),
			...(toolPolicies === undefined
				? {}
				: { toolPolicies: toolPolicies as Record<string, ToolPolicy> }),
		},
		...(serverRuntime ? { serverRuntime } : {}),
		eligibility: {
			autoRecover,
			reason,
		},
	};
}

export function isRunRecoverySnapshot(
	value: unknown,
): value is RunRecoverySnapshot {
	if (typeof value !== "string") {
		return false;
	}
	try {
		parseRunRecoverySnapshot(value);
		return true;
	} catch {
		return false;
	}
}

export function snapshotSystemPromptHash(systemPrompt: string): string {
	return hashToolInput(systemPrompt);
}

export function snapshotTranscriptHash(messages: readonly unknown[]): string {
	return hashToolInput(messages);
}
