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
		// KNOWN GAP - see below. Resume is advertised, but the composer is enabled,
		// so a user who has already typed has no way to submit.
		send: "dropped",
		composerEnabled: true,
		needsFooterEscape: true,
		why: "the task was cancelled; the composer still accepts input that is then discarded",
	},
	idle: {
		// KNOWN GAP - see below.
		send: "dropped",
		composerEnabled: true,
		needsFooterEscape: true,
		why: "no turn in progress, so the composer accepts input that is then discarded",
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
		// `idle` is excluded here and asserted as a known gap below; it is the one
		// phase that currently satisfies neither.
		const SATISFIED = TURN_PHASES.filter((p) => p !== "idle")

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

	describe("KNOWN GAP: idle discards what the user typed", () => {
		// idle drops a submission while the composer is enabled AND the footer
		// advertises no action, so the input looks like it works and the text
		// vanishes. Controller.restoreCheckpoint() reaches it: it sets `idle`,
		// bumps the fence, then replaces the transcript with the restored
		// messages, leaving the webview with messages AND phase `idle`.
		//
		// Not repaired here. The two candidate behaviours - start a task behind the
		// user's back, or raise an error - both change product semantics, and
		// `idle` with a populated transcript is genuinely ambiguous. Asserted as a
		// failure: when the product decides, remove `.fails` and this becomes the
		// contract.
		it.fails("must either accept the submission or visibly refuse it", () => {
			expect(sendOutcomeFor({ phase: "idle", hasMessages: true, hasOpenAsk: false })).not.toBe("dropped")
		})

		it("records the current behaviour that makes the gap reachable", () => {
			expect(sendOutcomeFor({ phase: "idle", hasMessages: true, hasOpenAsk: false })).toBe("dropped")
			expect(composerStateForPhase("idle").composerEnabled).toBe(true)
			expect(footerEscapeAction("idle")).toBeUndefined()
		})
	})

	describe("KNOWN GAP: resumable also discards typed input", () => {
		// Surfaced by this table rather than assumed: cancelTask() sets `resumable`
		// and leaves the transcript in place, and resume_task.sendingDisabled is
		// false, so the composer is enabled. Resume is advertised in the footer,
		// which does not help a user who has already typed a follow-up. Needs the
		// same product decision as idle.
		it.fails("must either accept the submission or visibly refuse it", () => {
			expect(sendOutcomeFor({ phase: "resumable", hasMessages: true, hasOpenAsk: false })).not.toBe("dropped")
		})

		it("records the current behaviour that makes the gap reachable", () => {
			expect(sendOutcomeFor({ phase: "resumable", hasMessages: true, hasOpenAsk: false })).toBe("dropped")
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
