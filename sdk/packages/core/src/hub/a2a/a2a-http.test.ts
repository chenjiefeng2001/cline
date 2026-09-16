import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	A2A_AGENT_CARD_WELL_KNOWN_PATH,
	mountA2AHttpHandler,
} from "./a2a-http";
import type { A2AJsonRpcResponse } from "./a2a-jsonrpc";
import {
	A2A_JSONRPC_INTERNAL_ERROR,
	A2A_JSONRPC_INVALID_PARAMS,
	A2A_JSONRPC_METHOD_NOT_FOUND,
	A2A_TASK_NOT_FOUND,
	createA2AJsonRpcHandler,
	extractA2ARequestPrompt,
	extractA2ARequestSessionId,
} from "./a2a-jsonrpc";
import type { A2AHubCommandClient } from "./a2a-server";
import { A2AServer } from "./a2a-server";

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
		agentCard: { name: "cline-hub", version: "1.0.0" },
	});

const asJsonRpc = (value: unknown): A2AJsonRpcResponse => {
	expect((value as { stream?: boolean }).stream).toBeUndefined();
	return value as A2AJsonRpcResponse;
};

const textMessage = (text: string, extra: Record<string, unknown> = {}) => ({
	message: {
		role: "user",
		parts: [{ kind: "text", text }],
		...extra,
	},
});

describe("extractA2ARequestPrompt", () => {
	it("joins text parts and trims", () => {
		expect(
			extractA2ARequestPrompt({
				message: {
					parts: [
						{ kind: "text", text: "line one" },
						{ kind: "text", text: "line two" },
					],
				},
			}),
		).toBe("line one\nline two");
		expect(extractA2ARequestPrompt({ message: { parts: [] } })).toBeUndefined();
		expect(extractA2ARequestPrompt(undefined)).toBeUndefined();
	});

	it("extracts taskId/contextId/sessionId", () => {
		expect(extractA2ARequestSessionId(textMessage("x", { taskId: "t1" }))).toBe(
			"t1",
		);
		expect(
			extractA2ARequestSessionId(textMessage("x", { contextId: "c1" })),
		).toBe("c1");
		expect(
			extractA2ARequestSessionId(textMessage("x", { sessionId: "s1" })),
		).toBe("s1");
		expect(extractA2ARequestSessionId(textMessage("x"))).toBeUndefined();
	});
});

