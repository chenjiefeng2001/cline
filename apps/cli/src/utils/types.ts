import type {
	AgentMode,
	CoreSandboxConfig,
	CoreSessionConfig,
	Llms,
	ProviderSettings,
	RuntimeLoggerConfig,
	SessionLineage,
	SessionManifest,
	ToolPolicy,
} from "@cline/core";
import type { Message } from "@cline/shared";

export type CliOutputMode = "text" | "json";
export type CliAgentMode = AgentMode;
export type CliReasoningEffort = NonNullable<
	NonNullable<ProviderSettings["reasoning"]>["effort"]
>;
export type CliCompactionMode = "agentic" | "basic" | "off";

export interface Config extends Omit<CoreSessionConfig, "apiKey" | "mode"> {
	apiKey: string;
	knownModels?: Record<string, Llms.ModelInfo>;
	loggerConfig?: RuntimeLoggerConfig;
	verbose: boolean;
	timeoutSeconds?: number;
	/**
	 * --data-dir state isolation: keep this run's files in a separate data
	 * directory. Named for what it does rather than sandbox, which now means
	 * OS-level process isolation and is a different mechanism entirely. The old
	 * name is why the two were once mistaken for each other.
	 */
	isolatedState: boolean;
	sandboxDataDir?: string;
	thinking?: boolean;
	outputMode: CliOutputMode;
	mode: CliAgentMode;
	defaultToolAutoApprove: boolean;
	toolPolicies: Record<string, ToolPolicy>;
}

export interface ActiveCliSession {
	manifest: SessionManifest;
}

export interface StoredApiMessages {
	version: 1;
	updated_at: string;
	messages: Message[];
}

export interface SessionDbRow {
	session_id: string;
	provider: string;
	model: string;
	cwd: string;
	workspace_root: string;
	team_name?: string | null;
	enable_tools: number;
	enable_spawn: number;
	enable_teams: number;
	prompt?: string | null;
}

export interface SubagentSessionInput
	extends Required<
		Pick<SessionLineage, "agentId" | "parentAgentId" | "conversationId">
	> {
	prompt?: string;
	rootSessionId?: string;
}

export interface ParsedArgs {
	prompt?: string;
	systemPrompt?: string;
	key?: string;
	verbose: boolean;
	interactive: boolean;
	outputMode: CliOutputMode;
	mode: CliAgentMode;
	timeoutSeconds?: number;
	invalidTimeoutSeconds?: string;
	/**
	 * Run guardrails, all optional so an omitted flag falls back to the default
	 * applied in main.ts. `invalid*` carries the raw text so main.ts can print a
	 * precise error rather than silently ignoring a typo'd value.
	 */
	maxIterations?: number;
	invalidMaxIterations?: string;
	runBudgetMaxTotalCost?: number;
	invalidMaxBudgetUsd?: string;
	maxParallelToolCalls?: number;
	invalidMaxParallelToolCalls?: string;
	thinking: boolean;
	/** Whether --thinking was explicitly provided on the command line */
	thinkingExplicitlySet?: boolean;
	reasoningEffort?: CliReasoningEffort;
	invalidThinkingLevel?: string;
	compactionMode?: CliCompactionMode;
	invalidCompactionMode?: string;
	invalidAutoApprove?: string;
	isolatedState: boolean;
	dataDir?: string;
	/** OS process isolation for shell commands; unset means unsandboxed. */
	sandbox?: CoreSandboxConfig;
	configDir?: string;
	hooksDir?: string;
	worktree?: boolean;
	acpMode: boolean;
	model?: string;
	provider?: string;
	id?: string;
	retries?: number;
	invalidRetries?: string;
	cwd?: string;
	teamName?: string;
	defaultToolAutoApprove: boolean;
	autoApproveOverride?: boolean;
}
