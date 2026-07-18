import { describe, it, expect, vi } from "vitest"
import { withFirstChunkTimeout, FirstChunkTimeoutError } from "./stream-timeout"

describe("withFirstChunkTimeout", () => {
	it("should yield all chunks from the inner iterable", async () => {
		const inner = (async function* () {
			yield "a"
			yield "b"
			yield "c"
		})()

		const collected: string[] = []
		for await (const chunk of withFirstChunkTimeout(inner, { timeoutMs: 5000 })) {
			collected.push(chunk)
		}
		expect(collected).toEqual(["a", "b", "c"])
	})

	it("should throw FirstChunkTimeoutError if first chunk is slow", { timeout: 5000 }, async () => {
		const neverResolve = new Promise<IteratorResult<string>>(() => { /* never */ })
		const inner = {
			[Symbol.asyncIterator]() {
				return { next: () => neverResolve, return: vi.fn().mockResolvedValue({ value: undefined, done: true }) }
			},
		}

		const start = Date.now()
		await expect(async () => {
			for await (const _ of withFirstChunkTimeout(inner as AsyncIterable<string>, { timeoutMs: 50 })) { /* */ }
		}).rejects.toThrow(FirstChunkTimeoutError)

		// Should complete within 2s for a 50ms timeout
		expect(Date.now() - start).toBeLessThan(5000)
	})

	it("should not throw if chunk arrives before timeout", async () => {
		const inner = (async function* () {
			yield "fast"
			yield "also-fast"
		})()

		const collected: string[] = []
		for await (const chunk of withFirstChunkTimeout(inner, { timeoutMs: 1000 })) {
			collected.push(chunk)
		}
		expect(collected).toEqual(["fast", "also-fast"])
	})

	it("should propagate user-supplied AbortSignal", async () => {
		const ac = new AbortController()
		const neverResolve = new Promise<IteratorResult<string>>(() => { /* never */ })
		const inner = {
			[Symbol.asyncIterator]() {
				return { next: () => neverResolve, return: vi.fn().mockResolvedValue({ value: undefined, done: true }) }
			},
		}

		const promise = (async () => {
			for await (const _ of withFirstChunkTimeout(inner as AsyncIterable<string>, {
				timeoutMs: 5000, signal: ac.signal,
			})) { /* */ }
		})()

		ac.abort(new DOMException("Cancelled", "AbortError"))
		await expect(promise).rejects.toThrow("Cancelled")
	})

	it("should call return() on the inner iterator on cancel", async () => {
		const returnFn = vi.fn().mockResolvedValue({ value: undefined, done: true })
		const inner = {
			[Symbol.asyncIterator]() {
				return {
					next: () => new Promise<IteratorResult<string>>(() => { /* hangs forever */ }),
					return: returnFn,
				}
			},
		}

		await expect(async () => {
			for await (const _ of withFirstChunkTimeout(inner as AsyncIterable<string>, { timeoutMs: 50 })) { /* */ }
		}).rejects.toThrow(FirstChunkTimeoutError)

		expect(returnFn).toHaveBeenCalled()
	})

	it("should handle an already-aborted signal before starting", async () => {
		const ac = new AbortController()
		ac.abort(new DOMException("AlreadyCancelled", "AbortError"))
		const neverResolve = new Promise<IteratorResult<string>>(() => { /* never */ })
		const inner = {
			[Symbol.asyncIterator]() {
				return { next: () => neverResolve, return: vi.fn().mockResolvedValue({ value: undefined, done: true }) }
			},
		}

		await expect(async () => {
			for await (const _ of withFirstChunkTimeout(inner as AsyncIterable<string>, {
				timeoutMs: 5000, signal: ac.signal,
			})) { /* */ }
		}).rejects.toThrow("AlreadyCancelled")
	})
})
