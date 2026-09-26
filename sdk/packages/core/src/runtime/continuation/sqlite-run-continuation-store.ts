import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadSqliteDb, type SqliteDb } from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";
import {
	parseRunRecoverySnapshot,
	type RunRecoverySnapshot,
	serializeRunRecoverySnapshot,
} from "./recovery-snapshot";
import {
	type CancelRunContinuationInput,
	type ClaimRunContinuationInput,
	type CloseRunContinuationInput,
	type CreateRunContinuationInput,
	DEFAULT_RUN_CONTINUATION_LEASE_MS,
	isRunContinuationPhase,
	isRunContinuationTerminalPhase,
	parseRunContinuationAgentChain,
	type RunContinuationClaim,
	RunContinuationClosedError,
	RunContinuationCollisionError,
	type RunContinuationIdentity,
	RunContinuationIdentityMismatchError,
	RunContinuationInputHashMismatchError,
	RunContinuationLeaseLostError,
	type RunContinuationMutationGuard,
	RunContinuationNotFoundError,
	type RunContinuationPhase,
	RunContinuationPhaseMismatchError,
	type RunContinuationRecord,
	type RunContinuationStore,
	type RunContinuationTerminalPhase,
	type RunContinuationUpsertResult,
	serializeRunContinuationAgentChain,
	type TransitionRunContinuationInput,
	type UpsertRunContinuationInput,
} from "./run-continuation-store";
import {
	parseRunState,
	type RunState,
	runStateResumeTurn,
	runStateStepForRecord,
	serializeRunState,
} from "./run-state";

const SCHEMA_VERSION = 4;
const TERMINAL_PHASES = [
	"completed",
	"failed",
	"cancelled",
	"succeeded",
] as const;

interface ContinuationRow {
	continuation_key: string;
	session_id: string;
	run_id: string;
	agent_id: string;
	conversation_id: string;
	iteration: number;
	tool_call_index: number;
	tool_call_id: string;
	tool_name: string;
	prepared_input_json: string;
	prepared_input_hash: string;
	assistant_message_id: string;
	approval_id: string;
	phase: string;
	owner_token: string | null;
	lease_started_at: string | null;
	lease_expires_at: string | null;
	created_at: string;
	updated_at: string;
	terminal_error: string | null;
	terminal_reason: string | null;
	recovery_snapshot_json: string | null;
	run_state_json: string | null;
	agent_chain_json: string | null;
}

export interface SqliteRunContinuationStoreOptions {
	dbPath?: string;
	clock?: () => Date | number;
}

function defaultDbPath(): string {
	return join(resolveDbDataDir(), "continuations.db");
}

