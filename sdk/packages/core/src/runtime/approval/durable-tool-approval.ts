import { join } from "node:path";
import {
	createSessionId,
	type ToolApprovalRequest,
	type ToolApprovalResult,
} from "@cline/shared";
import { loadSqliteDb, type SqliteDb } from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";
import { deriveIdempotencyKey, hashToolInput } from "../ledger/idempotency-key";

export type DurableToolApprovalStatus =
	| "pending"
	| "approved"
	| "denied"
	| "expired"
	| "cancelled";

export interface DurableToolApprovalRecord {
	approvalId: string;
	requestKey: string;
	sessionId: string;
	agentId: string;
	conversationId: string;
	runId?: string;
	iteration: number;
	toolCallIndex?: number;
	toolCallId: string;
	toolName: string;
	inputJson: string;
	inputHash: string;
	policyJson: string;
	status: DurableToolApprovalStatus;
	requestedByClientId?: string;
	targetClientId?: string;
	createdAt: number;
	expiresAt: number;
	decidedAt?: number;
	decidedByClientId?: string;
	reason?: string;
	version: number;
}

export interface CreateDurableToolApprovalInput {
	approvalId: string;
	requestKey: string;
	sessionId: string;
	agentId: string;
	conversationId: string;
	runId?: string;
	iteration: number;
	toolCallIndex?: number;
	toolCallId: string;
	toolName: string;
	inputJson: string;
	inputHash: string;
	policyJson: string;
	requestedByClientId?: string;
	targetClientId?: string;
	createdAt: number;
	expiresAt: number;
}

export interface DurableToolApprovalDecision {
	approvalId: string;
	sessionId?: string;
	approved: boolean;
	reason?: string;
	decidedByClientId?: string;
	decidedAt: number;
}

export type DurableToolApprovalDecisionOutcome =
	| "applied"
	| "existing"
	| "conflict";

export interface DurableToolApprovalDecisionResult {
	outcome: DurableToolApprovalDecisionOutcome;
	record: DurableToolApprovalRecord;
}

export interface DurableToolApprovalStore {
	init(): Promise<void> | void;
	createOrGet(
		input: CreateDurableToolApprovalInput,
	): Promise<{ created: boolean; record: DurableToolApprovalRecord }>;
	bindPrincipal(
		approvalId: string,
		requestedByClientId: string,
		targetClientId?: string,
	): Promise<DurableToolApprovalRecord>;
	respond(
		decision: DurableToolApprovalDecision,
	): Promise<DurableToolApprovalDecisionResult>;
	get(approvalId: string): Promise<DurableToolApprovalRecord | undefined>;
	listPending(sessionId?: string): Promise<DurableToolApprovalRecord[]>;
	expire(
		approvalId: string,
		now: number,
	): Promise<DurableToolApprovalRecord | undefined>;
	cancel(
		approvalId: string,
		reason: string,
		now: number,
	): Promise<DurableToolApprovalRecord | undefined>;
	cancelSession(
		sessionId: string,
		reason: string,
		now: number,
	): Promise<DurableToolApprovalRecord[]>;
	close(): Promise<void> | void;
}

interface ApprovalRow {
	approval_id: string;
	request_key: string;
	session_id: string;
	agent_id: string;
	conversation_id: string;
	run_id: string | null;
	iteration: number;
	tool_call_index: number | null;
	tool_call_id: string;
	tool_name: string;
	input_json: string;
	input_hash: string;
	policy_json: string;
	status: string;
	requested_by_client_id: string | null;
	target_client_id: string | null;
	created_at: number;
	expires_at: number;
	decided_at: number | null;
	decided_by_client_id: string | null;
	reason: string | null;
	version: number;
}

export interface SqliteDurableToolApprovalStoreOptions {
	dbPath?: string;
	clock?: () => number;
}

function defaultApprovalDbPath(): string {
	return join(resolveDbDataDir(), "approvals.db");
}

function parseStatus(value: string): DurableToolApprovalStatus {
	if (
		value === "pending" ||
		value === "approved" ||
		value === "denied" ||
		value === "expired" ||
		value === "cancelled"
	) {
		return value;
	}
	throw new Error(`Unknown durable approval status: ${value}`);
}

