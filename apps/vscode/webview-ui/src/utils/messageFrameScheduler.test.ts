import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFrameCoalescer, type FrameScheduler, scheduleAnimationFrame } from "./messageFrameScheduler"

describe("createFrameCoalescer (V12 方案6)", () => {
	function makeHarness() {
		const flush = vi.fn()
		let scheduled: (() => void) | null = null
		const schedule = vi.fn<FrameScheduler>((fn) => {
			scheduled = fn
			return () => {
				scheduled = null
			}
		})
		const coalescer = createFrameCoalescer(flush, schedule)
		return { coalescer, flush, schedule, runFrame: () => scheduled?.() }
	}

	it("flushes once per frame when scheduled repeatedly", () => {
		const { coalescer, flush, schedule, runFrame } = makeHarness()

		coalescer.schedule()
		coalescer.schedule()
		coalescer.schedule()

		expect(schedule).toHaveBeenCalledTimes(1)
		expect(flush).not.toHaveBeenCalled()

		runFrame()
		expect(flush).toHaveBeenCalledTimes(1)

		coalescer.schedule()
		runFrame()
		expect(flush).toHaveBeenCalledTimes(2)
	})

	it("cancel() drops a scheduled flush", () => {
		const { coalescer, flush, runFrame } = makeHarness()

		coalescer.schedule()
		coalescer.cancel()

		runFrame()
		expect(flush).not.toHaveBeenCalled()

		// A fresh schedule after cancel still works.
		coalescer.schedule()
		runFrame()
		expect(flush).toHaveBeenCalledTimes(1)
	})

	it("flushNow() runs immediately and cancels the pending frame", () => {
		const { coalescer, flush, runFrame } = makeHarness()

		coalescer.schedule()
		coalescer.flushNow()
		expect(flush).toHaveBeenCalledTimes(1)

		// The cancelled frame must not double-flush.
		runFrame()
		expect(flush).toHaveBeenCalledTimes(1)
	})

	it("scheduleAnimationFrame uses rAF when the document is visible", () => {
		const cb = vi.fn()
		const cancel = scheduleAnimationFrame(cb)
		expect(typeof cancel).toBe("function")
	})
})

/**
 * The hang this guards: streaming output stops in the webview and never resumes,
 * while the extension host keeps accumulating messages. Nothing in the extension
 * log shows it, and nothing in production clears it.
 *
 * The mechanism is a single lost animation frame. Chromium stops producing frames
 * for an occluded surface - minimised window, a panel behind another window, a
 * webview scrolled out of view - and `document.hidden` stays false for occlusion,
 * so scheduleAnimationFrame still takes the rAF branch and the callback never
 * arrives. `pending` is set before the frame is scheduled and cleared only by
 * runFlush, so after that one missed frame every subsequent schedule() is a no-op
 * and the coalescer stops flushing permanently. flushNow() has no production call
 * site and cancel() only runs on unmount, so there was no recovery path at all.
 */
describe("createFrameCoalescer stall recovery", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	function harness(opts?: { stallTimeoutMs?: number }) {
		const flush = vi.fn()
		// Models a scheduler whose callback is never invoked: an occluded surface
		// accepts the request and then never produces a frame.
		const schedule = vi.fn<FrameScheduler>(() => () => {})
		const coalescer = createFrameCoalescer(flush, schedule, opts?.stallTimeoutMs)
		return { coalescer, flush, schedule }
	}

	it("flushes even when the frame is never delivered", () => {
		const { coalescer, flush, schedule } = harness()
		coalescer.schedule()
		expect(schedule).toHaveBeenCalledTimes(1)
		expect(flush).not.toHaveBeenCalled()

		vi.advanceTimersByTime(250)
		expect(flush).toHaveBeenCalledTimes(1)
	})

	it("resumes accepting updates after a lost frame, instead of latching", () => {
		// This is the assertion that matters: the old code latched here, so every
		// later schedule() returned early and the webview stayed frozen for good.
		const { coalescer, flush, schedule } = harness()
		coalescer.schedule()
		vi.advanceTimersByTime(250)
		expect(flush).toHaveBeenCalledTimes(1)

		coalescer.schedule()
		expect(schedule).toHaveBeenCalledTimes(2)
		vi.advanceTimersByTime(250)
		expect(flush).toHaveBeenCalledTimes(2)
	})

	it("does not double-flush when the frame does arrive first", () => {
		const flush = vi.fn()
		let frame: (() => void) | null = null
		const schedule: FrameScheduler = (fn) => {
			frame = fn
			return () => {
				frame = null
			}
		}
		const coalescer = createFrameCoalescer(flush, schedule, 250)

		coalescer.schedule()
		frame?.()
		expect(flush).toHaveBeenCalledTimes(1)

		// The safety-net timer must be disarmed by the frame, or this would be a
		// second flush of a state the webview has already applied.
		vi.advanceTimersByTime(1000)
		expect(flush).toHaveBeenCalledTimes(1)
	})

	it("cancel() disarms the safety net too", () => {
		const { coalescer, flush } = harness()
		coalescer.schedule()
		coalescer.cancel()
		vi.advanceTimersByTime(1000)
		expect(flush).not.toHaveBeenCalled()
	})

	it("flushNow() disarms the safety net so a cancelled frame cannot fire later", () => {
		const { coalescer, flush } = harness()
		coalescer.schedule()
		coalescer.flushNow()
		expect(flush).toHaveBeenCalledTimes(1)
		vi.advanceTimersByTime(1000)
		expect(flush).toHaveBeenCalledTimes(1)
	})
})
