import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { State } from "@shared/proto/cline/state"
import { telemetryService } from "@/services/telemetry"
import { ExtensionState } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

/**
 * Maximum size (in bytes) for state JSON before truncation is applied.
 * 800KB threshold provides safety margin below the 1MB IPC limit.
 */
const STATE_SIZE_WARNING_THRESHOLD = 800 * 1024
const STATE_SIZE_HARD_LIMIT = 1024 * 1024

/**
 * Maximum number of messages to include in truncated state.
 * This ensures the most recent messages are preserved while reducing payload size.
 */
const MAX_MESSAGES_IN_TRUNCATED_STATE = 100

/**
 * Aggressive truncation limit: when the state STILL exceeds the hard limit
 * after the first truncation pass, reduce to this many messages.
 */
const AGGRESSIVE_MAX_MESSAGES = 20

/**
 * Instance-level subscription manager for state updates.
 * Replaces the global Set with per-instance tracking to prevent
 * subscription leaks and improve cleanup reliability.
 */
class StateSubscriptionManager {
	private static instance: StateSubscriptionManager | null = null
	private subscriptions: Map<string, StreamingResponseHandler<State>> = new Map()
	private subscriptionCounter = 0

	static getInstance(): StateSubscriptionManager {
		if (!StateSubscriptionManager.instance) {
			StateSubscriptionManager.instance = new StateSubscriptionManager()
		}
		return StateSubscriptionManager.instance
	}

	/**
	 * Register a new state subscription with a unique ID.
	 * Returns the subscription ID for later cleanup.
	 */
	register(responseStream: StreamingResponseHandler<State>): string {
		const subscriptionId = `state_sub_${++this.subscriptionCounter}_${Date.now()}`
		this.subscriptions.set(subscriptionId, responseStream)

		Logger.debug(`[StateSubscriptionManager] Registered subscription: ${subscriptionId}`)
		return subscriptionId
	}

	/**
	 * Unregister a state subscription by ID.
	 */
	unregister(subscriptionId: string): void {
		if (this.subscriptions.delete(subscriptionId)) {
			Logger.debug(`[StateSubscriptionManager] Unregistered subscription: ${subscriptionId}`)
		}
	}

	/**
	 * Get all active subscriptions.
	 */
	getActiveSubscriptions(): StreamingResponseHandler<State>[] {
		return Array.from(this.subscriptions.values())
	}

	/**
	 * Get the number of active subscriptions.
	 */
	getSubscriptionCount(): number {
		return this.subscriptions.size
	}

	/**
	 * Clean up all subscriptions (called on extension deactivation).
	 */
	disposeAll(): void {
		const count = this.subscriptions.size
		this.subscriptions.clear()
		if (count > 0) {
			Logger.log(`[StateSubscriptionManager] Cleared ${count} subscriptions`)
		}
	}
}

// Export singleton instance
export const stateSubscriptionManager = StateSubscriptionManager.getInstance()

/**
 * Truncate state to fit within IPC limits by reducing message history.
 * This preserves the most recent messages while discarding older ones.
 *
 * @param state The original extension state
 * @param maxMessages Maximum messages to keep (default: MAX_MESSAGES_IN_TRUNCATED_STATE)
 * @returns Truncated state with reduced message history
 */
function truncateStateForIpc(state: ExtensionState, maxMessages?: number): ExtensionState {
	const limit = maxMessages ?? MAX_MESSAGES_IN_TRUNCATED_STATE
	// If no messages or already within limits, return as-is
	if (!state.clineMessages || state.clineMessages.length <= limit) {
		return state
	}

	Logger.warn(`[subscribeToState] Truncating state: ${state.clineMessages.length} messages → ${limit}`)

	// Keep the most recent messages
	const truncatedMessages = state.clineMessages.slice(-limit)

	return {
		...state,
		clineMessages: truncatedMessages,
		// Mark that messages were truncated for pagination support
		messageTruncated: true,
		totalMessageCount: state.clineMessages.length,
	}
}

/**
 * Fields kept when even the halved payload is still over the limit. This is a
 * fixed-size allowlist on purpose: it is the only way to *guarantee* the
 * payload fits, since any pass-through field could in principle be huge.
 *
 * turnState / currentTaskItem / queuedPrompts are NOT optional here. turnState
 * is the authoritative UI mode the footer buttons and the input gate read
 * (see buttonsForPhase), and currentTaskItem is the active task handle. Drop
 * either and the webview cannot tell a finished turn from an in-flight one, so
 * the input stays disabled and the conversation cannot be continued - a
 * degraded payload must never be able to strand the UI.
 */
