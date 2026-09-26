import type { RunRecoverySnapshot } from "./recovery-snapshot";
import type { RunState } from "./run-state";

export const DEFAULT_RUN_CONTINUATION_LEASE_MS = 300_000;

export type RunContinuationPhase =
	| "awaiting_approval"
	| "approved"
	| "executing"
	| "completed"
	| "failed"
	| "cancelled"
	| "succeeded";

export type RunContinuationTerminalPhase = Extract<
	RunContinuationPhase,
	"completed" | "failed" | "cancelled" | "succeeded"
>;

/**
 * Serializable agent chain for a durable continuation. A lead run only carries
 * `agentId`; a delegated run additionally records the immediate parent and the
 * root run that owns the chain, so a later resume can refuse to replay a
 * delegated transcript as if it were the session's own turn.
 */
export interface RunContinuationAgentChain {
	agentId: string;
	agentRole?: string;
	parentAgentId?: string;
	rootRunId?: string;
}

export interface RunContinuationRecord {
	continuationKey: string;
	sessionId: string;
	runId: string;
	agentId: string;
	conversationId: string;
	iteration: number;
	toolCallIndex: number;
	toolCallId: string;
	toolName: string;
	preparedInputJson: string;
	preparedInputHash: string;
	assistantMessageId: string;
	approvalId: string;
	phase: RunContinuationPhase;
	ownerToken?: string;
	leaseStartedAt?: string;
	leaseExpiresAt?: string;
	createdAt: string;
	updatedAt: string;
	terminalError?: string;
	terminalReason?: string;
	recoverySnapshot?: RunRecoverySnapshot;
	runState?: RunState;
	agentChain?: RunContinuationAgentChain;
}

export interface RunContinuationIdentity {
	sessionId: string;
	runId: string;
	agentId: string;
	conversationId: string;
	iteration: number;
	toolCallIndex: number;
	toolCallId: string;
	toolName: string;
	preparedInputJson: string;
	preparedInputHash: string;
	assistantMessageId: string;
	approvalId: string;
}

export interface CreateRunContinuationInput extends RunContinuationIdentity {
	continuationKey: string;
	phase?: RunContinuationPhase;
	recoverySnapshot?: RunRecoverySnapshot;
	runState?: RunState;
	agentChain?: RunContinuationAgentChain;
}

export type UpsertRunContinuationInput = CreateRunContinuationInput;

export interface RunContinuationMutationGuard {
	expectedPhase?: RunContinuationPhase;
	fromPhase?: RunContinuationPhase;
	identity?: Partial<RunContinuationIdentity>;
	expectedIdentity?: Partial<RunContinuationIdentity>;
	inputHash?: string;
	expectedInputHash?: string;
	ownerToken?: string;
}

export interface ClaimRunContinuationInput
	extends RunContinuationMutationGuard {
	continuationKey: string;
	leaseDurationMs?: number;
}

export interface TransitionRunContinuationInput
	extends RunContinuationMutationGuard {
	continuationKey: string;
	phase?: RunContinuationPhase;
	toPhase?: RunContinuationPhase;
	terminalError?: string;
	terminalReason?: string;
}

export interface CloseRunContinuationInput
	extends RunContinuationMutationGuard {
	continuationKey: string;
	phase?: RunContinuationTerminalPhase;
	status?: RunContinuationTerminalPhase;
	error?: string;
	reason?: string;
	terminalError?: string;
	terminalReason?: string;
}

export interface CancelRunContinuationInput
	extends RunContinuationMutationGuard {
	continuationKey: string;
	reason?: string;
	terminalReason?: string;
}

export interface RunContinuationLease {
	continuationKey: string;
	ownerToken: string;
	leaseStartedAt: string;
	leaseExpiresAt: string;
}

export type RunContinuationClaim =
	| {
			outcome: "claimed";
			record: RunContinuationRecord;
			lease: RunContinuationLease;
	  }
	| {
			outcome: "in_progress";
			record: RunContinuationRecord;
	  };

export interface RunContinuationUpsertResult {
	created: boolean;
	record: RunContinuationRecord;
}

export interface RunContinuationStore {
	init(): Promise<void> | void;
	createOrUpsert(
		input: CreateRunContinuationInput,
	): Promise<RunContinuationUpsertResult>;
	upsert(
		input: UpsertRunContinuationInput,
	): Promise<RunContinuationUpsertResult>;
	create(
		input: CreateRunContinuationInput,
	): Promise<RunContinuationUpsertResult>;
	get(continuationKey: string): Promise<RunContinuationRecord | undefined>;
	listRecoverable(
		sessionId?: string,
		limit?: number,
	): Promise<RunContinuationRecord[]>;
	claim(input: ClaimRunContinuationInput): Promise<RunContinuationClaim>;
	transition(
		input: TransitionRunContinuationInput,
	): Promise<RunContinuationRecord>;
	transitionPhase(
		input: TransitionRunContinuationInput,
	): Promise<RunContinuationRecord>;
	closeTerminal(
		input: CloseRunContinuationInput,
	): Promise<RunContinuationRecord>;
	complete(input: CloseRunContinuationInput): Promise<RunContinuationRecord>;
	cancel(input: CancelRunContinuationInput): Promise<RunContinuationRecord>;
	close(): Promise<void> | void;
}

