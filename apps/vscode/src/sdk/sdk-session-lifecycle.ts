import type {
	CoreSessionEvent,
	ITelemetryService,
	PreparedRemoteConfigCoreIntegration,
	RestoreInput,
	RestoreResult,
	StartSessionResult,
} from "@cline/core"
import { computeRetryDelayMs, DEFAULT_PROVIDER_RETRY_POLICY, isTransientProviderError } from "@cline/llms"
import { formatModeSwitchNotice, type ModeSwitchNotice } from "@cline/shared"
import { StateManager } from "@/core/storage/StateManager"
import type { VscodeTerminalManager } from "@/hosts/vscode/terminal/VscodeTerminalManager"
import { McpHub } from "@/services/mcp/McpHub"
import { Logger } from "@/shared/services/Logger"
import type { ActiveSession } from "./cline-session-factory"
import type { SdkForegroundCommandCoordinator } from "./sdk-foreground-command-coordinator"
import { buildToolPolicies } from "./sdk-tool-policies"
import type { SdkSessionHost } from "./session-host"
import { VscodeSessionHost } from "./vscode-session-host"

// ─── Turn-end drain ──────────────────────────────────────────────────────
/**
 * How long a resolved send waits for the runtime's terminal event before the
 * turn is finalised locally.
 *
 * `send()` resolving is not the same fact as "the turn ended": it only says the
 * SDK call returned. How the turn ended is carried by the `done` event, and
 * finalising from the promise therefore throws away the distinction between "the
 * agent used its completion tool" (`completed`) and "the agent stopped and is
 * waiting for you" (`awaiting_followup`) - and it does so by overwriting the
 * phase the event stream already set.
 *
 * The wait is bounded rather than open-ended, because the alternative this
 * replaces was itself a bound - the previous implementation finalised at zero
 * and left a turn that never received a terminal event stuck in `streaming`
 * forever, which is the failure 568617579 fixed. 1s is long relative to the
 * work being waited on: the runtime dispatches `done` *before* the send promise
 * settles, and then persists session metadata and messages, so the event is
 * already in flight when the promise resolves. It is short enough that a lost
 * event is not user-visible, and the expiry is logged rather than swallowed,
 * because "the agent finished and never said so" is a runtime bug worth naming.
 */
export const TURN_DRAIN_TIMEOUT_MS = 1000

/**
 * Determine whether an error is transient and worth retrying automatically.
 *
 * Re-exported from `@cline/llms` (see `providers/transient-errors.ts`) rather than
 * implemented here. The classification is a fact about the provider and the transport,
 * not about this host, and keeping a second copy is how the CLI ended up with no
 * automatic retry at all while the extension retried transparently.
 */
export { isTransientProviderError as isRetryableError }

type RequestToolApprovalHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["requestToolApproval"]>
type AskQuestionHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["askQuestion"]>
type EditorExecutorHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["editorExecutor"]>
type ApplyPatchExecutorHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["applyPatchExecutor"]>

export interface SdkSessionLifecycleOptions {
	mcpHub: McpHub
	requestToolApproval: RequestToolApprovalHandler
	askQuestion: AskQuestionHandler
	/** Custom `editor` executor (diff-view edit pipeline); replaces the SDK's disk writer. */
	editorExecutor?: EditorExecutorHandler
	/** Custom `apply_patch` executor (reverts the diff preview, then applies via the SDK default). */
	applyPatchExecutor?: ApplyPatchExecutorHandler
	onSessionEvent: (event: CoreSessionEvent) => void
	/** Lazy factory for the VscodeTerminalManager (foreground terminal support). */
	getTerminalManager?: () => VscodeTerminalManager
	/** Registry of in-flight foreground executions for "Proceed While Running". */
	foregroundCommands?: SdkForegroundCommandCoordinator
	/** Returns the latest prepared remote-config integration, if remote config is active. */
	getRemoteConfigIntegration?: () => PreparedRemoteConfigCoreIntegration | undefined
	/** Shared SDK telemetry service owned by SdkController. */
	telemetry?: ITelemetryService
	onSendStart?: (sessionId: string) => void
	onSendComplete: (sessionId: string) => Promise<void> | void
	onSendError: (error: unknown, sessionId: string) => Promise<void> | void
	/** Called when a send is about to auto-retry after a transient error. */
	onAutoRetry?: (attempt: number, maxRetries: number, delayMs: number, error: unknown) => void
	/**
	 * Returns (and clears) a pending user-initiated plan/act switch recorded by
	 * SdkModeCoordinator for this session, so fireAndForgetSend — the single
	 * funnel for outbound turn sends — can stamp a <mode_notice> onto the next
	 * message. Consumed exactly once; null when no switch is pending.
	 */
	consumeModeSwitchNotice?: (sessionId: string) => ModeSwitchNotice | null
	onDidBecomeIdle?: () => void
	/**
	 * Overrides the turn-end drain bound. Production leaves it unset so the bound is
	 * TURN_DRAIN_TIMEOUT_MS; it exists because a test that does not simulate the
	 * runtime's terminal event would otherwise have to sit through the real bound to
	 * observe the fallback.
	 */
	turnDrainTimeoutMs?: number
}

