import { describe, it, expect, vi } from "vitest"
import { CompositeDisposable } from "./disposable"

describe("CompositeDisposable", () => {
	it("should run teardown callbacks in LIFO order (reverse registration order)", () => {
		const order: number[] = []

		const c = new CompositeDisposable()
		c.add(() => order.push(1))
		c.add(() => order.push(2))
		c.add(() => order.push(3))
		c.dispose()

		// LIFO: last registered runs first
		expect(order).toEqual([3, 2, 1])
	})

	it("should be idempotent (dispose twice is safe)", () => {
		const fn = vi.fn()

		const c = new CompositeDisposable()
		c.add(fn)
		c.dispose()
		c.dispose()

		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("should handle object-shaped disposables ( { dispose() } )", () => {
		const fn = vi.fn()

		const c = new CompositeDisposable()
		c.add({ dispose: fn })
		c.dispose()

		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("should guard against one callback throwing (others still run)", () => {
		const fn1 = vi.fn(() => { throw new Error("boom") })
		const fn2 = vi.fn()

		const c = new CompositeDisposable()
		c.add(fn1)
		c.add(fn2)
		c.dispose()

		// Both should have been called; no uncaught exception
		expect(fn1).toHaveBeenCalledTimes(1)
		expect(fn2).toHaveBeenCalledTimes(1)
	})

	it("should report disposed=true after dispose()", () => {
		const c = new CompositeDisposable()
		expect(c.disposed).toBe(false)
		c.dispose()
		expect(c.disposed).toBe(true)
	})

	it("should immediately dispose items added after dispose()", () => {
		const fn = vi.fn()

		const c = new CompositeDisposable()
		c.dispose()
		c.add(fn)

		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("should allow removing a callback before dispose", () => {
		const fn = vi.fn()

		const c = new CompositeDisposable()
		c.add(fn)
		c.remove(fn)
		c.dispose()

		expect(fn).not.toHaveBeenCalled()
	})
})