function assertText(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Run continuation ${field} must be a non-empty string`);
	}
}

function assertIndex(value: unknown, field: string): asserts value is number {
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new Error(`Run continuation ${field} must be a non-negative integer`);
	}
}

function parsePhase(value: string): RunContinuationPhase {
	if (!isRunContinuationPhase(value)) {
		throw new Error(`Unknown run continuation phase: ${value}`);
	}
	return value;
}

function rowToRecord(row: ContinuationRow): RunContinuationRecord {
	const record: RunContinuationRecord = {
		continuationKey: row.continuation_key,
		sessionId: row.session_id,
		runId: row.run_id,
		agentId: row.agent_id,
		conversationId: row.conversation_id,
		iteration: Number(row.iteration),
		toolCallIndex: Number(row.tool_call_index),
		toolCallId: row.tool_call_id,
		toolName: row.tool_name,
		preparedInputJson: row.prepared_input_json,
		preparedInputHash: row.prepared_input_hash,
		assistantMessageId: row.assistant_message_id,
		approvalId: row.approval_id,
		phase: parsePhase(row.phase),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	if (row.owner_token !== null) record.ownerToken = row.owner_token;
	if (row.lease_started_at !== null)
		record.leaseStartedAt = row.lease_started_at;
	if (row.lease_expires_at !== null)
		record.leaseExpiresAt = row.lease_expires_at;
	if (row.terminal_error !== null) record.terminalError = row.terminal_error;
	if (row.terminal_reason !== null) record.terminalReason = row.terminal_reason;
	if (row.recovery_snapshot_json !== null) {
		record.recoverySnapshot = parseRunRecoverySnapshot(
			row.recovery_snapshot_json,
		);
	}
	if (row.run_state_json !== null) {
		record.runState = parseRunState(row.run_state_json);
	}
	const agentChain = parseRunContinuationAgentChain(row.agent_chain_json);
	if (agentChain) {
		record.agentChain = agentChain;
	}
	return record;
}

function validateCreateInput(
	input: CreateRunContinuationInput,
): CreateRunContinuationInput & { phase: RunContinuationPhase } {
	assertText(input.continuationKey, "continuationKey");
	assertText(input.sessionId, "sessionId");
	assertText(input.runId, "runId");
	assertText(input.agentId, "agentId");
	assertText(input.conversationId, "conversationId");
	assertText(input.toolCallId, "toolCallId");
	assertText(input.toolName, "toolName");
	assertText(input.preparedInputJson, "preparedInputJson");
	assertText(input.preparedInputHash, "preparedInputHash");
	assertText(input.assistantMessageId, "assistantMessageId");
	assertText(input.approvalId, "approvalId");
	assertIndex(input.iteration, "iteration");
	assertIndex(input.toolCallIndex, "toolCallIndex");
	try {
		JSON.parse(input.preparedInputJson);
	} catch {
		throw new Error("Run continuation prepared input must be valid JSON");
	}
	const phase = input.phase ?? "awaiting_approval";
	if (!isRunContinuationPhase(phase)) {
		throw new Error(`Unknown run continuation phase: ${String(phase)}`);
	}
	const recoverySnapshot =
		input.recoverySnapshot === undefined
			? undefined
			: parseRunRecoverySnapshot(
					serializeRunRecoverySnapshot(input.recoverySnapshot),
				);
	const runState =
		input.runState === undefined
			? undefined
			: parseRunState(serializeRunState(input.runState));
	const agentChain =
		input.agentChain === undefined
			? undefined
			: parseRunContinuationAgentChain(
					serializeRunContinuationAgentChain(input.agentChain),
				);
	if (agentChain && agentChain.agentId !== input.agentId) {
		throw new RunContinuationIdentityMismatchError(
			"agentChain",
			input.continuationKey,
		);
	}
	if (runState) {
		const turn = runStateResumeTurn(runState.resume);
		if (
			turn.sessionId !== input.sessionId ||
			turn.runId !== input.runId ||
			turn.agentId !== input.agentId ||
			turn.conversationId !== input.conversationId ||
			turn.iteration !== input.iteration ||
			turn.assistantMessageId !== input.assistantMessageId ||
			!runStateStepForRecord(runState, input)
		) {
			throw new RunContinuationIdentityMismatchError(
				"runState",
				input.continuationKey,
			);
		}
		// A durable agent chain and the run state's own agent block must agree;
		// a mismatch would let a delegated turn be read back as a root turn.
		const stateAgent = runState.agent;
		if (
			agentChain &&
			stateAgent &&
			(stateAgent.agentId !== agentChain.agentId ||
				stateAgent.parentAgentId !== agentChain.parentAgentId ||
				stateAgent.rootRunId !== agentChain.rootRunId)
		) {
			throw new RunContinuationIdentityMismatchError(
				"agentChain",
				input.continuationKey,
			);
		}
	}
	return { ...input, phase, recoverySnapshot, runState, agentChain };
}

function expectedPhaseFromGuard(
	guard: RunContinuationMutationGuard,
): RunContinuationPhase | undefined {
	if (
		guard.expectedPhase !== undefined &&
		guard.fromPhase !== undefined &&
		guard.expectedPhase !== guard.fromPhase
	) {
		throw new Error("Run continuation phase guards disagree");
	}
	return guard.expectedPhase ?? guard.fromPhase;
}

function expectedIdentityFromGuard(
	guard: RunContinuationMutationGuard,
): Partial<RunContinuationIdentity> {
	if (guard.identity !== undefined && guard.expectedIdentity !== undefined) {
		return { ...guard.expectedIdentity, ...guard.identity };
	}
	return guard.expectedIdentity ?? guard.identity ?? {};
}

function expectedHashFromGuard(
	guard: RunContinuationMutationGuard,
): string | undefined {
	if (
		guard.inputHash !== undefined &&
		guard.expectedInputHash !== undefined &&
		guard.inputHash !== guard.expectedInputHash
	) {
		throw new RunContinuationInputHashMismatchError("unknown");
	}
	return guard.expectedInputHash ?? guard.inputHash;
}

function assertInputHash(
	row: ContinuationRow,
	expectedHash: string | undefined,
	continuationKey: string,
): void {
	if (expectedHash !== undefined && row.prepared_input_hash !== expectedHash) {
		throw new RunContinuationInputHashMismatchError(continuationKey);
	}
}

function assertRecoverySnapshot(
	row: ContinuationRow,
	expected: RunRecoverySnapshot | undefined,
	continuationKey: string,
): void {
	if (expected === undefined) {
		return;
	}
	const serialized = serializeRunRecoverySnapshot(expected);
	if (row.recovery_snapshot_json === null) {
		throw new RunContinuationIdentityMismatchError(
			"recoverySnapshot",
			continuationKey,
		);
	}
	if (row.recovery_snapshot_json !== serialized) {
		throw new RunContinuationIdentityMismatchError(
			"recoverySnapshot",
			continuationKey,
		);
	}
}

function assertRunState(
	row: ContinuationRow,
	expected: RunState | undefined,
	continuationKey: string,
): void {
	if (expected === undefined) {
		return;
	}
	const serialized = serializeRunState(expected);
	if (row.run_state_json === null || row.run_state_json !== serialized) {
		throw new RunContinuationIdentityMismatchError("runState", continuationKey);
	}
}

function assertIdentity(
	row: ContinuationRow,
	expected: Partial<RunContinuationIdentity>,
	continuationKey: string,
): void {
	const fields: Array<
		[keyof RunContinuationIdentity, string | number, string]
	> = [
		["sessionId", row.session_id, "sessionId"],
		["runId", row.run_id, "runId"],
		["agentId", row.agent_id, "agentId"],
		["conversationId", row.conversation_id, "conversationId"],
		["iteration", Number(row.iteration), "iteration"],
		["toolCallIndex", Number(row.tool_call_index), "toolCallIndex"],
		["toolCallId", row.tool_call_id, "toolCallId"],
		["toolName", row.tool_name, "toolName"],
		["preparedInputJson", row.prepared_input_json, "preparedInputJson"],
		["preparedInputHash", row.prepared_input_hash, "preparedInputHash"],
		["assistantMessageId", row.assistant_message_id, "assistantMessageId"],
		["approvalId", row.approval_id, "approvalId"],
	];
	for (const [field, actual, fieldName] of fields) {
		const expectedValue = expected[field];
		if (expectedValue !== undefined && expectedValue !== actual) {
			throw new RunContinuationIdentityMismatchError(
				fieldName,
				continuationKey,
			);
		}
	}
}

function assertMutationGuards(
	row: ContinuationRow,
	guard: RunContinuationMutationGuard,
	continuationKey: string,
): void {
	const expectedPhase = expectedPhaseFromGuard(guard);
	if (expectedPhase !== undefined && row.phase !== expectedPhase) {
		throw new RunContinuationPhaseMismatchError(
			continuationKey,
			expectedPhase,
			parsePhase(row.phase),
		);
	}
	assertInputHash(row, expectedHashFromGuard(guard), continuationKey);
	assertIdentity(row, expectedIdentityFromGuard(guard), continuationKey);
}

function assertLease(
	row: ContinuationRow,
	ownerToken: string | undefined,
	continuationKey: string,
	nowIso: string,
): void {
	if (row.owner_token === null) {
		if (ownerToken !== undefined) {
			throw new RunContinuationLeaseLostError(continuationKey);
		}
		return;
	}
	if (
		ownerToken === undefined ||
		ownerToken !== row.owner_token ||
		row.lease_expires_at === null ||
		row.lease_expires_at <= nowIso
	) {
		throw new RunContinuationLeaseLostError(continuationKey);
	}
}

function assertTerminalPhase(
	phase: RunContinuationPhase,
	continuationKey: string,
): void {
	if (isRunContinuationTerminalPhase(phase)) {
		throw new RunContinuationPhaseMismatchError(continuationKey, phase, phase);
	}
}

function assertTransitionAllowed(
	from: RunContinuationPhase,
	to: RunContinuationPhase,
	continuationKey: string,
): void {
	if (from === to) return;
	if (isRunContinuationTerminalPhase(from)) {
		throw new RunContinuationPhaseMismatchError(continuationKey, from, from);
	}
	if (isRunContinuationTerminalPhase(to)) return;
	const allowed: Record<string, ReadonlySet<RunContinuationPhase>> = {
		awaiting_approval: new Set(["approved"]),
		approved: new Set(["executing"]),
		executing: new Set(),
	};
	if (!allowed[from]?.has(to)) {
		throw new Error(
			`Invalid run continuation phase transition: ${from} -> ${to} (${continuationKey})`,
		);
	}
}

function normalizeTerminalPhase(
	input: CloseRunContinuationInput,
): RunContinuationTerminalPhase {
	const phase = input.phase ?? input.status ?? "completed";
	if (
		phase !== "completed" &&
		phase !== "failed" &&
		phase !== "cancelled" &&
		phase !== "succeeded"
	) {
		throw new Error(
			`Unknown terminal run continuation phase: ${String(phase)}`,
		);
	}
	return phase;
}

export class SqliteRunContinuationStore implements RunContinuationStore {
	private readonly dbFilePath: string;
	private readonly clock: () => Date | number;
	private db: SqliteDb | undefined;
	private closed = false;

	constructor(options: SqliteRunContinuationStoreOptions = {}) {
		this.dbFilePath = options.dbPath ?? defaultDbPath();
		this.clock = options.clock ?? (() => new Date());
	}

	init(): void {
		this.getRawDb();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db?.close?.();
		this.db = undefined;
	}

	private getRawDb(): SqliteDb {
		if (this.closed) throw new RunContinuationClosedError();
		if (this.db) return this.db;
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
				CREATE TABLE IF NOT EXISTS run_continuation_schema_version (
					lock INTEGER PRIMARY KEY CHECK (lock = 1),
					version INTEGER NOT NULL
				);
			`);
			const versionRow = db
				.prepare(
					"SELECT version FROM run_continuation_schema_version WHERE lock = 1",
				)
				.get() as { version: number } | null;
			if (!versionRow) {
				this.createSchema(db);
				db.prepare(
					"INSERT INTO run_continuation_schema_version (lock, version) VALUES (1, ?)",
				).run(SCHEMA_VERSION);
			} else {
				const version = Number(versionRow.version);
				if (!Number.isInteger(version) || version < 1) {
					throw new Error(
						`Invalid run continuation schema version: ${versionRow.version}`,
					);
				}
				if (version > SCHEMA_VERSION) {
					throw new Error(
						`Unsupported run continuation schema version: ${version}`,
					);
				}
				if (version < SCHEMA_VERSION) {
					this.migrateSchema(db, version);
				}
			}
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_run_continuations_recoverable
				ON run_continuations(phase, session_id, created_at);
			`);
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_run_continuations_lease
				ON run_continuations(phase, lease_expires_at);
			`);
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_run_continuations_approval
				ON run_continuations(approval_id);
			`);
		});
	}

	private createSchema(db: SqliteDb): void {
		db.exec(`
			CREATE TABLE IF NOT EXISTS run_continuations (
				continuation_key TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				conversation_id TEXT NOT NULL,
				iteration INTEGER NOT NULL,
				tool_call_index INTEGER NOT NULL,
				tool_call_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				prepared_input_json TEXT NOT NULL,
				prepared_input_hash TEXT NOT NULL,
				assistant_message_id TEXT NOT NULL,
				approval_id TEXT NOT NULL,
				phase TEXT NOT NULL,
				owner_token TEXT,
				lease_started_at TEXT,
				lease_expires_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				terminal_error TEXT,
				terminal_reason TEXT,
				recovery_snapshot_json TEXT,
				run_state_json TEXT,
				agent_chain_json TEXT
			);
		`);
	}

	private migrateSchema(db: SqliteDb, version: number): void {
		if (version < 2) {
			db.exec(
				"ALTER TABLE run_continuations ADD COLUMN recovery_snapshot_json TEXT",
			);
		}
		if (version < 3) {
			db.exec("ALTER TABLE run_continuations ADD COLUMN run_state_json TEXT");
		}
		if (version < 4) {
			db.exec("ALTER TABLE run_continuations ADD COLUMN agent_chain_json TEXT");
		}
		db.prepare(
			"UPDATE run_continuation_schema_version SET version = ? WHERE lock = 1",
		).run(SCHEMA_VERSION);
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

	private nowDate(): Date {
		const value = this.clock();
		const date =
			value instanceof Date ? new Date(value.getTime()) : new Date(value);
		if (!Number.isFinite(date.getTime())) {
			throw new Error("Run continuation clock returned an invalid date");
		}
		return date;
	}

	private currentIso(): string {
		return this.nowDate().toISOString();
	}

	private run(sql: string, params: unknown[] = []): { changes?: number } {
		return this.getRawDb()
			.prepare(sql)
			.run(...params);
	}

	private selectRows(sql: string, params: unknown[] = []): ContinuationRow[] {
		return this.getRawDb()
			.prepare(sql)
			.all(...params) as unknown as ContinuationRow[];
	}

	private getOne(continuationKey: string): ContinuationRow | undefined {
		return this.selectRows(
			"SELECT * FROM run_continuations WHERE continuation_key = ?",
			[continuationKey],
		)[0];
	}

	private requireOne(continuationKey: string): ContinuationRow {
		const row = this.getOne(continuationKey);
		if (!row) throw new RunContinuationNotFoundError(continuationKey);
		return row;
	}

	private leaseDurationMs(value: number | undefined): number {
		const duration = value ?? DEFAULT_RUN_CONTINUATION_LEASE_MS;
		if (!Number.isFinite(duration) || duration <= 0) {
			throw new Error("Run continuation lease duration must be positive");
		}
		return Math.max(1, Math.floor(duration));
	}

	private recordFor(
		row: ContinuationRow | undefined,
		continuationKey: string,
	): RunContinuationRecord {
		if (!row) throw new RunContinuationNotFoundError(continuationKey);
		return rowToRecord(row);
	}

	async createOrUpsert(
		input: CreateRunContinuationInput,
	): Promise<RunContinuationUpsertResult> {
		const normalized = validateCreateInput(input);
		const db = this.getRawDb();
		const now = this.currentIso();
		return this.withTransaction(db, () => {
			const existing = this.getOne(normalized.continuationKey);
			if (existing) {
				assertInputHash(
					existing,
					normalized.preparedInputHash,
					normalized.continuationKey,
				);
				assertIdentity(existing, normalized, normalized.continuationKey);
				if (normalized.recoverySnapshot !== undefined) {
					const serialized = serializeRunRecoverySnapshot(
						normalized.recoverySnapshot,
					);
					if (existing.recovery_snapshot_json === null) {
						this.run(
							`UPDATE run_continuations
							 SET recovery_snapshot_json = ?, updated_at = ?
							 WHERE continuation_key = ? AND recovery_snapshot_json IS NULL`,
							[serialized, now, normalized.continuationKey],
						);
						existing.recovery_snapshot_json = serialized;
					} else {
						assertRecoverySnapshot(
							existing,
							normalized.recoverySnapshot,
							normalized.continuationKey,
						);
					}
				}
				if (normalized.runState !== undefined) {
					const serialized = serializeRunState(normalized.runState);
					if (existing.run_state_json === null) {
						this.run(
							`UPDATE run_continuations
						 SET run_state_json = ?, updated_at = ?
						 WHERE continuation_key = ? AND run_state_json IS NULL`,
							[serialized, now, normalized.continuationKey],
						);
						existing.run_state_json = serialized;
					} else {
						assertRunState(
							existing,
							normalized.runState,
							normalized.continuationKey,
						);
					}
				}
				if (normalized.agentChain !== undefined) {
					// First write wins, matching the recovery-state columns: a
					// re-recorded approval must not silently restate the chain
					// that the durable record was created with.
					const serialized = serializeRunContinuationAgentChain(
						normalized.agentChain,
					);
					if (existing.agent_chain_json === null) {
						this.run(
							`UPDATE run_continuations
						 SET agent_chain_json = ?, updated_at = ?
						 WHERE continuation_key = ? AND agent_chain_json IS NULL`,
							[serialized, now, normalized.continuationKey],
						);
						existing.agent_chain_json = serialized;
					} else if (existing.agent_chain_json !== serialized) {
						throw new RunContinuationIdentityMismatchError(
							"agentChain",
							normalized.continuationKey,
						);
					}
				}
				if (input.phase !== undefined && existing.phase !== normalized.phase) {
					throw new RunContinuationPhaseMismatchError(
						normalized.continuationKey,
						normalized.phase,
						parsePhase(existing.phase),
					);
				}
				return {
					created: false,
					record: this.recordFor(existing, normalized.continuationKey),
				};
			}
			this.run(
				`INSERT INTO run_continuations (
					continuation_key, session_id, run_id, agent_id, conversation_id,
					iteration, tool_call_index, tool_call_id, tool_name,
					prepared_input_json, prepared_input_hash, assistant_message_id,
					approval_id, phase, created_at, updated_at, recovery_snapshot_json,
					run_state_json, agent_chain_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					normalized.continuationKey,
					normalized.sessionId,
					normalized.runId,
					normalized.agentId,
					normalized.conversationId,
					normalized.iteration,
					normalized.toolCallIndex,
					normalized.toolCallId,
					normalized.toolName,
					normalized.preparedInputJson,
					normalized.preparedInputHash,
					normalized.assistantMessageId,
					normalized.approvalId,
					normalized.phase,
					now,
					now,
					normalized.recoverySnapshot
						? serializeRunRecoverySnapshot(normalized.recoverySnapshot)
						: null,
					normalized.runState ? serializeRunState(normalized.runState) : null,
					normalized.agentChain
						? serializeRunContinuationAgentChain(normalized.agentChain)
						: null,
				],
			);
			return {
				created: true,
				record: this.recordFor(
					this.getOne(normalized.continuationKey),
					normalized.continuationKey,
				),
			};
		});
	}

	async upsert(
		input: UpsertRunContinuationInput,
	): Promise<RunContinuationUpsertResult> {
		return this.createOrUpsert(input);
	}

	async create(
		input: CreateRunContinuationInput,
	): Promise<RunContinuationUpsertResult> {
		return this.createOrUpsert(input);
	}

	async get(
		continuationKey: string,
	): Promise<RunContinuationRecord | undefined> {
		assertText(continuationKey, "continuationKey");
		const row = this.getOne(continuationKey);
		return row ? rowToRecord(row) : undefined;
	}

	async listRecoverable(
		sessionId?: string,
		limit?: number,
	): Promise<RunContinuationRecord[]> {
		const placeholders = TERMINAL_PHASES.map(() => "?").join(", ");
		const params: unknown[] = [...TERMINAL_PHASES];
		let sessionClause = "";
		if (sessionId !== undefined) {
			assertText(sessionId, "sessionId");
			sessionClause = " AND session_id = ?";
			params.push(sessionId);
		}
		let limitClause = "";
		if (limit !== undefined) {
			if (!Number.isInteger(limit) || limit <= 0) {
				throw new Error("Run continuation list limit must be positive");
			}
			limitClause = " LIMIT ?";
			params.push(limit);
		}
		const rows = this.selectRows(
			`SELECT * FROM run_continuations
			 WHERE phase NOT IN (${placeholders})${sessionClause}
			 ORDER BY created_at ASC, continuation_key ASC${limitClause}`,
			params,
		);
		return rows.map(rowToRecord);
	}

	async claim(input: ClaimRunContinuationInput): Promise<RunContinuationClaim> {
		assertText(input.continuationKey, "continuationKey");
		if (input.ownerToken !== undefined)
			assertText(input.ownerToken, "ownerToken");
		const db = this.getRawDb();
		const nowDate = this.nowDate();
		const now = nowDate.toISOString();
		const leaseDuration = this.leaseDurationMs(input.leaseDurationMs);
		const leaseExpiresAt = new Date(
			nowDate.getTime() + leaseDuration,
		).toISOString();
		return this.withTransaction(db, () => {
			const existing = this.requireOne(input.continuationKey);
			assertMutationGuards(existing, input, input.continuationKey);
			assertTerminalPhase(parsePhase(existing.phase), input.continuationKey);
			if (
				existing.owner_token !== null &&
				(existing.lease_expires_at === null || existing.lease_expires_at > now)
			) {
				return {
					outcome: "in_progress",
					record: this.recordFor(existing, input.continuationKey),
				} satisfies RunContinuationClaim;
			}
			const ownerToken = input.ownerToken ?? randomUUID();
			const changes =
				this.run(
					`UPDATE run_continuations
					 SET owner_token = ?, lease_started_at = ?, lease_expires_at = ?, updated_at = ?
					 WHERE continuation_key = ?
					   AND phase NOT IN (?, ?, ?, ?)
					   AND (
							owner_token IS NULL
							OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
					   )`,
					[
						ownerToken,
						now,
						leaseExpiresAt,
						now,
						input.continuationKey,
						...TERMINAL_PHASES,
						now,
					],
				).changes ?? 0;
			if (changes !== 1) {
				throw new RunContinuationCollisionError(input.continuationKey);
			}
			const claimed = this.recordFor(
				this.getOne(input.continuationKey),
				input.continuationKey,
			);
			return {
				outcome: "claimed",
				record: claimed,
				lease: {
					continuationKey: input.continuationKey,
					ownerToken,
					leaseStartedAt: now,
					leaseExpiresAt,
				},
			} satisfies RunContinuationClaim;
		});
	}

	async transition(
		input: TransitionRunContinuationInput,
	): Promise<RunContinuationRecord> {
		assertText(input.continuationKey, "continuationKey");
		const target = input.toPhase ?? input.phase;
		if (target === undefined || !isRunContinuationPhase(target)) {
			throw new Error(`Unknown run continuation phase: ${String(target)}`);
		}
		const db = this.getRawDb();
		const now = this.currentIso();
		return this.withTransaction(db, () => {
			const existing = this.requireOne(input.continuationKey);
			assertMutationGuards(existing, input, input.continuationKey);
			const current = parsePhase(existing.phase);
			assertTransitionAllowed(current, target, input.continuationKey);
			assertLease(existing, input.ownerToken, input.continuationKey, now);
			if (current === target) {
				return this.recordFor(existing, input.continuationKey);
			}
			const terminal = isRunContinuationTerminalPhase(target);
			const changes =
				this.run(
					`UPDATE run_continuations
					 SET phase = ?, terminal_error = ?, terminal_reason = ?,
					 owner_token = ?, lease_started_at = ?, lease_expires_at = ?, updated_at = ?
					 WHERE continuation_key = ? AND phase = ?`,
					[
						target,
						terminal ? (input.terminalError ?? null) : null,
						terminal ? (input.terminalReason ?? null) : null,
						terminal ? null : existing.owner_token,
						terminal ? null : existing.lease_started_at,
						terminal ? null : existing.lease_expires_at,
						now,
						input.continuationKey,
						current,
					],
				).changes ?? 0;
			if (changes !== 1) {
				throw new RunContinuationPhaseMismatchError(
					input.continuationKey,
					current,
					target,
				);
			}
			return this.recordFor(
				this.getOne(input.continuationKey),
				input.continuationKey,
			);
		});
	}

	async transitionPhase(
		input: TransitionRunContinuationInput,
	): Promise<RunContinuationRecord> {
		return this.transition(input);
	}

	async closeTerminal(
		input: CloseRunContinuationInput,
	): Promise<RunContinuationRecord> {
		assertText(input.continuationKey, "continuationKey");
		const target = normalizeTerminalPhase(input);
		const db = this.getRawDb();
		const now = this.currentIso();
		return this.withTransaction(db, () => {
			const existing = this.requireOne(input.continuationKey);
			assertMutationGuards(existing, input, input.continuationKey);
			const current = parsePhase(existing.phase);
			if (isRunContinuationTerminalPhase(current)) {
				if (current === target) {
					return this.recordFor(existing, input.continuationKey);
				}
				throw new RunContinuationPhaseMismatchError(
					input.continuationKey,
					current,
					target,
				);
			}
			assertLease(existing, input.ownerToken, input.continuationKey, now);
			const changes =
				this.run(
					`UPDATE run_continuations
					 SET phase = ?, terminal_error = ?, terminal_reason = ?,
					 owner_token = NULL, lease_started_at = NULL, lease_expires_at = NULL,
					 updated_at = ?
					 WHERE continuation_key = ? AND phase = ?`,
					[
						target,
						input.terminalError ?? input.error ?? null,
						input.terminalReason ?? input.reason ?? null,
						now,
						input.continuationKey,
						current,
					],
				).changes ?? 0;
			if (changes !== 1) {
				throw new RunContinuationPhaseMismatchError(
					input.continuationKey,
					current,
					target,
				);
			}
			return this.recordFor(
				this.getOne(input.continuationKey),
				input.continuationKey,
			);
		});
	}

	async complete(
		input: CloseRunContinuationInput,
	): Promise<RunContinuationRecord> {
		return this.closeTerminal(input);
	}

	async cancel(
		input: CancelRunContinuationInput,
	): Promise<RunContinuationRecord> {
		assertText(input.continuationKey, "continuationKey");
		const db = this.getRawDb();
		const now = this.currentIso();
		const reason =
			input.terminalReason ?? input.reason ?? "Continuation cancelled";
		return this.withTransaction(db, () => {
			const existing = this.requireOne(input.continuationKey);
			assertMutationGuards(existing, input, input.continuationKey);
			const current = parsePhase(existing.phase);
			if (current === "cancelled") {
				return this.recordFor(existing, input.continuationKey);
			}
			if (isRunContinuationTerminalPhase(current)) {
				throw new RunContinuationPhaseMismatchError(
					input.continuationKey,
					current,
					"cancelled",
				);
			}
			assertLease(existing, input.ownerToken, input.continuationKey, now);
			const changes =
				this.run(
					`UPDATE run_continuations
					 SET phase = 'cancelled', terminal_error = NULL, terminal_reason = ?,
					 owner_token = NULL, lease_started_at = NULL, lease_expires_at = NULL,
					 updated_at = ?
					 WHERE continuation_key = ? AND phase = ?`,
					[reason, now, input.continuationKey, current],
				).changes ?? 0;
			if (changes !== 1) {
				throw new RunContinuationPhaseMismatchError(
					input.continuationKey,
					current,
					"cancelled",
				);
			}
			return this.recordFor(
				this.getOne(input.continuationKey),
				input.continuationKey,
			);
		});
	}
}
