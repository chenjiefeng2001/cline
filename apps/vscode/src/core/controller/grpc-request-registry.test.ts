import { describe, expect, it, vi } from "vitest"
import { GrpcRequestRegistry } from "./grpc-request-registry"

/**
 * A streaming subscription is opened once, by the webview's mount effect, and held
 * for the lifetime of the page. The registry's job is to reclaim subscriptions whose
 * webview went away — NOT to cap how long a subscription may live.
 *
 * It used to reap purely on registration age (10-minute threshold, 5-minute
 * interval), so every live subscription was destroyed between 10 and 15 minutes
 * after the webview mounted. In production that produced:
 *
 *   22:12:54 [GrpcHandler] Cleaned up 16 stale gRPC requests
 *           Unregistered subscription: state_sub_1_1790863078175
 *
 * after which `sendStateUpdate` / `sendStateDelta` / `sendPartialMessageEvent`
 * iterated an empty subscriber set: no snapshot, no delta, no partial message could
 * ever reach the webview again, with no error, no disconnect and no resubscribe. The
 * webview still had its `message` listeners attached, believing it was live. Hence
 * "the panel stopped refreshing after a few rounds of conversation".
 */
describe("GrpcRequestRegistry staleness", () => {
	const TEN_MIN = 10 * 60 * 1000

	it("never reaps a healthy subscription, however old it is", () => {
		const registry = new GrpcRequestRegistry()
		const cleanup = vi.fn()
		registry.registerRequest("req-1", cleanup, { type: "state_subscription" }, vi.fn())

		// Age it far past any threshold by backdating the registration timestamp,
		// which is diagnostics-only data.
		const info = registry.getRequestInfo("req-1")!
		info.timestamp = new Date(Date.now() - 10 * TEN_MIN)

		expect(registry.cleanupStaleRequests(TEN_MIN)).toBe(0)
		expect(registry.hasRequest("req-1")).toBe(true)
		expect(cleanup).not.toHaveBeenCalled()
	})

	it("reaps every subscription kind once delivery has been failing for too long", () => {
		// All 17 registerRequest call sites are long-lived subscriptions; they must all
		// survive on health alone.
		const kinds = [
			"state_subscription",
			"partial_message_subscription",
			"show_webview_subscription",
			"mcpServers_subscription",
			"openRouterModels_subscription",
		]
		const registry = new GrpcRequestRegistry()
		const cleanups: Array<ReturnType<typeof vi.fn>> = []
		kinds.forEach((type, i) => {
			const cleanup = vi.fn()
			cleanups.push(cleanup)
			registry.registerRequest(`req-${i}`, cleanup, { type }, vi.fn())
		})

		// A single failure must not be enough — it is usually transient.
		registry.noteDeliveryFailure("req-0")
		expect(registry.cleanupStaleRequests(TEN_MIN)).toBe(0)
		expect(registry.hasRequest("req-0")).toBe(true)

		// Backdate the failure past the window, then it is genuinely abandoned.
		const info = registry.getRequestInfo("req-0")!
		info.lastFailureAt = new Date(Date.now() - TEN_MIN - 1000)

		expect(registry.cleanupStaleRequests(TEN_MIN)).toBe(1)
		expect(registry.hasRequest("req-0")).toBe(false)
		expect(cleanups[0]).toHaveBeenCalledTimes(1)
		// The healthy ones are untouched.
		for (let i = 1; i < kinds.length; i++) {
			expect(registry.hasRequest(`req-${i}`)).toBe(true)
		}
	})

	it("forgets a failure once delivery succeeds again", () => {
		const registry = new GrpcRequestRegistry()
		registry.registerRequest("req-1", vi.fn(), { type: "state_subscription" }, vi.fn())

		registry.noteDeliveryFailure("req-1")
		registry.noteDeliveryFailure("req-1")
		expect(registry.getRequestInfo("req-1")!.consecutiveFailures).toBe(2)

		registry.noteDeliverySuccess("req-1")
		const info = registry.getRequestInfo("req-1")!
		expect(info.consecutiveFailures).toBe(0)
		expect(info.lastFailureAt).toBeUndefined()

		// ...so even a backdated age no longer makes it reapable.
		info.timestamp = new Date(Date.now() - 100 * TEN_MIN)
		expect(registry.cleanupStaleRequests(TEN_MIN)).toBe(0)
	})

	it("ignores delivery reports for requests it does not know", () => {
		const registry = new GrpcRequestRegistry()
		expect(() => registry.noteDeliveryFailure("nope")).not.toThrow()
		expect(() => registry.noteDeliverySuccess("nope")).not.toThrow()
	})
})

describe("GrpcRequestRegistry.releaseAll", () => {
	it("releases every subscription, which is how webview dispose tears down", () => {
		// A disposed webview cannot send grpc_request_cancel, so disposal is the only
		// reliable teardown signal. This is the path that makes it deterministic
		// instead of leaving the leak backstop to infer it from failed deliveries.
		const registry = new GrpcRequestRegistry()
		const cleanups = [vi.fn(), vi.fn(), vi.fn()]
		cleanups.forEach((cleanup, i) => registry.registerRequest(`req-${i}`, cleanup, { type: "state_subscription" }, vi.fn()))

		expect(registry.releaseAll()).toBe(3)
		expect(registry.getAllRequests()).toHaveLength(0)
		for (const cleanup of cleanups) {
			expect(cleanup).toHaveBeenCalledTimes(1)
		}
		// Idempotent, because dispose can run more than once.
		expect(registry.releaseAll()).toBe(0)
	})
})
