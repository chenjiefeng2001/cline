import type { ClineMessage, TurnState } from "@shared/ExtensionMessage"
import { reportWebviewDiagnostic } from "../../../../utils/reportWebviewError"
import { buttonsForPhase } from "./buttonConfig"

/**
 * The turn/UI contract, in one place.
 *
 * Three separate places used to decide "what can the user do right now" from
 * `turnState.phase`, each with its own inline phase list, and the lists did not
 * agree. `turnAllowsFollowup` in useMessageHandlers omits `idle`, which combined
 * with a retained transcript made the composer a dead end. Keeping the three
 * decisions side by side here makes the divergence reviewable and lets
 * turnUiContract.test.ts state the intended semantics as a table instead of
 * leaving them as three untested expressions.
 *
 * These are pure functions deliberately: they are the contract, and the
 * components are just callers.
 */

/** Every phase the backend can report. Keep in sync with TurnPhase. */
export const TURN_PHASES = [
	"idle",
	"streaming",
	"completed",
	"resumable",
	"error",
	"awaiting_followup",
	"awaiting_approval",
] as const

export type TurnPhaseName = (typeof TURN_PHASES)[number]

/**
 * Phases in which a turn is live or awaiting the user, so a composer submission is a
 * follow-up (or an interrupt) rather than a new task.
 *
 * `idle` and `resumable` are here now, which they were not until this was decided
 * against how mainstream agents behave rather than by guessing:
 *
 *   - a follow-up message *continues* the same task. The agent SDK documents it as
 *     "follow up on a completed task - the agent already analyzed something, now you
 *     want it to act on that analysis", which resumes the same session rather than
 *     opening a new one. An empty transcript still starts a new task, via the
 *     `!hasMessages` branch above.
 *   - there is no separate "resumable" end state to respect. The docs are explicit
 *     that an interrupted turn ends with the *same* stop reason as one that finished
 *     on its own - "there is no stop reason specific to interruption" - so a
 *     resumable turn is a continuation, not a dead end.
 *
 * Before this, `idle` with a populated transcript made the composer a dead end: the
 * user could type, the composer was enabled, and the submission was dropped with no
 * request, no state change and no error anywhere. `Controller.restoreCheckpoint()`
 * reaches that state - it sets `idle` and repopulates the transcript - so it was
 * reachable, not hypothetical.
 */
const FOLLOWUP_PHASES: ReadonlySet<TurnPhaseName> = new Set<TurnPhaseName>([
	"completed",
	"awaiting_followup",
	"streaming",
	"idle",
	"resumable",
])

/** Phases where the composer accepts a submission while the turn is live. */
const QUEUEABLE_PHASES: ReadonlySet<TurnPhaseName> = new Set<TurnPhaseName>(["streaming", "awaiting_approval"])

/**
 * Every one of the three decisions below logs to the webview console under a
 * single `[TurnUi]` prefix, with its inputs.
 *
 * The inputs are the point. Logging only the outcome leaves you unable to tell
 * a correct decision from a wrong one, and these are the decisions where a
 * silent-drop bug is invisible from the outside: the composer simply refuses
 * input, or a submission vanishes, and the extension log shows nothing at all
 * because no RPC was ever made. Grep `[TurnUi]` in the webview devtools console
 * to replay the whole decision chain; the extension log carries the matching
 * `[TurnUi]` phase/epoch lines.
 */

export function isFollowupPhase(phase: TurnPhaseName | undefined): boolean {
	return phase !== undefined && FOLLOWUP_PHASES.has(phase)
}

export function isQueueablePhase(phase: TurnPhaseName | undefined): boolean {
	return phase !== undefined && QUEUEABLE_PHASES.has(phase)
}

/**
 * Whether the composer is enabled. Mirrors InputSection: a submission is
 * allowed while the turn is live (so it can be queued or steered) or when the
 * active button set does not claim to be mid-send.
 */
