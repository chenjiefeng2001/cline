import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteDb } from "@cline/shared/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecoverySnapshot } from "./recovery-snapshot";
import {
	type CreateRunContinuationInput,
	RunContinuationClosedError,
	RunContinuationIdentityMismatchError,
	RunContinuationInputHashMismatchError,
	RunContinuationLeaseLostError,
	RunContinuationPhaseMismatchError,
} from "./run-continuation-store";
import {
	RUN_STATE_KIND,
	RUN_STATE_VERSION,
	type RunState,
	type RunStateToolCallResume,
} from "./run-state";
import { SqliteRunContinuationStore } from "./sqlite-run-continuation-store";

function continuationInput(
	overrides: Partial<CreateRunContinuationInput> = {},
): CreateRunContinuationInput {
	return {
		continuationKey: "continuation-1",
		sessionId: "session-1",
		runId: "run-1",
		agentId: "agent-1",
		conversationId: "conversation-1",
		iteration: 2,
		toolCallIndex: 0,
		toolCallId: "call-1",
		toolName: "write_file",
		preparedInputJson: JSON.stringify({ path: "a.txt", content: "hello" }),
		preparedInputHash: "hash-1",
		assistantMessageId: "assistant-message-1",
		approvalId: "approval-1",
		...overrides,
	};
}

function recoverySnapshot(): RunRecoverySnapshot {
	return {
		kind: "cline.run-recovery",
		version: 1,
		capturedAt: "2026-09-25T00:00:00.000Z",
		sessionId: "session-1",
		source: "a2a",
		recoveryOwner: "a2a-owner-1",
		interactive: false,
		toolName: "read_files",
		toolOrigin: "core-builtin",
		clientContributionsPresent: false,
		run: {
			runId: "run-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			iteration: 2,
			toolCallIndex: 0,
			assistantMessageId: "assistant-message-1",
			toolCallId: "call-1",
			approvalId: "approval-1",
		},
		preparedInputHash: "hash-1",
		transcript: {
			messageCount: 2,
			lastMessageId: "assistant-message-1",
			transcriptHash: "transcript-hash",
			systemPromptHash: "system-hash",
		},
		config: {
			providerId: "provider-1",
			modelId: "model-1",
			cwd: "/workspace",
			workspaceRoot: "/workspace",
			systemPrompt: "system prompt",
			mode: "act",
			enableTools: true,
			enableSpawnAgent: false,
			enableAgentTeams: false,
			toolExecution: "sequential",
		},
		eligibility: { autoRecover: true, reason: "eligible" },
	};
}

function runState(overrides: Partial<RunState> = {}): RunState {
	return {
		kind: RUN_STATE_KIND,
		version: RUN_STATE_VERSION,
		capturedAt: "2026-09-25T00:00:00.000Z",
		source: "a2a",
		recoveryOwner: "a2a-owner-1",
		interactive: false,
		resume: {
			type: "tool_call",
			sessionId: "session-1",
			runId: "run-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			iteration: 2,
			toolCallIndex: 0,
			assistantMessageId: "assistant-message-1",
			toolCallId: "call-1",
			toolName: "read_files",
			approvalId: "approval-1",
			preparedInputHash: "0123456789abcdef0123456789abcdef",
		},
		transcript: {
			messageCount: 2,
			lastMessageId: "assistant-message-1",
			transcriptHash: "0123456789abcdef0123456789abcdef",
			systemPromptHash: "0123456789abcdef0123456789abcdef",
		},
		config: {
			providerId: "provider-1",
			modelId: "model-1",
			cwd: "/workspace",
			workspaceRoot: "/workspace",
			systemPrompt: "system prompt",
			mode: "act",
			enableTools: true,
			enableSpawnAgent: false,
			enableAgentTeams: false,
			toolExecution: "sequential",
		},
		...overrides,
	};
}

