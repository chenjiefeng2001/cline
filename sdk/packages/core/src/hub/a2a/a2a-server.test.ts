import { describe, expect, it, vi } from "vitest";
import {
	buildAgentCard,
	mapSessionStatusToTaskState,
	mapSessionToTask,
} from "./a2a-mapping";
import { type A2AHubCommandClient, A2AServer } from "./a2a-server";

describe("mapSessionStatusToTaskState", () => {
	it("maps hub session statuses onto the A2A state machine", () => {
		expect(mapSessionStatusToTaskState("idle")).toBe("TASK_STATE_SUBMITTED");
		expect(mapSessionStatusToTaskState("running")).toBe("TASK_STATE_WORKING");
		expect(mapSessionStatusToTaskState("pending")).toBe("TASK_STATE_WORKING");
		expect(mapSessionStatusToTaskState("completed")).toBe(
			"TASK_STATE_COMPLETED",
		);
		expect(mapSessionStatusToTaskState("failed")).toBe("TASK_STATE_FAILED");
		expect(mapSessionStatusToTaskState("cancelled")).toBe(
			"TASK_STATE_CANCELED",
		);
		expect(mapSessionStatusToTaskState("unknown")).toBe("TASK_STATE_SUBMITTED");
	});

	it("maps pending approval to input-required (HITL fit)", () => {
		expect(
			mapSessionStatusToTaskState("running", { hasPendingApproval: true }),
		).toBe("TASK_STATE_INPUT_REQUIRED");
		expect(
			mapSessionStatusToTaskState("idle", { hasPendingApproval: true }),
		).toBe("TASK_STATE_INPUT_REQUIRED");
		// Terminal states win over pending approval.
		expect(
			mapSessionStatusToTaskState("completed", { hasPendingApproval: true }),
		).toBe("TASK_STATE_COMPLETED");
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
		expect(task?.status.state).toBe("TASK_STATE_WORKING");
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
	it("declares hub-derived capabilities and v1 discovery shape", () => {
		const card = buildAgentCard({
			name: "cline-hub",
			description: "Cline hub agent",
			url: "https://hub.example/a2a",
			version: "1.0.0",
			skills: [
				{
					id: "sessions",
					name: "Session management",
					description: "Manage sessions",
					tags: ["sessions"],
				},
			],
		});
		expect(card.name).toBe("cline-hub");
		expect(card.description).toBe("Cline hub agent");
		expect(card.supportedInterfaces).toEqual([
			{ url: "https://hub.example/a2a", protocolBinding: "JSONRPC" },
		]);
		expect(card).not.toHaveProperty("url");
		expect(card.capabilities.streaming).toBe(true);
		// No push delivery exists, so the card must not claim it (v1.0 §4.4.3).
		expect(card.capabilities.pushNotifications).toBe(false);
		expect(card.defaultInputModes).toEqual(["text"]);
		expect(card.skills).toHaveLength(1);
	});

	it("reflects the streaming flag when provided", () => {
		const card = buildAgentCard({
			name: "cline-hub",
			version: "1.0.0",
			streaming: false,
		});
		expect(card.capabilities.streaming).toBe(false);
		expect(card.capabilities.pushNotifications).toBe(false);
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
		// No event source bound → the card must not claim streaming.
		expect(card.capabilities.streaming).toBe(false);
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
		expect(task?.status.state).toBe("TASK_STATE_SUBMITTED");
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
		expect(task?.status.state).toBe("TASK_STATE_WORKING");
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
		expect(task?.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
		expect(task?.metadata?.pendingApproval).toBe(true);
	});

	it("returns undefined for a session.get miss instead of throwing", async () => {
		const { client } = makeClient();
		const server = makeServer(client);
		const task = await server.getTask("missing");
		expect(task).toBeUndefined();
	});

	it("maps CancelTask to run.abort and returns the task", async () => {
		const { client, calls, replies } = makeClient();
		replies.set("session.get", {
			ok: true,
			payload: { session: { sessionId: "s3", status: "running" } },
		});
		const server = makeServer(client);
		const outcome = await server.cancelTask("s3");
		expect(outcome.canceled).toBe(true);
		expect(outcome.task?.id).toBe("s3");
		expect(calls.map((call) => call.command)).toEqual([
			"session.get",
			"run.abort",
			"session.get",
		]);
		expect(calls[1]?.sessionId).toBe("s3");
	});

	it("reports a missing task as not canceled (→ TaskNotFound)", async () => {
		const { client, calls } = makeClient();
		const server = makeServer(client);
		const outcome = await server.cancelTask("missing");
		expect(outcome).toEqual({ canceled: false });
		expect(calls.map((call) => call.command)).toEqual(["session.get"]);
	});

	it("refuses to cancel an already-terminal task (→ TaskNotCancelable)", async () => {
		const { client, calls, replies } = makeClient();
		replies.set("session.get", {
			ok: true,
			payload: { session: { sessionId: "s3", status: "completed" } },
		});
		const server = makeServer(client);
		const outcome = await server.cancelTask("s3");
		expect(outcome.canceled).toBe(false);
		expect(outcome.task?.status.state).toBe("TASK_STATE_COMPLETED");
		expect(calls.map((call) => call.command)).toEqual(["session.get"]);
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
		const tasks = await server.listTasks({ pageSize: 10 });
		expect(calls[0]?.command).toBe("session.list");
		expect(calls[0]?.payload).toMatchObject({ limit: 10 });
		expect(tasks.map((task) => task.status.state)).toEqual([
			"TASK_STATE_WORKING",
			"TASK_STATE_COMPLETED",
			"TASK_STATE_FAILED",
		]);
	});

	it("filters ListTasks by contextId and status", async () => {
		const { client, replies } = makeClient();
		replies.set("session.list", {
			ok: true,
			payload: {
				sessions: [
					{
						sessionId: "s1",
						status: "running",
						metadata: { conversationId: "c1" },
					},
					{
						sessionId: "s2",
						status: "running",
						metadata: { conversationId: "c2" },
					},
				],
			},
		});
		const server = makeServer(client);
		const byContext = await server.listTasks({ contextId: "c2" });
		expect(byContext.map((task) => task.id)).toEqual(["s2"]);
		const byStatus = await server.listTasks({
			status: "TASK_STATE_COMPLETED",
		});
		expect(byStatus).toEqual([]);
	});
});
