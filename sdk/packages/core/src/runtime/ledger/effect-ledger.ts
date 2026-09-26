export const DEFAULT_EFFECT_LEASE_MS = 300_000;

export type EffectLedgerStatus =
	| "pending"
	| "succeeded"
	| "failed"
	| "in_doubt";

export type EffectLedgerTerminalStatus = Exclude<EffectLedgerStatus, "pending">;

export interface EffectLedgerRecord {
	idempotencyKey: string;
	sessionId: string;
	toolName: string;
	runId?: string;
	iteration?: number;
	toolCallId?: string;
	toolCallIndex?: number;
	stepId?: string;
	inputHash?: string;
	status: EffectLedgerStatus;
	result?: unknown;
	error?: string;
	createdAt: string;
	completedAt?: string;
	attempt: number;
	ownerId?: string;
	leaseExpiresAt?: string;
}

export interface EffectLedgerLease {
	idempotencyKey: string;
	ownerId: string;
	leaseToken: string;
	leaseExpiresAt: string;
}

export interface EffectLedgerClaimInput {
	idempotencyKey: string;
	sessionId: string;
	toolName: string;
	runId?: string;
	iteration?: number;
	toolCallId?: string;
	toolCallIndex?: number;
	stepId?: string;
	input?: unknown;
	inputHash?: string;
	ownerId: string;
	leaseDurationMs?: number;
}

export type EffectLedgerClaim =
	| {
			outcome: "claimed";
			lease: EffectLedgerLease;
	  }
	| {
			outcome: "replay";
			result?: unknown;
			record: EffectLedgerRecord;
	  }
	| {
			outcome: "in_progress";
			record: EffectLedgerRecord;
	  }
	| {
			outcome: "in_doubt";
			record: EffectLedgerRecord;
	  };

export interface EffectLedgerOutcome {
	status: EffectLedgerTerminalStatus;
	result?: unknown;
	error?: string;
}

export interface EffectLedgerImportInput {
	idempotencyKey: string;
	sessionId: string;
	source: EffectLedgerRecord;
}

export type EffectLedgerImportResult = "imported" | "existing";

export class EffectLedgerCollisionError extends Error {
	constructor(idempotencyKey: string) {
		super(`Effect ledger key collision: ${idempotencyKey}`);
		this.name = "EffectLedgerCollisionError";
	}
}

export class EffectLedgerLeaseLostError extends Error {
	constructor(idempotencyKey: string) {
		super(`Effect ledger lease lost: ${idempotencyKey}`);
		this.name = "EffectLedgerLeaseLostError";
	}
}

export class EffectLedgerUnavailableError extends Error {
	readonly outcome: "in_progress" | "in_doubt";
	readonly record: EffectLedgerRecord;

	constructor(outcome: "in_progress" | "in_doubt", record: EffectLedgerRecord) {
		super(
			outcome === "in_progress"
				? `Effect is already running: ${record.idempotencyKey}`
				: `Effect outcome is in doubt: ${record.idempotencyKey}`,
		);
		this.name = "EffectLedgerUnavailableError";
		this.outcome = outcome;
		this.record = record;
	}
}

export interface EffectLedger {
	init(): Promise<void> | void;
	claim(input: EffectLedgerClaimInput): Promise<EffectLedgerClaim>;
	renew(lease: EffectLedgerLease, leaseDurationMs?: number): Promise<void>;
	complete(
		lease: EffectLedgerLease,
		outcome: EffectLedgerOutcome,
	): Promise<void>;
	import(input: EffectLedgerImportInput): Promise<EffectLedgerImportResult>;
	get(idempotencyKey: string): Promise<EffectLedgerRecord | undefined>;
	list(sessionId?: string): Promise<EffectLedgerRecord[]>;
	close(): Promise<void> | void;
}
