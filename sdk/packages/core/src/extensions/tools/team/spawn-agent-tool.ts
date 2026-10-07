/**
 * Reusable spawn_agent tool for delegating tasks to sub-agents.
 */

import {
	type AgentConfig,
	type AgentEvent,
	type AgentHooks,
	type AgentResult,
	type AgentTool,
	type AgentToolContext,
	type BasicLogger,
	createTool,
	type HookErrorMode,
	type ITelemetryService,
	type ToolApprovalRequest,
	type ToolApprovalResult,
	type ToolPolicy,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import {
	createDelegatedAgent,
	type DelegatedAgentConfigProvider,
} from "./delegated-agent";
import type { SubAgentRunRegistry } from "../../../runtime/orchestration/subagent-run-registry";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];

/**
 * Fallback label for an unlabelled sub-agent, so status output stays readable
 * instead of showing a wall of identical empty labels.
 */
function taskSummary(task: string, maxChars = 60): string {
	const collapsed = task.replace(/\s+/g, " ").trim();
	return collapsed.length > maxChars
		? `${collapsed.slice(0, maxChars - 1)}…`
		: collapsed;
}
type AgentFinishReason = AgentResult["finishReason"];

export const SpawnAgentInputSchema = z.object({
	systemPrompt: z
		.string()
		.describe("System prompt defining the sub-agent's behavior"),
	task: z.string().describe("Task for the sub-agent to complete"),
	label: z
		.string()
		.optional()
		.describe(
			"Short label for this sub-agent, used to identify it in status and completion messages.",
		),
	background: z
		.boolean()
		.optional()
		.describe(
			"Start the sub-agent and return immediately instead of waiting for it. " +
				"The call returns a runId you can read later with the subagent_runs tool. " +
				"Use this only when you have other work to do meanwhile: the result is not " +
				"delivered to you unless you go and read it, and its tokens are spent either way.",
		),
});

export type SpawnAgentInput = z.infer<typeof SpawnAgentInputSchema>;

export interface SpawnAgentOutput {
	text: string;
	iterations: number;
	finishReason: AgentFinishReason;
	usage: {
		inputTokens: number;
		outputTokens: number;
	};
}

/**
 * Returned instead of {@link SpawnAgentOutput} when `background` is set. Kept as a
 * union rather than an optional field so a caller cannot mistake "started, no
 * result yet" for a completed run with empty text.
 */
export interface SpawnAgentBackgroundOutput {
	started: true;
	runId: string;
	label: string;
	task: string;
	message: string;
}

export type SpawnAgentResult = SpawnAgentOutput | SpawnAgentBackgroundOutput;

export interface SubAgentStartContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
}

export interface SubAgentEndContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
	result?: SpawnAgentOutput;
	agentResult?: AgentResult;
	error?: Error;
}

export interface SpawnAgentToolConfig {
	configProvider: DelegatedAgentConfigProvider;
	defaultMaxIterations?: number;
	subAgentTools?: AgentTool[];
	createSubAgentTools?: (
		input: SpawnAgentInput,
		context: AgentToolContext,
	) => AgentTool[] | Promise<AgentTool[]>;
	onSubAgentEvent?: (event: AgentEvent) => void;
	/**
	 * Lifecycle hooks forwarded to spawned sub-agent runs.
	 */
	hooks?: AgentHooks;
	/**
	 * Extension list forwarded to spawned sub-agent runs.
	 */
	extensions?: AgentExtension[];
	/**
	 * Error handling mode for forwarded lifecycle hooks.
	 */
	hookErrorMode?: HookErrorMode;
	/**
	 * Called after a sub-agent instance is created and before it starts running.
	 * Errors are ignored so lifecycle observers cannot break task execution.
	 */
	onSubAgentStart?: (context: SubAgentStartContext) => void | Promise<void>;
	/**
	 * Called once a sub-agent run finishes (success or error).
	 * Errors are ignored so lifecycle observers cannot break task execution.
	 */
	onSubAgentEnd?: (context: SubAgentEndContext) => void | Promise<void>;
	/**
	 * Optional per-tool policy for spawned sub-agents.
	 */
	toolPolicies?: Record<string, ToolPolicy>;
	/**
	 * Optional approval callback for spawned sub-agent tool calls.
	 */
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	/**
	 * Optional logger forwarded to spawned sub-agent runs.
	 */
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
	wrapTools?: (tools: AgentTool[]) => AgentTool[];
	/**
	 * Registry that makes a backgrounded run readable after the fact.
	 *
	 * Required for `background: true`. Omitting it silently disables backgrounding
	 * rather than falling back to fire-and-forget, since a backgrounded run whose
	 * result nobody can reach spends tokens for nothing.
	 */
	runs?: SubAgentRunRegistry;
}

/**
 * Create a spawn_agent tool that can run a delegated task with a focused sub-agent.
 */
