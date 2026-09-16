/**
 * Local sqlite memory store — the first `MemoryStore` adapter [roadmap P1-1].
 *
 * Follows the established `SqliteTeamStore` pattern (WAL, busy_timeout,
 * single-row schema-version table for ALTER-based upgrades, `loadSqliteDb`
 * from `@cline/shared/db`). One `memory.db` in the shared data dir;
 * project scoping rides the nullable `workspace_path` column.
 *
 * Semantic conflict resolution happens inside a transaction on append:
 * supersede the previous active record with the same subject, then insert
 * the new one, so a reader never sees two active facts for one subject.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSqliteDb, nowIso, type SqliteDb } from "@cline/shared/db";
import { resolveDbDataDir } from "@cline/shared/storage";
import type { MemoryStore } from "../memory-store";
import type {
	EpisodicMemoryInput,
	MemoryQueryFilter,
	MemoryRecord,
	MemoryRecordInput,
	SemanticMemoryInput,
} from "../models/memory-records";

export interface SqliteMemoryStoreOptions {
	dbPath?: string;
}

interface MemoryRow {
	id: string;
	kind: string;
	subtype: string | null;
	title: string | null;
	detail: string | null;
	subject: string | null;
	fact: string | null;
	confidence: number | null;
	tags_json: string | null;
	sources_json: string | null;
	workspace_path: string | null;
	session_id: string | null;
	created_at: string;
	updated_at: string;
	superseded_by_id: string | null;
}

function defaultDbPath(): string {
	return join(resolveDbDataDir(), "memory.db");
}

function parseStringArray(raw: string | null | undefined): string[] {
	if (!raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

function optionalString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function rowToRecord(row: MemoryRow): MemoryRecord | undefined {
	const tags = parseStringArray(row.tags_json);
	if (row.kind === "semantic") {
		return {
			id: row.id,
			kind: "semantic",
			subtype: row.subtype ?? "codebase-fact",
			subject: row.subject ?? "",
			fact: row.fact ?? "",
			confidence:
				typeof row.confidence === "number" && Number.isFinite(row.confidence)
					? row.confidence
					: undefined,
			sources: parseStringArray(row.sources_json),
			workspacePath: optionalString(row.workspace_path),
			tags,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			supersededById: optionalString(row.superseded_by_id),
		};
	}
	if (row.kind === "episodic") {
		return {
			id: row.id,
			kind: "episodic",
			subtype: row.subtype ?? "decision",
			title: row.title ?? "",
			detail: row.detail ?? "",
			workspacePath: optionalString(row.workspace_path),
			sessionId: optionalString(row.session_id),
			tags,
			createdAt: row.created_at,
		};
	}
	// `procedural` and future kinds: no published shape yet, skip the row.
	return undefined;
}

function likeEscape(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export class SqliteMemoryStore implements MemoryStore {
	private readonly dbFilePath: string;
	private db: SqliteDb | undefined;

	constructor(options: SqliteMemoryStoreOptions = {}) {
		this.dbFilePath = options.dbPath ?? defaultDbPath();
	}

	init(): void {
		this.getRawDb();
	}

	/** Closes the underlying connection (tests and graceful shutdown). */
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
			CREATE TABLE IF NOT EXISTS memory_store_schema_version (
				lock INTEGER PRIMARY KEY CHECK (lock = 1),
				version INTEGER NOT NULL
			);
		`);
		const versionRow = db
			.prepare("SELECT version FROM memory_store_schema_version WHERE lock = 1")
			.get() as { version: number } | null;
		if (!versionRow) {
			db.prepare(
				"INSERT INTO memory_store_schema_version (lock, version) VALUES (1, 1)",
			).run();
		}
		db.exec(`
			CREATE TABLE IF NOT EXISTS memory_records (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				subtype TEXT,
				title TEXT,
				detail TEXT,
				subject TEXT,
				fact TEXT,
				confidence REAL,
				tags_json TEXT,
				sources_json TEXT,
				workspace_path TEXT,
				session_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				superseded_by_id TEXT
			);
		`);
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_memory_records_kind_subject
				ON memory_records(kind, subject);
		`);
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_memory_records_workspace
				ON memory_records(workspace_path, created_at DESC);
		`);
	}

	private run(sql: string, params: unknown[] = []): void {
		this.getRawDb()
			.prepare(sql)
			.run(...params);
	}

	private selectRows(sql: string, params: unknown[] = []): MemoryRow[] {
		return this.getRawDb()
			.prepare(sql)
			.all(...params) as unknown as MemoryRow[];
	}

	private getOne(id: string): MemoryRow | undefined {
		const rows = this.selectRows("SELECT * FROM memory_records WHERE id = ?", [
			id,
		]);
		return rows[0];
	}

	append(input: MemoryRecordInput): MemoryRecord {
		const now = nowIso();
		const id = randomUUID();
		const tags = JSON.stringify(input.tags ?? []);
		if (input.kind === "episodic") {
			const episodic = input as EpisodicMemoryInput;
			this.run(
				`INSERT INTO memory_records
					(id, kind, subtype, title, detail, tags_json, workspace_path, session_id, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					"episodic",
					episodic.subtype ?? "decision",
					episodic.title,
					episodic.detail,
					tags,
					episodic.workspacePath ?? null,
					episodic.sessionId ?? null,
					now,
					now,
				],
			);
		} else if (input.kind === "semantic") {
			const semantic = input as SemanticMemoryInput;
			// Supersede the previous active fact on the same subject inside a
			// transaction so a reader never sees two active facts for one key.
			this.getRawDb().exec("BEGIN IMMEDIATE;");
			try {
				this.run(
					`UPDATE memory_records
					 SET superseded_by_id = ?, updated_at = ?
					 WHERE kind = 'semantic'
					   AND subject = ?
					   AND (workspace_path IS ? OR workspace_path = ?)
					   AND superseded_by_id IS NULL`,
					[
						id,
						now,
						semantic.subject,
						semantic.workspacePath ?? null,
						semantic.workspacePath,
					],
				);
				this.run(
					`INSERT INTO memory_records
						(id, kind, subtype, subject, fact, confidence, tags_json, sources_json, workspace_path, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						id,
						"semantic",
						semantic.subtype ?? "codebase-fact",
						semantic.subject,
						semantic.fact,
						typeof semantic.confidence === "number" &&
						Number.isFinite(semantic.confidence)
							? semantic.confidence
							: null,
						tags,
						JSON.stringify(semantic.sources ?? []),
						semantic.workspacePath ?? null,
						now,
						now,
					],
				);
				this.getRawDb().exec("COMMIT;");
			} catch (error) {
				this.getRawDb().exec("ROLLBACK;");
				throw error;
			}
		} else {
			throw new Error(
				`unsupported memory kind: ${String((input as { kind?: unknown }).kind)}`,
			);
		}
		const row = this.getOne(id);
		const record = row ? rowToRecord(row) : undefined;
		if (!record) {
			throw new Error("memory record vanished right after insert");
		}
		return record;
	}

	get(id: string): MemoryRecord | undefined {
		const row = this.getOne(id);
		return row ? rowToRecord(row) : undefined;
	}

	query(filter: MemoryQueryFilter = {}): MemoryRecord[] {
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (filter.kind) {
			clauses.push("kind = ?");
			params.push(filter.kind);
		}
		if (filter.subtypes?.length) {
			clauses.push(`subtype IN (${filter.subtypes.map(() => "?").join(", ")})`);
			params.push(...filter.subtypes);
		}
		if (filter.subject) {
			clauses.push("subject = ?");
			params.push(filter.subject);
		}
		if (filter.workspacePath) {
			clauses.push("workspace_path = ?");
			params.push(filter.workspacePath);
		}
		if (filter.sessionId) {
			clauses.push("session_id = ?");
			params.push(filter.sessionId);
		}
		if (filter.activeOnly !== false) {
			clauses.push("superseded_by_id IS NULL");
		}
		if (filter.keyword?.trim()) {
			const pattern = `%${likeEscape(filter.keyword.trim())}%`;
			clauses.push(
				`(title LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR fact LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\')`,
			);
			params.push(pattern, pattern, pattern, pattern);
		}
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.selectRows(
			// rowid (implicit, monotonic for inserts) breaks same-millisecond
			// created_at ties deterministically; id is a random UUID and must
			// not be an ordering tiebreaker.
			`SELECT * FROM memory_records ${where} ORDER BY created_at DESC, rowid DESC`,
			params,
		);
		const records: MemoryRecord[] = [];
		for (const row of rows) {
			const record = rowToRecord(row);
			if (!record) {
				continue;
			}
			if (filter.tags?.length) {
				const hasAll = filter.tags.every((tag) => record.tags.includes(tag));
				if (!hasAll) {
					continue;
				}
			}
			records.push(record);
			if (filter.limit && records.length >= filter.limit) {
				break;
			}
		}
		return records;
	}
}
