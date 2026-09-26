import type { HubReplyEnvelope } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWebSocketHubAdapter } from "./browser-websocket";

function createSocket() {
	const messageListeners = new Set<(event: { data: string }) => void>();
	const closeListeners = new Set<() => void>();
	return {
		sent: [] as string[],
		send(data: string) {
			this.sent.push(data);
		},
		addEventListener(
			type: "message" | "close",
			listener: ((event: { data: string }) => void) | (() => void),
		) {
			if (type === "message") {
				messageListeners.add(listener as (event: { data: string }) => void);
				return;
			}
			closeListeners.add(listener as () => void);
		},
		removeEventListener(
			type: "message" | "close",
			listener: ((event: { data: string }) => void) | (() => void),
		) {
			if (type === "message") {
				messageListeners.delete(listener as (event: { data: string }) => void);
				return;
			}
			closeListeners.delete(listener as () => void);
		},
		emitMessage(data: string) {
			for (const listener of messageListeners) {
				void listener({ data });
			}
		},
		emitClose() {
			for (const listener of closeListeners) {
				listener();
			}
		},
	};
}

describe("BrowserWebSocketHubAdapter", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("ignores malformed websocket frames instead of throwing", async () => {
		const transport = {
			command: vi.fn(),
			subscribe: vi.fn(),
		};
		const socket = createSocket();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const adapter = new BrowserWebSocketHubAdapter(transport);
			adapter.attach(socket);

			await expect(async () => {
				socket.emitMessage("{bad json");
				await Promise.resolve();
			}).not.toThrow();

			expect(transport.command).not.toHaveBeenCalled();
			expect(socket.sent).toHaveLength(0);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'"message":"rejected malformed websocket frame"',
				),
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("keeps run.start open past the default command timeout", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		let resolveCommand: ((reply: HubReplyEnvelope) => void) | undefined;
		const transport = {
			command: vi.fn(
				async (envelope: { command: string }): Promise<HubReplyEnvelope> => {
					if (envelope.command === "client.register") {
						return {
							version: "v1",
							requestId: "req-register",
							ok: true,
							payload: { clientId: "client-1" },
						};
					}
					return new Promise<HubReplyEnvelope>((resolve) => {
						resolveCommand = resolve;
					});
				},
			),
			subscribe: vi.fn(),
		};
		const socket = createSocket();
		const adapter = new BrowserWebSocketHubAdapter(transport);
		adapter.attach(socket);

		// The connection must register before it can issue any other command:
		// `envelope.clientId` is otherwise an unauthenticated self-report.
		socket.emitMessage(
			JSON.stringify({
				kind: "command",
				envelope: {
					version: "v1",
					command: "client.register",
					requestId: "req-register",
					clientId: "client-1",
					payload: { clientId: "client-1" },
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(0);

		socket.emitMessage(
			JSON.stringify({
				kind: "command",
				envelope: {
					version: "v1",
					command: "run.start",
					requestId: "req-run",
					clientId: "client-1",
					sessionId: "session-1",
					payload: { input: "hello" },
				},
			}),
		);

		await vi.advanceTimersByTimeAsync(30_001);
		expect(socket.sent.map((entry) => JSON.parse(entry))).not.toContainEqual(
			expect.objectContaining({
				kind: "reply",
				envelope: expect.objectContaining({ requestId: "req-run" }),
			}),
		);

		resolveCommand?.({
			version: "v1",
			requestId: "req-run",
			ok: true,
			payload: { result: { finishReason: "completed" } },
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
			kind: "reply",
			envelope: {
				version: "v1",
				requestId: "req-run",
				ok: true,
				payload: { result: { finishReason: "completed" } },
			},
		});
	});

	it("applies the default command timeout to fast commands", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const transport = {
			command: vi.fn(
				async (envelope: { command: string }): Promise<HubReplyEnvelope> => {
					if (envelope.command === "client.register") {
						return {
							version: "v1",
							requestId: "req-register",
							ok: true,
							payload: { clientId: "client-1" },
						};
					}
					return new Promise<HubReplyEnvelope>(() => {});
				},
			),
			subscribe: vi.fn(),
		};
		const socket = createSocket();
		const adapter = new BrowserWebSocketHubAdapter(transport);
		adapter.attach(socket);

		socket.emitMessage(
			JSON.stringify({
				kind: "command",
				envelope: {
					version: "v1",
					command: "client.register",
					requestId: "req-register",
					clientId: "client-1",
					payload: { clientId: "client-1" },
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(0);

		socket.emitMessage(
			JSON.stringify({
				kind: "command",
				envelope: {
					version: "v1",
					command: "client.list",
					requestId: "req-list",
					clientId: "client-1",
				},
			}),
		);

		await vi.advanceTimersByTimeAsync(30_001);

		expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
			kind: "reply",
			envelope: {
				version: "v1",
				requestId: "req-list",
				ok: false,
				error: {
					code: "hub_command_timeout",
					message:
						"Hub command client.list did not complete within 30000ms. Check hub-daemon.log for command.start/command.slow logs with requestId req-list.",
				},
			},
		});
	});
});

describe("BrowserWebSocketHubAdapter connection identity", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function createTransport() {
		return {
			command: vi.fn(
				async (envelope: {
					command: string;
					clientId?: string;
				}): Promise<HubReplyEnvelope> => ({
					version: "v1",
					requestId: "req",
					ok: true,
					payload: { clientId: envelope.clientId },
				}),
			),
			subscribe: vi.fn(() => () => {}),
		};
	}

	async function register(
		transport: ReturnType<typeof createTransport>,
		socket: ReturnType<typeof createSocket>,
		clientId: string,
	): Promise<void> {
		socket.emitMessage(
			JSON.stringify({
				kind: "command",
				envelope: {
					version: "v1",
					command: "client.register",
					requestId: `req-register-${clientId}`,
					clientId,
					payload: { clientId },
				},
			}),
		);
		await Promise.resolve();
		await Promise.resolve();
		// Registration is the only command a fresh connection may issue; clear it
		// so later assertions only see post-registration traffic.
		transport.command.mockClear();
		socket.sent.length = 0;
	}

	function replies(socket: ReturnType<typeof createSocket>) {
		return socket.sent
			.map((entry) => JSON.parse(entry))
			.filter((frame) => frame.kind === "reply")
			.map((frame) => frame.envelope);
	}

	it("refuses commands from a connection that never registered", async () => {
		const transport = createTransport();
		const socket = createSocket();
		new BrowserWebSocketHubAdapter(transport).attach(socket);

		socket.emitMessage(
			JSON.stringify({
				kind: "command",
				envelope: {
					version: "v1",
					command: "session.list",
					requestId: "req-list",
					clientId: "client-1",
				},
			}),
		);
		await Promise.resolve();

		expect(transport.command).not.toHaveBeenCalled();
		expect(replies(socket)).toContainEqual(
			expect.objectContaining({
				requestId: "req-list",
				ok: false,
				error: expect.objectContaining({ code: "hub_unregistered_client" }),
			}),
		);
	});

	it("refuses to act as a different client than the one registered", async () => {
		const transport = createTransport();
		const socket = createSocket();
		new BrowserWebSocketHubAdapter(transport).attach(socket);
		await register(transport, socket, "client-1");

		socket.emitMessage(
			JSON.stringify({
				kind: "command",
				envelope: {
					version: "v1",
					command: "approval.respond",
					requestId: "req-spoof",
					clientId: "client-admin",
					sessionId: "session-1",
				},
			}),
		);
		await Promise.resolve();

		expect(transport.command).not.toHaveBeenCalled();
		expect(replies(socket)).toContainEqual(
			expect.objectContaining({
				requestId: "req-spoof",
				ok: false,
				error: expect.objectContaining({ code: "hub_client_id_mismatch" }),
			}),
		);
	});

	it("stamps the bound identity when a client omits clientId", async () => {
		const transport = createTransport();
		const socket = createSocket();
		new BrowserWebSocketHubAdapter(transport).attach(socket);
		await register(transport, socket, "client-1");

		socket.emitMessage(
			JSON.stringify({
				kind: "command",
				envelope: {
					version: "v1",
					command: "session.list",
					requestId: "req-list",
				},
			}),
		);
		await Promise.resolve();
		await Promise.resolve();

		expect(transport.command).toHaveBeenLastCalledWith(
			expect.objectContaining({
				command: "session.list",
				clientId: "client-1",
			}),
			expect.objectContaining({ connectionId: expect.any(String) }),
		);
	});

	it("refuses to subscribe on behalf of another client", async () => {
		const transport = createTransport();
		const socket = createSocket();
		new BrowserWebSocketHubAdapter(transport).attach(socket);
		await register(transport, socket, "client-1");

		socket.emitMessage(
			JSON.stringify({
				kind: "stream.subscribe",
				clientId: "client-admin",
				sessionId: "session-1",
			}),
		);
		await Promise.resolve();

		expect(transport.subscribe).not.toHaveBeenCalled();
		expect(replies(socket)).toContainEqual(
			expect.objectContaining({
				ok: false,
				error: expect.objectContaining({ code: "hub_client_id_mismatch" }),
			}),
		);
	});

	it("subscribes as the bound client and unregisters it on close", async () => {
		const transport = createTransport();
		const socket = createSocket();
		new BrowserWebSocketHubAdapter(transport).attach(socket);
		await register(transport, socket, "client-1");

		socket.emitMessage(
			JSON.stringify({
				kind: "stream.subscribe",
				clientId: "client-1",
				sessionId: "session-1",
			}),
		);
		await Promise.resolve();
		expect(transport.subscribe).toHaveBeenCalledWith(
			"client-1",
			expect.any(Function),
			{ sessionId: "session-1" },
		);

		socket.emitClose();
		await Promise.resolve();
		expect(transport.command).toHaveBeenLastCalledWith(
			expect.objectContaining({
				command: "client.unregister",
				clientId: "client-1",
			}),
			expect.objectContaining({ connectionId: expect.any(String) }),
		);
	});

	it("requires re-registration after the connection unregisters", async () => {
		const transport = createTransport();
		const socket = createSocket();
		new BrowserWebSocketHubAdapter(transport).attach(socket);
		await register(transport, socket, "client-1");

		socket.emitMessage(
			JSON.stringify({
				kind: "command",
				envelope: {
					version: "v1",
					command: "client.unregister",
					requestId: "req-unregister",
					clientId: "client-1",
				},
			}),
		);
		await Promise.resolve();
		await Promise.resolve();

		transport.command.mockClear();
		socket.emitMessage(
			JSON.stringify({
				kind: "command",
				envelope: {
					version: "v1",
					command: "session.list",
					requestId: "req-after",
					clientId: "client-1",
				},
			}),
		);
		await Promise.resolve();

		expect(transport.command).not.toHaveBeenCalled();
		expect(replies(socket)).toContainEqual(
			expect.objectContaining({
				requestId: "req-after",
				ok: false,
				error: expect.objectContaining({ code: "hub_unregistered_client" }),
			}),
		);
	});
});
