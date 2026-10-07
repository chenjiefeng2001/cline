import { describe, expect, it, vi } from "vitest";
import { SubAgentRunRegistry } from "./subagent-run-registry";
import { createSubAgentRunsTool } from "./subagent-runs-tool";

function setup() {
	const runs = new SubAgentRunRegistry();
	const tool = createSubAgentRunsTool(runs);
	const call = async (input: unknown) =>
		(await tool.execute(input as never, {} as never)) as Record<string, never>;
	return { runs, tool, call };
}

function startRun(runs: SubAgentRunRegistry, label = "reviewer") {
	return runs.start({
		subAgentId: `agent_${label}`,
		conversationId: "conv_1",
		label,
		task: "review the diff",
	});
}

describe("subagent_runs tool", () => {
	it("lists runs with their status", async () => {
		const { runs, call } = setup();
		const record = startRun(runs);
		const out = await call({ action: "list" });
		const listed = (out as unknown as { runs: { runId: string }[] }).runs;
		expect(listed).toHaveLength(1);
		expect(listed[0].runId).toBe(record.runId);
	});

	it("omits result text from a listing so status stays cheap", async () => {
		// A long result in a listing would defeat the purpose of listing.
		const { runs, call } = setup();
		const record = startRun(runs);
		runs.complete(record.runId, { text: "x".repeat(5000) });
		const out = (await call({ action: "list" })) as unknown as {
			runs: Record<string, unknown>[];
		};
		expect(out.runs[0]).not.toHaveProperty("resultText");
	});

	it("includes the result on an explicit read", async () => {
		const { runs, call } = setup();
		const record = startRun(runs);
		runs.complete(record.runId, { text: "found 3 issues" });
		const out = (await call({
			action: "read",
			runId: record.runId,
			includeResult: true,
		})) as unknown as { run: { resultText?: string } };
		expect(out.run.resultText).toBe("found 3 issues");
	});

	it("omits the result on read unless asked, since it can be large", async () => {
		const { runs, call } = setup();
		const record = startRun(runs);
		runs.complete(record.runId, { text: "found 3 issues" });
		const out = (await call({ action: "read", runId: record.runId })) as unknown as {
			run: Record<string, unknown>;
		};
		expect(out.run).not.toHaveProperty("resultText");
		expect(out.run.status).toBe("completed");
	});

	it("reports an unknown run rather than an empty success", async () => {
		// An empty object would read as "no runs", hiding a typo'd runId.
		const { call } = setup();
		expect(await call({ action: "read", runId: "subrun_99999" })).toHaveProperty(
			"error",
		);
	});

	it("waits for a running run and returns its result", async () => {
		const { runs, call } = setup();
		const record = startRun(runs);
		setTimeout(() => runs.complete(record.runId, { text: "late answer" }), 10);
		const out = (await call({
			action: "await",
			runId: record.runId,
			includeResult: true,
		})) as unknown as { run: { resultText?: string }; stillRunning?: boolean };
		expect(out.run.resultText).toBe("late answer");
		expect(out.stillRunning).toBe(false);
	});

	it("says so when a run is still going after the timeout", async () => {
		// Distinguishing "timed out" from "finished" is what lets the model decide
		// whether to keep working or wait again.
		const { runs, call } = setup();
		const record = startRun(runs);
		const out = (await call({
			action: "await",
			runId: record.runId,
			timeoutMs: 10,
		})) as unknown as { stillRunning?: boolean };
		expect(out.stillRunning).toBe(true);
	});

	it("prunes finished records on request", async () => {
		const { runs, call } = setup();
		const done = startRun(runs, "done");
		runs.complete(done.runId, { text: "x" });
		const running = startRun(runs, "running");
		expect(await call({ action: "prune" })).toEqual({ pruned: 1 });
		expect(runs.get(running.runId)?.status).toBe("running");
	});

	it("reports whether anything is still running", async () => {
		const { runs, call } = setup();
		expect(await call({ action: "list" })).toMatchObject({ running: false });
		const record = startRun(runs);
		expect(await call({ action: "list" })).toMatchObject({ running: true });
		runs.complete(record.runId, { text: "x" });
		expect(await call({ action: "list" })).toMatchObject({ running: false });
	});

	it("advertises every action in its schema", () => {
		// An action the model cannot see is an action it will never call.
		const { tool } = setup();
		const schema = JSON.stringify(tool.inputSchema);
		for (const action of ["list", "read", "await", "prune"]) {
			expect(schema).toContain(action);
		}
	});

	it("says in its description that results are not delivered automatically", async () => {
		// The single most important sentence for a model that just backgrounded
		// work: nothing will arrive unless it reads the result.
		const { tool } = setup();
		expect(tool.description).toMatch(/not delivered/i);
	});

	it("rejects a read with no runId rather than returning everything", async () => {
		const { runs, call } = setup();
		const record = startRun(runs);
		runs.complete(record.runId, { text: "secret-ish" });
		await expect(call({ action: "read" })).rejects.toThrow();
	});
});