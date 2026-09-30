import type { ConnectionStatus, TurnPhase, TurnState } from "@shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
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

/**
 * Phases that already state how the turn ended.
 *
 * Used to decide whether a late turn-end signal - the send promise resolving - has
 * anything left to say. If the event stream has already reported the end, the phase
 * it chose is the answer: `completed` for a turn that used its completion tool,
 * `awaiting_followup` for one that stopped and is waiting for the user, `resumable`
 * for a cancelled turn, `error` for a failed one. Overwriting any of those with a
 * single "completed" discards the distinction the user actually sees, which is the
 * whole reason the event stream is the authority for the terminal phase.
 */
export function isTerminalTurnPhase(phase: TurnPhase): boolean {
	return phase === "completed" || phase === "awaiting_followup" || phase === "resumable" || phase === "error"
}

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
		const previous = this.phase
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
		// [TurnUi] The phase drives the footer buttons, the composer and whether a
		// submission is accepted or dropped, and the webview gates on seq. A wrong
		// phase is therefore indistinguishable from a dead UI, so every transition
		// records where it came from, where it went, and the anchor it will be
		// matched against. anchorTs=undefined is normal and load-bearing: the webview
		// then keys its button identity on the message tail instead, which is how a
		// footer identity can go stale.
		Logger.log(
			`[TurnUi] phase ${previous} -> ${phase} (seq=${this.seq}, anchorTs=${anchorTs ?? "none"}, connection=${this.connectionStatus})`,
		)
	}

	/** Update connection status (e.g. "reconnecting" during auto-retry). */
	setConnectionStatus(status: ConnectionStatus, attempt?: number, maxRetries?: number): void {
		const previous = this.connectionStatus
		this.connectionStatus = status
		if (attempt !== undefined) this.retryAttempt = attempt
		if (maxRetries !== undefined) this.retryMax = maxRetries
		this.seq = this.minter.nextSeq()
		// [TurnUi] This advances seq without changing the phase. The webview's
		// TurnState gate is seq-based, so this makes a same-phase snapshot look
		// newer to it while the UI mode is unchanged. Worth recording because a seq
		// that moves with no phase change is the signature of a stale-phase bug.
		Logger.debug(
			`[TurnUi] connection ${previous} -> ${status} (phase stays ${this.phase}, seq=${this.seq}, attempt=${this.retryAttempt}/${this.retryMax})`,
		)
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
