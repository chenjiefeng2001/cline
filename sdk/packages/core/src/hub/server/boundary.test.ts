import type { AgentToolContext, HubEventEnvelope } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	DurableToolApprovalCoordinator,
	SqliteDurableToolApprovalStore,
} from "../../runtime/approval/durable-tool-approval";
import {
	RUNTIME_INTERNAL_RECOVERY_OWNER,
	SessionNotFoundError,
	type StartSessionInput,
	type StartSessionResult,
} from "../../runtime/host/runtime-host";
import { createSessionCompactionState } from "../../session/models/session-compaction";
import { createLocalHubScheduleRuntimeHandlers } from "../daemon/runtime-handlers";
import { HubServerTransport } from "../server";
import {
	handleApprovalRespond,
	requestToolApproval,
} from "./handlers/approval-handlers";
import {
	ensureSessionParticipant,
	ensureSessionState,
	type HubTransportContext,
} from "./handlers/context";
import { projectSessionEvent } from "./handlers/session-event-projector";

describe("HubServerTransport boundaries", () => {
	function createTransport(options: Record<string, unknown> = {}) {
		const { sessionHost: sessionHostOverride, ...transportOptions } = options;
		return new HubServerTransport({
			approvalCoordinator: new DurableToolApprovalCoordinator(
				new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
			),
			runtimeHandlers: createLocalHubScheduleRuntimeHandlers(),
			scheduleOptions: { dbPath: ":memory:" },
			sessionHost: {
				subscribe: vi.fn(),
				startSession: vi.fn(),
				stopSession: vi.fn(),
				runTurn: vi.fn(),
				abort: vi.fn(),
				dispose: vi.fn(),
				getSession: vi.fn().mockResolvedValue({
					sessionId: "session-1",
					status: "completed",
					startedAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
					workspaceRoot: "/tmp/project",
					cwd: "/tmp/project",
				}),
				getAccumulatedUsage: vi.fn().mockResolvedValue(undefined),
				listSessions: vi.fn(),
				deleteSession: vi.fn(),
				updateSession: vi.fn(),
				dispatchHookEvent: vi.fn(),
				readSessionMessages: vi.fn(),
				...((sessionHostOverride as Record<string, unknown> | undefined) ?? {}),
			} as never,
			...transportOptions,
		});
	}

	function getContext(transport: HubServerTransport): HubTransportContext {
		return (transport as unknown as { ctx: HubTransportContext }).ctx;
	}

	/**
	 * Seed live session ownership. Session commands are authorized centrally by
	 * the ACL table, so a test that is not exercising authorization has to say
	 * which client owns the session it operates on.
	 */
	function ownSession(
		transport: HubServerTransport,
		sessionId = "session-1",
		clientId = "client-1",
	): void {
		ensureSessionState(getContext(transport), sessionId, clientId, "creator");
	}

	it("runs startup recovery before schedules start", async () => {
		const order: string[] = [];
		const recovery = vi.fn(async () => {
			order.push("recovery");
		});
		const transport = createTransport({ startupRecovery: recovery });
		const schedules = (
			transport as unknown as {
				schedules: { start: () => Promise<void> };
			}
		).schedules;
		const originalStart = schedules.start.bind(schedules);
		schedules.start = vi.fn(async () => {
			order.push("schedules");
			await originalStart();
		});
		try {
			await transport.start();
			expect(order).toEqual(["recovery", "schedules"]);
			expect(recovery).toHaveBeenCalledTimes(1);
		} finally {
			await transport.stop();
		}
	});

	it("forwards only the internal A2A recovery owner to the runtime", async () => {
		let captured: StartSessionInput | undefined;
		const startSession = vi.fn(async (input: StartSessionInput) => {
			captured = input;
			return {
				sessionId: "owner-session",
				manifest: {
					version: 1,
					session_id: "owner-session",
					source: "a2a",
					pid: process.pid,
					started_at: new Date(0).toISOString(),
					status: "running",
					interactive: true,
					provider: "mock",
					model: "mock",
					cwd: "/tmp/project",
					workspace_root: "/tmp/project",
					enable_tools: true,
					enable_spawn: false,
					enable_teams: false,
				},
				manifestPath: "",
				messagesPath: "",
			} as StartSessionResult;
		});
		const transport = createTransport({
			sessionHost: {
				startSession,
				getSession: vi.fn().mockResolvedValue({
					sessionId: "owner-session",
					status: "running",
					startedAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
					workspaceRoot: "/tmp/project",
					cwd: "/tmp/project",
				}),
				readSessionMessages: vi.fn().mockResolvedValue([]),
			} as never,
		});
		const payload = {
			workspaceRoot: "/tmp/project",
			cwd: "/tmp/project",
			sessionConfig: { sessionId: "owner-session" },
			metadata: { source: "a2a" },
			recoveryOwner: "client-spoofed",
		} as Record<string, unknown> & {
			[RUNTIME_INTERNAL_RECOVERY_OWNER]?: string;
		};
		payload[RUNTIME_INTERNAL_RECOVERY_OWNER] = "server-owned";
		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-owner",
			command: "session.create",
			clientId: "a2a-owner",
			payload,
		});
		expect(reply.ok).toBe(true);
		expect(captured?.[RUNTIME_INTERNAL_RECOVERY_OWNER]).toBe("server-owned");
		expect(captured?.recoveryOwner).toBeUndefined();
	});

	it("redacts credentials from every published event payload", () => {
		const transport = createTransport();
		const events: HubEventEnvelope[] = [];
		transport.subscribe("watcher", (event) => events.push(event));

		(
			transport as unknown as {
				publish: (event: HubEventEnvelope) => void;
			}
		).publish({
			version: "v1",
			event: "ui.notify",
			eventId: "evt_secret",
			timestamp: Date.now(),
			payload: {
				title: "sync",
				apiKey: "sk-live-abcdefghijklmnop",
				nested: { password: "hunter2", note: "Bearer abcdef0123456789xyz" },
			},
		});

		const published = events.at(-1);
		expect(published?.payload).toEqual({
			title: "sync",
			apiKey: "[REDACTED]",
			nested: {
				password: "[REDACTED]",
				note: "Bearer [REDACTED]",
			},
		});
		// Addressing fields are not data and must survive untouched.
		expect(published?.event).toBe("ui.notify");
		expect(published?.eventId).toBe("evt_secret");
	});

	it("keeps non-credential event payload fields intact", () => {
		const transport = createTransport();
		const events: HubEventEnvelope[] = [];
		transport.subscribe("watcher", (event) => events.push(event));

		(
			transport as unknown as { publish: (event: HubEventEnvelope) => void }
		).publish({
			version: "v1",
			event: "ui.notify",
			eventId: "evt_ok",
			timestamp: Date.now(),
			payload: { count: 3, ok: true, label: "hello", items: ["a", "b"] },
		});

		expect(events.at(-1)?.payload).toEqual({
			count: 3,
			ok: true,
			label: "hello",
			items: ["a", "b"],
		});
	});

	it("redacts credentials from the client registry projection", async () => {
		const transport = createTransport();
		const ctx = getContext(transport);
		ctx.clients.set("client-1", {
			clientId: "client-1",
			clientType: "core",
			actorKind: "client",
			connectedAt: 0,
			lastSeenAt: 0,
			transport: "native",
			capabilities: [],
			metadata: {
				workspaceRoot: "/tmp/project",
				apiKey: "sk-live-abcdefghijklmnop",
			},
		});

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-client-list",
			command: "client.list",
			clientId: "client-1",
		});

		expect(reply.ok).toBe(true);
		const clients = (
			reply.payload as { clients: Array<Record<string, unknown>> }
		).clients;
		expect(clients[0]?.metadata).toEqual({
			workspaceRoot: "/tmp/project",
			apiKey: "[REDACTED]",
		});
	});

	it("redacts credentials from the session record projection", async () => {
		const transport = createTransport({
			sessionHost: {
				getSession: vi.fn().mockResolvedValue({
					sessionId: "session-1",
					status: "idle",
					startedAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
					workspaceRoot: "/tmp/project",
					cwd: "/tmp/project",
					metadata: {
						apiKey: "sk-live-abcdefghijklmnop",
						systemPrompt: "Call with ANTHROPIC_API_KEY=sk-abcdefghijklmnop",
					},
				}),
				listSessions: vi.fn().mockResolvedValue([]),
			},
		});
		ownSession(transport);

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-session-get",
			command: "session.get",
			clientId: "client-1",
			sessionId: "session-1",
		});

		expect(reply.ok).toBe(true);
		const serialized = JSON.stringify(reply.payload);
		expect(serialized).not.toContain("sk-live-abcdefghijklmnop");
		expect(serialized).not.toContain("sk-abcdefghijklmnop");
		expect(serialized).toContain("[REDACTED]");
	});

	it("continues publishing when one listener throws", () => {
		const transport = createTransport();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const delivered: string[] = [];

		try {
			transport.subscribe("bad", () => {
				throw new Error("listener boom");
			});
			transport.subscribe("good", (event) => {
				delivered.push(event.event);
			});

			(
				transport as unknown as {
					publish: (event: {
						event: string;
						timestamp: number;
						version: "v1";
						eventId: string;
					}) => void;
				}
			).publish({
				version: "v1",
				event: "ui.notify",
				eventId: "evt_1",
				timestamp: Date.now(),
			});

			expect(delivered).toEqual(["ui.notify"]);
			const logged = String(errorSpy.mock.calls[0]?.[0] ?? "");
			expect(logged.startsWith("[hub] ")).toBe(true);
			const payload = JSON.parse(logged.slice("[hub] ".length));
			expect(payload).toMatchObject({
				level: "error",
				component: "hub",
				message: "listener threw while publishing ui.notify",
			});
			expect(payload.error).toContain("listener boom");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("denies non-interactive approval requests immediately", async () => {
		const transport = createTransport();
		const ctx = getContext(transport);
		ensureSessionState(ctx, "session-1", "client-1", "creator", {
			interactive: false,
		});

		const result = await requestToolApproval(ctx, {
			sessionId: "session-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			iteration: 1,
			toolCallId: "call-1",
			toolName: "run_commands",
			input: { commands: ["echo hi"] },
			policy: { autoApprove: false },
		});

		expect(result).toEqual({
			approved: false,
			reason:
				"Tool approval requires an interactive session, but this session is non-interactive.",
		});
	});

	it("serves session messages from the hub-owned session host", async () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "text", text: "created elsewhere" }],
			},
		];
		const readMessages = vi.fn().mockResolvedValue(messages);
		const transport = createTransport({
			sessionHost: {
				subscribe: vi.fn(),
				startSession: vi.fn(),
				stopSession: vi.fn(),
				runTurn: vi.fn(),
				abort: vi.fn(),
				dispose: vi.fn(),
				getSession: vi.fn().mockResolvedValue({
					sessionId: "session-1",
					source: "cli",
					pid: 123,
					startedAt: new Date(0).toISOString(),
					status: "completed",
					interactive: false,
					provider: "cline",
					model: "test-model",
					cwd: "/tmp/project",
					workspaceRoot: "/tmp/project",
					enableTools: true,
					enableSpawn: true,
					enableTeams: false,
					updatedAt: new Date(0).toISOString(),
				}),
				getAccumulatedUsage: vi.fn().mockResolvedValue(undefined),
				listSessions: vi.fn(),
				deleteSession: vi.fn(),
				updateSession: vi.fn(),
				dispatchHookEvent: vi.fn(),
				readSessionMessages: readMessages,
			} as never,
		});

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-1",
			command: "session.messages",
			sessionId: "session-1",
		});

		expect(readMessages).toHaveBeenCalledWith("session-1");
		expect(reply).toMatchObject({
			version: "v1",
			requestId: "req-1",
			ok: true,
			payload: { sessionId: "session-1", messages },
		});
	});

	it("includes accumulated usage on session.get", async () => {
		const usage = {
			inputTokens: 10,
			outputTokens: 3,
			cacheReadTokens: 1,
			cacheWriteTokens: 2,
			totalCost: 0.11,
		};
		const aggregateUsage = {
			inputTokens: 17,
			outputTokens: 8,
			cacheReadTokens: 3,
			cacheWriteTokens: 3,
			totalCost: 0.23,
		};
		const getAccumulatedUsage = vi
			.fn()
			.mockResolvedValue({ usage, aggregateUsage });
		const transport = createTransport({
			sessionHost: {
				subscribe: vi.fn(),
				startSession: vi.fn(),
				stopSession: vi.fn(),
				runTurn: vi.fn(),
				abort: vi.fn(),
				dispose: vi.fn(),
				getSession: vi.fn().mockResolvedValue({
					sessionId: "session-1",
					source: "cli",
					pid: 123,
					startedAt: new Date(0).toISOString(),
					status: "completed",
					interactive: false,
					provider: "cline",
					model: "test-model",
					cwd: "/tmp/project",
					workspaceRoot: "/tmp/project",
					enableTools: true,
					enableSpawn: true,
					enableTeams: true,
					updatedAt: new Date(0).toISOString(),
				}),
				getAccumulatedUsage,
				listSessions: vi.fn(),
				deleteSession: vi.fn(),
				updateSession: vi.fn(),
				dispatchHookEvent: vi.fn(),
				readSessionMessages: vi.fn(),
			} as never,
		});

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-usage",
			command: "session.get",
			sessionId: "session-1",
		});

		expect(getAccumulatedUsage).toHaveBeenCalledWith("session-1");
		expect(reply).toMatchObject({
			version: "v1",
			requestId: "req-usage",
			ok: true,
			payload: {
				session: {
					sessionId: "session-1",
					usage,
					aggregateUsage,
				},
			},
		});
	});

	it("includes a redacted pending approval descriptor on session.get", async () => {
		const listPending = vi.fn().mockResolvedValue([
			{
				approvalId: "approval-1",
				toolCallId: "call-1",
				toolName: "run_commands",
				expiresAt: 1234,
				inputJson: '{"secret":"do-not-project"}',
			},
		]);
		const transport = createTransport({
			approvalCoordinator: { listPending } as never,
			sessionHost: {
				getSession: vi.fn().mockResolvedValue({
					sessionId: "session-approval",
					status: "running",
					startedAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
					workspaceRoot: "/tmp/project",
					cwd: "/tmp/project",
				}),
			} as never,
		});
		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-approval",
			command: "session.get",
			sessionId: "session-approval",
		});
		expect(listPending).toHaveBeenCalledWith("session-approval");
		expect(reply).toMatchObject({
			payload: {
				pendingApproval: true,
				approval: {
					approvalId: "approval-1",
					toolCallId: "call-1",
					toolName: "run_commands",
					expiresAt: 1234,
				},
			},
		});
		expect(JSON.stringify(reply)).not.toContain("do-not-project");
	});

	it("returns session_not_found when session messages are requested for an unknown session", async () => {
		const readMessages = vi.fn().mockResolvedValue([]);
		const telemetry = { capture: vi.fn() };
		const transport = createTransport({
			telemetry,
			sessionHost: {
				subscribe: vi.fn(),
				startSession: vi.fn(),
				stopSession: vi.fn(),
				runTurn: vi.fn(),
				abort: vi.fn(),
				dispose: vi.fn(),
				getSession: vi.fn().mockResolvedValue(undefined),
				getAccumulatedUsage: vi.fn().mockResolvedValue(undefined),
				listSessions: vi.fn(),
				deleteSession: vi.fn(),
				updateSession: vi.fn(),
				dispatchHookEvent: vi.fn(),
				readSessionMessages: readMessages,
			} as never,
		});

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-1",
			command: "session.messages",
			sessionId: "missing-session",
		});

		expect(readMessages).not.toHaveBeenCalled();
		expect(reply).toMatchObject({
			version: "v1",
			requestId: "req-1",
			ok: false,
			error: {
				code: "session_not_found",
				message: "Unknown session: missing-session",
			},
		});
		expect(telemetry.capture).toHaveBeenCalledWith({
			event: "sdk.error",
			properties: expect.objectContaining({
				component: "core",
				operation: "hub.command_reply",
				severity: "warn",
				handled: true,
				command: "session.messages",
				requestId: "req-1",
				sessionId: "missing-session",
				errorCode: "session_not_found",
				error_message: "Unknown session: missing-session",
			}),
		});
	});

	it("keeps session list and get lightweight unless snapshots are requested", async () => {
		const readSessionMessages = vi
			.fn()
			.mockResolvedValue([{ role: "user", content: "heavy transcript" }]);
		const session = {
			sessionId: "session-1",
			source: "cli",
			status: "completed",
			startedAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			workspaceRoot: "/tmp/project",
			cwd: "/tmp/project",
			interactive: true,
			provider: "cline",
			model: "test-model",
			enableTools: true,
			enableSpawn: true,
			enableTeams: false,
		};
		const transport = createTransport({
			sessionHost: {
				subscribe: vi.fn(),
				startSession: vi.fn(),
				stopSession: vi.fn(),
				runTurn: vi.fn(),
				abort: vi.fn(),
				dispose: vi.fn(),
				getSession: vi.fn().mockResolvedValue(session),
				getAccumulatedUsage: vi.fn().mockResolvedValue(undefined),
				listSessions: vi.fn().mockResolvedValue([session]),
				deleteSession: vi.fn(),
				updateSession: vi.fn(),
				dispatchHookEvent: vi.fn(),
				readSessionMessages,
			} as never,
		});

		const listReply = await transport.handleCommand({
			version: "v1",
			requestId: "req-list",
			command: "session.list",
			payload: { limit: 10 },
		});
		const getReply = await transport.handleCommand({
			version: "v1",
			requestId: "req-get",
			command: "session.get",
			sessionId: "session-1",
		});

		expect(listReply.payload?.sessions).toHaveLength(1);
		expect(listReply.payload).not.toHaveProperty("snapshots");
		expect(getReply.payload).toHaveProperty("session");
		expect(getReply.payload).not.toHaveProperty("snapshot");
		expect(readSessionMessages).not.toHaveBeenCalled();

		const snapshotReply = await transport.handleCommand({
			version: "v1",
			requestId: "req-get-snapshot",
			command: "session.get",
			sessionId: "session-1",
			payload: { includeSnapshot: true },
		});

		expect(snapshotReply.payload).toHaveProperty("snapshot");
		expect(readSessionMessages).toHaveBeenCalledWith("session-1");
	});

	it("keeps interactive approval requests pending until a response arrives", async () => {
		vi.useFakeTimers();
		try {
			const recoverPendingRunContinuations = vi.fn().mockResolvedValue({});
			const transport = createTransport({
				sessionHost: { recoverPendingRunContinuations } as never,
			});
			const events: HubEventEnvelope[] = [];
			let approvalId = "";
			transport.subscribe("test", (event) => {
				events.push(event);
				if (
					event.event === "approval.requested" &&
					typeof event.payload?.approvalId === "string"
				) {
					approvalId = event.payload.approvalId;
				}
			});
			const ctx = getContext(transport);
			ensureSessionState(ctx, "session-1", "client-1", "creator", {
				interactive: true,
			});

			let settled: unknown;
			const resultPromise = requestToolApproval(ctx, {
				sessionId: "session-1",
				agentId: "agent-1",
				conversationId: "conversation-1",
				iteration: 1,
				toolCallId: "call-1",
				toolName: "run_commands",
				input: { commands: ["echo hi"] },
				policy: { autoApprove: false },
			});
			resultPromise.then((result) => {
				settled = result;
			});

			await vi.advanceTimersByTimeAsync(10_000);
			await Promise.resolve();

			expect(settled).toBeUndefined();
			expect(approvalId).toMatch(/^approval_/);
			const requested = events.find(
				(event) => event.event === "approval.requested",
			);
			expect(requested?.sessionId).toBe("session-1");
			expect(requested?.payload).toMatchObject({
				sessionId: "session-1",
				conversationId: "conversation-1",
			});
			const reply = handleApprovalRespond(ctx, {
				version: "v1",
				requestId: "req-1",
				command: "approval.respond",
				clientId: "client-1",
				sessionId: "session-1",
				payload: {
					approvalId,
					approved: true,
					reason: "approved by user",
				},
			});

			await expect(reply).resolves.toMatchObject({ ok: true });
			await expect(resultPromise).resolves.toEqual({
				approved: true,
				reason: "approved by user",
			});
			expect(recoverPendingRunContinuations).toHaveBeenCalledWith({
				background: true,
				maxCandidates: 1,
				sessionId: "session-1",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("enforces the approval client and replays pending requests on attach", async () => {
		const transport = createTransport();
		const ctx = getContext(transport);
		const events: HubEventEnvelope[] = [];
		let approvalId = "";
		let resolveRequested: (() => void) | undefined;
		const requested = new Promise<void>((resolve) => {
			resolveRequested = resolve;
		});
		transport.subscribe("test", (event) => {
			events.push(event);
			if (event.event === "approval.requested") {
				approvalId = String(event.payload?.approvalId ?? "");
				resolveRequested?.();
			}
		});
		ensureSessionState(ctx, "session-1", "client-1", "creator", {
			interactive: true,
		});
		const resultPromise = requestToolApproval(ctx, {
			sessionId: "session-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			runId: "run-approval",
			iteration: 1,
			toolCallIndex: 0,
			toolCallId: "call-approval-auth",
			toolName: "write_file",
			input: { path: "a.txt" },
			policy: { autoApprove: false },
		});
		await requested;
		const wrongClient = await handleApprovalRespond(ctx, {
			version: "v1",
			requestId: "req-wrong-client",
			command: "approval.respond",
			clientId: "client-2",
			sessionId: "session-1",
			payload: { approvalId, approved: true },
		});
		expect(wrongClient).toMatchObject({
			ok: false,
			error: { code: "approval_wrong_client" },
		});
		await transport.handleCommand({
			version: "v1",
			requestId: "req-attach-approval",
			command: "session.attach",
			clientId: "client-1",
			sessionId: "session-1",
		});
		expect(
			events.filter(
				(event) =>
					event.event === "approval.requested" &&
					event.payload?.approvalId === approvalId,
			),
		).toHaveLength(2);
		const accepted = await handleApprovalRespond(ctx, {
			version: "v1",
			requestId: "req-right-client",
			command: "approval.respond",
			clientId: "client-1",
			sessionId: "session-1",
			payload: { approvalId, approved: true },
		});
		expect(accepted).toMatchObject({ ok: true });
		await expect(resultPromise).resolves.toEqual({ approved: true });
	});

	it("preserves pending approvals across a clean hub shutdown", async () => {
		const transport = createTransport();
		const ctx = getContext(transport);
		let resolveRequested: (() => void) | undefined;
		const requested = new Promise<void>((resolve) => {
			resolveRequested = resolve;
		});
		transport.subscribe("test", (event) => {
			if (event.event === "approval.requested") {
				resolveRequested?.();
			}
		});
		ensureSessionState(ctx, "session-1", "client-1", "creator", {
			interactive: true,
		});
		const resultPromise = requestToolApproval(ctx, {
			sessionId: "session-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			runId: "run-shutdown",
			iteration: 1,
			toolCallIndex: 0,
			toolCallId: "call-shutdown",
			toolName: "write_file",
			input: { path: "a.txt" },
			policy: { autoApprove: false },
		});
		await requested;
		await transport.stop();
		await expect(resultPromise).resolves.toMatchObject({ approved: false });
		const coordinator = ctx.approvalCoordinator;
		expect(coordinator).toBeDefined();
		await expect(coordinator?.listPending("session-1")).resolves.toHaveLength(
			1,
		);
		await coordinator?.close();
	});

	it("routes durable run resume through the execution host", async () => {
		const resumePendingRun = vi.fn().mockResolvedValue({
			record: { phase: "completed" },
		});
		const transport = createTransport({
			sessionHost: { resumePendingRun },
		});
		ownSession(transport);
		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-resume",
			command: "session.resume",
			clientId: "client-1",
			sessionId: "session-1",
			payload: {
				continuationKey: "approval:approval-1",
				start: { config: { providerId: "mock", modelId: "mock" } },
			},
		});

		expect(reply).toMatchObject({
			ok: true,
			payload: { result: { record: { phase: "completed" } } },
		});
		expect(resumePendingRun).toHaveBeenCalledWith(
			expect.objectContaining({
				continuationKey: "approval:approval-1",
				start: expect.objectContaining({
					config: expect.objectContaining({ sessionId: "session-1" }),
				}),
			}),
		);
	});

	it("routes a durable run batch resume through the execution host", async () => {
		const resumePendingRunBatch = vi.fn().mockResolvedValue({
			records: [{ phase: "completed" }],
		});
		const resumePendingRun = vi.fn();
		const transport = createTransport({
			sessionHost: { resumePendingRun, resumePendingRunBatch },
		});
		ownSession(transport);
		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-resume-batch",
			command: "session.resume",
			clientId: "client-1",
			sessionId: "session-1",
			payload: {
				continuationKeys: ["approval:approval-1", "approval:approval-2"],
				start: { config: { providerId: "mock", modelId: "mock" } },
			},
		});

		expect(reply).toMatchObject({
			ok: true,
			payload: { result: { records: [{ phase: "completed" }] } },
		});
		expect(resumePendingRun).not.toHaveBeenCalled();
		expect(resumePendingRunBatch).toHaveBeenCalledWith(
			expect.objectContaining({
				continuationKeys: ["approval:approval-1", "approval:approval-2"],
				start: expect.objectContaining({
					config: expect.objectContaining({ sessionId: "session-1" }),
				}),
			}),
		);
	});

	it("rejects a batch resume when the host does not support it", async () => {
		const resumePendingRun = vi.fn();
		const transport = createTransport({
			sessionHost: { resumePendingRun },
		});
		ownSession(transport);
		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-resume-batch-unsupported",
			command: "session.resume",
			clientId: "client-1",
			sessionId: "session-1",
			payload: {
				continuationKeys: ["approval:approval-1", "approval:approval-2"],
				start: { config: { providerId: "mock", modelId: "mock" } },
			},
		});

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "session_resume_unavailable" },
		});
		expect(resumePendingRun).not.toHaveBeenCalled();
	});

	it("rejects pending tool approvals when a run is aborted", async () => {
		const abort = vi.fn().mockResolvedValue(undefined);
		const transport = createTransport({
			sessionHost: {
				subscribe: vi.fn(),
				startSession: vi.fn(),
				stopSession: vi.fn(),
				runTurn: vi.fn(),
				abort,
				dispose: vi.fn(),
				getSession: vi.fn(),
				listSessions: vi.fn(),
				deleteSession: vi.fn(),
				updateSession: vi.fn(),
				dispatchHookEvent: vi.fn(),
			} as never,
		});
		const ctx = getContext(transport);
		const events: HubEventEnvelope[] = [];
		let approvalId = "";
		transport.subscribe("test", (event) => {
			events.push(event);
			if (
				event.event === "approval.requested" &&
				typeof event.payload?.approvalId === "string"
			) {
				approvalId = event.payload.approvalId;
			}
		});
		ensureSessionState(ctx, "session-1", "client-1", "creator", {
			interactive: true,
		});

		const resultPromise = requestToolApproval(ctx, {
			sessionId: "session-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			iteration: 1,
			toolCallId: "call-1",
			toolName: "run_commands",
			input: { commands: ["echo hi"] },
			policy: { autoApprove: false },
		});
		await Promise.resolve();

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-abort",
			command: "run.abort",
			sessionId: "session-1",
			payload: { reason: "user cancelled" },
		});

		expect(reply.ok).toBe(true);
		expect(abort).toHaveBeenCalledWith("session-1", "user cancelled");
		expect(ctx.pendingApprovals.has(approvalId)).toBe(false);
		await expect(resultPromise).resolves.toEqual({
			approved: false,
			reason: "user cancelled",
		});
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "approval.resolved",
					sessionId: "session-1",
					payload: expect.objectContaining({
						approvalId,
						approved: false,
						cancelled: true,
						reason: "user cancelled",
					}),
				}),
			]),
		);
	});

	it("publishes capability-backed tools on the hub session stream", async () => {
		let capturedStartInput: StartSessionInput | undefined;
		const startSession = vi.fn(
			async (input: StartSessionInput): Promise<StartSessionResult> => {
				capturedStartInput = input;
				const sessionId = input.config.sessionId?.trim() || "missing-session";
				return {
					sessionId,
					manifest: {
						version: 1,
						session_id: sessionId,
						source: "cli",
						pid: 1,
						started_at: new Date(0).toISOString(),
						status: "running",
						interactive: true,
						provider: "cline",
						model: "test-model",
						cwd: "/tmp/project",
						workspace_root: "/tmp/project",
						enable_tools: true,
						enable_spawn: true,
						enable_teams: false,
					},
					manifestPath: "",
					messagesPath: "",
					result: undefined,
				};
			},
		);
		const transport = createTransport({
			sessionHost: {
				subscribe: vi.fn(),
				startSession,
				stopSession: vi.fn(),
				runTurn: vi.fn(),
				abort: vi.fn(),
				dispose: vi.fn(),
				getSession: vi.fn().mockImplementation(async (sessionId: string) => ({
					sessionId,
					status: "running",
					startedAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
					workspaceRoot: "/tmp/project",
					cwd: "/tmp/project",
				})),
				listSessions: vi.fn(),
				deleteSession: vi.fn(),
				updateSession: vi.fn(),
				dispatchHookEvent: vi.fn(),
				readSessionMessages: vi.fn(),
			} as never,
		});
		const events: HubEventEnvelope[] = [];
		transport.subscribe("client-1", (event) => events.push(event));

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-create",
			command: "session.create",
			clientId: "client-1",
			payload: {
				workspaceRoot: "/tmp/project",
				cwd: "/tmp/project",
				sessionConfig: {
					providerId: "cline",
					modelId: "test-model",
					cwd: "/tmp/project",
					workspaceRoot: "/tmp/project",
					systemPrompt: "system",
				},
				metadata: { source: "cli", interactive: true },
				runtimeOptions: {
					clientContributions: [
						{
							kind: "toolExecutor",
							executor: "askQuestion",
							capabilityName: "tool_executor.askQuestion",
						},
					],
				},
			},
		});

		expect(reply.ok).toBe(true);
		const sessionId = capturedStartInput?.config.sessionId?.trim() || "";
		expect(sessionId).toMatch(/^[0-9]/);
		const askQuestion =
			capturedStartInput?.capabilities?.toolExecutors?.askQuestion;
		if (!askQuestion) {
			throw new Error("Expected askQuestion executor to be registered");
		}
		const toolContext: AgentToolContext = {
			agentId: "agent-1",
			conversationId: "conv-1",
			iteration: 1,
		};
		const answerPromise = askQuestion(
			"Which path?",
			["Use hub", "Use local"],
			toolContext,
		);
		await Promise.resolve();

		const request = events.find(
			(event) => event.event === "capability.requested",
		);
		expect(request?.sessionId).toBe(sessionId);
		expect(request?.payload?.payload).toMatchObject({
			context: { conversationId: "conv-1" },
		});
		expect(request?.payload?.targetClientId).toBe("client-1");
		const requestId =
			typeof request?.payload?.requestId === "string"
				? request.payload.requestId
				: "";
		expect(requestId).toMatch(/^capreq_/);

		await transport.handleCommand({
			version: "v1",
			requestId: "req-response",
			command: "capability.respond",
			clientId: "client-1",
			sessionId,
			payload: {
				requestId,
				ok: true,
				payload: { result: "Use hub" },
			},
		});

		await expect(answerPromise).resolves.toBe("Use hub");
	});

	it("does not transfer capability ownership to attached clients", async () => {
		let createdSessionId = "";
		const startSession = vi.fn(async (input: StartSessionInput) => {
			createdSessionId = input.config.sessionId?.trim() || "missing-session";
			return {
				sessionId: createdSessionId,
				manifest: {
					version: 1,
					session_id: createdSessionId,
					source: "cli",
					pid: 1,
					started_at: new Date(0).toISOString(),
					status: "running",
					interactive: true,
					provider: "cline",
					model: "test-model",
					cwd: "/tmp/project",
					workspace_root: "/tmp/project",
					enable_tools: true,
					enable_spawn: true,
					enable_teams: false,
				},
				manifestPath: "",
				messagesPath: "",
				result: undefined,
			};
		});
		const transport = createTransport({
			sessionHost: {
				subscribe: vi.fn(),
				startSession,
				stopSession: vi.fn(),
				runTurn: vi.fn(),
				abort: vi.fn(),
				dispose: vi.fn(),
				getSession: vi.fn().mockImplementation(async (sessionId: string) => ({
					sessionId,
					status: "running",
					startedAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
					workspaceRoot: "/tmp/project",
					cwd: "/tmp/project",
					metadata: { hubCapabilityOwnerClientId: "owner-client" },
				})),
				listSessions: vi.fn(),
				deleteSession: vi.fn(),
				updateSession: vi.fn(),
				dispatchHookEvent: vi.fn(),
				readSessionMessages: vi.fn(),
			} as never,
		});
		const events: HubEventEnvelope[] = [];
		transport.subscribe("owner-client", (event) => events.push(event));

		await transport.handleCommand({
			version: "v1",
			requestId: "req-create",
			command: "session.create",
			clientId: "owner-client",
			payload: {
				workspaceRoot: "/tmp/project",
				cwd: "/tmp/project",
				sessionConfig: {
					providerId: "cline",
					modelId: "test-model",
					cwd: "/tmp/project",
					workspaceRoot: "/tmp/project",
					systemPrompt: "system",
				},
				metadata: { source: "cli", interactive: true },
				runtimeOptions: {
					clientContributions: [
						{
							kind: "toolExecutor",
							executor: "askQuestion",
							capabilityName: "tool_executor.askQuestion",
						},
					],
				},
			},
		});
		await transport.handleCommand({
			version: "v1",
			requestId: "req-attach",
			command: "session.attach",
			clientId: "viewer-client",
			sessionId: createdSessionId,
		});

		const askQuestion =
			startSession.mock.calls[0]?.[0].capabilities?.toolExecutors?.askQuestion;
		if (!askQuestion) throw new Error("Expected askQuestion executor");
		const answerPromise = askQuestion("Which path?", ["Use hub"], {
			agentId: "agent-1",
			conversationId: "conv-1",
			iteration: 1,
		});
		await Promise.resolve();

		const request = events.find(
			(event) => event.event === "capability.requested",
		);
		expect(request?.payload?.targetClientId).toBe("owner-client");
		const requestId = String(request?.payload?.requestId ?? "");
		await transport.handleCommand({
			version: "v1",
			requestId: "req-response",
			command: "capability.respond",
			clientId: "owner-client",
			sessionId: createdSessionId,
			payload: { requestId, ok: true, payload: { result: "Use hub" } },
		});

		await expect(answerPromise).resolves.toBe("Use hub");
	});

	it("rejects capability responses from non-owner clients", async () => {
		const transport = createTransport();
		const ctx = getContext(transport);
		ctx.pendingCapabilityRequests.set("capreq-1", {
			sessionId: "session-1",
			targetClientId: "owner-client",
			capabilityName: "tool_executor.askQuestion",
			resolve: vi.fn(),
		});

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-response",
			command: "capability.respond",
			clientId: "viewer-client",
			sessionId: "session-1",
			payload: { requestId: "capreq-1", ok: true, payload: { result: "no" } },
		});

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "capability_wrong_client" },
		});
		expect(ctx.pendingCapabilityRequests.has("capreq-1")).toBe(true);
	});

	it("does not let session metadata updates overwrite server-owned compaction owner", async () => {
		const updateSession = vi.fn().mockResolvedValue({ updated: true });
		const transport = createTransport({
			sessionHost: {
				updateSession,
			},
		});
		// The caller owns the session: this test is about the metadata sanitizer,
		// not about authorization (which `session-access` covers separately).
		ownSession(transport, "session-1", "attacker-client");

		await transport.handleCommand({
			version: "v1",
			requestId: "req-update",
			command: "session.update",
			clientId: "attacker-client",
			sessionId: "session-1",
			payload: {
				metadata: {
					hubCapabilityOwnerClientId: "attacker-client",
					title: "safe title",
				},
			},
		});

		expect(updateSession).toHaveBeenCalledWith("session-1", {
			metadata: { title: "safe title" },
		});
	});

	it("authorizes compaction sidecar access from server session state, not mutable metadata", async () => {
		const readSessionCompactionState = vi.fn();
		const transport = createTransport({
			sessionHost: {
				getSession: vi.fn().mockResolvedValue({
					sessionId: "session-1",
					status: "completed",
					startedAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
					workspaceRoot: "/tmp/project",
					cwd: "/tmp/project",
					metadata: { hubCapabilityOwnerClientId: "attacker-client" },
				}),
				readSessionCompactionState,
			},
		});
		const ctx = getContext(transport);
		ensureSessionState(ctx, "session-1", "owner-client", "creator");

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-compact",
			command: "session.compaction.get",
			clientId: "attacker-client",
			sessionId: "session-1",
		});

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "session_wrong_client" },
		});
		expect(readSessionCompactionState).not.toHaveBeenCalled();
	});

	it("does not grant compaction sidecar ownership from session attach", async () => {
		const state = createSessionCompactionState({
			sourceMessages: [{ role: "user", content: "source" }],
			compactedMessages: [{ role: "user", content: "summary" }],
			conversationId: "session-1",
		});
		const readSessionCompactionState = vi.fn().mockResolvedValue(state);
		const updateSessionCompactionState = vi
			.fn()
			.mockResolvedValue({ updated: true });
		const transport = createTransport({
			sessionHost: {
				readSessionCompactionState,
				updateSessionCompactionState,
			},
		});
		const ctx = getContext(transport);
		expect(ctx.sessionState.has("session-1")).toBe(false);

		const attachReply = await transport.handleCommand({
			version: "v1",
			requestId: "req-attach",
			command: "session.attach",
			clientId: "viewer-client",
			sessionId: "session-1",
		});

		expect(attachReply).toMatchObject({ ok: true });
		expect(
			ctx.sessionState.get("session-1")?.createdByClientId,
		).toBeUndefined();
		expect(
			ctx.sessionState.get("session-1")?.participants.has("viewer-client"),
		).toBe(true);

		const getReply = await transport.handleCommand({
			version: "v1",
			requestId: "req-compact-get",
			command: "session.compaction.get",
			clientId: "viewer-client",
			sessionId: "session-1",
		});
		const updateReply = await transport.handleCommand({
			version: "v1",
			requestId: "req-compact-update",
			command: "session.compaction.update",
			clientId: "viewer-client",
			sessionId: "session-1",
			payload: { state },
		});

		expect(getReply).toMatchObject({
			ok: false,
			error: { code: "session_wrong_client" },
		});
		expect(updateReply).toMatchObject({
			ok: false,
			error: { code: "session_wrong_client" },
		});
		expect(readSessionCompactionState).not.toHaveBeenCalled();
		expect(updateSessionCompactionState).not.toHaveBeenCalled();
	});

	it("allows a creator to claim ownerless compaction sidecar ownership", async () => {
		const state = createSessionCompactionState({
			sourceMessages: [{ role: "user", content: "source" }],
			compactedMessages: [{ role: "user", content: "summary" }],
			conversationId: "session-1",
		});
		const readSessionCompactionState = vi.fn().mockResolvedValue(state);
		const transport = createTransport({
			sessionHost: { readSessionCompactionState },
		});
		const ctx = getContext(transport);
		ensureSessionParticipant(ctx, "session-1", "viewer-client", "participant");

		expect(
			ctx.sessionState.get("session-1")?.createdByClientId,
		).toBeUndefined();

		ensureSessionState(ctx, "session-1", "owner-client", "creator");

		expect(ctx.sessionState.get("session-1")?.createdByClientId).toBe(
			"owner-client",
		);
		expect(
			ctx.sessionState.get("session-1")?.participants.has("viewer-client"),
		).toBe(true);

		const getReply = await transport.handleCommand({
			version: "v1",
			requestId: "req-compact-get",
			command: "session.compaction.get",
			clientId: "owner-client",
			sessionId: "session-1",
		});

		expect(getReply).toMatchObject({
			ok: true,
			payload: { state },
		});
		expect(readSessionCompactionState).toHaveBeenCalledWith("session-1");
	});

	it("clears compaction sidecar ownership when the owner detaches", async () => {
		const readSessionCompactionState = vi.fn();
		const transport = createTransport({
			sessionHost: { readSessionCompactionState },
		});
		const ctx = getContext(transport);
		ensureSessionState(ctx, "session-1", "owner-client", "creator");
		ensureSessionParticipant(ctx, "session-1", "viewer-client", "participant");

		const detachReply = await transport.handleCommand({
			version: "v1",
			requestId: "req-detach",
			command: "session.detach",
			clientId: "owner-client",
			sessionId: "session-1",
		});

		expect(detachReply).toMatchObject({ ok: true });
		expect(
			ctx.sessionState.get("session-1")?.participants.has("viewer-client"),
		).toBe(true);
		expect(
			ctx.sessionState.get("session-1")?.createdByClientId,
		).toBeUndefined();

		const getReply = await transport.handleCommand({
			version: "v1",
			requestId: "req-compact-get",
			command: "session.compaction.get",
			clientId: "viewer-client",
			sessionId: "session-1",
		});

		expect(getReply).toMatchObject({
			ok: false,
			error: { code: "session_wrong_client" },
		});
		expect(readSessionCompactionState).not.toHaveBeenCalled();
	});

	it("clears compaction sidecar ownership when the owner unregisters", async () => {
		const readSessionCompactionState = vi.fn();
		const transport = createTransport({
			sessionHost: { readSessionCompactionState },
		});
		const ctx = getContext(transport);
		ensureSessionState(ctx, "session-1", "owner-client", "creator");
		ensureSessionParticipant(ctx, "session-1", "viewer-client", "participant");

		const unregisterReply = await transport.handleCommand({
			version: "v1",
			requestId: "req-unregister",
			command: "client.unregister",
			clientId: "owner-client",
		});

		expect(unregisterReply).toMatchObject({ ok: true });
		expect(
			ctx.sessionState.get("session-1")?.participants.has("viewer-client"),
		).toBe(true);
		expect(
			ctx.sessionState.get("session-1")?.createdByClientId,
		).toBeUndefined();

		const getReply = await transport.handleCommand({
			version: "v1",
			requestId: "req-compact-get",
			command: "session.compaction.get",
			clientId: "viewer-client",
			sessionId: "session-1",
		});

		expect(getReply).toMatchObject({
			ok: false,
			error: { code: "session_wrong_client" },
		});
		expect(readSessionCompactionState).not.toHaveBeenCalled();
	});

	it("returns compaction sidecar state to the server-owned session client", async () => {
		const state = createSessionCompactionState({
			sourceMessages: [{ role: "user", content: "source" }],
			compactedMessages: [{ role: "user", content: "summary" }],
			conversationId: "session-1",
		});
		const readSessionCompactionState = vi.fn().mockResolvedValue(state);
		const transport = createTransport({
			sessionHost: { readSessionCompactionState },
		});
		const ctx = getContext(transport);
		ensureSessionState(ctx, "session-1", "owner-client", "creator");

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-compact-get",
			command: "session.compaction.get",
			clientId: "owner-client",
			sessionId: "session-1",
		});

		expect(reply).toMatchObject({
			ok: true,
			payload: { sessionId: "session-1", state },
		});
		expect(readSessionCompactionState).toHaveBeenCalledWith("session-1");
	});

	it("rejects invalid compaction sidecar updates before calling the session host", async () => {
		const updateSessionCompactionState = vi.fn();
		const transport = createTransport({
			sessionHost: { updateSessionCompactionState },
		});
		const ctx = getContext(transport);
		ensureSessionState(ctx, "session-1", "owner-client", "creator");

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-compact-update-invalid",
			command: "session.compaction.update",
			clientId: "owner-client",
			sessionId: "session-1",
			payload: { state: { version: 1, messages: "bad" } },
		});

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "invalid_compaction_state" },
		});
		expect(updateSessionCompactionState).not.toHaveBeenCalled();
	});

	it("publishes session updates after successful compaction sidecar updates", async () => {
		const state = createSessionCompactionState({
			sourceMessages: [{ role: "user", content: "source" }],
			compactedMessages: [{ role: "user", content: "summary" }],
			conversationId: "session-1",
		});
		const updateSessionCompactionState = vi
			.fn()
			.mockResolvedValue({ updated: true });
		const transport = createTransport({
			sessionHost: { updateSessionCompactionState },
		});
		const ctx = getContext(transport);
		const events: HubEventEnvelope[] = [];
		ensureSessionState(ctx, "session-1", "owner-client", "creator");
		transport.subscribe("owner-client", (event) => events.push(event));

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-compact-update",
			command: "session.compaction.update",
			clientId: "owner-client",
			sessionId: "session-1",
			payload: { state },
		});

		expect(reply).toMatchObject({
			ok: true,
			payload: { updated: true },
		});
		expect(updateSessionCompactionState).toHaveBeenCalledWith(
			"session-1",
			state,
		);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "session.updated",
					sessionId: "session-1",
				}),
			]),
		);
	});

	it("does not publish session updates when compaction sidecar update is stale", async () => {
		const state = createSessionCompactionState({
			sourceMessages: [{ role: "user", content: "source" }],
			compactedMessages: [{ role: "user", content: "summary" }],
			conversationId: "session-1",
		});
		const updateSessionCompactionState = vi
			.fn()
			.mockResolvedValue({ updated: false });
		const transport = createTransport({
			sessionHost: { updateSessionCompactionState },
		});
		const ctx = getContext(transport);
		const events: HubEventEnvelope[] = [];
		ensureSessionState(ctx, "session-1", "owner-client", "creator");
		transport.subscribe("owner-client", (event) => events.push(event));

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-compact-stale",
			command: "session.compaction.update",
			clientId: "owner-client",
			sessionId: "session-1",
			payload: { state },
		});

		expect(reply).toMatchObject({
			ok: true,
			payload: { updated: false },
		});
		expect(events).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ event: "session.updated" }),
			]),
		);
	});

	it("cancels pending capability requests when a run is aborted", async () => {
		const abort = vi.fn().mockResolvedValue(undefined);
		const transport = createTransport({
			sessionHost: {
				subscribe: vi.fn(),
				startSession: vi.fn(),
				stopSession: vi.fn(),
				runTurn: vi.fn(),
				abort,
				dispose: vi.fn(),
				getSession: vi.fn(),
				listSessions: vi.fn(),
				deleteSession: vi.fn(),
				updateSession: vi.fn(),
				dispatchHookEvent: vi.fn(),
			} as never,
		});
		const ctx = getContext(transport);
		const resolved = vi.fn();
		const events: HubEventEnvelope[] = [];
		transport.subscribe("owner-client", (event) => events.push(event));
		ctx.pendingCapabilityRequests.set("capreq-1", {
			sessionId: "session-1",
			targetClientId: "owner-client",
			capabilityName: "tool_executor.askQuestion",
			resolve: resolved,
		});

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-abort",
			command: "run.abort",
			sessionId: "session-1",
			payload: { reason: "user cancelled" },
		});

		expect(reply.ok).toBe(true);
		expect(resolved).toHaveBeenCalledWith({
			ok: false,
			error: "user cancelled",
		});
		expect(ctx.pendingCapabilityRequests.has("capreq-1")).toBe(false);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "capability.resolved",
					payload: expect.objectContaining({
						requestId: "capreq-1",
						cancelled: true,
					}),
				}),
			]),
		);
	});

	it("returns session_not_found when a run starts against a stale active session", async () => {
		const runTurn = vi
			.fn()
			.mockRejectedValue(new SessionNotFoundError("stale-session"));
		const transport = createTransport({
			sessionHost: {
				runTurn,
				getSession: vi.fn().mockResolvedValue({
					sessionId: "stale-session",
					source: "cli",
					pid: 123,
					startedAt: new Date(0).toISOString(),
					status: "running",
					interactive: true,
					provider: "cline",
					model: "test-model",
					cwd: "/tmp/project",
					workspaceRoot: "/tmp/project",
					enableTools: true,
					enableSpawn: true,
					enableTeams: false,
					updatedAt: new Date(0).toISOString(),
				}),
			},
		});
		const events: HubEventEnvelope[] = [];
		transport.subscribe("client-1", (event) => events.push(event));
		ownSession(transport, "stale-session");

		const reply = await transport.handleCommand({
			version: "v1",
			requestId: "req-stale-run",
			command: "run.start",
			clientId: "client-1",
			sessionId: "stale-session",
			payload: { prompt: "continue" },
		});

		expect(runTurn).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "stale-session" }),
		);
		expect(reply).toMatchObject({
			version: "v1",
			requestId: "req-stale-run",
			ok: false,
			error: {
				code: "session_not_found",
				message: "session not found: stale-session",
			},
		});
		expect(events.some((event) => event.event === "run.failed")).toBe(false);
	});

	it("forwards run file attachment paths to the session host", async () => {
		const runTurn = vi.fn().mockResolvedValue(undefined);
		const transport = createTransport({
			sessionHost: {
				subscribe: vi.fn(),
				startSession: vi.fn(),
				stopSession: vi.fn(),
				runTurn,
				abort: vi.fn(),
				dispose: vi.fn(),
				getSession: vi.fn(),
				listSessions: vi.fn(),
				deleteSession: vi.fn(),
				updateSession: vi.fn(),
				dispatchHookEvent: vi.fn(),
			} as never,
		});

		const reply = await (
			transport as unknown as {
				handleCommand: (envelope: {
					version: "v1";
					requestId: string;
					command: "run.start";
					sessionId: string;
					payload: {
						sessionId: string;
						prompt: string;
						mode?: string;
						attachments: { userFiles: string[] };
					};
				}) => Promise<{ ok: boolean }>;
			}
		).handleCommand({
			version: "v1",
			requestId: "req-1",
			command: "run.start",
			sessionId: "session-1",
			payload: {
				sessionId: "session-1",
				prompt: "Use this file",
				mode: "plan",
				attachments: { userFiles: ["/tmp/project/note.md"] },
			},
		});

		expect(reply.ok).toBe(true);
		expect(runTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session-1",
				prompt: "Use this file",
				mode: "plan",
				userFiles: ["/tmp/project/note.md"],
			}),
		);
	});

	it("publishes result error text on failed run events", async () => {
		const runTurn = vi.fn().mockResolvedValue({
			text: "Provider rejected the request",
			finishReason: "error",
			iterations: 1,
			usage: { inputTokens: 0, outputTokens: 0 },
			toolCalls: [],
			messages: [],
			model: { id: "model-1", provider: "provider-1" },
			startedAt: new Date(0),
			endedAt: new Date(0),
			durationMs: 0,
		});
		const transport = createTransport({
			sessionHost: {
				subscribe: vi.fn(),
				startSession: vi.fn(),
				stopSession: vi.fn(),
				runTurn,
				abort: vi.fn(),
				dispose: vi.fn(),
				getSession: vi.fn(),
				listSessions: vi.fn(),
				deleteSession: vi.fn(),
				updateSession: vi.fn(),
				dispatchHookEvent: vi.fn(),
			} as never,
		});
		const events: HubEventEnvelope[] = [];
		transport.subscribe("test", (event) => {
			events.push(event);
		});

		await (
			transport as unknown as {
				handleCommand: (envelope: {
					version: "v1";
					requestId: string;
					command: "run.start";
					sessionId: string;
					payload: { sessionId: string; prompt: string };
				}) => Promise<{ ok: boolean }>;
			}
		).handleCommand({
			version: "v1",
			requestId: "req-1",
			command: "run.start",
			sessionId: "session-1",
			payload: { sessionId: "session-1", prompt: "go" },
		});

		expect(events).toContainEqual(
			expect.objectContaining({
				event: "run.failed",
				payload: expect.objectContaining({
					error: "Provider rejected the request",
				}),
			}),
		);
	});

	it("publishes iteration lifecycle events from agent events", async () => {
		const transport = createTransport();
		const published: string[] = [];
		transport.subscribe("test", (event) => {
			published.push(event.event);
		});
		const ctx = getContext(transport);

		await projectSessionEvent(ctx, {
			type: "agent_event",
			payload: {
				sessionId: "session-1",
				event: { type: "iteration_start", iteration: 3 },
			},
		});
		await projectSessionEvent(ctx, {
			type: "agent_event",
			payload: {
				sessionId: "session-1",
				event: {
					type: "iteration_end",
					iteration: 3,
					hadToolCalls: true,
					toolCallCount: 1,
				},
			},
		});

		expect(published).toEqual(["iteration.started", "iteration.finished"]);
	});

	it("projects live usage events with aggregate usage and agent identity", async () => {
		const usage = {
			inputTokens: 10,
			outputTokens: 3,
			cacheReadTokens: 1,
			cacheWriteTokens: 2,
			totalCost: 0.11,
		};
		const aggregateUsage = {
			inputTokens: 17,
			outputTokens: 8,
			cacheReadTokens: 3,
			cacheWriteTokens: 3,
			totalCost: 0.23,
		};
		const getAccumulatedUsage = vi
			.fn()
			.mockResolvedValue({ usage, aggregateUsage });
		const transport = createTransport({
			sessionHost: { getAccumulatedUsage },
		});
		const events: HubEventEnvelope[] = [];
		transport.subscribe("test", (event) => {
			events.push(event);
		});
		const ctx = getContext(transport);

		await projectSessionEvent(ctx, {
			type: "agent_event",
			payload: {
				sessionId: "session-1",
				teamAgentId: "investigator",
				teamRole: "teammate",
				event: {
					type: "usage",
					agentId: "agent-teammate-1",
					conversationId: "conv-teammate-1",
					parentAgentId: "lead",
					inputTokens: 7,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
					cost: 0.12,
					totalInputTokens: 7,
					totalOutputTokens: 5,
					totalCacheReadTokens: 2,
					totalCacheWriteTokens: 1,
					totalCost: 0.12,
				},
			},
		});

		expect(getAccumulatedUsage).toHaveBeenCalledWith("session-1");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: "usage.updated",
			sessionId: "session-1",
			payload: {
				sessionId: "session-1",
				delta: {
					inputTokens: 7,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
					totalCost: 0.12,
				},
				totals: {
					inputTokens: 7,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
					totalCost: 0.12,
				},
				usage,
				aggregateUsage,
				agent: {
					kind: "teammate",
					agentId: "agent-teammate-1",
					conversationId: "conv-teammate-1",
					parentAgentId: "lead",
					teamAgentId: "investigator",
					teamRole: "teammate",
				},
			},
		});
	});

	it("projects notices with teammate provenance intact", async () => {
		const transport = createTransport();
		const events: HubEventEnvelope[] = [];
		transport.subscribe("test", (event) => events.push(event));
		const ctx = getContext(transport);

		await projectSessionEvent(ctx, {
			type: "agent_event",
			payload: {
				sessionId: "session-1",
				teamAgentId: "investigator",
				teamRole: "teammate",
				event: {
					type: "notice",
					agentId: "agent-teammate-1",
					conversationId: "conv-teammate-1",
					parentAgentId: "lead",
					noticeType: "status",
					displayRole: "status",
					message: "auto-compacted",
					metadata: { kind: "auto_compaction", phase: "completed" },
				},
			},
		});

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: "session.notice",
			sessionId: "session-1",
			payload: {
				agent: {
					kind: "teammate",
					agentId: "agent-teammate-1",
					conversationId: "conv-teammate-1",
					parentAgentId: "lead",
					teamAgentId: "investigator",
					teamRole: "teammate",
				},
			},
		});
	});
});
