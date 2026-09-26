import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSqliteDb, type SqliteDb } from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";
import {
	DEFAULT_EFFECT_LEASE_MS,
	type EffectLedger,
	type EffectLedgerClaim,
	type EffectLedgerClaimInput,
	EffectLedgerCollisionError as EffectLedgerCollisionErrorClass,
	type EffectLedgerImportInput,
	type EffectLedgerImportResult,
	type EffectLedgerLease,
	EffectLedgerLeaseLostError,
	type EffectLedgerOutcome,
	type EffectLedgerRecord,
	type EffectLedgerStatus,
} from "../effect-ledger";
import { hashToolInput } from "../idempotency-key";

const SCHEMA_VERSION = 4;

export interface SqliteEffectLedgerOptions {
	dbPath?: string;
	clock?: () => Date;
}

interface EffectRow {
	idempotency_key: string;
	session_id: string;
	tool_name: string;
	run_id: string | null;
	iteration: number | null;
	tool_call_id: string | null;
	tool_call_index: number | null;
	step_id: string | null;
	input_hash: string | null;
	status: string;
	result_json: string | null;
	error: string | null;
	created_at: string;
	completed_at: string | null;
	attempt: number;
	owner_id: string | null;
	lease_token: string | null;
	lease_expires_at: string | null;
}

function defaultDbPath(): string {
	return join(resolveDbDataDir(), "effects.db");
}

function parseStatus(value: string): EffectLedgerStatus {
	if (
		value === "pending" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "in_doubt"
	) {
		return value;
	}
	throw new Error(`Unknown effect ledger status: ${value}`);
}

function rowToRecord(row: EffectRow): EffectLedgerRecord {
	let result: unknown;
	if (row.result_json) {
		try {
			result = JSON.parse(row.result_json);
		} catch {
			result = undefined;
		}
	}
	return {
		idempotencyKey: row.idempotency_key,
		sessionId: row.session_id,
		toolName: row.tool_name,
		runId: row.run_id ?? undefined,
		iteration: row.iteration ?? undefined,
		toolCallId: row.tool_call_id ?? undefined,
		toolCallIndex: row.tool_call_index ?? undefined,
		stepId: row.step_id ?? undefined,
		inputHash: row.input_hash ?? undefined,
		status: parseStatus(row.status),
		result,
		error: row.error ?? undefined,
		createdAt: row.created_at,
		completedAt: row.completed_at ?? undefined,
		attempt: row.attempt,
		ownerId: row.owner_id ?? undefined,
		leaseExpiresAt: row.lease_expires_at ?? undefined,
	};
}

export class SqliteEffectLedger implements EffectLedger {
	private readonly dbFilePath: string;
	private readonly clock: () => Date;
	private db: SqliteDb | undefined;
	private closed = false;

