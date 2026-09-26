import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentResult,
	MessageWithMetadata,
	ToolApprovalRequest,
	ToolApprovalResult,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../../session/models/session-row";
import {
	DurableToolApprovalCoordinator,
	SqliteDurableToolApprovalStore,
} from "../approval/durable-tool-approval";
import { DurableRunContinuationCoordinator } from "../continuation/durable-run-continuation";
import type { RunRecoverySnapshot } from "../continuation/recovery-snapshot";
import {
	RUN_STATE_KIND,
	RUN_STATE_VERSION,
	type RunState,
	type RunStateToolCallBatchStep,
	type RunStateToolCallResume,
	runStateResumeSteps,
} from "../continuation/run-state";
import { SqliteRunContinuationStore } from "../continuation/sqlite-run-continuation-store";
import { hashToolInput } from "../ledger/idempotency-key";
import { SqliteEffectLedger } from "../ledger/stores/sqlite-effect-ledger";
import { LocalRuntimeHost } from "./local-runtime-host";

function config(sessionId: string) {
	return {
		providerId: "mock-provider",
		modelId: "mock-model",
		cwd: "/tmp/project",
		workspaceRoot: "/tmp/project",
		systemPrompt: "test",
		mode: "act" as const,
		enableTools: true,
		enableSpawnAgent: false,
		enableAgentTeams: false,
		sessionId,
	};
}

function recoverySnapshot(
	request: ToolApprovalRequest,
	messages: MessageWithMetadata[],
): RunRecoverySnapshot {
	return {
		kind: "cline.run-recovery",
		version: 1,
		capturedAt: "2026-09-25T00:00:00.000Z",
		sessionId: request.sessionId,
		source: "cli",
		interactive: false,
		toolName: request.toolName,
		toolOrigin: "core-builtin",
		clientContributionsPresent: false,
		run: {
			runId: request.runId ?? "run-1",
			agentId: request.agentId,
			conversationId: request.conversationId,
			iteration: request.iteration,
			toolCallIndex: request.toolCallIndex ?? 0,
			assistantMessageId: request.assistantMessageId ?? "assistant-1",
			toolCallId: request.toolCallId,
			approvalId: request.approvalId ?? "approval-1",
		},
		preparedInputHash: hashToolInput(request.input),
		transcript: {
			messageCount: messages.length,
			lastMessageId: messages.at(-1)?.id ?? "",
			transcriptHash: hashToolInput(messages),
			systemPromptHash: hashToolInput("test"),
		},
		config: {
			providerId: "mock-provider",
			modelId: "mock-model",
			cwd: "/tmp/project",
			workspaceRoot: "/tmp/project",
			systemPrompt: "test",
			mode: "act",
			enableTools: true,
			enableSpawnAgent: false,
			enableAgentTeams: false,
			toolExecution: "sequential",
		},
		serverRuntime: {
			configExtensions: ["rules", "workflows"],
			skills: ["review"],
			sourceReference: {
				version: 1,
				algorithm: "sha256",
				digest: "a".repeat(64),
			},
		},
		eligibility: { autoRecover: true, reason: "eligible" },
	};
}

function runState(
	request: ToolApprovalRequest,
	messages: MessageWithMetadata[],
): RunState {
	const snapshot = recoverySnapshot(request, messages);
	return {
		kind: RUN_STATE_KIND,
		version: RUN_STATE_VERSION,
		capturedAt: snapshot.capturedAt,
		source: snapshot.source,
		...(snapshot.recoveryOwner
			? { recoveryOwner: snapshot.recoveryOwner }
			: {}),
		interactive: snapshot.interactive,
		resume: {
			type: "tool_call",
			sessionId: snapshot.sessionId,
			...snapshot.run,
			stepId: `step:${snapshot.run.runId}:${snapshot.run.iteration}:${snapshot.run.toolCallIndex}`,
			toolName: snapshot.toolName,
			preparedInputHash: snapshot.preparedInputHash,
		},
		agent: { agentId: snapshot.run.agentId },
		transcript: snapshot.transcript,
		config: snapshot.config,
		...(snapshot.serverRuntime
			? { serverRuntime: snapshot.serverRuntime }
			: {}),
	};
}

/**
 * Turn-level batch cursor for the whole assistant turn, as the host persists it
 * once every tool call of the turn has a decided continuation.
 */
function batchRunState(
	requests: ToolApprovalRequest[],
	messages: MessageWithMetadata[],
	overrides: { steps?: RunStateToolCallBatchStep[]; agentId?: string } = {},
): RunState {
	const base = runState(requests[0] as ToolApprovalRequest, messages);
	const steps =
		overrides.steps ?? requests.map((_, index) => turnStep(requests, index));
	return {
		...base,
		agent: { agentId: overrides.agentId ?? "agent-1" },
		resume: {
			type: "tool_call_batch",
			sessionId: base.resume.sessionId,
			runId: base.resume.runId,
			agentId: base.resume.agentId,
			conversationId: base.resume.conversationId,
			iteration: base.resume.iteration,
			assistantMessageId: base.resume.assistantMessageId,
			steps,
		},
	};
}

function turnStep(
	requests: ToolApprovalRequest[],
	index: number,
): RunStateToolCallBatchStep {
	const request = requests[index] as ToolApprovalRequest;
	return {
		stepId: `step:${request.runId}:${request.iteration}:${index}`,
		toolCallIndex: index,
		toolCallId: request.toolCallId,
		toolName: request.toolName,
		approvalId: request.approvalId as string,
		preparedInputHash: hashToolInput(request.input),
	};
}

function result(messages: MessageWithMetadata[]): AgentResult {
	return {
		text: "resumed",
		usage: {
			inputTokens: 1,
			outputTokens: 1,
			totalCost: 0,
		},
		messages,
		toolCalls: [],
		iterations: 2,
		finishReason: "completed",
		model: { id: "mock-model", provider: "mock-provider" },
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
		endedAt: new Date("2026-01-01T00:00:01.000Z"),
		durationMs: 1,
	};
}

function batchTurn(sessionId: string, runId = "run-batch") {
	const messages: MessageWithMetadata[] = [
		{ role: "user", content: [{ type: "text", text: "read both" }] },
		{
			role: "assistant",
			id: "assistant-batch",
			content: [
				{
					type: "tool_use",
					id: "assistant-batch",
					call_id: "call-1",
					name: "read_files",
					input: { path: "a.md" },
				},
				{
					type: "tool_use",
					id: "assistant-batch",
					call_id: "call-2",
					name: "read_files",
					input: { path: "b.md" },
				},
			],
		},
	];
	const requests: ToolApprovalRequest[] = [0, 1].map((index) => ({
		approvalId: `approval-batch-${index}`,
		sessionId,
		agentId: "agent-1",
		conversationId: "conversation-1",
		runId,
		iteration: 1,
		toolCallIndex: index,
		assistantMessageId: "assistant-batch",
		toolCallId: `call-${index + 1}`,
		toolName: "read_files",
		input: { path: index === 0 ? "a.md" : "b.md" },
		policy: { autoApprove: false },
	}));
	return { messages, requests };
}

async function seedBatchContinuations(
	approvalCoordinator: DurableToolApprovalCoordinator,
	continuationCoordinator: DurableRunContinuationCoordinator,
	requests: ToolApprovalRequest[],
	messages: MessageWithMetadata[],
	stateFor: (request: ToolApprovalRequest) => RunState,
): Promise<string[]> {
	const keys: string[] = [];
	for (const request of requests) {
		await approvalCoordinator.createRequest(request);
		await approvalCoordinator.respond(
			request.approvalId as string,
			{ approved: true },
			"client-1",
		);
		const record = await continuationCoordinator.recordApprovalRequest({
			request,
			assistantMessageId: "assistant-batch",
			agentId: "agent-1",
			conversationId: "conversation-1",
			recoverySnapshot: recoverySnapshot(request, messages),
			runState: stateFor(request),
		});
		if (!record) throw new Error("expected continuation");
		keys.push(record.continuationKey);
	}
	return keys;
}

