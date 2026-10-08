/**
 * Build an `AgentRuntimeConfig` from an `AgentConfig` plus session-owned
 * supporting objects (model handler, tools, hooks, plugins, telemetry).
 *
 * The function is intentionally **pure**: it does not create handlers or tools
 * itself; it receives them already resolved from the caller (`SessionRuntime`)
 * and wires them into an `AgentRuntimeConfig`.
 *
 * Fields that do **not** round-trip into `AgentRuntimeConfig`
 * (e.g. `execution.maxConsecutiveMistakes`, `execution.loopDetection`) are
 * consumed by `SessionRuntime` / `MistakeTracker` /
 * `LoopDetectionTracker` — not passed through here.
 */

import type {
	AgentConfig,
	AgentMessage,
	AgentModel,
	AgentRuntimeConfig,
	AgentRuntimeHooks,
	AgentRuntimePlugin,
	AgentRuntimePrepareTurnContext,
	AgentRuntimePrepareTurnResult,
	AgentTool,
	BasicLogger,
	ITelemetryService,
} from "@cline/shared";

/**
 * Inputs required to assemble an `AgentRuntimeConfig`. Distinct from
 * `AgentConfig` because some of these (the model adapter, the hook
 * bridge's runtime-hooks bag, a resolved plugin list) can only be
 * produced inside `SessionRuntime`.
 */
export interface CreateAgentRuntimeConfigInput {
	readonly agentConfig: AgentConfig;
	/**
	 * Core/hub runtime session identifier used for host lifecycle operations,
	 * event routing, persistence, and approval delivery.
	 */
	readonly sessionId?: string;
	readonly runId?: string;
	readonly agentId: string;
	/**
	 * Agent conversation/transcript identifier used by tools, hooks, telemetry,
	 * and model history correlation.
	 */
	readonly conversationId?: string;
	readonly parentAgentId?: string;
	/**
	 * Run that owns this agent's chain. Only set for delegated agents; a root
	 * agent's own run id changes per run, so the root run id is only stable for
	 * a delegated chain.
	 */
	readonly rootRunId?: string;
	/** The role label for teammates (`AgentConfig.role` in sub-agent configs). */
	readonly agentRole?: string;
	/** Pre-built model adapter (produced by `apiHandlerToAgentModel`). */
	readonly model: AgentModel;
	readonly logger?: BasicLogger;
	readonly telemetry?: ITelemetryService;
	/** Pre-built tool array (builtins + plugin-contributed + session extras). */
	readonly tools?: readonly AgentTool<unknown, unknown>[];
	readonly toolContextMetadata?: Record<string, unknown>;
	/** Pre-resolved plugin list from the plugin loader. */
	readonly plugins?: readonly AgentRuntimePlugin[];
	/** Runtime hooks supplied by the session/runtime builder. */
	readonly hooks?: Partial<AgentRuntimeHooks>;
	/** Host-owned context pipeline invoked before runtime model hooks. */
	readonly prepareTurn?: (
		context: AgentRuntimePrepareTurnContext,
	) =>
		| Promise<AgentRuntimePrepareTurnResult | undefined>
		| AgentRuntimePrepareTurnResult
		| undefined;
	/** Seed messages (usually `session.conversation.getMessages()`). */
	readonly initialMessages?: readonly AgentMessage[];
	/**
	 * Override for `AgentRuntimeConfig.systemPrompt` — useful when
	 * the caller has composed additional guidance (e.g. via
	 * `LocalRuntimeHost.composeSystemPrompt`). Defaults to
	 * `agentConfig.systemPrompt`.
	 */
	readonly systemPrompt?: string;
}

/**
 * Fields on `AgentRuntimeConfig` that this builder deliberately does not populate.
 *
 * Every entry needs a reason, because "we forgot" is the failure this list exists
 * to make impossible to hide.
 *
 * - `toolRetryDelayMs`: an agents-level knob for consumers that construct
 *   `AgentRuntime` directly. It is not on `AgentConfig`, so there is nothing here
 *   to copy, and no host exposes it. The runtime falls back to a fixed 100ms base
 *   with capped exponential backoff, so behaviour is deterministic rather than
 *   accidentally unset.
 */
type IntentionallyNotMapped = "toolRetryDelayMs";

/**
 * Produce an `AgentRuntimeConfig` from session-owned runtime inputs.
 */
