import type { ModelInfo } from "@cline/llms";
import type {
	AgentConfig,
	AgentHooks,
	AgentMode,
	AgentTool,
	BasicLogger,
	ConsecutiveMistakeLimitContext,
	ConsecutiveMistakeLimitDecision,
	ExtensionContext,
	HookErrorMode,
	ITelemetryService,
	MessageWithMetadata,
	SessionExecutionConfig,
	SessionPromptConfig,
	SessionWorkspaceConfig,
} from "@cline/shared";
import type { ToolRoutingRule } from "../extensions/tools/model-tool-routing";
import type { TeamEvent } from "../extensions/tools/team";
import type { FileBoundary } from "../extensions/tools/executors/file-boundary";
import type { ProviderConfig } from "./provider-settings";

/**
 * Session-level shape of the file-tool workspace boundary.
 *
 * The root is not part of this: the host derives it from `workspaceRoot ?? cwd`, so
 * a caller opts in to "constrain to this session's workspace" rather than restating
 * a path the config already carries.
 */
export interface FileBoundaryConfig {
	/**
	 * Explicit roots. Overrides the derived root when provided, which is what a host
	 * wants when the real working set is not the workspace (a scratch directory, a
	 * sibling checkout).
	 */
	roots?: string[];
	/**
	 * Extra permitted roots, such as each folder of a multi-root workspace.
	 */
	additionalRoots?: string[];
	/**
	 * Set false to leave the tools unconstrained.
	 * @default true
	 */
	enabled?: boolean;
}

export type { FileBoundary };

/**
 * Cross-session project memory: what the agent chose to carry forward.
 *
 * The store and the recall tool existed but no host instantiated them, and nothing
 * anywhere called `append()`, so the layer could only ever return empty. The write
 * paths and these switches are what make it a real capability.
 *
 * The two write paths have different risk. `writeEnabled` lets the model persist
 * records on its own initiative; `autoCaptureEnabled` extracts them from completed
 * turns. Both retain data outside the conversation, so both default off.
 */
export interface MemoryConfig {
/** Master switch. No store is opened and no tool is exposed when false. */
enabled?: boolean;
/**
 * Expose `recall_memory`.
 * @default true when enabled
 */
recallEnabled?: boolean;
/**
 * Expose `remember`, the agent-initiated write path.
 * @default false
 */
writeEnabled?: boolean;
/**
 * Run the automatic write path over completed turns.
 * @default false
 */
autoCaptureEnabled?: boolean;
/** SQLite file. Defaults to the session data directory. */
dbPath?: string;
}
export type CoreAgentMode = AgentMode;

export interface CoreModelConfig {
	providerId: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	providerConfig?: ProviderConfig;
	knownModels?: Record<string, ModelInfo>;
	/**
	 * Request model-side thinking/reasoning when supported.
	 */
	thinking?: boolean;
	/**
	 * Explicit reasoning effort override for capable models.
	 */
	reasoningEffort?: ProviderConfig["reasoningEffort"];
	/**
	 * Explicit thinking/reasoning token budget for capable models.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Maximum output tokens per API call.
	 */
	maxTokensPerTurn?: number;
	/**
	 * Sampling temperature per API call.
	 */
	temperature?: number;
}

export interface CoreRuntimeFeatures {
	enableTools: boolean;
	enableSpawnAgent: boolean;
	enableAgentTeams: boolean;
	disableMcpSettingsTools?: boolean;
	yolo?: boolean;
}

export type CoreCompactionMode = "auto" | "manual";

