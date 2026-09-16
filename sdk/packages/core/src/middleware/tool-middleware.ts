/**
 * Tool middleware chain [roadmap P1-4].
 *
 * Gap D7: guardrails were scattered across approvals and config with no
 * unified before/after interception chain. This module upgrades the hooks'
 * 70% foundation into an ordered middleware pipeline (MAF-style): cross-
 * cutting concerns (retry/budget/redaction/approval) compose as onion
 * wrappers around tool execution with zero intrusion into executors, and
 * approval becomes a manual node on the chain instead of a special case.
 *
 * Composition order: **first registered = outermost** (approval first,
 * retry innermost — the retry sees the redacted-chain-wrapped executor).
 */

export interface ToolMiddlewareContext {
	toolName: string;
	/** Loop iteration that produced the call. */
	iteration: number;
	toolCallId?: string;
	sessionId?: string;
	agentId?: string;
	conversationId?: string;
	input: unknown;
	/** Tool policy (`autoApprove: false` → approval node asks). */
	policy?: { enabled?: boolean; autoApprove?: boolean };
}

export interface ToolMiddleware {
	/** Identifier used in call-order assertions and diagnostics. */
	name: string;
	/**
	 * Onion-style wrap: receives the downstream executor and the call
	 * context, returns the (possibly transformed) result.
	 */
	wrap: (
		execute: () => Promise<unknown>,
		context: ToolMiddlewareContext,
	) => Promise<unknown>;
}

export type ToolMiddlewareChain = (
	execute: () => Promise<unknown>,
	context: ToolMiddlewareContext,
) => Promise<unknown>;

/**
 * Composes an ordered middleware chain. First registered = outermost; the
 * composed chain throws when a middleware is registered twice (ordering
 * mistakes are otherwise silent).
 */
export function composeToolMiddleware(
	middlewares: ToolMiddleware[],
): ToolMiddlewareChain {
	const seen = new Set<string>();
	for (const middleware of middlewares) {
		if (seen.has(middleware.name)) {
			throw new Error(`duplicate middleware: ${middleware.name}`);
		}
		seen.add(middleware.name);
	}
	return async (execute, context) => {
		const chain = middlewares.reduceRight(
			(next, middleware) => () => middleware.wrap(next, context),
			execute,
		);
		return chain();
	};
}
