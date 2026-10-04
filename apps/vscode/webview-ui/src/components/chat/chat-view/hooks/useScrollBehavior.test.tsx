import { act, renderHook } from "@testing-library/react"
import type { MutableRefObject } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useScrollBehavior } from "./useScrollBehavior"

const commandMessage = {
	ts: 1,
	type: "ask",
	ask: "command",
	text: "echo hi",
}

describe("useScrollBehavior", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("scrolls to bottom after command output layout has been quiet for 500ms", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		act(() => {
			vi.runOnlyPendingTimers()
		})
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.handleLastRowContentChange()
		})

		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(499)
		})
		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(scrollTo).toHaveBeenCalledWith({
			top: Number.MAX_SAFE_INTEGER,
			behavior: "smooth",
		})
	})

	it("resets the 500ms wait when another command output change arrives", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		act(() => {
			vi.runOnlyPendingTimers()
		})
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.handleLastRowContentChange()
			scrollTo.mockClear()
			vi.advanceTimersByTime(400)
			result.current.handleLastRowContentChange()
			scrollTo.mockClear()
			vi.advanceTimersByTime(499)
		})
		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(scrollTo).toHaveBeenCalledWith({
			top: Number.MAX_SAFE_INTEGER,
			behavior: "smooth",
		})
	})

	it("does not re-pin command output changes after auto-scroll is disabled", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.disableAutoScrollRef.current = true
			result.current.handleLastRowContentChange()
			vi.runAllTimers()
		})

		expect(scrollTo).not.toHaveBeenCalled()
	})

	it("disables auto-scroll when a user expands a row", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [commandMessage as any], {}, vi.fn()))

		act(() => {
			result.current.toggleRowExpansion(commandMessage.ts)
		})

		expect(result.current.disableAutoScrollRef.current).toBe(true)
	})

	it("keeps auto-scroll enabled when command output expands programmatically", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [commandMessage as any], {}, vi.fn()))

		act(() => {
			result.current.toggleRowExpansion(commandMessage.ts, { preserveAutoScroll: true })
		})

		expect(result.current.disableAutoScrollRef.current).toBe(false)
	})

	/**
	 * The overview rail is driven entirely by these two, so they are pinned here
	 * rather than only through the rail's own tests.
	 */
	describe("visible range and index jumps", () => {
		it("starts with no range, before Virtuoso reports one", () => {
			const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
			expect(result.current.visibleRange).toBeNull()
		})

		it("records the range Virtuoso reports", () => {
			const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))

			act(() => {
				result.current.handleRangeChanged({ startIndex: 12, endIndex: 30 })
			})

			expect(result.current.visibleRange).toEqual({ startIndex: 12, endIndex: 30 })
		})

		it("keeps the same object when the range is unchanged", () => {
			// Virtuoso re-fires rangeChanged while streaming; a new object identity
			// would re-render the rail on every chunk.
			const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))

			act(() => {
				result.current.handleRangeChanged({ startIndex: 3, endIndex: 9 })
			})
			const first = result.current.visibleRange
			act(() => {
				result.current.handleRangeChanged({ startIndex: 3, endIndex: 9 })
			})

			expect(result.current.visibleRange).toBe(first)
		})

		it("jumps to a row and detaches bottom pinning", () => {
			const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
			const scrollToIndex = vi.fn()
			;(result.current.virtuosoRef as MutableRefObject<{ scrollToIndex: typeof scrollToIndex } | null>).current = {
				scrollToIndex,
			}

			act(() => {
				result.current.scrollToGroupIndex(42)
			})

			expect(scrollToIndex).toHaveBeenCalledWith({ index: 42, align: "start", behavior: "smooth" })
			// Without this, the next streamed chunk would yank the user back down.
			expect(result.current.disableAutoScrollRef.current).toBe(true)
		})

		it("can jump without releasing bottom pinning", () => {
			// Programmatic jumps (for example following a quote) must not silently
			// stop the view tracking new output.
			const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
			const scrollToIndex = vi.fn()
			;(result.current.virtuosoRef as MutableRefObject<{ scrollToIndex: typeof scrollToIndex } | null>).current = {
				scrollToIndex,
			}

			act(() => {
				result.current.scrollToGroupIndex(7, { disableAutoScroll: false, align: "center" })
			})

			expect(scrollToIndex).toHaveBeenCalledWith({ index: 7, align: "center", behavior: "smooth" })
			expect(result.current.disableAutoScrollRef.current).toBe(false)
		})

		it("ignores a negative index", () => {
			const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
			const scrollToIndex = vi.fn()
			;(result.current.virtuosoRef as MutableRefObject<{ scrollToIndex: typeof scrollToIndex } | null>).current = {
				scrollToIndex,
			}

			act(() => {
				result.current.scrollToGroupIndex(-1)
			})

			expect(scrollToIndex).not.toHaveBeenCalled()
		})
	})
})
