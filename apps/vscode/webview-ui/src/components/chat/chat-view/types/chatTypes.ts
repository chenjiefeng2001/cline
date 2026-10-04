/**
 * Shared types and interfaces for the chat view components
 */

import { ClineAsk, ClineMessage } from "@shared/ExtensionMessage"
import { ListRange, VirtuosoHandle } from "react-virtuoso"
import { ButtonActionType } from "../shared/buttonConfig"

export interface PendingUserMessage {
	message: ClineMessage
	afterTs: number
}

/**
 * Chat state interface
 */
export interface ChatState {
	// State values
	inputValue: string
	setInputValue: React.Dispatch<React.SetStateAction<string>>
	activeQuote: string | null
	setActiveQuote: React.Dispatch<React.SetStateAction<string | null>>
	isTextAreaFocused: boolean
	setIsTextAreaFocused: React.Dispatch<React.SetStateAction<boolean>>
	selectedImages: string[]
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
	selectedFiles: string[]
	setSelectedFiles: React.Dispatch<React.SetStateAction<string[]>>
	sendingDisabled: boolean
	setSendingDisabled: React.Dispatch<React.SetStateAction<boolean>>
	enableButtons: boolean
	setEnableButtons: React.Dispatch<React.SetStateAction<boolean>>
	primaryButtonText: string | undefined
	setPrimaryButtonText: React.Dispatch<React.SetStateAction<string | undefined>>
	secondaryButtonText: string | undefined
	setSecondaryButtonText: React.Dispatch<React.SetStateAction<string | undefined>>
	expandedRows: Record<number, boolean>
	setExpandedRows: React.Dispatch<React.SetStateAction<Record<number, boolean>>>
	pendingUserMessage: PendingUserMessage | undefined
	setPendingUserMessage: React.Dispatch<React.SetStateAction<PendingUserMessage | undefined>>

	// Refs
	textAreaRef: React.RefObject<HTMLTextAreaElement>

	// Derived values
	lastMessage: ClineMessage | undefined
	secondLastMessage: ClineMessage | undefined
	clineAsk: ClineAsk | undefined
	task: ClineMessage | undefined

	// Handlers
	handleFocusChange: (isFocused: boolean) => void
	clearExpandedRows: () => void
	resetState: () => void

	// Scroll-related state (will be moved to scroll hook)
	isAtBottom?: boolean
	pendingScrollToMessage?: number | null
}

/**
 * How a submitted prompt should be delivered while a turn is in flight.
 * - "queue": wait behind the running turn (plain Enter)
 * - "steer": hard-interrupt the turn and send immediately (Ctrl/Cmd+Enter)
 */
export type MessageDelivery = "queue" | "steer"

/**
 * Message handlers interface
 */
export interface MessageHandlers {
	executeButtonAction: (action: ButtonActionType, text?: string, images?: string[], files?: string[]) => Promise<void>
	handleSendMessage: (text: string, images: string[], files: string[], delivery?: MessageDelivery) => Promise<void>
	handleTaskCloseButtonClick: () => void
	startNewTask: () => Promise<void>
}

/**
 * Scroll behavior interface
 */
export interface ScrollBehavior {
	virtuosoRef: React.RefObject<VirtuosoHandle>
	scrollContainerRef: React.RefObject<HTMLDivElement>
	disableAutoScrollRef: React.MutableRefObject<boolean>
	scrollToBottomSmooth: () => void
	scrollToBottomAuto: () => void
	scrollToMessage: (messageIndex: number) => void
	toggleRowExpansion: (ts: number, options?: { preserveAutoScroll?: boolean }) => void
	handleRowHeightChange: (isTaller: boolean) => void
	handleLastRowContentChange: () => void
	isAtBottom: boolean
	setIsAtBottom: React.Dispatch<React.SetStateAction<boolean>>
	pendingScrollToMessage: number | null
	setPendingScrollToMessage: React.Dispatch<React.SetStateAction<number | null>>
	scrolledPastUserMessage: ClineMessage | null
	handleRangeChanged: (range: ListRange) => void
	/**
	 * Rows currently rendered, or null until Virtuoso reports its first range.
	 *
	 * The only exact measure of viewport position in a virtualized list: the pixel
	 * height of rows that are not mounted is unknowable, but the index range is not.
	 */
	visibleRange: ListRange | null
	/**
	 * Scroll to a row index in `groupedMessages`.
	 *
	 * Detaches bottom pinning by default, so a jump made while the agent is
	 * streaming is not undone by the next chunk; pinning re-engages on reaching
	 * the bottom.
	 */
	scrollToGroupIndex: (
		groupIndex: number,
		options?: {
			align?: "start" | "center" | "end"
			behavior?: "smooth" | "auto"
			/** Set false to move without releasing bottom pinning. */
			disableAutoScroll?: boolean
		},
	) => void
}

/**
 * Welcome section props
 */
export interface WelcomeSectionProps {
	showAnnouncement: boolean
	hideAnnouncement: () => void
	showHistoryView: () => void
	telemetrySetting: string
	version: string
	taskHistory: any[]
	shouldShowQuickWins: boolean
}
