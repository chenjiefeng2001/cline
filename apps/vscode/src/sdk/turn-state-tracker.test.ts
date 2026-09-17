import { describe, expect, it } from "vitest"
import { MessageIdMinter } from "./message-id-minter"
import { TurnStateTracker } from "./turn-state-tracker"

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
