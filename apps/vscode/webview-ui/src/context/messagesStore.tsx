/**
 * External store for the conversation transcript (high-frequency state).
 *
 * ## Why this is not React state
 *
 * The transcript changes on every streaming delta / partial message — dozens of
 * times per second during a turn. It used to live in `useState` inside
 * `ExtensionStateContextProvider`, which made the provider itself re-render on
 * every chunk. The provider builds its `ExtensionStateContext` value as an object
 * literal, so every chunk produced a new context identity and re-rendered all
 * ~240 `useExtensionState()` consumers (111 files), plus every visible message
 * row. Per-frame cost was O(N + k*N + G*N) in the number of messages, so a
 * handful of conversation rounds was enough to saturate the webview main thread
 * and the panel stopped refreshing.
 *
 * Moving the transcript here means the provider never re-renders for message
 * traffic: `MessagesStateProvider` (below) is a separate component that
 * subscribes via `useSyncExternalStore`, and because the outer provider keeps
 * passing the identical `children` element, React bails out of the subtree
 * except for the `MessagesStateContext` consumers.
 */

import type { ClineMessage, TurnState } from "@shared/ExtensionMessage"
import { LoadHistoryBatchRequest } from "@shared/proto/cline/task"
import { convertProtoToClineMessage } from "@shared/proto-conversions/cline-message"
import React, { createContext, useContext, useMemo, useSyncExternalStore } from "react"
import {
	createReplicaState,
	type ReplicaState,
	applyBatchPrepend as reducerApplyBatchPrepend,
} from "../components/chat/chat-view/messageReducer"
import { TaskServiceClient } from "../services/grpc-client"
import { createFrameCoalescer, type FrameCoalescer, scheduleAnimationFrame } from "../utils/messageFrameScheduler"

/**
 * High-frequency message state, decoupled from the low-frequency
 * ExtensionStateContext (V12 方案3 — fine-grained subscription).
 *
 * Streaming deltas, partial messages and transcript snapshots only update this
 * context, so settings/theme changes no longer re-render the message list and,
 * symmetrically, message updates no longer re-render settings/theme consumers.
 */
export interface MessagesState {
	clineMessages: ClineMessage[]
	turnState?: TurnState
	messageTruncated?: boolean
	totalMessageCount?: number
	/** Conversation/replica fence (see messageReducer.ts). */
	epoch: number
	/** Highest state snapshot version applied. */
	stateVersion: number
	/** True while older messages may still be loaded via loadHistoryBatch. */
	hasMoreMessages: boolean
	loadHistoryBatch: (taskId: string, beforeTs: number) => Promise<void>
}

const MessagesStateContext = createContext<MessagesState | undefined>(undefined)

/** The immutable object handed to `useSyncExternalStore`. It is rebuilt only when
 * one of its fields actually changes by reference/value, which is what keeps
 * `getSnapshot` stable — `useSyncExternalStore` throws on a snapshot that
 * changes identity on every call.
 */
export interface MessagesSnapshot {
	clineMessages: ClineMessage[]
	turnState?: TurnState
	messageTruncated?: boolean
	totalMessageCount?: number
	epoch: number
	stateVersion: number
	hasMoreMessages: boolean
}

const EMPTY_SNAPSHOT: MessagesSnapshot = {
	clineMessages: [],
	turnState: undefined,
	messageTruncated: undefined,
	totalMessageCount: undefined,
	epoch: 0,
	stateVersion: 0,
	hasMoreMessages: true,
}

let replica: ReplicaState = createReplicaState()
let hasMoreMessages = true
let snapshot: MessagesSnapshot = EMPTY_SNAPSHOT

const listeners = new Set<() => void>()

/** The authoritative transcript. Mutate only by replacing it (the reducer is pure). */
export function getReplica(): ReplicaState {
	return replica
}

export function setReplica(next: ReplicaState): void {
	replica = next
}

function buildSnapshot(): MessagesSnapshot {
	return {
		clineMessages: replica.messages,
		turnState: replica.turnState,
		messageTruncated: replica.messageTruncated,
		totalMessageCount: replica.totalMessageCount,
		epoch: replica.epoch,
		stateVersion: replica.stateVersion,
		hasMoreMessages,
	}
}

function snapshotChanged(next: MessagesSnapshot): boolean {
	return (
		next.clineMessages !== snapshot.clineMessages ||
		next.turnState !== snapshot.turnState ||
		next.epoch !== snapshot.epoch ||
		next.stateVersion !== snapshot.stateVersion ||
		next.messageTruncated !== snapshot.messageTruncated ||
		next.totalMessageCount !== snapshot.totalMessageCount ||
		next.hasMoreMessages !== snapshot.hasMoreMessages
	)
}

function flushSnapshot(): void {
	const next = buildSnapshot()
	// Reference comparison: the reducer returns the same object for a no-op merge,
	// so an unchanged transcript produces no store emission and no React render.
	if (!snapshotChanged(next)) {
		return
	}
	snapshot = next
	for (const listener of Array.from(listeners)) {
		listener()
	}
}

let coalescer: FrameCoalescer | null = null

/**
 * Schedule a frame-coalesced publish of the transcript. Deltas/partials/snapshots
 * arriving within a single animation frame are merged into ONE store emission, so
 * streaming bursts do not render intermediate frames.
 */
export function publishReplica(): void {
	if (!coalescer) {
		coalescer = createFrameCoalescer(flushSnapshot, scheduleAnimationFrame)
	}
	coalescer.schedule()
}

