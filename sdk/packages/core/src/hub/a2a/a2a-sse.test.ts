import type { HubEventEnvelope } from "@cline/shared";
import { assert, describe, expect, it, vi } from "vitest";
import type { A2AHubCommandClient } from "./a2a-server";
import { A2AServer } from "./a2a-server";
import {
	A2A_SSE_CONTENT_TYPE,
	type A2AArtifactUpdateEvent,
	type A2AStreamEvent,
	type A2ATaskStatusUpdateEvent,
	buildArtifactUpdateEvent,
	buildStatusUpdateEvent,
	formatA2ASseFrame,
	isTerminalA2ATaskState,
	mapHubEventToStreamDelta,
	mapHubEventToTaskState,
} from "./a2a-sse";
import type { A2ATask } from "./a2a-types";

describe("mapHubEventToTaskState", () => {
	it("maps progress and run lifecycle events to working", () => {
		for (const event of [
			"run.started",
			"run.heartbeat",
			"assistant.delta",
			"reasoning.delta",
			"tool.started",
			"tool.updated",
			"tool.finished",
			"approval.resolved",
		]) {
			expect(mapHubEventToTaskState(event)).toBe("TASK_STATE_WORKING");
		}
	});

	it("maps approval.requested to input-required", () => {
		expect(mapHubEventToTaskState("approval.requested")).toBe(
			"TASK_STATE_INPUT_REQUIRED",
		);
	});

	it("maps run terminals to A2A terminal states", () => {
		expect(mapHubEventToTaskState("run.completed")).toBe(
			"TASK_STATE_COMPLETED",
		);
		expect(mapHubEventToTaskState("run.failed")).toBe("TASK_STATE_FAILED");
		expect(mapHubEventToTaskState("run.aborted")).toBe("TASK_STATE_CANCELED");
	});

	it("returns undefined for unmapped events", () => {
		expect(mapHubEventToTaskState("usage.updated")).toBeUndefined();
		expect(mapHubEventToTaskState(undefined)).toBeUndefined();
	});
});

describe("isTerminalA2ATaskState", () => {
	it("accepts completed/failed/canceled/rejected and rejects the rest", () => {
		expect(isTerminalA2ATaskState("TASK_STATE_COMPLETED")).toBe(true);
		expect(isTerminalA2ATaskState("TASK_STATE_FAILED")).toBe(true);
		expect(isTerminalA2ATaskState("TASK_STATE_CANCELED")).toBe(true);
		expect(isTerminalA2ATaskState("TASK_STATE_REJECTED")).toBe(true);
		expect(isTerminalA2ATaskState("TASK_STATE_WORKING")).toBe(false);
		expect(isTerminalA2ATaskState("TASK_STATE_INPUT_REQUIRED")).toBe(false);
		expect(isTerminalA2ATaskState("TASK_STATE_SUBMITTED")).toBe(false);
		expect(isTerminalA2ATaskState("TASK_STATE_AUTH_REQUIRED")).toBe(false);
	});
});

describe("buildStatusUpdateEvent", () => {
	it("builds a status update with taskId as default contextId", () => {
		const event = buildStatusUpdateEvent("t1", "TASK_STATE_WORKING");
		expect(event).toMatchObject({
			taskId: "t1",
			contextId: "t1",
			status: { state: "TASK_STATE_WORKING" },
		});
		expect(event.status.timestamp).toBeTruthy();
		// v1.0 carries neither kind nor final (Appendix A.2.1).
		expect(event).not.toHaveProperty("kind");
		expect(event).not.toHaveProperty("final");
	});

	it("honors an explicit contextId", () => {
		const event = buildStatusUpdateEvent("t1", "TASK_STATE_COMPLETED", "c1");
		expect(event.contextId).toBe("c1");
	});
});

