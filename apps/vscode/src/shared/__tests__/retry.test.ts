import { describe, expect, it, vi } from "vitest"
import { classifyError, executeWithRetry } from "@/shared/retry"

describe("classifyError", () => {
	it("classifies 429 as rateLimit", () => {
		expect(classifyError({ status: 429 })).toBe("rateLimit")
	})

	it("classifies 5xx as serverError", () => {
		expect(classifyError({ status: 500 })).toBe("serverError")
		expect(classifyError({ status: 503 })).toBe("serverError")
	})

	it("classifies 4xx (non-429) as clientError", () => {
		expect(classifyError({ status: 400 })).toBe("clientError")
		expect(classifyError({ status: 403 })).toBe("clientError")
		expect(classifyError({ status: 404 })).toBe("clientError")
	})

	it("classifies network errors", () => {
		expect(classifyError({ code: "ENOTFOUND" })).toBe("networkError")
		expect(classifyError({ code: "ECONNREFUSED" })).toBe("networkError")
		expect(classifyError({ code: "ETIMEDOUT" })).toBe("networkError")
	})

	it("classifies AbortError as networkError", () => {
		expect(classifyError({ name: "AbortError" })).toBe("networkError")
		expect(classifyError({ name: "TIMEOUT" })).toBe("networkError")
	})

	it("returns unknown for unrecognized errors", () => {
		expect(classifyError({})).toBe("unknown")
		expect(classifyError("string error")).toBe("unknown")
	})
})

describe("executeWithRetry", () => {
	it("returns the result on success", async () => {
		const fn = vi.fn().mockResolvedValue("ok")
		const result = await executeWithRetry(fn, undefined, "test")
		expect(result).toBe("ok")
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("retries on network error and succeeds", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce({ code: "ECONNREFUSED" })
			.mockResolvedValueOnce("ok")

		const result = await executeWithRetry(fn, undefined, "test")
		expect(result).toBe("ok")
		expect(fn).toHaveBeenCalledTimes(2)
	})

	it("throws after exhausting attempts", async () => {
		const error = { code: "ECONNREFUSED" }
		const fn = vi.fn().mockRejectedValue(error)

		await expect(executeWithRetry(fn, undefined, "test")).rejects.toBe(error)
		expect(fn).toHaveBeenCalledTimes(3) // networkError maxAttempts = 3
	})

	it("does not retry client errors", async () => {
		const error = { status: 400 }
		const fn = vi.fn().mockRejectedValue(error)

		await expect(executeWithRetry(fn, undefined, "test")).rejects.toBe(error)
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("uses custom classifier", async () => {
		const customClassifier = vi.fn().mockReturnValue("rateLimit")
		const fn = vi.fn().mockRejectedValue({ status: 500 })

		await expect(executeWithRetry(fn, customClassifier, "test")).rejects.toThrow()
		expect(customClassifier).toHaveBeenCalled()
	})
})