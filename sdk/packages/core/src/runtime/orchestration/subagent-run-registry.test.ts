import { describe, expect, it } from "vitest";
import {
	describeSubAgentRun,
	SubAgentRunRegistry,
} from "./subagent-run-registry";

function started(
	runs: SubAgentRunRegistry,
	overrides: Partial<{ label: string; task: string; subAgentId: string }> = {},
) {
	return runs.start({
		subAgentId: overrides.subAgentId ?? "agent_1",
		conversationId: "conv_1",
		label: overrides.label ?? "reviewer",
		task: overrides.task ?? "review the diff",
	});
}

describe("SubAgentRunRegistry", () => {
	it("reports a run as running before it settles", () => {
		const runs = new SubAgentRunRegistry();
		const record = started(runs);
		expect(runs.get(record.runId)?.status).toBe("running");
		expect(runs.hasRunning()).toBe(true);
	});

	it("stores a result so a later turn can read it", () => {
		const runs = new SubAgentRunRegistry();
		const record = started(runs);
		runs.complete(record.runId, {
			text: "found 3 issues",
			finishReason: "completed",
			iterations: 4,
			usage: { inputTokens: 100, outputTokens: 50 },
		});
		const read = runs.get(record.runId);
		expect(read?.status).toBe("completed");
		expect(read?.resultText).toBe("found 3 issues");
		// Token spend has to be visible, or a backgrounded run is invisible cost.
		expect(read?.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
		expect(runs.hasRunning()).toBe(false);
	});

	it("records a failure instead of losing it", () => {
		const runs = new SubAgentRunRegistry();
		const record = started(runs);
		runs.fail(record.runId, new Error("provider 401"));
		expect(runs.get(record.runId)).toMatchObject({
			status: "failed",
			error: "provider 401",
		});
	});

	it("truncates a very long result so it cannot flood a later turn", () => {
		const runs = new SubAgentRunRegistry();
		const record = started(runs);
		runs.complete(record.runId, { text: "x".repeat(10_000) });
		const text = runs.get(record.runId)?.resultText ?? "";
		expect(text.length).toBeLessThan(5000);
		expect(text).toContain("truncated");
	});

	it("keeps a result after the producing run is gone", () => {
		// The whole premise: a backgrounded run outlives the turn that started it.
		const runs = new SubAgentRunRegistry();
		const record = started(runs);
		runs.complete(record.runId, { text: "done" });
		expect(runs.list()).toHaveLength(1);
		expect(runs.get(record.runId)?.resultText).toBe("done");
	});

	it("resolves await() immediately for a settled run", async () => {
		const runs = new SubAgentRunRegistry();
		const record = started(runs);
		runs.complete(record.runId, { text: "done" });
		await expect(runs.await(record.runId, 50)).resolves.toMatchObject({
			status: "completed",
		});
	});

	it("resolves await() once a running run finishes", async () => {
		const runs = new SubAgentRunRegistry();
		const record = started(runs);
		setTimeout(() => runs.complete(record.runId, { text: "late" }), 10);
		const settled = await runs.await(record.runId, 1000);
		expect(settled?.resultText).toBe("late");
	});

	it("returns the current record when await() times out", async () => {
		// Timing out is not an error: the run may legitimately still be going.
		const runs = new SubAgentRunRegistry();
		const record = started(runs);
		const settled = await runs.await(record.runId, 10);
		expect(settled?.status).toBe("running");
	});

	it("resolves await() with undefined for an unknown run", async () => {
		const runs = new SubAgentRunRegistry();
		await expect(runs.await("nope")).resolves.toBeUndefined();
	});

	it("prunes finished records but keeps running ones", () => {
		const runs = new SubAgentRunRegistry();
		const done = started(runs);
		runs.complete(done.runId, { text: "x" });
		const stillRunning = started(runs, { label: "second" });
		expect(runs.pruneFinished()).toBe(1);
		expect(runs.get(done.runId)).toBeUndefined();
		expect(runs.get(stillRunning.runId)?.status).toBe("running");
	});

	it("gives each run a distinct id", () => {
		const runs = new SubAgentRunRegistry();
		const ids = new Set(
			Array.from({ length: 5 }, () => started(runs).runId),
		);
		expect(ids.size).toBe(5);
	});

	it("ignores completion of an unknown run", () => {
		const runs = new SubAgentRunRegistry();
		expect(() => runs.complete("nope", { text: "x" })).not.toThrow();
		expect(() => runs.fail("nope", new Error("x"))).not.toThrow();
	});
});

describe("describeSubAgentRun", () => {
	it("omits result text unless asked, keeping status listings small", () => {
		const runs = new SubAgentRunRegistry();
		const record = started(runs);
		runs.complete(record.runId, { text: "a long answer" });
		const full = runs.get(record.runId);
		expect(describeSubAgentRun(full!)).toMatchObject({ status: "completed" });
		expect(describeSubAgentRun({ ...full!, resultText: undefined })).not.toHaveProperty(
			"resultText",
		);
	});

	it("reports elapsed time for a finished run", () => {
		const runs = new SubAgentRunRegistry();
		const record = started(runs);
		runs.complete(record.runId, { text: "x" });
		const described = describeSubAgentRun(runs.get(record.runId)!) as {
			elapsedMs: number;
		};
		expect(described.elapsedMs).toBeGreaterThanOrEqual(0);
	});
});