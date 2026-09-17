import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	A2A_AGENT_CARD_WELL_KNOWN_PATH,
	type A2AHttpMountOptions,
	mountA2AHttpHandler,
} from "./a2a-http";
import type { A2AJsonRpcResponse } from "./a2a-jsonrpc";
import * as jsonrpc from "./a2a-jsonrpc";
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
import type { A2AStreamEvent } from "./a2a-sse";

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

const makeHttpExchange = () => {
	const req = Object.assign(new EventEmitter(), {
		url: "/a2a",
		method: "POST",
		headers: {} as Record<string, string>,
		aborted: false,
		destroyed: false,
		pause: vi.fn(),
		resume: vi.fn(),
	}) as unknown as http.IncomingMessage;
	const res = Object.assign(new EventEmitter(), {
		statusCode: 200,
		destroyed: false,
		writableEnded: false,
		setHeader: vi.fn(),
		flushHeaders: vi.fn(),
		write: vi.fn(),
		end: vi.fn(() => {
			Object.assign(res, { writableEnded: true });
		}),
	}) as unknown as http.ServerResponse;
	return { req, res };
};

const streamRequestBody = JSON.stringify({
	jsonrpc: "2.0",
	id: 31,
	method: "message/stream",
	params: textMessage("quiet stream"),
});

const createSseReader = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
	const decoder = new TextDecoder();
	let buffer = "";
	let ended = false;
	return async (): Promise<A2AStreamEvent | undefined> => {
		while (true) {
			const boundary = /\r?\n\r?\n/.exec(buffer);
			if (boundary) {
				const frame = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				const data = frame
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).replace(/^ /, ""));
				if (data.length > 0) {
					return JSON.parse(data.join("\n")) as A2AStreamEvent;
				}
				continue;
			}
			if (ended) {
				expect(buffer).toBe("");
				return undefined;
			}
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			ended = done;
		}
	};
};

const feedRequest = (req: http.IncomingMessage, body: string): void => {
	req.emit("data", Buffer.from(body));
	req.emit("end");
};

const expectBodyListenersRemoved = (req: http.IncomingMessage): void => {
	for (const event of ["data", "end", "error", "aborted"]) {
		expect(req.listenerCount(event)).toBe(0);
	}
};

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

describe("mountA2AHttpHandler — stream cleanup", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it.each([
		"terminal",
		"source error",
		"disconnect",
		"response error",
		"write error",
	])("clears heartbeat and subscription on %s", async (reason) => {
		vi.useFakeTimers();
		let finish: (error?: Error) => void = () => {};
		const cancel = vi.fn();
		vi.spyOn(jsonrpc, "createA2AJsonRpcHandler").mockReturnValue(async () => ({
			stream: true,
			contentType: "text/event-stream",
			subscribe: (_onFrame, onClose) => {
				finish = onClose;
				return cancel;
			},
		}));
		const { req, res } = makeHttpExchange();
		const handler = mountA2AHttpHandler({
			server: makeServer(makeClient().client),
		});
		const handled = handler(req, res);
		feedRequest(req, streamRequestBody);
		await handled;
		expect(res.flushHeaders).toHaveBeenCalledOnce();
		expect(res.write).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(14_999);
		expect(res.write).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(res.write).toHaveBeenCalledExactlyOnceWith(": ping\n\n");
		if (reason === "terminal") finish();
		else if (reason === "source error") finish(new Error("source failed"));
		else if (reason === "disconnect") res.emit("close");
		else if (reason === "response error")
			res.emit("error", new Error("socket failed"));
		else {
			vi.mocked(res.write).mockImplementation(() => {
				throw new Error("write failed");
			});
			await vi.advanceTimersByTimeAsync(15_000);
		}
		expect(cancel).toHaveBeenCalledOnce();
		expect(res.end).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(res.listenerCount("close")).toBe(0);
		expect(res.listenerCount("error")).toBe(0);
		expectBodyListenersRemoved(req);
		finish();
		expect(cancel).toHaveBeenCalledOnce();
	});

	it.each([
		"close",
		"error",
		"throw",
	])("does not leak on synchronous subscribe %s", async (reason) => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		vi.spyOn(jsonrpc, "createA2AJsonRpcHandler").mockReturnValue(async () => ({
			stream: true,
			contentType: "text/event-stream",
			subscribe: (_onFrame, onClose) => {
				if (reason === "throw") throw new Error("subscribe failed");
				onClose(reason === "error" ? new Error("source failed") : undefined);
				return cancel;
			},
		}));
		const { req, res } = makeHttpExchange();
		const handled = mountA2AHttpHandler({
			server: makeServer(makeClient().client),
		})(req, res);
		feedRequest(req, streamRequestBody);
		await handled;
		expect(cancel).toHaveBeenCalledTimes(reason === "throw" ? 0 : 1);
		expect(res.end).toHaveBeenCalledOnce();
		expect(res.write).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		expect(res.listenerCount("close")).toBe(0);
		expect(res.listenerCount("error")).toBe(0);
		expectBodyListenersRemoved(req);
	});
});

