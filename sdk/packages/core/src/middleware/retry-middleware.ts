/**
 * Retry middleware [roadmap P1-4].
 *
 * **Superseded — do not add this to the tool chain.**
 *
 * The runtime already retries failed tool calls, per tool, with the retryable
 * flag honoured and the backoff capped:
 * `agent-runtime.ts:2562` (`resolveToolMaxRetries`, reading
 * `AgentTool.maxRetries`, bounded by `MAX_TOOL_RETRIES = 10`) and
 * `agent-runtime.ts:2576` (`toolRetryDelayMs`, capped at
 * `MAX_TOOL_RETRY_DELAY_MS`).
 *
 * Stacking this on top would multiply the two: a single call could run up to
 * `(1 + tool.maxRetries) * (1 + middleware.maxRetries)` times — 33 attempts at
 * the defaults. Beyond the cost, the middleware's default `retryOn` retries
 * *every* failure, including permanent ones (bad input, missing file, a
 * deliberate throw from the tool), which the runtime's `retryable` check
 * correctly refuses. That turns a fast, honest failure into a slow, masked one.
 *
 * Kept for the same reason as `approval-middleware.ts`: it is exported,
 * documented and tested, and the chain framework is in active use.
 *
 * Retries failed tool calls with exponential backoff. The retry decision is
 * pluggable (`retryOn`); the default retries every failure. The sleep is
 * injectable so tests run without real backoff waits.
 */

import type { ToolMiddleware, ToolMiddlewareContext } from "./tool-middleware";

export interface RetryMiddlewareOptions {
	/** Additional attempts after the first failure. Defaults to 2. */
	maxRetries?: number;
	/** Base backoff delay; doubles per attempt. Defaults to 100ms. */
	backoffMs?: number;
	/** Retry predicate; defaults to retrying every failure. */
	retryOn?: (error: unknown, attempt: number) => boolean;
	/** Sleep override (tests). */
	sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export function createRetryMiddleware(
	options: RetryMiddlewareOptions = {},
): ToolMiddleware {
	const maxRetries = Math.max(0, options.maxRetries ?? 2);
	const backoffMs = Math.max(0, options.backoffMs ?? 100);
	const retryOn = options.retryOn ?? (() => true);
	const sleep = options.sleep ?? defaultSleep;
	return {
		name: "retry",
		async wrap(execute, _context: ToolMiddlewareContext) {
			let lastError: unknown;
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				try {
					return await execute();
				} catch (error) {
					lastError = error;
					if (attempt >= maxRetries || !retryOn(error, attempt)) {
						break;
					}
					await sleep(backoffMs * 2 ** attempt);
				}
			}
			throw lastError;
		},
	};
}
