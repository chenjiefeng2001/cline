import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { HistoryOverviewRail, OVERVIEW_MIN_THUMB_PCT } from "./HistoryOverviewRail"

/**
 * The rail exists because the message list hides its native scrollbar, so these
 * tests care about two things a pixel scrollbar would get for free: that the
 * thumb tracks the *virtualized* viewport (index fractions, not pixel heights),
 * and that jumping from the rail detaches bottom pinning upstream.
 */

/** The rail measures the track with getBoundingClientRect, which jsdom zeroes. */
function stubTrackHeight(element: HTMLElement, height: number, top = 0): void {
	element.getBoundingClientRect = () =>
		({ top, bottom: top + height, left: 0, right: 10, width: 10, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
}

function renderRail(props: Partial<React.ComponentProps<typeof HistoryOverviewRail>> = {}) {
	const onJumpToIndex = vi.fn()
	const utils = render(
		<HistoryOverviewRail
			hasOlderHistory={false}
			onJumpToIndex={onJumpToIndex}
			totalCount={100}
			turnIndices={[]}
			visibleEndIndex={9}
			visibleStartIndex={0}
			{...props}
		/>,
	)
	return { ...utils, onJumpToIndex }
}

function thumb(container: HTMLElement): HTMLElement {
	const thumb = container.querySelector("[role='scrollbar'] > div:last-of-type") as HTMLElement
	if (!thumb) {
		throw new Error("thumb not found")
	}
	return thumb
}

describe("HistoryOverviewRail", () => {
	it("positions and sizes the thumb from the visible row range", () => {
		// Rows 20-29 of 100: the thumb belongs in the top fifth, a tenth tall.
		const { container } = renderRail({ visibleStartIndex: 20, visibleEndIndex: 29 })
		expect(thumb(container).style.top).toBe("20%")
		expect(thumb(container).style.height).toBe("10%")
	})

	it("never shrinks the thumb below a grabbable size", () => {
		// Ten visible rows out of 100000 is a sliver; an ungrabbable thumb is worse
		// than a slightly imprecise one.
		const { container } = renderRail({
			totalCount: 100000,
			visibleStartIndex: 50_000,
			visibleEndIndex: 50_009,
		})
		expect(parseFloat(thumb(container).style.height)).toBe(OVERVIEW_MIN_THUMB_PCT)
	})

	it("renders nothing when every row already fits", () => {
		// A full-height thumb would be a decoration that looks broken.
		const { container } = renderRail({ totalCount: 5, visibleStartIndex: 0, visibleEndIndex: 4 })
		expect(container).toBeEmptyDOMElement()
	})

	it("renders nothing when there are no rows", () => {
		const { container } = renderRail({ totalCount: 0, visibleStartIndex: 0, visibleEndIndex: 0 })
		expect(container).toBeEmptyDOMElement()
	})

	it("maps a click on the track to the row at that position", () => {
		const { onJumpToIndex } = renderRail()
		const rail = screen.getByRole("scrollbar")
		stubTrackHeight(rail, 200)

		// Halfway down a 100-row track is row 50.
		firePointer(rail, 100)
		expect(onJumpToIndex).toHaveBeenCalledWith(50)
	})

	it("clamps a click past the ends of the track", () => {
		const { onJumpToIndex } = renderRail()
		const rail = screen.getByRole("scrollbar")
		stubTrackHeight(rail, 200)

		firePointer(rail, -50)
		expect(onJumpToIndex).toHaveBeenLastCalledWith(0)
		firePointer(rail, 9999)
		expect(onJumpToIndex).toHaveBeenLastCalledWith(99)
	})

	it("keeps following the pointer while dragging", () => {
		const { onJumpToIndex } = renderRail()
		const rail = screen.getByRole("scrollbar")
		stubTrackHeight(rail, 200)

		firePointer(rail, 20)
		onJumpToIndex.mockClear()
		firePointer(rail, 180, { pointerId: 1, buttons: 1, type: "pointerMove" })
		expect(onJumpToIndex).toHaveBeenCalledWith(89)
	})

	it("ignores moves that are not part of a drag", () => {
		// Without a preceding pointerdown, a move is just the mouse passing over the
		// rail; jumping there would hijack the scroll position.
		const { onJumpToIndex } = renderRail()
		const rail = screen.getByRole("scrollbar")
		stubTrackHeight(rail, 200)

		firePointer(rail, 180, { pointerId: 1, type: "pointerMove", buttons: 0 })
		expect(onJumpToIndex).not.toHaveBeenCalled()
	})

	it("ignores non-primary buttons", () => {
		const { onJumpToIndex } = renderRail()
		const rail = screen.getByRole("scrollbar")
		stubTrackHeight(rail, 200)

		firePointer(rail, 100, { button: 2 })
		expect(onJumpToIndex).not.toHaveBeenCalled()
	})

	it("exposes the viewport to assistive tech as a scrollbar", () => {
		renderRail({ visibleStartIndex: 20, visibleEndIndex: 29 })
		const rail = screen.getByRole("scrollbar")
		expect(rail).toHaveAttribute("aria-valuenow", "20")
		expect(rail).toHaveAttribute("aria-valuemin", "0")
		expect(rail).toHaveAttribute("aria-valuemax", "99")
		expect(rail).toHaveAttribute("aria-valuetext", expect.stringContaining("21 of 100"))
	})

	it("mentions unloaded older messages instead of implying full coverage", () => {
		renderRail({ hasOlderHistory: true })
		expect(screen.getByRole("scrollbar")).toHaveAttribute("aria-valuetext", expect.stringContaining("not yet loaded"))
	})

	it("marks one tick per user turn", () => {
		const { container } = renderRail({ turnIndices: [0, 40, 99] })
		const markers = container.querySelectorAll("[aria-hidden='true'] > div")
		expect(markers).toHaveLength(3)
		expect((markers[1] as HTMLElement).style.top).toBe("40%")
	})

	it("supports keyboard navigation", () => {
		const { onJumpToIndex } = renderRail({ visibleStartIndex: 20, visibleEndIndex: 29 })
		const rail = screen.getByRole("scrollbar")

		fireKey(rail, "PageDown")
		expect(onJumpToIndex).toHaveBeenLastCalledWith(30)
		fireKey(rail, "PageUp")
		expect(onJumpToIndex).toHaveBeenLastCalledWith(10)
		fireKey(rail, "Home")
		expect(onJumpToIndex).toHaveBeenLastCalledWith(0)
		fireKey(rail, "End")
		expect(onJumpToIndex).toHaveBeenLastCalledWith(99)
		fireKey(rail, "ArrowDown")
		expect(onJumpToIndex).toHaveBeenLastCalledWith(30)
		fireKey(rail, "ArrowUp")
		expect(onJumpToIndex).toHaveBeenLastCalledWith(19)
	})

	it("does not move past the ends from the keyboard", () => {
		const { onJumpToIndex } = renderRail({ visibleStartIndex: 0, visibleEndIndex: 5 })
		const rail = screen.getByRole("scrollbar")

		fireKey(rail, "PageUp")
		expect(onJumpToIndex).toHaveBeenLastCalledWith(0)
	})

	it("leaves unrelated keys alone", () => {
		const { onJumpToIndex } = renderRail()
		fireKey(screen.getByRole("scrollbar"), "a")
		expect(onJumpToIndex).not.toHaveBeenCalled()
	})
})

/** `fireEvent` builds a real event and lets React dispatch it, which sets
 *  `currentTarget` for us; a hand-rolled Event cannot. */
function firePointer(
	element: HTMLElement,
	clientY: number,
	init: { pointerId?: number; type?: "pointerDown" | "pointerMove" | "pointerUp"; buttons?: number; button?: number } = {},
): void {
	const { pointerId = 1, type = "pointerDown", buttons = 1, button = 0 } = init
	fireEvent[type](element, { clientY, pointerId, buttons, button })
}

function fireKey(element: HTMLElement, key: string): void {
	fireEvent.keyDown(element, { key })
}
