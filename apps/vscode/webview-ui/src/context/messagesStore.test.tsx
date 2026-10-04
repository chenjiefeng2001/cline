import type { ClineMessage } from "@shared/ExtensionMessage"
import { act, render, screen } from "@testing-library/react"
import { createContext, useContext } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createReplicaState, applyMessage as reducerApplyMessage } from "@/components/chat/chat-view/messageReducer"
import {
	getMessagesSnapshot,
	getReplica,
	MessagesStateProvider,
	publishReplica,
	resetMessagesStore,
	setReplica,
	subscribeMessages,
	useMessagesState,
} from "./messagesStore"

/**
 * The transcript is published through an external store precisely so that streaming
 * traffic never re-renders `ExtensionStateContextProvider`.
 *
 * When the transcript was `useState` inside that provider, every delta / partial /
 * snapshot produced a new provider render and therefore a new `ExtensionStateContext`
 * value, waking all ~240 `useExtensionState()` consumers (111 files) plus every
 * visible message row — per frame, at an O(N) cost in the number of messages. A
 * handful of conversation rounds was enough to saturate the webview main thread and
 * the panel stopped refreshing.
 *
 * So the invariant worth locking down is NOT only "the list updates" — it is
 * "the list updates while the rest of the tree stays put".
 */

function makeMessage(ts: number, overrides: Partial<ClineMessage> = {}): ClineMessage {
	return {
		ts,
		type: "say",
		say: "text",
		text: `message ${ts}`,
		seq: ts,
		epoch: 1,
		...overrides,
	} as ClineMessage
}

beforeEach(() => {
	resetMessagesStore()
	// The store publishes through a frame coalescer backed by requestAnimationFrame.
	// Fake timers + a rAF stub make the flush deterministic instead of waiting on
	// real frames.
	vi.useFakeTimers()
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number)
	vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle as unknown as NodeJS.Timeout))
})

afterEach(() => {
	resetMessagesStore()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

/**
 * Run a store mutation, request a publish, and let the frame-coalesced flush land.
 * The mutation callback runs BEFORE the timers are advanced — `publishReplica()`
 * arms both the stubbed rAF and the 250ms stall net, so the advance has to follow it.
 */
async function publish(mutate: () => void) {
	await act(async () => {
		mutate()
		publishReplica()
		vi.advanceTimersByTime(1)
	})
}

describe("messages store emission", () => {
	it("emits when the transcript changes", async () => {
		const seen: number[] = []
		let previous = getMessagesSnapshot()
		const unsubscribe = subscribeMessages(() => {
			const next = getMessagesSnapshot()
			if (next !== previous) {
				previous = next
				seen.push(next.clineMessages.length)
			}
		})

		await publish(() => setReplica(reducerApplyMessage(createReplicaState(), makeMessage(1))))

		expect(seen).toEqual([1])
		unsubscribe()
	})

	it("does not emit when a no-op merge leaves the transcript identical", async () => {
		// The reducer returns the SAME state object for a stale/duplicate message, so
		// the store's reference comparison suppresses the emission entirely. This is
		// what stops a burst of duplicate or out-of-order frames from re-rendering.
		const base = reducerApplyMessage(createReplicaState(), makeMessage(1))

		const seen: number[] = []
		let previous = getMessagesSnapshot()
		const unsubscribe = subscribeMessages(() => {
			const next = getMessagesSnapshot()
			if (next !== previous) {
				previous = next
				seen.push(next.clineMessages.length)
			}
		})

		// Get the store's snapshot in sync with the replica first...
		await publish(() => setReplica(base))
		expect(seen).toEqual([1])

		// ...then a stale merge of the same ts (LOWER seq) is dropped by the reducer,
		// so re-publishing must not emit a second time.
		expect(reducerApplyMessage(base, makeMessage(1, { seq: 0 }))).toBe(base)
		await publish(() => publishReplica())

		expect(seen).toEqual([1])
		unsubscribe()
	})

	it("drops the transcript and cancels pending flushes on reset", async () => {
		setReplica(reducerApplyMessage(createReplicaState(), makeMessage(1)))
		publishReplica()
		resetMessagesStore()

		expect(getMessagesSnapshot().clineMessages).toEqual([])
		expect(getReplica()).toEqual(createReplicaState())
	})
})

describe("MessagesStateProvider isolation", () => {
	// A stand-in for the low-frequency outer context. What is under test is React's
	// behaviour — a child provider that re-renders must not drag an unchanged
	// `children` subtree along with it — so any outer context demonstrates it, and
	// using a local one keeps this test independent of the gRPC client graph.
	const OuterContext = createContext<{ version: number }>({ version: 0 })

	let outerRenders = 0
	let messageRenders = 0

	function OuterConsumer() {
		outerRenders++
		const { version } = useContext(OuterContext)
		return <span data-testid="outer">{version}</span>
	}

	function MessageConsumer() {
		messageRenders++
		const { clineMessages } = useMessagesState()
		return <span data-testid="messages">{clineMessages.length}</span>
	}

	beforeEach(() => {
		outerRenders = 0
		messageRenders = 0
	})

	it("updates MessagesStateContext consumers without re-rendering the outer subtree", async () => {
		render(
			<OuterContext.Provider value={{ version: 1 }}>
				<MessagesStateProvider>
					<OuterConsumer />
					<MessageConsumer />
				</MessagesStateProvider>
			</OuterContext.Provider>,
		)

		expect(screen.getByTestId("outer")).toHaveTextContent("1")
		expect(screen.getByTestId("messages")).toHaveTextContent("0")
		const outerRendersAfterMount = outerRenders
		const messageRendersAfterMount = messageRenders

		await publish(() => setReplica(reducerApplyMessage(getReplica(), makeMessage(1))))

		// The transcript advanced...
		expect(screen.getByTestId("messages")).toHaveTextContent("1")
		expect(messageRenders).toBeGreaterThan(messageRendersAfterMount)
		// ...and nothing that does not read MessagesStateContext re-rendered. This is
		// the assertion that would have caught the original regression.
		expect(outerRenders).toBe(outerRendersAfterMount)
	})
})
