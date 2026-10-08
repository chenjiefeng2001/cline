/**
 * Activity-bounded consumption of a provider stream.
 *
 * A `for await` over a provider stream has no upper bound on how long the next
 * chunk may take. When a connection goes half-open - the socket stays alive while
 * the far end stops sending, which is what suspending a laptop or silently
 * dropping inbound packets looks like - that loop parks forever. No error is
 * raised, so the transient-retry path never runs, and the only way out is the user
 * clicking Cancel, which aborts the whole turn rather than retrying the request.
 * That is upstream cline/cline#10631.
 *
 * This wraps the iterable rather than the transport, so it applies uniformly to
 * every provider without each one growing its own timer, and it measures *activity*
 * rather than total duration: a long reasoning pause is not a stall, a long silence
 * is. Time spent producing chunks never counts against the budget.
 */

/** Raised when a provider stream produces nothing for longer than the budget. */
export class StreamStalledError extends Error {
	override readonly name = "StreamStalledError";

	constructor(readonly stallTimeoutMs: number) {
		super(
			`Provider stream stalled: no data received for ${stallTimeoutMs}ms. ` +
				`The connection is most likely half-open, so this is classified as transient and retried.`,
		);
	}
}

/**
 * Default budget for silence between chunks.
 *
 * Deliberately generous. Normal streaming delivers a chunk every tens to hundreds
 * of milliseconds, but an extended-thinking model can think for a minute or more
 * before its next visible output, and cutting that off would abort legitimate
 * requests and turn a working model into a retry loop. Two minutes of absolute
 * silence is far outside normal reasoning pauses while still converting an
 * unrecoverable hang into a retry that can succeed.
 */
export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 120_000;

export interface StallTimeoutOptions {
	/**
	 * Milliseconds of silence to tolerate before declaring a stall. `0` or a
	 * negative value disables the guard and restores plain `for await` behaviour.
	 */
	stallTimeoutMs?: number;
}

/**
 * Resolve the budget, allowing an environment override.
 *
 * Read per call rather than once at module load so the value can be set by a host
 * at startup, and so tests can exercise the real call sites without waiting out the
 * production default. An unparseable value falls back rather than disabling the
 * guard, so a typo cannot silently remove the protection.
 */
function resolveStallTimeoutMs(): number {
	const raw = process.env.CLINE_STREAM_STALL_TIMEOUT_MS;
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_STREAM_STALL_TIMEOUT_MS;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : DEFAULT_STREAM_STALL_TIMEOUT_MS;
}

/**
 * Yield everything from `source`, failing with {@link StreamStalledError} if no
 * item arrives within the budget.
 *
 * The timer is `unref`'d so a pending stall can never by itself hold the process
 * open, and a rejection arriving from the abandoned iterator is swallowed rather
 * than surfacing as an unhandled rejection.
 */
export async function* withStallTimeout<T>(
	source: AsyncIterable<T>,
	options: StallTimeoutOptions = {},
): AsyncGenerator<T> {
	const limit = options.stallTimeoutMs ?? resolveStallTimeoutMs();
	const iterator = source[Symbol.asyncIterator]();

	if (!Number.isFinite(limit) || limit <= 0) {
		// Not `yield* iterator`: that needs an iterable, and `iterator` is the raw
		// AsyncIterator, which has no [Symbol.asyncIterator].
		for (;;) {
			const result = await iterator.next();
			if (result.done === true) {
				return;
			}
			yield result.value;
		}
	}

	try {
		for (;;) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			// Once the stall wins the race, the real `next()` is still in flight and may
			// reject later. Without this it becomes an unhandled rejection.
			const pending = iterator.next();
			pending.catch(() => {});

			const stalled = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new StreamStalledError(limit)), limit);
			});

			let result: IteratorResult<T>;
			try {
				result = await Promise.race([pending, stalled]);
			} finally {
				if (timer !== undefined) {
					clearTimeout(timer);
				}
			}

			if (result.done === true) {
				return;
			}
			yield result.value;
		}
	} finally {
		// Deliberately NOT awaited.
		//
		// For an async generator suspended at a `next()` that never settles, `.return()`
		// queues behind that pending await and only runs once it completes. Awaiting it
		// here therefore re-blocks forever and turns the StreamStalledError back into
		// the very hang this guard exists to break - observed as a test that timed out
		// instead of failing. Cleanup is best-effort, so fire it and move on; the
		// rejection is swallowed because there is no caller left to receive it.
		void iterator.return?.(undefined)?.catch(() => {});
	}
}