export class SdkSessionLifecycle {
	private activeSession: ActiveSession | undefined
	private sharedHost: SdkSessionHost | undefined
	private sharedHostPromise: Promise<SdkSessionHost> | undefined
	private sharedHostUnsubscribe: (() => void) | undefined
	/**
	 * Stops still in flight, keyed by sessionId. Mode/MCP rebuilds and
	 * follow-up resumes reuse the sessionId of the session they replace, and
	 * core cleanup is keyed by sessionId, so a same-id start that overlaps a
	 * stop would be torn down by the old session's late cleanup.
	 * startNewSession consults this map to enforce stop-before-start, the same
	 * sequencing the CLI uses.
	 */
	private readonly pendingStops = new Map<string, Promise<void>>()
	/**
	 * Resolvers for callers blocked on the next running -> idle transition.
	 *
	 * Only SdkSessionEventCoordinator's turn-end branch clears `isRunning` for a
	 * live turn, so this is the signal that the terminal event has landed and the
	 * event stream has already decided the phase. See TURN_DRAIN_TIMEOUT_MS.
	 */
	private readonly idleWaiters = new Set<() => void>()

	constructor(private readonly options: SdkSessionLifecycleOptions) {}

	getActiveSession(): ActiveSession | undefined {
		return this.activeSession
	}

	setRunning(isRunning: boolean): void {
		const activeSession = this.activeSession
		if (!activeSession || activeSession.isRunning === isRunning) {
			return
		}
		activeSession.isRunning = isRunning
		if (!isRunning) {
			this.options.onDidBecomeIdle?.()
			// Snapshot before clearing: a resolver may re-enter (a superseded send
			// bails out here), and mutating the set while iterating it would skip
			// the remaining waiters.
			for (const notify of [...this.idleWaiters]) {
				notify()
			}
			this.idleWaiters.clear()
		}
	}

	/**
	 * Wait for `session` to leave the running state, up to `timeoutMs`.
	 *
	 * Resolves true when the transition happened, false on expiry. Expiry is not
	 * an error here: the caller decides how to finalise a turn the runtime never
	 * reported the end of. A session that is already idle - or gone, which only a
	 * superseded send can observe from here - has nothing left to wait for.
	 */
	private awaitSessionIdle(session: ActiveSession | undefined, timeoutMs: number): Promise<boolean> {
		if (!session?.isRunning) {
			return Promise.resolve(true)
		}
		return new Promise<boolean>((resolve) => {
			let settled = false
			const finish = (drained: boolean) => {
				if (settled) {
					return
				}
				settled = true
				clearTimeout(timer)
				this.idleWaiters.delete(onIdle)
				resolve(drained)
			}
			const timer = setTimeout(() => finish(false), timeoutMs)
			const onIdle = () => finish(true)
			this.idleWaiters.add(onIdle)
		})
	}

	private clearActiveSessionReference(): ActiveSession | undefined {
		const activeSession = this.activeSession
		this.activeSession = undefined
		return activeSession
	}

	async endActiveSession(
		reason: string,
		options: { awaitStop?: boolean; timeoutMs?: number } = {},
	): Promise<ActiveSession | undefined> {
		const activeSession = this.clearActiveSessionReference()
		if (!activeSession) {
			return undefined
		}

		this.safeUnsubscribe(activeSession, reason)
		const stopPromise = this.trackSessionStop(activeSession.sdkHost, activeSession.sessionId, reason)
		if (options.awaitStop) {
			const timeoutMs = options.timeoutMs ?? 3000
			const stopped = await this.waitForStop(stopPromise, timeoutMs)
			if (!stopped) {
				Logger.warn(
					`[SdkController] Timed out stopping SDK session ${activeSession.sessionId} after ${timeoutMs}ms (${reason})`,
				)
			}
		}
		return activeSession
	}