describe("artifact mapping", () => {
	it("maps only the producer's assistant text payload", () => {
		expect(
			mapHubEventToStreamDelta("assistant.delta", { text: "Hello\n " }),
		).toEqual({ statusState: "TASK_STATE_WORKING", artifactText: "Hello\n " });
		for (const payload of [
			undefined,
			{},
			{ text: 42 },
			{ text: "" },
			{ delta: "guessed" },
		]) {
			expect(mapHubEventToStreamDelta("assistant.delta", payload)).toEqual({
				statusState: "TASK_STATE_WORKING",
			});
		}
		for (const event of [
			"reasoning.delta",
			"reasoning.finished",
			"artifact.created",
			"diff.created",
		]) {
			expect(
				mapHubEventToStreamDelta(event, {
					text: "private",
					reasoning: "private",
				}).artifactText,
			).toBeUndefined();
		}
	});

	it("builds stable artifact IDs with explicit append and completion flags", () => {
		const first = buildArtifactUpdateEvent("t1", "Hello", { contextId: "c1" });
		const last = buildArtifactUpdateEvent("t1", "", {
			contextId: "c1",
			append: true,
			lastChunk: true,
		});
		expect(first).toEqual({
			taskId: "t1",
			contextId: "c1",
			artifact: {
				artifactId: "t1:output",
				name: "output",
				parts: [{ text: "Hello" }],
			},
			append: false,
			lastChunk: false,
		});
		expect(last.artifact.artifactId).toBe(first.artifact.artifactId);
		expect(last.append).toBe(true);
		expect(last.lastChunk).toBe(true);
	});
});

describe("formatA2ASseFrame", () => {
	it("frames JSON on a single data line", () => {
		const payload: A2ATask = {
			id: "t1",
			contextId: "t1",
			status: { state: "TASK_STATE_WORKING" },
		};
		const frame = formatA2ASseFrame(payload);
		expect(frame).toBe(`data: ${JSON.stringify(payload)}\n\n`);
		expect(frame).not.toContain("\r");
	});

	it("exposes the SSE content type constant", () => {
		expect(A2A_SSE_CONTENT_TYPE).toBe("text/event-stream");
	});
});

