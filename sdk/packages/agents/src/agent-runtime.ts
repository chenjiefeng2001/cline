import { createGateway, type GatewayProviderSettings } from "@cline/llms";
import type {
	AgentAfterToolResult,
	AgentBeforeModelResult,
	AgentBeforeToolResult,
	AgentMessage,
	AgentMessagePart,
	AgentModel,
	AgentModelFinishReason,
	AgentModelRequest,
	AgentRunBudget,
	AgentRunBudgetStatus,
	AgentRunResult,
	AgentRuntimeEvent,
	AgentRuntimeHooks,
	AgentRuntimeStateSnapshot,
	AgentStopControl,
	AgentTool,
	AgentToolCallPart,
	AgentToolDefinition,
	AgentToolResult,
	AgentUsage,
	AgentRuntimeConfig as BaseAgentRuntimeConfig,
	TelemetryProperties,
	ToolApprovalResult,
	ToolPolicy,
} from "@cline/shared";
import {
	captureAgentUnexpectedReasoningTokens,
	captureSdkError,
	estimateTokens,
	mergeModelOptions,
	normalizeAgentRunBudget,
	normalizeJsonLikeStringsForSchema,
	omitUndefinedValues,
	trimNonEmpty,
} from "@cline/shared";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { nanoid } from "nanoid";

// No-op unless a TracerProvider is registered (OpenTelemetryProvider/Langfuse
// do so when telemetry is configured). Spans give every agent run and tool
// execution a causal slot under the caller's active context.
const agentTracer = trace.getTracer("cline.agents");

const MAX_TOKENS_INCOMPLETE_TURN_MESSAGE =
	"Model reached the maximum output token limit before completing the turn";

const MAX_RESUME_TOOL_BATCH = 16;

// Local `createUID` helper. The clinee source imports this from
// `@cline/shared` (see `packages/shared/dist/identifier.ts`), but
// sdk-re's shared package does not expose it yet. Inlining here keeps
// PLAN.md Step 1 scoped to `packages/agents/src/` and matches the
// exact clinee implementation (`${prefix}_${nanoid(length)}`).
function createUID(prefix: string, length = 8): string {
	return `${prefix}_${nanoid(length)}`;
}

export function createToolStepId(
	runId: string | undefined,
	iteration: number,
	callIndex: number,
): string {
	return `step:${runId ?? "unknown"}:${iteration}:${callIndex}`;
}

export type AgentRunInput = string | AgentMessage | readonly AgentMessage[];
export type AgentEventListener = (event: AgentRuntimeEvent) => void;

export interface AgentRuntimeResumeToolCall {
	runId: string;
	iteration: number;
	stepId?: string;
	assistantMessageId: string;
	toolCallId: string;
	toolName: string;
	preparedInput: unknown;
	approval: ToolApprovalResult;
}

export interface AgentRuntimeResumeToolCallEntry {
	stepId?: string;
	toolCallId: string;
	toolName: string;
	preparedInput: unknown;
	approval: ToolApprovalResult;
}

/**
 * Resumes a decided assistant turn that requested more than one tool call.
 * Entries must match the persisted assistant message exactly, in order, and
 * are executed sequentially under their persisted step identities.
 */
export interface AgentRuntimeResumeToolBatch {
	runId: string;
	iteration: number;
	assistantMessageId: string;
	calls: AgentRuntimeResumeToolCallEntry[];
}

/**
 * Advanced form: caller supplies a pre-built `AgentModel`. Used by
 * `@cline/core`, which constructs models itself to share gateway/telemetry
 * wiring with the rest of the session runtime.
 */
export interface AgentRuntimeConfigWithModel extends BaseAgentRuntimeConfig {
	model: AgentModel;
}

/**
 * Friendly form: caller supplies provider/model IDs and credentials, and the
 * runtime builds an `AgentModel` internally via `@cline/llms`. This is the
 * entry point most standalone users want.
 */
export interface AgentRuntimeConfigWithProvider
	extends Omit<BaseAgentRuntimeConfig, "model"> {
	/** Provider ID (e.g., "anthropic", "openai") */
	providerId: string;
	/** Model ID to use */
	modelId: string;
	/** API key for the provider */
	apiKey?: string;
	/** Custom base URL for the API */
	baseUrl?: string;
	/** Additional headers for API requests */
	headers?: Record<string, string>;
	/** Provider-specific gateway options */
	options?: GatewayProviderSettings["options"];
}

/**
 * Config accepted by `new AgentRuntime(...)` / `createAgentRuntime(...)` /
 * `new Agent(...)` / `createAgent(...)`. Either supply a pre-built `model`
 * (advanced) or `providerId` + `modelId` (+ credentials) and the runtime will
 * construct the model itself via `@cline/llms`.
 */
export type AgentRuntimeConfig =
	| AgentRuntimeConfigWithModel
	| AgentRuntimeConfigWithProvider;

function hasPrebuiltModel(
	config: AgentRuntimeConfig,
): config is AgentRuntimeConfigWithModel {
	return (config as AgentRuntimeConfigWithModel).model !== undefined;
}

function resolveRuntimeConfig(
	config: AgentRuntimeConfig,
): BaseAgentRuntimeConfig {
	if (hasPrebuiltModel(config)) {
		return config;
	}
	const { providerId, modelId, apiKey, baseUrl, headers, options, ...rest } =
		config;
	const gateway = createGateway({
		providerConfigs: [{ providerId, apiKey, baseUrl, headers, options }],
		telemetry: rest.telemetry,
	});
	const model = gateway.createAgentModel({ providerId, modelId });
	// The prebuilt-model path preserves a caller-provided messageModelInfo;
	// mirror that here so the provider/model constructor also tags assistant
	// messages with modelInfo. An explicit caller-provided value still wins.
	const messageModelInfo = rest.messageModelInfo ?? {
		id: modelId,
		provider: providerId,
	};
	return { ...rest, model, messageModelInfo };
}

function resolveToolPolicy(
	toolName: string,
	policies: BaseAgentRuntimeConfig["toolPolicies"],
): ToolPolicy {
	return {
		...(policies?.["*"] ?? {}),
		...(policies?.[toolName] ?? {}),
	};
}

interface PendingToolAssembly {
	toolCallId: string;
	toolName?: string;
	inputText: string;
	inputValue?: unknown;
	metadata?: unknown;
	parseError?: string;
}

interface InvalidToolCall {
	toolCallId: string;
	toolName?: string;
	input: Record<string, unknown>;
	reason: "missing_name" | "missing_arguments" | "invalid_arguments";
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

function getOutputSize(output: unknown): number {
	if (typeof output === "string") {
		return output.length;
	}
	return safeJsonSize(output);
}

function summarizeModelRequest(
	request: AgentModelRequest,
): Record<string, unknown> {
	let textChars = request.systemPrompt?.length ?? 0;
	let toolResultCount = 0;
	let toolResultChars = 0;
	let maxToolResultChars = 0;
	for (const message of request.messages) {
		for (const part of message.content) {
			switch (part.type) {
				case "text":
					textChars += part.text.length;
					break;
				case "reasoning":
					textChars += part.text.length;
					break;
				case "file":
					textChars += part.content.length;
					break;
				case "tool-call":
					textChars += safeJsonSize(part.input);
					break;
				case "tool-result": {
					const outputChars = getOutputSize(part.output);
					toolResultCount += 1;
					toolResultChars += outputChars;
					maxToolResultChars = Math.max(maxToolResultChars, outputChars);
					textChars += outputChars;
					break;
				}
			}
		}
	}

	return {
		messageCount: request.messages.length,
		toolSchemaCount: request.tools.length,
		systemPromptChars: request.systemPrompt?.length ?? 0,
		requestJsonChars: safeJsonSize({
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
			options: request.options,
		}),
		visibleTextChars: textChars,
		estimatedTextTokens: estimateTokens(textChars),
		toolResultCount,
		toolResultChars,
		maxToolResultChars,
	};
}

interface PreparedToolExecution {
	toolCall: AgentToolCallPart;
	callIndex: number;
	stepId: string;
	tool?: AgentTool;
	input: unknown;
	skipReason?: string;
	denialReason?: string;
}

interface ResumeToolCallState {
	assistantMessage: AgentMessage;
	toolCall: AgentToolCallPart;
	tool: AgentTool;
}

interface ResumeToolBatchState {
	assistantMessage: AgentMessage;
	entries: ResumeToolCallState[];
}

interface HookBag {
	beforeRun: NonNullable<AgentRuntimeHooks["beforeRun"]>[];
	afterRun: NonNullable<AgentRuntimeHooks["afterRun"]>[];
	beforeModel: NonNullable<AgentRuntimeHooks["beforeModel"]>[];
	afterModel: NonNullable<AgentRuntimeHooks["afterModel"]>[];
	beforeTool: NonNullable<AgentRuntimeHooks["beforeTool"]>[];
	afterTool: NonNullable<AgentRuntimeHooks["afterTool"]>[];
	onEvent: NonNullable<AgentRuntimeHooks["onEvent"]>[];
}

class ControlledStopError extends Error {
	readonly reason?: string;