function rowToRecord(row: ApprovalRow): DurableToolApprovalRecord {
	return {
		approvalId: row.approval_id,
		requestKey: row.request_key,
		sessionId: row.session_id,
		agentId: row.agent_id,
		conversationId: row.conversation_id,
		runId: row.run_id ?? undefined,
		iteration: row.iteration,
		toolCallIndex: row.tool_call_index ?? undefined,
		toolCallId: row.tool_call_id,
		toolName: row.tool_name,
		inputJson: row.input_json,
		inputHash: row.input_hash,
		policyJson: row.policy_json,
		status: parseStatus(row.status),
		requestedByClientId: row.requested_by_client_id ?? undefined,
		targetClientId: row.target_client_id ?? undefined,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		decidedAt: row.decided_at ?? undefined,
		decidedByClientId: row.decided_by_client_id ?? undefined,
		reason: row.reason ?? undefined,
		version: row.version,
	};
}

export class SqliteDurableToolApprovalStore
	implements DurableToolApprovalStore
{
	private readonly dbFilePath: string;
	private readonly clock: () => number;
	private db: SqliteDb | undefined;
	private closed = false;

	constructor(options: SqliteDurableToolApprovalStoreOptions = {}) {
		this.dbFilePath = options.dbPath ?? defaultApprovalDbPath();
		this.clock = options.clock ?? Date.now;
	}

	init(): void {
		this.getRawDb();
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.db?.close?.();
		this.db = undefined;
	}

	private getRawDb(): SqliteDb {
		if (this.closed) {
			throw new Error("Durable approval store is closed");
		}
		if (this.db) {
			return this.db;
		}
		const db = loadSqliteDb(this.dbFilePath);
		try {
			this.ensureSchema(db);
			this.db = db;
			return db;
		} catch (error) {
			db.close?.();
			throw error;
		}
	}

	private ensureSchema(db: SqliteDb): void {
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("PRAGMA busy_timeout = 5000;");
		this.withTransaction(db, () => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS durable_tool_approval_schema_version (
					lock INTEGER PRIMARY KEY CHECK (lock = 1),
					version INTEGER NOT NULL
				);
			`);
			const versionRow = db
				.prepare(
					"SELECT version FROM durable_tool_approval_schema_version WHERE lock = 1",
				)
				.get() as { version: number } | null;
			if (versionRow && Number(versionRow.version) > 1) {
				throw new Error(
					`Unsupported durable approval schema version: ${versionRow.version}`,
				);
			}
			db.exec(`
				CREATE TABLE IF NOT EXISTS durable_tool_approvals (
					approval_id TEXT PRIMARY KEY,
					request_key TEXT NOT NULL UNIQUE,
					session_id TEXT NOT NULL,
					agent_id TEXT NOT NULL,
					conversation_id TEXT NOT NULL,
					run_id TEXT,
					iteration INTEGER NOT NULL,
					tool_call_index INTEGER,
					tool_call_id TEXT NOT NULL,
					tool_name TEXT NOT NULL,
					input_json TEXT NOT NULL,
					input_hash TEXT NOT NULL,
					policy_json TEXT NOT NULL,
					status TEXT NOT NULL,
					requested_by_client_id TEXT,
					target_client_id TEXT,
					created_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL,
					decided_at INTEGER,
					decided_by_client_id TEXT,
					reason TEXT,
					version INTEGER NOT NULL DEFAULT 1
				);
			`);
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_durable_tool_approvals_pending
					ON durable_tool_approvals(status, session_id, created_at);
			`);
			if (!versionRow) {
				db.prepare(
					"INSERT INTO durable_tool_approval_schema_version (lock, version) VALUES (1, 1)",
				).run();
			}
		});
	}

	private withTransaction<T>(db: SqliteDb, work: () => T): T {
		db.exec("BEGIN IMMEDIATE;");
		try {
			const result = work();
			db.exec("COMMIT;");
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK;");
			} catch {}
			throw error;
		}
	}

	private getOneByApprovalId(approvalId: string): ApprovalRow | undefined {
		return (
			(this.getRawDb()
				.prepare("SELECT * FROM durable_tool_approvals WHERE approval_id = ?")
				.get(approvalId) as ApprovalRow | null) ?? undefined
		);
	}

	private getOneByRequestKey(requestKey: string): ApprovalRow | undefined {
		return (
			(this.getRawDb()
				.prepare("SELECT * FROM durable_tool_approvals WHERE request_key = ?")
				.get(requestKey) as ApprovalRow | null) ?? undefined
		);
	}

	async createOrGet(
		input: CreateDurableToolApprovalInput,
	): Promise<{ created: boolean; record: DurableToolApprovalRecord }> {
		const db = this.getRawDb();
		return this.withTransaction(db, () => {
			const existing = this.getOneByRequestKey(input.requestKey);
			if (existing) {
				if (
					existing.session_id !== input.sessionId ||
					existing.agent_id !== input.agentId ||
					existing.conversation_id !== input.conversationId ||
					existing.input_hash !== input.inputHash ||
					existing.tool_name !== input.toolName ||
					existing.run_id !== (input.runId ?? null) ||
					existing.iteration !== input.iteration ||
					existing.tool_call_index !== (input.toolCallIndex ?? null)
				) {
					throw new Error(
						`Durable approval key collision: ${input.requestKey}`,
					);
				}
				if (
					existing.status === "pending" &&
					existing.expires_at <= this.clock()
				) {
					this.expireRow(existing.approval_id, this.clock());
				}
				return {
					created: false,
					record: rowToRecord(
						this.getOneByApprovalId(existing.approval_id) as ApprovalRow,
					),
				};
			}
			this.getRawDb()
				.prepare(
					`INSERT INTO durable_tool_approvals
						(approval_id, request_key, session_id, agent_id, conversation_id,
						 run_id, iteration, tool_call_index, tool_call_id, tool_name,
						 input_json, input_hash, policy_json, status, requested_by_client_id,
						 target_client_id, created_at, expires_at, version)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 1)`,
				)
				.run(
					input.approvalId,
					input.requestKey,
					input.sessionId,
					input.agentId,
					input.conversationId,
					input.runId ?? null,
					input.iteration,
					input.toolCallIndex ?? null,
					input.toolCallId,
					input.toolName,
					input.inputJson,
					input.inputHash,
					input.policyJson,
					input.requestedByClientId ?? null,
					input.targetClientId ?? null,
					input.createdAt,
					input.expiresAt,
				);
			return {
				created: true,
				record: rowToRecord(
					this.getOneByApprovalId(input.approvalId) as ApprovalRow,
				),
			};
		});
	}

	async bindPrincipal(
		approvalId: string,
		requestedByClientId: string,
		targetClientId?: string,
	): Promise<DurableToolApprovalRecord> {
		const db = this.getRawDb();
		return this.withTransaction(db, () => {
			const existing = this.getOneByApprovalId(approvalId);
			if (!existing) {
				throw new Error(`Unknown durable approval: ${approvalId}`);
			}
			if (
				(existing.requested_by_client_id &&
					existing.requested_by_client_id !== requestedByClientId) ||
				(existing.target_client_id &&
					targetClientId &&
					existing.target_client_id !== targetClientId)
			) {
				throw new Error(`Durable approval principal mismatch: ${approvalId}`);
			}
			this.getRawDb()
				.prepare(
					`UPDATE durable_tool_approvals
					 SET requested_by_client_id = COALESCE(requested_by_client_id, ?),
						 target_client_id = COALESCE(target_client_id, ?),
						 version = version + 1
					 WHERE approval_id = ?`,
				)
				.run(requestedByClientId, targetClientId ?? null, approvalId);
			return rowToRecord(this.getOneByApprovalId(approvalId) as ApprovalRow);
		});
	}

	async respond(
		decision: DurableToolApprovalDecision,
	): Promise<DurableToolApprovalDecisionResult> {
		const db = this.getRawDb();
		return this.withTransaction(db, () => {
			const existing = this.getOneByApprovalId(decision.approvalId);
			if (!existing) {
				throw new Error(`Unknown durable approval: ${decision.approvalId}`);
			}
			if (decision.sessionId && existing.session_id !== decision.sessionId) {
				throw new Error(
					`Durable approval session mismatch: ${decision.approvalId}`,
				);
			}
			const current = rowToRecord(existing);
			const targetStatus = decision.approved ? "approved" : "denied";
			if (current.status !== "pending") {
				return {
					outcome: current.status === targetStatus ? "existing" : "conflict",
					record: current,
				};
			}
			if (current.expiresAt <= decision.decidedAt) {
				this.expireRow(decision.approvalId, decision.decidedAt);
				return {
					outcome: "conflict",
					record: rowToRecord(
						this.getOneByApprovalId(decision.approvalId) as ApprovalRow,
					),
				};
			}
			const changes = this.getRawDb()
				.prepare(
					`UPDATE durable_tool_approvals
					 SET status = ?, decided_at = ?, decided_by_client_id = ?, reason = ?,
						 version = version + 1
					 WHERE approval_id = ? AND status = 'pending'`,
				)
				.run(
					targetStatus,
					decision.decidedAt,
					decision.decidedByClientId ?? null,
					decision.reason ?? null,
					decision.approvalId,
				).changes;
			if (changes !== 1) {
				throw new Error(
					`Durable approval decision conflict: ${decision.approvalId}`,
				);
			}
			return {
				outcome: "applied",
				record: rowToRecord(
					this.getOneByApprovalId(decision.approvalId) as ApprovalRow,
				),
			};
		});
	}

	async get(
		approvalId: string,
	): Promise<DurableToolApprovalRecord | undefined> {
		const row = this.getOneByApprovalId(approvalId);
		return row ? rowToRecord(row) : undefined;
	}

	async listPending(sessionId?: string): Promise<DurableToolApprovalRecord[]> {
		this.expireAllPending(this.clock());
		const rows = sessionId
			? (this.getRawDb()
					.prepare(
						`SELECT * FROM durable_tool_approvals
						 WHERE status = 'pending' AND session_id = ?
						 ORDER BY created_at ASC`,
					)
					.all(sessionId) as unknown as ApprovalRow[])
			: (this.getRawDb()
					.prepare(
						`SELECT * FROM durable_tool_approvals
						 WHERE status = 'pending'
						 ORDER BY created_at ASC`,
					)
					.all() as unknown as ApprovalRow[]);
		return rows.map(rowToRecord);
	}

	async expire(
		approvalId: string,
		now: number,
	): Promise<DurableToolApprovalRecord | undefined> {
		this.expireRow(approvalId, now);
		const row = this.getOneByApprovalId(approvalId);
		return row ? rowToRecord(row) : undefined;
	}

	async cancel(
		approvalId: string,
		reason: string,
		now: number,
	): Promise<DurableToolApprovalRecord | undefined> {
		const db = this.getRawDb();
		return this.withTransaction(db, () => {
			this.getRawDb()
				.prepare(
					`UPDATE durable_tool_approvals
					 SET status = 'cancelled', decided_at = ?, reason = ?, version = version + 1
					 WHERE approval_id = ? AND status = 'pending'`,
				)
				.run(now, reason, approvalId);
			const row = this.getOneByApprovalId(approvalId);
			return row ? rowToRecord(row) : undefined;
		});
	}

	async cancelSession(
		sessionId: string,
		reason: string,
		now: number,
	): Promise<DurableToolApprovalRecord[]> {
		const db = this.getRawDb();
		return this.withTransaction(db, () => {
			const rows = this.getRawDb()
				.prepare(
					`SELECT * FROM durable_tool_approvals
					 WHERE status = 'pending' AND session_id = ?`,
				)
				.all(sessionId) as unknown as ApprovalRow[];
			const approvalIds = rows.map((row) => row.approval_id);
			if (approvalIds.length === 0) {
				return [];
			}
			this.getRawDb()
				.prepare(
					`UPDATE durable_tool_approvals
					 SET status = 'cancelled', decided_at = ?, reason = ?, version = version + 1
					 WHERE status = 'pending' AND session_id = ?`,
				)
				.run(now, reason, sessionId);
			return approvalIds.flatMap((approvalId) => {
				const row = this.getOneByApprovalId(approvalId);
				return row ? [rowToRecord(row)] : [];
			});
		});
	}

	private expireRow(approvalId: string, now: number): void {
		this.getRawDb()
			.prepare(
				`UPDATE durable_tool_approvals
				 SET status = 'expired', decided_at = ?, reason = COALESCE(reason, 'Approval expired'),
					 version = version + 1
				 WHERE approval_id = ? AND status = 'pending' AND expires_at <= ?`,
			)
			.run(now, approvalId, now);
	}

	private expireAllPending(now: number): void {
		this.getRawDb()
			.prepare(
				`UPDATE durable_tool_approvals
				 SET status = 'expired', decided_at = ?, reason = COALESCE(reason, 'Approval expired'),
					 version = version + 1
				 WHERE status = 'pending' AND expires_at <= ?`,
			)
			.run(now, now);
	}
}

