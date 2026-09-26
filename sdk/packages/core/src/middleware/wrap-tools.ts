/**
 * Tool middleware wiring — wraps agent tools with the middleware chain
 * [roadmap P1-4 + P2-2 wiring].
 *
 * The P1-4 gap analysis calls for cross-cutting concerns composed around
 * tool execution "with zero intrusion into executors". The agents package
 * cannot depend on core (cycle), so the wiring point is the toolset: hosts
 * wrap their tools with the chain before handing them to the agent runtime
 * (opt-in — unwrapped tools keep stock behavior). The full onion composes:
 * retry/budget/redaction/approval (P1-4) and the idempotency ledger
 * (P2-2) ride the same chain.
 */

import type { AgentTool, AgentToolContext } from "@cline/shared";
import type { ToolMiddleware, ToolMiddlewareChain } from "./tool-middleware";
import { composeToolMiddleware } from "./tool-middleware";

export interface WrapToolsWithMiddlewareOptions {
	/** Middleware list or a pre-composed chain. */
	chain: ToolMiddleware[] | ToolMiddlewareChain;
	/** Session id for chain context; fixed value or per-call resolver. */
	sessionId: string | ((context: AgentToolContext) => string);
}

/**
 * Returns new tool objects whose `execute` runs the middleware chain around
 * the original executor. Identity fields (name/description/timeout/...) are
 * preserved; the original tools are not mutated.
 */
export function wrapToolsWithMiddleware<T extends AgentTool>(
	tools: readonly T[],
	options: WrapToolsWithMiddlewareOptions,
): T[] {
	const chain: ToolMiddlewareChain = Array.isArray(options.chain)
		? composeToolMiddleware(options.chain)
		: options.chain;
	const resolveSessionId = (context: AgentToolContext): string =>
		typeof options.sessionId === "function"
			? options.sessionId(context)
			: options.sessionId;
	return tools.map((tool) => ({
		...tool,
		// The chain is unknown-typed at the boundary; both sides of the
		// wrapper are type-erasing pass-throughs for the tool's declared I/O.
		execute: ((input: unknown, context: AgentToolContext): Promise<unknown> => {
			const executor = tool.execute as (
				input: unknown,
				context: AgentToolContext,
			) => unknown;
			return chain(() => Promise.resolve(executor(input, context)), {
				toolName: tool.name,
				stepId: context.stepId,
				toolCallId: context.toolCallId,
				toolCallIndex: context.toolCallIndex,
				iteration: context.iteration,
				sessionId: resolveSessionId(context),
				runId: context.runId,
				agentId: context.agentId,
				conversationId: context.conversationId,
				retryable: tool.retryable === true,
				signal: context.signal,
				input,
				policy: undefined,
			});
		}) as T["execute"],
	}));
}
