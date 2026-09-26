import { Buffer } from "node:buffer";
import type {
	AgentMode,
	AgentRunBudget,
	RuntimeConfigExtensionKind,
	ToolPolicy,
} from "@cline/shared";
import { normalizeAgentRunBudget } from "@cline/shared";
import type { UserInstructionSourceReference } from "../../extensions/config";

export const RUN_STATE_KIND = "cline.run-state" as const;
export const RUN_STATE_VERSION = 1 as const;
export const MAX_RUN_STATE_BYTES = 256_000;
export const MAX_RUN_STATE_SYSTEM_PROMPT_LENGTH = 64_000;
export const MAX_RUN_STATE_RESUME_STEPS = 16;

const MAX_RUN_STATE_STRING_LENGTH = 256;
const MAX_RUN_STATE_PATH_LENGTH = 4_096;
const MAX_RUN_STATE_SKILLS = 64;
const MAX_RUN_STATE_POLICIES = 128;
const MAX_RUN_STATE_DEPTH = 32;
const MAX_RUN_STATE_AGENT_ID_LENGTH = 128;
const MAX_RUN_STATE_AGENT_ROLE_LENGTH = 64;

const RUN_STATE_CONFIG_EXTENSIONS = new Set<RuntimeConfigExtensionKind>([
	"rules",
	"skills",
	"workflows",
]);

export interface RunStateToolCallResume {
	type: "tool_call";
	sessionId: string;
	runId: string;
	agentId: string;
	conversationId: string;
	iteration: number;
	toolCallIndex: number;
	stepId?: string;
	assistantMessageId: string;
	toolCallId: string;
	toolName: string;
	approvalId: string;
	preparedInputHash: string;
}

export interface RunStateToolCallBatchStep {
	stepId?: string;
	toolCallIndex: number;
	toolCallId: string;
	toolName: string;
	approvalId: string;
	preparedInputHash: string;
}

/**
 * Turn-level resume cursor for an assistant message that requested more than
 * one tool call. The ordered `steps` describe the whole turn, so a resume can
 * prove the replayed batch is exactly the persisted assistant turn instead of
 * trusting whatever subset of continuations a caller happens to pass.
 */
export interface RunStateToolCallBatchResume {
	type: "tool_call_batch";
	sessionId: string;
	runId: string;
	agentId: string;
	conversationId: string;
	iteration: number;
	assistantMessageId: string;
	steps: RunStateToolCallBatchStep[];
}

export type RunStateResume =
	| RunStateToolCallResume
	| RunStateToolCallBatchResume;

/**
 * Serializable agent identity for the resumed run. Root runs only carry
 * `agentId`; delegated runs additionally record the role, the immediate
 * parent agent, and the root run that owns the agent chain. Resume fails
 * closed when the rebuilt runtime cannot reproduce this identity.
 */
export interface RunStateAgent {
	agentId: string;
	agentRole?: string;
	parentAgentId?: string;
	rootRunId?: string;
}

export interface RunStateTurnIdentity {
	sessionId: string;
	runId: string;
	agentId: string;
	conversationId: string;
	iteration: number;
	assistantMessageId: string;
}

export interface RunStateTranscript {
	messageCount: number;
	lastMessageId: string;
	transcriptHash: string;
	systemPromptHash: string;
}

export interface RunStateConfig {
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
	 * Run budget recorded for the interrupted run. Optional and additive: a
	 * state written before this field existed parses unchanged, and a reader
	 * that predates it rejects the newer state rather than silently dropping
	 * the guardrail.
	 */
	budget?: AgentRunBudget;
	toolExecution: "sequential" | "parallel";
	maxParallelToolCalls?: number;
	toolPolicies?: Record<string, ToolPolicy>;
}

export interface RunStateServerRuntime {
	configExtensions: RuntimeConfigExtensionKind[];
	skills?: string[];
	sourceReference?: UserInstructionSourceReference;
}

