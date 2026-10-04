import type { ClineMessage } from "@shared/ExtensionMessage"
import type React from "react"
import { memo, useCallback, useMemo, useRef } from "react"
import BrowserSessionRow from "@/components/chat/BrowserSessionRow"
import ChatRow from "@/components/chat/ChatRow"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { useMessageRowContext } from "../../context/MessageRowContext"
import { findReasoningForApiReq, isTextMessagePendingToolCall, isToolGroup } from "../../utils/messageUtils"
import { ToolGroupRenderer } from "./ToolGroupRenderer"

interface MessageRendererProps {
	index: number
	isLast: boolean
	messageOrGroup: ClineMessage | ClineMessage[]
}

/**
 * Specialized component for rendering different message types.
 * Reads derived state (modifiedMessages, groupedMessages, expandedRows, etc.)
 * from MessageRowContext instead of receiving them as props.
 *
 * This is critical for Virtuoso performance: by not passing modifiedMessages
 * or groupedMessages through the itemContent closure, the itemContent function
 * reference stays stable during streaming, allowing Virtuoso to reuse its
 * internal DOM cache instead of remounting every row.
 */
const MessageRendererInner: React.FC<MessageRendererProps> = ({ index, isLast, messageOrGroup }) => {
	const { mode } = useExtensionState()
	const {
		modifiedMessages,
		groupedMessages,
		expandedRows,
		onToggleExpand,
		onHeightChange,
		onLastRowContentChange,
		onSetQuote,
		inputValue,
		messageHandlers,
		footerActive,
	} = useMessageRowContext()

	// Stable identity for ChatRow's `onCancelCommand`.
	//
	// ChatRow is memoized with `fast-deep-equal`, which compares functions by
	// reference. An inline arrow here is a new function on every MessageRenderer
	// render, so the deepEqual ALWAYS reported "changed" and ChatRow re-rendered for
	// every visible row on every streaming chunk — the memo was dead code. Reading
	// messageHandlers through a ref keeps the closure stable while still calling the
	// latest handler.
	const messageHandlersRef = useRef(messageHandlers)
	messageHandlersRef.current = messageHandlers
	const onCancelCommand = useCallback(() => {
		messageHandlersRef.current.executeButtonAction("cancel")
	}, [])

	// Get reasoning content and response status for api_req_started messages
	const reasoningData = useMemo(() => {
		if (!Array.isArray(messageOrGroup) && messageOrGroup.say === "api_req_started") {
			return findReasoningForApiReq(messageOrGroup.ts, modifiedMessages)
		}
		return { reasoning: undefined, responseStarted: false }
	}, [messageOrGroup, modifiedMessages])

	// Check if a text message is waiting for tool call completion
	const isRequestInProgress = useMemo(() => {
		if (!Array.isArray(messageOrGroup) && messageOrGroup.say === "text") {
			return isTextMessagePendingToolCall(messageOrGroup.ts, modifiedMessages)
		}
		return false
	}, [messageOrGroup, modifiedMessages])

	// Tool group (low-stakes tools grouped together)
	// Determine if this is the last tool group to show active items
	const isLastToolGroup = useMemo(() => {
		if (!isToolGroup(messageOrGroup)) {
			return false
		}
		// Find the last tool group in groupedMessages
		for (let i = groupedMessages.length - 1; i >= 0; i--) {
			if (isToolGroup(groupedMessages[i])) {
				return i === index
			}
		}
		return false
	}, [messageOrGroup, groupedMessages, index])

	if (isToolGroup(messageOrGroup)) {
		return <ToolGroupRenderer allMessages={modifiedMessages} isLastGroup={isLastToolGroup} messages={messageOrGroup} />
	}

	// Browser session group
	if (Array.isArray(messageOrGroup)) {
		return (
			<BrowserSessionRow
				expandedRows={expandedRows}
				isLast={isLast}
				key={messageOrGroup[0]?.ts}
				lastModifiedMessage={modifiedMessages.at(-1)}
				messages={messageOrGroup}
				onHeightChange={onHeightChange}
				onSetQuote={onSetQuote}
				onToggleExpand={onToggleExpand}
			/>
		)
	}

	// Regular message
	return (
		<div
			className={cn({
				"pb-2.5": isLast && !footerActive,
			})}
			data-message-ts={messageOrGroup.ts}>
			<ChatRow
				inputValue={inputValue}
				isExpanded={expandedRows[messageOrGroup.ts] || false}
				isLast={isLast}
				isRequestInProgress={isRequestInProgress}
				key={messageOrGroup.ts}
				lastModifiedMessage={modifiedMessages.at(-1)}
				message={messageOrGroup}
				mode={mode}
				onCancelCommand={onCancelCommand}
				onHeightChange={onHeightChange}
				onLastRowContentChange={onLastRowContentChange}
				onSetQuote={onSetQuote}
				onToggleExpand={onToggleExpand}
				reasoningContent={reasoningData.reasoning}
				responseStarted={reasoningData.responseStarted}
				sendMessageFromChatRow={messageHandlers.handleSendMessage}
			/>
		</div>
	)
}

/**
 * Memoized so a re-render of the list owner (a scroll tick, an expanded-row toggle,
 * an `inputValue` change) does not re-render every mounted row. It does NOT stop a
 * re-render when MessageRowContext itself changed — context propagation reaches
 * consumers regardless of memo — which is correct, because those rows did change.
 */
export const MessageRenderer = memo(MessageRendererInner)
