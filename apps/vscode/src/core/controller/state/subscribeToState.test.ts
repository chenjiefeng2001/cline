import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ExtensionState } from "@/shared/ExtensionMessage"

// The 1MB ceiling prepareStateForIpc() is written to stay under. This is the
// IPC limit; anything larger risks the transport dropping the frame, which
// leaves the webview with no state and therefore a blank panel.
const STATE_SIZE_HARD_LIMIT = 1024 * 1024

vi.mock("@/services/telemetry", () => ({
	telemetryService: { captureGrpcResponseSize: vi.fn() },
}))

const loggerSpy = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn(), info: vi.fn() }
vi.mock("@/shared/services/Logger", () => ({
	Logger: new Proxy(
		{},
		{
			get: (_t, prop: string) => (prop in loggerSpy ? loggerSpy[prop as keyof typeof loggerSpy] : vi.fn()),
		},
	),
}))

vi.mock("../grpc-handler", () => ({
	getRequestRegistry: () => ({ registerRequest: vi.fn(), unregisterRequest: vi.fn() }),
}))

type Captured = { stateJson: string; stateVersion?: number }

/**
 * Drive the real subscribeToState() with a synthetic state and capture exactly
 * what the webview would receive.
 */
async function captureStatePayload(state: ExtensionState): Promise<Captured> {
	const { subscribeToState, stateSubscriptionManager } = await import("./subscribeToState")
	const captured: Captured[] = []
	const controller = {
		getStateToPostToWebview: vi.fn(async () => state),
	}
	const stream = (async (msg: Captured) => {
		captured.push(msg)
		return msg
	}) as never

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	await subscribeToState(controller as any, {} as never, stream, undefined)

	stateSubscriptionManager.disposeAll()
	expect(captured.length).toBe(1)
	return captured[0]
}

/** One Cline message of roughly `textBytes` of assistant text. */
function bigMessage(i: number, textBytes: number) {
	return {
		ts: 1_700_000_000_000 + i,
		type: "say" as const,
		say: "text" as const,
		text: "x".repeat(textBytes),
		partial: false,
	}
}

function baseState(over: Partial<ExtensionState>): ExtensionState {
	return { welcomeViewCompleted: true, ...over } as unknown as ExtensionState
}

describe("subscribeToState state-size guard", () => {
	beforeEach(() => {
		loggerSpy.warn.mockClear()
		loggerSpy.error.mockClear()
	})

	it("keeps a huge clineMessages transcript under the IPC hard limit", async () => {
		// An extreme single session: 600 messages of 20KB each = ~12MB.
		const state = baseState({ clineMessages: Array.from({ length: 600 }, (_, i) => bigMessage(i, 20_000)) })
		const { stateJson } = await captureStatePayload(state)
		const bytes = Buffer.byteLength(stateJson, "utf8")
		console.log(`  transcript-only payload: ${(bytes / 1024).toFixed(1)}KB`)
		expect(bytes).toBeLessThanOrEqual(STATE_SIZE_HARD_LIMIT)
	})

	it("keeps the payload under the hard limit when the bulk is taskHistory, not messages", async () => {
		// taskHistory grows with the number of tasks in a workspace and is NOT
		// touched by truncateStateForIpc(), which only slices clineMessages.
		const taskHistory = Array.from({ length: 4000 }, (_, i) => ({
			id: `task-${i}-${"t".repeat(400)}`,
			ts: 1_700_000_000_000 + i,
			preview: "p".repeat(400),
			conversationHistory: [],
		}))
		const state = baseState({
			clineMessages: Array.from({ length: 600 }, (_, i) => bigMessage(i, 20_000)),
			taskHistory: taskHistory as unknown as ExtensionState["taskHistory"],
		})

		const { stateJson } = await captureStatePayload(state)
		const bytes = Buffer.byteLength(stateJson, "utf8")
		const parsed = JSON.parse(stateJson) as { taskHistory?: unknown[] }
		console.log(`  taskHistory-bulk payload: ${(bytes / 1024).toFixed(1)}KB`)
		console.log(`  taskHistory entries still delivered: ${parsed.taskHistory?.length ?? 0}`)
		console.log(`  CRITICAL logged by prepareStateForIpc: ${loggerSpy.error.mock.calls.length > 0}`)

		expect(bytes).toBeLessThanOrEqual(STATE_SIZE_HARD_LIMIT)
	})

	it("falls back to a fixed-size skeleton when no collection can be halved further", async () => {
		// remoteConfigSettings is a pass-through field: halving the transcript and
		// task history cannot shrink it, so the reducer must reach its allowlist
		// floor rather than looping forever or emitting an oversized payload.
		const state = baseState({
			version: "3.4.9",
			mode: "act" as ExtensionState["mode"],
			welcomeViewCompleted: true,
			clineMessages: Array.from({ length: 300 }, (_, i) => bigMessage(i, 5_000)),
			taskHistory: Array.from({ length: 500 }, (_, i) => ({
				id: `t-${i}`,
				ts: i,
				preview: "p".repeat(200),
			})) as unknown as ExtensionState["taskHistory"],
			remoteConfigSettings: { blob: "R".repeat(3 * STATE_SIZE_HARD_LIMIT) } as never,
		})

		const { stateJson } = await captureStatePayload(state)
		const bytes = Buffer.byteLength(stateJson, "utf8")
		const parsed = JSON.parse(stateJson) as Record<string, unknown>
		console.log(`  unshrinkable-field payload: ${(bytes / 1024).toFixed(1)}KB`)
		console.log(
			`  skeleton kept version=${parsed.version} mode=${parsed.mode}, dropped blob=${parsed.remoteConfigSettings === undefined}`,
		)

		expect(bytes).toBeLessThanOrEqual(STATE_SIZE_HARD_LIMIT)
		// The allowlisted identity/scale fields must survive so the UI still renders.
		expect(parsed.clineMessages).toEqual([])
		expect(parsed.taskHistory).toEqual([])
		expect(parsed.messageTruncated).toBe(true)
		expect(parsed.version).toBe("3.4.9")
		expect(parsed.mode).toBe("act")
	})
})
