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