describe("createA2AJsonRpcHandler", () => {
	it("dispatches message/send for a new prompt", async () => {
		const { client, calls, replies } = makeClient();
		replies.set("session.create", {
			ok: true,
			payload: { session: { sessionId: "new-1", status: "idle" } },
		});
		const handler = createA2AJsonRpcHandler(makeServer(client));
		const response = asJsonRpc(
			await handler({
				jsonrpc: "2.0",
				id: 1,
				method: "message/send",
				params: textMessage("review the diff"),
			}),
		);
		expect(calls[0]?.command).toBe("session.create");
		expect(response.result).toMatchObject({ id: "new-1" });
		expect(response.error).toBeUndefined();
	});

	it("dispatches message/send with a taskId to session.send_input", async () => {
		const { client, calls } = makeClient();
		const handler = createA2AJsonRpcHandler(makeServer(client));
		const response = asJsonRpc(
			await handler({
				jsonrpc: "2.0",
				id: 2,
				method: "message/send",
				params: textMessage("continue", { taskId: "s1" }),
			}),
		);
		expect(calls[0]?.command).toBe("session.send_input");
		expect(calls[0]?.sessionId).toBe("s1");
		expect(response.result).toMatchObject({ id: "s1" });
	});

	it("dispatches tasks/get, tasks/cancel, and tasks/list", async () => {
		const { client, calls, replies } = makeClient();
		replies.set("session.get", {
			ok: true,
			payload: { session: { sessionId: "s1", status: "running" } },
		});
		replies.set("session.list", {
			ok: true,
			payload: { sessions: [{ sessionId: "s1", status: "running" }] },
		});
		const handler = createA2AJsonRpcHandler(makeServer(client));

		const got = asJsonRpc(
			await handler({
				jsonrpc: "2.0",
				id: 3,
				method: "tasks/get",
				params: { id: "s1" },
			}),
		);
		expect(got.result).toMatchObject({
			id: "s1",
			status: { state: "working" },
		});

		const canceled = asJsonRpc(
			await handler({
				jsonrpc: "2.0",
				id: 4,
				method: "tasks/cancel",
				params: { id: "s1" },
			}),
		);
		expect(calls.find((call) => call.command === "run.abort")?.sessionId).toBe(
			"s1",
		);
		expect(canceled.result).toEqual({ canceled: true });

		const listed = asJsonRpc(
			await handler({
				jsonrpc: "2.0",
				id: 5,
				method: "tasks/list",
				params: { limit: 10 },
			}),
		);
		expect(Array.isArray(listed.result)).toBe(true);
	});

	it("returns -32001 for a tasks/get miss", async () => {
		const handler = createA2AJsonRpcHandler(makeServer(makeClient().client));
		const response = asJsonRpc(
			await handler({
				jsonrpc: "2.0",
				id: 6,
				method: "tasks/get",
				params: { id: "missing" },
			}),
		);
		expect(response.error?.code).toBe(A2A_TASK_NOT_FOUND);
	});

	it("returns -32601 for unknown methods and -32602 for invalid params", async () => {
		const handler = createA2AJsonRpcHandler(makeServer(makeClient().client));
		const unknown = asJsonRpc(
			await handler({
				jsonrpc: "2.0",
				id: 7,
				method: "nope",
			}),
		);
		expect(unknown.error?.code).toBe(A2A_JSONRPC_METHOD_NOT_FOUND);
		const noPrompt = asJsonRpc(
			await handler({
				jsonrpc: "2.0",
				id: 8,
				method: "message/send",
				params: { message: { parts: [] } },
			}),
		);
		expect(noPrompt.error?.code).toBe(A2A_JSONRPC_INVALID_PARAMS);
		const noId = asJsonRpc(
			await handler({
				jsonrpc: "2.0",
				id: 9,
				method: "tasks/get",
			}),
		);
		expect(noId.error?.code).toBe(A2A_JSONRPC_INVALID_PARAMS);
	});
});

