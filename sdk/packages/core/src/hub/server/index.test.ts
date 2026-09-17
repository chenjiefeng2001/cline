import { createServer as createHttpServer } from "node:http";
import {
	createConnection,
	createServer as createNetServer,
	type Socket,
} from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { A2AServer } from "../a2a";
import { createLocalHubScheduleRuntimeHandlers } from "../daemon/runtime-handlers";
import {
	clearHubDiscovery,
	createInMemoryHubOwnerContext,
	readHubDiscovery,
	toHubHealthUrl,
	writeHubDiscovery,
} from "../discovery";
import {
	ensureHubWebSocketServer,
	type HubWebSocketServer,
	startHubWebSocketServer,
} from "../server";

async function reservePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createNetServer();
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("Failed to reserve test port")));
				return;
			}
			const { port } = address;
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(port);
			});
		});
	});
}

async function sendRawHttpRequest(
	port: number,
	request: string,
): Promise<string> {
	return await new Promise((resolve, reject) => {
		let response = "";
		const socket = createConnection({ host: "127.0.0.1", port }, () => {
			socket.write(request);
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			response += chunk;
		});
		socket.on("end", () => {
			resolve(response);
		});
		socket.on("error", (error) => {
			reject(error);
		});
	});
}

function requireServer(
	server: HubWebSocketServer | undefined,
): HubWebSocketServer {
	expect(server).toBeDefined();
	if (!server) {
		throw new Error("Expected hub server to be defined");
	}
	return server;
}