export interface RunState {
	kind: typeof RUN_STATE_KIND;
	version: typeof RUN_STATE_VERSION;
	capturedAt: string;
	source: string;
	recoveryOwner?: string;
	interactive: boolean;
	resume: RunStateResume;
	agent?: RunStateAgent;
	transcript: RunStateTranscript;
	config: RunStateConfig;
	serverRuntime?: RunStateServerRuntime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(
	value: unknown,
	field: string,
	stack = new Set<object>(),
	depth = 0,
): void {
	if (depth > MAX_RUN_STATE_DEPTH) {
		throw new Error(`Run state ${field} is too deeply nested`);
	}
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`Run state ${field} contains a non-finite number`);
		}
		return;
	}
	if (
		typeof value === "undefined" ||
		typeof value === "bigint" ||
		typeof value === "function" ||
		typeof value === "symbol"
	) {
		throw new Error(`Run state ${field} contains an unsupported value`);
	}
	if (stack.has(value)) {
		throw new Error(`Run state ${field} contains a cycle`);
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_RUN_STATE_POLICIES) {
			throw new Error(`Run state ${field} is too large`);
		}
		stack.add(value);
		for (const key of Reflect.ownKeys(value)) {
			if (key === "length") {
				continue;
			}
			if (typeof key !== "string" || !/^\d+$/.test(key)) {
				throw new Error(`Run state ${field} contains an unsupported field`);
			}
			assertJsonValue(value[Number(key)], `${field}[${key}]`, stack, depth + 1);
		}
		stack.delete(value);
		return;
	}
	if (!isRecord(value)) {
		throw new Error(`Run state ${field} must be a plain object`);
	}
	stack.add(value);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") {
			throw new Error(`Run state ${field} contains an unsupported field`);
		}
		assertJsonValue(
			(value as Record<string, unknown>)[key],
			`${field}.${key}`,
			stack,
			depth + 1,
		);
	}
	stack.delete(value);
}

function assertKeys(
	value: Record<string, unknown>,
	allowed: ReadonlyArray<string>,
	required: ReadonlyArray<string>,
	field: string,
): void {
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !allowed.includes(key)) {
			throw new Error(`Run state ${field} contains an unsupported field`);
		}
	}
	for (const key of required) {
		if (!Object.hasOwn(value, key)) {
			throw new Error(`Run state ${field}.${key} is required`);
		}
	}
}

function requireText(
	value: unknown,
	field: string,
	maxLength = MAX_RUN_STATE_STRING_LENGTH,
): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maxLength
	) {
		throw new Error(`Run state ${field} must be a bounded non-empty string`);
	}
	return value;
}

function requireSystemPrompt(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > MAX_RUN_STATE_SYSTEM_PROMPT_LENGTH
	) {
		throw new Error("Run state config.systemPrompt is invalid");
	}
	return value;
}

function requireContentHash(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) {
		throw new Error(`Run state ${field} must be a content hash`);
	}
	return value;
}

function requirePreparedInputHash(value: unknown, field: string): string {
	if (
		typeof value !== "string" ||
		(value !== "none" &&
			value !== "unserializable" &&
			!/^[a-f0-9]{32}$/.test(value))
	) {
		throw new Error(`Run state ${field} must be a prepared input hash`);
	}
	return value;
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`Run state ${field} must be boolean`);
	}
	return value;
}

function requireIndex(value: unknown, field: string, positive = false): number {
	if (!Number.isInteger(value) || (value as number) < (positive ? 1 : 0)) {
		throw new Error(`Run state ${field} must be a valid index`);
	}
	return value as number;
}

function requireBoundedPositiveInteger(value: unknown, field: string): number {
	if (
		!Number.isInteger(value) ||
		(value as number) < 1 ||
		(value as number) > 64
	) {
		throw new Error(`Run state ${field} must be a bounded integer`);
	}
	return value as number;
}

function requireMode(value: unknown): AgentMode {
	if (
		value !== "act" &&
		value !== "plan" &&
		value !== "yolo" &&
		value !== "zen"
	) {
		throw new Error("Run state config.mode is invalid");
	}
	return value;
}

