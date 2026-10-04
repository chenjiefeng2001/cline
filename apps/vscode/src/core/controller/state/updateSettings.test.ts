import { describe, expect, it, vi } from "vitest"
import type { Controller } from ".."
import { updateSettings } from "./updateSettings"

/**
 * The guardrails, safety boundaries and feature switches below were all already
 * read into `CoreSessionConfig` — the session behaved as if they were configured.
 * But nothing in `UpdateSettingsRequest` carried them, so the settings dialog had
 * no way to write them and a user could only change them by hand-editing global
 * state. These tests pin the write side, including the cases where a bad value
 * must be rejected rather than stored.
 */
function makeController(initial: Record<string, unknown> = {}) {
	const store: Record<string, unknown> = { ...initial }
	return {
		store,
		postStateToWebview: vi.fn(),
		applyDefaultModelAndProvider: vi.fn(),
		handleTerminalExecutionModeChanged: vi.fn(),
		stateManager: {
			setGlobalState: vi.fn((key: string, value: unknown) => {
				store[key] = value
			}),
			getGlobalState: vi.fn((key: string) => store[key]),
			setGlobalSettings: vi.fn(),
		},
	}
}

async function run(controller: unknown, request: Record<string, unknown>) {
	// biome-ignore lint/suspicious/noExplicitAny: a partial Controller stub is the
	// point — these handlers only touch `stateManager`.
	await updateSettings(controller as Controller, request as never)
	return (controller as ReturnType<typeof makeController>).store
}

describe("updateSettings guardrails and safety boundaries", () => {
	it("stores 0 for maxIterationsSetting rather than treating it as unset", async () => {
		// 0 means "no limit". A falsy check here would drop it and leave the
		// default in place, so the dialog would read as unlimited while the run
		// was still capped.
		const controller = makeController()
		const store = await run(controller, { maxIterationsSetting: 0 })
		expect(store.maxIterationsSetting).toBe(0)
	})

	it("stores a positive maxIterationsSetting", async () => {
		const store = await run(makeController(), { maxIterationsSetting: 25 })
		expect(store.maxIterationsSetting).toBe(25)
	})

	it("ignores a negative maxIterationsSetting", async () => {
		const store = await run(makeController(), { maxIterationsSetting: -1 })
		expect(store.maxIterationsSetting).toBeUndefined()
	})

	it("requires at least 1 for maxParallelToolCalls", async () => {
		// 0 workers would disable dispatch entirely; the documented escape hatch
		// back to serial execution is 1, not 0.
		expect((await run(makeController(), { maxParallelToolCalls: 1 })).maxParallelToolCalls).toBe(1)

		const bad = await run(makeController(), { maxParallelToolCalls: 0 })
		expect(bad.maxParallelToolCalls).toBeUndefined()
	})

	it("allows 0 for runBudgetMaxTotalCost to mean no ceiling", async () => {
		expect((await run(makeController(), { runBudgetMaxTotalCost: 0 })).runBudgetMaxTotalCost).toBe(0)

		// Negative spend is meaningless and must not be stored.
		const bad = await run(makeController(), { runBudgetMaxTotalCost: -5 })
		expect(bad.runBudgetMaxTotalCost).toBeUndefined()
	})

	it("stores the file boundary switch and its extra roots", async () => {
		const off = await run(makeController(), {
			fileBoundaryEnabled: false,
			fileBoundaryAdditionalRoots: "/a,/b",
		})
		expect(off.fileBoundaryEnabled).toBe(false)
		expect(off.fileBoundaryAdditionalRoots).toBe("/a,/b")
	})

	it("stores each memory switch independently", async () => {
		// The write paths retain data outside the conversation, so the switches are
		// not derived from a master flag.
		const store = await run(makeController(), {
			memoryEnabled: true,
			memoryRecallEnabled: true,
			memoryWriteEnabled: false,
			memoryAutoCaptureEnabled: true,
		})
		expect(store.memoryEnabled).toBe(true)
		expect(store.memoryRecallEnabled).toBe(true)
		expect(store.memoryWriteEnabled).toBe(false)
		expect(store.memoryAutoCaptureEnabled).toBe(true)
	})

	it("stores the web search egress settings", async () => {
		const store = await run(makeController(), {
			webSearchEnabled: true,
			webSearchProvider: "exa",
			webSearchApiKey: "secret",
			webSearchEngineId: "engine",
			webSearchMaxResults: 8,
		})
		expect(store.webSearchEnabled).toBe(true)
		expect(store.webSearchProvider).toBe("exa")
		expect(store.webSearchApiKey).toBe("secret")
		expect(store.webSearchEngineId).toBe("engine")
		expect(store.webSearchMaxResults).toBe(8)
	})

	it("rejects a non-positive webSearchMaxResults", async () => {
		const store = await run(makeController(), { webSearchMaxResults: 0 })
		expect(store.webSearchMaxResults).toBeUndefined()
	})

	it("leaves untouched switches alone when the request omits them", async () => {
		// Partial updates must not clobber settings the dialog did not send.
		const controller = makeController({ memoryWriteEnabled: true, fileBoundaryEnabled: true })
		const store = await run(controller, { webSearchEnabled: true })
		expect(store.memoryWriteEnabled).toBe(true)
		expect(store.fileBoundaryEnabled).toBe(true)
	})
})
