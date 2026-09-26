import { randomUUID } from "node:crypto";
import type {
	ToolMiddleware,
	ToolMiddlewareContext,
} from "../../middleware/tool-middleware";
import {
	DEFAULT_EFFECT_LEASE_MS,
	type EffectLedger,
	type EffectLedgerOutcome,
	type EffectLedgerRecord,
	EffectLedgerUnavailableError,
} from "./effect-ledger";
import {
	deriveIdempotencyKeyFromContext,
	deriveLegacyIdempotencyKey,
	deriveV2IdempotencyKey,
} from "./idempotency-key";

export interface IdempotencyMiddlewareOptions {
	ledger: EffectLedger;
	sessionId: string | ((context: ToolMiddlewareContext) => string);
	ownerId?: string;
	leaseDurationMs?: number;
	renewIntervalMs?: number | false;
	isSafeToRetry?: (error: unknown) => boolean;
	classifyResult?: (
		result: unknown,
		context: ToolMiddlewareContext,
	) =>
		| EffectLedgerOutcome
		| undefined
		| Promise<EffectLedgerOutcome | undefined>;
}

function findUnsuccessfulResult(
	value: unknown,
): { error?: unknown; isError?: unknown; success?: unknown } | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const unsuccessful = findUnsuccessfulResult(item);
			if (unsuccessful) {
				return unsuccessful;
			}
		}
		return undefined;
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const result = value as {
		error?: unknown;
		isError?: unknown;
		success?: unknown;
	};
	return result.isError === true || result.success === false
		? result
		: undefined;
}

function defaultResultOutcome(result: unknown): EffectLedgerOutcome {
	const unsuccessful = findUnsuccessfulResult(result);
	if (!unsuccessful) {
		return { status: "succeeded", result };
	}
	return {
		status: "in_doubt",
		error:
			typeof unsuccessful.error === "string"
				? unsuccessful.error
				: "Tool returned an unsuccessful result",
	};
}

function inDoubtRecord(record: EffectLedgerRecord): EffectLedgerRecord {
	return {
		...record,
		status: "in_doubt",
		completedAt: record.completedAt ?? new Date().toISOString(),
		ownerId: undefined,
		leaseExpiresAt: undefined,
		error: record.error ?? "Legacy effect lease is unavailable",
	};
}

