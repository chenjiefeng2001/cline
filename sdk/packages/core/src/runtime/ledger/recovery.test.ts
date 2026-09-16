import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeToolMiddleware } from "../../middleware/tool-middleware";
import { deriveIdempotencyKey } from "./idempotency-key";
import { createIdempotencyMiddleware } from "./idempotency-middleware";
import { replayEffectsIntoSession } from "./recovery";
import { SqliteEffectLedger } from "./stores/sqlite-effect-ledger";

describe("replayEffectsIntoSession", () => {
	let dir: string;
	let ledger: SqliteEffectLedger;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-recovery-"));
		ledger = new SqliteEffectLedger({ dbPath: join(dir, "effects.db") });
		ledger.init();
	});

	afterEach(() => {
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const seedEffect = async (
		sessionId: string,
		toolName: string,
		toolCallId: string,
		result: unknown,
		status: "succeeded" | "failed",
	) => {
		const key = deriveIdempotencyKey({
			sessionId,
			toolName,
			iteration: 1,
			toolCallId,
			input: { toolCallId },
		});
		await ledger.claim({
			idempotencyKey: key,
			sessionId,
			toolName,
			toolCallId,
		});
		if (status === "failed") {
			await ledger.complete(key, { status: "failed", error: "boom" });
		} else {
			await ledger.complete(key, { status: "succeeded", result });
		}
		return key;
	};

	it("re-keys succeeded effects into the recovered session and skips failed ones", async () => {
		const succeededKey = await seedEffect(
			"s-old",
			"write_file",
			"call-1",
			{ written: true },
			"succeeded",
		);
		const failedKey = await seedEffect(
			"s-old",
			"send_request",
			"call-2",
			undefined,
			"failed",
		);

		const outcome = await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
		});
		expect(outcome.replayed).toBe(1);
		expect(outcome.skipped).toBe(1);

		// The re-keyed record replays in the recovered session.
		const reKeyed = `${"s-new"}:${succeededKey.slice("s-old:".length)}`;
		const record = await ledger.get(reKeyed);
		expect(record?.status).toBe("succeeded");
		expect(record?.result).toEqual({ written: true });
		expect(record?.sessionId).toBe("s-new");
		expect(record?.toolCallId).toBe("call-1");

		// The failed record is NOT copied — re-execution is safe.
		const failedReKeyed = `${"s-new"}:${failedKey.slice("s-old:".length)}`;
		expect(await ledger.get(failedReKeyed)).toBeUndefined();
	});

	it("respects the checkpoint cutoff (createdBefore)", async () => {
		const oldKey = await seedEffect(
			"s-old",
			"write_file",
			"call-1",
			1,
			"succeeded",
		);
		const record = await ledger.get(oldKey);
		const cutoff = record?.createdAt ?? new Date().toISOString();

		// An effect created after the cutoff.
		const laterKey = deriveIdempotencyKey({
			sessionId: "s-old",
			toolName: "send_request",
			iteration: 2,
			toolCallId: "call-2",
			input: { toolCallId: "call-2" },
		});
		await ledger.claim({
			idempotencyKey: laterKey,
			sessionId: "s-old",
			toolName: "send_request",
			toolCallId: "call-2",
		});
		await ledger.complete(laterKey, { status: "succeeded", result: 2 });
		// Bump its createdAt beyond the cutoff.
		await ledger.complete(laterKey, { status: "succeeded", result: 2 });

		const outcome = await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
			createdBefore: cutoff,
		});
		expect(outcome.replayed).toBeGreaterThanOrEqual(1);
		// The later effect stays out of the replay plan.
		const laterReKeyed = `${"s-new"}:${laterKey.slice("s-old:".length)}`;
		expect(await ledger.get(laterReKeyed)).toBeUndefined();
	});

	it("is idempotent — replaying twice skips already-present records", async () => {
		await seedEffect("s-old", "write_file", "call-1", 1, "succeeded");
		const first = await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
		});
		expect(first.replayed).toBe(1);
		const second = await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
		});
		expect(second.replayed).toBe(0);
		expect(second.skipped).toBe(1);
	});

	it("wires into the idempotency middleware: the recovered session replays instead of double-applying", async () => {
		const key = await seedEffect(
			"s-old",
			"write_file",
			"call-1",
			{ written: true },
			"succeeded",
		);
		await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
		});

		// The recovered session's middleware derives the same logical key.
		const context = {
			toolName: "write_file",
			toolCallId: "call-1",
			iteration: 1,
			input: { toolCallId: "call-1" },
		} as const;
		const expectedKey = deriveIdempotencyKey({
			sessionId: "s-new",
			toolName: "write_file",
			iteration: 1,
			toolCallId: "call-1",
			input: { toolCallId: "call-1" },
		});
		expect(expectedKey).toBe(`${"s-new"}:${key.slice("s-old:".length)}`);

		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s-new" }),
		]);
		const replayed = await chain(async () => "should-not-run", context);
		expect(replayed).toEqual({ written: true });
	});
});
