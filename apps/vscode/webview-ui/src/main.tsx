import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./main.css"
import "./index.css"
import App from "./App.tsx"
import { reportWebviewError } from "./utils/reportWebviewError"

/**
 * Report failures that would otherwise be invisible.
 *
 * VS Code does not persist the webview console to disk, so before this the only
 * durable record of the panel was the extension log - and it ends at "Webview view
 * resolved". A bundle that fails to evaluate, or a module that throws at import
 * time, leaves the root element empty: the panel is blank, the webview never posts
 * webview_ready, and nothing anywhere says why.
 *
 * Installed before createRoot so a throw during the initial render is caught too.
 * The listener is intentionally outside React: ChatErrorBoundary only covers
 * errors thrown while rendering inside the tree, which excludes module evaluation
 * and anything that fails before the tree exists.
 */
window.addEventListener("error", (event) => {
	reportWebviewError({
		phase: "runtime",
		message: String(event.message ?? "unknown error"),
		source: event.filename,
		line: event.lineno,
		column: event.colno,
		// An uncaught failure may carry no stack; the message plus location is the
		// part that identifies it, and the extension log is the only place it lands.
		stack: event.error instanceof Error ? event.error.stack : undefined,
	})
})

window.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason
	reportWebviewError({
		phase: "runtime",
		message: `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
		stack: reason instanceof Error ? reason.stack : undefined,
	})
})

try {
	createRoot(document.getElementById("root")!).render(
		<StrictMode>
			<App />
		</StrictMode>,
	)
} catch (error) {
	// Thrown synchronously by createRoot/render, e.g. a provider that throws while
	// building its initial state.
	reportWebviewError({
		phase: "runtime",
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
	})
	throw error
}