/**
 * The `useSyncExternalStore` contract for the transcript store. Exported so the store
 * can be observed directly (tests, and any future non-React consumer).
 *
 * `getMessagesSnapshot` MUST return a stable reference between changes — React throws
 * on a snapshot that changes identity on every call.
 */
export function subscribeMessages(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange)
	return () => {
		listeners.delete(onStoreChange)
	}
}

export function getMessagesSnapshot(): MessagesSnapshot {
	return snapshot
}

/** True while older messages may still be loaded via loadHistoryBatch. */
export function getHasMoreMessages(): boolean {
	return hasMoreMessages
}

export function setHasMoreMessages(value: boolean): void {
	if (hasMoreMessages === value) {
		return
	}
	hasMoreMessages = value
	publishReplica()
}

/**
 * Drop the transcript and cancel any pending frame-coalesced flush. Called when
 * the provider unmounts so a later mount starts from a clean slate (and so a
 * scheduled flush cannot fire into a torn-down tree).
 */
export function resetMessagesStore(): void {
	coalescer?.cancel()
	coalescer = null
	replica = createReplicaState()
	hasMoreMessages = true
	snapshot = EMPTY_SNAPSHOT
}

/**
 * Persist ReplicaState to sessionStorage for recovery on webview re-creation.
 * This helps maintain conversation state when VS Code recycles the webview.
 */
export function persistReplicaState(): void {
	try {
		const stateToPersist = {
			messages: replica.messages.slice(-100), // Keep last 100 messages
			epoch: replica.epoch,
			stateVersion: replica.stateVersion,
			turnState: replica.turnState,
			messageTruncated: replica.messageTruncated,
			totalMessageCount: replica.totalMessageCount,
			timestamp: Date.now(),
		}
		sessionStorage.setItem("cline_replica_state", JSON.stringify(stateToPersist))
	} catch (error) {
		console.warn("[ExtensionState] Failed to persist replica state:", error)
	}
}

/**
 * Restore ReplicaState from sessionStorage if available and recent.
 * Returns true when state was restored, false otherwise.
 */
export function restoreReplicaState(): boolean {
	try {
		const saved = sessionStorage.getItem("cline_replica_state")
		if (!saved) return false

		const parsed = JSON.parse(saved)
		const age = Date.now() - (parsed.timestamp || 0)

		// Only restore if less than 5 minutes old
		if (age > 5 * 60 * 1000) {
			sessionStorage.removeItem("cline_replica_state")
			return false
		}

		replica = {
			...replica,
			messages: parsed.messages || [],
			epoch: parsed.epoch || 0,
			stateVersion: parsed.stateVersion || 0,
			turnState: parsed.turnState,
			messageTruncated: parsed.messageTruncated,
			totalMessageCount: parsed.totalMessageCount,
		}

		console.log(`[ExtensionState] Restored replica state: ${parsed.messages?.length || 0} messages, epoch=${parsed.epoch}`)
		return true
	} catch (error) {
		console.warn("[ExtensionState] Failed to restore replica state:", error)
		sessionStorage.removeItem("cline_replica_state")
		return false
	}
}

/**
 * Load a batch of older messages when scrolling up past the truncation window.
 * Calls the backend's loadHistoryBatch RPC and prepends the batch to the
 * message replica via reducerApplyBatchPrepend.
 */
export async function loadHistoryBatch(taskId: string, beforeTs: number): Promise<void> {
	if (!taskId || taskId === "") {
		console.warn("[loadHistoryBatch] No taskId provided, skipping")
		return
	}
	try {
		const response = await TaskServiceClient.loadHistoryBatch(
			LoadHistoryBatchRequest.create({
				taskId,
				beforeTs,
				limit: 50,
			}),
		)
		if (!response.messages || response.messages.length === 0) {
			// No more messages available
			setHasMoreMessages(false)
			return
		}

		// Convert protobuf messages to ClineMessage[]
		const incoming = response.messages.map(convertProtoToClineMessage).filter(Boolean) as ClineMessage[]

		// Apply batch prepend to the replica
		setReplica(reducerApplyBatchPrepend(replica, incoming, undefined, response.totalCount))

		// Publish the merged transcript + pagination metadata
		publishReplica()

		// Update hasMore flag from response
		if (response.hasMore !== undefined) {
			setHasMoreMessages(response.hasMore)
		}
	} catch (error) {
		console.error("[loadHistoryBatch] Error loading history batch:", error)
	}
}

/**
 * Provides `MessagesStateContext` from the external store.
 *
 * Rendered as a child of `ExtensionStateContextProvider` so that the provider
 * itself never re-renders for message traffic. Because the outer provider passes
 * the same `children` element on every render, React bails out of this subtree
 * when the store is idle and only re-renders the components that actually read
 * `MessagesStateContext`.
 */
export const MessagesStateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const current = useSyncExternalStore(subscribeMessages, getMessagesSnapshot)
	const value = useMemo<MessagesState>(
		() => ({
			clineMessages: current.clineMessages,
			turnState: current.turnState,
			messageTruncated: current.messageTruncated,
			totalMessageCount: current.totalMessageCount,
			epoch: current.epoch,
			stateVersion: current.stateVersion,
			hasMoreMessages: current.hasMoreMessages,
			loadHistoryBatch,
		}),
		[current],
	)

	return <MessagesStateContext.Provider value={value}>{children}</MessagesStateContext.Provider>
}

export function useMessagesState(): MessagesState {
	const context = useContext(MessagesStateContext)
	if (context === undefined) {
		throw new Error("useMessagesState must be used within an ExtensionStateContextProvider")
	}
	return context
}