export class RunContinuationCollisionError extends Error {
	constructor(readonly continuationKey: string) {
		super(`Run continuation key collision: ${continuationKey}`);
		this.name = "RunContinuationCollisionError";
	}
}

export class RunContinuationIdentityMismatchError extends RunContinuationCollisionError {
	constructor(
		readonly field: string,
		continuationKey: string,
	) {
		super(continuationKey);
		this.name = "RunContinuationIdentityMismatchError";
		this.message = `Run continuation identity mismatch for ${field}: ${continuationKey}`;
	}
}

export class RunContinuationInputHashMismatchError extends RunContinuationCollisionError {
	constructor(continuationKey: string) {
		super(continuationKey);
		this.name = "RunContinuationInputHashMismatchError";
		this.message = `Run continuation input hash mismatch: ${continuationKey}`;
	}
}

export class RunContinuationPhaseMismatchError extends Error {
	constructor(
		readonly continuationKey: string,
		readonly expectedPhase: RunContinuationPhase,
		readonly actualPhase: RunContinuationPhase,
	) {
		super(
			`Run continuation phase mismatch for ${continuationKey}: expected ${expectedPhase}, got ${actualPhase}`,
		);
		this.name = "RunContinuationPhaseMismatchError";
	}
}

export class RunContinuationLeaseLostError extends Error {
	constructor(readonly continuationKey: string) {
		super(`Run continuation lease lost: ${continuationKey}`);
		this.name = "RunContinuationLeaseLostError";
	}
}

export class RunContinuationNotFoundError extends Error {
	constructor(readonly continuationKey: string) {
		super(`Run continuation not found: ${continuationKey}`);
		this.name = "RunContinuationNotFoundError";
	}
}

export class RunContinuationClosedError extends Error {
	constructor() {
		super("Run continuation store is closed");
		this.name = "RunContinuationClosedError";
	}
}

export function isRunContinuationTerminalPhase(
	phase: RunContinuationPhase,
): phase is RunContinuationTerminalPhase {
	return (
		phase === "completed" ||
		phase === "failed" ||
		phase === "cancelled" ||
		phase === "succeeded"
	);
}

export function isRunContinuationPhase(
	value: unknown,
): value is RunContinuationPhase {
	return (
		value === "awaiting_approval" ||
		value === "approved" ||
		value === "executing" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "succeeded"
	);
}

const MAX_AGENT_CHAIN_ID_LENGTH = 128;

function requireAgentChainText(
	value: unknown,
	field: string,
): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > MAX_AGENT_CHAIN_ID_LENGTH
	) {
		throw new Error(`Run continuation ${field} must be a bounded identifier`);
	}
	return value;
}

/**
 * Parse a persisted agent chain. Unset or empty columns stay `undefined`; a
 * non-object or over-long value is rejected so a corrupted row can never be
 * read back as a root run.
 */
export function parseRunContinuationAgentChain(
	value: unknown,
): RunContinuationAgentChain | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("Run continuation agent chain must be JSON text");
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error("Run continuation agent chain is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Run continuation agent chain must be an object");
	}
	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (
			key !== "agentId" &&
			key !== "agentRole" &&
			key !== "parentAgentId" &&
			key !== "rootRunId"
		) {
			throw new Error(
				`Run continuation agent chain contains unsupported field: ${key}`,
			);
		}
	}
	const agentId = requireAgentChainText(record.agentId, "agent chain agentId");
	if (!agentId) {
		throw new Error("Run continuation agent chain requires an agentId");
	}
	const agentRole = requireAgentChainText(
		record.agentRole,
		"agent chain agentRole",
	);
	const parentAgentId = requireAgentChainText(
		record.parentAgentId,
		"agent chain parentAgentId",
	);
	if (parentAgentId === agentId) {
		throw new Error(
			"Run continuation agent chain parentAgentId must differ from agentId",
		);
	}
	const rootRunId = requireAgentChainText(
		record.rootRunId,
		"agent chain rootRunId",
	);
	return {
		agentId,
		...(agentRole ? { agentRole } : {}),
		...(parentAgentId ? { parentAgentId } : {}),
		...(rootRunId ? { rootRunId } : {}),
	};
}

export function serializeRunContinuationAgentChain(
	chain: RunContinuationAgentChain,
): string {
	return JSON.stringify(parseRunContinuationAgentChain(JSON.stringify(chain)));
}
