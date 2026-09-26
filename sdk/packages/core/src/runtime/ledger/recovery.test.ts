import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeToolMiddleware } from "../../middleware/tool-middleware";
import { EffectLedgerUnavailableError } from "./effect-ledger";
import {
	deriveIdempotencyKey,
	deriveLegacyIdempotencyKey,
} from "./idempotency-key";
import { createIdempotencyMiddleware } from "./idempotency-middleware";
import { replayEffectsIntoSession } from "./recovery";
import { SqliteEffectLedger } from "./stores/sqlite-effect-ledger";

describe("replayEffectsIntoSession", () => {
	const sourceRunId = "run-source";
	let dir: string;
	let now: Date;
	let ledger: SqliteEffectLedger;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-recovery-"));
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

	const seedEffect = async (
		sessionId: string,
		toolName: string,
		toolCallId: string,
		result: unknown,
		status: "succeeded" | "failed",
	): Promise<string> => {
		const input = { path: toolName };
		const key = deriveIdempotencyKey({
			sessionId,
			toolName,
			runId: sourceRunId,
			iteration: 1,
			toolCallIndex: 0,
			toolCallId,
			input,
		});
		const claim = await ledger.claim({
			idempotencyKey: key,
			sessionId,
			toolName,
			runId: sourceRunId,
			iteration: 1,
			toolCallId,
			toolCallIndex: 0,
			input,
			ownerId: "seed-owner",
		});
		if (claim.outcome !== "claimed") {
			throw new Error("expected seed claim");
		}
		await ledger.complete(claim.lease, {
			status,
			error: status === "failed" ? "boom" : undefined,
			result: status === "succeeded" ? result : undefined,
		});
		return key;
	};

	const seedPending = async (
		sessionId: string,
		toolName: string,
		toolCallId: string,
	): Promise<string> => {
		const input = { path: toolName };
		const key = deriveIdempotencyKey({
			sessionId,
			toolName,
			runId: sourceRunId,
			iteration: 1,
			toolCallIndex: 0,
			toolCallId,
			input,
		});
		await ledger.claim({
			idempotencyKey: key,
			sessionId,
			toolName,
			runId: sourceRunId,
			iteration: 1,
			toolCallId,
			toolCallIndex: 0,
			input,
			ownerId: "pending-owner",
		});
		return key;
	};

	it("re-keys succeeded effects and skips proven-safe failures", async () => {
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
		expect(outcome).toEqual({ replayed: 1, inDoubt: 0, skipped: 1 });

		const reKeyed = `s-new:${succeededKey.slice("s-old:".length)}`;
		const record = await ledger.get(reKeyed);
		expect(record).toMatchObject({
			status: "succeeded",
			result: { written: true },
			sessionId: "s-new",
			toolCallId: "call-1",
		});
		const failedReKeyed = `s-new:${failedKey.slice("s-old:".length)}`;
		expect(await ledger.get(failedReKeyed)).toBeUndefined();
	});

	it("carries pending and in-doubt effects forward as in-doubt", async () => {
		const pendingKey = await seedPending("s-old", "write_file", "call-pending");
		now = new Date("2026-09-24T00:00:01.000Z");
		const inDoubtKey = deriveIdempotencyKey({
			sessionId: "s-old",
			toolName: "send_request",
			runId: sourceRunId,
			iteration: 1,
			toolCallIndex: 1,
			toolCallId: "call-doubt",
			input: { path: "send_request" },
		});
		const claim = await ledger.claim({
			idempotencyKey: inDoubtKey,
			sessionId: "s-old",
			toolName: "send_request",
			runId: sourceRunId,
			iteration: 1,
			toolCallId: "call-doubt",
			toolCallIndex: 1,
			input: { path: "send_request" },
			ownerId: "doubt-owner",
		});
		if (claim.outcome !== "claimed") {
			throw new Error("expected in-doubt seed claim");
		}
		await ledger.complete(claim.lease, {
			status: "in_doubt",
			error: "connection lost",
		});

		const outcome = await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
		});
		expect(outcome).toEqual({ replayed: 0, inDoubt: 2, skipped: 0 });
		for (const key of [pendingKey, inDoubtKey]) {
			const reKeyed = `s-new:${key.slice("s-old:".length)}`;
			expect((await ledger.get(reKeyed))?.status).toBe("in_doubt");
		}
	});

	it("respects the checkpoint cutoff", async () => {
		const oldKey = await seedEffect(
			"s-old",
			"write_file",
			"call-1",
			1,
			"succeeded",
		);
		const cutoff = now.toISOString();
		now = new Date("2026-09-24T00:00:01.000Z");
		const laterInput = { path: "send_request" };
		const laterKey = deriveIdempotencyKey({
			sessionId: "s-old",
			toolName: "send_request",
			runId: sourceRunId,
			iteration: 2,
			toolCallIndex: 1,
			toolCallId: "call-2",
			input: laterInput,
		});
		const laterClaim = await ledger.claim({
			idempotencyKey: laterKey,
			sessionId: "s-old",
			toolName: "send_request",
			runId: sourceRunId,
			iteration: 2,
			toolCallId: "call-2",
			toolCallIndex: 1,
			input: laterInput,
			ownerId: "later-owner",
		});
		if (laterClaim.outcome !== "claimed") {
			throw new Error("expected later claim");
		}
		await ledger.complete(laterClaim.lease, {
			status: "succeeded",
			result: 2,
		});

		const outcome = await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
			createdBefore: cutoff,
		});
		expect(outcome).toEqual({ replayed: 1, inDoubt: 0, skipped: 1 });
		expect(
			await ledger.get(`s-new:${oldKey.slice("s-old:".length)}`),
		).toBeDefined();
		expect(
			await ledger.get(`s-new:${laterKey.slice("s-old:".length)}`),
		).toBeUndefined();
	});

	it("replays only the restored checkpoint run", async () => {
		const restoredKey = await seedEffect(
			"s-old",
			"write_file",
			"call-restored",
			"restored",
			"succeeded",
		);
		const laterInput = { path: "later" };
		const laterKey = deriveIdempotencyKey({
			sessionId: "s-old",
			toolName: "write_file",
			runId: "run-later",
			iteration: 1,
			toolCallIndex: 0,
			input: laterInput,
		});
		const laterClaim = await ledger.claim({
			idempotencyKey: laterKey,
			sessionId: "s-old",
			toolName: "write_file",
			runId: "run-later",
			iteration: 1,
			toolCallIndex: 0,
			input: laterInput,
			ownerId: "later-run-owner",
		});
		if (laterClaim.outcome !== "claimed") {
			throw new Error("expected later run claim");
		}
		await ledger.complete(laterClaim.lease, {
			status: "succeeded",
			result: "later",
		});

		const outcome = await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
			runId: sourceRunId,
		});

		expect(outcome).toEqual({ replayed: 1, inDoubt: 0, skipped: 1 });
		expect(
			await ledger.get(`s-new:${restoredKey.slice("s-old:".length)}`),
		).toBeDefined();
		expect(
			await ledger.get(`s-new:${laterKey.slice("s-old:".length)}`),
		).toBeUndefined();
	});

	it("replays pre-run-id records under a deterministic legacy scope", async () => {
		const legacyRunId = "legacy_1_checkpoint-ref";
		const input = { path: "legacy" };
		const key = deriveLegacyIdempotencyKey({
			sessionId: "s-old",
			toolName: "write_file",
			iteration: 1,
			toolCallId: "old-provider-call",
			input,
		});
		const claim = await ledger.claim({
			idempotencyKey: key,
			sessionId: "s-old",
			toolName: "write_file",
			toolCallId: "old-provider-call",
			input,
			ownerId: "legacy-owner",
		});
		if (claim.outcome !== "claimed") {
			throw new Error("expected legacy claim");
		}
		await ledger.complete(claim.lease, {
			status: "succeeded",
			result: "legacy-result",
		});
		await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
			runId: legacyRunId,
		});
		const context = {
			toolName: "write_file",
			toolCallId: "regenerated-call",
			toolCallIndex: 0,
			runId: legacyRunId,
			iteration: 1,
			input,
		} as const;
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s-new" }),
		]);

		await expect(chain(async () => "should-not-run", context)).resolves.toBe(
			"legacy-result",
		);
	});

	it("is idempotent", async () => {
		await seedEffect("s-old", "write_file", "call-1", 1, "succeeded");
		const first = await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
		});
		expect(first).toEqual({ replayed: 1, inDoubt: 0, skipped: 0 });
		const second = await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
		});
		expect(second).toEqual({ replayed: 0, inDoubt: 0, skipped: 1 });
	});

	it("makes recovered calls replay through middleware", async () => {
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

		const input = { path: "write_file" };
		const context = {
			toolName: "write_file",
			toolCallId: "regenerated-call-id",
			toolCallIndex: 0,
			runId: sourceRunId,
			iteration: 1,
			input,
		} as const;
		const expectedKey = deriveIdempotencyKey({
			sessionId: "s-new",
			toolName: "write_file",
			runId: sourceRunId,
			iteration: 1,
			toolCallId: "regenerated-call-id",
			toolCallIndex: 0,
			input,
		});
		expect(expectedKey).toBe(`s-new:${key.slice("s-old:".length)}`);

		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s-new" }),
		]);
		await expect(chain(async () => "should-not-run", context)).resolves.toEqual(
			{
				written: true,
			},
		);
	});

	it("blocks recovered in-doubt calls through middleware", async () => {
		const input = { path: "write_file" };
		const key = deriveIdempotencyKey({
			sessionId: "s-old",
			toolName: "write_file",
			runId: sourceRunId,
			iteration: 1,
			toolCallId: "call-1",
			toolCallIndex: 0,
			input,
		});
		const claim = await ledger.claim({
			idempotencyKey: key,
			sessionId: "s-old",
			toolName: "write_file",
			runId: sourceRunId,
			iteration: 1,
			toolCallId: "call-1",
			toolCallIndex: 0,
			input,
			ownerId: "old-owner",
		});
		if (claim.outcome !== "claimed") {
			throw new Error("expected source claim");
		}
		await ledger.complete(claim.lease, {
			status: "in_doubt",
			error: "lost response",
		});
		await replayEffectsIntoSession(ledger, {
			fromSessionId: "s-old",
			toSessionId: "s-new",
		});
		const chain = composeToolMiddleware([
			createIdempotencyMiddleware({ ledger, sessionId: "s-new" }),
		]);
		await expect(
			chain(async () => "should-not-run", {
				toolName: "write_file",
				toolCallId: "call-1",
				toolCallIndex: 0,
				runId: sourceRunId,
				iteration: 1,
				input,
			}),
		).rejects.toBeInstanceOf(EffectLedgerUnavailableError);
	});
});
