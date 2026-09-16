/**
 * Local sqlite effect ledger — the first `EffectLedger` adapter [roadmap P2-2].
 *
 * Follows the established `SqliteTeamStore`/`SqliteMemoryStore` pattern (WAL,
 * busy_timeout, single-row schema-version table, `loadSqliteDb` from
 * `@cline/shared/db`). The idempotency key is the primary key, so the claim
 * path is a single conditional INSERT: a reader never sees two records for
 * one logical call.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSqliteDb, nowIso, type SqliteDb } from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";
import type {
	EffectLedger,
	EffectLedgerClaim,
	EffectLedgerClaimInput,
	EffectLedgerOutcome,
	EffectLedgerRecord,
} from "../effect-ledger";
import { hashToolInput } from "../idempotency-key";

export interface SqliteEffectLedgerOptions {
	dbPath?: string;
}

interface EffectRow {
	idempotency_key: string;
	session_id: string;
	tool_name: string;
	tool_call_id: string | null;
	input_hash: string | null;
	status: string;
	result_json: string | null;
	error: string | null;
	created_at: string;
	completed_at: string | null;
}

function defaultDbPath(): string {
	return join(resolveDbDataDir(), "effects.db");
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
		toolCallId: row.tool_call_id ?? undefined,
		inputHash: row.input_hash ?? undefined,
		status:
			row.status === "succeeded" || row.status === "failed"
				? row.status
				: "pending",
		result,
		error: row.error ?? undefined,
		createdAt: row.created_at,
		completedAt: row.completed_at ?? undefined,
	};
}

export class SqliteEffectLedger implements EffectLedger {
	private readonly dbFilePath: string;
	private db: SqliteDb | undefined;

	constructor(options: SqliteEffectLedgerOptions = {}) {
		this.dbFilePath = options.dbPath ?? defaultDbPath();
	}

	init(): void {
		this.getRawDb();
	}

	close(): void {
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
		if (this.db) {
			return this.db;
		}
		const db = loadSqliteDb(this.ensureDataDir());
		this.ensureSchema(db);
		this.db = db;
		return db;
	}

	private ensureSchema(db: SqliteDb): void {
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("PRAGMA busy_timeout = 5000;");
		// Single-row table so ALTER-based upgrades can run in order (baseline = 1).
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
			db.prepare(
				"INSERT INTO effect_ledger_schema_version (lock, version) VALUES (1, 1)",
			).run();
		}
		db.exec(`
			CREATE TABLE IF NOT EXISTS effect_ledger (
				idempotency_key TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				tool_call_id TEXT,
				input_hash TEXT,
				status TEXT NOT NULL,
				result_json TEXT,
				error TEXT,
				created_at TEXT NOT NULL,
				completed_at TEXT
			);
		`);
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_effect_ledger_session
				ON effect_ledger(session_id, created_at DESC);
		`);
	}

	private run(sql: string, params: unknown[] = []): void {
		this.getRawDb()
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

	async claim(input: EffectLedgerClaimInput): Promise<EffectLedgerClaim> {
		const existing = this.getOne(input.idempotencyKey);
		if (existing && existing.status === "succeeded") {
			// Replay: the effect already happened; never double-apply.
			return {
				outcome: "replay",
				result: rowToRecord(existing).result,
				record: rowToRecord(existing),
			};
		}
		if (!existing) {
			// Fork: fresh key — record pending, execute, complete.
			this.run(
				`INSERT INTO effect_ledger
					(idempotency_key, session_id, tool_name, tool_call_id, input_hash, status, created_at)
				VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
				[
					input.idempotencyKey,
					input.sessionId,
					input.toolName,
					input.toolCallId ?? null,
					input.input === undefined ? null : hashToolInput(input.input),
					nowIso(),
				],
			);
		}
		// Failed or pending prior record: retry is safe — leave the row for
		// the completion to overwrite (fork semantics).
		return { outcome: "claimed" };
	}

	async complete(
		idempotencyKey: string,
		outcome: EffectLedgerOutcome,
	): Promise<void> {
		this.run(
			`UPDATE effect_ledger
			 SET status = ?, result_json = ?, error = ?, completed_at = ?
			 WHERE idempotency_key = ?`,
			[
				outcome.status,
				outcome.result === undefined ? null : JSON.stringify(outcome.result),
				outcome.error ?? null,
				nowIso(),
				idempotencyKey,
			],
		);
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
