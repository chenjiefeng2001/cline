/**
 * PR gate for the deterministic agent conformance contract.
 *
 * Two responsibilities:
 *
 * 1. Run every case and assert the behavioural guarantee it names. These are
 *    offline and scripted, so a failure is a behaviour change, not noise.
 * 2. Assert the registry still matches `conformance-baseline.json`. Without
 *    this, deleting a case would turn the gate green, which is the one failure
 *    mode a regression gate must not have.
 */

import { describe, expect, it } from "vitest";
import { CONFORMANCE_CASES, toolResults } from "./agent-conformance";
import baseline from "./conformance-baseline.json";

interface BaselineShape {
	version: number;
	cases: Array<{ id: string; boundary: string; guarantee: string }>;
}

const pinned = baseline as BaselineShape;

describe("agent conformance baseline", () => {
	it("pins every registered case and nothing else", () => {
		const registeredIds = CONFORMANCE_CASES.map(
			(testCase) => testCase.id,
		).sort();
		const pinnedIds = pinned.cases.map((entry) => entry.id).sort();
		expect(registeredIds).toEqual(pinnedIds);
	});

	it("has no duplicate case ids", () => {
		const ids = CONFORMANCE_CASES.map((testCase) => testCase.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("keeps each pinned boundary and guarantee in sync with the case", () => {
		for (const entry of pinned.cases) {
			const registered = CONFORMANCE_CASES.find(
				(testCase) => testCase.id === entry.id,
			);
			expect(registered, entry.id).toBeDefined();
			expect(registered?.boundary, entry.id).toBe(entry.boundary);
			expect(registered?.guarantee, entry.id).toBe(entry.guarantee);
		}
	});
});

describe("agent conformance cases", () => {
	for (const testCase of CONFORMANCE_CASES) {
		it(`${testCase.id}: ${testCase.guarantee}`, async () => {
			const context = await testCase.run();
			expect(context).toBeDefined();
			assertCase(testCase.id, context);
		});
	}
});

function assertCase(
	id: string,
	context: Awaited<ReturnType<(typeof CONFORMANCE_CASES)[number]["run"]>>,
): void {
	switch (id) {
		case "tool-result-completeness-single-tool": {
			// The call produced a result in the transcript the provider will see,
			// and the loop continued normally afterwards.
			const results = toolResults(context.messages);
			expect(results).toHaveLength(1);
			expect(results[0]?.isError).not.toBe(true);
			expect(context.modelRequests).toHaveLength(2);
			return;
		}
		case "budget-stops-before-next-model-request": {
			// The cap was reached during the first turn: the tool still ran and
			// still produced a result, and no second request was paid for.
			expect(context.toolResultOutputs).toHaveLength(1);
			expect(context.modelRequests).toHaveLength(1);
			return;
		}
		case "budget-absent-does-not-gate": {
			// Unchanged behaviour: a second turn still happens.
			expect(context.modelRequests).toHaveLength(2);
			expect(context.outputText).toBe("done");
			return;
		}
		case "parallel-tool-batch-settles-before-run-ends": {
			// Both calls of the multi-tool turn produced a result, so the batch
			// settled rather than letting one answer go missing.
			expect(toolResults(context.messages)).toHaveLength(2);
			return;
		}
		case "tool-context-carries-stable-step-identity": {
			const stepId = context.toolContexts[0]?.stepId;
			expect(stepId).toMatch(/^step:[^:\s]+:\d+:\d+$/);
			return;
		}
		case "delegated-run-reports-its-agent-chain": {
			expect(context.toolContexts[0]).toMatchObject({
				agentId: "conformance-agent",
				parentAgentId: "conformance-parent",
				rootRunId: "conformance-root-run",
			});
			return;
		}
		case "lead-run-reports-no-agent-chain": {
			const observed = context.toolContexts[0];
			expect(observed?.parentAgentId).toBeUndefined();
			expect(observed?.rootRunId).toBeUndefined();
			return;
		}
		case "file-boundary-refuses-path-that-escapes-the-root": {
			// The decisive part: the tool never returned anything, and the model got
			// an error result instead. A boundary that ran after the read, or that
			// swallowed the refusal, would still hand over the contents.
			expect(context.toolResultOutputs).toHaveLength(0);
			const results = toolResults(context.messages);
			expect(results).toHaveLength(1);
			expect(results[0]?.isError).toBe(true);
			return;
		}
		case "file-boundary-honours-configured-additional-roots": {
			// The escape hatch is opt-in, not a loosening of the default: with the
			// directory listed, the tool resolves and returns the path. Before the
			// drive-qualification fix this was refused, because the target kept a
			// different base than the realpath'd root.
			expect(context.toolResultOutputs).toHaveLength(1);
			const results = toolResults(context.messages);
			expect(results).toHaveLength(1);
			expect(results[0]?.isError).not.toBe(true);
			const echoed = (context.toolResultOutputs[0] as { echoed: string }).echoed;
			expect(echoed).toMatch(/notes\.md$/);
			return;
		}
		default:
			throw new Error(
				`Conformance case ${id} has no assertion. Add one, or remove it from the registry and the baseline together.`,
			);
	}
}
