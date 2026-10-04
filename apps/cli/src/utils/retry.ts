import {
	computeRetryDelayMs,
	DEFAULT_PROVIDER_RETRY_POLICY,
	isTransientProviderError,
	type ProviderRetryPolicy,
} from "@cline/llms";

/**
 * Retry a turn on transient provider/transport failures.
 *
 * The CLI previously had no automatic retry at all, while the VS Code extension
 * retried transparently — so the same `ECONNRESET` failed a CLI run outright and was
 * invisible in the IDE. Classification and backoff now come from `@cline/llms`
 * (`providers/transient-errors.ts`), which is the single definition both hosts share;
 * this wrapper only adds the loop and the reporting.
 *
 * Aborts are never retried: `isTransientProviderError` rejects anything abort-shaped,
 * so a user pressing Ctrl-C is not raced by a queued retry.
 */
export interface TransientRetryOptions {
	policy?: ProviderRetryPolicy;
	/** Called before each backoff, for progress output. */
	onRetry?: (info: {
		attempt: number;
		maxRetries: number;
		delayMs: number;
		error: unknown;
	}) => void;
	/**
	 * Cancellation. Checked before each retry so a host that owns an
	 * `AbortController` (ACP `prompt`/`cancel`) does not sit through a backoff
	 * the user already cancelled. The in-flight attempt is not interrupted —
	 * the abort is delivered to it through the operation itself.
	 */
	signal?: AbortSignal;
	/** Injectable for tests. */
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Run `operation`, retrying it while it fails with a transient error and attempts
 * remain. The last error is rethrown once the policy is exhausted, so the caller's
 * existing error handling is unchanged.
 */
export async function withTransientRetry<T>(
	operation: (attempt: number) => Promise<T>,
	options: TransientRetryOptions = {},
): Promise<T> {
	const policy = options.policy ?? DEFAULT_PROVIDER_RETRY_POLICY;
	const sleep = options.sleep ?? defaultSleep;

	let attempt = 0;
	for (;;) {
		try {
			return await operation(attempt);
		} catch (error) {
			if (attempt >= policy.maxRetries || !isTransientProviderError(error)) {
				throw error;
			}
			if (options.signal?.aborted) {
				throw error;
			}
			const delayMs = computeRetryDelayMs(attempt, policy);
			options.onRetry?.({
				attempt: attempt + 1,
				maxRetries: policy.maxRetries,
				delayMs,
				error,
			});
			await sleep(delayMs);
			attempt += 1;
		}
	}
}