describe("mountA2AHttpHandler — body buffering", () => {
	it("decodes split UTF-8 once and accepts the exact byte limit", async () => {
		const { client, calls } = makeClient();
		const text = "café 漢字 𐐀";
		const body = Buffer.from(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "message/send",
				params: textMessage(text),
			}),
		);
		const { req, res } = makeHttpExchange();
		const handler = mountA2AHttpHandler({
			server: makeServer(client),
			maxBodyBytes: body.length,
		});
		const handled = handler(req, res);
		for (const byte of body) {
			req.emit("data", Buffer.from([byte]));
		}
		req.emit("end");
		expect(await handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(calls[0]?.payload).toMatchObject({ metadata: { prompt: text } });
		expectBodyListenersRemoved(req);
	});

	it("counts Unicode bytes rather than characters for chunked requests", async () => {
		const { client } = makeClient();
		const body = JSON.stringify({
			method: "tasks/get",
			params: { id: "漢字" },
		});
		const { req, res } = makeHttpExchange();
		const handler = mountA2AHttpHandler({
			server: makeServer(client),
			maxBodyBytes: body.length,
		});
		const handled = handler(req, res);
		req.emit("data", Buffer.from(body));
		expect(await handled).toBe(true);
		expect(res.statusCode).toBe(413);
		expect(req.pause).toHaveBeenCalledOnce();
		expect(client.command).not.toHaveBeenCalled();
		expectBodyListenersRemoved(req);
	});

	it("releases body listeners and avoids responding after an abort", async () => {
		const { client } = makeClient();
		const { req, res } = makeHttpExchange();
		const handled = mountA2AHttpHandler({ server: makeServer(client) })(
			req,
			res,
		);
		req.emit("data", Buffer.from('{"method":'));
		Object.assign(req, { aborted: true, destroyed: true });
		req.emit("aborted");
		expect(await handled).toBe(true);
		expectBodyListenersRemoved(req);
		expect(res.end).not.toHaveBeenCalled();
		expect(client.command).not.toHaveBeenCalled();
	});
});

