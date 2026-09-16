/**
 * Effect-ledger recovery — replay-or-fork across session restore [P2-2
 * wiring, roadmap].
 *
 * Gap D1: checkpoint ≠ 断点续跑 — restore rebuilds the conversation but tool
 * side effects are outside the recovery semantics. This module completes the
 * durable-execution story: after a restore creates a new session id, the
 * source session's *succeeded* effect records are re-keyed into the new
 * session, so the idempotency middleware in the recovered session replays
 * the recorded outcomes instead of double-applying effects. Failed records
 * are skipped (no recorded effect — re-execution is safe, per the ledger's
 * fork semantics).
 */

import type { EffectLedger } from "./effect-ledger";

export interface ReplayEffectsIntoSessionInput {
	/** Source session whose effects are replayed. */
	fromSessionId: string;
	/** Recovered session receiving the re-keyed records. */
	toSessionId: string;
	/**
	 * Only replay effects created at/before this ISO timestamp (e.g. the
	 * checkpoint cutoff). When absent, all succeeded effects are replayed.
	 */
	createdBefore?: string;
}

export interface EffectReplayOutcome {
	/** Succeeded effects re-keyed into the recovered session. */
	replayed: number;
	/** Records skipped: failed (re-executable) or already present. */
	skipped: number;
}

/**
 * Re-keys the source session's succeeded effect records into the recovered
 * session so the idempotency middleware replays them. The key prefix swap
 * (`<fromSessionId>:...` → `<toSessionId>:...`) preserves the deterministic
 * derivation (iteration/tool/toolCallId/inputHash segments untouched).
 */
export async function replayEffectsIntoSession(
	ledger: EffectLedger,
	input: ReplayEffectsIntoSessionInput,
): Promise<EffectReplayOutcome> {
	const records = await ledger.list(input.fromSessionId);
	const prefix = `${input.fromSessionId}:`;
	let replayed = 0;
	let skipped = 0;
	for (const record of records) {
		if (record.status !== "succeeded") {
			// Failed effects have no recorded side effect — re-execution is safe.
			skipped += 1;
			continue;
		}
		if (input.createdBefore && record.createdAt > input.createdBefore) {
			// Effect postdates the checkpoint cutoff — it belongs to work the
			// recovered session will redo naturally.
			skipped += 1;
			continue;
		}
		if (!record.idempotencyKey.startsWith(prefix)) {
			skipped += 1;
			continue;
		}
		const reKeyed = `${input.toSessionId}:${record.idempotencyKey.slice(prefix.length)}`;
		const existing = await ledger.get(reKeyed);
		if (existing && existing.status === "succeeded") {
			skipped += 1;
			continue;
		}
		await ledger.claim({
			idempotencyKey: reKeyed,
			sessionId: input.toSessionId,
			toolName: record.toolName,
			toolCallId: record.toolCallId,
		});
		await ledger.complete(reKeyed, {
			status: "succeeded",
			result: record.result,
		});
		replayed += 1;
	}
	return { replayed, skipped };
}