export const DEFAULT_DURABLE_TOOL_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface DurableToolApprovalRequestOptions {
	requestedByClientId?: string;
	targetClientId?: string;
	expiresInMs?: number;
	approvalId?: string;
}

export type DurableToolApprovalHandler = (
	request: ToolApprovalRequest & { approvalId: string },
) => Promise<ToolApprovalResult>;

export class DurableToolApprovalCoordinator {
	private readonly waiters = new Map<
		string,
		Set<(result: ToolApprovalResult) => void>
	>();
	private initialization: Promise<void> | undefined;
	private readonly pendingCreations = new Map<string, Set<Promise<void>>>();
	private readonly pendingDeliveries = new Map<string, Set<Promise<void>>>();
	private preservePendingApprovals = false;
	private closed = false;

	constructor(
		readonly store: DurableToolApprovalStore = new SqliteDurableToolApprovalStore(),
		private readonly clock: () => number = Date.now,
	) {}

	setPreservePendingApprovals(preserve: boolean): void {
		this.preservePendingApprovals = preserve;
	}

	releaseWaiters(
		reason = "Approval runtime shut down before a decision was received",
	): void {
		for (const [approvalId, waiters] of this.waiters) {
			for (const resolve of waiters) {
				resolve({ approved: false, reason });
			}
			waiters.clear();
			this.waiters.delete(approvalId);
		}
	}

