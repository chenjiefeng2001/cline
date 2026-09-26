import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolApprovalRequest } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DurableToolApprovalCoordinator,
	SqliteDurableToolApprovalStore,
} from "./durable-tool-approval";

const request: ToolApprovalRequest = {
	sessionId: "session-1",
	agentId: "agent-1",
	conversationId: "conversation-1",
	runId: "run-1",
	iteration: 2,
	toolCallIndex: 3,
	toolCallId: "call-1",
	toolName: "write_file",
	input: { path: "a.txt", content: "hello" },
	policy: { enabled: true, autoApprove: false },
};

describe("durable tool approval", () => {
	let dir: string;
	let now: number;
	let dbPath: string;
	let coordinator: DurableToolApprovalCoordinator;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-approvals-"));
		now = Date.parse("2026-09-24T00:00:00.000Z");
		dbPath = join(dir, "approvals.db");
		coordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({
				dbPath,
				clock: () => now,
			}),
			() => now,
		);
	});

	afterEach(async () => {
		await coordinator.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("persists a pending request across runtime instances", async () => {
		const created = await coordinator.createRequest(request, {
			requestedByClientId: "client-1",
			targetClientId: "client-1",
		});
		expect(created.created).toBe(true);
		await coordinator.close();
		coordinator = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath, clock: () => now }),
			() => now,
		);

		expect(await coordinator.listPending(request.sessionId)).toHaveLength(1);
		const decision = await coordinator.respond(
			created.record.approvalId,
			{ approved: true },
			"client-1",
			request.sessionId,
		);

		expect(decision.outcome).toBe("applied");
		expect(decision.record).toMatchObject({
			status: "approved",
			decidedByClientId: "client-1",
		});
	});

	it("returns one atomic winner for concurrent decisions", async () => {
		const created = await coordinator.createRequest(request);
		const other = new DurableToolApprovalCoordinator(
			new SqliteDurableToolApprovalStore({ dbPath, clock: () => now }),
			() => now,
		);
		const outcomes = await Promise.all([
			coordinator.respond(
				created.record.approvalId,
				{ approved: true },
				"client-1",
			),
			other.respond(
				created.record.approvalId,
				{ approved: false, reason: "denied" },
				"client-2",
			),
		]);
		await other.close();

		expect(
			outcomes.filter((outcome) => outcome.outcome === "applied"),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.outcome === "conflict"),
		).toHaveLength(1);
		expect(["approved", "denied"]).toContain(outcomes[0].record.status);
	});

	it("deduplicates the same logical request", async () => {
		const first = await coordinator.createRequest(request);
		const duplicate = await coordinator.createRequest(request);
		expect(duplicate.created).toBe(false);
		expect(duplicate.record.approvalId).toBe(first.record.approvalId);
	});

	it("expires pending requests without making them decidable", async () => {
		const created = await coordinator.createRequest(request, {
			expiresInMs: 1_000,
		});
		now += 1_001;
		expect(await coordinator.listPending(request.sessionId)).toHaveLength(0);
		const decision = await coordinator.respond(
			created.record.approvalId,
			{ approved: true },
			"client-1",
		);
		expect(decision.outcome).toBe("conflict");
		expect(decision.record.status).toBe("expired");
	});

	it("wakes the active waiter when a client decides", async () => {
		let approvalId: string | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const waiting = coordinator.request(request, async (approval) => {
			approvalId = approval.approvalId;
			markStarted?.();
			return await new Promise(() => {});
		});
		await started;
		const decision = await coordinator.respond(approvalId as string, {
			approved: true,
		});
		expect(decision.outcome).toBe("applied");
		expect(await waiting).toEqual({ approved: true });
	});

	it("releases waiters without terminalizing pending records during shutdown", async () => {
		let approvalId: string | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const waiting = coordinator.request(request, async (approval) => {
			approvalId = approval.approvalId;
			markStarted?.();
			return await new Promise(() => {});
		});
		await started;
		coordinator.setPreservePendingApprovals(true);
		coordinator.releaseWaiters();
		expect(await waiting).toEqual({
			approved: false,
			reason: "Approval runtime shut down before a decision was received",
		});
		expect(await coordinator.get(approvalId as string)).toMatchObject({
			status: "pending",
		});
	});

	it("persists abort cancellation and resolves the waiter", async () => {
		const controller = new AbortController();
		let approvalId: string | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const waiting = coordinator.request(
			{ ...request, signal: controller.signal },
			async (approval) => {
				approvalId = approval.approvalId;
				markStarted?.();
				return await new Promise(() => {});
			},
		);
		await started;
		controller.abort();
		expect(await waiting).toEqual({
			approved: false,
			reason: "Tool approval aborted",
		});
		expect(await coordinator.get(approvalId as string)).toMatchObject({
			status: "cancelled",
			reason: "Tool approval aborted",
		});
	});
});
