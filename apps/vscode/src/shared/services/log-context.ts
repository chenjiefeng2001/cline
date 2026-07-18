/**
 * # Log Context — AsyncLocalStorage-backed implicit context propagation
 *
 * ## Why
 *
 * Before this module, every Logger call needed an explicit `taskId` or
 * `sessionId` parameter threaded through the call chain. This was error-prone
 * (easy to forget) and invasive (every deep method signature needed a context
 * parameter).
 *
 * ## Solution
 *
 * Use Node.js built-in `AsyncLocalStorage` to associate a `LogContext` with
 * the current async execution flow. Any Logger call within a `withLogContext()`
 * scope automatically picks up the active taskId, sessionId, etc.
 *
 * ## How to use
 *
 * ```typescript
 * import { withLogContext } from '@/shared/services/log-context'
 *
 * // At session start, wrap the entire execution:
 * withLogContext({ taskId: "task_123", sessionId: "sess_456" }, async () => {
 *   Logger.info("Session started")        // Auto-tagged with taskId
 *   await someDeepOperation()              // All nested Logger calls also tagged
 *   Logger.warn("Something suspicious")    // Still tagged
 * })
 * ```
 *
 * ## ⚠️ Warnings
 *
 * - `AsyncLocalStorage` propagates through `async/await` chains, but NOT
 *   through raw `setTimeout` / `setInterval` callbacks or EventEmitter
 *   'data' listeners. If you need context in those, ensure the callback is
 *   created within the `withLogContext` scope or manually re-wrap.
 * - Do NOT store mutable objects — the context is shared by reference within
 *   the same async chain.
 */

import { AsyncLocalStorage } from "async_hooks"

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface LogContext {
	/** The id of the current task (e.g. "task_abc123") */
	taskId?: string
	/** The id of the current session (e.g. "sess_xyz") */
	sessionId?: string
	/** Optional run/attempt id for retry tracking */
	runId?: string
	/** The active provider id (e.g. "anthropic", "ollama") */
	providerId?: string
	/** Arbitrary key-value tags for additional context */
	tags?: Record<string, string>
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage instance
// ---------------------------------------------------------------------------

const storage = new AsyncLocalStorage<LogContext>()

/**
 * Run `fn` with the given `LogContext` bound to the current async execution
 * flow. All Logger calls made within `fn` (or any async operation it awaits)
 * will automatically include the context fields.
 *
 * @param ctx — The context to associate (taskId, sessionId, etc.)
 * @param fn — The async function to execute within the context scope
 * @returns The return value of `fn`
 *
 * @example
 * ```typescript
 * const result = await withLogContext({ taskId: "task_1" }, async () => {
 *   Logger.info("Doing work") // → "[Task: task_1] Doing work"
 *   return 42
 * })
 * ```
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
	return storage.run(ctx, fn)
}

/**
 * Get the current `LogContext` for the active async execution flow.
 *
 * Returns `undefined` if called outside a `withLogContext()` scope.
 * Logger's `#output` method uses this internally to enrich log messages.
 */
export function getLogContext(): LogContext | undefined {
	return storage.getStore()
}

/**
 * Format a log context into a human-readable prefix.
 *
 * Example output: `[Task: task_abc] [Session: sess_xyz]`
 *
 * Used by Logger to prepend context to messages.
 */
export function formatLogContext(ctx: LogContext): string {
	const parts: string[] = []
	if (ctx.taskId) parts.push(`Task: ${ctx.taskId}`)
	if (ctx.sessionId) parts.push(`Session: ${ctx.sessionId}`)
	if (ctx.runId) parts.push(`Run: ${ctx.runId}`)
	if (ctx.providerId) parts.push(`Provider: ${ctx.providerId}`)
	if (parts.length === 0) return ""
	return `[${parts.join("] [")}] `
}

/**
 * Export the storage instance for testing/advanced usage.
 * @internal
 */
export const _storage = storage