	beginRequestDelivery(sessionId: string): () => void {
		let resolveDelivery: (() => void) | undefined;
		const delivery = new Promise<void>((resolve) => {
			resolveDelivery = resolve;
		});
		const deliveries = this.pendingDeliveries.get(sessionId) ?? new Set();
		deliveries.add(delivery);
		this.pendingDeliveries.set(sessionId, deliveries);
		return () => {
			resolveDelivery?.();
			deliveries.delete(delivery);
			if (deliveries.size === 0) {
				this.pendingDeliveries.delete(sessionId);
			}
		};
	}

	async createRequest(
		request: ToolApprovalRequest,
		options: DurableToolApprovalRequestOptions = {},
	): Promise<{ created: boolean; record: DurableToolApprovalRecord }> {
		let resolveCreation: (() => void) | undefined;
		const creation = new Promise<void>((resolve) => {
			resolveCreation = resolve;
		});
		const creations = this.pendingCreations.get(request.sessionId) ?? new Set();
		creations.add(creation);
		this.pendingCreations.set(request.sessionId, creations);
		try {
			return await this.createRequestInternal(request, options);
		} finally {
			resolveCreation?.();
			creations.delete(creation);
			if (creations.size === 0) {
				this.pendingCreations.delete(request.sessionId);
			}
		}
	}

