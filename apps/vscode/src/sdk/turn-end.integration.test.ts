import type { CoreSessionEvent } from "@cline/core"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import { MessageIdMinter } from "./message-id-minter"
import { MessageTranslatorState, translateSessionEvent } from "./message-translator"
import { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { SdkSessionEventCoordinator } from "./sdk-session-event-coordinator"
import { SdkSessionLifecycle, TURN_DRAIN_TIMEOUT_MS } from "./sdk-session-lifecycle"
import { createTaskProxy } from "./task-proxy"
import { decideTurnEndPhase, TurnStateTracker } from "./turn-state-tracker"

/**
 * The turn end, with all three of its parts wired together.
 *
 * Each was testable alone and none of them was testable together, which is where the bug
 * lived: the drain, the event that ends the turn, and the decision about which phase to
 * land on had each been reasoned about in isolation, and the defect - the send promise
 * overwriting a phase the event stream had already chosen - was only visible across all
 * three. The Controller, which holds the last of them, needs the VS Code host, so the
 * decision it makes is now `decideTurnEndPhase`, a pure function this test can call with
 * the same input the Controller passes it.
 *
 * What is deliberately absent: the Controller. Everything asserted here is a real object
 * doing real work - a real lifecycle draining on a real idle transition, a real
 * translator, a real tracker. The only stand-in is the `sdkHost`, which is a resolved
 * promise, because a real one would mean a real model.
 */

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), log: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: () => ({ getGlobalSettingsKey: () => undefined }) },
}))

vi.mock("./vscode-session-host", () => ({
	VscodeSessionHost: {
		// The lifecycle builds its session through the real factory; only the transport is
		// replaced, because a real one would mean a real model behind it.
		create: vi.fn(async () => ({
			start: vi.fn(async () => ({ sessionId: "session-123" })),
			subscribe: vi.fn(() => () => {}),
			send: vi.fn(async () => undefined),
			stop: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		})),
	},
}))

function doneEvent(sessionId: string, finishReason: "completed" | "max_iterations", text: string): CoreSessionEvent {
	return {
		type: "agent_event",
		payload: {
			sessionId,
			event: { type: "done", reason: finishReason, text, iterations: 2 },
		},
	} as unknown as CoreSessionEvent
}

function makeTask(messages: ClineMessage[]) {
	// The real task proxy, not a hand-rolled stand-in: it owns the message list the
	// coordinator appends to and the anchor reads from, and a fake would have to
	// reimplement addMessages to make the test pass - which is how a test ends up
	// asserting against its own stub.
	const task = createTaskProxy("session-123", vi.fn(), vi.fn())
	task.messageStateHandler.addMessages(messages)
	return task
}

/**
 * A lifecycle, a coordinator and a tracker sharing one minter and one message list,
 * wired the way SdkController wires them.
 */
function makeTurnEndHarness(input: { messages: ClineMessage[]; turnDrainTimeoutMs?: number }) {
	const minter = new MessageIdMinter()
	const tracker = new TurnStateTracker(minter)
	const task = makeTask(input.messages)
	const translatorState = new MessageTranslatorState(minter)
	const posted: string[] = []
	// Every phase the turn went through, in order. The end state alone was not enough to
	// diagnose this: a bug that set the right phase twice, or set it and then overwrote it,
	// looks identical at the end and completely different in sequence.
	const phaseLog: string[] = []

	const sendComplete = vi.fn(async () => {
		// This is SdkController.onSendComplete's decision, with its two other duties
		// (discarding diff previews, posting state) left out - they cannot change the phase.
		const decision = decideTurnEndPhase(tracker.currentPhase)
		if (decision.action === "fallback") {
			tracker.set(decision.phase, task.messageStateHandler.getClineMessages().at(-1)?.ts)
		}
		posted.push(tracker.currentPhase)
	})

	const lifecycle = new SdkSessionLifecycle({
		// biome-ignore lint/suspicious/noExplicitAny: focused fake for this integration test
		mcpHub: {} as any,
		requestToolApproval: vi.fn(),
		askQuestion: vi.fn(),
		onSessionEvent: vi.fn(),
		onSendComplete: sendComplete,
		onSendError: vi.fn(),
		turnDrainTimeoutMs: input.turnDrainTimeoutMs,
	})

	const coordinator = new SdkSessionEventCoordinator({
		messageTranslatorState: translatorState,
		sessions: {
			// The coordinator's declared option type is the whole lifecycle; only these two
			// members are the contract it actually uses, and passing the real lifecycle
			// object is what makes this an integration test rather than a mock arrangement.
			getActiveSession: () => lifecycle.getActiveSession(),
			setRunning: (running: boolean) => lifecycle.setRunning(running),
			// biome-ignore lint/suspicious/noExplicitAny: the coordinator only calls updateTaskUsage
		} as any,
		messages: new SdkMessageCoordinator({ getTask: () => task }),
		taskHistory: {
			updateTaskUsage: vi.fn(),
			// biome-ignore lint/suspicious/noExplicitAny: the coordinator only calls updateTaskUsage
		} as any,
		getTask: () => task,
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		setTurnPhase: (phase, anchorTs) => {
			phaseLog.push(phase)
			tracker.set(phase, anchorTs)
		},
		translateSessionEvent: (event) => translateSessionEvent(event, translatorState),
	})

	return { lifecycle, coordinator, tracker, task, sendComplete, posted, phaseLog, translatorState }
}

type Harness = ReturnType<typeof makeTurnEndHarness>

