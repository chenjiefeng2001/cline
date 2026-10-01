import { describe, expect, it } from "vitest"
import type { SendOutcome, TurnPhaseName } from "./turnUiContract"
import { composerStateForPhase, footerEscapeAction, isComposerEnabled, sendOutcomeFor, TURN_PHASES } from "./turnUiContract"

/**
 * The turn/UI contract, stated as a table.
 *
 * These assertions describe what each phase is supposed to mean for the user, not
 * what the current code happens to do. Where the implementation disagrees with the
 * intent, the test says so instead of absorbing it - that is the whole point, so
 * the disagreement shows up in CI rather than in a bug report.
 *
 * `epoch` leads the table because it decides whether the webview holds a
 * transcript at all: applyStateSnapshot only replaces the transcript when the
 * epoch advances, and at the same epoch it merges and never shrinks. The same
 * phase therefore behaves differently either side of a conversation boundary.
 */

/** What the user should be able to do per phase, and why. */
type PhaseIntent = {
	/** Expected sendOutcomeFor() with a retained transcript and no open ask. */
	send: SendOutcome
	/** Expected composer state, using the phase's real button config. */
	composerEnabled: boolean
	/** Must the footer offer an action? Only meaningful when `send` is dropped. */
	needsFooterEscape: boolean
	why: string
}

const INTENTS: Record<TurnPhaseName, PhaseIntent> = {
	streaming: {
		send: "continue-turn",
		composerEnabled: true,
		needsFooterEscape: false,
		why: "a turn is live; submitting steers or queues into it",
	},
	completed: {
		send: "continue-turn",
		composerEnabled: true,
		needsFooterEscape: false,
		why: "the agent finished; the user can keep talking in this session",
	},
	awaiting_followup: {
		send: "continue-turn",
		composerEnabled: true,
		needsFooterEscape: false,
		why: "the agent is waiting on the user, so input is the expected answer",
	},
	awaiting_approval: {
		send: "reject-approval",
		composerEnabled: true,
		needsFooterEscape: false,
		why: "an approval is pending; submitting the composer rejects it by design",
	},
	error: {
		send: "dropped",
		composerEnabled: false,
		needsFooterEscape: true,
		why: "the turn failed; the composer is visibly off and Retry / New Task are offered",
	},
	resumable: {
		// A cancelled turn continues the same task. The docs are explicit that an
		// interrupted turn ends with the same stop reason as one that finished on its
		// own, so there is no separate end state here to respect.
		send: "continue-turn",
		composerEnabled: true,
		needsFooterEscape: true,
		why: "the task was cancelled; the composer still accepts input that is then discarded",
	},
	idle: {
		// With a transcript, a follow-up continues the same task. An empty transcript
		// still starts a new one, which the !hasMessages branch handles.
		send: "continue-turn",
		composerEnabled: true,
		needsFooterEscape: true,
		why: "no turn in progress, so a follow-up continues the task it was left on",
	},
	limit_reached: {
		// A run that hit its cap, its budget, or a non-converging tool is over, not
		// broken: the transcript is intact and there is work to carry on from, which is
		// the same situation as `completed` with a different reason. Submitting continues
		// the session; the cap will stop the next run at the same place, and that is the
		// user learning the number is too low rather than the product misbehaving.
		send: "continue-turn",
		composerEnabled: true,
		needsFooterEscape: true,
		why: "the run stopped at a boundary; the transcript is intact so a follow-up continues it",
	},
}

