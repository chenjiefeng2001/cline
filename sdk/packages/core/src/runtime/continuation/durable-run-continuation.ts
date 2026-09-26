import type { ToolApprovalRequest, ToolApprovalResult } from "@cline/shared";
import { hashToolInput } from "../ledger/idempotency-key";
import type { RunRecoverySnapshot } from "./recovery-snapshot";
import type {
	RunContinuationAgentChain,
	RunContinuationPhase,
	RunContinuationRecord,
	RunContinuationStore,
} from "./run-continuation-store";
import type { RunState } from "./run-state";
import { SqliteRunContinuationStore } from "./sqlite-run-continuation-store";

export type {
	RunContinuationAgentChain,
	RunContinuationRecord,
} from "./run-continuation-store";

export interface RunContinuationApprovalInput {
	request: ToolApprovalRequest;
	assistantMessageId: string;
	agentId: string;
	conversationId: string;
	recoverySnapshot?: RunRecoverySnapshot;
	runState?: RunState;
	/**
	 * Agent chain that owns the tool call. Delegated (sub-agent/team) runs pass
	 * it so a later resume can refuse to replay a delegated transcript as the
	 * session's own turn.
	 */
	agentChain?: RunContinuationAgentChain;
}

export class DurableRunContinuationCoordinator {
	private readonly store: RunContinuationStore;
	private readonly ownsStore: boolean;
	private initialization: Promise<void> | undefined;
	private preservePending = false;

	constructor(store: RunContinuationStore = new SqliteRunContinuationStore()) {
		this.store = store;
		this.ownsStore = store instanceof SqliteRunContinuationStore;
	}

	setPreservePending(preserve: boolean): void {
		this.preservePending = preserve;
	}

	async init(): Promise<void> {
		await this.initialize();
	}

	async recordApprovalRequest(
		input: RunContinuationApprovalInput,
	): Promise<RunContinuationRecord | undefined> {
		const approvalId = input.request.approvalId?.trim();
		const runId = input.request.runId?.trim();
		const toolCallIndex = input.request.toolCallIndex;
		if (
			!approvalId ||
			!runId ||
			toolCallIndex === undefined ||
			!input.assistantMessageId.trim() ||
			!input.agentId.trim() ||
			!input.conversationId.trim()
		) {
			return undefined;
		}
		const preparedInputJson = JSON.stringify(input.request.input ?? null);
		if (preparedInputJson === undefined) {
			throw new Error("Tool approval input must be JSON serializable");
		}
		const continuationKey = `approval:${approvalId}`;
		await this.initialize();
		const existing = await this.store.get(continuationKey);
		const created = await this.store.createOrUpsert({
			continuationKey,
			sessionId: input.request.sessionId,
			runId,
			agentId: input.agentId,
			conversationId: input.conversationId,
			iteration: input.request.iteration,
			toolCallIndex,
			toolCallId: input.request.toolCallId,
			toolName: input.request.toolName,
			preparedInputJson,
			preparedInputHash: hashToolInput(input.request.input),
			assistantMessageId: input.assistantMessageId,
			approvalId,
			phase: existing?.phase ?? "awaiting_approval",
			recoverySnapshot: existing?.recoverySnapshot ?? input.recoverySnapshot,
			runState: input.runState,
			agentChain: existing?.agentChain ?? input.agentChain,
		});
		return created.record;
	}

	async markApprovalDecision(
		continuationKey: string,
		ownerToken?: string,
	): Promise<RunContinuationRecord> {
		await this.initialize();
		return this.store.transition({
			continuationKey,
			ownerToken,
			fromPhase: "awaiting_approval",
			toPhase: "approved",
		});
	}

	async claim(
		continuationKey: string,
		ownerToken: string,
		leaseDurationMs?: number,
	) {
		await this.initialize();
		return this.store.claim({
			continuationKey,
			ownerToken,
			leaseDurationMs,
		});
	}

	async markExecuting(
		continuationKey: string,
		ownerToken: string,
	): Promise<RunContinuationRecord> {
		await this.initialize();
		return this.store.transition({
			continuationKey,
			ownerToken,
			fromPhase: "approved",
			toPhase: "executing",
		});
	}

	async closeTerminal(
		continuationKey: string,
		ownerToken: string,
		result: ToolApprovalResult & { status?: RunContinuationPhase },
	): Promise<RunContinuationRecord> {
		await this.initialize();
		return this.store.closeTerminal({
			continuationKey,
			ownerToken,
			status:
				result.status === "failed" || result.status === "cancelled"
					? result.status
					: "completed",
			error: result.reason,
			reason: result.reason,
		});
	}

	async cancel(
		continuationKey: string,
		reason: string,
		ownerToken?: string,
	): Promise<RunContinuationRecord> {
		if (this.preservePending) {
			const record = await this.get(continuationKey);
			if (!record) {
				throw new Error(`Run continuation not found: ${continuationKey}`);
			}
			return record;
		}
		await this.initialize();
		return this.store.cancel({
			continuationKey,
			ownerToken,
			reason,
		});
	}

	async cancelSession(
		sessionId: string,
		reason: string,
	): Promise<RunContinuationRecord[]> {
		if (this.preservePending || !this.initialization) {
			return [];
		}
		await this.initialize();
		const records = await this.store.listRecoverable(sessionId);
		const cancelled: RunContinuationRecord[] = [];
		for (const record of records) {
			cancelled.push(
				await this.store.cancel({
					continuationKey: record.continuationKey,
					reason,
				}),
			);
		}
		return cancelled;
	}

	async get(continuationKey: string) {
		await this.initialize();
		return this.store.get(continuationKey);
	}

	async listRecoverable(sessionId?: string, limit?: number) {
		await this.initialize();
		return this.store.listRecoverable(sessionId, limit);
	}

	async close(): Promise<void> {
		if (this.ownsStore) {
			await this.store.close();
		}
	}

	private async initialize(): Promise<void> {
		this.initialization ??= Promise.resolve()
			.then(async () => {
				await this.store.init();
			})
			.catch((error) => {
				this.initialization = undefined;
				throw error;
			});
		await this.initialization;
	}
}