const STATE_SIZE_FLOOR_FIELDS = [
	"version",
	"mode",
	"platform",
	"preferredLanguage",
	"welcomeViewCompleted",
	"mcpMarketplaceEnabled",
	"mcpDisplayMode",
	"planActSeparateModelsSetting",
	"enableCheckpointsSetting",
	"telemetrySetting",
	"shellIntegrationTimeout",
	"terminalReuseEnabled",
	"maxConsecutiveMistakes",
	"requestTimeoutMs",
	"yoloModeToggled",
	"useAutoCondense",
	"compactionStrategy",
	"autoCompactThreshold",
	"subagentsEnabled",
	"worktreesEnabled",
	"multiRootSetting",
	"isMultiRootWorkspace",
	"primaryRootIndex",
	"workspaceRoots",
	"backgroundCommandRunning",
	"backgroundCommandTaskId",
	"foregroundCommandRunning",
	"stateVersion",
	"epoch",
	"messageTruncated",
	"totalMessageCount",
	"turnState",
	"currentTaskItem",
	"queuedPrompts",
] as const satisfies readonly (keyof ExtensionState)[]

/**
 * Check state size and apply truncation if necessary.
 * Returns the final state JSON and whether truncation was applied.
 *
 * @param state The extension state to serialize
 * @returns Object containing the state JSON and truncation status
 */
function prepareStateForIpc(state: ExtensionState): { stateJson: string; wasTruncated: boolean } {
	const sizeBytes = Buffer.byteLength(JSON.stringify(state), "utf8")

	// Record telemetry for all state sizes
	recordStateSizeTelemetry(sizeBytes)

	// Apply truncation if state exceeds warning threshold
	if (sizeBytes > STATE_SIZE_WARNING_THRESHOLD) {
		// [TurnUi] This is the only place a state large enough to starve the webview
		// is observable. It used to be silent until truncation, so a session creeping
		// toward the limit gave no warning at all, and after truncation the original
		// size was logged but never the size actually sent. Log all three: before,
		// after each tier, and what the webview is left holding.
		Logger.warn(
			`[TurnUi] state ${(sizeBytes / 1024).toFixed(1)}KB exceeds the ${(STATE_SIZE_WARNING_THRESHOLD / 1024).toFixed(0)}KB ` +
				`threshold (hard limit ${(STATE_SIZE_HARD_LIMIT / 1024).toFixed(0)}KB, messages=${state.clineMessages?.length ?? 0}, ` +
				`taskHistory=${state.taskHistory?.length ?? 0}, turn=${state.turnState?.phase ?? "none"}) - truncating`,
		)
		const truncatedState = truncateStateForIpc(state)
		const truncatedJson = JSON.stringify(truncatedState)
		const truncatedSize = Buffer.byteLength(truncatedJson, "utf8")

		// If still over the hard limit, apply aggressive truncation
		if (truncatedSize > STATE_SIZE_HARD_LIMIT) {
			Logger.warn(
				`[subscribeToState] Truncated state still large: ${(truncatedSize / 1024).toFixed(1)}KB, applying aggressive truncation`,
			)
			const aggressiveState = truncateStateForIpc(state, AGGRESSIVE_MAX_MESSAGES)
			const aggressiveJson = JSON.stringify(aggressiveState)
			const aggressiveSize = Buffer.byteLength(aggressiveJson, "utf8")

			if (aggressiveSize > STATE_SIZE_HARD_LIMIT) {
				// Strip message bodies entirely, keep only metadata
				Logger.warn(
					`[subscribeToState] Aggressive truncation still large: ${(aggressiveSize / 1024).toFixed(1)}KB, stripping message bodies`,
				)
				const minimalState = {
					...aggressiveState,
					clineMessages: (aggressiveState.clineMessages ?? []).map((msg: any) => ({
						...msg,
						text: msg.text ? `[truncated ${msg.text.length} chars]` : undefined,
						toolResults: undefined,
						toolInvocations: undefined,
					})),
				}
				const minimalJson = JSON.stringify(minimalState)
				const minimalSize = Buffer.byteLength(minimalJson, "utf8")

				if (minimalSize > STATE_SIZE_HARD_LIMIT) {
					// The remaining bulk is OUTSIDE clineMessages. taskHistory is the
					// usual culprit: it grows with every task in the workspace and
					// truncateStateForIpc() only ever slices the transcript, so the
					// tiers above could return a payload many times over the IPC
					// limit. Previously this path logged CRITICAL and sent the
					// oversized payload anyway, which starves the webview of state and
					// leaves the sidebar blank with nothing surfaced to the user.
					//
					// Both collections are recoverable by paging, so shedding them
					// beats dropping the frame: halve until the payload fits, then
					// fall back to a fixed-size skeleton that always does.
					Logger.error(
						`[subscribeToState] CRITICAL: State size ${(minimalSize / 1024).toFixed(1)}KB exceeds hard limit even after aggressive truncation. Halving collections.`,
					)
					return halveCollectionsToFit(minimalState, minimalSize)
				}

				return { stateJson: minimalJson, wasTruncated: true }
			}

			return { stateJson: aggressiveJson, wasTruncated: true }
		}

		return { stateJson: truncatedJson, wasTruncated: true }
	}

	// Near the limit but under it. Silent until now, so a session creeping toward
	// the ceiling produced no signal at all; the next tier to trip would be a cliff.
	//
	// `messages` here is the WINDOW, not the conversation. getStateToPostToWebview
	// sends only the most recent INITIAL_MESSAGE_WINDOW (200) messages and flags the
	// rest as loadable via loadHistoryBatch, so this number stops growing once the
	// window saturates - it read a flat messages=200 across 105 consecutive posts of a
	// 25 minute session, which looks like a stuck pipeline and is actually a full
	// window. Report the true total alongside it, because the gap between the two IS
	// the frontend/backend divergence and nothing else in the log states it.
	const windowCount = state.clineMessages?.length ?? 0
	const totalCount = state.totalMessageCount ?? windowCount
	const isWindowed = windowCount > 0 && totalCount > windowCount
	Logger.debug(
		`[TurnUi] state ${(sizeBytes / 1024).toFixed(1)}KB is within ` +
			`${((STATE_SIZE_WARNING_THRESHOLD - sizeBytes) / 1024).toFixed(0)}KB of the ` +
			`${(STATE_SIZE_WARNING_THRESHOLD / 1024).toFixed(0)}KB threshold ` +
			`(messages=${windowCount}${isWindowed ? ` of ${totalCount}` : ""}, ` +
			`taskHistory=${state.taskHistory?.length ?? 0})`,
	)

	return { stateJson: JSON.stringify(state), wasTruncated: false }
}