describe("turn/UI contract", () => {
	it("covers every phase the backend can report", () => {
		expect([...TURN_PHASES].sort()).toEqual([...Object.keys(INTENTS)].sort())
	})

	describe("epoch advanced: the webview replaced the transcript", () => {
		it.each(TURN_PHASES)("%s routes a submission to a new task when the transcript is empty", (phase) => {
			// With no transcript the phase is irrelevant: a submission always starts a
			// new task, so no phase can dead-end on this side of the fence.
			expect(sendOutcomeFor({ phase, hasMessages: false, hasOpenAsk: false })).toBe("new-task")
		})
	})

	describe("same epoch: the transcript is retained, so the phase decides", () => {
		it.each(TURN_PHASES)("%s -> send=%s (composer from real config=%s)", (phase) => {
			const intent = INTENTS[phase]
			const outcome = sendOutcomeFor({ phase, hasMessages: true, hasOpenAsk: false })
			expect(outcome, `${phase}: ${intent.why}`).toBe(intent.send)
		})

		it.each(TURN_PHASES)("%s -> composer enabled=%s", (phase) => {
			const intent = INTENTS[phase]
			const { composerEnabled } = composerStateForPhase(phase)
			expect(composerEnabled, `${phase}: ${intent.why}`).toBe(intent.composerEnabled)
		})
	})

	describe("a dropped submission must not look like a working one", () => {
		// The invariant that turns "silently dropped" from a bug report into a test
		// failure. A phase may drop a submission if it disables the composer (the
		// user can see it is off) or advertises a footer action to click instead.
		//
		// Every phase, now. `idle` and `resumable` used to be excluded because they
		// dropped a submission while looking usable - the invariant below is what caught
		// that, and both now route to continue-turn instead of dropping.
		const SATISFIED = TURN_PHASES

		it.each(SATISFIED)("%s", (phase) => {
			const intent = INTENTS[phase]
			if (intent.send !== "dropped") {
				return
			}
			const { composerEnabled } = composerStateForPhase(phase)
			const escape = footerEscapeAction(phase)
			const visiblyOffOrHasEscape = !composerEnabled || Boolean(escape)
			expect(
				visiblyOffOrHasEscape,
				`${phase} drops a submission but looks usable: composerEnabled=${composerEnabled}, footerAction=${escape}`,
			).toBe(true)
		})

		it("error disables the composer, so it is not a silent drop", () => {
			// The case the contract is satisfied by today.
			expect(composerStateForPhase("error").composerEnabled).toBe(false)
			expect(footerEscapeAction("error")).toBeTruthy()
		})

		it("resumable offers Resume in the footer, so it is not a silent drop", () => {
			expect(footerEscapeAction("resumable")).toBe("proceed")
		})
	})

	// Previously two KNOWN GAP blocks pinned `dropped` for idle and resumable via
	// it.fails, pending a product decision. Both are closed: a follow-up continues the
	// same task, which is how the agent SDK documents it, and there is no distinct
	// "resumable" end state to respect. The old behaviour is still pinned, inverted,
	// so a regression back to silent-dropping is a failure rather than a surprise.
	describe("idle with a transcript continues the task", () => {
		// Controller.restoreCheckpoint() reaches this: it sets `idle`, bumps the fence,
		// then replaces the transcript with the restored messages, leaving the webview
		// with messages AND phase `idle`. The user could type, the composer was
		// enabled, and the submission vanished with no request, no state change and no
		// error anywhere.
		it("routes to continue-turn rather than dropping", () => {
			expect(sendOutcomeFor({ phase: "idle", hasMessages: true, hasOpenAsk: false })).toBe("continue-turn")
		})

		it("still starts a new task on an empty transcript", () => {
			// The distinction that keeps this from being "always continue". With nothing
			// to continue, the user is starting something.
			expect(sendOutcomeFor({ phase: "idle", hasMessages: false, hasOpenAsk: false })).toBe("new-task")
		})

		it("leaves the composer usable, which is what made the old drop a trap", () => {
			expect(composerStateForPhase("idle").composerEnabled).toBe(true)
		})
	})

	describe("resumable continues the same task", () => {
		// cancelTask() sets `resumable` and leaves the transcript in place, with
		// resume_task.sendingDisabled false, so the composer was enabled while the
		// submission was dropped. The docs are explicit that an interrupted turn ends
		// with the same stop reason as one that finished on its own, so there is no
		// separate end state here to respect.
		it("routes to continue-turn rather than dropping", () => {
			expect(sendOutcomeFor({ phase: "resumable", hasMessages: true, hasOpenAsk: false })).toBe("continue-turn")
		})

		it("leaves the composer usable", () => {
			expect(composerStateForPhase("resumable").composerEnabled).toBe(true)
		})
	})

	describe("an open ask always has a route", () => {
		it.each(TURN_PHASES)("%s answers an open ask rather than dropping it", (phase) => {
			expect(sendOutcomeFor({ phase, hasMessages: true, hasOpenAsk: true })).not.toBe("dropped")
		})
	})

	describe("legacy state with no TurnState still works", () => {
		it("routes a retained transcript off the message tail", () => {
			expect(sendOutcomeFor({ phase: undefined, hasMessages: true, hasOpenAsk: false, isTaskRunning: true })).toBe(
				"continue-turn",
			)
		})

		it("enables the composer off the legacy running signal", () => {
			expect(isComposerEnabled({ phase: undefined, sendingDisabled: true, legacyTaskRunning: true })).toBe(true)
		})
	})
})