export function createAgentRuntimeConfig(
	input: CreateAgentRuntimeConfigInput,
): AgentRuntimeConfig {
	const { agentConfig } = input;

	const modelOptions = buildModelOptions(agentConfig);
	const messageModelInfo = buildMessageModelInfo(agentConfig);
	const hooks = input.hooks;
	const toolExecution = resolveToolExecution(agentConfig.maxParallelToolCalls);

	const config = {
		sessionId: input.sessionId ?? agentConfig.sessionId,
		runId: input.runId,
		agentId: input.agentId,
		conversationId: input.conversationId,
		parentAgentId: input.parentAgentId,
		rootRunId: input.rootRunId ?? agentConfig.rootRunId,
		agentRole: input.agentRole,
		systemPrompt: input.systemPrompt ?? agentConfig.systemPrompt,
		messageModelInfo,
		model: input.model,
		modelOptions,
		tools: input.tools,
		hooks,
		prepareTurn: input.prepareTurn,
		consumePendingUserMessage: agentConfig.consumePendingUserMessage,
		plugins: input.plugins,
		logger: input.logger ?? agentConfig.logger,
		telemetry: input.telemetry ?? agentConfig.telemetry,
		initialMessages: input.initialMessages,
		completionPolicy: agentConfig.completionPolicy,
		maxIterations: agentConfig.maxIterations,
		budget: agentConfig.budget,
		toolExecution,
		maxParallelToolCalls: agentConfig.maxParallelToolCalls,
		// Tool-call ceiling for the lead agent. It is declared under `execution` on
		// the session config and on `AgentExecutionConfig`, but nothing copied it onto
		// `AgentRuntimeConfig`, so `AgentRuntime` read `undefined` and no cap was ever
		// applied to a lead session — only to delegated sub-agents, which read
		// `config.execution?.maxToolCalls` directly in the runtime builder. Setting
		// `cline.maxToolCalls` or `--max-tool-calls` appeared to work and did nothing.
		maxToolCalls: agentConfig.execution?.maxToolCalls,
		toolPolicies: agentConfig.toolPolicies,
		toolContextMetadata: input.toolContextMetadata,
		requestToolApproval: agentConfig.requestToolApproval,
	};

	// Compile-time exhaustiveness. `AgentRuntimeConfig` grew a field, or a field is
	// renamed, and nothing here maps it: this stops compiling.
	//
	// The explicit `: AgentRuntimeConfig` annotation used to hide exactly that, because
	// an object literal satisfies a wider type without mentioning every key. It is how
	// `execution.maxToolCalls` went missing — the builder copied four neighbouring
	// guardrails and not that one, the annotation accepted the result, and the runtime
	// read `undefined` for every lead session while the setting looked fully wired.
	//
	// Removing the annotation is the point: `keyof typeof config` is now the literal's
	// real key set, so the subtraction below can fail.
	type MappedFromSession = Exclude<
		keyof AgentRuntimeConfig,
		keyof typeof config | IntentionallyNotMapped
	>;
	const _exhaustive: MappedFromSession extends never ? true : never = true;
	void _exhaustive;

	// The reciprocal check, so the allowlist cannot rot: an entry for a field that
	// no longer exists would otherwise silently stop meaning anything, and the
	// error above would look like coverage when it is not.
	type StaleAllowlistEntry = Exclude<
		IntentionallyNotMapped,
		keyof AgentRuntimeConfig
	>;
	const _allowlistIsCurrent: StaleAllowlistEntry extends never ? true : never =
		true;
	void _allowlistIsCurrent;

	const typed: AgentRuntimeConfig = config;
	return typed;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Collect the provider-/reasoning-related fields from `AgentConfig`
 * into `AgentRuntimeConfig.modelOptions`. Kept undefined when every
 * field is undefined so the runtime does not receive an empty object.
 */
export function buildModelOptions(
	config: AgentConfig,
): Record<string, unknown> | undefined {
	const options: Record<string, unknown> = {};
	if (config.thinking !== undefined) {
		options.thinking = config.thinking;
	}
	if (config.reasoningEffort !== undefined) {
		options.reasoningEffort = config.reasoningEffort;
	}
	if (config.thinkingBudgetTokens !== undefined) {
		options.thinkingBudgetTokens = config.thinkingBudgetTokens;
	}
	if (config.maxTokensPerTurn !== undefined) {
		options.maxTokensPerTurn = config.maxTokensPerTurn;
	}
	if (config.temperature !== undefined) {
		options.temperature = config.temperature;
	}
	if (config.apiTimeoutMs !== undefined) {
		options.apiTimeoutMs = config.apiTimeoutMs;
	}
	return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Compose `messageModelInfo` from the provider-related fields per
 * §3.2.1: `{ id: modelId, provider: providerId, family:
 * providerConfig?.family }`.
 */
export function buildMessageModelInfo(
	config: AgentConfig,
): AgentMessage["modelInfo"] {
	const family = (config.providerConfig as { family?: string } | undefined)
		?.family;
	return {
		id: config.modelId,
		provider: config.providerId,
		family,
	};
}

/**
 * `"parallel"` when `maxParallelToolCalls ≥ 2`, `"sequential"` when
 * `1`, `undefined` when the caller did not specify.
 */
export function resolveToolExecution(
	maxParallelToolCalls: number | undefined,
): "sequential" | "parallel" | undefined {
	if (maxParallelToolCalls === undefined) {
		return undefined;
	}
	return maxParallelToolCalls >= 2 ? "parallel" : "sequential";
}
