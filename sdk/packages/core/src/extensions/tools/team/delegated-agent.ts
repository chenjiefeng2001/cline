import type {
	AgentConfig,
	AgentEvent,
	AgentHooks,
	AgentTool,
	BasicLogger,
	HookErrorMode,
	ITelemetryService,
	ToolApprovalRequest,
	ToolApprovalResult,
} from "@cline/shared";
import {
	SessionRuntime,
	type SessionRuntimeOrchestratorDeps,
} from "../../../runtime/orchestration/session-runtime-orchestrator";
import {
	buildSubAgentSystemPrompt,
	buildTeammateSystemPrompt,
} from "./subagent-prompts";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];

export type DelegatedAgentConnectionConfig = Pick<
	AgentConfig,
	| "providerId"
	| "modelId"
	| "apiKey"
	| "baseUrl"
	| "headers"
	| "providerConfig"
	| "knownModels"
	| "thinking"
	| "reasoningEffort"
	| "thinkingBudgetTokens"
	| "maxTokensPerTurn"
	| "temperature"
>;

export interface DelegatedAgentRuntimeConfig
	extends DelegatedAgentConnectionConfig {
	cwd?: string;
	providerId: string;
	clinePlatform?: string;
	clineIdeName?: string;
	maxIterations?: number;
	/**
	 * Per-run tool-call cap for delegated agents. A sub-agent spends the parent's
	 * budget, so without forwarding this the cap would bound the parent while a child
	 * looped freely inside it.
	 */
	maxToolCalls?: number;
	hooks?: AgentHooks;
	extensions?: AgentExtension[];
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
	workspaceMetadata?: string;
	sessionId?: string;
	/**
	 * Run that owns the agent chain. Set on a delegated runtime so every agent
	 * created from this provider inherits the same chain root.
	 */
	rootRunId?: string;
}

export interface DelegatedAgentConfigProvider {
	getRuntimeConfig(): DelegatedAgentRuntimeConfig;
	getConnectionConfig(): DelegatedAgentConnectionConfig;
	updateConnectionDefaults(
		overrides: Partial<DelegatedAgentConnectionConfig>,
	): void;
}

export type DelegatedAgentKind = "subagent" | "teammate";

export interface BuildDelegatedAgentConfigOptions {
	kind: DelegatedAgentKind;
	prompt: string;
	tools: AgentTool[];
	configProvider: DelegatedAgentConfigProvider;
	parentAgentId?: string;
	/**
	 * Run that owns the parent agent's chain. Carried onto the child so its own
	 * tool contexts and approval requests describe the full chain; a child
	 * without it cannot be attributed to a root run.
	 */
	rootRunId?: string;
	maxIterations?: number;
	abortSignal?: AbortSignal;
	onEvent?: (event: AgentEvent) => void;
	hookErrorMode?: HookErrorMode;
	toolPolicies?: AgentConfig["toolPolicies"];
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	role?: string;
	cwd?: string;
	sessionId?: string;
	wrapTools?: (tools: AgentTool[]) => AgentTool[];
}

export function createDelegatedAgentConfigProvider(
	initialConfig: DelegatedAgentRuntimeConfig,
): DelegatedAgentConfigProvider {
	let runtimeConfig: DelegatedAgentRuntimeConfig = { ...initialConfig };

	return {
		getRuntimeConfig: () => runtimeConfig,
		getConnectionConfig: () => ({
			providerId: runtimeConfig.providerId,
			modelId: runtimeConfig.modelId,
			apiKey: runtimeConfig.apiKey,
			baseUrl: runtimeConfig.baseUrl,
			headers: runtimeConfig.headers,
			providerConfig: runtimeConfig.providerConfig,
			knownModels: runtimeConfig.knownModels,
			thinking: runtimeConfig.thinking,
			reasoningEffort: runtimeConfig.reasoningEffort,
			thinkingBudgetTokens: runtimeConfig.thinkingBudgetTokens,
			maxTokensPerTurn: runtimeConfig.maxTokensPerTurn,
			temperature: runtimeConfig.temperature,
		}),
		updateConnectionDefaults: (overrides) => {
			runtimeConfig = {
				...runtimeConfig,
				...overrides,
			};
		},
	};
}

export function buildDelegatedAgentConfig(
	options: BuildDelegatedAgentConfigOptions,
): AgentConfig & { role?: string } {
	const runtimeConfig = options.configProvider.getRuntimeConfig();
	const systemPrompt =
		options.kind === "teammate"
			? buildTeammateSystemPrompt(options.prompt, runtimeConfig)
			: buildSubAgentSystemPrompt(options.prompt, runtimeConfig);
	// A delegated agent keeps the chain's root run so a later recovery can tell
	// which root run owns it. When the parent did not report one, fall back to
	// the parent's own run id so the chain is still describable.
	const rootRunId = options.rootRunId ?? runtimeConfig.rootRunId;

	return {
		...options.configProvider.getConnectionConfig(),
		sessionId: options.sessionId ?? runtimeConfig.sessionId,
		systemPrompt,
		tools: options.tools,
		maxIterations: options.maxIterations ?? runtimeConfig.maxIterations,
		maxToolCalls: runtimeConfig.maxToolCalls,
		parentAgentId: options.parentAgentId,
		...(rootRunId ? { rootRunId } : {}),
		abortSignal: options.abortSignal,
		onEvent: options.onEvent,
		hooks: runtimeConfig.hooks,
		extensions: runtimeConfig.extensions,
		hookErrorMode: options.hookErrorMode,
		toolPolicies: options.toolPolicies,
		requestToolApproval: options.requestToolApproval,
		logger: runtimeConfig.logger,
		role: options.role,
	};
}

export function createDelegatedAgent(
	options: BuildDelegatedAgentConfigOptions,
): SessionRuntime {
	const config = buildDelegatedAgentConfig(options);
	const deps: SessionRuntimeOrchestratorDeps = {
		...(config.rootRunId ? { chainRootRunId: config.rootRunId } : {}),
		...(options.wrapTools ? { wrapTools: options.wrapTools } : {}),
	};
	const session = new SessionRuntime(config, deps);
	if (config.onEvent) {
		session.subscribeEvents(config.onEvent);
	}
	return session;
}
