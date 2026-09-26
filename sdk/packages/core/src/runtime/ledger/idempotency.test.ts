import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteDb } from "@cline/shared/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeToolMiddleware } from "../../middleware/tool-middleware";
import {
	EffectLedgerCollisionError,
	type EffectLedgerLease,
	EffectLedgerLeaseLostError,
	EffectLedgerUnavailableError,
} from "./effect-ledger";
import {
	deriveIdempotencyKey,
	deriveIdempotencyKeyFromContext,
	deriveLegacyIdempotencyKey,
	hashToolInput,
} from "./idempotency-key";
import { createIdempotencyMiddleware } from "./idempotency-middleware";
import { SqliteEffectLedger } from "./stores/sqlite-effect-ledger";

describe("hashToolInput", () => {
	it("is deterministic and order-insensitive for object keys", () => {
		expect(hashToolInput({ a: 1, b: 2 })).toBe(hashToolInput({ b: 2, a: 1 }));
		expect(hashToolInput({ a: 1 })).not.toBe(hashToolInput({ a: 2 }));
	});

	it("preserves array order", () => {
		expect(hashToolInput([1, 2])).not.toBe(hashToolInput([2, 1]));
		expect(hashToolInput(["x"])).toBe(hashToolInput(["x"]));
	});

	it("hashes nullish inputs to a stable marker and tolerates unserializable values", () => {
		expect(hashToolInput(undefined)).toBe("none");
		expect(hashToolInput(null)).toBe("none");
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(hashToolInput(circular)).toBe("unserializable");
	});
});

describe("deriveIdempotencyKey", () => {
	it("is deterministic for the same logical call", () => {
		const key = deriveIdempotencyKey({
			sessionId: "s1",
			toolName: "write_file",
			iteration: 3,
			toolCallId: "call-9",
			input: { path: "x", content: "y" },
		});
		const again = deriveIdempotencyKey({
			sessionId: "s1",
			toolName: "write_file",
			iteration: 3,
			toolCallId: "different-provider-call-id",
			input: { content: "y", path: "x" },
		});
		expect(key).toBe(again);
	});

	it("distinguishes distinct calls", () => {
		const base = {
			sessionId: "s1",
			toolName: "write_file",
			iteration: 3,
			toolCallId: "call-9",
			input: { path: "x" },
		};
		expect(deriveIdempotencyKey({ ...base, sessionId: "s2" })).not.toBe(
			deriveIdempotencyKey(base),
		);
		expect(deriveIdempotencyKey({ ...base, input: { path: "z" } })).not.toBe(
			deriveIdempotencyKey(base),
		);
		expect(deriveIdempotencyKey({ ...base, toolName: "read_file" })).not.toBe(
			deriveIdempotencyKey(base),
		);
	});

	it("separates repeated calls by durable run and call ordinal", () => {
		const base = {
			sessionId: "s1",
			toolName: "read_files",
			runId: "run-1",
			iteration: 1,
			toolCallIndex: 0,
			input: { path: "x" },
		};
		expect(deriveIdempotencyKey({ ...base, runId: "run-2" })).not.toBe(
			deriveIdempotencyKey(base),
		);
		expect(deriveIdempotencyKey({ ...base, toolCallIndex: 1 })).not.toBe(
			deriveIdempotencyKey(base),
		);
	});

	it("derives from a middleware context", () => {
		const key = deriveIdempotencyKeyFromContext(
			{
				toolName: "read_file",
				toolCallId: "c1",
				iteration: 1,
				input: { path: "a" },
			},
			"session-1",
		);
		expect(key).toContain("session-1");
		expect(key).toContain("read_file");
	});
});