function parseSourceReference(value: unknown): UserInstructionSourceReference {
	if (!isRecord(value)) {
		throw new Error(
			"Run state serverRuntime.sourceReference must be an object",
		);
	}
	assertKeys(
		value,
		["version", "algorithm", "digest"],
		["version", "algorithm", "digest"],
		"serverRuntime.sourceReference",
	);
	if (
		value.version !== 1 ||
		value.algorithm !== "sha256" ||
		typeof value.digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.digest)
	) {
		throw new Error("Run state serverRuntime.sourceReference is invalid");
	}
	return Object.freeze({
		version: 1,
		algorithm: "sha256",
		digest: value.digest,
	});
}

function parseServerRuntime(value: unknown): RunStateServerRuntime {
	if (!isRecord(value)) {
		throw new Error("Run state serverRuntime must be an object");
	}
	assertKeys(
		value,
		["configExtensions", "skills", "sourceReference"],
		["configExtensions"],
		"serverRuntime",
	);
	if (!Array.isArray(value.configExtensions)) {
		throw new Error(
			"Run state serverRuntime.configExtensions must be an array",
		);
	}
	if (value.configExtensions.length > 8) {
		throw new Error("Run state serverRuntime.configExtensions is too large");
	}
	const configExtensions: RuntimeConfigExtensionKind[] = [];
	for (const item of value.configExtensions) {
		if (
			typeof item !== "string" ||
			!RUN_STATE_CONFIG_EXTENSIONS.has(item as RuntimeConfigExtensionKind)
		) {
			throw new Error(
				"Run state serverRuntime.configExtensions contains an unsupported kind",
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
			value.skills.length > MAX_RUN_STATE_SKILLS
		) {
			throw new Error("Run state serverRuntime.skills must be a bounded array");
		}
		skills = [];
		for (const item of value.skills) {
			const skill = requireText(item, "serverRuntime.skills[]", 128);
			if (!skills.includes(skill)) {
				skills.push(skill);
			}
		}
	}
	const sourceReference =
		value.sourceReference === undefined
			? undefined
			: parseSourceReference(value.sourceReference);
	return {
		configExtensions,
		...(skills ? { skills } : {}),
		...(sourceReference ? { sourceReference } : {}),
	};
}

function parseToolPolicies(value: unknown): Record<string, ToolPolicy> {
	if (!isRecord(value)) {
		throw new Error("Run state config.toolPolicies must be an object");
	}
	const entries = Object.entries(value);
	if (entries.length > MAX_RUN_STATE_POLICIES) {
		throw new Error("Run state config.toolPolicies is too large");
	}
	const policies: Record<string, ToolPolicy> = Object.create(null);
	for (const [name, policy] of entries) {
		requireText(name, "config.toolPolicies key", 128);
		if (!isRecord(policy)) {
			throw new Error(
				`Run state config.toolPolicies.${name} must be an object`,
			);
		}
		assertKeys(
			policy,
			["enabled", "autoApprove"],
			[],
			`config.toolPolicies.${name}`,
		);
		const normalized: ToolPolicy = {};
		if (policy.enabled !== undefined) {
			normalized.enabled = requireBoolean(
				policy.enabled,
				`config.toolPolicies.${name}.enabled`,
			);
		}
		if (policy.autoApprove !== undefined) {
			normalized.autoApprove = requireBoolean(
				policy.autoApprove,
				`config.toolPolicies.${name}.autoApprove`,
			);
		}
		policies[name] = normalized;
	}
	return policies;
}

function parseConfig(value: unknown): RunStateConfig {
	if (!isRecord(value)) {
		throw new Error("Run state config must be an object");
	}
	assertKeys(
		value,
		[
			"providerId",
			"modelId",
			"cwd",
			"workspaceRoot",
			"systemPrompt",
			"mode",
			"enableTools",
			"enableSpawnAgent",
			"enableAgentTeams",
			"maxIterations",
			"budget",
			"toolExecution",
			"maxParallelToolCalls",
			"toolPolicies",
		],
		[
			"providerId",
			"modelId",
			"cwd",
			"workspaceRoot",
			"systemPrompt",
			"mode",
			"enableTools",
			"enableSpawnAgent",
			"enableAgentTeams",
			"toolExecution",
		],
		"config",
	);
	if (
		value.toolExecution !== "sequential" &&
		value.toolExecution !== "parallel"
	) {
		throw new Error("Run state config.toolExecution is invalid");
	}
	const maxParallelToolCalls =
		value.maxParallelToolCalls === undefined
			? undefined
			: requireBoundedPositiveInteger(
					value.maxParallelToolCalls,
					"config.maxParallelToolCalls",
				);
	if (
		maxParallelToolCalls !== undefined &&
		((value.toolExecution === "parallel" && maxParallelToolCalls < 2) ||
			(value.toolExecution === "sequential" && maxParallelToolCalls > 1))
	) {
		throw new Error(
			"Run state config.maxParallelToolCalls is inconsistent with toolExecution",
		);
	}
	const budget = normalizeAgentRunBudget(value.budget);
	return {
		providerId: requireText(value.providerId, "config.providerId"),
		modelId: requireText(value.modelId, "config.modelId"),
		cwd: requireText(value.cwd, "config.cwd", MAX_RUN_STATE_PATH_LENGTH),
		workspaceRoot: requireText(
			value.workspaceRoot,
			"config.workspaceRoot",
			MAX_RUN_STATE_PATH_LENGTH,
		),
		systemPrompt: requireSystemPrompt(value.systemPrompt),
		mode: requireMode(value.mode),
		enableTools: requireBoolean(value.enableTools, "config.enableTools"),
		enableSpawnAgent: requireBoolean(
			value.enableSpawnAgent,
			"config.enableSpawnAgent",
		),
		enableAgentTeams: requireBoolean(
			value.enableAgentTeams,
			"config.enableAgentTeams",
		),
		...(value.maxIterations === undefined
			? {}
			: {
					maxIterations: requireIndex(
						value.maxIterations,
						"config.maxIterations",
						true,
					),
				}),
		...(budget ? { budget } : {}),
		toolExecution: value.toolExecution,
		...(maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls }),
		...(value.toolPolicies === undefined
			? {}
			: { toolPolicies: parseToolPolicies(value.toolPolicies) }),
	};
}

