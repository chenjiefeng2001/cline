/**
 * Tool side-effect ledger — exactly-once at the tool boundary [roadmap P2-2].
 *
 * Gap D1: checkpoint ≠ 断点续跑 — restore rebuilds the conversation from
 * message history, but tool side effects (requests sent, resources created)
 * are outside the recovery semantics, and ACRFence notes that *no* framework
 * (LangGraph/Claude Code/Cursor/ADK included) enforces exactly-once at the
 * tool boundary — recovered runs can double-apply effects.
 *
 * The hub bus already records every command envelope; this ledger completes
 * the picture: one idempotency-keyed record per tool call, so recovery can
 * **replay** the recorded outcome (succeeded calls — no double-apply) or
 * **fork** into normal execution (failed calls — no recorded effect, retry
 * is safe). The enforcement point is the idempotency middleware
 * (`../middleware` chain); backends implement this contract — the first
 * adapter is the local sqlite store (`stores/sqlite-effect-ledger.ts`).
 */

export type EffectLedgerStatus = "pending" | "succeeded" | "failed";

export interface EffectLedgerRecord {
	/** Deterministic idempotency key (see deriveIdempotencyKey). */
	idempotencyKey: string;
	sessionId: string;
	toolName: string;
	toolCallId?: string;
	/** Stable hash of the call input for collision checks. */
	inputHash?: string;
	status: EffectLedgerStatus;
	/** Recorded outcome for replay (succeeded calls). */
	result?: unknown;
	error?: string;
	createdAt: string;
	completedAt?: string;
}

export interface EffectLedgerClaimInput {
	idempotencyKey: string;
	sessionId: string;
	toolName: string;
	toolCallId?: string;
	/** Call input; hashed for collision checks, not stored verbatim. */
	input?: unknown;
}

/** Outcome of claiming an idempotency key. */
export type EffectLedgerClaim =
	| {
			/** Key is new (or the prior call failed) — execute and complete. */
			outcome: "claimed";
	  }
	| {
			/** A succeeded call already holds this key — replay its result. */
			outcome: "replay";
			result?: unknown;
			record: EffectLedgerRecord;
	  };

export interface EffectLedgerOutcome {
	status: Exclude<EffectLedgerStatus, "pending">;
	result?: unknown;
	error?: string;
}

export interface EffectLedger {
	init(): Promise<void> | void;
	/**
	 * Atomically claims an idempotency key: inserts a pending record when the
	 * key is new or the prior call failed (fork/retry), and replays the
	 * recorded result when a succeeded call already holds the key (replay).
	 */
	claim(input: EffectLedgerClaimInput): Promise<EffectLedgerClaim>;
	complete(idempotencyKey: string, outcome: EffectLedgerOutcome): Promise<void>;
	get(idempotencyKey: string): Promise<EffectLedgerRecord | undefined>;
	list(sessionId?: string): Promise<EffectLedgerRecord[]>;
}
