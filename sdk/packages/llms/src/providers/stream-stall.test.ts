import { describe, expect, it } from "vitest"

import {
	DEFAULT_STREAM_STALL_TIMEOUT_MS,
	StreamStalledError,
	withStallTimeout,
} from "./stream-stall"

/** An async iterable that yields `items`, then optionally stalls forever. */
function makeStream<T>(items: T[], options: { stallAfter?: boolean } = {}) {
	let index = 0
	return {
		[Symbol.asyncIterator]() {
			return {
				next(): Promise<IteratorResult<T>> {
					if (index < items.length) {
						return Promise.resolve({ done: false, value: items[index++] as T })
					}
					if (options.stallAfter) {
						return new Promise<IteratorResult<T>>(() => {})
					}
					return Promise.resolve({ done: true, value: undefined as never })
				},
				return(): Promise<IteratorResult<T>> {
					index = Number.POSITIVE_INFINITY
					return Promise.resolve({ done: true, value: undefined as never })
				},
			}
		},
	}
}

/** Resolves after `ms`, used to release a stalled stream from outside the guard. */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("withStallTimeout", () => {
	it("yields every item from a healthy stream", async () => {
		const out: string[] = []
		for await (const item of withStallTimeout(makeStream(["a", "b", "c"]), { stallTimeoutMs: 1_000 })) {
			out.push(item)
		}
		expect(out).toEqual(["a", "b", "c"])
	})

	it("yields an empty stream without stalling", async () => {
		const out: string[] = []
		for await (const item of withStallTimeout(makeStream<string>([]), { stallTimeoutMs: 1_000 })) {
			out.push(item)
		}
		expect(out).toEqual([])
	})

	it("yields output produced before the stall, then fails", async () => {
		// The shape in #10631: the model streams part of a response and then the
		// connection goes half-open. Whatever arrived before the silence must still be
		// delivered, otherwise the failure discards real output.
		const partial: string[] = [];
		const consume = async () => {
			for await (const item of withStallTimeout(makeStream(["half a ", "response"], { stallAfter: true }), {
				stallTimeoutMs: 50,
			})) {
				partial.push(item);
			}
		};

		await expect(consume()).rejects.toBeInstanceOf(StreamStalledError);
		expect(partial).toEqual(["half a ", "response"]);
	});

	it("throws StreamStalledError when no item arrives within the budget", async () => {
		const consume = async () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _ of withStallTimeout(makeStream(["first"], { stallAfter: true }), {
				stallTimeoutMs: 40,
			})) {
				// drain until the stall fires
			}
		}

		await expect(consume()).rejects.toBeInstanceOf(StreamStalledError)
	})

	it("reports the budget it actually enforced", async () => {
		const consume = async () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			for await (const _ of withStallTimeout(makeStream<string>([], { stallAfter: true }), {
				stallTimeoutMs: 35,
			})) {
				// never entered
			}
		}

		await expect(consume()).rejects.toMatchObject({ stallTimeoutMs: 35 })
	})

	it("does not fire while items keep arriving", async () => {
		// Each gap is well under the budget; the total span is over it. Measuring
		// activity rather than total duration is the whole point.
		const slow = {
			async *[Symbol.asyncIterator]() {
				for (const item of ["a", "b", "c", "d"]) {
					await wait(30)
					yield item
				}
			},
		}

		const out: string[] = []
		for await (const item of withStallTimeout(slow, { stallTimeoutMs: 90 })) {
			out.push(item)
		}
		expect(out).toEqual(["a", "b", "c", "d"])
	})

	it("treats a non-positive budget as disabled", async () => {
		const out: string[] = []
		for await (const item of withStallTimeout(makeStream(["x", "y"]), { stallTimeoutMs: 0 })) {
			out.push(item)
		}
		expect(out).toEqual(["x", "y"])
	})

	it("releases the underlying iterator when the consumer stops early", async () => {
		let returned = false
		const source = {
			[Symbol.asyncIterator]() {
				let index = 0
				return {
					next: () => Promise.resolve({ done: false, value: `item-${index++}` }),
					return: () => {
						returned = true
						return Promise.resolve({ done: true, value: undefined as never })
					},
				}
			},
		}

		for await (const item of withStallTimeout(source, { stallTimeoutMs: 1_000 })) {
			expect(item).toBe("item-0")
			break
		}

		expect(returned).toBe(true)
	})

	it("exposes a generous default so reasoning pauses are not cut off", () => {
		expect(DEFAULT_STREAM_STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
	})
})

describe("StreamStalledError", () => {
	it("is named so transient classification can key on it", () => {
		const err = new StreamStalledError(1_000)
		expect(err.name).toBe("StreamStalledError")
		expect(err.stallTimeoutMs).toBe(1_000)
	})
})