function parseTranscript(value: unknown): RunStateTranscript {
	if (!isRecord(value)) {
		throw new Error("Run state transcript must be an object");
	}
	assertKeys(
		value,
		["messageCount", "lastMessageId", "transcriptHash", "systemPromptHash"],
		["messageCount", "lastMessageId", "transcriptHash", "systemPromptHash"],
		"transcript",
	);
	return {
		messageCount: requireIndex(value.messageCount, "transcript.messageCount"),
		lastMessageId: requireText(value.lastMessageId, "transcript.lastMessageId"),
		transcriptHash: requireContentHash(
			value.transcriptHash,
			"transcript.transcriptHash",
		),
		systemPromptHash: requireContentHash(
			value.systemPromptHash,
			"transcript.systemPromptHash",
		),
	};
}

function requireStepId(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^step:[^:\s]+:\d+:\d+$/.test(value)) {
		throw new Error(`Run state ${field} must be a step identity`);
	}
	return value;
}

function parseToolCallBatchStep(
	value: unknown,
	field: string,
): RunStateToolCallBatchStep {
	if (!isRecord(value)) {
		throw new Error(`Run state ${field} must be an object`);
	}
	assertKeys(
		value,
		[
			"stepId",
			"toolCallIndex",
			"toolCallId",
			"toolName",
			"approvalId",
			"preparedInputHash",
		],
		[
			"toolCallIndex",
			"toolCallId",
			"toolName",
			"approvalId",
			"preparedInputHash",
		],
		field,
	);
	const stepId =
		value.stepId === undefined
			? undefined
			: requireStepId(value.stepId, `${field}.stepId`);
	return {
		toolCallIndex: requireIndex(value.toolCallIndex, `${field}.toolCallIndex`),
		...(stepId ? { stepId } : {}),
		toolCallId: requireText(value.toolCallId, `${field}.toolCallId`),
		toolName: requireText(value.toolName, `${field}.toolName`, 128),
		approvalId: requireText(value.approvalId, `${field}.approvalId`),
		preparedInputHash: requirePreparedInputHash(
			value.preparedInputHash,
			`${field}.preparedInputHash`,
		),
	};
}