describe("A2AServer.streamMessage", () => {
	const hubEvent = (event: string, sessionId: string): HubEventEnvelope => ({
		version: "v1",
		event: event as HubEventEnvelope["event"],
		eventId: "hevt_1",
		sessionId,
		timestamp: Date.now(),
		payload: {},
	});

	const makeServer = () => {
		const calls: Array<{ command: string; sessionId?: string }> = [];
		const client: A2AHubCommandClient = {
			command: vi.fn(async (command, _payload, sessionId) => {
				calls.push({ command, sessionId });
				if (command === "session.create") {
					return {
						ok: true,
						payload: { session: { sessionId: "new-1", status: "idle" } },
					};
				}
				return { ok: true, payload: {} };
			}),
		};
		const listeners: Array<(event: HubEventEnvelope) => void> = [];
		const events = {
			subscribe: vi.fn((listener: (event: HubEventEnvelope) => void) => {
				listeners.push(listener);
				return vi.fn(() => {
					const index = listeners.indexOf(listener);
					if (index >= 0) {
						listeners.splice(index, 1);
					}
				});
			}),
		};
		const server = new A2AServer(
			client,
			{ agentCard: { name: "cline-hub", version: "1.0.0" } },
			events,
		);
		return { server, events, listeners, calls };
	};

	it("emits the initial snapshot then status updates until terminal", async () => {
		const { server, listeners, calls } = makeServer();
		const received: unknown[] = [];
		const unsubscribe = await server.streamMessage(
			{ prompt: "hello" },
			(event) => received.push(event),
		);
		expect(calls[0]?.command).toBe("session.create");

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			id: "new-1",
			status: { state: "TASK_STATE_SUBMITTED" },
		});

		const listener = listeners[0];
		assert(listener);
		listener(hubEvent("run.started", "new-1"));
		listener(hubEvent("run.completed", "new-1"));
		expect(received).toHaveLength(3);
		expect(received[1]).toMatchObject({
			taskId: "new-1",
			status: { state: "TASK_STATE_WORKING" },
		});
		expect(received[2]).toMatchObject({
			status: { state: "TASK_STATE_COMPLETED" },
		});

		expect(listeners).toHaveLength(0);
		listener(hubEvent("assistant.delta", "new-1"));
		expect(received).toHaveLength(3);
		unsubscribe();
	});

	it("approval.requested maps to input-required and keeps the stream open", async () => {
		const { server, listeners } = makeServer();
		const received: unknown[] = [];
		const unsubscribe = await server.streamMessage({ prompt: "go" }, (event) =>
			received.push(event),
		);
		listeners[0]?.(hubEvent("approval.requested", "new-1"));
		expect(received).toHaveLength(2);
		expect(received[1]).toMatchObject({
			status: { state: "TASK_STATE_INPUT_REQUIRED" },
		});
		expect(listeners).toHaveLength(1);
		listeners[0]?.(hubEvent("approval.resolved", "new-1"));
		expect(received).toHaveLength(3);
		expect(received[2]).toMatchObject({
			status: { state: "TASK_STATE_WORKING" },
		});
		expect(listeners).toHaveLength(1);
		unsubscribe();
	});

	it("unsubscribing mid-stream detaches and stops events", async () => {
		const { server, events, listeners } = makeServer();
		const received: unknown[] = [];
		const unsubscribe = await server.streamMessage({ prompt: "go" }, (event) =>
			received.push(event),
		);
		expect(events.subscribe).toHaveBeenCalledTimes(1);
		unsubscribe();
		expect(listeners).toHaveLength(0);
		listeners[0]?.(hubEvent("run.completed", "new-1"));
		expect(received).toHaveLength(1);
	});

	it("without an event source, sendMessage still resolves and no stream opens", async () => {
		const client: A2AHubCommandClient = {
			command: vi.fn(async () => ({
				ok: true,
				payload: { session: { sessionId: "s9", status: "idle" } },
			})),
		};
		const server = new A2AServer(client, {
			agentCard: { name: "cline-hub", version: "1.0.0" },
		});
		expect(server.supportsStreaming()).toBe(false);
		const received: unknown[] = [];
		const unsubscribe = await server.streamMessage({ prompt: "hi" }, (event) =>
			received.push(event),
		);
		expect(received).toHaveLength(0);
		expect(unsubscribe()).toBeUndefined();
	});

	it("idleTimeoutMs closes a stream that never reaches a terminal state", async () => {
		vi.useFakeTimers();
		try {
			const { server, listeners } = makeServer();
			const received: unknown[] = [];
			const unsubscribe = await server.streamMessage(
				{ prompt: "stall" },
				(event) => received.push(event),
				{ idleTimeoutMs: 50 },
			);
			listeners[0]?.(hubEvent("assistant.delta", "new-1"));
			await vi.advanceTimersByTimeAsync(100);
			expect(received.length).toBeGreaterThanOrEqual(2);
			listeners[0]?.(hubEvent("assistant.delta", "new-1"));
			expect(
				received.filter(
					(event) =>
						"taskId" in (event as object) && "status" in (event as object),
				),
			).toHaveLength(1);
			unsubscribe();
		} finally {
			vi.useRealTimers();
		}
	});

	it("fires onClose exactly once across terminal, idle, and manual close", async () => {
		const { server, listeners } = makeServer();
		const received: unknown[] = [];
		const onClose = vi.fn();
		const unsubscribe = await server.streamMessage(
			{ prompt: "hi" },
			(event) => received.push(event),
			{ idleTimeoutMs: 50, onClose },
		);
		listeners[0]?.(hubEvent("run.completed", "new-1"));
		unsubscribe();
		await vi.waitFor(() => {
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	it("fires onClose when the idle timer closes a stalled stream", async () => {
		vi.useFakeTimers();
		try {
			const { server } = makeServer();
			const onClose = vi.fn();
			const unsubscribe = await server.streamMessage(
				{ prompt: "stall" },
				() => {},
				{ idleTimeoutMs: 50, onClose },
			);
			await vi.advanceTimersByTimeAsync(100);
			expect(onClose).toHaveBeenCalledTimes(1);
			unsubscribe();
			expect(onClose).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("closes without hanging when the session cannot be created", async () => {
		const client: A2AHubCommandClient = {
			command: vi.fn(async () => ({
				ok: true,
				payload: {},
			})),
		};
		const server = new A2AServer(
			client,
			{ agentCard: { name: "cline-hub", version: "1.0.0" } },
			{ subscribe: () => () => {} },
		);
		const onClose = vi.fn();
		const received: unknown[] = [];
		const unsubscribe = await server.streamMessage(
			{ prompt: "hi" },
			(event) => received.push(event),
			{ onClose },
		);
		expect(received).toHaveLength(0);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(unsubscribe()).toBeUndefined();
	});

	it("closes without hanging when sendMessage rejects", async () => {
		const client: A2AHubCommandClient = {
			command: vi.fn(async () => {
				throw new Error("boom");
			}),
		};
		const server = new A2AServer(
			client,
			{ agentCard: { name: "cline-hub", version: "1.0.0" } },
			{ subscribe: () => () => {} },
		);
		const onClose = vi.fn();
		await expect(
			server.streamMessage({ prompt: "hi" }, () => {}, { onClose }),
		).rejects.toThrow("boom");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("handles a subscribe that throws synchronously", async () => {
		const { server } = makeServer();
		(server as unknown as { events: { subscribe: () => void } }).events = {
			subscribe: () => {
				throw new Error("subscribe boom");
			},
		};
		const received: unknown[] = [];
		const onClose = vi.fn();
		await expect(
			server.streamMessage({ prompt: "hi" }, (event) => received.push(event), {
				onClose,
			}),
		).rejects.toThrow("subscribe boom");
		expect(received).toHaveLength(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("does not leak reasoning payloads into the artifact stream", async () => {
		const { server, listeners } = makeServer();
		const received: A2AStreamEvent[] = [];
		const unsubscribe = await server.streamMessage({ prompt: "go" }, (event) =>
			received.push(event),
		);
		const reasoningEnvelope = hubEvent("reasoning.delta", "new-1");
		reasoningEnvelope.payload = {
			text: "secret-thoughts",
			reasoning: "secret-thoughts",
		};
		listeners[0]?.(reasoningEnvelope);
		expect(received).toHaveLength(2);
		expect(received[1]).toMatchObject({
			status: { state: "TASK_STATE_WORKING" },
		});
		expect(
			received.filter((event) => "artifact" in event && "taskId" in event),
		).toHaveLength(0);
		const assistantEnvelope = hubEvent("assistant.delta", "new-1");
		assistantEnvelope.payload = {
			text: "public",
			reasoning: "secret-thoughts",
			redacted: false,
		};
		listeners[0]?.(assistantEnvelope);
		const artifacts = received.filter(
			(event): event is A2AArtifactUpdateEvent =>
				"artifact" in event && "taskId" in event,
		);
		expect(received).toHaveLength(4);
		expect(artifacts).toEqual([
			{
				taskId: "new-1",
				contextId: "new-1",
				artifact: {
					artifactId: "new-1:output",
					name: "output",
					parts: [{ text: "public" }],
				},
				append: false,
				lastChunk: false,
			},
		]);
		expect(JSON.stringify(received)).not.toContain("secret-thoughts");
		unsubscribe();
	});

	it("streams two real text chunks with a stable artifact ID before terminal completion", async () => {
		const { server, listeners } = makeServer();
		const received: A2AStreamEvent[] = [];
		const onClose = vi.fn();
		const unsubscribe = await server.streamMessage(
			{ prompt: "go" },
			(event) => received.push(event),
			{ onClose },
		);
		const listener = listeners[0];
		assert(listener);
		for (const text of ["Hello", " world\n"]) {
			const envelope = hubEvent("assistant.delta", "new-1");
			envelope.payload = { text };
			listener(envelope);
		}
		expect(received).toHaveLength(5);
		expect(onClose).not.toHaveBeenCalled();
		listener(hubEvent("run.completed", "new-1"));
		expect(received).toMatchObject([
			{ id: "new-1", status: { state: "TASK_STATE_SUBMITTED" } },
			{
				artifact: {
					artifactId: "new-1:output",
					parts: [{ text: "Hello" }],
				},
				append: false,
				lastChunk: false,
			},
			{ status: { state: "TASK_STATE_WORKING" } },
			{
				artifact: {
					artifactId: "new-1:output",
					parts: [{ text: " world\n" }],
				},
				append: true,
				lastChunk: false,
			},
			{ status: { state: "TASK_STATE_WORKING" } },
			{
				artifact: {
					artifactId: "new-1:output",
					parts: [{ text: "" }],
				},
				append: true,
				lastChunk: true,
			},
			{ status: { state: "TASK_STATE_COMPLETED" } },
		]);
		expect(listeners).toHaveLength(0);
		listener(hubEvent("run.completed", "new-1"));
		expect(received).toHaveLength(7);
		unsubscribe();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("preserves the task contextId instead of the envelope sessionId", async () => {
		const { server, listeners } = makeServer();
		const received: A2AStreamEvent[] = [];
		const snapshot: A2ATask = {
			id: "task-9",
			contextId: "conversation-77",
			status: { state: "TASK_STATE_SUBMITTED" },
		};
		const unsubscribe = server.streamTask("task-9", snapshot, (event) =>
			received.push(event),
		);
		listeners[0]?.(hubEvent("run.started", "task-9"));
		const update = received.find(
			(event): event is A2ATaskStatusUpdateEvent =>
				"taskId" in event && "status" in event,
		);
		expect(update?.contextId).toBe("conversation-77");
		unsubscribe();
	});

	it("handles a synchronous terminal event during subscribe", async () => {
		const { server, events } = makeServer();
		const received: A2AStreamEvent[] = [];
		const onClose = vi.fn();
		const cleanup = vi.fn(() => {});
		events.subscribe.mockImplementationOnce(
			(listener: (event: HubEventEnvelope) => void) => {
				listener(hubEvent("run.completed", "new-1"));
				return cleanup;
			},
		);
		const unsubscribe = await server.streamMessage(
			{ prompt: "hi" },
			(event) => received.push(event),
			{ onClose },
		);
		expect(received).toHaveLength(2);
		expect(received[1]).toMatchObject({
			status: { state: "TASK_STATE_COMPLETED" },
		});
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(() => unsubscribe()).not.toThrow();
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("drops events whose envelope sessionId does not match the task", async () => {
		const { server, listeners } = makeServer();
		const received: A2AStreamEvent[] = [];
		await server.streamMessage({ prompt: "go" }, (event) =>
			received.push(event),
		);
		listeners[0]?.(hubEvent("run.started", "other-session"));
		expect(received).toHaveLength(1);
		listeners[0]?.(hubEvent("assistant.delta", "other-session"));
		expect(received).toHaveLength(1);
		listeners[0]?.(hubEvent("run.completed", "new-1"));
		expect(received).toHaveLength(2);
		expect(received[1]).toMatchObject({
			status: { state: "TASK_STATE_COMPLETED" },
		});
	});

	it("cleans up exactly once when onEvent throws", async () => {
		vi.useFakeTimers();
		try {
			const { server, events, listeners } = makeServer();
			const onClose = vi.fn();
			const onEvent = vi.fn();
			const unsubscribe = await server.streamMessage(
				{ prompt: "go" },
				onEvent,
				{ idleTimeoutMs: 50, onClose },
			);
			const cleanup = events.subscribe.mock.results[0]?.value;
			const listener = listeners[0];
			assert(listener);
			onEvent.mockImplementationOnce(() => {
				throw new Error("onEvent boom");
			});
			const envelope = hubEvent("assistant.delta", "new-1");
			envelope.payload = { text: "Hello" };
			expect(() => listener(envelope)).toThrow("onEvent boom");
			expect(cleanup).toHaveBeenCalledTimes(1);
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(listeners).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
			listener(hubEvent("run.completed", "new-1"));
			unsubscribe();
			await vi.advanceTimersByTimeAsync(100);
			expect(onEvent).toHaveBeenCalledTimes(2);
			expect(cleanup).toHaveBeenCalledTimes(1);
			expect(onClose).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reset the idle timeout for foreign-session events", async () => {
		vi.useFakeTimers();
		try {
			const { server, events, listeners } = makeServer();
			const onClose = vi.fn();
			const onEvent = vi.fn();
			const unsubscribe = await server.streamMessage(
				{ prompt: "stall" },
				onEvent,
				{ idleTimeoutMs: 50, onClose },
			);
			const cleanup = events.subscribe.mock.results[0]?.value;
			const listener = listeners[0];
			assert(listener);
			await vi.advanceTimersByTimeAsync(40);
			const envelope = hubEvent("assistant.delta", "other-session");
			envelope.payload = { text: "foreign text" };
			listener(envelope);
			listener(hubEvent("run.completed", "other-session"));
			expect(onEvent).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(9);
			expect(onClose).not.toHaveBeenCalled();
			expect(cleanup).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(cleanup).toHaveBeenCalledTimes(1);
			expect(listeners).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
			listener(hubEvent("run.started", "new-1"));
			unsubscribe();
			await vi.advanceTimersByTimeAsync(100);
			expect(onEvent).toHaveBeenCalledTimes(1);
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(cleanup).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