describe("hub server startup", () => {
	const servers = new Set<HubWebSocketServer>();

	afterEach(async () => {
		for (const server of servers) {
			await server.close();
		}
		servers.clear();
	});

	it("starts on the requested port instead of drifting to a random port", async () => {
		const owner = createInMemoryHubOwnerContext("hub-server-test-fixed-port");
		const port = await reservePort();
		await writeHubDiscovery(owner.discoveryPath, {
			hubId: "stale-hub",
			protocolVersion: "v1",
			authToken: "stale-token",
			host: "127.0.0.1",
			port: port + 1,
			url: `ws://127.0.0.1:${port + 1}/hub`,
			startedAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		});

		const result = await ensureHubWebSocketServer({
			owner,
			host: "127.0.0.1",
			port,
			pathname: "/hub",
			runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
		});
		expect(result.url).toBe(`ws://127.0.0.1:${port}/hub`);
		expect(result.action).toBe("started");
		const server = requireServer(result.server);
		servers.add(server);

		await expect(readHubDiscovery(owner.discoveryPath)).resolves.toMatchObject({
			port,
			url: `ws://127.0.0.1:${port}/hub`,
		});
	});

	it("fails when the requested port is already occupied", async () => {
		const owner = createInMemoryHubOwnerContext("hub-server-test-port-busy");
		const port = await reservePort();
		const blocker = createNetServer();
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen({ host: "127.0.0.1", port }, () => resolve());
		});

		try {
			await expect(
				startHubWebSocketServer({
					owner,
					host: "127.0.0.1",
					port,
					pathname: "/hub",
					runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
				}),
			).rejects.toMatchObject({ code: "EADDRINUSE" });
			await expect(
				readHubDiscovery(owner.discoveryPath),
			).resolves.toBeUndefined();
		} finally {
			await new Promise<void>((resolve, reject) => {
				blocker.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
			await clearHubDiscovery(owner.discoveryPath);
		}
	});

	it("falls back to an ephemeral port when fallback is allowed", async () => {
		const owner = createInMemoryHubOwnerContext(
			"hub-server-test-port-fallback",
		);
		const port = await reservePort();
		const blockerSockets = new Set<Socket>();
		const blocker = createHttpServer((_req, res) => {
			res.statusCode = 404;
			res.setHeader("connection", "close");
			res.end("not a hub");
		});
		blocker.on("connection", (socket) => {
			blockerSockets.add(socket);
			socket.once("close", () => {
				blockerSockets.delete(socket);
			});
		});
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen({ host: "127.0.0.1", port }, () => resolve());
		});

		try {
			const result = await ensureHubWebSocketServer({
				owner,
				host: "127.0.0.1",
				port,
				pathname: "/hub",
				allowPortFallback: true,
				runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
			});

			expect(result.action).toBe("started");
			const server = requireServer(result.server);
			expect(server.port).not.toBe(port);
			servers.add(server);
		} finally {
			for (const socket of blockerSockets) {
				socket.destroy();
			}
			await new Promise<void>((resolve, reject) => {
				blocker.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
			await clearHubDiscovery(owner.discoveryPath);
		}
	});

	it("shuts down active server through the shutdown endpoint", async () => {
		const owner = createInMemoryHubOwnerContext("hub-server-test-shutdown");
		const result = await ensureHubWebSocketServer({
			owner,
			host: "127.0.0.1",
			port: 0,
			pathname: "/hub",
			runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
		});
		const server = requireServer(result.server);
		servers.add(server);

		const shutdownUrl = new URL(toHubHealthUrl(result.url));
		shutdownUrl.pathname = "/shutdown";
		const discovery = await readHubDiscovery(owner.discoveryPath);
		if (!discovery) {
			throw new Error("Expected hub discovery to be written");
		}
		expect(discovery.authToken).toMatch(/^[a-f0-9]{64}$/);
		const authToken = discovery.authToken;
		const response = await fetch(shutdownUrl, {
			method: "POST",
			headers: { authorization: `Bearer ${authToken}` },
		});
		expect(response.status).toBe(202);

		for (let index = 0; index < 50; index += 1) {
			if ((await readHubDiscovery(owner.discoveryPath)) === undefined) {
				servers.delete(server);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		throw new Error("Timed out waiting for hub shutdown");
	});

	it("rejects shutdown request with 401 when no auth token is provided", async () => {
		const owner = createInMemoryHubOwnerContext(
			"hub-server-test-shutdown-unauth",
		);
		const result = await ensureHubWebSocketServer({
			owner,
			host: "127.0.0.1",
			port: 0,
			pathname: "/hub",
			runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
		});
		servers.add(requireServer(result.server));

		const shutdownUrl = new URL(toHubHealthUrl(result.url));
		shutdownUrl.pathname = "/shutdown";

		// No Authorization header
		const noTokenResponse = await fetch(shutdownUrl, { method: "POST" });
		expect(noTokenResponse.status).toBe(401);

		// Wrong token
		const wrongTokenResponse = await fetch(shutdownUrl, {
			method: "POST",
			headers: { authorization: "Bearer wrong-token" },
		});
		expect(wrongTokenResponse.status).toBe(401);

		// Server should still be alive
		const health = await fetch(new URL("/health", toHubHealthUrl(result.url)));
		expect(health.status).toBe(200);
	});

	it("rejects WebSocket upgrade with 401 when no auth token is provided", async () => {
		const owner = createInMemoryHubOwnerContext("hub-server-test-ws-unauth");
		const result = await ensureHubWebSocketServer({
			owner,
			host: "127.0.0.1",
			port: 0,
			pathname: "/hub",
			runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
		});
		servers.add(requireServer(result.server));

		const hubUrl = new URL(result.url);

		// WebSocket upgrade with no Sec-WebSocket-Protocol token
		const response = await sendRawHttpRequest(
			Number(hubUrl.port),
			[
				"GET /hub HTTP/1.1",
				"Host: 127.0.0.1",
				"Connection: Upgrade",
				"Upgrade: websocket",
				"Sec-WebSocket-Version: 13",
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
				"",
				"",
			].join("\r\n"),
		);

		expect(response).toContain("401 Unauthorized");
	});

	it("survives websocket upgrade handler failures", async () => {
		const owner = createInMemoryHubOwnerContext(
			"hub-server-test-upgrade-guard",
		);
		const handleUpgrade = vi
			.spyOn(WebSocketServer.prototype, "handleUpgrade")
			.mockImplementation(() => {
				throw new Error("boom");
			});
		try {
			const result = await ensureHubWebSocketServer({
				owner,
				host: "127.0.0.1",
				port: 0,
				pathname: "/hub",
				runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
			});
			servers.add(requireServer(result.server));

			const hubUrl = new URL(result.url);
			const discovery = await readHubDiscovery(owner.discoveryPath);
			if (!discovery) {
				throw new Error("Expected hub discovery to be written");
			}
			const authToken = discovery.authToken;
			const response = await sendRawHttpRequest(
				Number(hubUrl.port),
				[
					"GET /hub HTTP/1.1",
					"Host: 127.0.0.1",
					"Connection: Upgrade",
					"Upgrade: websocket",
					`Sec-WebSocket-Protocol: cline-hub-auth.${authToken}`,
					"Sec-WebSocket-Version: 13",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					"",
					"",
				].join("\r\n"),
			);

			expect(response).toContain("400 Bad Request");

			const health = await fetch(
				new URL("/health", `http://127.0.0.1:${hubUrl.port}`),
			);
			expect(health.status).toBe(200);
		} finally {
			handleUpgrade.mockRestore();
		}
	});
});

describe("hub server A2A opt-in mount", () => {
	const servers = new Set<HubWebSocketServer>();

	afterEach(async () => {
		for (const server of servers) {
			await server.close();
		}
		servers.clear();
	});

	function a2aCardUrl(server: HubWebSocketServer): string {
		return `http://${server.host}:${server.port}/a2a/.well-known/agent-card.json`;
	}

	it("keeps A2A endpoints disabled by default", async () => {
		const result = await ensureHubWebSocketServer({
			owner: createInMemoryHubOwnerContext("hub-server-test-a2a-default-off"),
			host: "127.0.0.1",
			port: 0,
			pathname: "/hub",
			runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
		});
		const server = requireServer(result.server);
		servers.add(server);

		const discovery = await fetch(a2aCardUrl(server));
		expect(discovery.status).toBe(404);
	});

	it("rejects unauthenticated A2A discovery and RPC requests", async () => {
		const result = await ensureHubWebSocketServer({
			owner: createInMemoryHubOwnerContext("hub-server-test-a2a-unauth"),
			host: "127.0.0.1",
			port: 0,
			pathname: "/hub",
			runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
			a2a: { enabled: true },
		});
		const server = requireServer(result.server);
		servers.add(server);

		const discovery = await fetch(a2aCardUrl(server));
		expect(discovery.status).toBe(401);

		const rpc = await fetch(`http://${server.host}:${server.port}/a2a`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "ListTasks",
			}),
		});
		expect(rpc.status).toBe(401);
	});

	it("serves authenticated A2A discovery and RPC over the shared port", async () => {
		const result = await ensureHubWebSocketServer({
			owner: createInMemoryHubOwnerContext("hub-server-test-a2a-auth"),
			host: "127.0.0.1",
			port: 0,
			pathname: "/hub",
			runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
			a2a: { enabled: true },
		});
		const server = requireServer(result.server);
		servers.add(server);

		const authToken = server.authToken;
		const card = await fetch(a2aCardUrl(server), {
			headers: { authorization: `Bearer ${authToken}` },
		});
		expect(card.status).toBe(200);
		const agentCard = (await card.json()) as { name: string };
		expect(agentCard.name).toBe("Cline Hub");

		const rpc = await fetch(`http://${server.host}:${server.port}/a2a`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${authToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "ListTasks",
			}),
		});
		expect(rpc.status).toBe(200);
		const rpcBody = (await rpc.json()) as {
			result?: { tasks?: unknown[]; nextPageToken?: string };
		};
		expect(Array.isArray(rpcBody.result?.tasks)).toBe(true);
		expect(rpcBody.result?.nextPageToken).toBe("");
	});

	it("closes promptly with an active A2A SSE response", async () => {
		const result = await ensureHubWebSocketServer({
			owner: createInMemoryHubOwnerContext("hub-server-test-a2a-sse-close"),
			host: "127.0.0.1",
			port: 0,
			pathname: "/hub",
			runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
			a2a: { enabled: true },
		});
		const server = requireServer(result.server);
		servers.add(server);

		const send = vi
			.spyOn(A2AServer.prototype, "sendMessage")
			.mockResolvedValue({
				id: "shutdown-stream",
				contextId: "shutdown-stream",
				status: { state: "TASK_STATE_WORKING" },
			});
		try {
			const response = await fetch(`http://${server.host}:${server.port}/a2a`, {
				method: "POST",
				headers: { authorization: `Bearer ${server.authToken}` },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "SendStreamingMessage",
					params: { message: { parts: [{ kind: "text", text: "wait" }] } },
				}),
				signal: AbortSignal.timeout(3000),
			});
			expect(response.headers.get("content-type")).toBe("text/event-stream");
			const reader = response.body?.getReader();
			if (!reader) throw new Error("missing response body");
			expect((await reader.read()).done).toBe(false);
			const ended = reader.read().then(
				(value) => value.done,
				() => true,
			);
			await expect(server.close()).resolves.toBeUndefined();
			expect(await ended).toBe(true);
			servers.delete(server);
		} finally {
			send.mockRestore();
		}
	});
});