function parseToolCallBatchSteps(value: unknown): RunStateToolCallBatchStep[] {
	if (!Array.isArray(value)) {
		throw new Error("Run state resume.steps must be an array");
	}
	if (value.length < 1 || value.length > MAX_RUN_STATE_RESUME_STEPS) {
		throw new Error(
			`Run state resume.steps must contain 1 to ${MAX_RUN_STATE_RESUME_STEPS} steps`,
		);
	}
	const steps: RunStateToolCallBatchStep[] = [];
	const approvalIds = new Set<string>();
	const toolCallIds = new Set<string>();
	const stepIds = new Set<string>();
	for (const [index, item] of value.entries()) {
		const step = parseToolCallBatchStep(item, `resume.steps[${index}]`);
		if (step.toolCallIndex !== index) {
			throw new Error(
				`Run state resume.steps[${index}].toolCallIndex must be ${index}`,
			);
		}
		if (approvalIds.has(step.approvalId)) {
			throw new Error("Run state resume.steps contains a duplicate approval");
		}
		if (toolCallIds.has(step.toolCallId)) {
			throw new Error("Run state resume.steps contains a duplicate tool call");
		}
		if (step.stepId !== undefined) {
			if (stepIds.has(step.stepId)) {
				throw new Error("Run state resume.steps contains a duplicate step");
			}
			stepIds.add(step.stepId);
		}
		approvalIds.add(step.approvalId);
		toolCallIds.add(step.toolCallId);
		steps.push(step);
	}
	return steps;
}

function parseTurnIdentity(
	value: Record<string, unknown>,
	field: string,
): RunStateTurnIdentity {
	return {
		sessionId: requireText(value.sessionId, `${field}.sessionId`),
		runId: requireText(value.runId, `${field}.runId`),
		agentId: requireText(value.agentId, `${field}.agentId`),
		conversationId: requireText(
			value.conversationId,
			`${field}.conversationId`,
		),
		iteration: requireIndex(value.iteration, `${field}.iteration`, true),
		assistantMessageId: requireText(
			value.assistantMessageId,
			`${field}.assistantMessageId`,
		),
	};
}

function parseToolCallResume(value: unknown): RunStateToolCallResume {
	if (!isRecord(value)) {
		throw new Error("Run state resume must be an object");
	}
	assertKeys(
		value,
		[
			"type",
			"sessionId",
			"runId",
			"agentId",
			"conversationId",
			"iteration",
			"toolCallIndex",
			"stepId",
			"assistantMessageId",
			"toolCallId",
			"toolName",
			"approvalId",
			"preparedInputHash",
		],
		[
			"type",
			"sessionId",
			"runId",
			"agentId",
			"conversationId",
			"iteration",
			"toolCallIndex",
			"assistantMessageId",
			"toolCallId",
			"toolName",
			"approvalId",
			"preparedInputHash",
		],
		"resume",
	);
	if (value.type !== "tool_call") {
		throw new Error("Unsupported run state resume type");
	}
	const stepId =
		value.stepId === undefined
			? undefined
			: requireStepId(value.stepId, "resume.stepId");
	return {
		type: "tool_call",
		...parseTurnIdentity(value, "resume"),
		toolCallIndex: requireIndex(value.toolCallIndex, "resume.toolCallIndex"),
		...(stepId ? { stepId } : {}),
		toolCallId: requireText(value.toolCallId, "resume.toolCallId"),
		toolName: requireText(value.toolName, "resume.toolName", 128),
		approvalId: requireText(value.approvalId, "resume.approvalId"),
		preparedInputHash: requirePreparedInputHash(
			value.preparedInputHash,
			"resume.preparedInputHash",
		),
	};
}