describe("SqliteEffectLedger", () => {
	let dir: string;
	let now: Date;
	let ledger: SqliteEffectLedger;

	const claimInput = {
		idempotencyKey: "s1:-:write_file:call-1:hash",
		sessionId: "s1",
		toolName: "write_file",
		toolCallId: "call-1",
		stepId: "step:run-1:1:0",
		ownerId: "owner-1",
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-effects-"));
		now = new Date("2026-09-24T00:00:00.000Z");
		ledger = new SqliteEffectLedger({
			dbPath: join(dir, "effects.db"),
			clock: () => now,
		});
		ledger.init();
	});

	afterEach(() => {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function expectClaimed(): Promise<EffectLedgerLease> {
		const claim = await ledger.claim(claimInput);
		expect(claim.outcome).toBe("claimed");
		if (claim.outcome !== "claimed") {
			throw new Error("expected claim");
		}
		return claim.lease;
	}

	it("claims a fresh key and replays the recorded result after success", async () => {
		const lease = await expectClaimed();
		expect(lease).toMatchObject({
			idempotencyKey: claimInput.idempotencyKey,
			ownerId: "owner-1",
		});
		expect(lease.leaseExpiresAt).toBe("2026-09-24T00:05:00.000Z");
		await ledger.complete(lease, {
			status: "succeeded",
			result: { written: true },
		});
		const replay = await ledger.claim(claimInput);
		expect(replay.outcome).toBe("replay");
		if (replay.outcome === "replay") {
			expect(replay.result).toEqual({ written: true });
		}
	});

	it("allows only one active owner and preserves the lease", async () => {
		const lease = await expectClaimed();
		const concurrent = await ledger.claim({
			...claimInput,
			ownerId: "owner-2",
		});
		expect(concurrent.outcome).toBe("in_progress");
		if (concurrent.outcome === "in_progress") {
			expect(concurrent.record.ownerId).toBe("owner-1");
			expect(concurrent.record.leaseExpiresAt).toBe(lease.leaseExpiresAt);
		}
	});

	it("fences completion from a stale attempt", async () => {
		const first = await expectClaimed();
		await ledger.complete(first, { status: "failed", error: "safe failure" });
		const second = await ledger.claim({
			...claimInput,
			ownerId: "owner-2",
		});
		expect(second.outcome).toBe("claimed");
		if (second.outcome !== "claimed") {
			throw new Error("expected second claim");
		}
		await expect(
			ledger.complete(first, { status: "succeeded", result: "stale" }),
		).rejects.toBeInstanceOf(EffectLedgerLeaseLostError);
		expect((await ledger.get(claimInput.idempotencyKey))?.status).toBe(
			"pending",
		);
		await ledger.complete(second.lease, {
			status: "succeeded",
			result: "current",
		});
	});

	it("moves expired pending effects to in_doubt without re-executing them", async () => {
		const lease = await ledger
			.claim({ ...claimInput, leaseDurationMs: 1_000 })
			.then((claim) => {
				if (claim.outcome !== "claimed") throw new Error("expected claim");
				return claim.lease;
			});
		now = new Date("2026-09-24T00:00:01.001Z");
		const recovered = await ledger.claim({
			...claimInput,
			ownerId: "owner-2",
		});
		expect(recovered.outcome).toBe("in_doubt");
		await expect(
			ledger.complete(lease, { status: "succeeded", result: "late" }),
		).rejects.toBeInstanceOf(EffectLedgerLeaseLostError);
		const record = await ledger.get(claimInput.idempotencyKey);
		expect(record?.status).toBe("in_doubt");
		expect(record?.error).toContain("lease expired");
	});

	it("rejects a key reused with different call metadata", async () => {
		await expectClaimed();
		await expect(
			ledger.claim({
				...claimInput,
				ownerId: "owner-2",
				input: { path: "different" },
			}),
		).rejects.toBeInstanceOf(EffectLedgerCollisionError);
	});

	it("records outcomes and attempt metadata for audit", async () => {
		const lease = await ledger
			.claim({
				...claimInput,
				input: { path: "x" },
			})
			.then((claim) => {
				if (claim.outcome !== "claimed") throw new Error("expected claim");
				return claim.lease;
			});
		await ledger.complete(lease, { status: "succeeded", result: 1 });
		const record = await ledger.get(claimInput.idempotencyKey);
		expect(record).toMatchObject({
			status: "succeeded",
			result: 1,
			toolCallId: "call-1",
			stepId: "step:run-1:1:0",
			attempt: 1,
		});
		expect(record?.inputHash).toBe(hashToolInput({ path: "x" }));
		expect(record?.ownerId).toBeUndefined();
		const listed = await ledger.list("s1");
		expect(listed).toHaveLength(1);
		expect(await ledger.list("other")).toHaveLength(0);
	});

	it("persists outcomes across instances", async () => {
		const lease = await expectClaimed();
		await ledger.complete(lease, { status: "succeeded", result: "persisted" });
		ledger.close();
		const reopened = new SqliteEffectLedger({
			dbPath: join(dir, "effects.db"),
			clock: () => now,
		});
		reopened.init();
		const replay = await reopened.claim(claimInput);
		expect(replay.outcome).toBe("replay");
		if (replay.outcome === "replay") {
			expect(replay.result).toBe("persisted");
		}
		reopened.close();
		ledger = new SqliteEffectLedger({
			dbPath: join(dir, "effects.db"),
			clock: () => now,
		});
		ledger.init();
	});

	it("atomically exposes one winner across ledger instances", async () => {
		const other = new SqliteEffectLedger({
			dbPath: join(dir, "effects.db"),
			clock: () => now,
		});
		other.init();
		const outcomes = await Promise.all([
			ledger.claim(claimInput),
			other.claim({ ...claimInput, ownerId: "owner-2" }),
		]);
		expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual([
			"claimed",
			"in_progress",
		]);
		other.close();
	});

	it("upgrades a failed target when recovery imports a known success", async () => {
		const input = {
			...claimInput,
			idempotencyKey: "s1:1:write_file:failed-target",
		};
		const lease = await ledger.claim(input).then((claim) => {
			if (claim.outcome !== "claimed") throw new Error("expected claim");
			return claim.lease;
		});
		await ledger.complete(lease, { status: "failed", error: "safe failure" });
		const failed = await ledger.get(input.idempotencyKey);
		if (!failed) {
			throw new Error("expected source record");
		}
		const source = {
			...failed,
			status: "succeeded" as const,
			result: { written: true },
			completedAt: new Date(now.getTime() + 1).toISOString(),
		};

		await expect(
			ledger.import({
				idempotencyKey: input.idempotencyKey,
				sessionId: input.sessionId,
				source,
			}),
		).resolves.toBe("imported");
		expect(await ledger.get(input.idempotencyKey)).toMatchObject({
			status: "succeeded",
			result: { written: true },
		});
	});

	it("fences an active target owner when recovery imports certainty", async () => {
		const input = {
			...claimInput,
			idempotencyKey: "s1:run:active:write_file:active",
		};
		const targetClaim = await ledger.claim(input);
		if (targetClaim.outcome !== "claimed") {
			throw new Error("expected active claim");
		}
		const pending = await ledger.get(input.idempotencyKey);
		if (!pending) {
			throw new Error("expected pending record");
		}
		await expect(
			ledger.import({
				idempotencyKey: input.idempotencyKey,
				sessionId: input.sessionId,
				source: {
					...pending,
					status: "succeeded",
					result: { recovered: true },
					completedAt: now.toISOString(),
				},
			}),
		).resolves.toBe("imported");
		await expect(
			ledger.complete(targetClaim.lease, { status: "failed" }),
		).rejects.toBeInstanceOf(EffectLedgerLeaseLostError);
		expect(await ledger.get(input.idempotencyKey)).toMatchObject({
			status: "succeeded",
			result: { recovered: true },
		});
	});

	it("does not reopen a closed ledger", async () => {
		ledger.close();
		await expect(ledger.get("missing")).rejects.toThrow("closed");
	});

	it("migrates v1 pending effects to in_doubt", async () => {
		ledger.close();
		const legacyPath = join(dir, "legacy.db");
		const legacy = loadSqliteDb(legacyPath);
		legacy.exec(`
			CREATE TABLE effect_ledger_schema_version (
				lock INTEGER PRIMARY KEY CHECK (lock = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO effect_ledger_schema_version (lock, version) VALUES (1, 1);
			CREATE TABLE effect_ledger (
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
		legacy
			.prepare(
				`INSERT INTO effect_ledger
					(idempotency_key, session_id, tool_name, tool_call_id, input_hash, status, result_json, error, created_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"legacy-pending",
				"s-old",
				"write_file",
				"call-old",
				"hash",
				"pending",
				null,
				null,
				"2026-09-23T00:00:00.000Z",
				null,
			);
		legacy.close?.();
		const migrated = new SqliteEffectLedger({
			dbPath: legacyPath,
			clock: () => now,
		});
		migrated.init();
		const record = await migrated.get("legacy-pending");
		expect(record).toMatchObject({
			status: "in_doubt",
			attempt: 1,
		});
		const claim = await migrated.claim({
			idempotencyKey: "legacy-pending",
			sessionId: "s-old",
			toolName: "write_file",
			toolCallId: "call-old",
			inputHash: "hash",
			ownerId: "owner-2",
		});
		expect(claim.outcome).toBe("in_doubt");
		migrated.close();
		ledger = new SqliteEffectLedger({
			dbPath: join(dir, "effects.db"),
			clock: () => now,
		});
		ledger.init();
	});

	it("adds step identity to a v3 ledger without losing recorded outcomes", async () => {
		ledger.close();
		const legacyPath = join(dir, "v3.db");
		const legacy = loadSqliteDb(legacyPath);
		legacy.exec(`
			CREATE TABLE effect_ledger_schema_version (
				lock INTEGER PRIMARY KEY CHECK (lock = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO effect_ledger_schema_version (lock, version) VALUES (1, 3);
			CREATE TABLE effect_ledger (
				idempotency_key TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				run_id TEXT,
				iteration INTEGER,
				tool_call_id TEXT,
				tool_call_index INTEGER,
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
		legacy
			.prepare(
				`INSERT INTO effect_ledger
					(idempotency_key, session_id, tool_name, run_id, iteration, tool_call_id, tool_call_index, input_hash, status, result_json, error, created_at, completed_at, attempt)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"v3-succeeded",
				"s-old",
				"write_file",
				"run-old",
				1,
				"call-old",
				0,
				"hash",
				"succeeded",
				JSON.stringify({ written: true }),
				null,
				"2026-09-23T00:00:00.000Z",
				"2026-09-23T00:00:01.000Z",
				1,
			);
		legacy.close?.();
		const migrated = new SqliteEffectLedger({
			dbPath: legacyPath,
			clock: () => now,
		});
		migrated.init();
		expect(await migrated.get("v3-succeeded")).toMatchObject({
			status: "succeeded",
			result: { written: true },
			attempt: 1,
		});
		const lease = await migrated
			.claim({
				idempotencyKey: "v3-new",
				sessionId: "s-old",
				toolName: "write_file",
				toolCallId: "call-new",
				stepId: "step:run-old:1:0",
				ownerId: "owner-3",
			})
			.then((claim) => {
				if (claim.outcome !== "claimed") throw new Error("expected claim");
				return claim.lease;
			});
		await migrated.complete(lease, {
			status: "succeeded",
			result: "ok",
		});
		expect(await migrated.get("v3-new")).toMatchObject({
			stepId: "step:run-old:1:0",
		});
		migrated.close();
		ledger = new SqliteEffectLedger({
			dbPath: join(dir, "effects.db"),
			clock: () => now,
		});
		ledger.init();
	});
});

describe("createIdempotencyMiddleware", () => {
	let dir: string;
	let ledger: SqliteEffectLedger;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-effects-mw-"));
		ledger = new SqliteEffectLedger({ dbPath: join(dir, "effects.db") });
		ledger.init();
	});

	afterEach(() => {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const context = {
		toolName: "write_file",
		toolCallId: "call-1",
		iteration: 2,
		input: { path: "x", content: "y" },
	} as const;

	it("executes the first call and records the outcome", async () => {
		const execute = vi.fn(async () => ({ written: true }));
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s1" }),
		]);
		await expect(chain(execute, context)).resolves.toEqual({ written: true });
		expect(execute).toHaveBeenCalledTimes(1);
		const [record] = await ledger.list("s1");
		expect(record?.status).toBe("succeeded");
	});

	it("replays the recorded outcome without executing on recovery", async () => {
		const execute = vi.fn(async () => ({ written: true }));
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s1" }),
		]);
		await chain(execute, context);
		const replayed = await chain(
			vi.fn(async () => "should-not-run"),
			context,
		);
		expect(replayed).toEqual({ written: true });
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("records the stable step identity for a tool call", async () => {
		const execute = vi.fn(async () => ({ written: true }));
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s1" }),
		]);
		await chain(execute, {
			...context,
			runId: "run-1",
			stepId: "step:run-1:2:0",
			toolCallIndex: 0,
		});
		const [record] = await ledger.list("s1");
		expect(record).toMatchObject({
			status: "succeeded",
			stepId: "step:run-1:2:0",
		});
	});

	it("does not replay the same input across different runs or call ordinals", async () => {
		const execute = vi.fn(async () => ({ ok: true }));
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s1" }),
		]);
		await chain(execute, {
			...context,
			runId: "run-1",
			toolCallIndex: 0,
		});
		await chain(execute, {
			...context,
			runId: "run-1",
			toolCallIndex: 1,
		});
		await chain(execute, {
			...context,
			runId: "run-2",
			toolCallIndex: 0,
		});
		expect(execute).toHaveBeenCalledTimes(3);
	});

	it("replays legacy call-id records under the canonical restored key", async () => {
		const legacyKey = deriveLegacyIdempotencyKey({
			sessionId: "s1",
			toolName: context.toolName,
			iteration: context.iteration,
			toolCallId: context.toolCallId,
			input: context.input,
		});
		const claim = await ledger.claim({
			idempotencyKey: legacyKey,
			sessionId: "s1",
			toolName: context.toolName,
			toolCallId: context.toolCallId,
			input: context.input,
			ownerId: "legacy-owner",
		});
		if (claim.outcome !== "claimed") {
			throw new Error("expected legacy claim");
		}
		await ledger.complete(claim.lease, {
			status: "succeeded",
			result: { written: true },
		});
		const execute = vi.fn(async () => "should-not-run");
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s1" }),
		]);

		await expect(chain(execute, context)).resolves.toEqual({ written: true });
		expect(execute).not.toHaveBeenCalled();
		const canonicalKey = deriveIdempotencyKey({
			sessionId: "s1",
			toolName: context.toolName,
			iteration: context.iteration,
			input: context.input,
		});
		expect((await ledger.get(canonicalKey))?.status).toBe("succeeded");
	});

	it("marks an abandoned execution in_doubt when its signal aborts", async () => {
		const controller = new AbortController();
		let resolveExecution: ((value: string) => void) | undefined;
		const execute = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolveExecution = resolve;
				}),
		);
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s1" }),
		]);
		const first = chain(execute, { ...context, signal: controller.signal });
		await vi.waitFor(async () => {
			expect((await ledger.list("s1"))[0]?.status).toBe("pending");
		});
		controller.abort(new Error("tool timed out"));
		resolveExecution?.("late result");
		await expect(first).rejects.toBeInstanceOf(EffectLedgerLeaseLostError);
		await expect(
			chain(
				vi.fn(async () => "should-not-run"),
				{
					...context,
					signal: new AbortController().signal,
				},
			),
		).rejects.toBeInstanceOf(EffectLedgerUnavailableError);
		expect((await ledger.list("s1"))[0]?.status).toBe("in_doubt");
	});

	it("marks thrown execution errors in_doubt by default", async () => {
		const execute = vi.fn(async () => {
			throw new Error("unknown outcome");
		});
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s1" }),
		]);
		await expect(chain(execute, context)).rejects.toThrow("unknown outcome");
		await expect(
			chain(
				vi.fn(async () => "should-not-run"),
				context,
			),
		).rejects.toBeInstanceOf(EffectLedgerUnavailableError);
		expect(execute).toHaveBeenCalledTimes(1);
		expect((await ledger.list("s1"))[0]?.status).toBe("in_doubt");
	});

	it("re-executes only retryable errors explicitly classified as side-effect free", async () => {
		const executions: string[] = [];
		const retryableContext = { ...context, retryable: true };
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({
				ledger,
				sessionId: "s1",
				isSafeToRetry: (error) =>
					error instanceof Error && error.message === "safe failure",
			}),
		]);
		await expect(
			chain(async () => {
				executions.push("first");
				throw new Error("safe failure");
			}, retryableContext),
		).rejects.toThrow("safe failure");
		await expect(
			chain(async () => {
				executions.push("second");
				return "recovered";
			}, retryableContext),
		).resolves.toBe("recovered");
		expect(executions).toEqual(["first", "second"]);
		expect((await ledger.list("s1"))[0]).toMatchObject({
			status: "succeeded",
			attempt: 2,
		});
	});

	it("does not persist unsuccessful structured results as succeeded", async () => {
		const execute = vi.fn(async () => ({ success: false, error: "denied" }));
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s1" }),
		]);
		await expect(chain(execute, context)).resolves.toEqual({
			success: false,
			error: "denied",
		});
		await expect(
			chain(
				vi.fn(async () => "should-not-run"),
				context,
			),
		).rejects.toBeInstanceOf(EffectLedgerUnavailableError);
		expect(execute).toHaveBeenCalledTimes(1);
		expect((await ledger.list("s1"))[0]?.status).toBe("in_doubt");
	});

	it("treats mixed tool-result arrays with a failure as in_doubt", async () => {
		const execute = vi.fn(async () => [
			{ success: true, result: "ok" },
			{ success: false, error: "partial failure" },
		]);
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s1" }),
		]);
		await chain(execute, context);
		expect((await ledger.list("s1"))[0]).toMatchObject({
			status: "in_doubt",
			error: "partial failure",
		});
	});

	it("executes without ledger interaction when no session id resolves", async () => {
		const execute = vi.fn(async () => "ok");
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: () => "" }),
		]);
		await expect(chain(execute, context)).resolves.toBe("ok");
		expect(await ledger.list()).toHaveLength(0);
	});
});