export interface CoreCompactionBudget {
	request: {
		/** Estimated tokens for the full provider request. */
		inputTokens: number;
		/** Effective provider input limit. */
		maxInputTokens: number;
		/** Full-request token count that triggers automatic compaction. */
		triggerTokens: number;
		/** Full-request token count the strategy output should fit within. */
		targetTokens: number;
		/** Fixed system-prompt, tool-definition, and request framing cost. */
		overheadTokens: number;
		thresholdRatio: number;
		utilizationRatio: number;
	};
	messages: {
		/** Estimated tokens in the compactable message transcript. */
		inputTokens: number;
		/** Message budget corresponding to the full-request trigger. */
		triggerTokens: number;
		/** Message budget the strategy should compact toward. */
		targetTokens: number;
	};
}

export interface CoreCompactionContext {
	agentId: string;
	conversationId: string;
	parentAgentId: string | null;
	iteration: number;
	messages: MessageWithMetadata[];
	model: {
		id: string;
		provider: string;
		info?: ModelInfo;
	};
	mode: CoreCompactionMode;
	budget: CoreCompactionBudget;
}

// Mirrors BudgetPolicyIntent in extensions/context/budget-projection/types.ts.
// Keep this public API type decoupled from the internal projection module.
export type CoreCompactionBudgetPolicyIntent =
	| "agentic_summary"
	| "basic_compaction_projection"
	| "normal_provider_request";

// Mirrors LiveTailHandling in extensions/context/budget-projection/types.ts.
// Keep this public API type decoupled from the internal projection module.
export type CoreCompactionLiveTailHandling =
	| "included_verbatim"
	| "included_degraded"
	| "summarized_as_context"
	| "omitted_with_warning"
	| "preserved_out_of_band";

export interface CoreCompactionBudgetMetadata {
	policyIntent: CoreCompactionBudgetPolicyIntent;
	actionCount: number;
	warningCount: number;
	liveTailHandling: CoreCompactionLiveTailHandling;
}

export interface CoreCompactionResult {
	messages: MessageWithMetadata[];
	budget?: CoreCompactionBudgetMetadata;
}

export interface CoreCompactionSummarizerConfig {
	providerId: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	/**
	 * Optional pre-resolved model metadata for the summarizer. Supplying either
	 * this or `knownModels` lets agentic compaction budget summary input against
	 * the summarizer model's actual context window instead of falling back to the
	 * active model's window.
	 */
	modelInfo?: ModelInfo;
	knownModels?: Record<string, ModelInfo>;
	providerConfig?: ProviderConfig;
	maxOutputTokens?: number;
}

export type CoreCompactionStrategy = "basic" | "agentic";

export interface CoreCompactionConfig {
	enabled?: boolean;
	strategy?: CoreCompactionStrategy;
	/**
	 * User-configurable auto-compact trigger: compact once the transcript
	 * consumes this share of the usable input budget (e.g. 0.9 = 90%).
	 * Falls back to COMPACTION_TRIGGER_RATIO (0.9) when unset.
	 */
	triggerRatio?: number;
	preserveRecentTokens?: number;
	summarizer?: CoreCompactionSummarizerConfig;
	compact?: (
		context: CoreCompactionContext,
	) =>
		| Promise<CoreCompactionResult | undefined>
		| CoreCompactionResult
		| undefined;
}

/**
 * Context passed to a custom `createCheckpoint` implementation.
 */
export interface CoreCheckpointContext {
	/** Absolute path to the working directory of the session. */
	cwd: string;
	/** The session identifier. */
	sessionId: string;
	/** Monotonically increasing run counter for this session (starts at 1). */
	runCount: number;
}

/**
 * Configuration for the built-in git-based checkpoint feature.
 *
 * Checkpoints capture a restorable snapshot of the workspace at the start of
 * each root-agent run so that changes made during a session can be rolled back.
 *
 * @example Disable checkpoints entirely:
 * ```ts
 * checkpoint: { enabled: false }
 * ```
 *
 * @example Bring your own checkpoint implementation:
 * ```ts
 * checkpoint: {
 *   createCheckpoint: async ({ cwd, sessionId, runCount }) => {
 *     const ref = await mySnapshotFn(cwd);
 *     return { ref, createdAt: Date.now(), runCount };
 *   },
 * }
 * ```
 */
