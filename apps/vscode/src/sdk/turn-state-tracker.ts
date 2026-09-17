import type { ConnectionStatus, TurnPhase, TurnState } from "@shared/ExtensionMessage"
import type { MessageIdMinter } from "./message-id-minter"

// Authoritative UI-mode tracker for the current agent turn.
//
// The backend knows the true phase at every SDK lifecycle point (it drives the session and owns
// every interaction promise), so it sets the phase explicitly here rather than letting the
// webview infer it from the tail of the message array. The webview renders
// footer/buttons/thinking from this.
//
// Each transition stamps a fresh `seq` from the shared minter so the webview keeps only the
// newest TurnState and ignores stale/out-of-order ones (a late "streaming" can never overwrite
// a newer "completed").

export class TurnStateTracker {
	private phase: TurnPhase = "idle"
	private anchorTs: number | undefined
	private seq: number
	private connectionStatus: ConnectionStatus = "idle"
	private retryAttempt = 0
	private retryMax = 0

	constructor(private readonly minter: MessageIdMinter) {
		this.seq = minter.nextSeq()
	}

	/** Set the phase (and optional anchor message ts), advancing seq. No-op metadata if unchanged. */
	set(phase: TurnPhase, anchorTs?: number): void {
		this.phase = phase
		this.anchorTs = anchorTs
		this.seq = this.minter.nextSeq()
		// Reset retry counters on phase transitions that are not retries
		if (phase === "streaming" || phase === "completed" || phase === "idle") {
			this.retryAttempt = 0
			this.retryMax = 0
			this.connectionStatus = phase === "streaming" ? "connected" : "idle"
		} else if (phase === "error") {
			this.connectionStatus = "error"
		}
	}

	/** Update connection status (e.g. "reconnecting" during auto-retry). */
	setConnectionStatus(status: ConnectionStatus, attempt?: number, maxRetries?: number): void {
		this.connectionStatus = status
		if (attempt !== undefined) this.retryAttempt = attempt
		if (maxRetries !== undefined) this.retryMax = maxRetries
		this.seq = this.minter.nextSeq()
	}

	/** Current immutable snapshot for inclusion in the state payload. */
	get(): TurnState {
		return {
			phase: this.phase,
			anchorTs: this.anchorTs,
			seq: this.seq,
			connectionStatus: this.connectionStatus,
			retryAttempt: this.retryAttempt || undefined,
			retryMax: this.retryMax || undefined,
		}
	}

	get currentPhase(): TurnPhase {
		return this.phase
	}
}