	constructor(reason?: string) {
		super(reason ?? "Run stopped by runtime control");
		this.name = "ControlledStopError";
		this.reason = reason;
	}
}

const MAX_TOOL_RETRIES = 10;
const MAX_TOOL_RETRY_DELAY_MS = 2_000;

class AgentToolTimeoutError extends Error {
	constructor(
		readonly toolName: string,
		readonly timeoutMs: number,
	) {
		super(`Tool ${toolName} timed out after ${timeoutMs}ms`);
		this.name = "AgentToolTimeoutError";
	}
}

export class AgentRuntimeAbortError extends Error {
	readonly reason?: unknown;

	constructor(reason?: unknown) {
		const message =
			typeof reason === "string"
				? reason
				: reason instanceof Error
					? reason.message
					: reason === undefined
						? "Run aborted"
						: String(reason);
		super(message);
		this.name = "AgentRuntimeAbortError";
		this.reason = reason;
	}
}

const DEFAULT_USAGE: AgentUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
};

function createMessage(
	role: AgentMessage["role"],
	content: AgentMessagePart[],
	metadata?: Record<string, unknown>,
): AgentMessage {
	return {
		id: createUID("msg"),
		role,
		content,
		createdAt: Date.now(),
		metadata,
	};
}

function cloneUsage(usage: AgentUsage): AgentUsage {
	return { ...usage };
}

function cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => ({
		...message,
		content: message.content.map((part: AgentMessagePart) => ({ ...part })),
		metadata: message.metadata ? { ...message.metadata } : undefined,
		modelInfo: message.modelInfo ? { ...message.modelInfo } : undefined,
		metrics: message.metrics ? { ...message.metrics } : undefined,
	}));
}

function usageDelta(
	start: AgentUsage,
	end: AgentUsage,
): NonNullable<AgentMessage["metrics"]> | undefined {
	const inputTokens = Math.max(
		0,
		(end.inputTokens ?? 0) - (start.inputTokens ?? 0),
	);
	const outputTokens = Math.max(
		0,
		(end.outputTokens ?? 0) - (start.outputTokens ?? 0),
	);
	const cacheReadTokens = Math.max(
		0,
		(end.cacheReadTokens ?? 0) - (start.cacheReadTokens ?? 0),
	);
	const cacheWriteTokens = Math.max(
		0,
		(end.cacheWriteTokens ?? 0) - (start.cacheWriteTokens ?? 0),
	);
	const reasoningTokenCount = Math.max(
		0,
		(end.reasoningTokenCount ?? 0) - (start.reasoningTokenCount ?? 0),
	);
	const startCost = start.totalCost ?? 0;
	const endCost = end.totalCost ?? 0;
	const cost = Math.max(0, endCost - startCost);
	if (
		inputTokens === 0 &&
		outputTokens === 0 &&
		cacheReadTokens === 0 &&
		cacheWriteTokens === 0 &&
		reasoningTokenCount === 0 &&
		cost === 0
	) {
		return undefined;
	}
	return {
		inputTokens: inputTokens > 0 ? inputTokens : 0,
		outputTokens: outputTokens > 0 ? outputTokens : 0,
		cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : 0,
		cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : 0,
		...(reasoningTokenCount > 0 ? { reasoningTokenCount } : {}),
		...(cost > 0 ? { cost } : {}),
	};
}

function reasoningWasRequestedOff(request: AgentModelRequest): boolean {
	return request.options?.thinking === false;
}

function textFromMessage(message: AgentMessage | undefined): string {
	if (!message) {
		return "";
	}
	return message.content
		.filter(
			(
				part: AgentMessagePart,
			): part is Extract<AgentMessagePart, { type: "text" }> =>
				part.type === "text",
		)
		.map((part: Extract<AgentMessagePart, { type: "text" }>) => part.text)
		.join("");
}

function textFromToolMessage(message: AgentMessage | undefined): string {
	const result = message?.content.find(
		(part): part is Extract<AgentMessagePart, { type: "tool-result" }> =>
			part.type === "tool-result",
	);
	if (!result || result.isError) {
		return "";
	}
	if (typeof result.output === "string") {
		return result.output;
	}
	try {
		return JSON.stringify(result.output);
	} catch {
		return String(result.output);
	}
}

function normalizeInput(input: AgentRunInput): AgentMessage[] {
	if (typeof input === "string") {
		return [createMessage("user", [{ type: "text", text: input }])];
	}
	if (Array.isArray(input)) {
		return cloneMessages(input);
	}
	return cloneMessages([input as AgentMessage]);
}

export class AgentRuntime {
	private config: Required<Pick<BaseAgentRuntimeConfig, "toolExecution">> &
		BaseAgentRuntimeConfig;
	private readonly listeners = new Set<AgentEventListener>();
	// biome-ignore lint/suspicious/noExplicitAny: tool input/output types vary per tool
	private readonly tools = new Map<string, AgentTool<any, any>>();
	private hooks: HookBag = {
		beforeRun: [],
		afterRun: [],
		beforeModel: [],
		afterModel: [],
		beforeTool: [],
		afterTool: [],
		onEvent: [],
	};
	private readonly state = {
		agentId: "",
		agentRole: undefined as string | undefined,
		parentAgentId: undefined as string | null | undefined,
		runId: undefined as string | undefined,
		status: "idle" as AgentRuntimeStateSnapshot["status"],
		iteration: 0,
		messages: [] as AgentMessage[],
		pendingToolCalls: [] as string[],
		usage: cloneUsage(DEFAULT_USAGE),
		lastError: undefined as string | undefined,
	};
	private initialization?: Promise<void>;
	private abortController?: AbortController;
	private configuredRunId?: string;
	/**
	 * Stable run id of the agent chain that owns this runtime. Only set for
	 * delegated agents; a lead agent's own run id changes per run. Carried on
	 * the config rather than read from state so it survives a resume that
	 * renumbers `state.runId`.
	 */
	private readonly chainRootRunId: string | undefined;
	/**
	 * Validated, frozen run budget. Undefined when the caller set no caps, in
	 * which case the loop is never gated on spend.
	 */
	private readonly runBudget: AgentRunBudget | undefined;

	constructor(config: AgentRuntimeConfig) {
		const resolved = resolveRuntimeConfig(config);
		this.config = {
			...resolved,
			toolExecution: resolved.toolExecution ?? "sequential",
		};
		this.state.agentId = resolved.agentId ?? createUID("agent");
		this.state.agentRole = resolved.agentRole;
		this.state.parentAgentId = resolved.parentAgentId;
		this.chainRootRunId = trimNonEmpty(resolved.rootRunId);
		this.runBudget = normalizeAgentRunBudget(resolved.budget);
		this.configuredRunId = resolved.runId;
		this.state.messages = cloneMessages(resolved.initialMessages ?? []);
	}

	async run(input: AgentRunInput): Promise<AgentRunResult> {
		return this.execute(input);
	}

	async continue(input?: AgentRunInput): Promise<AgentRunResult> {
		return this.execute(input);
	}

	async resumePendingToolCall(
		input: AgentRuntimeResumeToolCall,
	): Promise<AgentRunResult> {
		return this.execute(undefined, {
			runId: input.runId,
			iteration: input.iteration,
			assistantMessageId: input.assistantMessageId,
			calls: [
				{
					...(input.stepId ? { stepId: input.stepId } : {}),
					toolCallId: input.toolCallId,
					toolName: input.toolName,
					preparedInput: input.preparedInput,
					approval: input.approval,
				},
			],
		});
	}

	async resumePendingToolBatch(
		input: AgentRuntimeResumeToolBatch,
	): Promise<AgentRunResult> {
		return this.execute(undefined, input);
	}

	abort(reason?: unknown): void {
		if (!this.abortController) {
			return;
		}
		const abortError =
			reason instanceof AgentRuntimeAbortError
				? reason
				: new AgentRuntimeAbortError(reason);
		this.state.lastError = abortError.message;
		this.abortController.abort(abortError);
	}

	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Replace the conversation with a fresh set of messages, discarding any
	 * in-flight run and usage state while preserving the underlying model,
	 * tools, hooks, plugins, and active event subscribers.
	 *
	 * Useful for standalone callers that persist conversations externally and
	 * want to re-seed the runtime from storage without recreating subscribers.
	 */
	restore(messages: readonly AgentMessage[]): void {
		this.abort("Agent state restored");
		// Reset state that is not carried across restores. Keep `listeners`,
		// tools, hooks, plugins, model, and agent identity so external event
		// subscribers continue to receive events after restore().
		this.state.runId = undefined;
		this.state.status = "idle";
		this.state.iteration = 0;
		this.state.pendingToolCalls = [];
		this.state.usage = cloneUsage(DEFAULT_USAGE);
		this.state.lastError = undefined;
		this.state.messages = cloneMessages(messages);
		this.config = {
			...this.config,
			initialMessages: cloneMessages(messages),
		};
	}

	snapshot(): AgentRuntimeStateSnapshot {
		return {
			agentId: this.state.agentId,
			agentRole: this.state.agentRole,
			parentAgentId: this.state.parentAgentId,
			conversationId: this.config.conversationId?.trim() || undefined,
			runId: this.state.runId,
			status: this.state.status,
			iteration: this.state.iteration,
			messages: cloneMessages(this.state.messages),
			pendingToolCalls: [...this.state.pendingToolCalls],
			usage: cloneUsage(this.state.usage),
			lastError: this.state.lastError,
		};
	}

	private async ensureInitialized(): Promise<void> {
		this.initialization ??= this.initialize();
		await this.initialization;
	}

