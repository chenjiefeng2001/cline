/**
 * Create a stream consumer that adds a first-chunk timeout to any
 * `AsyncIterable`. If the first chunk doesn't arrive within `timeoutMs`,
 * the consumer throws a `TimeoutError`.
 *
 * ## Why
 *
 * API streams can hang on the first chunk (e.g. a provider's gateway is slow
 * to start streaming, or the network is congested). Without a timeout, the
 * `for await...of` loop hangs forever, blocking the entire task. The caller
 * can catch the error and decide whether to retry or surface it.
 *
 * ## Usage
 *
 * ```typescript
 * const consumer = withFirstChunkTimeout(handler.createMessage(system, msgs), {
 *   timeoutMs: 120_000,  // 2 min for local models
 *   signal: abortController.signal,
 * })
 * for await (const chunk of consumer) {
 *   // ...
 * }
 * ```
 *
 * When the timeout fires, the underlying iterator is cancelled (via
 * `return()`) so the provider's stream is closed cleanly.
 */

export interface FirstChunkTimeoutOptions {
	/** Milliseconds to wait for the first chunk. Default: 30_000. */
	timeoutMs?: number
	/** Optional AbortSignal to cancel early. */
	signal?: AbortSignal
}

export class FirstChunkTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`First chunk did not arrive within ${timeoutMs}ms`)
		this.name = "FirstChunkTimeoutError"
	}
}

/**
 * Wrap an `AsyncIterable` so that it throws `FirstChunkTimeoutError` if the
 * first chunk does not arrive within `timeoutMs`.
 */
export async function* withFirstChunkTimeout<T>(
	iterable: AsyncIterable<T>,
	options?: FirstChunkTimeoutOptions,
): AsyncGenerator<T> {
	const timeoutMs = options?.timeoutMs ?? 30_000
	const signal = options?.signal

	const iterator = iterable[Symbol.asyncIterator]()

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined

	// Race: first chunk vs timeout
	const firstChunkPromise = iterator.next()
	const timeoutPromise = new Promise<never>((_, reject) => {
		// Clean up the timeout if the signal aborts first
		if (signal) {
			if (signal.aborted) {
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
				return
			}
			const onAbort = () => {
				clearTimeout(timeoutHandle)
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
			}
			signal.addEventListener("abort", onAbort, { once: true })
			// Store cleanup so we can remove the listener if timeout wins
			timeoutHandle = setTimeout(() => {
				signal.removeEventListener("abort", onAbort)
				reject(new FirstChunkTimeoutError(timeoutMs))
			}, timeoutMs)
		} else {
			timeoutHandle = setTimeout(() => {
				reject(new FirstChunkTimeoutError(timeoutMs))
			}, timeoutMs)
		}
	})

	let result: IteratorResult<T>
	try {
		result = await Promise.race([firstChunkPromise, timeoutPromise])
	} catch (error) {
		// Cancel the underlying iterator so resources are released
		await iterator.return?.()
		throw error
	} finally {
		clearTimeout(timeoutHandle)
	}

	// Yield the first chunk (if available)
	if (result.done) {
		return
	}
	yield result.value

	// Yield remaining chunks normally
	while (true) {
		const next = await iterator.next()
		if (next.done) break
		yield next.value
	}
}
