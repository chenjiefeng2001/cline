import { Logger } from "@shared/services/Logger"

/**
 * SSE Heartbeat monitoring for MCP streamable HTTP connections.
 *
 * Detects silent connection drops where the TCP connection is killed by a network
 * middlebox (proxy, load balancer, firewall) without sending a proper TCP RST or FIN.
 * In these cases, ReconnectingEventSource may NOT fire onerror because the EventSource
 * API only detects errors when the HTTP response itself fails, not when the stream
 * silently stops producing data.
 *
 * The heartbeat passively monitors data flow — no ping/pong protocol needed.
 * If no data arrives within the timeout window, it triggers a reconnect.
 *
 * ## Usage
 * ```typescript
 * const cleanup = SseHeartbeat.start(name, transport, findConn, reconnect, onError)
 * // ... later ...
 * cleanup() // Stop monitoring on disconnect
 * ```
 */
export class SseHeartbeat {
	private static readonly HEARTBEAT_INTERVAL_MS = 30_000 // Check every 30s
	private static readonly INACTIVITY_TIMEOUT_MS = 45_000 // Consider dead after 45s of silence

	private lastActivity = Date.now()
	private intervalId: ReturnType<typeof setInterval> | undefined
	private disposed = false

	private constructor(
		private readonly name: string,
		private readonly transport: unknown,
		private readonly onStale: () => void,
	) {
		this.intervalId = setInterval(() => this.check(), SseHeartbeat.HEARTBEAT_INTERVAL_MS)
		this.intervalId.unref?.()
	}

	/**
	 * Start monitoring an SSE transport for inactivity.
	 *
	 * @param name - Server name for logging
	 * @param transport - The MCP transport object
	 * @param findConnection - Returns current connection (may be stale after reconnect)
	 * @param reconnect - Called to trigger a reconnect
	 * @param onError - Called with error message before reconnect
	 * @returns Cleanup function — call on disconnect to stop monitoring
	 */
	static start(
		name: string,
		transport: unknown,
		_findConnection: () => unknown,
		reconnect: () => Promise<void>,
		onError: (error: string) => void,
	): () => void {
		const heartbeat = new SseHeartbeat(name, transport, () => {
			onError(
				`SSE heartbeat timeout: no data received for ${SseHeartbeat.INACTIVITY_TIMEOUT_MS / 1000}s. ` +
					`Triggering reconnect.`,
			)
			heartbeat.dispose()
			reconnect().catch((err) => {
				Logger.error(`[SseHeartbeat:${name}] Reconnect failed:`, err)
			})
		})

		Logger.log(`[SseHeartbeat:${name}] Started monitoring (every ${SseHeartbeat.HEARTBEAT_INTERVAL_MS / 1000}s, ` +
			`timeout ${SseHeartbeat.INACTIVITY_TIMEOUT_MS / 1000}s)`)

		return () => heartbeat.dispose()
	}

	/**
	 * Mark activity — call this whenever data is received on the transport.
	 * Resets the inactivity timer.
	 */
	markActivity(): void {
		this.lastActivity = Date.now()
	}

	private check(): void {
		if (this.disposed) return

		const elapsed = Date.now() - this.lastActivity
		if (elapsed >= SseHeartbeat.INACTIVITY_TIMEOUT_MS) {
			Logger.warn(
				`[SseHeartbeat:${this.name}] No data for ${Math.round(elapsed / 1000)}s ` +
					`(threshold: ${SseHeartbeat.INACTIVITY_TIMEOUT_MS / 1000}s). Triggering reconnect.`,
			)
			this.onStale()
		}
	}

	/**
	 * Stop the heartbeat timer. Safe to call multiple times.
	 */
	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		if (this.intervalId) {
			clearInterval(this.intervalId)
			this.intervalId = undefined
		}
	}
}