function batchResumeHost(options: {
	approvalCoordinator: DurableToolApprovalCoordinator;
	continuationCoordinator: DurableRunContinuationCoordinator;
	effectLedger: SqliteEffectLedger;
	sessionId: string;
	messages: MessageWithMetadata[];
	resumeBatch: ReturnType<typeof vi.fn>;
}): LocalRuntimeHost {
	const manifest = {
		version: 1 as const,
		session_id: options.sessionId,
		source: "cli" as const,
		pid: process.pid,
		started_at: "2026-01-01T00:00:00.000Z",
		status: "running" as const,
		interactive: false,
		provider: "mock-provider",
		model: "mock-model",
		cwd: "/tmp/project",
		workspace_root: "/tmp/project",
		enable_tools: true,
		enable_spawn: false,
		enable_teams: false,
		messages_path: "/tmp/messages.json",
	};
	const sessionService = {
		ensureSessionsDir: vi.fn().mockReturnValue("/tmp/sessions"),
		createRootSessionWithArtifacts: vi.fn().mockResolvedValue({
			manifestPath: "/tmp/manifest.json",
			messagesPath: "/tmp/messages.json",
			manifest,
		}),
		readSessionMessages: vi.fn().mockResolvedValue(options.messages),
		persistSessionMessages: vi.fn().mockResolvedValue(undefined),
		updateSessionStatus: vi.fn().mockResolvedValue({ updated: true }),
		writeSessionManifest: vi.fn().mockResolvedValue(undefined),
		listSessions: vi.fn().mockResolvedValue([]),
		deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
	};
	const agent = {
		run: vi.fn(),
		continue: vi.fn(),
		resumePendingToolCall: vi.fn(),
		resumePendingToolBatch: options.resumeBatch,
		abort: vi.fn(),
		subscribeEvents: vi.fn().mockReturnValue(() => {}),
		canStartRun: vi.fn().mockReturnValue(true),
		getAgentId: vi.fn().mockReturnValue("agent-1"),
		getConversationId: vi.fn().mockReturnValue("conversation-1"),
		getMessages: vi.fn().mockReturnValue(options.messages),
		shutdown: vi.fn().mockResolvedValue(undefined),
	};
	const host = new LocalRuntimeHost({
		sessionService: sessionService as never,
		approvalCoordinator: options.approvalCoordinator,
		continuationCoordinator: options.continuationCoordinator,
		effectLedger: options.effectLedger,
		runtimeBuilder: {
			build: vi.fn().mockReturnValue({
				tools: [],
				shutdown: vi.fn().mockResolvedValue(undefined),
				getServerRuntimeSourceReference: () => ({
					version: 1,
					algorithm: "sha256",
					digest: "a".repeat(64),
				}),
			}),
		} as never,
		createAgent: () => agent as never,
	});
	vi.spyOn(host, "readSessionMessages").mockResolvedValue(options.messages);
	return host;
}

/**
 * Host wired so a fake agent turn can drive the real durable-approval path
 * (`capabilities.requestToolApproval` → continuation journal).
 */
function approvalPathHost(options: {
	sessionId: string;
	messages: MessageWithMetadata[];
	approvalCoordinator: DurableToolApprovalCoordinator;
	continuationCoordinator: DurableRunContinuationCoordinator;
	effectLedger: SqliteEffectLedger;
	run: (
		requestToolApproval: (
			request: ToolApprovalRequest,
		) => Promise<ToolApprovalResult>,
	) => Promise<AgentResult>;
	onAgentConfig?: (config: Record<string, unknown>) => void;
	resumeSingle?: ReturnType<typeof vi.fn>;
	resumeBatch?: ReturnType<typeof vi.fn>;
}): LocalRuntimeHost {
	const manifest = {
		version: 1 as const,
		session_id: options.sessionId,
		source: "cli" as const,
		pid: process.pid,
		started_at: "2026-01-01T00:00:00.000Z",
		status: "running" as const,
		interactive: false,
		provider: "mock-provider",
		model: "mock-model",
		cwd: "/tmp/project",
		workspace_root: "/tmp/project",
		enable_tools: true,
		enable_spawn: false,
		enable_teams: false,
		messages_path: "/tmp/messages.json",
	};
	const sessionService = {
		ensureSessionsDir: vi.fn().mockReturnValue("/tmp/sessions"),
		createRootSessionWithArtifacts: vi.fn().mockResolvedValue({
			manifestPath: "/tmp/manifest.json",
			messagesPath: "/tmp/messages.json",
			manifest,
		}),
		readSessionMessages: vi.fn().mockResolvedValue(options.messages),
		persistSessionMessages: vi.fn().mockResolvedValue(undefined),
		updateSessionStatus: vi.fn().mockResolvedValue({ updated: true }),
		writeSessionManifest: vi.fn().mockResolvedValue(undefined),
		listSessions: vi.fn().mockResolvedValue([]),
		deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
	};
	let requestToolApproval:
		| ((request: ToolApprovalRequest) => Promise<ToolApprovalResult>)
		| undefined;
	const agent = {
		run: vi.fn(async () => options.run(requestToolApproval as never)),
		continue: vi.fn(async () => options.run(requestToolApproval as never)),
		resumePendingToolCall: options.resumeSingle ?? vi.fn(),
		resumePendingToolBatch: options.resumeBatch ?? vi.fn(),
		abort: vi.fn(),
		subscribeEvents: vi.fn().mockReturnValue(() => {}),
		canStartRun: vi.fn().mockReturnValue(true),
		getAgentId: vi.fn().mockReturnValue("agent-1"),
		getConversationId: vi.fn().mockReturnValue("conversation-1"),
		getMessages: vi.fn().mockReturnValue(options.messages),
		shutdown: vi.fn().mockResolvedValue(undefined),
	};
	const host = new LocalRuntimeHost({
		sessionService: sessionService as never,
		approvalCoordinator: options.approvalCoordinator,
		continuationCoordinator: options.continuationCoordinator,
		effectLedger: options.effectLedger,
		runtimeBuilder: {
			build: vi.fn().mockReturnValue({
				tools: [],
				shutdown: vi.fn().mockResolvedValue(undefined),
				getServerRuntimeSourceReference: () => ({
					version: 1,
					algorithm: "sha256",
					digest: "a".repeat(64),
				}),
			}),
		} as never,
		createAgent: (agentConfig) => {
			const config = agentConfig as unknown as Record<string, unknown>;
			options.onAgentConfig?.(config);
			requestToolApproval =
				config.requestToolApproval as typeof requestToolApproval;
			return agent as never;
		},
	});
	vi.spyOn(host, "readSessionMessages").mockResolvedValue(options.messages);
	return host;
}

