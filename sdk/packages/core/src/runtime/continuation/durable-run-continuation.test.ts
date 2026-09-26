import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolApprovalRequest } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableRunContinuationCoordinator } from "./durable-run-continuation";
import { SqliteRunContinuationStore } from "./sqlite-run-continuation-store";

describe("DurableRunContinuationCoordinator", () => {
	let dir: string;
	let store: SqliteRunContinuationStore;
	let coordinator: DurableRunContinuationCoordinator;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-continuation-coordinator-"));
		store = new SqliteRunContinuationStore({
			dbPath: join(dir, "continuations.db"),
		});
		coordinator = new DurableRunContinuationCoordinator(store);
	});

	afterEach(async () => {
		await coordinator.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const request: ToolApprovalRequest = {
		approvalId: "approval-1",
		sessionId: "session-1",
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

	it("records a request, advances it, and closes it with a lease", async () => {
		const record = await coordinator.recordApprovalRequest({
			request,
			assistantMessageId: request.assistantMessageId as string,
			agentId: request.agentId,
			conversationId: request.conversationId,
		});
		expect(record).toMatchObject({
			continuationKey: "approval:approval-1",
			phase: "awaiting_approval",
			approvalId: "approval-1",
		});
		if (!record) {
			throw new Error("expected continuation record");
		}
		const continuationKey = record.continuationKey;
		await coordinator.markApprovalDecision(continuationKey);
		const claim = await coordinator.claim(continuationKey, "owner-1");
		expect(claim.outcome).toBe("claimed");
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		await coordinator.markExecuting(continuationKey, "owner-1");
		const terminal = await coordinator.closeTerminal(
			continuationKey,
			"owner-1",
			{ approved: true, reason: "done", status: "completed" },
		);
		expect(terminal).toMatchObject({ phase: "completed" });
		expect(await coordinator.listRecoverable()).toHaveLength(0);
	});

	it("does not initialize an unused store while cancelling a session", async () => {
		const init = vi.spyOn(store, "init");
		await expect(
			coordinator.cancelSession("session-unused", "shutdown"),
		).resolves.toEqual([]);
		expect(init).not.toHaveBeenCalled();
	});

	it("preserves pending records during runtime shutdown", async () => {
		const record = await coordinator.recordApprovalRequest({
			request,
			assistantMessageId: "assistant-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
		});
		if (!record) throw new Error("expected continuation record");
		coordinator.setPreservePending(true);
		await expect(
			coordinator.cancelSession("session-1", "shutdown"),
		).resolves.toEqual([]);
		expect(await coordinator.get(record.continuationKey)).toMatchObject({
			phase: "awaiting_approval",
		});
	});

	it("does not create a continuation without durable identity fields", async () => {
		await expect(
			coordinator.recordApprovalRequest({
				request: { ...request, runId: undefined },
				assistantMessageId: "assistant-1",
				agentId: "agent-1",
				conversationId: "conversation-1",
			}),
		).resolves.toBeUndefined();
	});
});