describe("SqliteRunContinuationStore", () => {
	let dir: string;
	let dbPath: string;
	let now: Date;
	let store: SqliteRunContinuationStore;
	let other: SqliteRunContinuationStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-continuations-"));
		dbPath = join(dir, "continuations.db");
		now = new Date("2026-09-24T00:00:00.000Z");
		store = new SqliteRunContinuationStore({ dbPath, clock: () => now });
		other = new SqliteRunContinuationStore({ dbPath, clock: () => now });
		store.init();
		other.init();
	});

	afterEach(() => {
		store.close();
		other.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("persists a serializable record and deduplicates retries", async () => {
		const input = continuationInput();
		const created = await store.createOrUpsert(input);
		expect(created.created).toBe(true);
		expect(created.record).toMatchObject({
			continuationKey: input.continuationKey,
			sessionId: input.sessionId,
			runId: input.runId,
			agentId: input.agentId,
			conversationId: input.conversationId,
			iteration: input.iteration,
			toolCallIndex: input.toolCallIndex,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			preparedInputJson: input.preparedInputJson,
			preparedInputHash: input.preparedInputHash,
			assistantMessageId: input.assistantMessageId,
			approvalId: input.approvalId,
			phase: "awaiting_approval",
			createdAt: now.toISOString(),
			updatedAt: now.toISOString(),
		});
		expect(JSON.parse(JSON.stringify(created.record))).toEqual(created.record);

		const duplicate = await store.upsert(input);
		expect(duplicate.created).toBe(false);
		expect(duplicate.record).toEqual(created.record);
		expect(await store.get(input.continuationKey)).toEqual(created.record);
	});

	it("persists a recovery snapshot and rejects snapshot drift", async () => {
		const input = continuationInput({ recoverySnapshot: recoverySnapshot() });
		const created = await store.createOrUpsert(input);
		expect(created.record.recoverySnapshot).toEqual(input.recoverySnapshot);
		expect((await other.get(input.continuationKey))?.recoverySnapshot).toEqual(
			input.recoverySnapshot,
		);
		store.close();
		const reopened = new SqliteRunContinuationStore({
			dbPath,
			clock: () => now,
		});
		try {
			expect(
				(await reopened.get(input.continuationKey))?.recoverySnapshot,
			).toEqual(input.recoverySnapshot);
		} finally {
			reopened.close();
		}
		store = new SqliteRunContinuationStore({ dbPath, clock: () => now });
		await expect(
			store.createOrUpsert({
				...input,
				recoverySnapshot: {
					...recoverySnapshot(),
					preparedInputHash: "different-hash",
				},
			}),
		).rejects.toBeInstanceOf(RunContinuationIdentityMismatchError);
	});

	it("persists a run state and rejects state drift", async () => {
		const input = continuationInput({
			preparedInputHash: "0123456789abcdef0123456789abcdef",
			toolName: "read_files",
			runState: runState(),
		});
		const created = await store.createOrUpsert(input);
		expect(created.record.runState).toEqual(input.runState);
		expect((await other.get(input.continuationKey))?.runState).toEqual(
			input.runState,
		);
		await expect(
			store.createOrUpsert({
				...input,
				runState: runState({
					resume: {
						...(runState().resume as RunStateToolCallResume),
						preparedInputHash: "ffffffffffffffffffffffffffffffff",
					},
				}),
			}),
		).rejects.toBeInstanceOf(RunContinuationIdentityMismatchError);
	});

	it("migrates a v2 database and leaves legacy run state null", async () => {
		const input = continuationInput();
		await store.createOrUpsert(input);
		store.close();
		other.close();
		const db = loadSqliteDb(dbPath);
		try {
			// A real v2 database predates both the strict run state and the
			// durable agent chain, so the simulation drops both columns.
			db.exec("ALTER TABLE run_continuations DROP COLUMN run_state_json;");
			db.exec("ALTER TABLE run_continuations DROP COLUMN agent_chain_json;");
			db.prepare(
				"UPDATE run_continuation_schema_version SET version = 2 WHERE lock = 1",
			).run();
		} finally {
			db.close?.();
		}
		const migrated = new SqliteRunContinuationStore({
			dbPath,
			clock: () => now,
		});
		try {
			const record = await migrated.get(input.continuationKey);
			expect(record?.runState).toBeUndefined();
			expect(record?.agentChain).toBeUndefined();
		} finally {
			migrated.close();
		}
	});

	it("round-trips a delegated agent chain and rejects drift", async () => {
		const input = continuationInput();
		const created = await store.createOrUpsert({
			...input,
			agentChain: {
				agentId: input.agentId,
				agentRole: "reviewer",
				parentAgentId: "agent-root",
				rootRunId: "run-root",
			},
		});
		expect(created.record.agentChain).toEqual({
			agentId: input.agentId,
			agentRole: "reviewer",
			parentAgentId: "agent-root",
			rootRunId: "run-root",
		});
		// First write wins: restating the chain must not silently replace it.
		await expect(
			store.createOrUpsert({
				...input,
				agentChain: { agentId: input.agentId, parentAgentId: "agent-other" },
			}),
		).rejects.toBeInstanceOf(RunContinuationIdentityMismatchError);
		// The chain must describe the agent that owns the continuation.
		await expect(
			store.createOrUpsert({
				...input,
				continuationKey: "continuation-chain-drift",
				agentId: "agent-child",
				agentChain: { agentId: "agent-root" },
			}),
		).rejects.toBeInstanceOf(RunContinuationIdentityMismatchError);
	});

	it("rejects a run state that disagrees with the durable agent chain", async () => {
		const input = continuationInput();
		await expect(
			store.createOrUpsert({
				...input,
				runState: runState(),
				agentChain: { agentId: input.agentId, parentAgentId: "agent-root" },
			}),
		).rejects.toBeInstanceOf(RunContinuationIdentityMismatchError);
	});

	it("rejects phase, identity, and input-hash mismatches", async () => {
		const input = continuationInput();
		await store.createOrUpsert(input);

		await expect(
			store.createOrUpsert({ ...input, phase: "approved" }),
		).rejects.toBeInstanceOf(RunContinuationPhaseMismatchError);
		await expect(
			store.createOrUpsert({ ...input, sessionId: "session-2" }),
		).rejects.toBeInstanceOf(RunContinuationIdentityMismatchError);
		await expect(
			store.createOrUpsert({ ...input, preparedInputHash: "hash-2" }),
		).rejects.toBeInstanceOf(RunContinuationInputHashMismatchError);
		await expect(
			store.transition({
				continuationKey: input.continuationKey,
				expectedPhase: "approved",
				toPhase: "approved",
			}),
		).rejects.toBeInstanceOf(RunContinuationPhaseMismatchError);
		await expect(
			store.transition({
				continuationKey: input.continuationKey,
				identity: { sessionId: "session-2" },
				toPhase: "approved",
			}),
		).rejects.toBeInstanceOf(RunContinuationIdentityMismatchError);
		await expect(
			store.transition({
				continuationKey: input.continuationKey,
				expectedInputHash: "hash-2",
				toPhase: "approved",
			}),
		).rejects.toBeInstanceOf(RunContinuationInputHashMismatchError);
	});

	it("lists only non-terminal records and scopes by session", async () => {
		await store.createOrUpsert(continuationInput());
		await store.createOrUpsert(
			continuationInput({
				continuationKey: "continuation-2",
				toolCallId: "call-2",
				toolCallIndex: 1,
			}),
		);
		await store.createOrUpsert(
			continuationInput({
				continuationKey: "continuation-other",
				sessionId: "session-2",
				toolCallId: "call-other",
			}),
		);
		await store.closeTerminal({
			continuationKey: "continuation-2",
			status: "completed",
		});

		expect(
			(await store.listRecoverable()).map((record) => record.continuationKey),
		).toEqual(["continuation-1", "continuation-other"]);
		expect(
			(await store.listRecoverable("session-1")).map(
				(record) => record.continuationKey,
			),
		).toEqual(["continuation-1"]);
		expect(
			(await store.listRecoverable(undefined, 1)).map(
				(record) => record.continuationKey,
			),
		).toEqual(["continuation-1"]);
	});

	it("claims a lease, fences stale owners, and permits expiry recovery", async () => {
		const input = continuationInput();
		await store.createOrUpsert(input);
		const first = await store.claim({
			continuationKey: input.continuationKey,
			ownerToken: "owner-1",
			leaseDurationMs: 1_000,
		});
		expect(first.outcome).toBe("claimed");
		if (first.outcome !== "claimed") throw new Error("expected claim");
		expect(first.lease).toEqual({
			continuationKey: input.continuationKey,
			ownerToken: "owner-1",
			leaseStartedAt: now.toISOString(),
			leaseExpiresAt: "2026-09-24T00:00:01.000Z",
		});
		expect(first.record).toMatchObject({
			ownerToken: "owner-1",
			leaseStartedAt: now.toISOString(),
			leaseExpiresAt: "2026-09-24T00:00:01.000Z",
		});

		const concurrent = await other.claim({
			continuationKey: input.continuationKey,
			ownerToken: "owner-2",
		});
		expect(concurrent.outcome).toBe("in_progress");
		if (concurrent.outcome !== "in_progress")
			throw new Error("expected busy claim");
		expect(concurrent.record.ownerToken).toBe("owner-1");

		await expect(
			store.transition({
				continuationKey: input.continuationKey,
				ownerToken: "owner-2",
				toPhase: "approved",
			}),
		).rejects.toBeInstanceOf(RunContinuationLeaseLostError);

		await store.transition({
			continuationKey: input.continuationKey,
			ownerToken: "owner-1",
			toPhase: "approved",
		});
		await store.transition({
			continuationKey: input.continuationKey,
			ownerToken: "owner-1",
			toPhase: "executing",
		});

		now = new Date("2026-09-24T00:00:01.001Z");
		const reclaimed = await other.claim({
			continuationKey: input.continuationKey,
			ownerToken: "owner-2",
			leaseDurationMs: 1_000,
		});
		expect(reclaimed.outcome).toBe("claimed");
		if (reclaimed.outcome !== "claimed") throw new Error("expected reclaim");
		expect(reclaimed.lease.ownerToken).toBe("owner-2");
		await expect(
			store.closeTerminal({
				continuationKey: input.continuationKey,
				ownerToken: "owner-1",
				status: "completed",
			}),
		).rejects.toBeInstanceOf(RunContinuationLeaseLostError);
	});

	it("allows exactly one winner across concurrent store instances", async () => {
		const input = continuationInput();
		await store.createOrUpsert(input);
		const outcomes = await Promise.all([
			store.claim({
				continuationKey: input.continuationKey,
				ownerToken: "owner-1",
			}),
			other.claim({
				continuationKey: input.continuationKey,
				ownerToken: "owner-2",
			}),
		]);
		expect(
			outcomes.filter((outcome) => outcome.outcome === "claimed"),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.outcome === "in_progress"),
		).toHaveLength(1);
	});

	it("closes terminal records with reason and error, and cancels active records", async () => {
		const completedInput = continuationInput();
		await store.createOrUpsert(completedInput);
		await store.transition({
			continuationKey: completedInput.continuationKey,
			toPhase: "approved",
		});
		const claim = await store.claim({
			continuationKey: completedInput.continuationKey,
			ownerToken: "owner-1",
		});
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		await store.transition({
			continuationKey: completedInput.continuationKey,
			ownerToken: claim.lease.ownerToken,
			toPhase: "executing",
		});
		const completed = await store.closeTerminal({
			continuationKey: completedInput.continuationKey,
			ownerToken: claim.lease.ownerToken,
			status: "failed",
			error: "tool failed",
			reason: "execution failed",
		});
		expect(completed).toMatchObject({
			phase: "failed",
			terminalError: "tool failed",
			terminalReason: "execution failed",
		});
		expect(completed.ownerToken).toBeUndefined();
		expect(completed.leaseExpiresAt).toBeUndefined();
		expect(await store.listRecoverable(completedInput.sessionId)).toHaveLength(
			0,
		);

		const cancelledInput = continuationInput({
			continuationKey: "continuation-cancelled",
			toolCallId: "call-cancelled",
		});
		await store.createOrUpsert(cancelledInput);
		const cancelled = await store.cancel({
			continuationKey: cancelledInput.continuationKey,
			reason: "user cancelled",
		});
		expect(cancelled).toMatchObject({
			phase: "cancelled",
			terminalReason: "user cancelled",
		});
		await expect(
			store.closeTerminal({
				continuationKey: cancelledInput.continuationKey,
				status: "completed",
			}),
		).rejects.toBeInstanceOf(RunContinuationPhaseMismatchError);
	});

	it("survives reopening and refuses use after close", async () => {
		const input = continuationInput();
		await store.createOrUpsert(input);
		store.close();
		const reopened = new SqliteRunContinuationStore({
			dbPath,
			clock: () => now,
		});
		try {
			expect(await reopened.get(input.continuationKey)).toMatchObject({
				continuationKey: input.continuationKey,
				phase: "awaiting_approval",
			});
		} finally {
			reopened.close();
		}
		store = new SqliteRunContinuationStore({ dbPath, clock: () => now });
		store.close();
		await expect(store.get(input.continuationKey)).rejects.toBeInstanceOf(
			RunContinuationClosedError,
		);
	});
});
