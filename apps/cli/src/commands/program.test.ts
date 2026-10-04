import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { commanderToParsedArgs } from "./program";

/**
 * The CLI is the only one of the three hosts that lets a run continue unbounded:
 * it accepted no iteration cap and no spend ceiling, so `--yolo "..."` could loop
 * and spend indefinitely with no way to stop it. These cover the parsing half of
 * that gap — validation lives in `main.ts`, which rejects the invalid* fields.
 */
function parse(opts: Record<string, unknown>) {
	return commanderToParsedArgs({
		opts: () => opts,
		args: [],
	} as unknown as Command);
}

describe("commanderToParsedArgs run limits", () => {
	it("leaves every limit unset when no flag is passed", () => {
		// Unset is meaningful: `main.ts` substitutes the host defaults
		// (50 / 5 / 6), so this must not pre-empt them with a different value.
		const parsed = parse({});
		expect(parsed.maxIterations).toBeUndefined();
		expect(parsed.runBudgetMaxTotalCost).toBeUndefined();
		expect(parsed.maxParallelToolCalls).toBeUndefined();
	});

	it("parses --max-iterations, --max-budget-usd and --max-parallel-tool-calls", () => {
		const parsed = parse({
			maxIterations: "12",
			maxBudgetUsd: "2.5",
			maxParallelToolCalls: "1",
		});
		expect(parsed.maxIterations).toBe(12);
		expect(parsed.runBudgetMaxTotalCost).toBe(2.5);
		expect(parsed.maxParallelToolCalls).toBe(1);
	});

	it("records invalid values instead of silently coercing them to a default", () => {
		// A bad flag must surface as an error, not as "50" — otherwise the user
		// believes they capped the run when they did not.
		const parsed = parse({
			maxIterations: "0",
			maxBudgetUsd: "-3",
			maxParallelToolCalls: "many",
		});
		expect(parsed.invalidMaxIterations).toBe("0");
		expect(parsed.invalidMaxBudgetUsd).toBe("-3");
		expect(parsed.invalidMaxParallelToolCalls).toBe("many");
		expect(parsed.maxIterations).toBeUndefined();
		expect(parsed.runBudgetMaxTotalCost).toBeUndefined();
		expect(parsed.maxParallelToolCalls).toBeUndefined();
	});

	it("treats 1 parallel tool call as valid", () => {
		// 1 is the documented "force serial" escape hatch, so the >= 1 lower bound
		// must not reject it.
		expect(parse({ maxParallelToolCalls: "1" }).maxParallelToolCalls).toBe(1);
	});

	it("ignores an empty value rather than reporting it as invalid", () => {
		const parsed = parse({ maxIterations: "   " });
		expect(parsed.invalidMaxIterations).toBeUndefined();
		expect(parsed.maxIterations).toBeUndefined();
	});
});