	async updateActiveSessionModel(modelId: string): Promise<boolean> {
		const activeSession = this.activeSession
		if (!activeSession?.sdkHost.updateSessionModel) {
			return false
		}

		await activeSession.sdkHost.updateSessionModel(activeSession.sessionId, modelId)
		return true
	}

	async startNewSession(
		startInput: Parameters<VscodeSessionHost["start"]>[0],
	): Promise<{ startResult: StartSessionResult; sdkHost: SdkSessionHost }> {
		if (this.activeSession) {
			await this.endActiveSession("startNewSession")
		}

		// Same-id starts must wait for the previous session's stop to finish;
		// see pendingStops. A fresh id cannot conflict, so it never waits.
		const requestedSessionId = startInput.config?.sessionId?.trim()
		const pendingStop = requestedSessionId ? this.pendingStops.get(requestedSessionId) : undefined
		if (pendingStop) {
			Logger.log(`[SdkController] Waiting for session ${requestedSessionId} to stop before restarting it`)
			await pendingStop
		}

		const autoApprovalSettings = StateManager.get().getGlobalSettingsKey("autoApprovalSettings")
		const toolPolicies = autoApprovalSettings ? buildToolPolicies(autoApprovalSettings, this.options.mcpHub) : undefined

		const sdkHost = await this.getOrCreateSharedHost()

		const startResult = await sdkHost.start({
			...startInput,
			...(toolPolicies ? { toolPolicies } : {}),
		})
		this.activeSession = {
			sessionId: startResult.sessionId,
			startConfig: startInput.config
				? {
						providerId: startInput.config.providerId,
						modelId: startInput.config.modelId,
					}
				: undefined,
			sdkHost,
			unsubscribe: () => {},
			startResult,
			isRunning: true,
		}

		return { startResult, sdkHost }
	}

	async replaceActiveSession(options: {
		expectedSession: ActiveSession
		startInput: Parameters<VscodeSessionHost["start"]>[0]
		initialMessages?: Parameters<VscodeSessionHost["start"]>[0]["initialMessages"]
		disposeReason: string
	}): Promise<
		| {
				oldSessionId: string
				startResult: StartSessionResult
				sdkHost: SdkSessionHost
		  }
		| undefined
	> {
		const oldSession = this.activeSession
		if (!oldSession || oldSession !== options.expectedSession || oldSession.isRunning) {
			return undefined
		}

		const { sessionId: oldSessionId } = oldSession

		// No need to await the stop here: callers reuse oldSessionId in the
		// startInput, and startNewSession waits on the pending stop for it.
		await this.endActiveSession(options.disposeReason)

		const { startResult, sdkHost } = await this.startNewSession({
			...options.startInput,
			...(options.initialMessages ? { initialMessages: options.initialMessages } : {}),
		})
		this.setRunning(false)

		return { oldSessionId, startResult, sdkHost }
	}

	async restoreActiveSession(input: RestoreInput): Promise<RestoreResult> {
		const activeSession = this.activeSession
		if (!activeSession) {
			throw new Error("No active SDK session to restore")
		}

		const sourceSessionId = activeSession.sessionId
		const restored = await activeSession.sdkHost.restore(input)
		if (!restored.startResult || !restored.sessionId) {
			return restored
		}

		this.activeSession = {
			...activeSession,
			sessionId: restored.sessionId,
			startConfig: input.start?.config
				? {
						providerId: input.start.config.providerId,
						modelId: input.start.config.modelId,
					}
				: activeSession.startConfig,
			startResult: restored.startResult,
			isRunning: false,
		}

		if (restored.sessionId !== sourceSessionId) {
			const stopPromise = this.trackSessionStop(activeSession.sdkHost, sourceSessionId, "restoreActiveSession")
			stopPromise.catch((error) => {
				Logger.warn(`[SdkController] Failed to stop source session after checkpoint restore: ${sourceSessionId}`, error)
			})
		}

		return restored
	}

	async dispose(reason = "SdkSessionLifecycle.dispose"): Promise<void> {
		await this.endActiveSession(reason, { awaitStop: true })

		const sharedHost = this.sharedHost ?? (await this.sharedHostPromise?.catch(() => undefined))
		this.sharedHost = undefined
		this.sharedHostPromise = undefined
		this.sharedHostUnsubscribe?.()
		this.sharedHostUnsubscribe = undefined
		await sharedHost?.dispose(reason)
	}