function parseToolCallBatchResume(value: unknown): RunStateToolCallBatchResume {
	if (!isRecord(value)) {
		throw new Error("Run state resume must be an object");
	}
	assertKeys(
		value,
		[
			"type",
			"sessionId",
			"runId",
			"agentId",
			"conversationId",
			"iteration",
			"assistantMessageId",
			"steps",
		],
		[
			"type",
			"sessionId",
			"runId",
			"agentId",
			"conversationId",
			"iteration",
			"assistantMessageId",
			"steps",
		],
		"resume",
	);
	if (value.type !== "tool_call_batch") {
		throw new Error("Unsupported run state resume type");
	}
	return {
		type: "tool_call_batch",
		...parseTurnIdentity(value, "resume"),
		steps: parseToolCallBatchSteps(value.steps),
	};
}

function parseResume(value: unknown): RunStateResume {
	if (!isRecord(value)) {
		throw new Error("Run state resume must be an object");
	}
	if (value.type === "tool_call_batch") {
		return parseToolCallBatchResume(value);
	}
	return parseToolCallResume(value);
}

function parseAgent(value: unknown): RunStateAgent {
	if (!isRecord(value)) {
		throw new Error("Run state agent must be an object");
	}
	assertKeys(
		value,
		["agentId", "agentRole", "parentAgentId", "rootRunId"],
		["agentId"],
		"agent",
	);
	const agentId = requireText(
		value.agentId,
		"agent.agentId",
		MAX_RUN_STATE_AGENT_ID_LENGTH,
	);
	const agentRole =
		value.agentRole === undefined
			? undefined
			: requireText(
					value.agentRole,
					"agent.agentRole",
					MAX_RUN_STATE_AGENT_ROLE_LENGTH,
				);
	const parentAgentId =
		value.parentAgentId === undefined
			? undefined
			: requireText(
					value.parentAgentId,
					"agent.parentAgentId",
					MAX_RUN_STATE_AGENT_ID_LENGTH,
				);
	const rootRunId =
		value.rootRunId === undefined
			? undefined
			: requireText(
					value.rootRunId,
					"agent.rootRunId",
					MAX_RUN_STATE_STRING_LENGTH,
				);
	if (parentAgentId !== undefined && parentAgentId === agentId) {
		throw new Error("Run state agent.parentAgentId must differ from agentId");
	}
	if (rootRunId !== undefined && parentAgentId === undefined) {
		throw new Error(
			"Run state agent.rootRunId requires a parentAgentId for delegated agents",
		);
	}
	return {
		agentId,
		...(agentRole ? { agentRole } : {}),
		...(parentAgentId ? { parentAgentId } : {}),
		...(rootRunId ? { rootRunId } : {}),
	};
}

function parseRunStateValue(value: unknown): RunState {
	assertJsonValue(value, "state");
	if (!isRecord(value)) {
		throw new Error("Run state must be an object");
	}
	assertKeys(
		value,
		[
			"kind",
			"version",
			"capturedAt",
			"source",
			"recoveryOwner",
			"interactive",
			"resume",
			"agent",
			"transcript",
			"config",
			"serverRuntime",
		],
		[
			"kind",
			"version",
			"capturedAt",
			"source",
			"interactive",
			"resume",
			"transcript",
			"config",
		],
		"state",
	);
	if (value.kind !== RUN_STATE_KIND || value.version !== RUN_STATE_VERSION) {
		throw new Error("Unsupported run state schema");
	}
	const capturedAt = requireText(value.capturedAt, "capturedAt", 64);
	if (!Number.isFinite(Date.parse(capturedAt))) {
		throw new Error("Run state capturedAt is invalid");
	}
	const recoveryOwner =
		value.recoveryOwner === undefined
			? undefined
			: requireText(value.recoveryOwner, "recoveryOwner");
	return {
		kind: RUN_STATE_KIND,
		version: RUN_STATE_VERSION,
		capturedAt,
		source: requireText(value.source, "source"),
		...(recoveryOwner ? { recoveryOwner } : {}),
		interactive: requireBoolean(value.interactive, "interactive"),
		resume: parseResume(value.resume),
		...(value.agent === undefined ? {} : { agent: parseAgent(value.agent) }),
		transcript: parseTranscript(value.transcript),
		config: parseConfig(value.config),
		...(value.serverRuntime === undefined
			? {}
			: { serverRuntime: parseServerRuntime(value.serverRuntime) }),
	};
}