	private async initialize(): Promise<void> {
		this.registerHooks(this.config.hooks);
		for (const tool of this.config.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		for (const plugin of this.config.plugins ?? []) {
			const setup = await plugin.setup?.({
				agentId: this.state.agentId,
				agentRole: this.state.agentRole,
				systemPrompt: this.config.systemPrompt,
			});
			for (const tool of setup?.tools ?? []) {
				this.tools.set(tool.name, tool);
			}
			this.registerHooks(setup?.hooks);
		}
	}

	private registerHooks(hooks: Partial<AgentRuntimeHooks> | undefined): void {
		if (!hooks) {
			return;
		}
		if (hooks.beforeRun) this.hooks.beforeRun.push(hooks.beforeRun);
		if (hooks.afterRun) this.hooks.afterRun.push(hooks.afterRun);
		if (hooks.beforeModel) this.hooks.beforeModel.push(hooks.beforeModel);
		if (hooks.afterModel) this.hooks.afterModel.push(hooks.afterModel);
		if (hooks.beforeTool) this.hooks.beforeTool.push(hooks.beforeTool);
		if (hooks.afterTool) this.hooks.afterTool.push(hooks.afterTool);
		if (hooks.onEvent) this.hooks.onEvent.push(hooks.onEvent);
	}

	private validateResumeToolBatch(
		input: AgentRuntimeResumeToolBatch,
		previousRunId: string | undefined,
		previousIteration: number,
	): ResumeToolBatchState {
		if (!isRecord(input)) {
			throw new Error(
				"Cannot resume pending tool call: malformed resume input",
			);
		}
		const runId = requireResumeString(input.runId, "runId");
		const assistantMessageId = requireResumeString(
			input.assistantMessageId,
			"assistantMessageId",
		);
		if (!Number.isSafeInteger(input.iteration) || input.iteration < 1) {
			throw new Error(
				"Cannot resume pending tool call: iteration must be a positive integer",
			);
		}
		if (
			!Array.isArray(input.calls) ||
			input.calls.length < 1 ||
			input.calls.length > MAX_RESUME_TOOL_BATCH
		) {
			throw new Error(
				`Cannot resume pending tool call: calls must contain 1 to ${MAX_RESUME_TOOL_BATCH} entries`,
			);
		}
		if (
			this.config.toolExecution !== "sequential" &&
			this.config.toolExecution !== "parallel"
		) {
			throw new Error(
				"Cannot resume pending tool call: unsupported tool execution",
			);
		}
		if (this.state.parentAgentId != null) {
			throw new Error(
				"Cannot resume pending tool call: only a root run can be resumed",
			);
		}
		if (
			(previousRunId !== undefined && previousRunId !== runId) ||
			(previousIteration !== 0 && previousIteration !== input.iteration)
		) {
			throw new Error(
				"Cannot resume pending tool call: run identity does not match runtime state",
			);
		}

		const initialMessages = this.config.initialMessages;
		if (!Array.isArray(initialMessages) || initialMessages.length === 0) {
			throw new Error(
				"Cannot resume pending tool call: initialMessages must contain the persisted assistant message",
			);
		}
		if (!areEquivalentValues(this.state.messages, initialMessages)) {
			throw new Error(
				"Cannot resume pending tool call: runtime conversation does not match initialMessages",
			);
		}

		const assistantMessage = initialMessages.at(-1);
		if (!assistantMessage || assistantMessage.role !== "assistant") {
			throw new Error(
				"Cannot resume pending tool call: persisted assistant message must be the last message",
			);
		}
		if (assistantMessage.id !== assistantMessageId) {
			throw new Error(
				"Cannot resume pending tool call: assistant message identity mismatch",
			);
		}
		if (!Array.isArray(assistantMessage.content)) {
			throw new Error(
				"Cannot resume pending tool call: persisted assistant message is malformed",
			);
		}

		const toolCalls: AgentToolCallPart[] = [];
		for (const part of assistantMessage.content) {
			if (!isRecord(part) || typeof part.type !== "string") {
				throw new Error(
					"Cannot resume pending tool call: persisted assistant message is malformed",
				);
			}
			if (part.type === "tool-result") {
				throw new Error(
					"Cannot resume pending tool call: persisted assistant message already contains a tool result",
				);
			}
			if (part.type === "tool-call") {
				if (
					typeof part.toolCallId !== "string" ||
					typeof part.toolName !== "string" ||
					!Object.hasOwn(part, "input")
				) {
					throw new Error(
						"Cannot resume pending tool call: persisted tool call is malformed",
					);
				}
				toolCalls.push(part as unknown as AgentToolCallPart);
			}
		}
		if (toolCalls.length !== input.calls.length) {
			throw new Error(
				"Cannot resume pending tool call: persisted assistant message tool calls do not match the resume batch",
			);
		}

		const resumedToolCallIds = new Set<string>();
		const entries: ResumeToolCallState[] = [];
		for (const [index, call] of input.calls.entries()) {
			if (!isRecord(call)) {
				throw new Error(
					"Cannot resume pending tool call: malformed resume batch entry",
				);
			}
			const toolCallId = requireResumeString(call.toolCallId, "toolCallId");
			const toolName = requireResumeString(call.toolName, "toolName");
			if (resumedToolCallIds.has(toolCallId)) {
				throw new Error(
					"Cannot resume pending tool call: duplicate tool call id in resume batch",
				);
			}
			resumedToolCallIds.add(toolCallId);
			if (
				!Object.hasOwn(call, "preparedInput") ||
				call.preparedInput === undefined
			) {
				throw new Error(
					"Cannot resume pending tool call: preparedInput is required",
				);
			}
			if (
				!isRecord(call.approval) ||
				typeof call.approval.approved !== "boolean" ||
				(call.approval.reason !== undefined &&
					typeof call.approval.reason !== "string")
			) {
				throw new Error(
					"Cannot resume pending tool call: malformed approval result",
				);
			}
			if (call.stepId !== undefined && typeof call.stepId !== "string") {
				throw new Error(
					"Cannot resume pending tool call: step identity must be a string",
				);
			}
			const toolCall = toolCalls[index] as AgentToolCallPart;
			if (
				toolCall.toolCallId !== toolCallId ||
				toolCall.toolName !== toolName
			) {
				throw new Error(
					"Cannot resume pending tool call: tool call identity mismatch",
				);
			}
			if (!areEquivalentValues(toolCall.input, call.preparedInput)) {
				throw new Error(
					"Cannot resume pending tool call: prepared input does not match persisted tool call",
				);
			}
			const tool = this.tools.get(toolName);
			if (!tool) {
				throw new Error(
					`Cannot resume pending tool call: unknown tool "${toolName}"`,
				);
			}
			entries.push({ assistantMessage, toolCall, tool });
		}

		for (const [messageIndex, message] of initialMessages.entries()) {
			if (messageIndex === initialMessages.length - 1) {
				continue;
			}
			if (isRecord(message) && message.id === assistantMessageId) {
				throw new Error(
					"Cannot resume pending tool call: assistant message has already been persisted",
				);
			}
			if (!isRecord(message) || !Array.isArray(message.content)) {
				throw new Error(
					"Cannot resume pending tool call: initialMessages are malformed",
				);
			}
			for (const part of message.content) {
				if (!isRecord(part)) {
					throw new Error(
						"Cannot resume pending tool call: initialMessages are malformed",
					);
				}
				if (
					(part.type === "tool-call" || part.type === "tool-result") &&
					typeof part.toolCallId === "string" &&
					resumedToolCallIds.has(part.toolCallId)
				) {
					throw new Error(
						"Cannot resume pending tool call: tool call has already been persisted",
					);
				}
			}
		}

		return { assistantMessage, entries };
	}

	private getRequiredCompletionToolNames(): string[] {
		if (this.config.completionPolicy?.requireCompletionTool !== true) {
			return [];
		}
		return [...this.tools.values()]
			.filter((tool) => tool.lifecycle?.completesRun === true)
			.map((tool) => tool.name)
			.sort();
	}

	private getCompletionToolReminderMessage(): string | undefined {
		const terminalToolNames = this.getRequiredCompletionToolNames();
		if (terminalToolNames.length === 0) {
			return undefined;
		}
		return `[SYSTEM] This run is not complete until you call one of these terminal completion tools: ${terminalToolNames.join(
			", ",
		)}. Continue working if requirements are not met. If the task is complete, call the appropriate terminal completion tool now.`;
	}

	private getCompletionReminderMessages(): string[] {
		return [
			this.getCompletionToolReminderMessage(),
			this.config.completionPolicy?.completionGuard?.(),
		].filter((message): message is string => Boolean(message));
	}

	private async addUserReminderMessage(text: string): Promise<AgentMessage> {
		const reminderMessage = createMessage("user", [{ type: "text", text }]);
		this.state.messages.push(reminderMessage);
		await this.emit({
			type: "message-added",
			snapshot: this.snapshot(),
			message: reminderMessage,
		});
		return reminderMessage;
	}

	private async execute(
		input?: AgentRunInput,
		resume?: AgentRuntimeResumeToolBatch,
	): Promise<AgentRunResult> {
		// No-op span unless a TracerProvider is registered. Root of the
		// agent-layer span tree; "agent.tool" spans below attach as children.
		const span = agentTracer.startSpan(
			"agent.run",
			{
				attributes: {
					"agent.id": this.state.agentId,
					"agent.session_id": this.config.sessionId,
					"agent.parent_agent_id": this.state.parentAgentId ?? undefined,
					"agent.model_id": this.config.messageModelInfo?.id,
					"agent.provider_id": this.config.messageModelInfo?.provider,
				},
			},
			context.active(),
		);
		try {
			const result = await context.with(
				trace.setSpan(context.active(), span),
				() => this.executeLoop(input, resume),
			);
			span.setAttribute("agent.status", result.status);
			span.setAttribute("agent.iterations", result.iterations);
			span.setAttribute("agent.run_id", result.runId);
			if (result.status === "failed" && result.error) {
				span.recordException(result.error);
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: result.error.message,
				});
			}
			return result;
		} catch (error) {
			span.recordException(error as Error);
			span.setStatus({ code: SpanStatusCode.ERROR });
			throw error;
		} finally {
			span.end();
		}
	}

	/** Body of the agent loop, wrapped by the "agent.run" span in execute(). */
	private async executeLoop(
		input?: AgentRunInput,
		resume?: AgentRuntimeResumeToolBatch,
	): Promise<AgentRunResult> {
		await this.ensureInitialized();
		if (this.state.status === "running") {
			throw new Error("Agent runtime is already running");
		}

		const previousRunId = this.state.runId;
		const previousIteration = this.state.iteration;
		const isResume = resume !== undefined;
		const resumeRunId =
			typeof resume?.runId === "string" ? resume.runId : createUID("run");
		const resumeIteration =
			typeof resume?.iteration === "number" && Number.isFinite(resume.iteration)
				? resume.iteration
				: 0;
		this.abortController = new AbortController();
		this.state.runId = isResume
			? resumeRunId
			: (this.configuredRunId ?? createUID("run"));
		this.configuredRunId = undefined;
		this.state.status = "running";
		this.state.iteration = isResume ? resumeIteration : 0;
		this.state.pendingToolCalls = [];
		this.state.lastError = undefined;
		if (!isResume) {
			this.state.usage = cloneUsage(DEFAULT_USAGE);
		}

		try {
			await this.callBeforeRunHooks();
			await this.emit({ type: "run-started", snapshot: this.snapshot() });

			let finalAssistantMessage: AgentMessage | undefined;
			if (resume !== undefined) {
				const resumed = this.validateResumeToolBatch(
					resume,
					previousRunId,
					previousIteration,
				);
				this.state.pendingToolCalls = resumed.entries.map(
					(entry) => entry.toolCall.toolCallId,
				);
				await this.emit({
					type: "turn-started",
					snapshot: this.snapshot(),
					iteration: this.state.iteration,
				});
				const resumedPrepared: PreparedToolExecution[] = resumed.entries.map(
					(entry, callIndex) => {
						const call = resume.calls[
							callIndex
						] as AgentRuntimeResumeToolCallEntry;
						return {
							toolCall: {
								...entry.toolCall,
								input: call.preparedInput,
							},
							callIndex,
							stepId:
								call.stepId ??
								createToolStepId(
									this.state.runId,
									this.state.iteration,
									callIndex,
								),
							tool: entry.tool,
							input: call.preparedInput,
							denialReason: call.approval.approved
								? undefined
								: call.approval.reason ||
									`Tool "${entry.toolCall.toolName}" was not approved`,
						};
					},
				);
				const resumedToolMessages =
					this.config.toolExecution === "parallel"
						? (await this.executePreparedToolsInParallel(resumedPrepared)).map(
								(outcome, index) =>
									outcome.status === "fulfilled"
										? outcome.value
										: this.createToolFailureMessage(
												resumedPrepared[index] as PreparedToolExecution,
												outcome.reason,
											),
							)
						: await this.executeResumeToolCallsSequentially(resumedPrepared);
				this.state.pendingToolCalls = [];
				for (const toolMessage of resumedToolMessages) {
					this.state.messages.push(toolMessage);
					await this.emit({
						type: "message-added",
						snapshot: this.snapshot(),
						message: toolMessage,
					});
				}
				await this.emit({
					type: "turn-finished",
					snapshot: this.snapshot(),
					iteration: this.state.iteration,
					toolCallCount: resumedToolMessages.length,
				});
				finalAssistantMessage = resumed.assistantMessage;
				const terminalToolMessage = this.findCompletingToolMessage(
					resumed.entries.map((entry) => entry.toolCall),
					resumedToolMessages,
				);
				if (terminalToolMessage) {
					const result = this.finishRun(
						"completed",
						finalAssistantMessage,
						textFromToolMessage(terminalToolMessage) || undefined,
					);
					await this.callAfterRunHooks(result);
					await this.emit({
						type: "run-finished",
						snapshot: this.snapshot(),
						result,
					});
					return result;
				}
				const completionToolReminder = this.getCompletionToolReminderMessage();
				if (completionToolReminder) {
					await this.addUserReminderMessage(completionToolReminder);
				}
			} else {
				for (const message of input ? normalizeInput(input) : []) {
					this.state.messages.push(message);
					await this.emit({
						type: "message-added",
						snapshot: this.snapshot(),
						message,
					});
				}

				const completionToolReminder = this.getCompletionToolReminderMessage();
				if (completionToolReminder) {
					await this.addUserReminderMessage(completionToolReminder);
				}
			}

			while (
				this.config.maxIterations === undefined ||
				this.state.iteration < this.config.maxIterations
			) {
				this.throwIfAborted();

				// Budget is a pre-request gate: the in-flight turn always finishes so
				// every tool call keeps a tool result, and the run stops here instead
				// of paying for another model call.
				const budgetStop = this.resolveBudgetStop();
				if (budgetStop) {
					return await this.finishBudgetExhausted(
						budgetStop,
						finalAssistantMessage,
					);
				}

				this.state.iteration += 1;
				await this.emit({
					type: "turn-started",
					snapshot: this.snapshot(),
					iteration: this.state.iteration,
				});

				const { message, finishReason } = await this.generateAssistantMessage();
				if (finishReason === "aborted") {
					throw this.normalizeAbortError();
				}
				if (message.content.length === 0) {
					throw new Error(
						finishReason === "error"
							? (this.state.lastError ?? "Model stream failed")
							: "Model returned empty response",
					);
				}
				const toolCalls = message.content.filter(
					(part: AgentMessagePart): part is AgentToolCallPart =>
						part.type === "tool-call",
				);

				finalAssistantMessage = message;
				this.state.messages.push(message);
				await this.emit({
					type: "message-added",
					snapshot: this.snapshot(),
					message,
				});
				await this.emit({
					type: "assistant-message",
					snapshot: this.snapshot(),
					iteration: this.state.iteration,
					message,
					finishReason,
				});

				if (finishReason === "max-tokens" && toolCalls.length === 0) {
					throw new Error(MAX_TOKENS_INCOMPLETE_TURN_MESSAGE);
				}
				if (finishReason === "error" && toolCalls.length === 0) {
					throw new Error(this.state.lastError ?? "Model stream failed");
				}
				this.state.pendingToolCalls = toolCalls.map((part) => part.toolCallId);

				if (toolCalls.length === 0) {
					await this.emit({
						type: "turn-finished",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						toolCallCount: 0,
					});
					const completionReminderMessages =
						this.getCompletionReminderMessages();
					if (completionReminderMessages.length > 0) {
						for (const reminderMessage of completionReminderMessages) {
							await this.addUserReminderMessage(reminderMessage);
						}
						continue;
					}
					const result = this.finishRun("completed", finalAssistantMessage);
					await this.callAfterRunHooks(result);
					await this.emit({
						type: "run-finished",
						snapshot: this.snapshot(),
						result,
					});
					return result;
				}

				const toolMessages = await this.executeToolCalls(toolCalls);
				this.state.pendingToolCalls = [];
				for (const toolMessage of toolMessages) {
					this.state.messages.push(toolMessage);
					await this.emit({
						type: "message-added",
						snapshot: this.snapshot(),
						message: toolMessage,
					});
				}
				await this.emit({
					type: "turn-finished",
					snapshot: this.snapshot(),
					iteration: this.state.iteration,
					toolCallCount: toolCalls.length,
				});
				const terminalToolMessage = this.findCompletingToolMessage(
					toolCalls,
					toolMessages,
				);
				if (terminalToolMessage) {
					const result = this.finishRun(
						"completed",
						finalAssistantMessage,
						textFromToolMessage(terminalToolMessage) || undefined,
					);
					await this.callAfterRunHooks(result);
					await this.emit({
						type: "run-finished",
						snapshot: this.snapshot(),
						result,
					});
					return result;
				}
			}

			throw new Error(
				`Agent runtime exceeded maxIterations (${this.config.maxIterations})`,
			);
		} catch (error) {
			const normalized =
				error instanceof Error ? error : new Error(String(error));
			const isControlledStop = normalized instanceof ControlledStopError;
			const isAborted = this.abortController.signal.aborted || isControlledStop;
			const status = isAborted ? "aborted" : "failed";
			this.state.status = status;
			this.state.lastError = normalized.message;
			const lastAssistantMessage = this.findLastAssistantMessage();
			const result: AgentRunResult = {
				agentId: this.state.agentId,
				agentRole: this.state.agentRole,
				runId: this.state.runId ?? createUID("run"),
				status,
				iterations: this.state.iteration,
				outputText: textFromMessage(lastAssistantMessage),
				messages: cloneMessages(this.state.messages),
				usage: cloneUsage(this.state.usage),
				error: status === "failed" ? normalized : undefined,
			};
			this.config.logger?.log?.("Agent loop caught error", {
				severity: status === "failed" ? "error" : "warn",
				agentId: this.state.agentId,
				agentRole: this.state.agentRole,
				runId: result.runId,
				status,
				iteration: this.state.iteration,
				errorName: normalized.name,
				errorMessage: normalized.message,
				assistantContentPartCount: lastAssistantMessage?.content.length ?? 0,
			});
			await this.callAfterRunHooks(result);
			if (status === "failed") {
				await this.emit({
					type: "run-failed",
					snapshot: this.snapshot(),
					error: normalized,
				});
			} else {
				await this.emit({
					type: "run-finished",
					snapshot: this.snapshot(),
					result,
				});
			}
			return result;
		} finally {
			this.abortController = undefined;
		}
	}

	private async callBeforeRunHooks(): Promise<void> {
		for (const hook of this.hooks.beforeRun) {
			const control = (await hook({
				snapshot: this.snapshot(),
			})) as AgentStopControl | undefined;
			this.applyStopControl(control);
		}
	}

	private async callAfterRunHooks(result: AgentRunResult): Promise<void> {
		for (const hook of this.hooks.afterRun) {
			await hook({ snapshot: this.snapshot(), result });
		}
	}

	private async generateAssistantMessage(): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	}> {
		const usageBeforeModel = cloneUsage(this.state.usage);
		const modelRequestMetadata = omitUndefinedValues({
			sessionId: trimNonEmpty(this.config.sessionId),
			agentId: this.state.agentId,
			conversationId: trimNonEmpty(this.config.conversationId),
			runId: this.state.runId,
			iteration: this.state.iteration,
		});
		let request: AgentModelRequest = {
			systemPrompt: this.config.systemPrompt,
			messages: cloneMessages(this.state.messages),
			tools: [...this.tools.values()].map<AgentToolDefinition>((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			})),
			signal: this.abortController?.signal,
			options: mergeModelOptions(this.config.modelOptions, {
				metadata: modelRequestMetadata,
			}),
		};

		if (this.state.iteration > 1) {
			const pendingUserMessage = await this.consumePendingUserMessage();
			if (pendingUserMessage) {
				request = {
					...request,
					messages: [
						...request.messages,
						...cloneMessages([pendingUserMessage]),
					],
				};
			}
		}

		request = await this.prepareTurnForModelRequest(request);

		for (const hook of this.hooks.beforeModel) {
			const result = (await hook({
				snapshot: this.snapshot(),
				request,
			})) as AgentBeforeModelResult | undefined;
			this.applyStopControl(result);
			if (result?.messages) {
				request = { ...request, messages: cloneMessages(result.messages) };
			}
			if (result?.tools) {
				request = { ...request, tools: [...result.tools] };
			}
			if (result?.options) {
				request = {
					...request,
					options: mergeModelOptions(request.options, result.options),
				};
			}
		}

		this.config.logger?.debug("Agent model request diagnostics", {
			iteration: this.state.iteration,
			providerId:
				"providerId" in this.config &&
				typeof this.config.providerId === "string"
					? this.config.providerId
					: undefined,
			modelId:
				"modelId" in this.config && typeof this.config.modelId === "string"
					? this.config.modelId
					: undefined,
			...summarizeModelRequest(request),
		});

		const stream = await this.config.model.stream(request);
		const content: AgentMessagePart[] = [];
		const toolAssemblies = new Map<string, PendingToolAssembly>();
		const invalidToolCalls: InvalidToolCall[] = [];
		const sequence: Array<
			{ type: "tool"; key: string } | { type: "part"; part: AgentMessagePart }
		> = [];
		let nextToolIndex = 0;
		let finishReason: AgentModelFinishReason = "stop";
		let accumulatedText = "";
		let accumulatedReasoning = "";

		for await (const event of stream) {
			this.throwIfAborted();
			switch (event.type) {
				case "text-delta": {
					accumulatedText += event.text;
					const last = sequence.at(-1);
					if (last?.type === "part" && last.part.type === "text") {
						last.part.text += event.text;
					} else {
						sequence.push({
							type: "part",
							part: { type: "text", text: event.text },
						});
					}
					await this.emit({
						type: "assistant-text-delta",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						text: event.text,
						accumulatedText,
					});
					break;
				}
				case "reasoning-delta": {
					accumulatedReasoning += event.text;
					const last = sequence.at(-1);
					if (last?.type === "part" && last.part.type === "reasoning") {
						last.part.text += event.text;
						last.part.redacted = event.redacted ?? last.part.redacted;
						last.part.metadata = event.metadata ?? last.part.metadata;
					} else {
						sequence.push({
							type: "part",
							part: {
								type: "reasoning",
								text: event.text,
								redacted: event.redacted,
								metadata: event.metadata,
							},
						});
					}
					await this.emit({
						type: "assistant-reasoning-delta",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						text: event.text,
						accumulatedText: accumulatedReasoning,
						redacted: event.redacted,
						metadata: event.metadata,
					});
					break;
				}
				case "tool-call-delta": {
					const key =
						event.toolCallId ?? `tool_${event.index ?? nextToolIndex}`;
					if (event.index == null && event.toolCallId == null) {
						nextToolIndex += 1;
					}
					let assembly = toolAssemblies.get(key);
					if (!assembly) {
						assembly = {
							toolCallId: event.toolCallId ?? createUID("tool"),
							inputText: "",
						};
						toolAssemblies.set(key, assembly);
						sequence.push({ type: "tool", key });
					}
					if (event.toolCallId) {
						assembly.toolCallId = event.toolCallId;
					}
					if (event.toolName) {
						assembly.toolName = event.toolName;
					}
					if (event.input !== undefined) {
						assembly.inputValue = event.input;
					}
					if (event.metadata !== undefined) {
						assembly.metadata = mergeToolMetadata(
							assembly.metadata,
							event.metadata,
						);
					}
					if (event.inputText) {
						assembly.inputText = mergeToolInputText(
							assembly.inputText,
							event.inputText,
						);
					}
					break;
				}
				case "usage": {
					await this.updateUsage(event.usage);
					break;
				}
				case "finish": {
					finishReason = event.reason;
					if (event.error) {
						this.state.lastError = event.error;
					}
					break;
				}
			}
		}

		for (const item of sequence) {
			if (item.type === "part") {
				content.push(item.part);
				continue;
			}
			const assembly = toolAssemblies.get(item.key);
			if (!assembly?.toolName) {
				invalidToolCalls.push({
					toolCallId: assembly?.toolCallId ?? item.key,
					input: buildInvalidToolInput(assembly?.inputText ?? ""),
					reason: "missing_name",
				});
				continue;
			}
			const parsed = parseToolInput(assembly);
			if (parsed.reason) {
				invalidToolCalls.push({
					toolCallId: assembly.toolCallId,
					toolName: assembly.toolName,
					input: parsed.invalidInput,
					reason: parsed.reason,
				});
			}
			content.push({
				type: "tool-call",
				toolCallId: assembly.toolCallId,
				toolName: assembly.toolName,
				input: parsed.input,
				metadata: parsed.parseError
					? mergeToolMetadata(assembly.metadata, {
							inputParseError: parsed.parseError,
							rawInputText: assembly.inputText,
						})
					: assembly.metadata,
			});
		}

		const message = createMessage(
			"assistant",
			content,
			invalidToolCalls.length > 0 ? { invalidToolCalls } : undefined,
		);
		const metrics = usageDelta(usageBeforeModel, this.state.usage);
		if (metrics) {
			message.metrics = metrics;
			this.captureUnexpectedReasoningTokens(request, metrics);
		}
		if (this.config.messageModelInfo) {
			message.modelInfo = { ...this.config.messageModelInfo };
		}
		for (const hook of this.hooks.afterModel) {
			const control = (await hook({
				snapshot: this.snapshot(),
				assistantMessage: message,
				finishReason,
			})) as AgentStopControl | undefined;
			this.applyStopControl(control);
		}

		return { message, finishReason };
	}

	private captureUnexpectedReasoningTokens(
		request: AgentModelRequest,
		metrics: NonNullable<AgentMessage["metrics"]>,
	): void {
		if (
			!reasoningWasRequestedOff(request) ||
			(metrics.reasoningTokenCount ?? 0) <= 0
		) {
			return;
		}
		const reasoningTokenCount = metrics.reasoningTokenCount;
		if (reasoningTokenCount === undefined) {
			return;
		}

		captureAgentUnexpectedReasoningTokens(this.config.telemetry, {
			sessionId: this.config.sessionId,
			agentId: this.state.agentId,
			runId: this.state.runId,
			iteration: this.state.iteration,
			providerId: this.config.messageModelInfo?.provider,
			modelId: this.config.messageModelInfo?.id,
			requestedThinking: false,
			reasoningTokenCount,
		});
	}

	private async prepareTurnForModelRequest(
		request: AgentModelRequest,
	): Promise<AgentModelRequest> {
		if (!this.config.prepareTurn) {
			return request;
		}

		const result = await this.config.prepareTurn({
			agentId: this.state.agentId,
			conversationId: this.config.conversationId,
			parentAgentId: this.state.parentAgentId ?? null,
			iteration: this.state.iteration,
			messages: request.messages,
			systemPrompt: request.systemPrompt,
			tools: request.tools,
			model: {
				id: this.config.messageModelInfo?.id,
				provider: this.config.messageModelInfo?.provider,
			},
			signal: request.signal,
			emitStatusNotice: (message, metadata) => {
				void this.emit({
					type: "status-notice",
					snapshot: this.snapshot(),
					message,
					metadata,
				});
			},
		});
		if (!result) {
			return request;
		}

		let next = request;
		if (result.messages) {
			const preparedMessages = cloneMessages(result.messages);
			next = { ...next, messages: cloneMessages(preparedMessages) };
		}
		if (result.systemPrompt !== undefined) {
			next = { ...next, systemPrompt: result.systemPrompt };
		}
		return next;
	}

	private async consumePendingUserMessage(): Promise<AgentMessage | undefined> {
		const consumePendingUserMessage = this.config.consumePendingUserMessage;
		if (!consumePendingUserMessage) {
			return undefined;
		}
		const pending = (await consumePendingUserMessage())?.trim();
		if (!pending) {
			return undefined;
		}
		const message = createMessage("user", [{ type: "text", text: pending }]);
		this.state.messages.push(message);
		await this.emit({
			type: "message-added",
			snapshot: this.snapshot(),
			message,
		});
		return message;
	}

	private async updateUsage(usage: Partial<AgentUsage>): Promise<void> {
		this.state.usage = {
			inputTokens: this.state.usage.inputTokens + (usage.inputTokens ?? 0),
			outputTokens: this.state.usage.outputTokens + (usage.outputTokens ?? 0),
			cacheReadTokens:
				this.state.usage.cacheReadTokens + (usage.cacheReadTokens ?? 0),
			cacheWriteTokens:
				this.state.usage.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
			reasoningTokenCount:
				(this.state.usage.reasoningTokenCount ?? 0) +
				(usage.reasoningTokenCount ?? 0),
			totalCost: (this.state.usage.totalCost ?? 0) + (usage.totalCost ?? 0),
		};
		await this.emit({
			type: "usage-updated",
			snapshot: this.snapshot(),
			usage: cloneUsage(this.state.usage),
		});
	}

	/**
	 * Resolve the run budget against cumulative usage, or `undefined` when the
	 * run may continue. The comparison is `>=` on purpose: a cap is a ceiling
	 * the run must not cross, and a provider that reports zero tokens (usage
	 * unavailable) must not silently disable a cost guardrail.
	 */
	private resolveBudgetStop(): AgentRunBudgetStatus | undefined {
		const budget = this.runBudget;
		if (!budget) {
			return undefined;
		}
		const usage = this.state.usage;
		const totalTokens = usage.inputTokens + usage.outputTokens;
		const totalCost = usage.totalCost ?? 0;
		const checks: Array<{
			limit: AgentRunBudgetStatus["limit"];
			cap: number | undefined;
			used: number;
		}> = [
			{
				limit: "maxInputTokens",
				cap: budget.maxInputTokens,
				used: usage.inputTokens,
			},
			{
				limit: "maxOutputTokens",
				cap: budget.maxOutputTokens,
				used: usage.outputTokens,
			},
			{
				limit: "maxTotalTokens",
				cap: budget.maxTotalTokens,
				used: totalTokens,
			},
			{ limit: "maxTotalCost", cap: budget.maxTotalCost, used: totalCost },
		];
		for (const check of checks) {
			if (check.cap !== undefined && check.used >= check.cap) {
				return {
					limit: check.limit,
					cap: check.cap,
					used: check.used,
					usage: cloneUsage(usage),
				};
			}
		}
		return undefined;
	}

	/**
	 * Stop the run because a budget cap was reached. The in-flight turn has
	 * already produced valid tool results, so the transcript stays valid and the
	 * run ends with a controlled `budget_exhausted` status rather than a thrown
	 * error — an exhausted budget is a policy outcome, not a failure.
	 */
	private async finishBudgetExhausted(
		status: AgentRunBudgetStatus,
		assistantMessage?: AgentMessage,
	): Promise<AgentRunResult> {
		await this.emit({
			type: "status-notice",
			snapshot: this.snapshot(),
			message: `Run budget exhausted: ${status.limit} reached ${status.used} of ${status.cap}`,
			metadata: { kind: "budget_exhausted", ...status },
		});
		const result = this.finishRun(
			"budget_exhausted",
			assistantMessage,
			undefined,
		);
		await this.callAfterRunHooks(result);
		await this.emit({
			type: "run-finished",
			snapshot: this.snapshot(),
			result,
		});
		return result;
	}

	private async executeResumeToolCall(
		prepared: PreparedToolExecution,
	): Promise<AgentMessage> {
		try {
			return await this.executePreparedTool(prepared);
		} catch (error) {
			if (
				this.abortController?.signal.aborted ||
				error instanceof AgentRuntimeAbortError
			) {
				throw error;
			}
			return this.createToolFailureMessage(prepared, error);
		}
	}

	private async executeResumeToolCallsSequentially(
		prepared: PreparedToolExecution[],
	): Promise<AgentMessage[]> {
		const messages: AgentMessage[] = [];
		for (const execution of prepared) {
			messages.push(await this.executeResumeToolCall(execution));
		}
		return messages;
	}

	private async executeToolCalls(
		toolCalls: AgentToolCallPart[],
	): Promise<AgentMessage[]> {
		const prepared: PreparedToolExecution[] = [];
		for (const [callIndex, toolCall] of toolCalls.entries()) {
			try {
				prepared.push(await this.prepareToolExecution(toolCall, callIndex));
			} catch (error) {
				this.throwIfAborted();
				prepared.push({
					toolCall,
					callIndex,
					stepId: createToolStepId(
						this.state.runId,
						this.state.iteration,
						callIndex,
					),
					tool: this.tools.get(toolCall.toolName),
					input: toolCall.input,
					skipReason: `Tool "${toolCall.toolName}" preparation failed: ${this.toolErrorText(error)}`,
				});
			}
		}

		if (this.config.toolExecution === "parallel") {
			const settled = await this.executePreparedToolsInParallel(prepared);
			this.throwIfAborted();
			return settled.map((outcome, index) =>
				outcome.status === "fulfilled"
					? outcome.value
					: this.createToolFailureMessage(
							prepared[index] as PreparedToolExecution,
							outcome.reason,
						),
			);
		}

		const results: AgentMessage[] = [];
		for (const execution of prepared) {
			try {
				results.push(await this.executePreparedTool(execution));
			} catch (error) {
				if (
					this.abortController?.signal.aborted ||
					error instanceof AgentRuntimeAbortError
				) {
					throw error;
				}
				results.push(this.createToolFailureMessage(execution, error));
			}
		}
		return results;
	}

	private async executePreparedToolsInParallel(
		prepared: PreparedToolExecution[],
	): Promise<PromiseSettledResult<AgentMessage>[]> {
		if (prepared.length < 2) {
			return Promise.allSettled(
				prepared.map((execution) => this.executePreparedTool(execution)),
			);
		}
		const configuredLimit = this.config.maxParallelToolCalls;
		const workerCount =
			typeof configuredLimit === "number" &&
			Number.isFinite(configuredLimit) &&
			configuredLimit > 0
				? Math.min(prepared.length, Math.floor(configuredLimit))
				: prepared.length;
		const results = new Array<PromiseSettledResult<AgentMessage>>(
			prepared.length,
		);
		let nextIndex = 0;
		const worker = async (): Promise<void> => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= prepared.length) {
					return;
				}
				try {
					results[index] = {
						status: "fulfilled",
						value: await this.executePreparedTool(
							prepared[index] as PreparedToolExecution,
						),
					};
				} catch (reason) {
					results[index] = { status: "rejected", reason };
				}
			}
		};
		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}

	private createToolFailureMessage(
		prepared: PreparedToolExecution,
		error: unknown,
	): AgentMessage {
		return createMessage("tool", [
			{
				type: "tool-result",
				toolCallId: prepared.toolCall.toolCallId,
				toolName: prepared.toolCall.toolName,
				output: { error: this.toolErrorText(error) },
				isError: true,
			},
		]);
	}

	private toolErrorText(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private findCompletingToolMessage(
		toolCalls: AgentToolCallPart[],
		toolMessages: AgentMessage[],
	): AgentMessage | undefined {
		for (let index = 0; index < toolCalls.length; index += 1) {
			const toolCall = toolCalls[index];
			if (this.tools.get(toolCall.toolName)?.lifecycle?.completesRun !== true) {
				continue;
			}
			const toolMessage = toolMessages[index];
			const result = toolMessage?.content.find(
				(part): part is Extract<AgentMessagePart, { type: "tool-result" }> =>
					part.type === "tool-result" &&
					part.toolCallId === toolCall.toolCallId,
			);
			if (result && !result.isError) {
				return toolMessage;
			}
		}
		return undefined;
	}

	private async prepareToolExecution(
		toolCall: AgentToolCallPart,
		callIndex: number,
	): Promise<PreparedToolExecution> {
		const tool = this.tools.get(toolCall.toolName);
		const stepId = createToolStepId(
			this.state.runId,
			this.state.iteration,
			callIndex,
		);
		let input = toolCall.input;
		let skipReason: string | undefined;
		const metadata =
			toolCall.metadata &&
			typeof toolCall.metadata === "object" &&
			!Array.isArray(toolCall.metadata)
				? (toolCall.metadata as Record<string, unknown>)
				: undefined;

		if (typeof metadata?.inputParseError === "string") {
			skipReason = metadata.inputParseError;
		}

		const toolSource =
			metadata?.toolSource &&
			typeof metadata.toolSource === "object" &&
			!Array.isArray(metadata.toolSource)
				? (metadata.toolSource as Record<string, unknown>)
				: undefined;
		if (toolSource?.executionMode === "provider") {
			const providerId =
				typeof toolSource.providerId === "string"
					? toolSource.providerId
					: "provider";
			skipReason = `Tool execution is disabled for provider ${providerId}`;
		}

		if (tool && !skipReason) {
			input = normalizeJsonLikeStringsForSchema(input, tool.inputSchema);
		}

		let policyOverride: ToolPolicy | undefined;
		if (tool && !skipReason) {
			for (const hook of this.hooks.beforeTool) {
				const result = (await hook({
					snapshot: this.snapshot(),
					tool,
					toolCall: { ...toolCall, input },
					stepId,
					input,
				})) as AgentBeforeToolResult | undefined;
				if (result?.input !== undefined) {
					input = result.input;
				}
				if (result?.policy) {
					policyOverride = {
						...policyOverride,
						...result.policy,
					};
				}
				this.applyStopControl(result);
				if (result?.skip) {
					skipReason =
						result.reason ?? `Tool ${tool.name} was blocked by a runtime hook`;
					break;
				}
			}
		}

		if (tool?.validateInput && !skipReason) {
			try {
				input = tool.validateInput(input);
			} catch (error) {
				skipReason = `Tool "${tool.name}" input validation failed: ${this.toolErrorText(error)}`;
			}
		}

		if (tool && !skipReason) {
			const policy = {
				...resolveToolPolicy(toolCall.toolName, this.config.toolPolicies),
				...policyOverride,
			};
			if (policy.enabled === false) {
				skipReason = `Tool "${toolCall.toolName}" is disabled by policy`;
			} else if (policy.autoApprove === false) {
				const approval = await this.requestToolApproval(
					toolCall,
					input,
					policy,
					callIndex,
					stepId,
				);
				if (!approval.approved) {
					skipReason =
						approval.reason ?? `Tool "${toolCall.toolName}" was not approved`;
				}
			}
		}

		return {
			toolCall: { ...toolCall, input },
			callIndex,
			stepId,
			tool,
			input,
			skipReason,
		};
	}

	private async requestToolApproval(
		toolCall: AgentToolCallPart,
		input: unknown,
		policy: ToolPolicy,
		toolCallIndex: number,
		stepId: string,
	): Promise<ToolApprovalResult> {
		const requestApproval = this.config.requestToolApproval;
		if (!requestApproval) {
			return {
				approved: false,
				reason: `Tool "${toolCall.toolName}" requires approval but no approval callback is configured`,
			};
		}
		try {
			return await requestApproval({
				sessionId:
					this.config.sessionId?.trim() ||
					this.config.conversationId?.trim() ||
					this.state.runId ||
					this.state.agentId,
				agentId: this.state.agentId,
				conversationId:
					this.config.conversationId?.trim() ||
					this.state.runId ||
					this.state.agentId,
				...(this.state.parentAgentId
					? { parentAgentId: this.state.parentAgentId }
					: {}),
				...(this.chainRootRunId ? { rootRunId: this.chainRootRunId } : {}),
				iteration: this.state.iteration,
				stepId,
				runId: this.state.runId,
				toolCallIndex,
				assistantMessageId: this.findLastAssistantMessage()?.id,
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				input,
				policy,
				signal: this.abortController?.signal,
			});
		} catch (error) {
			return {
				approved: false,
				reason: `Tool "${toolCall.toolName}" approval request failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}

	private async executePreparedTool(
		prepared: PreparedToolExecution,
	): Promise<AgentMessage> {
		// No-op span unless a TracerProvider is registered. Child of the
		// surrounding "agent.run" span via the active context.
		const span = agentTracer.startSpan(
			"agent.tool",
			{
				attributes: {
					"agent.tool.name": prepared.toolCall.toolName,
					"agent.tool.call_id": prepared.toolCall.toolCallId,
					"agent.tool.step_id": prepared.stepId,
					"agent.iteration": this.state.iteration,
					"agent.id": this.state.agentId,
					"agent.session_id": this.config.sessionId,
				},
			},
			context.active(),
		);
		try {
			const message = await context.with(
				trace.setSpan(context.active(), span),
				() => this.runPreparedTool(prepared),
			);
			const toolResult = message.content.find(
				(part): part is Extract<AgentMessagePart, { type: "tool-result" }> =>
					part.type === "tool-result" &&
					part.toolCallId === prepared.toolCall.toolCallId,
			);
			if (toolResult?.isError) {
				const output = toolResult.output;
				const errorText =
					typeof output === "object" &&
					output !== null &&
					"error" in output &&
					typeof (output as { error?: unknown }).error === "string"
						? (output as { error: string }).error
						: `Tool ${prepared.toolCall.toolName} failed`;
				span.setStatus({ code: SpanStatusCode.ERROR, message: errorText });
			}
			return message;
		} catch (error) {
			span.recordException(error as Error);
			span.setStatus({ code: SpanStatusCode.ERROR });
			throw error;
		} finally {
			span.end();
		}
	}

	/** Body of one prepared tool execution, wrapped by "agent.tool". */
	private async runPreparedTool(
		prepared: PreparedToolExecution,
	): Promise<AgentMessage> {
		const startedAt = new Date();
		await this.emit({
			type: "tool-started",
			snapshot: this.snapshot(),
			iteration: this.state.iteration,
			toolCall: prepared.toolCall,
		});

		let result: AgentToolResult;
		if (prepared.denialReason !== undefined) {
			result = {
				output: { denied: true, reason: prepared.denialReason },
				isError: true,
			};
		} else if (prepared.skipReason) {
			result = {
				output: { error: prepared.skipReason },
				isError: true,
			};
		} else if (!prepared.tool) {
			result = {
				output: { error: `Unknown tool: ${prepared.toolCall.toolName}` },
				isError: true,
			};
		} else {
			try {
				result = { output: await this.executeToolWithRetries(prepared) };
			} catch (error) {
				if (
					this.abortController?.signal.aborted ||
					error instanceof AgentRuntimeAbortError
				) {
					throw error;
				}
				result = {
					output: { error: this.toolErrorText(error) },
					isError: true,
				};
			}
		}

		const endedAt = new Date();
		const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());

		if (prepared.tool) {
			for (const hook of this.hooks.afterTool) {
				const after = (await hook({
					snapshot: this.snapshot(),
					tool: prepared.tool,
					toolCall: prepared.toolCall,
					stepId: prepared.stepId,
					input: prepared.input,
					result,
					startedAt,
					endedAt,
					durationMs,
				})) as AgentAfterToolResult | undefined;
				this.applyStopControl(after);
				if (after?.result) {
					result = after.result;
				}
			}
		}

		const message = createMessage("tool", [
			{
				type: "tool-result",
				toolCallId: prepared.toolCall.toolCallId,
				toolName: prepared.toolCall.toolName,
				output: result.output,
				isError: result.isError,
			},
		]);

		await this.emit({
			type: "tool-finished",
			snapshot: this.snapshot(),
			iteration: this.state.iteration,
			toolCall: prepared.toolCall,
			message,
		});

		return message;
	}

	private async executeToolWithRetries(
		prepared: PreparedToolExecution,
	): Promise<unknown> {
		const tool = prepared.tool;
		if (!tool) {
			throw new Error(`Unknown tool: ${prepared.toolCall.toolName}`);
		}
		const maxRetries = this.resolveToolMaxRetries(tool);
		let attempt = 0;
		while (true) {
			try {
				return await this.executeToolAttempt(tool, prepared);
			} catch (error) {
				if (
					this.abortController?.signal.aborted ||
					error instanceof AgentRuntimeAbortError
				) {
					throw error;
				}
				if (attempt >= maxRetries) {
					throw error;
				}
				await this.waitForToolRetry(this.toolRetryDelayMs(attempt));
				attempt += 1;
			}
		}
	}

	private async executeToolAttempt(
		tool: AgentTool,
		prepared: PreparedToolExecution,
	): Promise<unknown> {
		this.throwIfAborted();
		const runSignal = this.abortController?.signal;
		const controller = new AbortController();
		const timeoutMs =
			typeof tool.timeoutMs === "number" &&
			Number.isFinite(tool.timeoutMs) &&
			tool.timeoutMs > 0
				? Math.floor(tool.timeoutMs)
				: undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let onRunAbort: (() => void) | undefined;
		const abortPromise = new Promise<never>((_resolve, reject) => {
			onRunAbort = () => {
				const error = this.normalizeAbortError();
				controller.abort(error);
				reject(error);
			};
			if (runSignal?.aborted) {
				onRunAbort();
			} else {
				runSignal?.addEventListener("abort", onRunAbort, { once: true });
			}
		});
		const execution = Promise.resolve().then(() => {
			if (controller.signal.aborted) {
				throw controller.signal.reason;
			}
			return tool.execute(prepared.input, {
				sessionId: this.config.sessionId,
				agentId: this.state.agentId,
				conversationId: this.config.conversationId,
				runId: this.state.runId ?? createUID("run"),
				...(this.state.parentAgentId
					? { parentAgentId: this.state.parentAgentId }
					: {}),
				...(this.chainRootRunId ? { rootRunId: this.chainRootRunId } : {}),
				iteration: this.state.iteration,
				stepId: prepared.stepId,
				toolCallId: prepared.toolCall.toolCallId,
				toolCallIndex: prepared.callIndex,
				signal: controller.signal,
				metadata: this.config.toolContextMetadata,
				snapshot: this.snapshot(),
				emitUpdate: (update: unknown) => {
					void this.emit({
						type: "tool-updated",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						toolCall: prepared.toolCall,
						update,
					});
				},
			});
		});
		const timeoutPromise =
			timeoutMs === undefined
				? undefined
				: new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => {
							const error = new AgentToolTimeoutError(tool.name, timeoutMs);
							controller.abort(error);
							reject(error);
						}, timeoutMs);
					});
		const contenders: Promise<unknown>[] = [execution, abortPromise];
		if (timeoutPromise) {
			contenders.push(timeoutPromise);
		}
		try {
			return await Promise.race(contenders);
		} finally {
			if (timeout) {
				clearTimeout(timeout);
			}
			if (onRunAbort) {
				runSignal?.removeEventListener("abort", onRunAbort);
			}
		}
	}

	private resolveToolMaxRetries(tool: AgentTool): number {
		if (tool.retryable !== true) {
			return 0;
		}
		if (
			typeof tool.maxRetries !== "number" ||
			!Number.isFinite(tool.maxRetries) ||
			tool.maxRetries <= 0
		) {
			return 0;
		}
		return Math.min(MAX_TOOL_RETRIES, Math.floor(tool.maxRetries));
	}

	private toolRetryDelayMs(attempt: number): number {
		const configured = this.config.toolRetryDelayMs;
		const baseDelayMs =
			typeof configured === "number" &&
			Number.isFinite(configured) &&
			configured >= 0
				? configured
				: 100;
		return Math.min(MAX_TOOL_RETRY_DELAY_MS, baseDelayMs * 2 ** attempt);
	}

	private async waitForToolRetry(delayMs: number): Promise<void> {
		this.throwIfAborted();
		if (delayMs <= 0) {
			return;
		}
		const signal = this.abortController?.signal;
		await new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(this.normalizeAbortError());
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, delayMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
			}
		});
	}

	private finishRun(
		status: AgentRunResult["status"],
		assistantMessage?: AgentMessage,
		outputText?: string,
	): AgentRunResult {
		this.state.status = status;
		return {
			agentId: this.state.agentId,
			agentRole: this.state.agentRole,
			runId: this.state.runId ?? createUID("run"),
			status,
			iterations: this.state.iteration,
			outputText:
				outputText ??
				textFromMessage(assistantMessage ?? this.findLastAssistantMessage()),
			messages: cloneMessages(this.state.messages),
			usage: cloneUsage(this.state.usage),
		};
	}

	private findLastAssistantMessage(): AgentMessage | undefined {
		return [...this.state.messages]
			.reverse()
			.find((message) => message.role === "assistant");
	}

	private throwIfAborted(): void {
		if (this.abortController?.signal.aborted) {
			throw this.normalizeAbortError();
		}
	}

	private normalizeAbortError(): Error {
		const reason = this.abortController?.signal.reason;
		if (reason instanceof Error) {
			return reason;
		}
		if (typeof reason === "string") {
			return new Error(reason);
		}
		return new Error(this.state.lastError ?? "Run aborted");
	}

	private async emit(event: AgentRuntimeEvent): Promise<void> {
		const metadata = buildEventMetadata(event);
		switch (event.type) {
			case "run-started":
				// Verbatim clinee calls `logger?.info?.(...)`. sdk-re's
				// `BasicLogger` does not declare `info` (it uses `log`), so
				// we narrow to an optional-info shape at the call site to
				// preserve the clinee runtime contract without mutating
				// shared's `BasicLogger` interface.
				(
					this.config.logger as
						| {
								info?: (msg: string, md?: unknown) => void;
						  }
						| undefined
				)?.info?.("Agent run started", metadata);
				break;
			case "tool-finished":
				(
					this.config.logger as
						| {
								info?: (msg: string, md?: unknown) => void;
						  }
						| undefined
				)?.info?.("Agent tool finished", metadata);
				break;
			case "run-failed":
				this.config.logger?.error?.("Agent run failed", {
					...metadata,
					error: event.error,
				});
				captureSdkError(this.config.telemetry, {
					component: "agents",
					operation: "agent.run",
					error: event.error,
					severity: "error",
					handled: false,
					context: metadata as TelemetryProperties,
				});
				break;
			default:
				this.config.logger?.debug?.("Agent event", metadata);
				break;
		}
		this.config.telemetry?.capture({
			event: `agent.${event.type}`,
			properties: metadata as TelemetryProperties,
		});
		for (const listener of this.listeners) {
			listener(event);
		}
		for (const hook of this.hooks.onEvent) {
			await hook(event);
		}
	}

	private applyStopControl(
		control: AgentStopControl | undefined | undefined,
	): void {
		if (!control?.stop) {
			return;
		}
		if (control.reason) {
			this.state.lastError = control.reason;
		}
		throw new ControlledStopError(control.reason);
	}
}

function buildEventMetadata(event: AgentRuntimeEvent): Record<string, unknown> {
	return {
		agentId: event.snapshot.agentId,
		agentRole: event.snapshot.agentRole,
		runId: event.snapshot.runId,
		status: event.snapshot.status,
		iteration: event.snapshot.iteration,
		eventType: event.type,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireResumeString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Invalid resume ${field}`);
	}
	return value;
}

function areEquivalentValues(
	left: unknown,
	right: unknown,
	seen = new WeakMap<object, object>(),
): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (
		typeof left !== typeof right ||
		left === null ||
		right === null ||
		typeof left !== "object"
	) {
		return false;
	}

	const leftObject = left as object;
	const rightObject = right as object;
	if (seen.has(leftObject)) {
		return seen.get(leftObject) === rightObject;
	}
	seen.set(leftObject, rightObject);

	if (Array.isArray(left) || Array.isArray(right)) {
		if (
			!Array.isArray(left) ||
			!Array.isArray(right) ||
			left.length !== right.length
		) {
			return false;
		}
		return left.every((value, index) =>
			areEquivalentValues(value, right[index], seen),
		);
	}

	if (left instanceof Date || right instanceof Date) {
		return (
			left instanceof Date &&
			right instanceof Date &&
			left.getTime() === right.getTime()
		);
	}

	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const keys = new Set([
		...Object.keys(leftRecord),
		...Object.keys(rightRecord),
	]);
	for (const key of keys) {
		if (!areEquivalentValues(leftRecord[key], rightRecord[key], seen)) {
			return false;
		}
	}
	return true;
}

