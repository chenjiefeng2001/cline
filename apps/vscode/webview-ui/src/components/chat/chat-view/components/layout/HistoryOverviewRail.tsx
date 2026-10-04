import type React from "react"
import { useCallback, useRef } from "react"
import { cn } from "@/lib/utils"

/**
 * Geometry shared with the tests. Percent-based rather than pixel-based because a
 * virtualized list cannot report the height of rows it has never mounted; index
 * fractions are exact and cheap.
 */
export const OVERVIEW_MIN_THUMB_PCT = 6

export interface HistoryOverviewRailProps {
	/** Number of rows currently loaded. */
	totalCount: number
	/** Index of the first visible row. */
	visibleStartIndex: number
	/** Index of the last visible row. */
	visibleEndIndex: number
	/** Ascending row indices where a user message begins a new turn. */
	turnIndices: number[]
	/**
	 * Older messages exist but are not loaded yet.
	 *
	 * The rail must say so rather than implying the loaded window is the whole
	 * history, otherwise it silently overstates how much of the conversation is
	 * reachable by dragging.
	 */
	hasOlderHistory: boolean
	onJumpToIndex: (index: number) => void
	className?: string
}

/**
 * An overview of the whole message history for one task.
 *
 * The list's own scrollbar is hidden (`scrollbarWidth: none` in MessagesArea), so
 * in a long session there is no indication of where you are and no way to move
 * through the history other than the sticky "back to latest prompt" header. This
 * rail fills that gap, and adds the thing a bare scrollbar cannot do: a tick per
 * user turn, so a 600-message session is navigable by prompt rather than by pixel.
 */
export const HistoryOverviewRail: React.FC<HistoryOverviewRailProps> = ({
	totalCount,
	visibleStartIndex,
	visibleEndIndex,
	turnIndices,
	hasOlderHistory,
	onJumpToIndex,
	className,
}) => {
	const trackRef = useRef<HTMLDivElement>(null)
	const draggingRef = useRef(false)

	const visibleCount = Math.max(0, visibleEndIndex - visibleStartIndex + 1)
	// Nothing to navigate when everything fits, or when there is nothing yet.
	const isHidden = totalCount <= 0 || visibleCount >= totalCount

	const startPct = totalCount > 0 ? (visibleStartIndex / totalCount) * 100 : 0
	const heightPct = totalCount > 0 ? Math.max(OVERVIEW_MIN_THUMB_PCT, (visibleCount / totalCount) * 100) : 0

	/** Map a pointer position on the track to a row index. */
	const indexFromPointer = useCallback(
		(clientY: number): number => {
			const track = trackRef.current
			if (!track || totalCount <= 0) {
				return 0
			}
			const rect = track.getBoundingClientRect()
			if (rect.height <= 0) {
				return 0
			}
			const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
			return Math.min(totalCount - 1, Math.round(ratio * (totalCount - 1)))
		},
		[totalCount],
	)

	const handlePointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (event.button !== 0 || totalCount <= 0) {
				return
			}
			event.preventDefault()
			draggingRef.current = true
			event.currentTarget.setPointerCapture?.(event.pointerId)
			onJumpToIndex(indexFromPointer(event.clientY))
		},
		[indexFromPointer, onJumpToIndex, totalCount],
	)

	const handlePointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (!draggingRef.current) {
				return
			}
			// Continuous while dragging; the jump is index-based so it stays stable
			// regardless of how tall the rows above actually are.
			onJumpToIndex(indexFromPointer(event.clientY))
		},
		[indexFromPointer, onJumpToIndex],
	)

	const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		draggingRef.current = false
		event.currentTarget.releasePointerCapture?.(event.pointerId)
	}, [])

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			const jump = (index: number) => {
				event.preventDefault()
				onJumpToIndex(Math.min(totalCount - 1, Math.max(0, index)))
			}
			switch (event.key) {
				case "ArrowDown":
					jump(visibleEndIndex + 1)
					break
				case "ArrowUp":
					jump(visibleStartIndex - 1)
					break
				case "PageDown":
					jump(visibleStartIndex + visibleCount)
					break
				case "PageUp":
					jump(visibleStartIndex - visibleCount)
					break
				case "Home":
					jump(0)
					break
				case "End":
					jump(totalCount - 1)
					break
				default:
					break
			}
		},
		[onJumpToIndex, totalCount, visibleEndIndex, visibleStartIndex, visibleCount],
	)

	if (isHidden) {
		return null
	}

	return (
		<div
			aria-label="Message history overview"
			aria-valuemax={totalCount - 1}
			aria-valuemin={0}
			aria-valuenow={visibleStartIndex}
			aria-valuetext={`Row ${visibleStartIndex + 1} of ${totalCount}${hasOlderHistory ? " (older messages not yet loaded)" : ""}`}
			className={cn(
				"group absolute inset-y-0 right-0 z-20 flex w-3 items-stretch justify-center",
				"opacity-60 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
				className,
			)}
			onKeyDown={handleKeyDown}
			onPointerCancel={endDrag}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={endDrag}
			ref={trackRef}
			role="scrollbar"
			tabIndex={0}>
			{/* Track. Intentionally invisible: the thumb is the affordance, and a
			    visible groove would compete with the message list it overlays. */}
			<div className="absolute inset-x-1 inset-y-0 rounded-full" />

			{/*
			 * Turn markers are decorative on purpose.

			 * A `scrollbar` role takes no focusable children, so making these
			 * buttons would nest interactive content inside a widget whose keyboard
			 * contract is the rail itself. They also do not need their own hit
			 * targets: every marker sits at its row's exact position, so dragging
			 * or clicking there already lands on that row.
			 */}
			<div aria-hidden="true" className="pointer-events-none absolute inset-0">
				{turnIndices.map((index) => (
					<div
						className="absolute inset-x-0 h-px -translate-y-1/2 bg-description/40"
						key={index}
						style={{ top: `${(index / totalCount) * 100}%` }}
					/>
				))}
			</div>

			{/*
			 * Older history is loaded lazily as the top edge is reached, so the rail
			 * would otherwise claim to cover the whole conversation. The cap says the
			 * loaded window starts partway through.
			 */}
			{hasOlderHistory ? (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0.5 top-0 h-2 rounded-t-full border-t-2 border-dashed border-description/50"
				/>
			) : null}

			<div
				className={cn("absolute inset-x-0.5 rounded-full bg-description/50", "group-hover:bg-description/70")}
				style={{ height: `${heightPct}%`, top: `${startPct}%` }}
			/>
		</div>
	)
}

export default HistoryOverviewRail
