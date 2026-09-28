import type { WebviewErrorReport } from "@shared/WebviewMessage"
import { PLATFORM_CONFIG } from "../config/platform.config"

/**
 * Forward a webview failure to the extension so it lands in Cline.log.
 *
 * The webview console is the natural place for this, but VS Code discards it on
 * close and never writes it to disk, which makes a blank panel undiagnosable after
 * the fact. The extension log is the one artifact a user can hand over, so the
 * report goes there too.
 *
 * Best-effort by design: reporting an error must never itself throw, and it must
 * not depend on application state or the store, because the common case is that
 * the failure happened before any of that was usable.
 */
export function reportWebviewError(report: WebviewErrorReport): void {
	try {
		PLATFORM_CONFIG.postMessage({ type: "webview_error", webview_error: report })
	} catch {
		// Nothing left to report to - the bridge is gone, which is itself the
		// condition being reported. Swallowing here keeps the original error as the
		// one that propagates.
	}
}

/**
 * Report a load-phase failure. Call this from an inline script in the webview HTML
 * when the bundle itself cannot be evaluated, since a static import that fails to
 * load never reaches any application module.
 */
export function reportWebviewLoadError(message: string, source?: string): void {
	reportWebviewError({ phase: "load", message, source })
}

/**
 * Forward a webview decision to the extension, rate-limited per key.
 *
 * The [TurnUi] decision logs - what a submission routed to, why the composer is
 * disabled, which footer button rejected a click - go to the webview console, which
 * VS Code discards when the panel closes. That makes the decisive question
 * unanswerable afterwards: a user whose message list is not updating sends the log,
 * and it shows a healthy extension that never received their interaction. Observed
 * directly - a session ran six hours with the host correctly reporting an idle,
 * completed conversation while the list looked frozen, and nothing in Cline.log
 * could tell "the user did nothing" from "the webview dropped the send".
 *
 * Rate-limited because some fire on every state change and a dropped update during
 * streaming produces one per delta. The suppressed count is folded into the message
 * so a burst stays visible.
 */
const DIAGNOSTIC_INTERVAL_MS = 10_000
const lastDiagnosticAt = new Map<string, number>()
const suppressedCounts = new Map<string, number>()

export function reportWebviewDiagnostic(key: string, message: string): void {
	try {
		const now = Date.now()
		const previous = lastDiagnosticAt.get(key)
		if (previous !== undefined && now - previous < DIAGNOSTIC_INTERVAL_MS) {
			suppressedCounts.set(key, (suppressedCounts.get(key) ?? 0) + 1)
			return
		}
		const suppressed = suppressedCounts.get(key) ?? 0
		lastDiagnosticAt.set(key, now)
		suppressedCounts.set(key, 0)
		PLATFORM_CONFIG.postMessage({
			type: "webview_error",
			webview_error: {
				phase: "diagnostic",
				message: suppressed
					? message + " (+" + suppressed + " similar in the last " + DIAGNOSTIC_INTERVAL_MS / 1000 + "s)"
					: message,
			},
		})
	} catch {
		// Best effort, same as reportWebviewError.
	}
}
