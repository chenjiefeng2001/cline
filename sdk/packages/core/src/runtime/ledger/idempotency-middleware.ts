/**
 * Idempotency middleware — the tool-boundary exactly-once enforcement point
 * [roadmap P2-2].
 *
 * Wraps tool execution with the side-effect ledger: derives the idempotency
 * key from the call context, claims it, and either **replays** the recorded
 * outcome (succeeded call on recovery — no double-apply) or **forks** into
 * normal execution and completes the record (succeeded → recorded result;
 * failed → recorded error, retry stays safe).
 *
 * Designed for the P1-4 middleware chain: register it in the chain and the
 * enforcement is zero-intrusion into executors.
 */

import type {
	ToolMiddleware,
	ToolMiddlewareContext,
} from "../../middleware/tool-middleware";
import type { EffectLedger } from "./effect-ledger";
import { deriveIdempotencyKeyFromContext } from "./idempotency-key";

export interface IdempotencyMiddlewareOptions {
	ledger: EffectLedger;
	/** Session id for key derivation; fixed value or per-call resolver. */
	sessionId: string | ((context: ToolMiddlewareContext) => string);
}

export function createIdempotencyMiddleware(
	options: IdempotencyMiddlewareOptions,
): ToolMiddleware {
	const resolveSessionId = (context: ToolMiddlewareContext): string =>
		typeof options.sessionId === "function"
			? options.sessionId(context)
			: options.sessionId;
	return {
		name: "idempotency",
		async wrap(execute, context) {
			const sessionId = resolveSessionId(context);
			if (!sessionId) {
				// No session identity — ledger cannot key the call; execute
				// unsandboxed from the ledger (fork without recording).
				return execute();
			}
			const idempotencyKey = deriveIdempotencyKeyFromContext(
				context,
				sessionId,
			);
			const claim = await options.ledger.claim({
				idempotencyKey,
				sessionId,
				toolName: context.toolName,
				toolCallId: context.toolCallId,
				input: context.input,
			});
			if (claim.outcome === "replay") {
				return claim.result;
			}
			try {
				const result = await execute();
				await options.ledger.complete(idempotencyKey, {
					status: "succeeded",
					result,
				});
				return result;
			} catch (error) {
				await options.ledger.complete(idempotencyKey, {
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	};
}
