import { useExtensionState } from "@/context/ExtensionStateContext"

/**
 * Rendered instead of the app while the first state snapshot has not arrived.
 *
 * This exists because the previous behaviour was `return null`, which made an
 * unhydrated webview indistinguishable from a broken one: the user saw a blank
 * panel with no error, no spinner, and no way to recover short of reloading the
 * window. Anything that prevents the first frame from landing - an oversized
 * payload the transport drops, a slow host, a race on webview re-creation -
 * ended in that silent blank.
 */
const HydrationGate = () => {
	const { didHydrateState, hydrationTimedOut, retryHydration } = useExtensionState()

	if (didHydrateState) {
		return null
	}

	return (
		<div className="flex h-screen w-screen flex-col items-center justify-center gap-3 p-6 text-center">
			{hydrationTimedOut ? (
				<>
					<p className="text-sm font-medium">Cline could not load its state from the extension host.</p>
					<p className="max-w-md text-xs opacity-70">
						This usually means the initial state payload was too large to deliver, or the extension host did not
						respond in time. Retrying re-requests a fresh snapshot.
					</p>
					<button
						className="mt-1 rounded border border-vscode-button-border bg-vscode-button-background px-3 py-1 text-xs text-vscode-button-foreground hover:bg-vscode-button-hoverBackground"
						data-testid="hydration-retry"
						onClick={retryHydration}
						type="button">
						Retry
					</button>
				</>
			) : (
				<>
					<span className="text-xs opacity-70" data-testid="hydration-loading">
						Loading Cline…
					</span>
					<span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
				</>
			)}
		</div>
	)
}

export default HydrationGate
