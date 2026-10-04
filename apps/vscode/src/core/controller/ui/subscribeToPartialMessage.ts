import { EmptyRequest } from "@shared/proto/cline/common"
import { ClineMessage } from "@shared/proto/cline/ui"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active partial message subscriptions (gRPC streams)
const activePartialMessageSubscriptions = new Set<StreamingResponseHandler<ClineMessage>>()

// Keep track of callback-based subscriptions (for CLI and other non-gRPC consumers)
type PartialMessageCallback = (message: ClineMessage) => void
const callbackSubscriptions = new Set<PartialMessageCallback>()

/**
 * Subscribe to partial message events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToPartialMessage(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<ClineMessage>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	activePartialMessageSubscriptions.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		activePartialMessageSubscriptions.delete(responseStream)
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "partial_message_subscription" }, responseStream)
	}
}

/**
 * Hard ceiling for a single partial-message frame. Matches the state snapshot's hard
 * limit (see subscribeToState.ts) — the same VS Code IPC ceiling, applied to the one
 * push path that ships a message verbatim instead of going through the truncation
 * ladder.
 */
const PARTIAL_MESSAGE_SIZE_HARD_LIMIT = 1024 * 1024

/**
 * Serialized size of a partial message, or null when it cannot be serialized.
 *
 * This costs one `JSON.stringify` of a single message, which `postMessage` is about to
 * do anyway. It is not memoized: `WebviewGrpcBridge.pushPartialMessage` converts to a
 * fresh proto object per emit, so an identity cache would never hit and would only add
 * a module-level cache to reason about.
 */
function partialMessageBytes(partialMessage: ClineMessage): number | null {
	try {
		return Buffer.byteLength(JSON.stringify(partialMessage), "utf8")
	} catch {
		return null
	}
}

/**
 * Send a partial message event to all active subscribers
 * @param partialMessage The ClineMessage to send
 */
export async function sendPartialMessageEvent(partialMessage: ClineMessage): Promise<void> {
	// FIRE-AND-FORGET: do NOT await delivery to the webview. The webview can be hidden,
	// reloaded, or closed, and VSCode's postMessage may hang or resolve false; awaiting it
	// could stall the backend's turn loop on a dead consumer. Correctness does not depend on
	// any single delivery arriving — the webview is a convergent replica that merges by id/seq
	// and reconciles from full state.
	//
	// A delivery error must NOT unregister the subscriber. It used to:
	//
	//     .catch((error) => {
	//         Logger.error(...)
	//         activePartialMessageSubscriptions.delete(responseStream)
	//     })
	//
	// `postMessage` rejects for transient reasons — the webview reloading, being
	// momentarily unavailable, the view being disposed mid-flight. The webview holds
	// this stream open with a `message` listener and has NO re-subscribe path (the
	// subscription is created once, in the mount effect), so a single transient failure
	// silently and permanently severed the streaming transcript: the turn kept running in
	// the host and the panel simply stopped updating. That is the "frontend stops
	// refreshing after a few rounds" report, with an extension log that looks healthy
	// because it did nothing wrong.
	//
	// `sendStateUpdate` and `sendStateDelta` already only log here; this path now
	// matches them. A genuinely dead subscriber is reaped by the request registry's
	// stale sweeper in grpc-handler.ts instead.
	//
	// An OVERSIZED message is dropped rather than sent. `sendStateUpdate` bounds its
	// payload through prepareStateForIpc's truncation ladder, but this path ships one
	// message verbatim and a single message can be arbitrarily large on its own (a big
	// file read, a long command output). VS Code's postMessage fails on an oversized
	// frame, its boolean return is deliberately ignored, and the state-delta channel may
	// be skipping full snapshots for the rest of this turn — so a dropped message used to
	// leave the webview permanently missing that row with nothing to reconcile from. The
	// state snapshot carries the same message (bounded), so dropping it is safe.
	const messageBytes = partialMessageBytes(partialMessage)
	if (messageBytes !== null && messageBytes > PARTIAL_MESSAGE_SIZE_HARD_LIMIT) {
		Logger.warn(
			`[subscribeToPartialMessage] Dropped a ${(messageBytes / 1024).toFixed(1)}KB partial message ` +
				`(ts=${partialMessage.ts}, limit ${(PARTIAL_MESSAGE_SIZE_HARD_LIMIT / 1024).toFixed(0)}KB); ` +
				`it will arrive via the next bounded state snapshot.`,
		)
		return
	}

	for (const responseStream of activePartialMessageSubscriptions) {
		responseStream(partialMessage, false).catch((error) => {
			Logger.error("Error sending partial message event:", error)
		})
	}
	// Send to callback subscribers (synchronous)
	for (const callback of callbackSubscriptions) {
		try {
			callback(partialMessage)
		} catch (error) {
			Logger.error("Error in partial message callback:", error)
		}
	}
}