export interface CoreCheckpointConfig {
	/**
	 * Whether to create checkpoints on each root-agent run start.
	 * Defaults to `false` — checkpoints are **opt-in**. Set to `true` to
	 * enable the built-in git stash/ref checkpoint behaviour for this session.
	 */
	enabled?: boolean;
	/**
	 * Replace the built-in git stash/ref checkpoint logic with a custom
	 * implementation. Called once at the start of each root-agent run (before
	 * the first agent iteration).
	 *
	 * Return an object with at least `ref`, `createdAt`, and `runCount` to have
	 * the entry recorded in session metadata, or return `undefined` to skip
	 * writing a checkpoint for that run.
	 */
	createCheckpoint?: (context: CoreCheckpointContext) =>
		| Promise<
				| {
						ref: string;
						createdAt: number;
						runCount: number;
						kind?: "stash" | "commit";
				  }
				| undefined
		  >
		| {
				ref: string;
				createdAt: number;
				runCount: number;
				kind?: "stash" | "commit";
		  }
		| undefined;
}

export interface CoreSessionConfig
	extends CoreModelConfig,
		CoreRuntimeFeatures,
		Omit<SessionWorkspaceConfig, "workspaceRoot">,
		Omit<SessionPromptConfig, "systemPrompt">,
		Omit<
			SessionExecutionConfig,
			| "enableTools"
			| "teamName"
			| "missionLogIntervalSteps"
			| "missionLogIntervalMs"
			| "maxConsecutiveMistakes"
		> {
	/**
	 * Core/hub runtime session identifier.
	 *
	 * When provided, this becomes the host-owned id for persistence, hub
	 * subscriptions, send/abort/stop commands, and approval routing. When
	 * omitted, the runtime host creates one. This is distinct from the agent
	 * conversation id, which is generated by the conversation store for
	 * transcript/tool/hook context.
	 */
	sessionId?: string;
	workspaceRoot?: string;
	/**
	 * Constrain the primary file tools (`read_files`, `editor`, `apply_patch`) to a
	 * set of roots.
	 *
	 * These executors historically accepted any absolute path: `read_files` had no
	 * check at all, and `editor` applied its `..` test only to relative inputs, so the
	 * workspace was never a boundary and a `.env` or `~/.ssh/id_rsa` one tool call
	 * away. A boundary is checked by realpath on both sides, so a symlink that sits
	 * inside the workspace but points outside is rejected too.
	 *
	 * Omitted means unconstrained, which is the historical behaviour. Hosts that opt
	 * in should set `additionalRoots` rather than disabling the boundary, since a
	 * multi-root workspace legitimately spans several directories.
	 */
	fileBoundary?: FileBoundaryConfig;
	memory?: MemoryConfig;

	systemPrompt: string;
	teamName?: string;
	missionLogIntervalSteps?: number;
	missionLogIntervalMs?: number;
	hooks?: AgentHooks;
	hookErrorMode?: HookErrorMode;
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
	extensionContext?: ExtensionContext;
	extraTools?: AgentTool[];
	pluginPaths?: string[];
	extensions?: AgentConfig["extensions"];
	execution?: AgentConfig["execution"];
	compaction?: CoreCompactionConfig;
	checkpoint?: CoreCheckpointConfig;
	onTeamEvent?: (event: TeamEvent) => void;
	onConsecutiveMistakeLimitReached?: (
		context: ConsecutiveMistakeLimitContext,
	) =>
		| Promise<ConsecutiveMistakeLimitDecision>
		| ConsecutiveMistakeLimitDecision;
	toolRoutingRules?: ToolRoutingRule[];
	/**
	 * Optional skill allowlist for the `skills` tool. When provided, only these
	 * skills are surfaced in tool metadata and invocable by name.
	 */
	skills?: string[];
	workspaceMetadata?: string;
}