	private createSafeUnsubscribe(unsubscribe: () => void, label: string): () => void {
		let unsubscribed = false
		return () => {
			if (unsubscribed) {
				return
			}
			unsubscribed = true
			try {
				unsubscribe()
			} catch (error) {
				Logger.warn(`[SdkController] Failed to unsubscribe SDK session listener (${label}):`, error)
			}
		}
	}

	private safeUnsubscribe(activeSession: ActiveSession, reason: string): void {
		activeSession.unsubscribe()
		Logger.debug(`[SdkController] Unsubscribed SDK session listener: ${activeSession.sessionId} (${reason})`)
	}

	private ensureSharedHostSubscription(sdkHost: SdkSessionHost): void {
		if (this.sharedHostUnsubscribe) {
			return
		}
		this.sharedHostUnsubscribe = this.createSafeUnsubscribe(sdkHost.subscribe(this.options.onSessionEvent), "shared-host")
	}

	/**
	 * Starts the session's stop and records it in pendingStops until it
	 * settles. The returned promise never rejects.
	 */
	private trackSessionStop(sdkHost: SdkSessionHost, sessionId: string, reason: string): Promise<void> {
		const startedAt = Date.now()
		const stopPromise = sdkHost
			.stop(sessionId)
			.then(() => {
				const elapsed = Date.now() - startedAt
				if (elapsed > 250) {
					Logger.log(`[SdkController] SDK session ${sessionId} stopped in ${elapsed}ms (${reason})`)
				}
			})
			.catch((error: unknown) => {
				Logger.warn(`[SdkController] Failed to stop SDK session ${sessionId} (${reason}):`, error)
			})
			.finally(() => {
				if (this.pendingStops.get(sessionId) === stopPromise) {
					this.pendingStops.delete(sessionId)
				}
			})
		this.pendingStops.set(sessionId, stopPromise)
		return stopPromise
	}