	constructor(options: SqliteEffectLedgerOptions = {}) {
		this.dbFilePath = options.dbPath ?? defaultDbPath();
		this.clock = options.clock ?? (() => new Date());
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

	private ensureDataDir(): string {
		if (!existsSync(this.dbFilePath)) {
			mkdirSync(join(this.dbFilePath, ".."), { recursive: true });
		}
		return this.dbFilePath;
	}

	private getRawDb(): SqliteDb {
		if (this.closed) {
			throw new Error("Effect ledger is closed");
		}
		if (this.db) {
			return this.db;
		}
		const db = loadSqliteDb(this.ensureDataDir());
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
				CREATE TABLE IF NOT EXISTS effect_ledger_schema_version (
					lock INTEGER PRIMARY KEY CHECK (lock = 1),
					version INTEGER NOT NULL
				);
			`);
			const versionRow = db
				.prepare(
					"SELECT version FROM effect_ledger_schema_version WHERE lock = 1",
				)
				.get() as { version: number } | null;
			if (!versionRow) {
				this.createSchema(db);
				db.prepare(
					"INSERT INTO effect_ledger_schema_version (lock, version) VALUES (1, ?)",
				).run(SCHEMA_VERSION);
			} else {
				const version = Number(versionRow.version);
				if (!Number.isInteger(version) || version < 1) {
					throw new Error(
						`Invalid effect ledger schema version: ${versionRow.version}`,
					);
				}
				if (version > SCHEMA_VERSION) {
					throw new Error(
						`Unsupported effect ledger schema version: ${version}`,
					);
				}
				if (version === 1) {
					this.migrateSchema(db);
				}
				if (version <= 2) {
					this.migrateRunMetadataSchema(db);
				}
				if (version < 4) {
					this.migrateStepIdentitySchema(db);
				}
				if (version < SCHEMA_VERSION) {
					db.prepare(
						"UPDATE effect_ledger_schema_version SET version = ? WHERE lock = 1",
					).run(SCHEMA_VERSION);
				}
			}
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_effect_ledger_session
					ON effect_ledger(session_id, created_at DESC);
			`);
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_effect_ledger_lease
					ON effect_ledger(status, lease_expires_at);
			`);
		});
	}

	private createSchema(db: SqliteDb): void {
		db.exec(`
			CREATE TABLE IF NOT EXISTS effect_ledger (
				idempotency_key TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				run_id TEXT,
				iteration INTEGER,
				tool_call_id TEXT,
				tool_call_index INTEGER,
				step_id TEXT,
				input_hash TEXT,
				status TEXT NOT NULL,
				result_json TEXT,
				error TEXT,
				created_at TEXT NOT NULL,
				completed_at TEXT,
				attempt INTEGER NOT NULL DEFAULT 1,
				owner_id TEXT,
				lease_token TEXT,
				lease_expires_at TEXT
			);
		`);
	}

	private migrateSchema(db: SqliteDb): void {
		db.exec(`
			ALTER TABLE effect_ledger ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
			ALTER TABLE effect_ledger ADD COLUMN owner_id TEXT;
			ALTER TABLE effect_ledger ADD COLUMN lease_token TEXT;
			ALTER TABLE effect_ledger ADD COLUMN lease_expires_at TEXT;
		`);
		db.prepare(
			`UPDATE effect_ledger
				SET status = 'in_doubt',
					completed_at = COALESCE(completed_at, ?),
					error = COALESCE(error, 'Effect lease unavailable after upgrade')
				WHERE status = 'pending'`,
		).run(this.currentIso());
	}

	private migrateRunMetadataSchema(db: SqliteDb): void {
		db.exec(`
			ALTER TABLE effect_ledger ADD COLUMN run_id TEXT;
			ALTER TABLE effect_ledger ADD COLUMN iteration INTEGER;
			ALTER TABLE effect_ledger ADD COLUMN tool_call_index INTEGER;
		`);
	}

	private migrateStepIdentitySchema(db: SqliteDb): void {
		db.exec("ALTER TABLE effect_ledger ADD COLUMN step_id TEXT");
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

	private currentIso(): string {
		return this.clock().toISOString();
	}

	private leaseDurationMs(value: number | undefined): number {
		if (value === undefined) {
			return DEFAULT_EFFECT_LEASE_MS;
		}
		if (!Number.isFinite(value) || value <= 0) {
			throw new Error("Effect lease duration must be a positive number");
		}
		return Math.floor(value);
	}

	private run(sql: string, params: unknown[] = []): { changes?: number } {
		return this.getRawDb()
			.prepare(sql)
			.run(...params);
	}

	private selectRows(sql: string, params: unknown[] = []): EffectRow[] {
		return this.getRawDb()
			.prepare(sql)
			.all(...params) as unknown as EffectRow[];
	}

	private getOne(idempotencyKey: string): EffectRow | undefined {
		const rows = this.selectRows(
			"SELECT * FROM effect_ledger WHERE idempotency_key = ?",
			[idempotencyKey],
		);
		return rows[0];
	}

	private serializeResult(result: unknown): string | null {
		return result === undefined ? null : (JSON.stringify(result) ?? null);
	}

	private resolveInputHash(input: EffectLedgerClaimInput): string | undefined {
		if (input.inputHash !== undefined && input.input !== undefined) {
			throw new Error(
				"Effect ledger claim accepts input or inputHash, not both",
			);
		}
		if (input.inputHash !== undefined) {
			return input.inputHash;
		}
		return input.input === undefined ? undefined : hashToolInput(input.input);
	}

	private assertCompatible(
		existing: EffectRow,
		idempotencyKey: string,
		sessionId: string,
		toolName: string,
		inputHash: string | undefined,
		stepId: string | undefined,
	): void {
		if (
			existing.session_id !== sessionId ||
			existing.tool_name !== toolName ||
			(existing.input_hash ?? undefined) !== inputHash ||
			(existing.step_id !== null && existing.step_id !== (stepId ?? null))
		) {
			throw new EffectLedgerCollisionErrorClass(idempotencyKey);
		}
	}

	private expireLease(idempotencyKey: string, now: string): void {
		this.run(
			`UPDATE effect_ledger
			 SET status = 'in_doubt',
					completed_at = ?,
					owner_id = NULL,
					lease_token = NULL,
					lease_expires_at = NULL,
					error = COALESCE(error, 'Effect lease expired before completion')
				WHERE idempotency_key = ?
				  AND status = 'pending'
				  AND lease_expires_at IS NOT NULL
				  AND lease_expires_at <= ?`,
			[now, idempotencyKey, now],
		);
	}

	async claim(input: EffectLedgerClaimInput): Promise<EffectLedgerClaim> {
		const db = this.getRawDb();
		const now = this.currentIso();
		const inputHash = this.resolveInputHash(input);
		const leaseDurationMs = this.leaseDurationMs(input.leaseDurationMs);
		return this.withTransaction(db, () => {
			const existing = this.getOne(input.idempotencyKey);
			if (!existing) {
				const leaseToken = randomUUID();
				const leaseExpiresAt = new Date(
					this.clock().getTime() + leaseDurationMs,
				).toISOString();
				this.run(
					`INSERT INTO effect_ledger
						(idempotency_key, session_id, tool_name, run_id, iteration,
						 tool_call_id, tool_call_index, step_id, input_hash, status, created_at,
						 attempt, owner_id, lease_token, lease_expires_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?)`,
					[
						input.idempotencyKey,
						input.sessionId,
						input.toolName,
						input.runId ?? null,
						input.iteration ?? null,
						input.toolCallId ?? null,
						input.toolCallIndex ?? null,
						input.stepId ?? null,
						inputHash ?? null,
						now,
						input.ownerId,
						leaseToken,
						leaseExpiresAt,
					],
				);
				const claimed = this.getOne(input.idempotencyKey);
				if (!claimed) {
					throw new Error("Effect ledger record vanished after claim");
				}
				return {
					outcome: "claimed",
					lease: {
						idempotencyKey: input.idempotencyKey,
						ownerId: input.ownerId,
						leaseToken,
						leaseExpiresAt,
					},
				} satisfies EffectLedgerClaim;
			}
			this.assertCompatible(
				existing,
				input.idempotencyKey,
				input.sessionId,
				input.toolName,
				inputHash,
				input.stepId,
			);
			if (existing.status === "succeeded") {
				const record = rowToRecord(existing);
				return { outcome: "replay", result: record.result, record };
			}
			if (existing.status === "in_doubt") {
				return { outcome: "in_doubt", record: rowToRecord(existing) };
			}
			if (existing.status === "pending") {
				if (!existing.lease_expires_at || existing.lease_expires_at <= now) {
					this.run(
						`UPDATE effect_ledger
						 SET status = 'in_doubt',
							 completed_at = ?,
							 owner_id = NULL,
							 lease_token = NULL,
							 lease_expires_at = NULL,
							 error = COALESCE(error, 'Effect lease expired before completion')
						 WHERE idempotency_key = ?`,
						[now, input.idempotencyKey],
					);
					const inDoubt = this.getOne(input.idempotencyKey);
					if (!inDoubt) {
						throw new Error("Effect ledger record vanished while expiring");
					}
					return {
						outcome: "in_doubt",
						record: rowToRecord(inDoubt),
					};
				}
				return {
					outcome: "in_progress",
					record: rowToRecord(existing),
				};
			}
			const leaseToken = randomUUID();
			const leaseExpiresAt = new Date(
				this.clock().getTime() + leaseDurationMs,
			).toISOString();
			this.run(
				`UPDATE effect_ledger
				 SET status = 'pending',
					 result_json = NULL,
					 error = NULL,
					 completed_at = NULL,
					 attempt = attempt + 1,
					 step_id = COALESCE(step_id, ?),
					 owner_id = ?,
					 lease_token = ?,
					 lease_expires_at = ?
				 WHERE idempotency_key = ? AND status = 'failed'`,
				[
					input.stepId ?? null,
					input.ownerId,
					leaseToken,
					leaseExpiresAt,
					input.idempotencyKey,
				],
			);
			return {
				outcome: "claimed",
				lease: {
					idempotencyKey: input.idempotencyKey,
					ownerId: input.ownerId,
					leaseToken,
					leaseExpiresAt,
				},
			} satisfies EffectLedgerClaim;
		});
	}

	async renew(
		lease: EffectLedgerLease,
		leaseDurationMs = DEFAULT_EFFECT_LEASE_MS,
	): Promise<void> {
		const db = this.getRawDb();
		const now = this.currentIso();
		const duration = this.leaseDurationMs(leaseDurationMs);
		this.withTransaction(db, () => {
			this.expireLease(lease.idempotencyKey, now);
			const changes = this.run(
				`UPDATE effect_ledger
				 SET lease_expires_at = ?
				 WHERE idempotency_key = ?
				   AND status = 'pending'
				   AND owner_id = ?
				   AND lease_token = ?`,
				[
					new Date(this.clock().getTime() + duration).toISOString(),
					lease.idempotencyKey,
					lease.ownerId,
					lease.leaseToken,
				],
			).changes;
			if (changes !== 1) {
				throw new EffectLedgerLeaseLostError(lease.idempotencyKey);
			}
		});
	}

	async complete(
		lease: EffectLedgerLease,
		outcome: EffectLedgerOutcome,
	): Promise<void> {
		const db = this.getRawDb();
		const now = this.currentIso();
		this.withTransaction(db, () => {
			this.expireLease(lease.idempotencyKey, now);
			const changes = this.run(
				`UPDATE effect_ledger
				 SET status = ?,
					 result_json = ?,
					 error = ?,
					 completed_at = ?,
					 owner_id = NULL,
					 lease_token = NULL,
					 lease_expires_at = NULL
				 WHERE idempotency_key = ?
				   AND status = 'pending'
				   AND owner_id = ?
				   AND lease_token = ?`,
				[
					outcome.status,
					this.serializeResult(outcome.result),
					outcome.error ?? null,
					now,
					lease.idempotencyKey,
					lease.ownerId,
					lease.leaseToken,
				],
			).changes;
			if (changes !== 1) {
				throw new EffectLedgerLeaseLostError(lease.idempotencyKey);
			}
		});
	}

	async import(
		input: EffectLedgerImportInput,
	): Promise<EffectLedgerImportResult> {
		if (
			input.source.status !== "succeeded" &&
			input.source.status !== "in_doubt"
		) {
			throw new Error(
				`Cannot import effect ledger status: ${input.source.status}`,
			);
		}
		const db = this.getRawDb();
		const now = this.currentIso();
		return this.withTransaction(db, () => {
			const existing = this.getOne(input.idempotencyKey);
			if (existing) {
				this.assertCompatible(
					existing,
					input.idempotencyKey,
					input.sessionId,
					input.source.toolName,
					input.source.inputHash,
					input.source.stepId,
				);
				let current = existing;
				if (
					current.status === "pending" &&
					(!current.lease_expires_at || current.lease_expires_at <= now)
				) {
					this.run(
						`UPDATE effect_ledger
						 SET status = 'in_doubt',
							 completed_at = ?,
							 owner_id = NULL,
							 lease_token = NULL,
							 lease_expires_at = NULL,
							 error = COALESCE(error, 'Effect lease expired before import')
						 WHERE idempotency_key = ?`,
						[now, input.idempotencyKey],
					);
					current = this.getOne(input.idempotencyKey) ?? current;
				}
				if (current.status === "succeeded") {
					return "existing";
				}
				if (
					current.status === "in_doubt" &&
					input.source.status !== "succeeded"
				) {
					return "existing";
				}
				this.run(
					`UPDATE effect_ledger
					 SET status = ?,
						 result_json = ?,
						 error = ?,
						 completed_at = ?,
						 step_id = COALESCE(step_id, ?),
						 owner_id = NULL,
						 lease_token = NULL,
						 lease_expires_at = NULL
					 WHERE idempotency_key = ?`,
					[
						input.source.status,
						this.serializeResult(input.source.result),
						input.source.error ?? null,
						input.source.completedAt ?? now,
						input.source.stepId ?? null,
						input.idempotencyKey,
					],
				);
				return "imported";
			}
			this.run(
				`INSERT INTO effect_ledger
					(idempotency_key, session_id, tool_name, run_id, iteration,
					 tool_call_id, tool_call_index, step_id, input_hash, status, result_json,
					 error, created_at, completed_at, attempt)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					input.idempotencyKey,
					input.sessionId,
					input.source.toolName,
					input.source.runId ?? null,
					input.source.iteration ?? null,
					input.source.toolCallId ?? null,
					input.source.toolCallIndex ?? null,
					input.source.stepId ?? null,
					input.source.inputHash ?? null,
					input.source.status,
					this.serializeResult(input.source.result),
					input.source.error ?? null,
					input.source.createdAt,
					input.source.completedAt ?? now,
					input.source.attempt,
				],
			);
			return "imported";
		});
	}

	async get(idempotencyKey: string): Promise<EffectLedgerRecord | undefined> {
		const row = this.getOne(idempotencyKey);
		return row ? rowToRecord(row) : undefined;
	}

	async list(sessionId?: string): Promise<EffectLedgerRecord[]> {
		const rows = sessionId
			? this.selectRows(
					"SELECT * FROM effect_ledger WHERE session_id = ? ORDER BY created_at DESC",
					[sessionId],
				)
			: this.selectRows("SELECT * FROM effect_ledger ORDER BY created_at DESC");
		return rows.map(rowToRecord);
	}
}
