import { describe, expect, it } from "vitest"
import { withLogContext, getLogContext, formatLogContext } from "@/shared/services/log-context"

describe("log-context", () => {
	describe("withLogContext / getLogContext", () => {
		it("provides context within the wrapped function", async () => {
			const result = await withLogContext({ taskId: "task_1" }, async () => {
				const ctx = getLogContext()
				return ctx?.taskId
			})
			expect(result).toBe("task_1")
		})

		it("returns undefined outside a context scope", () => {
			expect(getLogContext()).toBeUndefined()
		})

		it("nests contexts correctly", async () => {
			const result = await withLogContext({ taskId: "outer" }, async () => {
				const outer = getLogContext()?.taskId
				const inner = await withLogContext({ taskId: "inner" }, async () => {
					return getLogContext()?.taskId
				})
				return { outer, inner }
			})
			expect(result).toEqual({ outer: "outer", inner: "inner" })
		})
	})

	describe("formatLogContext", () => {
		it("formats a full context", () => {
			const formatted = formatLogContext({ taskId: "t1", sessionId: "s1", providerId: "anthropic" })
			expect(formatted).toContain("Task: t1")
			expect(formatted).toContain("Session: s1")
			expect(formatted).toContain("Provider: anthropic")
		})

		it("returns empty string for empty context", () => {
			expect(formatLogContext({})).toBe("")
		})

		it("handles partial context", () => {
			expect(formatLogContext({ taskId: "t1" })).toContain("Task: t1")
			expect(formatLogContext({ runId: "r1" })).toContain("Run: r1")
		})
	})
})