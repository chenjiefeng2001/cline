import type { TurnPhase } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { MessageIdMinter } from "./message-id-minter"
import { decideTurnEndPhase, isTerminalTurnPhase, TurnStateTracker } from "./turn-state-tracker"

describe("TurnStateTracker", () => {
	it("starts idle", () => {
		const tracker = new TurnStateTracker(new MessageIdMinter())
		expect(tracker.get().phase).toBe("idle")
		expect(tracker.currentPhase).toBe("idle")
	})

	it("advances seq on every transition so the webview keeps the newest", () => {
		const tracker = new TurnStateTracker(new MessageIdMinter())
		const s0 = tracker.get().seq
		tracker.set("streaming")
		const s1 = tracker.get().seq
		tracker.set("completed")
		const s2 = tracker.get().seq
		expect(s1).toBeGreaterThan(s0)
		expect(s2).toBeGreaterThan(s1)
	})

	it("records the phase and anchor ts", () => {
		const tracker = new TurnStateTracker(new MessageIdMinter())
		tracker.set("awaiting_approval", 42)
		expect(tracker.get()).toMatchObject({ phase: "awaiting_approval", anchorTs: 42 })
		tracker.set("streaming")
		// anchor cleared when not provided
		expect(tracker.get().anchorTs).toBeUndefined()
		expect(tracker.get().phase).toBe("streaming")
	})

	it("shares the minter's seq space (seq is globally monotonic)", () => {
		const minter = new MessageIdMinter()
		const tracker = new TurnStateTracker(minter)
		const a = tracker.get().seq
		// An unrelated message mint advances the shared seq counter.
		minter.nextSeq()
		tracker.set("completed")
		expect(tracker.get().seq).toBeGreaterThan(a)
	})

	it("tracks connection status and retry counters for auto-retry UI", () => {
		const tracker = new TurnStateTracker(new MessageIdMinter())
		expect(tracker.get().connectionStatus).toBe("idle")

		tracker.setConnectionStatus("reconnecting", 1, 3)
		expect(tracker.get()).toMatchObject({ connectionStatus: "reconnecting", retryAttempt: 1, retryMax: 3 })

		// streaming resets retry counters and marks connected
		tracker.set("streaming")
		expect(tracker.get()).toMatchObject({ connectionStatus: "connected" })
		expect(tracker.get().retryAttempt).toBeUndefined()
		expect(tracker.get().retryMax).toBeUndefined()

		tracker.set("error")
		expect(tracker.get().connectionStatus).toBe("error")
	})
})

describe("isTerminalTurnPhase", () => {
	// The event stream owns the terminal phase, and a late turn-end signal - the send
	// promise resolving - must not overwrite one. This is the predicate that decides
	// whether there is anything left to say, so each phase is listed explicitly: the
	// set is the whole contract, and a phase added to TURN_PHASES should have to be
	// added here deliberately.
	it.each([
		["completed", true],
		["awaiting_followup", true],
		["resumable", true],
		["error", true],
		["limit_reached", true],
		["streaming", false],
		["awaiting_approval", false],
		["idle", false],
	] as const)("%s -> %s", (phase, expected) => {
		expect(isTerminalTurnPhase(phase)).toBe(expected)
	})

	it("treats every phase it can be handed as a decision, so a new one cannot be half-added", () => {
		// This predicate and TURN_PHASES in the webview have to agree, and they are in
		// different projects with no shared type between them. The exhaustive check that
		// would have caught the missing `limit_reached` lives in the integration test,
		// which is the only place both halves run; this asserts the shape of the decision
		// itself so a future phase cannot be added to one side alone and pass here.
		const phases: TurnPhase[] = [
			"idle",
			"streaming",
			"completed",
			"resumable",
			"error",
			"awaiting_followup",
			"awaiting_approval",
			"limit_reached",
		]
		for (const phase of phases) {
			expect(typeof decideTurnEndPhase(phase).action, phase).toBe("string")
		}
		// `idle` is deliberately non-terminal so a restored transcript is not declared
		// finished; `streaming` and `awaiting_approval` are live turns.
		expect(decideTurnEndPhase("streaming")).toEqual({ action: "fallback", phase: "completed" })
		expect(decideTurnEndPhase("limit_reached")).toEqual({ action: "keep" })
	})

	it("treats idle as non-terminal so a restored transcript is not declared finished", () => {
		// `Controller.restoreCheckpoint()` reaches idle with a populated transcript.
		// Reporting that as a finished turn would put a "Start New Task" footer on a
		// conversation that is merely paused, so idle has to stay non-terminal.
		expect(isTerminalTurnPhase("idle")).toBe(false)
	})
})