/**
 * Last-resort reducer: repeatedly halve the two unbounded collections until the
 * serialized state fits the IPC limit, then fall back to a fixed-size
 * allowlist. Terminates because the loop is bounded and the floor is fixed.
 */
function halveCollectionsToFit(state: ExtensionState, initialSize: number): { stateJson: string; wasTruncated: boolean } {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const messages: any[] = [...((state as any).clineMessages ?? [])]
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const history: any[] = [...((state as any).taskHistory ?? [])]
	const totalMessages = messages.length
	const totalHistory = history.length

	for (let attempt = 0; attempt < 24; attempt++) {
		const candidate = {
			...state,
			clineMessages: messages,
			taskHistory: history,
			messageTruncated: true,
			totalMessageCount: totalMessages,
		}
		const json = JSON.stringify(candidate)
		if (Buffer.byteLength(json, "utf8") <= STATE_SIZE_HARD_LIMIT) {
			Logger.warn(
				`[subscribeToState] Reduced state to fit IPC limit after ${attempt} halving pass(es): ${messages.length}/${totalMessages} messages, ${history.length}/${totalHistory} history entries`,
			)
			return { stateJson: json, wasTruncated: true }
		}
		if (messages.length === 0 && history.length === 0) {
			break
		}
		messages.splice(0, Math.max(1, Math.ceil(messages.length / 2)))
		history.splice(0, Math.max(1, Math.ceil(history.length / 2)))
	}

	// Nothing left to halve and still oversized: some other field is huge.
	// Ship a fixed-size skeleton so the webview gets a renderable state.
	const skeleton: Record<string, unknown> = {
		messageTruncated: true,
		totalMessageCount: totalMessages,
		clineMessages: [],
		taskHistory: [],
	}
	for (const key of STATE_SIZE_FLOOR_FIELDS) {
		if (state[key] !== undefined) {
			skeleton[key] = state[key]
		}
	}
	const skeletonJson = JSON.stringify(skeleton)
	Logger.error(
		`[subscribeToState] Sent reduced state skeleton: ${(Buffer.byteLength(skeletonJson, "utf8") / 1024).toFixed(1)}KB (was ${(initialSize / 1024).toFixed(1)}KB)`,
	)
	return { stateJson: skeletonJson, wasTruncated: true }
}

/**
 * Subscribe to state updates
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToState(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<State>,
	requestId?: string,
): Promise<void> {
	// Register this subscription with instance-level management
	const subscriptionId = stateSubscriptionManager.register(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		stateSubscriptionManager.unregister(subscriptionId)
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "state_subscription" }, responseStream)
	}

	// Send the initial state with size monitoring and truncation
	const initialState = await controller.getStateToPostToWebview()
	const { stateJson } = prepareStateForIpc(initialState)

	try {
		await responseStream(
			{
				stateJson,
				// Out-of-band version lets the webview gate BEFORE JSON.parse.
				stateVersion: initialState.stateVersion,
			},
			false, // Not the last message
		)
	} catch (error) {
		Logger.error("Error sending initial state:", error)
		stateSubscriptionManager.unregister(subscriptionId)
	}
}

/**
 * Send a state update to all active subscribers
 * @param state The state to send
 */
