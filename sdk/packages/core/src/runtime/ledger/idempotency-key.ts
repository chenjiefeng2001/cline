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
	/** Loop iteration that produced the call. */
	iteration?: number;
	toolCallId?: string;
	input?: unknown;
}

/**
 * Derives the ledger key for a tool call:
 * `<sessionId>:<iteration|->:<toolName>:<toolCallId|->:<inputHash>`.
 * Distinct logical calls derive distinct keys; the same call re-derived
 * after recovery collides by design (that is the replay path).
 */
export function deriveIdempotencyKey(input: DeriveIdempotencyKeyInput): string {
	const iteration = input.iteration ?? "-";
	const toolCallId = input.toolCallId ?? "-";
	const inputHash = hashToolInput(input.input);
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
		iteration: context.iteration,
		toolCallId: context.toolCallId,
		input: context.input,
	});
}
