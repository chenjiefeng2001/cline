/**
 * # Retry Strategy for Network Operations
 *
 * ## Overview
 *
 * Cline makes network requests to many different services (AI providers, MCP
 * servers, OAuth endpoints, marketplace API) with very different failure
 * profiles. A single retry policy cannot serve all of them.
 *
 * This module provides a unified `executeWithRetry()` function that picks the
 * right retry policy based on error classification. Each policy defines:
 * - maxAttempts — how many times to retry
 * - baseDelayMs / maxDelayMs — exponential backoff bounds
 * - jitter — whether to add randomization to avoid thundering herd
 * - shouldRetry — which error conditions trigger a retry
 *
 * ## Error Classification
 *
 * ```
 *         ┌──────────┐
 *         │ Response │
 *         ├──────────┤
 *         │ 429      │ → rateLimit (retry with backoff)
 *         │ 5xx      │ → serverError (retry with backoff)
 *         │ 4xx      │ → clientError (NO retry, except 429)
 *         │ Network  │ → networkError (retry with backoff)
 *         │ Timeout  │ → networkError (retry with backoff)
 *         │ Other    │ → no retry
 *         └──────────┘
 * ```
 */

import { Logger } from "@/shared/services/Logger"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryPolicy {
	maxAttempts: number
	baseDelayMs: number
	maxDelayMs: number
	jitter: boolean
	shouldRetry: (error: unknown) => boolean
}

export interface ApiError {
	statusCode?: number
	code?: string
	message?: string
}

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

function getStatusCode(error: unknown): number | undefined {
	if (error && typeof error === "object" && "status" in error) {
		return (error as { status: number }).status
	}
	if (error && typeof error === "object" && "statusCode" in error) {
		return (error as { statusCode: number }).statusCode
	}
	return undefined
}

function getErrorCode(error: unknown): string | undefined {
	if (error && typeof error === "object") {
		const obj = error as Record<string, unknown>
		if (typeof obj.code === "string") return obj.code
		if (typeof obj.cause === "object" && obj.cause) {
			return (obj.cause as Record<string, unknown>).code as string | undefined
		}
	}
	return undefined
}

function isAbortError(error: unknown): boolean {
	if (error && typeof error === "object") {
		const name = (error as { name?: string }).name
		if (name === "AbortError" || name === "TIMEOUT") return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Retry policies
// ---------------------------------------------------------------------------

const RETRY_POLICIES: Record<string, RetryPolicy> = {
	/** HTTP 429 — rate limited, retry after backoff */
	rateLimit: {
		maxAttempts: 3,
		baseDelayMs: 1_000,
		maxDelayMs: 60_000,
		jitter: true,
		shouldRetry: (err) => {
			const status = getStatusCode(err)
			return status === 429
		},
	},

	/** HTTP 5xx — server error, retry with exponential backoff */
	serverError: {
		maxAttempts: 5,
		baseDelayMs: 2_000,
		maxDelayMs: 120_000,
		jitter: true,
		shouldRetry: (err) => {
			const status = getStatusCode(err)
			return status !== undefined && status >= 500 && status < 600
		},
	},

	/** HTTP 4xx (except 429) — client error, do NOT retry */
	clientError: {
		maxAttempts: 1,
		baseDelayMs: 0,
		maxDelayMs: 0,
		jitter: false,
		shouldRetry: (err) => {
			const status = getStatusCode(err)
			return status !== undefined && status >= 400 && status < 500 && status !== 429
		},
	},

	/** Network-level errors (DNS, connection refused, timeout) */
	networkError: {
		maxAttempts: 3,
		baseDelayMs: 5_000,
		maxDelayMs: 30_000,
		jitter: true,
		shouldRetry: (err) => {
			if (isAbortError(err)) return true
			const code = getErrorCode(err)
			const NETWORK_ERROR_CODES = ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"]
			return code !== undefined && NETWORK_ERROR_CODES.includes(code)
		},
	},
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Calculate a delay with optional jitter.
 *
 * Uses full jitter strategy (random between 0 and calculated delay) to spread
 * retries and avoid thundering herd on shared services.
 */
function calculateDelay(baseMs: number, maxMs: number, jitter: boolean): number {
	const delay = Math.min(baseMs, maxMs)
	if (!jitter) return delay
	return Math.round(Math.random() * delay)
}

/**
 * Classify an error into a retry policy key.
 *
 * @param error — The error to classify
 * @returns A policy key string ("rateLimit", "serverError", "clientError", "networkError", or "unknown")
 */
export function classifyError(error: unknown): string {
	if (isAbortError(error)) return "networkError"

	const status = getStatusCode(error)
	if (status === 429) return "rateLimit"
	if (status !== undefined && status >= 500 && status < 600) return "serverError"
	if (status !== undefined && status >= 400 && status < 500) return "clientError"

	const code = getErrorCode(error)
	if (code && ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) {
		return "networkError"
	}

	return "unknown"
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Execute an async function with automatic retry based on error type.
 *
 * @param fn — The async function to execute
 * @param errorClassifier — Optional custom classifier. Defaults to `classifyError`.
 * @param context — Optional description for logging (e.g. "MCP SSE connect")
 * @returns The result of `fn()` if it succeeds
 * @throws The last error if all attempts fail
 *
 * @example
 * ```typescript
 * import { executeWithRetry } from '@/shared/retry'
 *
 * const data = await executeWithRetry(
 *   () => fetch('https://api.example.com/data').then(r => r.json()),
 *   undefined,
 *   "fetch example data"
 * )
 * ```
 */
export async function executeWithRetry<T>(
	fn: () => Promise<T>,
	errorClassifier?: (error: unknown) => string,
	context?: string,
): Promise<T> {
	const classify = errorClassifier ?? classifyError

	for (let attempt = 1; ; attempt++) {
		try {
			return await fn()
		} catch (error) {
			const errorType = classify(error)
			const policy = RETRY_POLICIES[errorType]

			if (!policy || attempt >= policy.maxAttempts) {
				// No policy or exhausted attempts — throw the last error
				Logger.error(
					`[retry] ${context ?? "request"} failed after ${attempt} attempt(s) (errorType: ${errorType})`,
					error,
				)
				throw error
			}

			const delayMs = calculateDelay(
				policy.baseDelayMs * Math.pow(2, attempt - 1),
				policy.maxDelayMs,
				policy.jitter,
			)

			Logger.warn(
				`[retry] ${context ?? "request"} failed (attempt ${attempt}/${policy.maxAttempts}, ` +
					`type: ${errorType}), retrying in ${delayMs}ms`,
			)

			await sleep(delayMs)
		}
	}
}