	private async createRequestInternal(
		request: ToolApprovalRequest,
		options: DurableToolApprovalRequestOptions = {},
	): Promise<{ created: boolean; record: DurableToolApprovalRecord }> {
		await this.initialize();
		const inputJson = JSON.stringify(request.input ?? null);
		const policyJson = JSON.stringify(request.policy ?? {});
		if (inputJson === undefined || policyJson === undefined) {
			throw new Error("Tool approval request must be JSON serializable");
		}
		const inputHash = hashToolInput(request.input);
		const now = this.clock();
		const expiresInMs =
			options.expiresInMs ?? DEFAULT_DURABLE_TOOL_APPROVAL_TTL_MS;
		if (!Number.isFinite(expiresInMs) || expiresInMs <= 0) {
			throw new Error("Tool approval expiry must be positive");
		}
		const requestKey = deriveIdempotencyKey({
			sessionId: request.sessionId,
			toolName: request.toolName,
			runId: request.runId,
			iteration: request.iteration,
			toolCallIndex: request.toolCallIndex,
			inputHash,
		});
		return this.store.createOrGet({
			approvalId:
				options.approvalId ??
				request.approvalId ??
				createSessionId("approval_"),
			requestKey,
			sessionId: request.sessionId,
			agentId: request.agentId,
			conversationId: request.conversationId,
			runId: request.runId,
			iteration: request.iteration,
			toolCallIndex: request.toolCallIndex,
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			inputJson,
			inputHash,
			policyJson,
			requestedByClientId: options.requestedByClientId,
			targetClientId: options.targetClientId,
			createdAt: now,
			expiresAt: now + expiresInMs,
		});
	}

