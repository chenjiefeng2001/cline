/**
 * Simple Logger utility for the extension's backend code.
 *
 * Subscriber lifecycle: every call to `subscribe()` returns a `Disposable`
 * that removes the callback when disposed. Always capture and dispose when
 * the calling module is torn down to prevent subscriber leaks.
 *
 * Context propagation: Logger automatically picks up the active
 * `LogContext` (taskId, sessionId, etc.) from AsyncLocalStorage when
 * `withLogContext()` is used around the caller. No manual context passing
 * needed. See `log-context.ts` for details.
 */
import { getLogContext, formatLogContext } from "./log-context"

/**
 * Minimal interface matching VS Code's `LogOutputChannel`.
 * Keeps Logger usable in non-VSCode environments (CLI, tests).
 */
export interface LogOutputChannel {
	trace(message: string, ...args: any[]): void
	debug(message: string, ...args: any[]): void
	info(message: string, ...args: any[]): void
	warn(message: string, ...args: any[]): void
	error(message: string, ...args: any[]): void
}

export class Logger {
	private static isVerbose = process.env.IS_DEV === "true"

	private static subscribers: Set<(msg: string) => void> = new Set()

	/**
	 * Ring buffer of recent log entries for diagnostic reports.
	 * Captures the last N entries in memory so we can export them
	 * without reading the full output channel file.
	 */
	private static readonly MAX_RECENT_LOGS = 200
	private static recentLogs: Array<{ ts: string; level: string; message: string }> = []

	/** Returns a copy of the recent log ring buffer. */
	static getRecentLogs(): Array<{ ts: string; level: string; message: string }> {
		return [...Logger.recentLogs]
	}

	/** Optional LogOutputChannel (e.g. VS Code's `window.createOutputChannel("Cline", { log: true })`). */
	private static outputChannel: LogOutputChannel | null = null

	/**
	 * Wire a LogOutputChannel (e.g. VS Code's `window.createOutputChannel("Cline", { log: true })`).
	 * Once set, all log output is also routed through this channel with the appropriate level.
	 *
	 * In environments where `vscode.window.createOutputChannel` with `{ log: true }` is available
	 * (VS Code >= 1.73), this provides proper log level filtering and file-based persistence.
	 * The call should be wrapped in try/catch since older VS Code versions and test environments
	 * don't support it.
	 */
	static setOutputChannel(ch: LogOutputChannel | null): void {
		Logger.outputChannel = ch
	}

	private static output(msg: string): void {
		for (const subscriber of Logger.subscribers) {
			try {
				subscriber(msg)
			} catch {
				// ignore errors from subscribers
			}
		}
	}

	/**
	 * Register a callback to receive log output messages.
	 *
	 * @returns A Disposable that removes the subscriber when disposed.
	 *   Call `dispose()` during teardown to prevent subscriber leaks.
	 *
	 * @example
	 * ```typescript
	 * const sub = Logger.subscribe(msg => console.log(msg))
	 * // ... later, during cleanup:
	 * sub.dispose()
	 * ```
	 */
	static subscribe(outputFn: (msg: string) => void): { dispose: () => void } {
		Logger.subscribers.add(outputFn)
		return {
			dispose: () => {
				Logger.subscribers.delete(outputFn)
			},
		}
	}

	static error(message: string, ...args: any[]) {
		Logger.#output("ERROR", message, undefined, args)
	}

	static warn(message: string, ...args: any[]) {
		Logger.#output("WARN", message, undefined, args)
	}

	static log(message: string, ...args: any[]) {
		Logger.#output("LOG", message, undefined, args)
	}

	static debug(message: string, ...args: any[]) {
		Logger.#output("DEBUG", message, undefined, args)
	}

	static info(message: string, ...args: any[]) {
		Logger.#output("INFO", message, undefined, args)
	}

	static trace(message: string, ...args: any[]) {
		Logger.#output("TRACE", message, undefined, args)
	}

	static #output(level: string, message: string, error: Error | undefined, args: any[]) {
		try {
			// Enrich message with AsyncLocalStorage context (taskId, sessionId, etc.)
			const ctx = getLogContext()
			const contextPrefix = ctx ? formatLogContext(ctx) : ""
			let fullMessage = contextPrefix + message
			if (Logger.isVerbose && args.length > 0) {
				fullMessage += ` ${args.map((arg) => JSON.stringify(arg)).join(" ")}`
			}
			const errorSuffix = error?.message ? ` ${error.message}` : ""
			const ts = new Date().toISOString()
			const line = `${ts} ${level} ${fullMessage}${errorSuffix}`.trimEnd()

			// Push to ring buffer for diagnostic reports
			Logger.recentLogs.push({ ts, level, message: fullMessage })
			if (Logger.recentLogs.length > Logger.MAX_RECENT_LOGS) {
				Logger.recentLogs.shift()
			}

			// Route to subscriber set (console, in-memory buffer, etc.)
			Logger.output(line)

			// Route to LogOutputChannel with appropriate level mapping
			if (Logger.outputChannel) {
				switch (level) {
					case "ERROR":
						Logger.outputChannel.error(line)
						break
					case "WARN":
						Logger.outputChannel.warn(line)
						break
					case "INFO":
						Logger.outputChannel.info(line)
						break
					case "DEBUG":
						Logger.outputChannel.debug(line)
						break
					case "TRACE":
						Logger.outputChannel.trace(line)
						break
					default:
						Logger.outputChannel.info(line)
						break
				}
			}
		} catch {
			// do nothing if Logger fails
		}
	}
}
