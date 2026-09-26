import type { EffectLedger, EffectLedgerRecord } from "./effect-ledger";
import { deriveIdempotencyKey } from "./idempotency-key";

function rekeyEffect(
	record: EffectLedgerRecord,
	fromSessionId: string,
	toSessionId: string,
	runId?: string,
): string {
	const prefix = `${fromSessionId}:`;
	const suffix = record.idempotencyKey.slice(prefix.length);
	const segments = suffix.split(":");
	const iterationSegment = record.runId ? undefined : (segments[0] ?? "-");
	const iteration =
		record.iteration ??
		(iterationSegment && /^\d+$/.test(iterationSegment)
			? Number(iterationSegment)
			: undefined);
	const inputHash = record.inputHash ?? segments.at(-1) ?? "none";
	return deriveIdempotencyKey({
		sessionId: toSessionId,
		toolName: record.toolName,
		runId: runId ?? record.runId,
		iteration,
		toolCallIndex:
			record.toolCallIndex ?? (!record.runId && runId ? 0 : undefined),
		inputHash,
	});
}

export interface ReplayEffectsIntoSessionInput {
	fromSessionId: string;
	toSessionId: string;
	runId?: string;
	createdBefore?: string;
}

export interface EffectReplayOutcome {
	replayed: number;
	inDoubt: number;
	skipped: number;
}

export async function replayEffectsIntoSession(
	ledger: EffectLedger,
	input: ReplayEffectsIntoSessionInput,
): Promise<EffectReplayOutcome> {
	const records = await ledger.list(input.fromSessionId);
	const prefix = `${input.fromSessionId}:`;
	let replayed = 0;
	let inDoubt = 0;
	let skipped = 0;
	for (const record of records) {
		if (
			input.runId &&
			record.runId !== input.runId &&
			(record.runId || !input.runId.startsWith("legacy_"))
		) {
			skipped += 1;
			continue;
		}
		if (record.status === "failed") {
			skipped += 1;
			continue;
		}
		if (input.createdBefore && record.createdAt > input.createdBefore) {
			skipped += 1;
			continue;
		}
		if (!record.idempotencyKey.startsWith(prefix)) {
			skipped += 1;
			continue;
		}
		const source: EffectLedgerRecord =
			record.status === "pending"
				? {
						...record,
						status: "in_doubt",
						completedAt: record.completedAt ?? new Date().toISOString(),
						ownerId: undefined,
						leaseExpiresAt: undefined,
						error: "Source effect was pending when recovery started",
					}
				: record;
		const idempotencyKey = rekeyEffect(
			record,
			input.fromSessionId,
			input.toSessionId,
			input.runId,
		);
		const result = await ledger.import({
			idempotencyKey,
			sessionId: input.toSessionId,
			source,
		});
		if (result === "existing") {
			skipped += 1;
		} else if (source.status === "in_doubt") {
			inDoubt += 1;
		} else {
			replayed += 1;
		}
	}
	return { replayed, inDoubt, skipped };
}
