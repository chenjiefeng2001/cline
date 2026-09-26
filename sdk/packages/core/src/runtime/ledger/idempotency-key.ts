/**
 * Idempotency-key derivation for the tool side-effect ledger [roadmap P2-2].
 *
 * Keys are deterministic so a recovered run re-derives the same key for the
 * same logical call (sessionId + iteration + tool + input) and the ledger
 * replays the recorded outcome instead of double-applying the effect.
 */

import { createHash } from "node:crypto";
import type { ToolMiddlewareContext } from "../../middleware/tool-middleware";

/**
 * Stable hash of a call input: JSON with sorted object keys (array order
 * preserved), sha256, truncated. `undefined`/absent inputs hash to "none".
 */
export function hashToolInput(input: unknown): string {
	if (input === undefined || input === null) {
		return "none";
	}
	try {
		return createHash("sha256")
			.update(stableStringify(input))
			.digest("hex")
			.slice(0, 32);
	} catch {
		return "unserializable";
	}
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => typeof item !== "function")
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries
		.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
		.join(",")}}`;
}

export interface DeriveIdempotencyKeyInput {
	sessionId: string;
	toolName: string;
	runId?: string;
	toolCallIndex?: number;
	/** Loop iteration that produced the call. */
	iteration?: number;
	toolCallId?: string;
	input?: unknown;
	inputHash?: string;
}

/**
 * Derives the durable ledger key for a logical tool step:
 * `<sessionId>:<runId|->:<iteration|->:<toolName>:<toolCallIndex|->:<inputHash>`.
 * Provider-generated tool call ids are intentionally excluded because a
 * restored model run may assign a new id to the same logical step.
 */
export function deriveIdempotencyKey(input: DeriveIdempotencyKeyInput): string {
	if (input.input !== undefined && input.inputHash !== undefined) {
		throw new Error("Idempotency key accepts input or inputHash, not both");
	}
	const runId = input.runId ?? "-";
	const iteration = input.iteration ?? "-";
	const toolCallIndex = input.toolCallIndex ?? "-";
	const inputHash = input.inputHash ?? hashToolInput(input.input);
	return `${input.sessionId}:${runId}:${iteration}:${input.toolName}:${toolCallIndex}:${inputHash}`;
}

export function deriveV2IdempotencyKey(
	input: DeriveIdempotencyKeyInput,
): string {
	if (input.input !== undefined && input.inputHash !== undefined) {
		throw new Error("Idempotency key accepts input or inputHash, not both");
	}
	const iteration = input.iteration ?? "-";
	const inputHash = input.inputHash ?? hashToolInput(input.input);
	return `${input.sessionId}:${iteration}:${input.toolName}:${inputHash}`;
}

export function deriveLegacyIdempotencyKey(
	input: DeriveIdempotencyKeyInput,
): string {
	if (input.input !== undefined && input.inputHash !== undefined) {
		throw new Error("Idempotency key accepts input or inputHash, not both");
	}
	const iteration = input.iteration ?? "-";
	const toolCallId = input.toolCallId ?? "-";
	const inputHash = input.inputHash ?? hashToolInput(input.input);
	return `${input.sessionId}:${iteration}:${input.toolName}:${toolCallId}:${inputHash}`;
}

/**
 * Derives the ledger key from a middleware chain context, so the
 * idempotency middleware needs no per-call plumbing.
 */
export function deriveIdempotencyKeyFromContext(
	context: ToolMiddlewareContext,
	sessionId: string,
): string {
	return deriveIdempotencyKey({
		sessionId,
		toolName: context.toolName,
		runId: context.runId,
		iteration: context.iteration,
		toolCallId: context.toolCallId,
		toolCallIndex: context.toolCallIndex,
		input: context.input,
	});
}
