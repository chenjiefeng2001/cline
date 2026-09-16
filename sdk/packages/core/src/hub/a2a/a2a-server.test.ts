import { describe, expect, it, vi } from "vitest";
import {
	buildAgentCard,
	mapSessionStatusToTaskState,
	mapSessionToTask,
} from "./a2a-mapping";
import { type A2AHubCommandClient, A2AServer } from "./a2a-server";

describe("mapSessionStatusToTaskState", () => {
	it("maps hub session statuses onto the A2A state machine", () => {
		expect(mapSessionStatusToTaskState("idle")).toBe("submitted");
		expect(mapSessionStatusToTaskState("running")).toBe("working");
		expect(mapSessionStatusToTaskState("pending")).toBe("working");
		expect(mapSessionStatusToTaskState("completed")).toBe("completed");
		expect(mapSessionStatusToTaskState("failed")).toBe("failed");
		expect(mapSessionStatusToTaskState("cancelled")).toBe("canceled");
		expect(mapSessionStatusToTaskState("unknown")).toBe("submitted");
	});

	it("maps pending approval to input-required (HITL fit)", () => {
		expect(
			mapSessionStatusToTaskState("running", { hasPendingApproval: true }),
		).toBe("input-required");
		expect(
			mapSessionStatusToTaskState("idle", { hasPendingApproval: true }),
		).toBe("input-required");
		// Terminal states win over pending approval.
		expect(
			mapSessionStatusToTaskState("completed", { hasPendingApproval: true }),
		).toBe("completed");
	});
});

describe("mapSessionToTask", () => {
	it("projects a hub session record onto an A2A task", () => {
		const task = mapSessionToTask(
			{
				sessionId: "s1",
				status: "running",
				conversationId: "c1",
				source: "cli",
			},
			{ hasPendingApproval: false },
		);
		expect(task?.id).toBe("s1");
		expect(task?.contextId).toBe("c1");
		expect(task?.status.state).toBe("working");
		expect(task?.metadata?.sessionId).toBe("s1");
		expect(task?.metadata?.source).toBe("cli");
	});

	it("falls back to the session id for contextId and degrades on missing records", () => {
		const task = mapSessionToTask({ sessionId: "s2", status: "running" });
		expect(task?.contextId).toBe("s2");
		expect(mapSessionToTask(undefined)).toBeUndefined();
		expect(mapSessionToTask({ status: "running" })).toBeUndefined();
	});
});

describe("buildAgentCard", () => {
	it("declares hub-derived capabilities (streaming + push)", () => {
		const card = buildAgentCard({
			name: "cline-hub",
			description: "Cline hub agent",
			url: "https://hub.example/a2a",
			version: "1.0.0",
			skills: [{ id: "sessions", name: "Session management" }],
		});
		expect(card.name).toBe("cline-hub");
		expect(card.capabilities.streaming).toBe(true);
		expect(card.capabilities.pushNotifications).toBe(true);
		expect(card.defaultInputModes).toEqual(["text"]);
		expect(card.skills).toHaveLength(1);
	});
});

describe("A2AServer", () => {
	const makeClient = () => {
		const calls: Array<{
			command: string;
			payload?: unknown;
			sessionId?: string;
		}> = [];
		const replies = new Map<string, unknown>();
		const client: A2AHubCommandClient = {
			command: vi.fn(async (command, payload, sessionId) => {
				calls.push({ command, payload, sessionId });
				return replies.get(command) ?? { ok: true, payload: {} };
			}),
		};
		return { client, calls, replies };
	};

	const makeServer = (client: A2AHubCommandClient) =>
		new A2AServer(client, {
			agentCard: {
				name: "cline-hub",
				version: "1.0.0",
				url: "https://hub.example/a2a",
			},
		});

	it("serves the Agent Card from the constructor options", () => {
		const { client } = makeClient();
		const server = makeServer(client);
		const card = server.getAgentCard();
		expect(card.name).toBe("cline-hub");
		expect(card.capabilities.streaming).toBe(true);
	});

	it("routes message/send for a new prompt to session.create", async () => {
		const { client, calls, replies } = makeClient();
		replies.set("session.create", {
			ok: true,
			payload: {
				session: {
					sessionId: "new-1",
					status: "idle",
					metadata: { source: "a2a" },
				},
			},
		});
		const server = makeServer(client);
		const task = await server.sendMessage({
			prompt: "review the diff",
			source: "a2a",
		});
		expect(calls[0]?.command).toBe("session.create");
		expect(calls[0]?.payload).toMatchObject({
			metadata: { source: "a2a", prompt: "review the diff" },
		});
		expect(task?.id).toBe("new-1");
		expect(task?.status.state).toBe("submitted");
		expect(task?.metadata?.source).toBe("a2a");
	});

	it("routes message/send for an existing task to session.send_input", async () => {
		const { client, calls } = makeClient();
		const server = makeServer(client);
		const task = await server.sendMessage({
			prompt: "continue",
			sessionId: "s1",
		});
		expect(calls[0]?.command).toBe("session.send_input");
		expect(calls[0]?.payload).toMatchObject({ prompt: "continue" });
		expect(calls[0]?.sessionId).toBe("s1");
		expect(task?.id).toBe("s1");
		expect(task?.status.state).toBe("working");
	});

	it("maps tasks/get to session.get with pending-approval detection", async () => {
		const { client, calls, replies } = makeClient();
		replies.set("session.get", {
			ok: true,
			payload: {
				session: { sessionId: "s2", status: "running" },
				pendingApproval: true,
			},
		});
		const server = makeServer(client);
		const task = await server.getTask("s2");
		expect(calls[0]?.command).toBe("session.get");
		expect(calls[0]?.sessionId).toBe("s2");
		expect(task?.status.state).toBe("input-required");
		expect(task?.metadata?.pendingApproval).toBe(true);
	});

	it("returns undefined for a session.get miss instead of throwing", async () => {
		const { client } = makeClient();
		const server = makeServer(client);
		const task = await server.getTask("missing");
		expect(task).toBeUndefined();
	});

	it("maps tasks/cancel to run.abort", async () => {
		const { client, calls } = makeClient();
		const server = makeServer(client);
		const outcome = await server.cancelTask("s3");
		expect(outcome).toEqual({ canceled: true });
		expect(calls[0]?.command).toBe("run.abort");
		expect(calls[0]?.sessionId).toBe("s3");
	});

	it("maps tasks/list to session.list projections", async () => {
		const { client, calls, replies } = makeClient();
		replies.set("session.list", {
			ok: true,
			payload: {
				sessions: [
					{ sessionId: "s1", status: "running" },
					{ sessionId: "s2", status: "completed" },
					{ sessionId: "s3", status: "failed" },
				],
			},
		});
		const server = makeServer(client);
		const tasks = await server.listTasks({ limit: 10 });
		expect(calls[0]?.command).toBe("session.list");
		expect(calls[0]?.payload).toMatchObject({ limit: 10 });
		expect(tasks.map((task) => task.status.state)).toEqual([
			"working",
			"completed",
			"failed",
		]);
	});
});
