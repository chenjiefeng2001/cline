import { describe, it, expect, vi, beforeEach } from "vitest"
import { Logger, type LogOutputChannel } from "./Logger"

describe("Logger", () => {
	beforeEach(() => {
		// Reset internal state
		Logger["subscribers"].clear()
		Logger.setOutputChannel(null)
	})

	it("should deliver messages to subscribers", () => {
		const fn = vi.fn()
		const sub = Logger.subscribe(fn)
		Logger.info("hello")
		expect(fn).toHaveBeenCalledWith(expect.stringContaining("hello"))
		sub.dispose()
	})

	it("should unregister subscribers on dispose", () => {
		const fn = vi.fn()
		const sub = Logger.subscribe(fn)
		sub.dispose()
		Logger.info("hello")
		expect(fn).not.toHaveBeenCalled()
	})

	it("should route messages through LogOutputChannel with correct level", () => {
		const ch: LogOutputChannel = {
			trace: vi.fn(),
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		}
		Logger.setOutputChannel(ch)

		Logger.error("err msg")
		expect(ch.error).toHaveBeenCalledWith(expect.stringContaining("err msg"))

		Logger.warn("warn msg")
		expect(ch.warn).toHaveBeenCalledWith(expect.stringContaining("warn msg"))

		Logger.info("info msg")
		expect(ch.info).toHaveBeenCalledWith(expect.stringContaining("info msg"))

		Logger.debug("dbg msg")
		expect(ch.debug).toHaveBeenCalledWith(expect.stringContaining("dbg msg"))
	})

	it("should not fail when outputChannel throws", () => {
		const ch: LogOutputChannel = {
			trace: vi.fn(() => { throw new Error("channel fail") }),
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		}
		Logger.setOutputChannel(ch)

		// Should not throw
		expect(() => Logger.info("test")).not.toThrow()
	})

	it("should set null outputChannel to disable LogOutputChannel routing", () => {
		const ch: LogOutputChannel = {
			trace: vi.fn(),
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		}
		Logger.setOutputChannel(ch)
		Logger.setOutputChannel(null)

		Logger.info("message")
		expect(ch.info).not.toHaveBeenCalled()
	})
})