export function createSpawnAgentTool(
	config: SpawnAgentToolConfig,
): AgentTool<SpawnAgentInput, SpawnAgentResult> {
	return createTool<SpawnAgentInput, SpawnAgentResult>({
		name: "spawn_agent",
		description: `Spawn a sub-agent with a custom system prompt for specialized tasks. Use when delegating work that benefits from focused expertise.`,
		inputSchema: zodToJsonSchema(SpawnAgentInputSchema),
		execute: async (input, context) => {
			const background = input.background === true;
			if (background && !config.runs) {
				// Refusing is the whole point: silently downgrading to a blocking run
				// would leave the model waiting on a call it asked not to wait for, and
				// running it detached would lose the result.
				throw new Error(
					"Background sub-agents are not available in this session: no run registry is configured.",
				);
			}
			const tools = config.createSubAgentTools
				? await config.createSubAgentTools(input, context)
				: (config.subAgentTools ?? []);

			const subAgent = createDelegatedAgent({
				kind: "subagent",
				prompt: input.systemPrompt,
				configProvider: config.configProvider,
				tools,
				maxIterations: config.defaultMaxIterations,
				parentAgentId: context.agentId,
				// A lead agent reports no chain root, so its own run id becomes the
				// chain root for the child.
				rootRunId: context.rootRunId ?? context.runId,
				// A background run deliberately does NOT inherit the parent's abort
				// signal. That signal is scoped to the parent turn, so inheriting it
				// would abort the child the moment the turn that started it ends —
				// which is the opposite of what backgrounding means. Cancellation is
				// therefore explicit, through the registry's own abort path.
				...(background ? {} : { abortSignal: context.signal }),
				onEvent: config.onSubAgentEvent,
				hookErrorMode: config.hookErrorMode,
				toolPolicies: config.toolPolicies,
				requestToolApproval: config.requestToolApproval,
				sessionId: context.sessionId,
				wrapTools: config.wrapTools,
			});
			const subAgentId = subAgent.getAgentId();
			const conversationId = subAgent.getConversationId();
			const parentAgentId = context.agentId;
			if (config.onSubAgentStart) {
				try {
					await config.onSubAgentStart({
						subAgentId,
						conversationId,
						parentAgentId,
						input,
					});
				} catch {
					// Best-effort observer callback.
				}
			}
			const label = input.label?.trim() || taskSummary(input.task);
			if (background && config.runs) {
				// Registered before the run starts, so a caller that immediately asks
				// for status sees "running" rather than "unknown run".
				const record = config.runs.start({
					subAgentId,
					conversationId,
					label,
					task: input.task,
				});
				// Detached on purpose: the awaited promise below is what the parent
				// model would otherwise block on. The registry is what makes the
				// result reachable, which is the difference between backgrounding and
				// losing work.
				void (async () => {
					try {
						const result = await subAgent.run(input.task);
						const output: SpawnAgentOutput = {
							text: result.text,
							iterations: result.iterations,
							finishReason: result.finishReason,
							usage: {
								inputTokens: result.usage.inputTokens,
								outputTokens: result.usage.outputTokens,
							},
						};
						config.runs?.complete(record.runId, output);
						if (config.onSubAgentEnd) {
							try {
								await config.onSubAgentEnd({
									subAgentId,
									conversationId,
									parentAgentId,
									input,
									result: output,
									agentResult: result,
								});
							} catch {
								// Best-effort observer callback.
							}
						}
					} catch (error) {
						config.runs?.fail(record.runId, error);
						if (config.onSubAgentEnd) {
							try {
								await config.onSubAgentEnd({
									subAgentId,
									conversationId,
									parentAgentId,
									input,
									error: error instanceof Error ? error : new Error(String(error)),
								});
							} catch {
								// Best-effort observer callback.
							}
						}
					}
				})();
				return {
					started: true,
					runId: record.runId,
					label,
					task: input.task,
					message: `Started "${label}" in the background. Read it with subagent_runs once you need the result.`,
				} satisfies SpawnAgentBackgroundOutput;
			}
			try {
				const result = await subAgent.run(input.task);
				const output: SpawnAgentOutput = {
					text: result.text,
					iterations: result.iterations,
					finishReason: result.finishReason,
					usage: {
						inputTokens: result.usage.inputTokens,
						outputTokens: result.usage.outputTokens,
					},
				};
				if (config.onSubAgentEnd) {
					try {
						await config.onSubAgentEnd({
							subAgentId,
							conversationId,
							parentAgentId,
							input,
							result: output,
							agentResult: result,
						});
					} catch {
						// Best-effort observer callback.
					}
				}
				return output;
			} catch (error) {
				if (config.onSubAgentEnd) {
					try {
						await config.onSubAgentEnd({
							subAgentId,
							conversationId,
							parentAgentId,
							input,
							error: error instanceof Error ? error : new Error(String(error)),
						});
					} catch {
						// Best-effort observer callback.
					}
				}
				throw error;
			}
		},
		timeoutMs: 300000,
		retryable: false,
	});
}