	async request(
		request: ToolApprovalRequest,
		handler: DurableToolApprovalHandler,
		options: DurableToolApprovalRequestOptions = {},
	): Promise<ToolApprovalResult> {
		const { record } = await this.createRequest(request, options);
		const terminal = this.resultForRecord(record);
		if (terminal) {
			return terminal;
		}
		if (request.signal?.aborted) {
			await this.cancel(
				record.approvalId,
				"Tool approval aborted before delivery",
			);
			return {
				approved: false,
				reason: "Tool approval aborted before delivery",
			};
		}
		const waiting = this.waitForDecision(record, request.signal);
		void Promise.resolve(handler({ ...request, approvalId: record.approvalId }))
			.then((result) => {
				if (this.preservePendingApprovals) {
					return undefined;
				}
				return this.respond(record.approvalId, result, "runtime");
			})
			.catch(async (error) => {
				if (this.preservePendingApprovals) {
					return;
				}
				await this.respond(
					record.approvalId,
					{
						approved: false,
						reason:
							error instanceof Error
								? error.message
								: `Tool approval request failed: ${String(error)}`,
					},
					"runtime",
				);
			})
			.catch(() => {});
		return waiting;
	}

	async respond(
		approvalId: string,
		result: ToolApprovalResult,
		decidedByClientId?: string,
		sessionId?: string,
	): Promise<DurableToolApprovalDecisionResult> {
		await this.initialize();
		const decision = await this.store.respond({
			approvalId,
			sessionId,
			approved: result.approved,
			reason: result.reason,
			decidedByClientId,
			decidedAt: this.clock(),
		});
		if (decision.outcome !== "conflict") {
			this.resolveWaiters(
				approvalId,
				this.resultForRecord(decision.record) ?? result,
			);
		}
		return decision;
	}

	async bindPrincipal(
		approvalId: string,
		requestedByClientId: string,
		targetClientId?: string,
	): Promise<DurableToolApprovalRecord> {
		await this.initialize();
		return this.store.bindPrincipal(
			approvalId,
			requestedByClientId,
			targetClientId,
		);
	}

	async get(
		approvalId: string,
	): Promise<DurableToolApprovalRecord | undefined> {
		await this.initialize();
		return this.store.get(approvalId);
	}

	async listPending(sessionId?: string): Promise<DurableToolApprovalRecord[]> {
		await this.initialize();
		return this.store.listPending(sessionId);
	}

	async cancel(
		approvalId: string,
		reason: string,
	): Promise<DurableToolApprovalRecord | undefined> {
		if (this.preservePendingApprovals || !this.initialization) {
			return undefined;
		}
		await this.initialize();
		const cancelled = await this.store.cancel(approvalId, reason, this.clock());
		if (cancelled?.status === "cancelled") {
			this.resolveWaiters(approvalId, {
				approved: false,
				reason: cancelled.reason ?? reason,
			});
		}
		return cancelled;
	}

