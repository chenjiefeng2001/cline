import { describe, expect, it } from "vitest"
import { createAgentRuntime } from "@cline/agents"
import { ScriptedModel } from "./agent-conformance"
import type { AgentModelEvent } from "@cline/shared"

/**
 * Run limits are outcomes, not failures.
 *
 * Two defects sat behind `Agent runtime exceeded maxIterations (50)`:
 *
 *   - the budget path finished gracefully with a first-class status while the
 *     iteration cap threw and surfaced as `failed`, so an ordinary boundary was
 *     reported as a crash
 *   - nothing anywhere detected a tool returning an identical result every turn, so a
 *     deterministically failing tool - a missing credential, a misconfiguration - could
 *     only be stopped by the cap, and was indistinguishable from a task that genuinely
 *     needed more room
 *
 * The changing-result case is the control. Without it, the stall detector is just a
 * turn counter and the first two cases would prove nothing.
 */
function callEvents(): AgentModelEvent[] {
	return [
		{ type: "tool-call-delta", toolCallId: "c1", toolName: "echo", inputText: "{}" },
		{ type: "finish", reason: "tool-calls" },
	]
}

function runtime(result: () => unknown, maxIterations: number) {
	let calls = 0
	const r = createAgentRuntime({
		sessionId: "s",
		agentId: "a",
		conversationId: "c",
		model: new ScriptedModel(
			Array.from({ length: maxIterations + 8 }, () => () => callEvents()),
		),
		tools: [
			{
				name: "echo",
				description: "probe",
				inputSchema: { type: "object" },
				execute: async () => {
					calls++
					return result()
				},
			},
		],
		maxIterations,
	})
	return { runtime: r, calls: () => calls }
}

describe("run limits are outcomes, not failures", () => {
	it("reports hitting the iteration cap as max_iterations, keeping the transcript", async () => {
		let n = 0
		const { runtime: r } = runtime(() => ({ n: ++n }), 5)
		const result = await r.run("go")
		expect(result.status).toBe("max_iterations")
		expect(result.status).not.toBe("failed")
		// The work done before the cap is still there.
		expect(r.snapshot().messages.length).toBeGreaterThan(0)
	})

	it("stops a deterministically failing tool at three repeats, long before the cap", async () => {
		// The shape that motivated this: a tool reporting a missing credential forever.
		// Retrying cannot help, so 50 iterations of it is 50 wasted turns.
		const { runtime: r, calls } = runtime(() => "no API key is available", 50)
		const result = await r.run("go")
		expect(result.status).toBe("no_progress")
		expect(calls()).toBe(3)
	})

	it("does not stop a tool whose result keeps changing", async () => {
		let n = 0
		const { runtime: r, calls } = runtime(() => ({ n: ++n }), 50)
		await r.run("go")
		expect(calls()).toBe(50)
	})

	it("treats reordered keys as the same result", async () => {
		// Key order must not disguise an identical result as a new one.
		let n = 0
		const { runtime: r, calls } = runtime(
			() => (++n % 2 ? { a: 1, b: 2 } : { b: 2, a: 1 }),
			50,
		)
		await r.run("go")
		expect(calls()).toBe(3)
	})

	it("names the stalled tool so the cause is not a mystery", async () => {
		const { runtime: r } = runtime(() => "same", 50)
		const result = await r.run("go")
		expect(result.outputText ?? "").toContain("echo")
		expect(result.outputText ?? "").toContain("3 times")
	})
})