function mergeToolMetadata(current: unknown, patch: unknown): unknown {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		return patch;
	}
	if (!current || typeof current !== "object" || Array.isArray(current)) {
		return patch;
	}
	return {
		...(current as Record<string, unknown>),
		...patch,
	};
}

function parseToolInput(assembly: PendingToolAssembly): {
	input: unknown;
	parseError?: string;
	invalidInput: Record<string, unknown>;
	reason?: InvalidToolCall["reason"];
} {
	if (assembly.inputValue !== undefined) {
		return {
			input: assembly.inputValue,
			invalidInput: buildInvalidToolInput(JSON.stringify(assembly.inputValue)),
		};
	}
	if (!assembly.inputText.trim()) {
		return {
			input: {},
			invalidInput: {},
		};
	}
	const parsed = parseToolArguments(assembly.inputText);
	if (parsed.ok) {
		return {
			input: parsed.value,
			invalidInput: buildInvalidToolInput(assembly.inputText),
		};
	}
	return {
		input: {},
		invalidInput: buildInvalidToolInput(assembly.inputText, parsed.error),
		parseError: `Tool call ${assembly.toolName ?? assembly.toolCallId} emitted invalid JSON arguments: ${parsed.error}`,
		reason: "invalid_arguments",
	};
}

function buildInvalidToolInput(
	value: string,
	parseError?: string,
): Record<string, unknown> {
	const trimmed = value.trim();
	if (!trimmed) {
		return {};
	}
	return parseError
		? { rawInputText: value, parseError }
		: { rawInputText: value };
}

