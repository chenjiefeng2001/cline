import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeToolMiddleware } from "../../middleware/tool-middleware";
import {
	deriveIdempotencyKey,
	deriveIdempotencyKeyFromContext,
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
			toolCallId: "call-9",
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
	let ledger: SqliteEffectLedger;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-effects-"));
		ledger = new SqliteEffectLedger({ dbPath: join(dir, "effects.db") });
		ledger.init();
	});

	afterEach(() => {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("claims a fresh key and replays the recorded result after success", async () => {
		const claimInput = {
			idempotencyKey: "s1:-:write_file:call-1:hash",
			sessionId: "s1",
			toolName: "write_file",
			toolCallId: "call-1",
		};
		await expect(ledger.claim(claimInput)).resolves.toEqual({
			outcome: "claimed",
		});
		await ledger.complete(claimInput.idempotencyKey, {
			status: "succeeded",
			result: { written: true },
		});
		const replay = await ledger.claim(claimInput);
		expect(replay.outcome).toBe("replay");
		if (replay.outcome === "replay") {
			expect(replay.result).toEqual({ written: true });
		}
	});

	it("allows retry after a failed call (fork semantics)", async () => {
		const claimInput = {
			idempotencyKey: "s1:-:send_request:call-2:hash",
			sessionId: "s1",
			toolName: "send_request",
			toolCallId: "call-2",
		};
		await ledger.claim(claimInput);
		await ledger.complete(claimInput.idempotencyKey, {
			status: "failed",
			error: "network down",
		});
		await expect(ledger.claim(claimInput)).resolves.toEqual({
			outcome: "claimed",
		});
	});

	it("records outcomes for audit via get/list", async () => {
		const key = "s1:-:write_file:call-3:hash";
		await ledger.claim({
			idempotencyKey: key,
			sessionId: "s1",
			toolName: "write_file",
			toolCallId: "call-3",
			input: { path: "x" },
		});
		await ledger.complete(key, { status: "succeeded", result: 1 });
		const record = await ledger.get(key);
		expect(record?.status).toBe("succeeded");
		expect(record?.result).toBe(1);
		expect(record?.toolCallId).toBe("call-3");
		const listed = await ledger.list("s1");
		expect(listed).toHaveLength(1);
		expect(await ledger.list("other")).toHaveLength(0);
	});

	it("persists across instances (WAL durability)", async () => {
		const key = "s1:-:write_file:call-4:hash";
		await ledger.claim({
			idempotencyKey: key,
			sessionId: "s1",
			toolName: "write_file",
		});
		await ledger.complete(key, { status: "succeeded", result: "persisted" });
		ledger.close();
		const reopened = new SqliteEffectLedger({
			dbPath: join(dir, "effects.db"),
		});
		reopened.init();
		const replay = await reopened.claim({
			idempotencyKey: key,
			sessionId: "s1",
			toolName: "write_file",
		});
		expect(replay.outcome).toBe("replay");
		if (replay.outcome === "replay") {
			expect(replay.result).toBe("persisted");
		}
		reopened.close();
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
		// Recovery: same logical call re-derived, executor must not run again.
		const replayed = await chain(
			vi.fn(async () => "should-not-run"),
			context,
		);
		expect(replayed).toEqual({ written: true });
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("re-executes failed calls and records the error", async () => {
		const executions: string[] = [];
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s1" }),
		]);
		await expect(
			chain(async () => {
				executions.push("first");
				throw new Error("transient failure");
			}, context),
		).rejects.toThrow("transient failure");
		expect(executions).toEqual(["first"]);
		const [record] = await ledger.list("s1");
		expect(record?.status).toBe("failed");
		expect(record?.error).toBe("transient failure");
		// Recovery: failed call has no recorded effect — safe to retry.
		await expect(
			chain(async () => {
				executions.push("second");
				return "recovered";
			}, context),
		).resolves.toBe("recovered");
		expect(executions).toEqual(["first", "second"]);
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
