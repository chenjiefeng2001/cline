/**
 * Frame-coalesced update scheduling (V12 方案6 — high-frequency message debounce).
 *
 * Streaming deltas, partial messages and snapshots arrive as separate gRPC
 * callbacks (separate macrotasks), so without coalescing each one triggers its
 * own React render — mid-frame renders are wasted. This utility merges all
 * publishes that happen within a single animation frame into one flush.
 *
 * The scheduler function is injectable so the logic can be unit-tested with
 * fake timers/callbacks.
 */

export type FrameScheduler = (callback: () => void) => () => void

export interface FrameCoalescer {
	/** Mark a pending update; at most one scheduled flush per frame. */
	schedule: () => void
	/** Cancel a scheduled (but not yet run) flush. */
	cancel: () => void
	/** Run the flush immediately, cancelling any pending frame. */
	flushNow: () => void
}

/**
 * How long a scheduled frame may be outstanding before the flush runs anyway.
 *
 * A frame is a courtesy, not a guarantee. Chromium stops producing frames for an
 * occluded surface - a minimised window, a panel covered by another window, a
 * webview scrolled out of view - and `document.hidden` stays false for occlusion,
 * so the rAF branch below is chosen and the callback then never arrives. Because
 * `pending` guards every later schedule() call, a single lost frame latches the
 * whole pipeline: the webview stops applying streaming output and nothing in
 * production ever clears it, since flushNow() has no call site and cancel() only
 * runs on unmount. 250ms is well above a frame in every healthy case, so the
 * safety net is invisible in normal operation.
 */
const DEFAULT_STALL_TIMEOUT_MS = 250

export function createFrameCoalescer(
	flush: () => void,
	scheduleFrame: FrameScheduler,
	stallTimeoutMs: number = DEFAULT_STALL_TIMEOUT_MS,
): FrameCoalescer {
	let pending = false
	let cancelScheduled: (() => void) | null = null
	let cancelSafetyNet: (() => void) | null = null

	const clearSafetyNet = () => {
		cancelSafetyNet?.()
		cancelSafetyNet = null
	}

	const runFlush = () => {
		pending = false
		cancelScheduled = null
		clearSafetyNet()
		flush()
	}

	return {
		schedule() {
			if (pending) {
				return
			}
			pending = true
			cancelScheduled = scheduleFrame(runFlush)
			// Whichever of the frame or this timer arrives first wins; runFlush
			// cancels the other, so the flush still happens exactly once.
			const safetyHandle = setTimeout(runFlush, stallTimeoutMs)
			cancelSafetyNet = () => clearTimeout(safetyHandle)
		},
		cancel() {
			cancelScheduled?.()
			cancelScheduled = null
			clearSafetyNet()
			pending = false
		},
		flushNow() {
			if (cancelScheduled) {
				cancelScheduled()
				cancelScheduled = null
			}
			clearSafetyNet()
			pending = false
			flush()
		},
	}
}

/**
 * Default scheduler: `requestAnimationFrame` when the document is visible
 * (Chromium webview), otherwise a ~1-frame `setTimeout` fallback so backgrounded
 * webviews still converge promptly.
 */
export const scheduleAnimationFrame: FrameScheduler = (callback) => {
	if (typeof requestAnimationFrame === "function" && typeof document !== "undefined" && !document.hidden) {
		const handle = requestAnimationFrame(callback)
		return () => cancelAnimationFrame(handle)
	}
	const handle = setTimeout(callback, 16)
	return () => clearTimeout(handle)
}
