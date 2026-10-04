import { Logger } from "@/shared/services/Logger"
import { StreamingResponseHandler } from "./grpc-handler"

/**
 * Information about a registered gRPC request
 */
export interface RequestInfo {
	/**
	 * Function to clean up resources when the request is cancelled or completed
	 */
	cleanup: () => void

	/**
	 * Optional metadata about the request
	 */
	metadata?: any

	/**
	 * Timestamp when the request was registered. Diagnostics only — this is NOT a
	 * staleness signal, because every request in this registry is a long-lived
	 * streaming subscription that is meant to outlive any fixed age.
	 */
	timestamp: Date

	/**
	 * When delivery to this subscriber last failed, or undefined while it is
	 * healthy. This is the staleness signal: a subscriber we cannot deliver to is
	 * genuinely abandoned, whereas age alone says nothing.
	 */
	lastFailureAt?: Date

	/**
	 * Consecutive delivery failures. Reset on every success. Used so a single
	 * transient error (the webview reloading mid-frame) does not age a healthy
	 * subscriber into the sweeper.
	 */
	consecutiveFailures: number

	/**
	 * The streaming response handler for this request
	 */
	responseStream?: StreamingResponseHandler<any>
}

/**
 * Registry for managing gRPC request lifecycles
 * This class provides a centralized way to track active requests and their cleanup functions
 */
export class GrpcRequestRegistry {
	/**
	 * Map of request IDs to request information
	 */
	private activeRequests = new Map<string, RequestInfo>()

	/**
	 * Register a new request with its cleanup function
	 * @param requestId The unique ID of the request
	 * @param cleanup Function to clean up resources when the request is cancelled
	 * @param metadata Optional metadata about the request
	 * @param responseStream Optional streaming response handler
	 */
	public registerRequest(
		requestId: string,
		cleanup: () => void,
		metadata?: any,
		responseStream?: StreamingResponseHandler<any>,
	): void {
		this.activeRequests.set(requestId, {
			cleanup,
			metadata,
			timestamp: new Date(),
			consecutiveFailures: 0,
			responseStream,
		})
	}

	/**
	 * Record a successful delivery to this subscriber.
	 *
	 * Called from the one place every streaming push funnels through. It clears the
	 * failure state, which is what keeps a subscriber that has recovered from being
	 * swept.
	 */
	public noteDeliverySuccess(requestId: string): void {
		const info = this.activeRequests.get(requestId)
		if (!info) {
			return
		}
		info.consecutiveFailures = 0
		info.lastFailureAt = undefined
	}

	/**
	 * Record a failed delivery to this subscriber (postMessage rejected, or resolved
	 * `false` meaning the frame was not delivered).
	 */
	public noteDeliveryFailure(requestId: string): void {
		const info = this.activeRequests.get(requestId)
		if (!info) {
			return
		}
		info.consecutiveFailures++
		info.lastFailureAt = new Date()
	}

	/**
	 * Cancel a request and clean up its resources
	 * @param requestId The ID of the request to cancel
	 * @returns True if the request was found and cancelled, false otherwise
	 */
	public cancelRequest(requestId: string): boolean {
		const requestInfo = this.activeRequests.get(requestId)
		if (!requestInfo) {
			return false
		}
		try {
			requestInfo.cleanup()
		} catch (error) {
			Logger.error(`Error cleaning up request ${requestId}:`, error)
		}
		this.activeRequests.delete(requestId)
		return true
	}

	/**
	 * Get information about a request
	 * @param requestId The ID of the request
	 * @returns The request information, or undefined if not found
	 */
	public getRequestInfo(requestId: string): RequestInfo | undefined {
		return this.activeRequests.get(requestId)
	}

	/**
	 * Check if a request exists in the registry
	 * @param requestId The ID of the request
	 * @returns True if the request exists, false otherwise
	 */
	public hasRequest(requestId: string): boolean {
		return this.activeRequests.has(requestId)
	}

	/**
	 * Get all active requests
	 * @returns An array of [requestId, requestInfo] pairs
	 */
	public getAllRequests(): [string, RequestInfo][] {
		return Array.from(this.activeRequests.entries())
	}

	/**
	 * Clean up subscribers that have been undeliverable for too long.
	 *
	 * ## Why this is NOT an age check
	 *
	 * This used to reap any request older than `maxAgeMs`, on the theory that it was
	 * cleaning up "webview reloaded while a streaming subscription was active". But
	 * every request in this registry is a long-lived streaming subscription that the
	 * webview opens once and holds for the lifetime of the page — `subscribeToState`,
	 * `subscribeToPartialMessage`, the button/mcp/model subscriptions. Age carries no
	 * information about whether one is still wanted.
	 *
	 * So the age sweep deleted LIVE subscriptions on a timer: with a 10-minute
	 * threshold and a 5-minute interval, every subscription was reaped between 10 and
	 * 15 minutes after the webview mounted. After that the host's subscriber sets
	 * were empty, so `sendStateUpdate` / `sendStateDelta` / `sendPartialMessageEvent`
	 * iterated nothing and no update could ever reach the webview again — no error, no
	 * disconnect, no resubscribe, and the webview still had its `message` listeners
	 * attached believing it was live. That is the "the panel stopped refreshing after
	 * a few rounds of conversation" report, with a healthy-looking extension log.
	 *
	 * Staleness is now delivery-based: a subscriber is stale only once delivery to it
	 * has actually been failing for `maxAgeMs`. A healthy subscriber is never reaped,
	 * however old it is. Genuine teardown does not rely on this sweep at all — see
	 * `releaseAll`, which the webview provider calls on dispose.
	 *
	 * @param maxAgeMs How long delivery must have been continuously failing.
	 * @returns The number of requests that were cleaned up
	 */
	public cleanupStaleRequests(maxAgeMs: number): number {
		const now = new Date()
		let cleanedCount = 0

		for (const [requestId, info] of this.activeRequests.entries()) {
			if (info.lastFailureAt === undefined) {
				continue
			}
			if (now.getTime() - info.lastFailureAt.getTime() > maxAgeMs) {
				Logger.warn(
					`[GrpcHandler] Releasing streaming subscription ${requestId} ` +
						`(${info.metadata?.type ?? "unknown"}): delivery has been failing for over ` +
						`${Math.round(maxAgeMs / 60000)} minutes (${info.consecutiveFailures} consecutive failures).`,
				)
				this.cancelRequest(requestId)
				cleanedCount++
			}
		}

		return cleanedCount
	}

	/**
	 * Release every registered request. Called when the webview is disposed, so
	 * teardown is driven by the real lifecycle event rather than inferred from a
	 * timer.
	 *
	 * @returns The number of requests released.
	 */
	public releaseAll(): number {
		const count = this.activeRequests.size
		for (const requestId of Array.from(this.activeRequests.keys())) {
			this.cancelRequest(requestId)
		}
		return count
	}
}