/**
 * Start a session and fire a turn at it, leaving the tracker on `streaming`.
 *
 * Returns the session id. The three casts are the boundary of this test: a real session
 * needs a real model, so the inputs the lifecycle hands to the transport are stubs. What
 * is being tested - the drain, the event, the phase decision - is all real.
 */
async function startStreamingTurn(harness: Harness, prompt: string): Promise<string> {
	const { lifecycle, tracker } = harness
	await lifecycle.startNewSession({} as never)
	const session = lifecycle.getActiveSession()
	if (!session) {
		throw new Error("startNewSession did not produce an active session")
	}
	tracker.set("streaming")
	lifecycle.fireAndForgetSend({ send: vi.fn().mockResolvedValue(undefined) } as never, session.sessionId, prompt)
	return session.sessionId
}

describe("turn end: drain, event and phase decision together", () => {
	it("keeps awaiting_followup when the event lands before the send promise resolves", async () => {
		// The ordering the product actually runs in: the runtime dispatches `done`, then
		// persists session metadata and messages, then settles send(). Before the drain,
		// onSendComplete overwrote this with `completed`, so a turn the agent ended by
		// stopping was indistinguishable from one it declared finished.
		const messages: ClineMessage[] = [{ ts: 1, type: "say", say: "text", text: "here is what I found" }]
		const harness = makeTurnEndHarness({ messages })
		const sessionId = await startStreamingTurn(harness, "look into it")
		const { coordinator, tracker, sendComplete } = harness

		// The event arrives while the send promise is still in flight.
		await coordinator.handleSessionEvent(doneEvent(sessionId, "completed", "Here is what I found."))
		await vi.waitFor(() => expect(sendComplete).toHaveBeenCalledWith(sessionId))

		expect(tracker.currentPhase).toBe("awaiting_followup")
		expect(tracker.get().anchorTs).toBe(1)
	})

	it("keeps a limit stop on limit_reached rather than flattening it to completed", async () => {
		const messages: ClineMessage[] = [{ ts: 4, type: "say", say: "text", text: "still working" }]
		const harness = makeTurnEndHarness({ messages })
		const sessionId = await startStreamingTurn(harness, "keep going")
		const { coordinator, tracker, sendComplete, phaseLog, task } = harness

		await coordinator.handleSessionEvent(
			doneEvent(sessionId, "max_iterations", "Stopped after 50 iterations without reaching a final answer."),
		)
		await vi.waitFor(() => expect(sendComplete).toHaveBeenCalledWith(sessionId))

		// The sequence, not just the end state: the bug this guards against sets the right
		// phase and then overwrites it, which looks identical if you only look at the end.
		expect(phaseLog).toEqual(["limit_reached"])
		expect(tracker.currentPhase).toBe("limit_reached")
		// The explanation reached the transcript, which is the other half of the same fix.
		// Read from the task, not from the array that seeded it: the real message handler
		// owns the list and copies what it is given.
		expect(task.messageStateHandler.getClineMessages().at(-1)).toMatchObject({
			say: "text",
			text: "Stopped after 50 iterations without reaching a final answer.",
		})
	})

	it("falls back to completed, anchored, when no terminal event ever arrives", async () => {
		// The other ordering: send() settles and the runtime never says how the turn ended.
		// The drain expires, and the fallback is a guess - but the turn must not be left
		// in `streaming` with a live Cancel button, which is the failure the drain exists
		// to bound.
		const messages: ClineMessage[] = [{ ts: 9, type: "say", say: "text", text: "partial output" }]
		const harness = makeTurnEndHarness({ messages, turnDrainTimeoutMs: 10 })
		const { lifecycle, tracker, sendComplete, posted } = harness
		const sessionId = await startStreamingTurn(harness, "hello")
		await vi.waitFor(() => expect(sendComplete).toHaveBeenCalledWith(sessionId))

		expect(tracker.currentPhase).toBe("completed")
		// Anchored, so the footer has a stable identity rather than keying off a moving tail.
		expect(tracker.get().anchorTs).toBe(9)
		expect(lifecycle.getActiveSession()?.isRunning).toBe(false)
		expect(posted).toEqual(["completed"])
	})

	it("waits for the terminal event instead of finalising the instant send resolves", async () => {
		// The drain's actual job, asserted through the real objects: with the event slow
		// but arriving, the send promise must not have finalised the turn yet.
		const harness = makeTurnEndHarness({
			messages: [{ ts: 2, type: "say", say: "text", text: "answer" }],
			turnDrainTimeoutMs: 5_000,
		})
		const { coordinator, tracker, sendComplete } = harness
		const sessionId = await startStreamingTurn(harness, "hello")

		// send() has resolved by now, but nothing has declared the turn over.
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(sendComplete).not.toHaveBeenCalled()
		expect(tracker.currentPhase).toBe("streaming")

		await coordinator.handleSessionEvent(doneEvent(sessionId, "completed", "answer"))
		await vi.waitFor(() => expect(sendComplete).toHaveBeenCalledWith(sessionId))
		// `completed` needs the completion tool; a `done` without one is the agent
		// stopping, which is awaiting_followup. Asserted explicitly because getting this
		// wrong is exactly the confusion the phase exists to resolve.
		expect(tracker.currentPhase).toBe("awaiting_followup")
	})

	it("defaults the drain bound when no override is configured", () => {
		// The bound is a behavioural guarantee, not an implementation detail: it is what
		// stops a turn hanging in `streaming` forever. A test that overrode it everywhere
		// would keep passing if someone deleted the constant.
		expect(TURN_DRAIN_TIMEOUT_MS).toBeGreaterThan(0)
		expect(TURN_DRAIN_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
	})
})