function parseToolArguments(
	value: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
	const trimmed = value.trim();
	if (!trimmed) {
		return {
			ok: false,
			error: "Tool call arguments were empty.",
		};
	}

	try {
		return { ok: true, value: JSON.parse(trimmed) };
	} catch {
		// Fall through to a normalized error below.
	}

	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
		return {
			ok: false,
			error: "Tool call arguments must be encoded as a JSON object or array.",
		};
	}

	return {
		ok: false,
		error:
			"Tool call arguments could not be parsed as JSON. Ensure the outer tool payload is valid JSON and escape embedded quotes/newlines inside string fields.",
	};
}

function mergeToolInputText(current: string, incoming: string): string {
	if (!current) {
		return incoming;
	}
	const trimmed = incoming.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return incoming;
	}
	return current + incoming;
}

export function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime {
	return new AgentRuntime(config);
}

/**
 * `Agent` is the user-friendly name for `AgentRuntime`. They are the same
 * class; this alias exists so standalone callers can write:
 *
 *     const agent = new Agent({ providerId, modelId, apiKey });
 *     await agent.run("hello");
 *
 * while `@cline/core` (which owns model construction) continues to use
 * the `AgentRuntime` name with `{ model, ... }` configs.
 */
export const Agent = AgentRuntime;
export type Agent = AgentRuntime;

export function createAgent(config: AgentRuntimeConfig): AgentRuntime {
	return new AgentRuntime(config);
}