	private async waitForStop(stopPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined
		try {
			const timeout = new Promise<"timeout">((resolve) => {
				timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs)
			})
			const result = await Promise.race([stopPromise.then(() => "stopped" as const), timeout])
			return result === "stopped"
		} finally {
			clearTimeout(timeoutHandle)
		}
	}

	private async getOrCreateSharedHost(): Promise<SdkSessionHost> {
		if (this.sharedHost) {
			this.ensureSharedHostSubscription(this.sharedHost)
			return this.sharedHost
		}
		if (!this.sharedHostPromise) {
			// Host-lifetime dependencies only. Anything task/session-specific must be
			// supplied to sdkHost.start(...), otherwise it can leak across reused sessions.
			this.sharedHostPromise = VscodeSessionHost.create({
				mcpHub: this.options.mcpHub,
				requestToolApproval: this.options.requestToolApproval,
				askQuestion: this.options.askQuestion,
				editorExecutor: this.options.editorExecutor,
				applyPatchExecutor: this.options.applyPatchExecutor,
				getTerminalManager: this.options.getTerminalManager,
				foregroundCommands: this.options.foregroundCommands,
				getRemoteConfigIntegration: this.options.getRemoteConfigIntegration,
				telemetry: this.options.telemetry,
			})
				.then((sdkHost) => {
					this.ensureSharedHostSubscription(sdkHost)
					this.sharedHost = sdkHost
					return sdkHost
				})
				.finally(() => {
					this.sharedHostPromise = undefined
				})
		}
		return this.sharedHostPromise
	}

	fireAndForgetSend(
		sdkHost: SdkSessionHost,
		sessionId: string,
		prompt: string,
		images?: string[],
		files?: string[],
		delivery?: "queue" | "steer",
	): void {
		// Captured by object identity, not sessionId: rebuilds (mode change) reuse
		// the same sessionId for the replacement session, so only reference
		// equality can tell this send's session apart from a successor. If the
		// session was replaced by the time the send settles, the settle callbacks
		// must not run bookkeeping against the successor (e.g. flipping a live
		// auto-continued run to isRunning=false, which makes the event coordinator
		// treat the new turn's completion as a cancelled-turn straggler).
		const sessionAtSend = this.activeSession
		const isSuperseded = (label: string): boolean => {
			if (this.activeSession === sessionAtSend) {
				return false
			}
			Logger.debug(`[SdkController] Ignoring ${label} of superseded send for session: ${sessionId}`)
			return true
		}
		// Mark a preceding user-initiated mode switch on this message so the model
		// sees exactly when the rules changed, instead of only inferring it from
		// the user_input mode attribute flipping (mirrors the CLI's
		// run-interactive stamping). The notice survives prepareTurnInput's
		// normalizeUserInput sanitize and is hidden from display surfaces by
		// stripModeNotices.
		const notice = this.options.consumeModeSwitchNotice?.(sessionId)
		const noticedPrompt = notice ? `${formatModeSwitchNotice(notice.from, notice.to)}\n${prompt}` : prompt
		this.options.onSendStart?.(sessionId)

		const attemptSend = (attempt: number): void => {
			sdkHost
				.send({
					sessionId,
					prompt: noticedPrompt,
					userImages: images,
					userFiles: files,
					delivery,
				})
				.then(async () => {
					if (delivery === "queue" || delivery === "steer") {
						Logger.log(`[SdkController] Message queued for session: ${sessionId}`)
						return
					}
					if (isSuperseded("completion")) {
						return
					}
					// Drain first. The terminal event carries how the turn ended, and
					// finalising from the promise alone overwrites it with a single
					// "completed" - so the event stream gets a bounded window to land
					// before anything local decides the phase.
					const drainTimeoutMs = this.options.turnDrainTimeoutMs ?? TURN_DRAIN_TIMEOUT_MS
					const drained = await this.awaitSessionIdle(sessionAtSend, drainTimeoutMs)
					if (isSuperseded("completion")) {
						return
					}
					if (drained) {
						Logger.log(`[SdkController] Agent turn completed for session: ${sessionId}`)
					} else {
						// No terminal event within the bound. Finalise here so the turn cannot
						// stay in `streaming` forever, and say so: the phase decided from this
						// point on is a guess, and a guessed phase that is never reported is how a
						// dead UI stays unexplained.
						Logger.warn(
							`[SdkController] Turn for ${sessionId} resolved with no terminal event after ` +
								`${drainTimeoutMs}ms; finalising the turn locally`,
						)
						this.setRunning(false)
					}
					await this.options.onSendComplete(sessionId)
				})
				.catch(async (error: unknown) => {
					if (isAbortError(error)) {
						Logger.debug(`[SdkController] Agent turn aborted (expected): ${sessionId}`)
						return
					}
					if (isSuperseded("failure")) {
						return
					}

					// ── Auto-retry for transient errors ─────────────────────
					// Policy and backoff come from @cline/llms so this host and the CLI
					// retry identically (see providers/transient-errors.ts).
					if (attempt < DEFAULT_PROVIDER_RETRY_POLICY.maxRetries && isTransientProviderError(error)) {
						const totalDelay = computeRetryDelayMs(attempt, DEFAULT_PROVIDER_RETRY_POLICY)
						const errorMsg = error instanceof Error ? error.message : String(error)
						Logger.warn(
							`[SdkController] Turn failed (attempt ${attempt + 1}/${DEFAULT_PROVIDER_RETRY_POLICY.maxRetries + 1}), retrying in ${totalDelay}ms: ${errorMsg}`,
						)
						this.options.onAutoRetry?.(attempt + 1, DEFAULT_PROVIDER_RETRY_POLICY.maxRetries, totalDelay, error)
						setTimeout(() => attemptSend(attempt + 1), totalDelay)
						return
					}

					// ── Non-retryable or exhausted retries ──────────────────
					Logger.error("[SdkController] Agent turn failed:", error)
					this.setRunning(false)
					await this.options.onSendError(error, sessionId)
				})
		}

		attemptSend(0)
	}
}

export function isAbortError(error: unknown): boolean {
	// NOTE: TIMEOUT is intentionally NOT treated as abort. Timeout errors
	// from net.ts (name === "TIMEOUT") are transient and must flow through
	// to the auto-retry path in fireAndForgetSend. Classifying them as
	// abort would silently swallow them: no retry, no setRunning(false),
	// leaving the UI stuck in a thinking state.
	if (error instanceof DOMException) {
		return error.name === "AbortError"
	}
	if (error instanceof Error) {
		return error.name === "AbortError" || error.message.toLowerCase().includes("aborted")
	}
	return false
}