describe("LocalRuntimeHost durable run continuation", () => {
	it("resumes one decided approval after a runtime restart", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const sessionId = "session-resume";
		const assistantMessage: MessageWithMetadata = {
			role: "assistant",
			id: "assistant-1",
			content: [
				{
					type: "tool_use",
					id: "assistant-1",
					call_id: "call-1",
					name: "write_file",
					input: { path: "a.txt" },
				},
			],
		};
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "write it" }] },
			assistantMessage,
		];
		const approvalRequest: ToolApprovalRequest = {
			approvalId: "approval-1",
			sessionId,
			agentId: "agent-1",
			conversationId: "conversation-1",
			runId: "run-1",
			iteration: 1,
			toolCallIndex: 0,
			assistantMessageId: "assistant-1",
			toolCallId: "call-1",
			toolName: "write_file",
			input: { path: "a.txt" },
			policy: { autoApprove: false },
		};
		await approvalCoordinator.createRequest(approvalRequest);
		await approvalCoordinator.respond(
			"approval-1",
			{ approved: true },
			"client-1",
		);
		const continuation = await continuationCoordinator.recordApprovalRequest({
			request: approvalRequest,
			assistantMessageId: "assistant-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			recoverySnapshot: recoverySnapshot(approvalRequest, messages),
			runState: runState(approvalRequest, messages),
		});
		if (!continuation) throw new Error("expected continuation");
		await continuationCoordinator.markApprovalDecision(
			continuation.continuationKey,
		);

		const manifest = {
			version: 1 as const,
			session_id: sessionId,
			source: "cli" as const,
			pid: process.pid,
			started_at: "2026-01-01T00:00:00.000Z",
			status: "running" as const,
			interactive: false,
			provider: "mock-provider",
			model: "mock-model",
			cwd: "/tmp/project",
			workspace_root: "/tmp/project",
			enable_tools: true,
			enable_spawn: false,
			enable_teams: false,
			messages_path: "/tmp/messages.json",
		};
		const persistSessionMessages = vi.fn().mockResolvedValue(undefined);
		const sessionService = {
			ensureSessionsDir: vi.fn().mockReturnValue("/tmp/sessions"),
			createRootSessionWithArtifacts: vi.fn().mockResolvedValue({
				manifestPath: "/tmp/manifest.json",
				messagesPath: "/tmp/messages.json",
				manifest,
			}),
			readSessionMessages: vi.fn().mockResolvedValue(messages),
			persistSessionMessages,
			updateSessionStatus: vi.fn().mockResolvedValue({ updated: true }),
			writeSessionManifest: vi.fn().mockResolvedValue(undefined),
			listSessions: vi.fn().mockResolvedValue([]),
			deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
		};
		const resume = vi.fn().mockResolvedValue(result(messages));
		const agent = {
			run: vi.fn(),
			continue: vi.fn(),
			resumePendingToolCall: resume,
			abort: vi.fn(),
			subscribeEvents: vi.fn().mockReturnValue(() => {}),
			canStartRun: vi.fn().mockReturnValue(true),
			getAgentId: vi.fn().mockReturnValue("agent-1"),
			getConversationId: vi.fn().mockReturnValue("conversation-1"),
			getMessages: vi.fn().mockReturnValue(messages),
			shutdown: vi.fn().mockResolvedValue(undefined),
		};
		const runtimeIdentity = vi.fn();
		const buildRuntime = vi.fn().mockReturnValue({
			tools: [],
			shutdown: vi.fn().mockResolvedValue(undefined),
			getServerRuntimeSourceReference: () => ({
				version: 1,
				algorithm: "sha256",
				digest: "a".repeat(64),
			}),
		});
		const host = new LocalRuntimeHost({
			sessionService: sessionService as never,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger: new SqliteEffectLedger({ dbPath: ":memory:" }),
			runtimeBuilder: {
				build: buildRuntime,
			} as never,
			createAgent: (_config, deps) => {
				runtimeIdentity(deps?.runtimeIdentity);
				return agent as never;
			},
		});

		vi.spyOn(host, "readSessionMessages").mockResolvedValue(messages);
		const resumed = await host.resumePendingRun({
			continuationKey: continuation.continuationKey,
			start: {
				config: { ...config(sessionId), skills: ["client-skill"] },
				localRuntime: { configExtensions: ["plugins"] },
			},
		});

		expect(buildRuntime).toHaveBeenCalledWith(
			expect.objectContaining({
				configExtensions: ["rules", "workflows"],
				config: expect.objectContaining({ skills: ["review"] }),
			}),
		);
		expect(resume).toHaveBeenCalledWith({
			runId: "run-1",
			iteration: 1,
			stepId: "step:run-1:1:0",
			assistantMessageId: "assistant-1",
			toolCallId: "call-1",
			toolName: "write_file",
			preparedInput: { path: "a.txt" },
			approval: { approved: true, reason: undefined },
		});
		expect(runtimeIdentity).toHaveBeenCalledWith({
			agentId: "agent-1",
			conversationId: "conversation-1",
		});
		expect(resumed.record.phase).toBe("completed");
		expect(persistSessionMessages).toHaveBeenCalled();
		await host.dispose();
		await approvalCoordinator.close();
		await continuationCoordinator.close();
	});

	it("resumes a decided multi-tool batch as one assistant turn", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-batch-resume";
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "read both" }] },
			{
				role: "assistant",
				id: "assistant-batch",
				content: [
					{
						type: "tool_use",
						id: "assistant-batch",
						call_id: "call-1",
						name: "read_files",
						input: { path: "a.md" },
					},
					{
						type: "tool_use",
						id: "assistant-batch",
						call_id: "call-2",
						name: "read_files",
						input: { path: "b.md" },
					},
				],
			},
		];
		const requests: ToolApprovalRequest[] = [0, 1].map((index) => ({
			approvalId: `approval-batch-${index}`,
			sessionId,
			agentId: "agent-1",
			conversationId: "conversation-1",
			runId: "run-batch",
			iteration: 1,
			toolCallIndex: index,
			assistantMessageId: "assistant-batch",
			toolCallId: `call-${index + 1}`,
			toolName: "read_files",
			input: { path: index === 0 ? "a.md" : "b.md" },
			policy: { autoApprove: false },
		}));
		const continuationKeys: string[] = [];
		for (const request of requests) {
			await approvalCoordinator.createRequest(request);
			await approvalCoordinator.respond(
				request.approvalId as string,
				{ approved: true },
				"client-1",
			);
			const record = await continuationCoordinator.recordApprovalRequest({
				request,
				assistantMessageId: "assistant-batch",
				agentId: "agent-1",
				conversationId: "conversation-1",
				recoverySnapshot: recoverySnapshot(request, messages),
				runState: runState(request, messages),
			});
			if (!record) throw new Error("expected continuation");
			continuationKeys.push(record.continuationKey);
		}
		const manifest = {
			version: 1 as const,
			session_id: sessionId,
			source: "cli" as const,
			pid: process.pid,
			started_at: "2026-01-01T00:00:00.000Z",
			status: "running" as const,
			interactive: false,
			provider: "mock-provider",
			model: "mock-model",
			cwd: "/tmp/project",
			workspace_root: "/tmp/project",
			enable_tools: true,
			enable_spawn: false,
			enable_teams: false,
			messages_path: "/tmp/messages.json",
		};
		const sessionService = {
			ensureSessionsDir: vi.fn().mockReturnValue("/tmp/sessions"),
			createRootSessionWithArtifacts: vi.fn().mockResolvedValue({
				manifestPath: "/tmp/manifest.json",
				messagesPath: "/tmp/messages.json",
				manifest,
			}),
			readSessionMessages: vi.fn().mockResolvedValue(messages),
			persistSessionMessages: vi.fn().mockResolvedValue(undefined),
			updateSessionStatus: vi.fn().mockResolvedValue({ updated: true }),
			writeSessionManifest: vi.fn().mockResolvedValue(undefined),
			listSessions: vi.fn().mockResolvedValue([]),
			deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
		};
		const resumeBatch = vi.fn().mockResolvedValue(result(messages));
		const agent = {
			run: vi.fn(),
			continue: vi.fn(),
			resumePendingToolCall: vi.fn(),
			resumePendingToolBatch: resumeBatch,
			abort: vi.fn(),
			subscribeEvents: vi.fn().mockReturnValue(() => {}),
			canStartRun: vi.fn().mockReturnValue(true),
			getAgentId: vi.fn().mockReturnValue("agent-1"),
			getConversationId: vi.fn().mockReturnValue("conversation-1"),
			getMessages: vi.fn().mockReturnValue(messages),
			shutdown: vi.fn().mockResolvedValue(undefined),
		};
		const host = new LocalRuntimeHost({
			sessionService: sessionService as never,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			runtimeBuilder: {
				build: vi.fn().mockReturnValue({
					tools: [],
					shutdown: vi.fn().mockResolvedValue(undefined),
					getServerRuntimeSourceReference: () => ({
						version: 1,
						algorithm: "sha256",
						digest: "a".repeat(64),
					}),
				}),
			} as never,
			createAgent: () => agent as never,
		});
		vi.spyOn(host, "readSessionMessages").mockResolvedValue(messages);

		try {
			const resumed = await host.resumePendingRunBatch({
				continuationKeys: [...continuationKeys].reverse(),
				start: { config: config(sessionId) },
			});

			expect(resumeBatch).toHaveBeenCalledWith({
				runId: "run-batch",
				iteration: 1,
				assistantMessageId: "assistant-batch",
				calls: [
					{
						stepId: "step:run-batch:1:0",
						toolCallId: "call-1",
						toolName: "read_files",
						preparedInput: { path: "a.md" },
						approval: { approved: true, reason: undefined },
					},
					{
						stepId: "step:run-batch:1:1",
						toolCallId: "call-2",
						toolName: "read_files",
						preparedInput: { path: "b.md" },
						approval: { approved: true, reason: undefined },
					},
				],
			});
			expect(resumed.records).toHaveLength(2);
			expect(resumed.records.map((record) => record.phase)).toEqual([
				"completed",
				"completed",
			]);
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("replays a decided batch from the turn-level run state cursor", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-batch-cursor";
		const { messages, requests } = batchTurn(sessionId);
		const turnState = batchRunState(requests, messages);
		// The host persists the turn-level cursor on the last continuation of
		// the turn; earlier steps keep their per-step cursor.
		const continuationKeys = await seedBatchContinuations(
			approvalCoordinator,
			continuationCoordinator,
			requests,
			messages,
			(request) =>
				request.toolCallIndex === 1 ? turnState : runState(request, messages),
		);
		const stored = await continuationCoordinator.get(
			continuationKeys[1] as string,
		);
		expect(stored?.runState?.resume.type).toBe("tool_call_batch");
		expect(
			stored?.runState ? runStateResumeSteps(stored.runState.resume) : [],
		).toHaveLength(2);
		const resumeBatch = vi.fn().mockResolvedValue(result(messages));
		const host = batchResumeHost({
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			sessionId,
			messages,
			resumeBatch,
		});
		try {
			const resumed = await host.resumePendingRunBatch({
				continuationKeys,
				start: { config: config(sessionId) },
			});
			expect(resumeBatch).toHaveBeenCalledWith({
				runId: "run-batch",
				iteration: 1,
				assistantMessageId: "assistant-batch",
				calls: [
					{
						stepId: "step:run-batch:1:0",
						toolCallId: "call-1",
						toolName: "read_files",
						preparedInput: { path: "a.md" },
						approval: { approved: true, reason: undefined },
					},
					{
						stepId: "step:run-batch:1:1",
						toolCallId: "call-2",
						toolName: "read_files",
						preparedInput: { path: "b.md" },
						approval: { approved: true, reason: undefined },
					},
				],
			});
			expect(resumed.records.every((item) => item.phase === "completed")).toBe(
				true,
			);
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("replays a parallel multi-tool turn in the recorded execution mode", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-parallel-batch";
		const { messages, requests } = batchTurn(sessionId, "run-parallel");
		const parallelState = (request: ToolApprovalRequest): RunState => {
			const base =
				request.toolCallIndex === 1
					? batchRunState(requests, messages)
					: runState(request, messages);
			return {
				...base,
				config: {
					...base.config,
					toolExecution: "parallel",
					maxParallelToolCalls: 2,
				},
			};
		};
		const continuationKeys = await seedBatchContinuations(
			approvalCoordinator,
			continuationCoordinator,
			requests,
			messages,
			(request) => parallelState(request),
		);
		const resumeBatch = vi.fn().mockResolvedValue(result(messages));
		const startedConfigs: Record<string, unknown>[] = [];
		const host = approvalPathHost({
			sessionId,
			messages,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			run: async () => result(messages),
			resumeBatch,
			onAgentConfig: (agentConfig) => {
				startedConfigs.push(agentConfig);
			},
		});
		try {
			const resumed = await host.resumePendingRunBatch({
				continuationKeys,
				start: { config: config(sessionId) },
			});
			expect(resumeBatch).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: "run-parallel",
					calls: [
						expect.objectContaining({
							stepId: "step:run-parallel:1:0",
							toolCallId: "call-1",
						}),
						expect.objectContaining({
							stepId: "step:run-parallel:1:1",
							toolCallId: "call-2",
						}),
					],
				}),
			);
			expect(resumed.records.every((item) => item.phase === "completed")).toBe(
				true,
			);
			// The rebuilt session keeps the recorded parallel mode, so the runtime
			// replays the whole turn concurrently instead of degrading to
			// sequential execution.
			expect(startedConfigs[0]).toMatchObject({ maxParallelToolCalls: 2 });
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("rejects a batch whose cursor does not cover every persisted tool call", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-batch-incomplete-turn";
		// Only the first tool call of the turn was recorded before the process
		// died, but the persisted assistant turn still requests a second call.
		const recorded = batchTurn(sessionId);
		const recordedRequests = [recorded.requests[0] as ToolApprovalRequest];
		const state = batchRunState(recordedRequests, recorded.messages, {
			steps: [turnStep(recordedRequests, 0)],
		});
		const continuationKeys = await seedBatchContinuations(
			approvalCoordinator,
			continuationCoordinator,
			recordedRequests,
			recorded.messages,
			() => state,
		);
		const resumeBatch = vi.fn().mockResolvedValue(result(recorded.messages));
		const host = batchResumeHost({
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			sessionId,
			messages: batchTurn(sessionId).messages,
			resumeBatch,
		});
		try {
			await expect(
				host.resumePendingRunBatch({
					continuationKeys,
					start: { config: config(sessionId) },
				}),
			).rejects.toThrow("does not cover every persisted tool call");
			expect(resumeBatch).not.toHaveBeenCalled();
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("rejects a batch whose cursor points at another assistant turn", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-batch-other-turn";
		const { messages, requests } = batchTurn(sessionId);
		const otherTurn: MessageWithMetadata[] = [
			...(messages as MessageWithMetadata[]),
			{
				role: "assistant",
				id: "assistant-batch-2",
				content: [
					{
						type: "tool_use",
						id: "assistant-batch-2",
						call_id: "call-3",
						name: "read_files",
						input: { path: "c.md" },
					},
				],
			},
		];
		const continuationKeys = await seedBatchContinuations(
			approvalCoordinator,
			continuationCoordinator,
			requests,
			messages,
			(request) =>
				request.toolCallIndex === 1
					? batchRunState(requests, messages)
					: runState(request, messages),
		);
		const resumeBatch = vi.fn().mockResolvedValue(result(messages));
		const host = batchResumeHost({
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			sessionId,
			messages: otherTurn,
			resumeBatch,
		});
		try {
			await expect(
				host.resumePendingRunBatch({
					continuationKeys,
					start: { config: config(sessionId) },
				}),
			).rejects.toThrow(
				"Run state batch does not match the persisted assistant turn",
			);
			expect(resumeBatch).not.toHaveBeenCalled();
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("refuses to resume one step of a multi-tool turn on its own", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-batch-single-step";
		const { messages, requests } = batchTurn(sessionId);
		const continuationKeys = await seedBatchContinuations(
			approvalCoordinator,
			continuationCoordinator,
			requests,
			messages,
			(request) =>
				request.toolCallIndex === 1
					? batchRunState(requests, messages)
					: runState(request, messages),
		);
		const resumeBatch = vi.fn().mockResolvedValue(result(messages));
		const host = batchResumeHost({
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			sessionId,
			messages,
			resumeBatch,
		});
		try {
			await expect(
				host.resumePendingRun({
					continuationKey: continuationKeys[1] as string,
					start: { config: config(sessionId) },
				}),
			).rejects.toThrow("one step of a multi-tool assistant turn");
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("rejects a batch whose run state records a different agent", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-batch-agent-drift";
		const { messages, requests } = batchTurn(sessionId);
		const state = batchRunState(requests, messages, { agentId: "agent-9" });
		const continuationKeys = await seedBatchContinuations(
			approvalCoordinator,
			continuationCoordinator,
			requests,
			messages,
			(request) =>
				request.toolCallIndex === 1 ? state : runState(request, messages),
		);
		const resumeBatch = vi.fn().mockResolvedValue(result(messages));
		const host = batchResumeHost({
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			sessionId,
			messages,
			resumeBatch,
		});
		try {
			await expect(
				host.resumePendingRunBatch({
					continuationKeys,
					start: { config: config(sessionId) },
				}),
			).rejects.toThrow("agent identity does not match");
			expect(resumeBatch).not.toHaveBeenCalled();
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("rejects a batch whose transcript drifted after the cursor was recorded", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-batch-turn-drift";
		const { messages, requests } = batchTurn(sessionId);
		const continuationKeys = await seedBatchContinuations(
			approvalCoordinator,
			continuationCoordinator,
			requests,
			messages,
			(request) => runState(request, messages),
		);
		// The assistant turn still matches; an earlier message changed, so the
		// recorded transcript fingerprint no longer describes the session.
		const driftedMessages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "read everything" }] },
			...(messages as MessageWithMetadata[]).slice(1),
		];
		const resumeBatch = vi.fn().mockResolvedValue(result(messages));
		const host = batchResumeHost({
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			sessionId,
			messages: driftedMessages,
			resumeBatch,
		});
		try {
			await expect(
				host.resumePendingRunBatch({
					continuationKeys,
					start: { config: config(sessionId) },
				}),
			).rejects.toThrow("Run state transcript does not match");
			expect(resumeBatch).not.toHaveBeenCalled();
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("upgrades the per-step cursor once the whole assistant turn is recorded", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-batch-upgrade";
		const { messages, requests } = batchTurn(sessionId);
		const first = requests[0] as ToolApprovalRequest;
		const second = requests[1] as ToolApprovalRequest;
		await approvalCoordinator.createRequest(first);
		await approvalCoordinator.respond(
			first.approvalId as string,
			{ approved: true },
			"client-1",
		);
		await continuationCoordinator.recordApprovalRequest({
			request: first,
			assistantMessageId: "assistant-batch",
			agentId: "agent-1",
			conversationId: "conversation-1",
			recoverySnapshot: recoverySnapshot(first, messages),
			runState: runState(first, messages),
		});
		const host = new LocalRuntimeHost({
			sessionService: {} as never,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
		});
		const withTurnBatchRunState = (
			host as unknown as {
				withTurnBatchRunState: (
					state: RunState,
					session: unknown,
					request: ToolApprovalRequest,
					persisted: MessageWithMetadata[],
				) => Promise<RunState>;
			}
		).withTurnBatchRunState.bind(host);
		const session = { sessionId, config: { logger: { debug: vi.fn() } } };
		try {
			// The first tool call of the turn is already durable, so the cursor
			// for the second one can describe the complete turn.
			const complete = await withTurnBatchRunState(
				runState(second, messages),
				session,
				second,
				messages,
			);
			expect(complete.resume.type).toBe("tool_call_batch");
			expect(runStateResumeSteps(complete.resume).map((s) => s.stepId)).toEqual(
				["step:run-batch:1:0", "step:run-batch:1:1"],
			);

			// A turn whose later tool call has no durable continuation yet keeps
			// the per-step cursor.
			const partial = await withTurnBatchRunState(
				runState(first, messages),
				session,
				first,
				messages,
			);
			expect(partial.resume.type).toBe("tool_call");
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("refuses to resume a delegated agent run as a root run", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-delegated-agent";
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "review it" }] },
			{
				role: "assistant",
				id: "assistant-1",
				content: [
					{
						type: "tool_use",
						id: "assistant-1",
						call_id: "call-1",
						name: "read_files",
						input: { path: "a.md" },
					},
				],
			},
		];
		const request: ToolApprovalRequest = {
			approvalId: "approval-delegated",
			sessionId,
			agentId: "agent-child",
			conversationId: "conversation-1",
			runId: "run-child",
			iteration: 1,
			toolCallIndex: 0,
			assistantMessageId: "assistant-1",
			toolCallId: "call-1",
			toolName: "read_files",
			input: { path: "a.md" },
			policy: { autoApprove: false },
		};
		await approvalCoordinator.createRequest(request);
		await approvalCoordinator.respond(
			"approval-delegated",
			{ approved: true },
			"client-1",
		);
		const delegatedState: RunState = {
			...runState(request, messages),
			agent: {
				agentId: "agent-child",
				parentAgentId: "agent-root",
				rootRunId: "run-root",
			},
		};
		const continuation = await continuationCoordinator.recordApprovalRequest({
			request,
			assistantMessageId: "assistant-1",
			agentId: "agent-child",
			conversationId: "conversation-1",
			recoverySnapshot: recoverySnapshot(request, messages),
			runState: delegatedState,
			agentChain: {
				agentId: "agent-child",
				parentAgentId: "agent-root",
				rootRunId: "run-root",
			},
		});
		if (!continuation) throw new Error("expected continuation");
		await continuationCoordinator.markApprovalDecision(
			continuation.continuationKey,
		);
		const host = new LocalRuntimeHost({
			sessionService: {} as never,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
		});
		try {
			await expect(
				host.resumePendingRun({
					continuationKey: continuation.continuationKey,
					start: { config: config(sessionId) },
				}),
			).rejects.toThrow("requires agent chain recovery");
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("refuses a delegated continuation that carries no run state", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-delegated-chain";
		const request: ToolApprovalRequest = {
			approvalId: "approval-delegated-chain",
			sessionId,
			agentId: "agent-child",
			parentAgentId: "agent-root",
			rootRunId: "run-root",
			conversationId: "conversation-child",
			runId: "run-child",
			iteration: 1,
			toolCallIndex: 0,
			assistantMessageId: "assistant-1",
			toolCallId: "call-1",
			toolName: "read_files",
			input: { path: "a.md" },
			policy: { autoApprove: false },
		};
		await approvalCoordinator.createRequest(request);
		await approvalCoordinator.respond(
			"approval-delegated-chain",
			{ approved: true },
			"client-1",
		);
		const continuation = await continuationCoordinator.recordApprovalRequest({
			request,
			assistantMessageId: "assistant-1",
			agentId: "agent-child",
			conversationId: "conversation-child",
			// A delegated run records its chain only: the host cannot see the
			// child's transcript, so there is no truthful recovery state.
			agentChain: {
				agentId: "agent-child",
				parentAgentId: "agent-root",
				rootRunId: "run-root",
			},
		});
		if (!continuation) throw new Error("expected continuation");
		expect(continuation.agentChain).toEqual({
			agentId: "agent-child",
			parentAgentId: "agent-root",
			rootRunId: "run-root",
		});
		expect(continuation.runState).toBeUndefined();
		expect(continuation.recoverySnapshot).toBeUndefined();
		await continuationCoordinator.markApprovalDecision(
			continuation.continuationKey,
		);
		const host = new LocalRuntimeHost({
			sessionService: {} as never,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
		});
		try {
			await expect(
				host.resumePendingRun({
					continuationKey: continuation.continuationKey,
					start: { config: config(sessionId) },
				}),
			).rejects.toThrow("requires agent chain recovery");
			const report = await host.recoverPendingRunContinuations();
			expect(report.eligible).toBe(0);
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("rejects a batch that is missing one of the assistant tool calls", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-batch-gap";
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "read both" }] },
			{
				role: "assistant",
				id: "assistant-batch",
				content: [
					{
						type: "tool_use",
						id: "assistant-batch",
						call_id: "call-1",
						name: "read_files",
						input: { path: "a.md" },
					},
					{
						type: "tool_use",
						id: "assistant-batch",
						call_id: "call-2",
						name: "read_files",
						input: { path: "b.md" },
					},
				],
			},
		];
		const request: ToolApprovalRequest = {
			approvalId: "approval-batch-gap",
			sessionId,
			agentId: "agent-1",
			conversationId: "conversation-1",
			runId: "run-batch",
			iteration: 1,
			toolCallIndex: 1,
			assistantMessageId: "assistant-batch",
			toolCallId: "call-2",
			toolName: "read_files",
			input: { path: "b.md" },
			policy: { autoApprove: false },
		};
		await approvalCoordinator.createRequest(request);
		await approvalCoordinator.respond(
			"approval-batch-gap",
			{ approved: true },
			"client-1",
		);
		const record = await continuationCoordinator.recordApprovalRequest({
			request,
			assistantMessageId: "assistant-batch",
			agentId: "agent-1",
			conversationId: "conversation-1",
			recoverySnapshot: recoverySnapshot(request, messages),
			runState: runState(request, messages),
		});
		if (!record) throw new Error("expected continuation");
		const host = new LocalRuntimeHost({
			sessionService: {} as never,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
		});
		try {
			await expect(
				host.resumePendingRunBatch({
					continuationKeys: [record.continuationKey],
					start: { config: config(sessionId) },
				}),
			).rejects.toThrow("missing tool call 0");
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("rejects a run state whose step identity points at another step", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-forged-step";
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "write it" }] },
			{
				role: "assistant",
				id: "assistant-1",
				content: [
					{
						type: "tool_use",
						id: "assistant-1",
						call_id: "call-1",
						name: "write_file",
						input: { path: "a.txt" },
					},
				],
			},
		];
		const request: ToolApprovalRequest = {
			approvalId: "approval-forged-step",
			sessionId,
			agentId: "agent-1",
			conversationId: "conversation-1",
			runId: "run-1",
			iteration: 1,
			toolCallIndex: 0,
			assistantMessageId: "assistant-1",
			toolCallId: "call-1",
			toolName: "write_file",
			input: { path: "a.txt" },
			policy: { autoApprove: false },
		};
		await approvalCoordinator.createRequest(request);
		await approvalCoordinator.respond(
			"approval-forged-step",
			{ approved: true },
			"client-1",
		);
		const forgedState = runState(request, messages);
		const forgedResume = forgedState.resume as RunStateToolCallResume;
		forgedResume.stepId = "step:run-1:9:9";
		const continuation = await continuationCoordinator.recordApprovalRequest({
			request,
			assistantMessageId: "assistant-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			recoverySnapshot: recoverySnapshot(request, messages),
			runState: forgedState,
		});
		if (!continuation) throw new Error("expected continuation");
		await continuationCoordinator.markApprovalDecision(
			continuation.continuationKey,
		);
		const host = new LocalRuntimeHost({
			sessionService: {} as never,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
		});
		try {
			await expect(
				host.resumePendingRun({
					continuationKey: continuation.continuationKey,
					start: { config: config(sessionId) },
				}),
			).rejects.toThrow("step identity does not match");
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("requires explicit reclaim for an executing continuation", async () => {
		const approvalStore = new SqliteDurableToolApprovalStore({
			dbPath: ":memory:",
		});
		const continuationStore = new SqliteRunContinuationStore({
			dbPath: ":memory:",
		});
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			approvalStore,
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			continuationStore,
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const request: ToolApprovalRequest = {
			approvalId: "approval-executing",
			sessionId: "session-executing",
			agentId: "agent-1",
			conversationId: "conversation-1",
			runId: "run-1",
			iteration: 1,
			toolCallIndex: 0,
			assistantMessageId: "assistant-1",
			toolCallId: "call-1",
			toolName: "write_file",
			input: { path: "a.txt" },
			policy: { autoApprove: false },
		};
		await approvalCoordinator.createRequest(request);
		await approvalCoordinator.respond(
			"approval-executing",
			{ approved: true },
			"client-1",
		);
		const record = await continuationCoordinator.recordApprovalRequest({
			request,
			assistantMessageId: "assistant-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
		});
		if (!record) throw new Error("expected continuation");
		await continuationCoordinator.markApprovalDecision(record.continuationKey);
		const claim = await continuationCoordinator.claim(
			record.continuationKey,
			"old-owner",
		);
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		await continuationCoordinator.markExecuting(
			record.continuationKey,
			"old-owner",
		);
		const host = new LocalRuntimeHost({
			sessionService: {} as never,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
		});
		try {
			await expect(
				host.resumePendingRun({
					continuationKey: record.continuationKey,
					start: { config: config("session-executing") },
				}),
			).rejects.toThrow("requires explicit reclaim");
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("schedules an eligible stale root continuation during startup recovery", async () => {
		const recoveryDir = mkdtempSync(join(tmpdir(), "cline-startup-recovery-"));
		const approvalStore = new SqliteDurableToolApprovalStore({
			dbPath: join(recoveryDir, "approvals.db"),
		});
		const continuationStore = new SqliteRunContinuationStore({
			dbPath: join(recoveryDir, "continuations.db"),
		});
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			approvalStore,
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			continuationStore,
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-recovery";
		const request: ToolApprovalRequest = {
			approvalId: "approval-recovery",
			sessionId,
			agentId: "agent-1",
			conversationId: "conversation-1",
			runId: "run-1",
			iteration: 1,
			toolCallIndex: 0,
			assistantMessageId: "assistant-1",
			toolCallId: "call-1",
			toolName: "read_files",
			input: { path: "README.md" },
			policy: { autoApprove: false },
		};
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "read it" }] },
			{
				role: "assistant",
				id: "assistant-1",
				content: [
					{
						type: "tool_use",
						id: "assistant-1",
						call_id: "call-1",
						name: "read_files",
						input: { path: "README.md" },
					},
				],
			},
		];
		await approvalCoordinator.createRequest(request);
		await approvalCoordinator.respond(
			"approval-recovery",
			{ approved: true },
			"client-1",
		);
		const record = await continuationCoordinator.recordApprovalRequest({
			request,
			assistantMessageId: "assistant-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			recoverySnapshot: recoverySnapshot(request, messages),
		});
		if (!record) throw new Error("expected continuation");
		await approvalCoordinator.close();
		await continuationCoordinator.close();
		const restartedApprovalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({
				dbPath: join(recoveryDir, "approvals.db"),
			}),
		);
		const restartedContinuationCoordinator =
			new DurableRunContinuationCoordinator(
				new SqliteRunContinuationStore({
					dbPath: join(recoveryDir, "continuations.db"),
				}),
			);
		const row: SessionRow = {
			sessionId,
			source: "cli",
			pid: 0,
			startedAt: "2026-09-25T00:00:00.000Z",
			status: "failed",
			statusLock: 1,
			interactive: false,
			provider: "mock-provider",
			model: "mock-model",
			cwd: "/tmp/project",
			workspaceRoot: "/tmp/project",
			enableTools: true,
			enableSpawn: false,
			enableTeams: false,
			isSubagent: false,
			metadata: {
				terminal_marker: "failed_external_process_exit",
				terminal_marker_source: "stale_session_reconciler",
			},
			messagesPath: "/tmp/messages.json",
			updatedAt: "2026-09-25T00:00:00.000Z",
		};
		const host = new LocalRuntimeHost({
			sessionService: {
				getSession: vi.fn().mockResolvedValue(row),
				listSessions: vi.fn().mockResolvedValue([row]),
			} as never,
			approvalCoordinator: restartedApprovalCoordinator,
			continuationCoordinator: restartedContinuationCoordinator,
			effectLedger,
		});
		vi.spyOn(host, "readSessionMessages").mockResolvedValue(messages as never);
		const resume = vi
			.spyOn(host, "resumePendingRun")
			.mockResolvedValue({ result: result(messages), record } as never);
		try {
			const report = await host.recoverPendingRunContinuations({
				background: true,
			});
			await host.dispose();
			expect(report).toMatchObject({
				scanned: 1,
				eligible: 1,
				scheduled: 1,
				resumed: 1,
				failed: 0,
			});
			expect(resume).toHaveBeenCalledWith(
				expect.objectContaining({
					continuationKey: record.continuationKey,
					start: expect.objectContaining({
						config: expect.objectContaining({
							sessionId,
							skills: ["review"],
						}),
						localRuntime: expect.objectContaining({
							configExtensions: ["rules", "workflows"],
						}),
					}),
				}),
			);
		} finally {
			await effectLedger.close();
			await restartedApprovalCoordinator.close();
			await restartedContinuationCoordinator.close();
			rmSync(recoveryDir, { recursive: true, force: true });
		}
	});

	it("schedules a decided multi-tool batch during startup recovery", async () => {
		const recoveryDir = mkdtempSync(join(tmpdir(), "cline-batch-recovery-"));
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({
				dbPath: join(recoveryDir, "approvals.db"),
			}),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({
				dbPath: join(recoveryDir, "continuations.db"),
			}),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-batch-recovery";
		const { messages, requests } = batchTurn(sessionId);
		const turnState = batchRunState(requests, messages);
		const continuationKeys: string[] = [];
		for (const request of requests) {
			await approvalCoordinator.createRequest(request);
			await approvalCoordinator.respond(
				request.approvalId as string,
				{ approved: true },
				"client-1",
			);
			const record = await continuationCoordinator.recordApprovalRequest({
				request,
				assistantMessageId: "assistant-batch",
				agentId: "agent-1",
				conversationId: "conversation-1",
				recoverySnapshot: {
					...recoverySnapshot(request, messages),
					eligibility: {
						autoRecover: false,
						reason: "parallel_or_ambiguous",
					},
				},
				// The turn-level cursor lands on the last continuation of the turn.
				...(request.toolCallIndex === 1 ? { runState: turnState } : {}),
			});
			if (!record) throw new Error("expected continuation");
			continuationKeys.push(record.continuationKey);
		}
		await approvalCoordinator.close();
		await continuationCoordinator.close();
		const restartedApprovalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({
				dbPath: join(recoveryDir, "approvals.db"),
			}),
		);
		const restartedContinuationCoordinator =
			new DurableRunContinuationCoordinator(
				new SqliteRunContinuationStore({
					dbPath: join(recoveryDir, "continuations.db"),
				}),
			);
		const row: SessionRow = {
			sessionId,
			source: "cli",
			pid: 0,
			startedAt: "2026-09-25T00:00:00.000Z",
			status: "failed",
			statusLock: 1,
			interactive: false,
			provider: "mock-provider",
			model: "mock-model",
			cwd: "/tmp/project",
			workspaceRoot: "/tmp/project",
			enableTools: true,
			enableSpawn: false,
			enableTeams: false,
			isSubagent: false,
			metadata: {
				terminal_marker: "failed_external_process_exit",
				terminal_marker_source: "stale_session_reconciler",
			},
			messagesPath: "/tmp/messages.json",
			updatedAt: "2026-09-25T00:00:00.000Z",
		};
		const host = new LocalRuntimeHost({
			sessionService: {
				getSession: vi.fn().mockResolvedValue(row),
				listSessions: vi.fn().mockResolvedValue([row]),
			} as never,
			approvalCoordinator: restartedApprovalCoordinator,
			continuationCoordinator: restartedContinuationCoordinator,
			effectLedger,
		});
		vi.spyOn(host, "readSessionMessages").mockResolvedValue(messages as never);
		const resumeBatch = vi
			.spyOn(host, "resumePendingRunBatch")
			.mockResolvedValue({ result: result(messages), records: [] } as never);
		const resume = vi.spyOn(host, "resumePendingRun");
		try {
			const report = await host.recoverPendingRunContinuations({
				background: true,
			});
			await host.dispose();
			expect(report).toMatchObject({
				scanned: 2,
				eligible: 1,
				scheduled: 1,
				resumed: 1,
				failed: 0,
			});
			expect(resume).not.toHaveBeenCalled();
			expect(resumeBatch).toHaveBeenCalledWith(
				expect.objectContaining({
					continuationKeys,
				}),
			);
		} finally {
			await effectLedger.close();
			await restartedApprovalCoordinator.close();
			await restartedContinuationCoordinator.close();
			rmSync(recoveryDir, { recursive: true, force: true });
		}
	});

	it("skips a stale batch whose persisted turn no longer matches its cursor", async () => {
		const recoveryDir = mkdtempSync(join(tmpdir(), "cline-batch-drift-"));
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({
				dbPath: join(recoveryDir, "approvals.db"),
			}),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({
				dbPath: join(recoveryDir, "continuations.db"),
			}),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-batch-recovery-drift";
		const { messages, requests } = batchTurn(sessionId);
		const turnState = batchRunState(requests, messages);
		for (const request of requests) {
			await approvalCoordinator.createRequest(request);
			await approvalCoordinator.respond(
				request.approvalId as string,
				{ approved: true },
				"client-1",
			);
			await continuationCoordinator.recordApprovalRequest({
				request,
				assistantMessageId: "assistant-batch",
				agentId: "agent-1",
				conversationId: "conversation-1",
				recoverySnapshot: {
					...recoverySnapshot(request, messages),
					eligibility: {
						autoRecover: false,
						reason: "parallel_or_ambiguous",
					},
				},
				...(request.toolCallIndex === 1 ? { runState: turnState } : {}),
			});
		}
		await approvalCoordinator.close();
		await continuationCoordinator.close();
		const restartedApprovalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({
				dbPath: join(recoveryDir, "approvals.db"),
			}),
		);
		const restartedContinuationCoordinator =
			new DurableRunContinuationCoordinator(
				new SqliteRunContinuationStore({
					dbPath: join(recoveryDir, "continuations.db"),
				}),
			);
		const row: SessionRow = {
			sessionId,
			source: "cli",
			pid: 0,
			startedAt: "2026-09-25T00:00:00.000Z",
			status: "failed",
			statusLock: 1,
			interactive: false,
			provider: "mock-provider",
			model: "mock-model",
			cwd: "/tmp/project",
			workspaceRoot: "/tmp/project",
			enableTools: true,
			enableSpawn: false,
			enableTeams: false,
			isSubagent: false,
			metadata: {
				terminal_marker: "failed_external_process_exit",
				terminal_marker_source: "stale_session_reconciler",
			},
			messagesPath: "/tmp/messages.json",
			updatedAt: "2026-09-25T00:00:00.000Z",
		};
		// The persisted turn now requests a third tool call that never reached
		// an approval, so the recorded batch cursor is no longer authoritative.
		const driftedMessages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "read both" }] },
			{
				role: "assistant",
				id: "assistant-batch",
				content: [
					{
						type: "tool_use",
						id: "assistant-batch",
						call_id: "call-1",
						name: "read_files",
						input: { path: "a.md" },
					},
					{
						type: "tool_use",
						id: "assistant-batch",
						call_id: "call-2",
						name: "read_files",
						input: { path: "b.md" },
					},
					{
						type: "tool_use",
						id: "assistant-batch",
						call_id: "call-3",
						name: "read_files",
						input: { path: "c.md" },
					},
				],
			},
		];
		const host = new LocalRuntimeHost({
			sessionService: {
				getSession: vi.fn().mockResolvedValue(row),
				listSessions: vi.fn().mockResolvedValue([row]),
			} as never,
			approvalCoordinator: restartedApprovalCoordinator,
			continuationCoordinator: restartedContinuationCoordinator,
			effectLedger,
		});
		vi.spyOn(host, "readSessionMessages").mockResolvedValue(
			driftedMessages as never,
		);
		const resumeBatch = vi
			.spyOn(host, "resumePendingRunBatch")
			.mockResolvedValue({ result: result(messages), records: [] } as never);
		const resume = vi.spyOn(host, "resumePendingRun");
		try {
			const report = await host.recoverPendingRunContinuations({
				background: true,
			});
			await host.dispose();
			expect(report).toMatchObject({
				scanned: 2,
				eligible: 0,
				scheduled: 0,
				resumed: 0,
				skipped: 2,
			});
			expect(resume).not.toHaveBeenCalled();
			expect(resumeBatch).not.toHaveBeenCalled();
		} finally {
			await effectLedger.close();
			await restartedApprovalCoordinator.close();
			await restartedContinuationCoordinator.close();
			rmSync(recoveryDir, { recursive: true, force: true });
		}
	});

	it("records a single-tool parallel turn as eligible for recovery", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-parallel-eligibility";
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "read it" }] },
			{
				role: "assistant",
				id: "assistant-parallel",
				content: [
					{
						type: "tool_use",
						id: "assistant-parallel",
						call_id: "call-1",
						name: "read_files",
						input: { path: "a.md" },
					},
				],
			},
		];
		const host = approvalPathHost({
			sessionId,
			messages,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			run: async (requestToolApproval) => {
				const approval = await requestToolApproval({
					approvalId: "approval-parallel",
					sessionId,
					agentId: "agent-1",
					conversationId: "conversation-1",
					runId: "run-parallel",
					iteration: 1,
					toolCallIndex: 0,
					assistantMessageId: "assistant-parallel",
					toolCallId: "call-1",
					toolName: "read_files",
					input: { path: "a.md" },
					policy: { autoApprove: false },
				});
				expect(approval.approved).toBe(true);
				return result(messages);
			},
		});
		try {
			await host.startSession({
				config: {
					...config(sessionId),
					maxParallelToolCalls: 2,
				} as never,
				prompt: "read it",
				interactive: false,
				capabilities: {
					requestToolApproval: vi
						.fn()
						.mockResolvedValue({ approved: true, reason: undefined }),
				} as never,
				localRuntime: { configExtensions: ["rules"] },
			} as never);
			const continuation = await continuationCoordinator.get(
				"approval:approval-parallel",
			);
			expect(continuation?.recoverySnapshot?.config.toolExecution).toBe(
				"parallel",
			);
			// A one-call turn replays identically in both execution modes, so the
			// parallel session keeps its mode but stays recoverable.
			expect(continuation?.recoverySnapshot?.eligibility).toEqual({
				autoRecover: true,
				reason: "eligible",
			});
			expect(continuation?.runState?.config.toolExecution).toBe("parallel");
			expect(continuation?.runState?.config.maxParallelToolCalls).toBe(2);
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("records a turn-level cursor for a parallel multi-tool turn", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-parallel-cursor";
		const { messages, requests } = batchTurn(sessionId, "run-parallel");
		const host = approvalPathHost({
			sessionId,
			messages,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			run: async (requestToolApproval) => {
				// A parallel turn requests every approval of the turn up front.
				for (const request of requests) {
					const approval = await requestToolApproval(request);
					expect(approval.approved).toBe(true);
				}
				return result(messages);
			},
		});
		try {
			await host.startSession({
				config: {
					...config(sessionId),
					maxParallelToolCalls: 2,
				} as never,
				prompt: "read both",
				interactive: false,
				capabilities: {
					requestToolApproval: vi
						.fn()
						.mockResolvedValue({ approved: true, reason: undefined }),
				} as never,
				localRuntime: { configExtensions: ["rules"] },
			} as never);
			const first = await continuationCoordinator.get(
				"approval:approval-batch-0",
			);
			const second = await continuationCoordinator.get(
				"approval:approval-batch-1",
			);
			expect(first?.runState?.resume.type).toBe("tool_call");
			expect(second?.runState?.resume.type).toBe("tool_call_batch");
			expect(
				second?.runState
					? runStateResumeSteps(second.runState.resume).map(
							(step) => step.stepId,
						)
					: [],
			).toEqual(["step:run-parallel:1:0", "step:run-parallel:1:1"]);
			// The turn stays ambiguous for automatic recovery; only the cursor
			// plus the persisted turn make the batch provably complete.
			expect(second?.recoverySnapshot?.eligibility).toEqual({
				autoRecover: false,
				reason: "parallel_or_ambiguous",
			});
			expect(second?.runState?.config.toolExecution).toBe("parallel");
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("resumes a single-tool turn recorded with parallel tool execution", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-parallel-resume";
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "read it" }] },
			{
				role: "assistant",
				id: "assistant-parallel",
				content: [
					{
						type: "tool_use",
						id: "assistant-parallel",
						call_id: "call-1",
						name: "read_files",
						input: { path: "a.md" },
					},
				],
			},
		];
		const request: ToolApprovalRequest = {
			approvalId: "approval-parallel-resume",
			sessionId,
			agentId: "agent-1",
			conversationId: "conversation-1",
			runId: "run-parallel",
			iteration: 1,
			toolCallIndex: 0,
			assistantMessageId: "assistant-parallel",
			toolCallId: "call-1",
			toolName: "read_files",
			input: { path: "a.md" },
			policy: { autoApprove: false },
		};
		await approvalCoordinator.createRequest(request);
		await approvalCoordinator.respond(
			"approval-parallel-resume",
			{ approved: true },
			"client-1",
		);
		const baseSnapshot = recoverySnapshot(request, messages);
		const parallelState = runState(request, messages);
		parallelState.config.toolExecution = "parallel";
		parallelState.config.maxParallelToolCalls = 2;
		const continuation = await continuationCoordinator.recordApprovalRequest({
			request,
			assistantMessageId: "assistant-parallel",
			agentId: "agent-1",
			conversationId: "conversation-1",
			recoverySnapshot: {
				...baseSnapshot,
				config: {
					...baseSnapshot.config,
					toolExecution: "parallel",
					maxParallelToolCalls: 2,
				},
			},
			runState: parallelState,
		});
		if (!continuation) throw new Error("expected continuation");
		await continuationCoordinator.markApprovalDecision(
			continuation.continuationKey,
		);
		const resume = vi.fn().mockResolvedValue(result(messages));
		const agent = {
			run: vi.fn(),
			continue: vi.fn(),
			resumePendingToolCall: resume,
			abort: vi.fn(),
			subscribeEvents: vi.fn().mockReturnValue(() => {}),
			canStartRun: vi.fn().mockReturnValue(true),
			getAgentId: vi.fn().mockReturnValue("agent-1"),
			getConversationId: vi.fn().mockReturnValue("conversation-1"),
			getMessages: vi.fn().mockReturnValue(messages),
			shutdown: vi.fn().mockResolvedValue(undefined),
		};
		const startedConfigs: Record<string, unknown>[] = [];
		const host = new LocalRuntimeHost({
			sessionService: {
				ensureSessionsDir: vi.fn().mockReturnValue("/tmp/sessions"),
				createRootSessionWithArtifacts: vi.fn().mockResolvedValue({
					manifestPath: "/tmp/manifest.json",
					messagesPath: "/tmp/messages.json",
					manifest: {
						version: 1 as const,
						session_id: sessionId,
						source: "cli" as const,
						pid: process.pid,
						started_at: "2026-01-01T00:00:00.000Z",
						status: "running" as const,
						interactive: false,
						provider: "mock-provider",
						model: "mock-model",
						cwd: "/tmp/project",
						workspace_root: "/tmp/project",
						enable_tools: true,
						enable_spawn: false,
						enable_teams: false,
						messages_path: "/tmp/messages.json",
					},
				}),
				readSessionMessages: vi.fn().mockResolvedValue(messages),
				persistSessionMessages: vi.fn().mockResolvedValue(undefined),
				updateSessionStatus: vi.fn().mockResolvedValue({ updated: true }),
				writeSessionManifest: vi.fn().mockResolvedValue(undefined),
				listSessions: vi.fn().mockResolvedValue([]),
				deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
			} as never,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			runtimeBuilder: {
				build: vi.fn().mockReturnValue({
					tools: [],
					shutdown: vi.fn().mockResolvedValue(undefined),
					getServerRuntimeSourceReference: () => ({
						version: 1,
						algorithm: "sha256",
						digest: "a".repeat(64),
					}),
				}),
			} as never,
			createAgent: (agentConfig) => {
				startedConfigs.push(agentConfig as never);
				return agent as never;
			},
		});
		vi.spyOn(host, "readSessionMessages").mockResolvedValue(messages);
		try {
			const resumed = await host.resumePendingRun({
				continuationKey: continuation.continuationKey,
				start: { config: config(sessionId) },
			});
			expect(resume).toHaveBeenCalledWith({
				runId: "run-parallel",
				iteration: 1,
				stepId: "step:run-parallel:1:0",
				assistantMessageId: "assistant-parallel",
				toolCallId: "call-1",
				toolName: "read_files",
				preparedInput: { path: "a.md" },
				approval: { approved: true, reason: undefined },
			});
			// The rebuilt session keeps the recorded parallel mode.
			expect(startedConfigs[0]).toMatchObject({
				maxParallelToolCalls: 2,
			});
			expect(resumed.record.phase).toBe("completed");
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("refuses to replay one step of a multi-tool turn on its own", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-parallel-partial";
		const { messages, requests } = batchTurn(sessionId, "run-parallel");
		const parallelState = (request: ToolApprovalRequest): RunState => {
			const base = runState(request, messages);
			return {
				...base,
				config: {
					...base.config,
					toolExecution: "parallel",
					maxParallelToolCalls: 2,
				},
			};
		};
		const continuationKeys = await seedBatchContinuations(
			approvalCoordinator,
			continuationCoordinator,
			[requests[0] as ToolApprovalRequest],
			messages,
			(request) => parallelState(request),
		);
		const host = batchResumeHost({
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			sessionId,
			messages,
			resumeBatch: vi.fn(),
		});
		try {
			await expect(
				host.resumePendingRun({
					continuationKey: continuationKeys[0] as string,
					start: { config: config(sessionId) },
				}),
			).rejects.toThrow("does not cover every persisted tool call");
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("marks a multi-tool assistant turn ineligible for recovery", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-parallel-eligibility";
		const manifest = {
			version: 1 as const,
			session_id: sessionId,
			source: "cli" as const,
			pid: process.pid,
			started_at: "2026-01-01T00:00:00.000Z",
			status: "running" as const,
			interactive: false,
			provider: "mock-provider",
			model: "mock-model",
			cwd: "/tmp/project",
			workspace_root: "/tmp/project",
			enable_tools: true,
			enable_spawn: false,
			enable_teams: false,
			messages_path: "/tmp/messages.json",
		};
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "read both" }] },
			{
				role: "assistant",
				id: "assistant-parallel",
				content: [
					{
						type: "tool_use",
						id: "assistant-parallel",
						call_id: "call-1",
						name: "read_files",
						input: { path: "a.md" },
					},
					{
						type: "tool_use",
						id: "assistant-parallel",
						call_id: "call-2",
						name: "read_files",
						input: { path: "b.md" },
					},
				],
			},
		];
		const sessionService = {
			ensureSessionsDir: vi.fn().mockReturnValue("/tmp/sessions"),
			createRootSessionWithArtifacts: vi.fn().mockResolvedValue({
				manifestPath: "/tmp/manifest.json",
				messagesPath: "/tmp/messages.json",
				manifest,
			}),
			readSessionMessages: vi.fn().mockResolvedValue(messages),
			persistSessionMessages: vi.fn().mockResolvedValue(undefined),
			updateSessionStatus: vi.fn().mockResolvedValue({ updated: true }),
			writeSessionManifest: vi.fn().mockResolvedValue(undefined),
			listSessions: vi.fn().mockResolvedValue([]),
			deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
		};
		const requestToolApproval = vi
			.fn()
			.mockResolvedValue({ approved: true, reason: undefined });
		let capturedConfig: { requestToolApproval?: unknown } | undefined;
		const executeTurn = vi.fn(async () => {
			const approval = (await (
				capturedConfig?.requestToolApproval as
					| ((request: Record<string, unknown>) => Promise<unknown>)
					| undefined
			)?.({
				approvalId: "approval-parallel",
				sessionId,
				agentId: "agent-1",
				conversationId: "conversation-1",
				runId: "run-parallel",
				iteration: 1,
				toolCallIndex: 0,
				assistantMessageId: "assistant-parallel",
				toolCallId: "call-1",
				toolName: "read_files",
				input: { path: "a.md" },
				policy: { autoApprove: false },
			})) as { approved: boolean } | undefined;
			expect(approval?.approved).toBe(true);
			return result(messages);
		});
		const agent = {
			run: executeTurn,
			continue: executeTurn,
			resumePendingToolCall: vi.fn(),
			abort: vi.fn(),
			subscribeEvents: vi.fn().mockReturnValue(() => {}),
			canStartRun: vi.fn().mockReturnValue(true),
			getAgentId: vi.fn().mockReturnValue("agent-1"),
			getConversationId: vi.fn().mockReturnValue("conversation-1"),
			getMessages: vi.fn().mockReturnValue(messages),
			shutdown: vi.fn().mockResolvedValue(undefined),
		};
		const host = new LocalRuntimeHost({
			sessionService: sessionService as never,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			runtimeBuilder: {
				build: vi.fn().mockReturnValue({
					tools: [],
					shutdown: vi.fn().mockResolvedValue(undefined),
					getServerRuntimeSourceReference: () => ({
						version: 1,
						algorithm: "sha256",
						digest: "a".repeat(64),
					}),
				}),
			} as never,
			createAgent: (agentConfig) => {
				capturedConfig = agentConfig as never;
				return agent as never;
			},
		});
		vi.spyOn(host, "readSessionMessages").mockResolvedValue(messages);

		try {
			await host.startSession({
				config: { ...config(sessionId) } as never,
				prompt: "read both",
				interactive: false,
				capabilities: { requestToolApproval } as never,
				localRuntime: { configExtensions: ["rules"] },
			} as never);
			const continuation = await continuationCoordinator.get(
				"approval:approval-parallel",
			);
			expect(continuation?.recoverySnapshot?.eligibility).toEqual({
				autoRecover: false,
				reason: "parallel_or_ambiguous",
			});
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});

	it("keeps a single-tool assistant turn eligible for recovery", async () => {
		const approvalCoordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath: ":memory:" }),
		);
		const continuationCoordinator = new DurableRunContinuationCoordinator(
			new SqliteRunContinuationStore({ dbPath: ":memory:" }),
		);
		const effectLedger = new SqliteEffectLedger({ dbPath: ":memory:" });
		const sessionId = "session-single-tool-eligibility";
		const manifest = {
			version: 1 as const,
			session_id: sessionId,
			source: "cli" as const,
			pid: process.pid,
			started_at: "2026-01-01T00:00:00.000Z",
			status: "running" as const,
			interactive: false,
			provider: "mock-provider",
			model: "mock-model",
			cwd: "/tmp/project",
			workspace_root: "/tmp/project",
			enable_tools: true,
			enable_spawn: false,
			enable_teams: false,
			messages_path: "/tmp/messages.json",
		};
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: [{ type: "text", text: "read it" }] },
			{
				role: "assistant",
				id: "assistant-single",
				content: [
					{
						type: "tool_use",
						id: "assistant-single",
						call_id: "call-single",
						name: "read_files",
						input: { path: "a.md" },
					},
				],
			},
		];
		const sessionService = {
			ensureSessionsDir: vi.fn().mockReturnValue("/tmp/sessions"),
			createRootSessionWithArtifacts: vi.fn().mockResolvedValue({
				manifestPath: "/tmp/manifest.json",
				messagesPath: "/tmp/messages.json",
				manifest,
			}),
			readSessionMessages: vi.fn().mockResolvedValue(messages),
			persistSessionMessages: vi.fn().mockResolvedValue(undefined),
			updateSessionStatus: vi.fn().mockResolvedValue({ updated: true }),
			writeSessionManifest: vi.fn().mockResolvedValue(undefined),
			listSessions: vi.fn().mockResolvedValue([]),
			deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
		};
		const requestToolApproval = vi
			.fn()
			.mockResolvedValue({ approved: true, reason: undefined });
		let capturedConfig: { requestToolApproval?: unknown } | undefined;
		const executeTurn = vi.fn(async () => {
			const approval = (await (
				capturedConfig?.requestToolApproval as
					| ((request: Record<string, unknown>) => Promise<unknown>)
					| undefined
			)?.({
				approvalId: "approval-single",
				sessionId,
				agentId: "agent-1",
				conversationId: "conversation-1",
				runId: "run-single",
				iteration: 1,
				toolCallIndex: 0,
				assistantMessageId: "assistant-single",
				toolCallId: "call-single",
				toolName: "read_files",
				input: { path: "a.md" },
				policy: { autoApprove: false },
			})) as { approved: boolean } | undefined;
			expect(approval?.approved).toBe(true);
			return result(messages);
		});
		const agent = {
			run: executeTurn,
			continue: executeTurn,
			resumePendingToolCall: vi.fn(),
			abort: vi.fn(),
			subscribeEvents: vi.fn().mockReturnValue(() => {}),
			canStartRun: vi.fn().mockReturnValue(true),
			getAgentId: vi.fn().mockReturnValue("agent-1"),
			getConversationId: vi.fn().mockReturnValue("conversation-1"),
			getMessages: vi.fn().mockReturnValue(messages),
			shutdown: vi.fn().mockResolvedValue(undefined),
		};
		const host = new LocalRuntimeHost({
			sessionService: sessionService as never,
			approvalCoordinator,
			continuationCoordinator,
			effectLedger,
			runtimeBuilder: {
				build: vi.fn().mockReturnValue({
					tools: [],
					shutdown: vi.fn().mockResolvedValue(undefined),
					getServerRuntimeSourceReference: () => ({
						version: 1,
						algorithm: "sha256",
						digest: "a".repeat(64),
					}),
				}),
			} as never,
			createAgent: (agentConfig) => {
				capturedConfig = agentConfig as never;
				return agent as never;
			},
		});
		vi.spyOn(host, "readSessionMessages").mockResolvedValue(messages);

		try {
			await host.startSession({
				config: { ...config(sessionId) } as never,
				prompt: "read it",
				interactive: false,
				capabilities: { requestToolApproval } as never,
				localRuntime: { configExtensions: ["rules"] },
			} as never);
			const continuation = await continuationCoordinator.get(
				"approval:approval-single",
			);
			expect(continuation?.recoverySnapshot?.eligibility).toEqual({
				autoRecover: true,
				reason: "eligible",
			});
		} finally {
			await host.dispose();
			await effectLedger.close();
			await approvalCoordinator.close();
			await continuationCoordinator.close();
		}
	});
});