export function parseRunState(value: string): RunState {
	if (typeof value !== "string") {
		throw new Error("Run state must be a JSON string");
	}
	if (Buffer.byteLength(value, "utf8") > MAX_RUN_STATE_BYTES) {
		throw new Error("Run state is too large");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Run state is not valid JSON");
	}
	return parseRunStateValue(parsed);
}

export function serializeRunState(state: RunState): string {
	const normalized = parseRunStateValue(state);
	const serialized = JSON.stringify(normalized);
	if (Buffer.byteLength(serialized, "utf8") > MAX_RUN_STATE_BYTES) {
		throw new Error("Run state is too large");
	}
	return serialized;
}

export function isRunStateBatchResume(
	resume: RunStateResume,
): resume is RunStateToolCallBatchResume {
	return resume.type === "tool_call_batch";
}

/** Turn identity shared by both resume variants. */
export function runStateResumeTurn(
	resume: RunStateResume,
): RunStateTurnIdentity {
	return {
		sessionId: resume.sessionId,
		runId: resume.runId,
		agentId: resume.agentId,
		conversationId: resume.conversationId,
		iteration: resume.iteration,
		assistantMessageId: resume.assistantMessageId,
	};
}

/**
 * Normalized, ordered step cursors for either resume variant. A single
 * tool-call resume yields exactly one step so callers can treat both variants
 * uniformly.
 */
export function runStateResumeSteps(
	resume: RunStateResume,
): RunStateToolCallBatchStep[] {
	if (isRunStateBatchResume(resume)) {
		return resume.steps;
	}
	return [
		{
			...(resume.stepId ? { stepId: resume.stepId } : {}),
			toolCallIndex: resume.toolCallIndex,
			toolCallId: resume.toolCallId,
			toolName: resume.toolName,
			approvalId: resume.approvalId,
			preparedInputHash: resume.preparedInputHash,
		},
	];
}

/**
 * Build the turn-level batch cursor for a complete assistant tool-call turn.
 * Throws when the steps do not describe a contiguous, duplicate-free turn so a
 * partially recorded turn can never be persisted as a resumable batch.
 */
export function createRunStateBatchResume(
	resume: RunStateResume,
	steps: readonly RunStateToolCallBatchStep[],
): RunStateToolCallBatchResume {
	const candidate = {
		type: "tool_call_batch" as const,
		...runStateResumeTurn(resume),
		steps: steps.map((step) => ({ ...step })),
	};
	return parseToolCallBatchResume(candidate);
}

/**
 * Resolve the resume step that a durable continuation record stands for.
 * Returns `undefined` when the state does not describe that step, which keeps
 * both the persistence and the resume boundary fail-closed.
 */
export function runStateStepForRecord(
	state: RunState,
	record: {
		toolCallIndex: number;
		toolCallId: string;
		toolName: string;
		approvalId: string;
		preparedInputHash: string;
	},
): RunStateToolCallBatchStep | undefined {
	return runStateResumeSteps(state.resume).find(
		(step) =>
			step.toolCallIndex === record.toolCallIndex &&
			step.toolCallId === record.toolCallId &&
			step.toolName === record.toolName &&
			step.approvalId === record.approvalId &&
			step.preparedInputHash === record.preparedInputHash,
	);
}