describe("mountA2AHttpHandler", () => {
	let server: http.Server;
	let baseUrl: string;

	beforeAll(async () => {
		const { client, replies } = makeClient();
		replies.set("session.get", {
			ok: true,
			payload: { session: { sessionId: "s1", status: "completed" } },
		});
		const a2aServer = new A2AServer(
			client,
			{ agentCard: { name: "cline-hub", version: "1.0.0" } },
			// Event source bound → the Agent Card claims streaming and
			// `message/stream` is available.
			{ subscribe: () => () => {} },
		);
		const handler = mountA2AHttpHandler({ server: a2aServer });
		server = http.createServer((req, res) => {
			void handler(req, res).then((handled) => {
				if (!handled) {
					res.statusCode = 404;
					res.end("Not Found");
				}
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

	it("serves the Agent Card at the well-known path", async () => {
		const response = await fetch(
			`${baseUrl}/a2a/${A2A_AGENT_CARD_WELL_KNOWN_PATH}`,
		);
		expect(response.status).toBe(200);
		const card = (await response.json()) as Record<string, unknown>;
		expect(card.name).toBe("cline-hub");
		expect(card.capabilities).toMatchObject({
			streaming: true,
			pushNotifications: true,
		});
	});

	it("dispatches JSON-RPC over POST", async () => {
		const response = await fetch(`${baseUrl}/a2a`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 11,
				method: "tasks/get",
				params: { id: "s1" },
			}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result?: { id?: string; status?: { state?: string } };
		};
		expect(body.result?.id).toBe("s1");
		expect(body.result?.status?.state).toBe("completed");
	});

	it("responds with a parse error for malformed bodies", async () => {
		const response = await fetch(`${baseUrl}/a2a`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json at all",
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			error?: { code?: number };
		};
		expect(body.error?.code).toBe(-32700);
	});

	it("falls through for unmatched paths (handler returns false)", async () => {
		const response = await fetch(`${baseUrl}/other`);
		expect(response.status).toBe(404);
	});
});

describe("mountA2AHttpHandler — message/stream SSE", () => {
	let server: http.Server;
	let baseUrl: string;
	let publish: (event: unknown) => void;

	beforeAll(async () => {
		const { client, replies } = makeClient();
		replies.set("session.create", {
			ok: true,
			payload: { session: { sessionId: "stream-1", status: "running" } },
		});
		const listeners: Array<(event: unknown) => void> = [];
		const events = {
			subscribe: (listener: (event: never) => void) => {
				listeners.push(listener as (event: unknown) => void);
				return () => {
					const index = listeners.indexOf(listener as (event: unknown) => void);
					if (index >= 0) {
						listeners.splice(index, 1);
					}
				};
			},
		};
		publish = (event: unknown) => {
			for (const listener of listeners) {
				listener(event);
			}
		};
		const a2aServer = new A2AServer(
			client,
			{ agentCard: { name: "cline-hub", version: "1.0.0" } },
			events,
		);
		const handler = mountA2AHttpHandler({ server: a2aServer });
		server = http.createServer((req, res) => {
			void handler(req, res).then((handled) => {
				if (!handled) {
					res.statusCode = 404;
					res.end("Not Found");
				}
			});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

	it("streams status updates until the terminal event", async () => {
		const response = await fetch(`${baseUrl}/a2a`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 21,
				method: "message/stream",
				params: textMessage("stream this"),
			}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");

		// The initial task snapshot frame arrives immediately.
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("no response body");
		}
		const decoder = new TextDecoder();
		const readFrame = async (): Promise<string> => {
			const { value } = await reader.read();
			return decoder.decode(value);
		};
		const snapshot = JSON.parse(
			(await readFrame()).replace(/^data: /, "").trim(),
		) as { id?: string; status?: { state?: string } };
		expect(snapshot.id).toBe("stream-1");
		expect(snapshot.status?.state).toBe("working");

		// Progress → working; terminal → final status-update and stream end.
		publish({
			version: "v1",
			event: "run.started",
			eventId: "hevt_2",
			sessionId: "stream-1",
			timestamp: Date.now(),
			payload: {},
		});
		expect((await readFrame()).startsWith("data: ")).toBe(true);

		publish({
			version: "v1",
			event: "run.completed",
			eventId: "hevt_3",
			sessionId: "stream-1",
			timestamp: Date.now(),
			payload: {},
		});
		const finalFrame = JSON.parse(
			(await readFrame()).replace(/^data: /, "").trim(),
		) as { status?: { state?: string }; final?: boolean };
		expect(finalFrame.status?.state).toBe("completed");
		expect(finalFrame.final).toBe(true);

		// The server closes the response after the final event.
		await reader.cancel();
	});

	it("answers a JSON-RPC error envelope when streaming is unavailable", async () => {
		const { client } = makeClient();
		const a2aServer = makeServer(client);
		const handler = mountA2AHttpHandler({ server: a2aServer });
		const standalone = http.createServer((req, res) => {
			void handler(req, res).then((handled) => {
				if (!handled) {
					res.statusCode = 404;
					res.end("Not Found");
				}
			});
		});
		await new Promise<void>((resolve) => {
			standalone.listen(0, "127.0.0.1", () => resolve());
		});
		try {
			const address = standalone.address() as AddressInfo;
			const response = await fetch(`http://127.0.0.1:${address.port}/a2a`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 22,
					method: "message/stream",
					params: textMessage("no events bound"),
				}),
			});
			const body = (await response.json()) as {
				error?: { code?: number };
			};
			expect(body.error?.code).toBe(A2A_JSONRPC_INTERNAL_ERROR);
		} finally {
			await new Promise<void>((resolve) => {
				standalone.close(() => resolve());
			});
		}
	});
});
