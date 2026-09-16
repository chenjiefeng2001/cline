import type { HubEventEnvelope } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import type { A2AHubCommandClient } from "./a2a-server";
import { A2AServer } from "./a2a-server";
import {
	A2A_SSE_CONTENT_TYPE,
	buildStatusUpdateEvent,
	formatA2ASseFrame,
	isTerminalA2ATaskState,
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
			expect(mapHubEventToTaskState(event)).toBe("working");
		}
	});

	it("maps approval.requested to input-required", () => {
		expect(mapHubEventToTaskState("approval.requested")).toBe("input-required");
	});

	it("maps run terminals to A2A terminal states", () => {
		expect(mapHubEventToTaskState("run.completed")).toBe("completed");
		expect(mapHubEventToTaskState("run.failed")).toBe("failed");
		expect(mapHubEventToTaskState("run.aborted")).toBe("canceled");
	});

	it("returns undefined for unmapped events", () => {
		expect(mapHubEventToTaskState("usage.updated")).toBeUndefined();
		expect(mapHubEventToTaskState(undefined)).toBeUndefined();
	});
});

describe("isTerminalA2ATaskState", () => {
	it("accepts completed/failed/canceled and rejects the rest", () => {
		expect(isTerminalA2ATaskState("completed")).toBe(true);
		expect(isTerminalA2ATaskState("failed")).toBe(true);
		expect(isTerminalA2ATaskState("canceled")).toBe(true);
		expect(isTerminalA2ATaskState("working")).toBe(false);
		expect(isTerminalA2ATaskState("input-required")).toBe(false);
		expect(isTerminalA2ATaskState("submitted")).toBe(false);
	});
});

describe("buildStatusUpdateEvent", () => {
	it("builds a status-update with taskId as default contextId", () => {
		const event = buildStatusUpdateEvent("t1", "working", false);
		expect(event).toMatchObject({
			kind: "status-update",
			taskId: "t1",
			contextId: "t1",
			status: { state: "working" },
			final: false,
		});
		expect(event.status.timestamp).toBeTruthy();
	});

	it("honors an explicit contextId and final flag", () => {
		const event = buildStatusUpdateEvent("t1", "completed", true, "c1");
		expect(event.contextId).toBe("c1");
		expect(event.final).toBe(true);
	});
});

describe("formatA2ASseFrame", () => {
	it("frames JSON on a single data line", () => {
		const payload: A2ATask = {
			id: "t1",
			contextId: "t1",
			status: { state: "working" },
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
				return () => {
					const index = listeners.indexOf(listener);
					if (index >= 0) {
						listeners.splice(index, 1);
					}
				};
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

		// Initial snapshot (submitted, non-final) before any hub events.
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			id: "new-1",
			status: { state: "submitted" },
		});

		// Progress event → working (non-final); terminal event → completed.
		listeners[0]?.(hubEvent("run.started", "new-1"));
		listeners[0]?.(hubEvent("run.completed", "new-1"));
		expect(received).toHaveLength(3);
		expect(received[1]).toMatchObject({
			kind: "status-update",
			taskId: "new-1",
			status: { state: "working" },
			final: false,
		});
		expect(received[2]).toMatchObject({
			kind: "status-update",
			status: { state: "completed" },
			final: true,
		});

		// Terminal state detaches the listener.
		listeners[0]?.(hubEvent("assistant.delta", "new-1"));
		expect(received).toHaveLength(3);
		unsubscribe();
	});

	it("approval.requested maps to input-required and keeps the stream open", async () => {
		const { server, listeners } = makeServer();
		const received: unknown[] = [];
		await server.streamMessage({ prompt: "go" }, (event) =>
			received.push(event),
		);
		listeners[0]?.(hubEvent("approval.requested", "new-1"));
		expect(received[1]).toMatchObject({
			kind: "status-update",
			status: { state: "input-required" },
			final: false,
		});
		listeners[0]?.(hubEvent("approval.resolved", "new-1"));
		expect(received[2]).toMatchObject({
			kind: "status-update",
			status: { state: "working" },
			final: false,
		});
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
				received.filter((event) => "final" in (event as object)),
			).toHaveLength(1);
			unsubscribe();
		} finally {
			vi.useRealTimers();
		}
	});
});
