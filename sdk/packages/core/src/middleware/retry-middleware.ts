/**
 * Retry middleware [roadmap P1-4].
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
