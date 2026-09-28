import React from "react"
import { reportWebviewError } from "../../utils/reportWebviewError"

interface ChatErrorBoundaryProps {
	children: React.ReactNode
	errorTitle?: string
	errorBody?: string
	height?: string
}

interface ChatErrorBoundaryState {
	hasError: boolean
	error: Error | null
}

/**
 * A reusable error boundary component specifically designed for chat widgets.
 * It provides a consistent error UI with customizable title and body text.
 */
class ChatErrorBoundary extends React.Component<ChatErrorBoundaryProps, ChatErrorBoundaryState> {
	constructor(props: ChatErrorBoundaryProps) {
		super(props)
		this.state = { hasError: false, error: null }
	}

	static getDerivedStateFromError(error: Error) {
		return { hasError: true, error }
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		console.error("Error in ChatErrorBoundary:", error.message)
		console.error("Component stack:", errorInfo.componentStack)

		// A boundary is precisely the component that prevents an error from reaching
		// window.onerror, which is where the webview load guard listens. So every
		// boundary-caught failure was invisible outside the devtools console: the panel
		// showed "Something went wrong displaying this content" and Cline.log said
		// nothing at all. VS Code discards that console when the panel closes, so the
		// report was gone by the time anyone looked. Forward it to the extension, which
		// is the one artifact that survives. The component stack is included because
		// "an error happened somewhere in a chat widget" is not actionable on its own.
		reportWebviewError({
			phase: "runtime",
			message: `React error boundary caught: ${error.message}`,
			// componentStack is React.ErrorInfo's, typed `string | null`; normalise to
			// undefined so the optional field stays optional.
			stack: error.stack ?? errorInfo.componentStack ?? undefined,
		})
	}

	render() {
		const { errorTitle, errorBody, height } = this.props

		if (this.state.hasError) {
			return (
				<div
					style={{
						padding: "10px",
						color: "var(--vscode-errorForeground)",
						height: height || "auto",
						maxWidth: "512px",
						overflow: "auto",
						border: "1px solid var(--vscode-editorError-foreground)",
						borderRadius: "4px",
						backgroundColor: "var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1))",
					}}>
					<h3 style={{ margin: "0 0 8px 0" }}>{errorTitle || "Something went wrong displaying this content"}</h3>
					<p style={{ margin: "0" }}>{errorBody || `Error: ${this.state.error?.message || "Unknown error"}`}</p>
				</div>
			)
		}

		return this.props.children
	}
}

export default ChatErrorBoundary