export function createIdempotencyMiddleware(
	options: IdempotencyMiddlewareOptions,
): ToolMiddleware {
	const resolveSessionId = (context: ToolMiddlewareContext): string =>
		typeof options.sessionId === "function"
			? options.sessionId(context)
			: options.sessionId;
	const ownerId = options.ownerId ?? randomUUID();
	const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_EFFECT_LEASE_MS;
	let initialization: Promise<void> | undefined;
	const initialize = async (): Promise<void> => {
		if (!initialization) {
			initialization = Promise.resolve()
				.then(async () => {
					await options.ledger.init();
				})
				.catch((error) => {
					initialization = undefined;
					throw error;
				});
		}
		await initialization;
	};
	const importLegacyRecord = async (
		context: ToolMiddlewareContext,
		sessionId: string,
		idempotencyKey: string,
	): Promise<void> => {
		const keyInput = {
			sessionId,
			toolName: context.toolName,
			iteration: context.iteration,
			toolCallId: context.toolCallId,
			toolCallIndex: context.toolCallIndex,
			input: context.input,
		};
		const legacyKeys = [deriveV2IdempotencyKey(keyInput)];
		if (context.toolCallId) {
			legacyKeys.push(deriveLegacyIdempotencyKey(keyInput));
		}
		let legacy: EffectLedgerRecord | undefined;
		for (const legacyKey of legacyKeys) {
			if (legacyKey === idempotencyKey) {
				continue;
			}
			legacy = await options.ledger.get(legacyKey);
			if (legacy) {
				break;
			}
		}
		if (!legacy || legacy.status === "failed") {
			return;
		}
		if (
			legacy.status === "pending" &&
			legacy.leaseExpiresAt &&
			Date.parse(legacy.leaseExpiresAt) > Date.now()
		) {
			throw new EffectLedgerUnavailableError("in_progress", legacy);
		}
		await options.ledger.import({
			idempotencyKey,
			sessionId,
			source: legacy.status === "pending" ? inDoubtRecord(legacy) : legacy,
		});
	};
	return {
		name: "idempotency",
		async wrap(execute, context) {
			const sessionId = resolveSessionId(context);
			if (!sessionId) {
				return execute();
			}
			await initialize();
			const idempotencyKey = deriveIdempotencyKeyFromContext(
				context,
				sessionId,
			);
			await importLegacyRecord(context, sessionId, idempotencyKey);
			const claim = await options.ledger.claim({
				idempotencyKey,
				sessionId,
				toolName: context.toolName,
				runId: context.runId,
				iteration: context.iteration,
				toolCallId: context.toolCallId,
				toolCallIndex: context.toolCallIndex,
				stepId: context.stepId,
				input: context.input,
				ownerId,
				leaseDurationMs,
			});
			if (claim.outcome === "replay") {
				return claim.result;
			}
			if (claim.outcome !== "claimed") {
				throw new EffectLedgerUnavailableError(claim.outcome, claim.record);
			}
			const lease = claim.lease;
			const configuredRenewInterval = options.renewIntervalMs;
			const renewIntervalMs =
				configuredRenewInterval === false
					? undefined
					: (configuredRenewInterval ??
						Math.max(10, Math.floor(leaseDurationMs / 3)));
			if (
				renewIntervalMs !== undefined &&
				(!Number.isFinite(renewIntervalMs) || renewIntervalMs <= 0)
			) {
				throw new Error("Idempotency renewal interval must be positive");
			}
			let renewal: Promise<void> | undefined;
			const renewTimer =
				renewIntervalMs === undefined
					? undefined
					: setInterval(() => {
							if (renewal) {
								return;
							}
							renewal = options.ledger
								.renew(lease, leaseDurationMs)
								.catch(() => undefined)
								.finally(() => {
									renewal = undefined;
								});
						}, renewIntervalMs);
			renewTimer?.unref?.();
			const onSignal = (): void => {
				if (!context.signal?.aborted) {
					return;
				}
				if (renewTimer) {
					clearInterval(renewTimer);
				}
				const reason = context.signal.reason;
				void options.ledger
					.complete(lease, {
						status: "in_doubt",
						error:
							reason instanceof Error
								? reason.message
								: reason === undefined
									? "Tool execution was interrupted"
									: String(reason),
					})
					.catch(() => undefined);
			};
			context.signal?.addEventListener("abort", onSignal, { once: true });
			onSignal();
			try {
				if (context.signal?.aborted) {
					throw new Error("Tool execution was interrupted");
				}
				let result: unknown;
				try {
					result = await execute();
				} catch (error) {
					let safeToRetry = false;
					if (context.retryable === true) {
						try {
							safeToRetry = options.isSafeToRetry?.(error) ?? true;
						} catch {
							safeToRetry = false;
						}
					}
					try {
						await options.ledger.complete(lease, {
							status: safeToRetry ? "failed" : "in_doubt",
							error: error instanceof Error ? error.message : String(error),
						});
					} catch (ledgerError) {
						throw new AggregateError(
							[error, ledgerError],
							"Tool failed and its effect ledger could not be completed",
						);
					}
					throw error;
				}
				let outcome: EffectLedgerOutcome;
				try {
					outcome =
						(await options.classifyResult?.(result, context)) ??
						defaultResultOutcome(result);
				} catch (error) {
					await options.ledger.complete(lease, {
						status: "in_doubt",
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
				await options.ledger.complete(lease, outcome);
				return result;
			} finally {
				context.signal?.removeEventListener("abort", onSignal);
				if (renewTimer) {
					clearInterval(renewTimer);
				}
			}
		},
	};
}