export async function sendStateUpdate(state: ExtensionState): Promise<void> {
	const { stateJson } = prepareStateForIpc(state)

	// Get all active subscriptions from the instance-level manager
	const activeSubscriptions = stateSubscriptionManager.getActiveSubscriptions()

	// FIRE-AND-FORGET: do not await delivery to the webview (it may be hidden/reloaded/closed
	// and postMessage can hang or resolve false). The webview reconciles convergently from
	// whatever state snapshots it receives, gated by stateVersion/epoch.
	for (const responseStream of activeSubscriptions) {
		responseStream(
			{
				stateJson,
				// Out-of-band version lets the webview gate BEFORE JSON.parse.
				stateVersion: state.stateVersion,
			},
			false, // Not the last message
		).catch((error) => {
			Logger.error("Error sending state update:", error)
			// Note: We can't easily unregister here since we don't have the subscriptionId
			// The subscription will be cleaned up when the connection closes
		})
	}
}

/**
 * State delta types for incremental state updates.
 */
export interface StateDeltaMessage {
	type: "append_message" | "update_message" | "replace_all"
	payload: unknown
	version: number
}

/**
 * Send a state delta to all active subscribers (incremental update).
 * This is lighter-weight than sendStateUpdate() because it ships only
 * the changed fields instead of the full ExtensionState.
 *
 * The delta is sent in the `deltaJson` field of the State proto message,
 * NOT `stateJson`. The webview's ExtensionStateContext checks `deltaJson`
 * first:
 * - If present, it applies the delta through the convergent-replica reducer
 *   (messageReducer.ts) and updates only the changed parts of its state.
 * - If `stateJson` is also present in the same message, it is treated as
 *   the ground-truth full snapshot and the delta is ignored.
 * - If neither is present, the message is a heartbeat and skipped.
 *
 * Fire-and-forget: errors are logged but not propagated. The next full
 * snapshot always carries ground truth.
 */
export async function sendStateDelta(delta: StateDeltaMessage): Promise<void> {
	let deltaJson: string
	try {
		deltaJson = JSON.stringify(delta)
	} catch (error) {
		Logger.error("Error serializing state delta:", error)
		return
	}

	// Get all active subscriptions from the instance-level manager
	const activeSubscriptions = stateSubscriptionManager.getActiveSubscriptions()

	for (const responseStream of activeSubscriptions) {
		responseStream(
			{
				stateJson: "", // sentinel: webview checks deltaJson first when present
				deltaJson,
			},
			false,
		).catch((error) => {
			Logger.error("Error sending state delta:", error)
			// Note: We can't easily unregister here since we don't have the subscriptionId
			// The subscription will be cleaned up when the connection closes
		})
	}
}

/**
 * Handle a full-sync request from the webview.
 *
 * The webview calls this when it detects a version-hash mismatch or a
 * gap in delta messages (self-healing protocol). The backend responds by
 * sending the full current state snapshot through the subscription stream.
 */
export async function requestFullSync(controller: Controller, _request: StringRequest): Promise<void> {
	const state = await controller.getStateToPostToWebview()
	const { stateJson } = prepareStateForIpc(state)

	// Get all active subscriptions from the instance-level manager
	const activeSubscriptions = stateSubscriptionManager.getActiveSubscriptions()

	for (const responseStream of activeSubscriptions) {
		responseStream(
			{
				stateJson,
				// Out-of-band version lets the webview gate BEFORE JSON.parse.
				stateVersion: state.stateVersion,
			},
			false,
		).catch((error) => {
			Logger.error("Error sending full sync state:", error)
			// Note: We can't easily unregister here since we don't have the subscriptionId
			// The subscription will be cleaned up when the connection closes
		})
	}
}

function recordStateSizeTelemetry(sizeBytes: number): void {
	telemetryService.captureGrpcResponseSize(sizeBytes, "cline.StateService", "subscribeToState")

	// Log state size metrics for monitoring
	if (sizeBytes > STATE_SIZE_WARNING_THRESHOLD) {
		Logger.warn(`[subscribeToState] Large state payload: ${(sizeBytes / 1024).toFixed(1)}KB`)
	}

	// Track subscription count for diagnostics
	const subscriptionCount = stateSubscriptionManager.getSubscriptionCount()
	if (subscriptionCount > 1) {
		Logger.debug(`[subscribeToState] Active subscriptions: ${subscriptionCount}`)
	}
}