export function isComposerEnabled(args: {
	phase: TurnPhaseName | undefined
	sendingDisabled: boolean
	/** Fallback for pre-TurnState state: does the message tail look like a live turn? */
	legacyTaskRunning?: boolean
}): boolean {
	const { phase, sendingDisabled, legacyTaskRunning = false } = args
	const queueable = isQueueablePhase(phase)
	const allowQueuedSubmit = queueable || legacyTaskRunning
	const enabled = !(sendingDisabled && !allowQueuedSubmit)
	// Only the disabled case is worth a line: an enabled composer fires on every
	// render, and a disabled one is the state users cannot explain.
	if (!enabled) {
		console.warn(
			`[TurnUi] composer DISABLED (phase=${phase ?? "none"}, sendingDisabled=${sendingDisabled}, ` +
				`queueable=${queueable}, legacyRunning=${legacyTaskRunning}, allowQueuedSubmit=${allowQueuedSubmit})`,
		)
		// Forwarded as well, because "the input box is disabled and I don't know why"
		// is the question the user actually asks, and a console that vanishes with the
		// panel cannot answer it. Rate limited upstream: this runs on every render
		// while disabled.
		reportWebviewDiagnostic(
			"composer-disabled",
			`composer DISABLED (phase=${phase ?? "none"}, sendingDisabled=${sendingDisabled}, ` +
				`queueable=${queueable}, legacyRunning=${legacyTaskRunning}, allowQueuedSubmit=${allowQueuedSubmit})`,
		)
	}
	return enabled
}

/**
 * What a composer submission does, mirroring the branch order in
 * useMessageHandlers.handleSendMessage. The point of this function is the
 * `dropped` case: it must be a reachable, named outcome rather than the absence
 * of an else branch, so it can be asserted on.
 */
export type SendOutcome =
	| "new-task"
	| "reject-approval"
	| "ask-response"
	| "continue-turn"
	/** No branch handled it. This is a dead end and must always be treated as a defect. */
	| "dropped"

export function sendOutcomeFor(args: {
	phase: TurnPhaseName | undefined
	/** Messages currently rendered in the webview. */
	hasMessages: boolean
	/** Is there an unresolved ask the composer should answer? */
	hasOpenAsk: boolean
	/** Does the message tail look like a live turn (legacy fallback path)? */
	isTaskRunning?: boolean
}): SendOutcome {
	const { phase, hasMessages, hasOpenAsk, isTaskRunning = false } = args

	if (!hasMessages) {
		console.log(`[TurnUi] send -> new-task (phase=${phase ?? "none"}, messages=0)`)
		return "new-task"
	}
	if (phase === "awaiting_approval") {
		console.log(`[TurnUi] send -> reject-approval (phase=${phase})`)
		return "reject-approval"
	}
	if (hasOpenAsk) {
		console.log(`[TurnUi] send -> ask-response (phase=${phase ?? "none"}, openAsk=true)`)
		return "ask-response"
	}
	if (isFollowupPhase(phase) || isTaskRunning) {
		console.log(
			`[TurnUi] send -> continue-turn (phase=${phase ?? "none"}, followupPhase=${isFollowupPhase(phase)}, isTaskRunning=${isTaskRunning})`,
		)
		return "continue-turn"
	}
	// The case that has no branch in handleSendMessage and therefore produces no
	// request, no state change and no error anywhere - the user sees their text
	// come back with nothing having happened. Logged at warn so it stands out, and
	// with every input, because whether the phase or the transcript is the odd one
	// out is exactly the question that has to be answered from the log.
	console.warn(
		`[TurnUi] send DROPPED (phase=${phase ?? "none"}, messages>0, openAsk=false, isTaskRunning=${isTaskRunning}, ` +
			`isFollowupPhase=${isFollowupPhase(phase)}) - no branch handles this; the submission is discarded silently`,
	)
	return "dropped"
}
export { buttonsForPhase as footerActionsForPhase } from "./buttonConfig"

/**
 * The composer state for a phase, derived from that phase's real button config
 * rather than from an assumed `sendingDisabled`. `sendingDisabled` is a property
 * of the config object the footer mirrors into chat state, so treating it as an
 * independent input makes it possible to assert a state that can never occur -
 * which is exactly how a first pass of this test "passed" while the real
 * composer was disabled for phases the user must be able to type into.
 */
export function composerStateForPhase(
	phase: TurnPhaseName,
	anchoredMessage?: ClineMessage,
): {
	sendingDisabled: boolean
	composerEnabled: boolean
} {
	const config = buttonsForPhase({ phase, anchorTs: anchoredMessage?.ts, seq: 0 } as TurnState, anchoredMessage, false)
	const sendingDisabled = config.sendingDisabled
	return { sendingDisabled, composerEnabled: isComposerEnabled({ phase, sendingDisabled }) }
}

/**
 * Whether a phase that can drop a submission still gives the user a way forward
 * through the footer. A dropped send is only acceptable if the phase also
 * advertises an action, because that is what the user can click instead.
 */
export function footerEscapeAction(phase: TurnPhaseName, anchoredMessage?: ClineMessage): string | undefined {
	const config = buttonsForPhase({ phase, anchorTs: anchoredMessage?.ts, seq: 0 } as TurnState, anchoredMessage, false)
	return config.primaryAction ?? config.secondaryAction
}
