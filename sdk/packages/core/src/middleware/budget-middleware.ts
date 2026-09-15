/**
 * Budget middleware [roadmap P1-4].
 *
 * Per-chain tool-call budget accounting: when the chain exhausts its call
 * budget the middleware returns a structured denial result instead of
 * executing further calls. Budget state lives in the middleware instance;
 * `reset()` clears it between runs.
 */

import type { ToolMiddleware, ToolMiddlewareContext } from "./tool-middleware";

export const BUDGET_EXCEEDED_REASON = "tool call budget exhausted";

/** Structured denial returned by chain nodes instead of executing a call. */
export interface ToolDenial {
	denied: true;
	reason: string;
}

/** Denial produced by the budget node; carries the accounting context. */
export interface BudgetExceededDenial extends ToolDenial {
	/** Budget that was in force when the denial was produced. */
	limit: number;
	/** Calls already spent when the denial was produced. */
	spent: number;
}

export function isToolDenial(value: unknown): value is ToolDenial {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { denied?: unknown }).denied === true &&
		typeof (value as { reason?: unknown }).reason === "string"
	);
}

export function isBudgetExceededDenial(
	value: unknown,
): value is BudgetExceededDenial {
	return (
		isToolDenial(value) &&
		typeof (value as { limit?: unknown }).limit === "number" &&
		typeof (value as { spent?: unknown }).spent === "number"
	);
}

export interface BudgetMiddlewareOptions {
	/** Maximum tool calls through this chain instance. */
	maxToolCalls: number;
}

export function createBudgetMiddleware(
	options: BudgetMiddlewareOptions,
): ToolMiddleware & { reset(): void } {
	const limit = Math.max(0, options.maxToolCalls);
	let spent = 0;
	return {
		name: "budget",
		async wrap(execute, _context: ToolMiddlewareContext) {
			if (spent >= limit) {
				return {
					denied: true,
					reason: BUDGET_EXCEEDED_REASON,
					limit,
					spent,
				} satisfies BudgetExceededDenial;
			}
			spent += 1;
			return execute();
		},
		/**
		 * Clears the spent-call counter (e.g. between agent runs sharing a
		 * chain instance).
		 */
		reset() {
			spent = 0;
		},
	};
}
