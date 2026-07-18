/**
 * # Provider Performance Monitoring
 *
 * Tracks key performance indicators for AI provider API calls and state sync.
 * These metrics are used for PostHog dashboards to monitor system health.
 *
 * ## Metrics
 *
 * | Metric | Event Name | Description |
 * |--------|-----------|-------------|
 * | API Duration | `task.api_request_duration` | API request round-trip time by provider |
 * | State Tearing | `task.state_sync_tearing` | Delta push → full sync fallback rate |
 *
 * ## Usage
 *
 * ```typescript
 * import { recordApiRequestDuration, recordStateSyncTearing } from '@/shared/provider-performance'
 *
 * // After API request completes:
 * recordApiRequestDuration({ provider: 'anthropic', durationMs: 2340, success: true })
 *
 * // When delta push falls back to full sync:
 * recordStateSyncTearing({ reason: 'version_mismatch' })
 * ```
 */

import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ApiRequestDuration {
	provider: string
	modelId?: string
	durationMs: number
	success: boolean
	errorType?: string
	/**
	 * Time from request start to first chunk received (Time-to-First-Token).
	 */
	timeToFirstTokenMs?: number
}

export interface StateSyncTearing {
	reason: "version_mismatch" | "delta_dropped" | "webview_reconnect"
}

// ─── Implementation ────────────────────────────────────────────────────────

/**
 * Record the duration of an API request for performance monitoring.
 *
 * Fires a PostHog `task.api_request_duration` event with provider, duration,
 * and success/failure dimensions for dashboard filtering.
 *
 * @param info - The API request performance data
 *
 * @example
 * ```typescript
 * const start = performance.now()
 * try {
 *   const result = await callApi()
 *   recordApiRequestDuration({
 *     provider: 'anthropic',
 *     modelId: 'claude-3-5-sonnet',
 *     durationMs: performance.now() - start,
 *     success: true,
 *   })
 * } catch (err) {
 *   recordApiRequestDuration({
 *     provider: 'anthropic',
 *     durationMs: performance.now() - start,
 *     success: false,
 *     errorType: err.code,
 *   })
 * }
 * ```
 */
export function recordApiRequestDuration(info: ApiRequestDuration): void {
	try {
		telemetryService.capture({
			event: "task.api_request_duration",
			properties: {
				provider: info.provider,
				modelId: info.modelId,
				durationMs: info.durationMs,
				success: info.success,
				errorType: info.errorType,
				timeToFirstTokenMs: info.timeToFirstTokenMs,
			},
		})
	} catch (error) {
		Logger.warn("[Performance] Failed to record API request duration:", error)
	}
}

/**
 * Record a state sync tearing event.
 *
 * Tearing happens when the delta push mechanism loses a message and the
 * webview falls back to requesting a full state sync. A high tearing rate
 * (>5%) signals that the delta channel is unreliable and may need tuning.
 *
 * @param info - The tearing event details
 *
 * @example
 * ```typescript
 * recordStateSyncTearing({ reason: 'version_mismatch' })
 * ```
 */
export function recordStateSyncTearing(info: StateSyncTearing): void {
	try {
		telemetryService.capture({
			event: "task.state_sync_tearing",
			properties: {
				reason: info.reason,
			},
		})
	} catch (error) {
		Logger.warn("[Performance] Failed to record state sync tearing:", error)
	}
}

/**
 * Convenience wrapper: records API duration + TTFT in a single call.
 *
 * Use this at the call site where both the first chunk arrival and total
 * duration are measured.
 *
 * @example
 * ```typescript
 * const start = performance.now()
 * // ... first chunk received at firstChunkTime ...
 * recordApiPerformance({
 *   provider: 'anthropic',
 *   modelId: 'claude-3-5-sonnet',
 *   durationMs: performance.now() - start,
 *   timeToFirstTokenMs: firstChunkTime - start,
 *   success: true,
 * })
 * ```
 */
export function recordApiPerformance(info: ApiRequestDuration): void {
	recordApiRequestDuration(info)

	// Also record TTFT via telemetryService.captureTaskCompleted if provided
	if (info.timeToFirstTokenMs !== undefined && info.success) {
		try {
			telemetryService.capture({
				event: "task.api_ttft",
				properties: {
					provider: info.provider,
					modelId: info.modelId,
					timeToFirstTokenMs: info.timeToFirstTokenMs,
				},
			})
		} catch (error) {
			Logger.warn("[Performance] Failed to record TTFT:", error)
		}
	}
}