	async cancelSession(
		sessionId: string,
		reason: string,
	): Promise<DurableToolApprovalRecord[]> {
		if (this.preservePendingApprovals) {
			return [];
		}
		while (true) {
			const pending = [
				...(this.pendingCreations.get(sessionId) ?? []),
				...(this.pendingDeliveries.get(sessionId) ?? []),
			];
			if (pending.length === 0) {
				break;
			}
			await Promise.all(pending);
		}
		if (!this.initialization) {
			return [];
		}
		await this.initialize();
		const cancelled = await this.store.cancelSession(
			sessionId,
			reason,
			this.clock(),
		);
		for (const item of cancelled) {
			this.resolveWaiters(item.approvalId, {
				approved: false,
				reason: item.reason ?? reason,
			});
		}
		return cancelled;
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.releaseWaiters();
		await this.store.close();
	}

	private async initialize(): Promise<void> {
		if (this.closed) {
			throw new Error("Durable approval coordinator is closed");
		}
		if (!this.initialization) {
			this.initialization = Promise.resolve()
				.then(async () => {
					await this.store.init();
				})
				.catch((error) => {
					this.initialization = undefined;
					throw error;
				});
		}
		await this.initialization;
	}

	async waitForDecision(
		record: DurableToolApprovalRecord,
		signal?: AbortSignal,
	): Promise<ToolApprovalResult> {
		if (this.preservePendingApprovals) {
			return {
				approved: false,
				reason: "Approval runtime shut down before a decision was received",
			};
		}
		const current = await this.store.get(record.approvalId);
		const currentResult = current ? this.resultForRecord(current) : undefined;
		if (currentResult) {
			return currentResult;
		}
		return new Promise((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let signalListener: (() => void) | undefined;
			const waiters = this.waiters.get(record.approvalId) ?? new Set();
			const finish = (result: ToolApprovalResult): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer) clearTimeout(timer);
				if (signalListener) {
					signal?.removeEventListener("abort", signalListener);
				}
				waiters.delete(finish);
				if (waiters.size === 0) {
					this.waiters.delete(record.approvalId);
				}
				resolve(result);
			};
			waiters.add(finish);
			this.waiters.set(record.approvalId, waiters);
			if (this.preservePendingApprovals) {
				finish({
					approved: false,
					reason: "Approval runtime shut down before a decision was received",
				});
				return;
			}
			void this.store
				.get(record.approvalId)
				.then((latest) => {
					const latestResult = latest
						? this.resultForRecord(latest)
						: undefined;
					if (latestResult) {
						finish(latestResult);
					}
				})
				.catch(() => {});
			if (signal) {
				signalListener = () => {
					if (this.preservePendingApprovals) {
						finish({
							approved: false,
							reason:
								"Approval runtime shut down before a decision was received",
						});
						return;
					}
					void this.cancel(record.approvalId, "Tool approval aborted").catch(
						() => {
							finish({
								approved: false,
								reason: "Tool approval aborted",
							});
						},
					);
				};
				signal.addEventListener("abort", signalListener, { once: true });
			}
			timer = setTimeout(
				() => {
					void this.store
						.expire(record.approvalId, this.clock())
						.then(() => {
							finish({
								approved: false,
								reason: "Tool approval expired",
							});
						})
						.catch(() => {
							finish({
								approved: false,
								reason: "Tool approval expiry could not be persisted",
							});
						});
				},
				Math.max(1, record.expiresAt - this.clock()),
			);
			timer.unref?.();
		});
	}

	private resolveWaiters(approvalId: string, result: ToolApprovalResult): void {
		const waiters = this.waiters.get(approvalId);
		if (!waiters) {
			return;
		}
		for (const resolve of waiters) {
			resolve(result);
		}
		waiters.clear();
		this.waiters.delete(approvalId);
	}

	toToolApprovalResult(
		record: DurableToolApprovalRecord,
	): ToolApprovalResult | undefined {
		return this.resultForRecord(record);
	}

	private resultForRecord(
		record: DurableToolApprovalRecord,
	): ToolApprovalResult | undefined {
		if (record.status === "pending") {
			return undefined;
		}
		return {
			approved: record.status === "approved",
			reason: record.reason,
		};
	}
}