describe("mountA2AHttpHandler — body limits", () => {
	let server: http.Server;
	let baseUrl: string;

	beforeAll(async () => {
		const { client } = makeClient();
		const handler = mountA2AHttpHandler({
			server: makeServer(client),
			maxBodyBytes: 16,
		});
		server = http.createServer((req, res) => {
			void handler(req, res).then((handled) => {
				if (!handled) {
					res.statusCode = 404;
					res.end("Not Found");
				}
			});
		});
		server.on("clientError", (_error, socket) => {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
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

	it("rejects a content-length above the configured limit", async () => {
		const response = await fetch(`${baseUrl}/a2a`, {
			method: "POST",
			body: "x".repeat(20),
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "request body too large" });
	});

	it.each([
		"content-length",
		"chunked",
	])("rejects oversized %s without waiting for the request to end", async (encoding) => {
		let request: http.ClientRequest | undefined;
		try {
			const response = await new Promise<http.IncomingMessage>(
				(resolve, reject) => {
					request = http.request(
						`${baseUrl}/a2a`,
						{
							method: "POST",
							headers:
								encoding === "content-length"
									? { "content-length": "17" }
									: { "transfer-encoding": "chunked" },
						},
						resolve,
					);
					request.on("error", reject);
					request.setTimeout(1000, () =>
						request?.destroy(new Error("response timeout")),
					);
					request.flushHeaders();
					if (encoding === "chunked") {
						request.write("x".repeat(8));
						request.write("y".repeat(9));
					}
				},
			);
			expect(response.statusCode).toBe(413);
			let body = "";
			for await (const chunk of response) {
				body += chunk.toString();
			}
			expect(JSON.parse(body)).toEqual({ error: "request body too large" });
		} finally {
			request?.destroy();
		}
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

	it("rejects content-length above the default 1 MiB limit", async () => {
		const response = await fetch(`${baseUrl}/a2a`, {
			method: "POST",
			body: "x".repeat(1024 * 1024 + 1),
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "request body too large" });
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
	const listeners = new Set<(event: unknown) => void>();
	const unsubscribe = vi.fn();

	beforeEach(() => {
		listeners.clear();
		unsubscribe.mockReset();
	});

	const startServer = async (
		options: Omit<A2AHttpMountOptions, "server"> = {},
	) => {
		const { client, replies } = makeClient();
		replies.set("session.create", {
			ok: true,
			payload: { session: { sessionId: "stream-1", status: "running" } },
		});
		const events = {
			subscribe: (listener: (event: never) => void) => {
				listeners.add(listener as (event: unknown) => void);
				return () => {
					unsubscribe();
					listeners.delete(listener as (event: unknown) => void);
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
		const handler = mountA2AHttpHandler({ server: a2aServer, ...options });
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
	};

	afterEach(async () => {
		if (server?.listening) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		}
	});

	it("streams status updates until the terminal event", async () => {
		await startServer();
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
		const readFrame = createSseReader(reader);
		expect(await readFrame()).toMatchObject({
			id: "stream-1",
			status: { state: "working" },
		});

		// Progress → working; terminal → final status-update and stream end.
		publish({
			version: "v1",
			event: "run.started",
			eventId: "hevt_2",
			sessionId: "stream-1",
			timestamp: Date.now(),
			payload: {},
		});
		expect(await readFrame()).toMatchObject({
			kind: "status-update",
			status: { state: "working" },
		});

		publish({
			version: "v1",
			event: "run.completed",
			eventId: "hevt_3",
			sessionId: "stream-1",
			timestamp: Date.now(),
			payload: {},
		});
		const finalFrame = (await readFrame()) as {
			status?: { state?: string };
			final?: boolean;
		};
		expect(finalFrame.status?.state).toBe("completed");
		expect(finalFrame.final).toBe(true);

		// The server closes the response after the final event.
		expect(await reader.read()).toEqual({ done: true, value: undefined });
	});

	it("ends an idle HTTP stream and detaches its subscription", async () => {
		await startServer({ idleTimeoutMs: 50, heartbeatIntervalMs: 0 });
		const response = await fetch(`${baseUrl}/a2a`, {
			method: "POST",
			body: streamRequestBody,
			signal: AbortSignal.timeout(2000),
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		const next = createSseReader(reader);
		expect(await next()).toMatchObject({ id: "stream-1" });
		expect(await next()).toBeUndefined();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(listeners.size).toBe(0);
	});

	it("delivers text chunks and the final artifact before HTTP EOF", async () => {
		await startServer({ heartbeatIntervalMs: 0 });
		const response = await fetch(`${baseUrl}/a2a`, {
			method: "POST",
			body: streamRequestBody,
			signal: AbortSignal.timeout(2000),
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing response body");
		const next = createSseReader(reader);
		await next();
		for (const text of ["Hello ", "世界"]) {
			publish({
				event: "assistant.delta",
				sessionId: "stream-1",
				payload: { text },
			});
		}
		publish({ event: "run.completed", sessionId: "stream-1", payload: {} });
		const received: A2AStreamEvent[] = [];
		for (let event = await next(); event; event = await next()) {
			received.push(event);
		}
		const artifacts = received.filter(
			(event) => "kind" in event && event.kind === "artifact-update",
		);
		expect(artifacts).toMatchObject([
			{
				append: false,
				lastChunk: false,
				artifact: {
					artifactId: "stream-1:output",
					parts: [{ text: "Hello " }],
				},
			},
			{
				append: true,
				lastChunk: false,
				artifact: { artifactId: "stream-1:output", parts: [{ text: "世界" }] },
			},
			{
				append: true,
				lastChunk: true,
				artifact: { artifactId: "stream-1:output" },
			},
		]);
		expect(received.at(-1)).toMatchObject({
			kind: "status-update",
			final: true,
		});
		expect(unsubscribe).toHaveBeenCalledTimes(1);
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
