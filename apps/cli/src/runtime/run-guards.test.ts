import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CLI_DEFAULT_MAX_ITERATIONS,
	CLI_DEFAULT_MAX_TOTAL_COST_USD,
	RUN_GUARD_ENV_KEYS,
	guardOverridesFromArgs,
	readRunGuardEnv,
	resolveRunGuards,
} from "./run-guards";

/**
 * These guardrails exist because ACP shipped without them: the same agent had a
 * 50-iteration, $5 ceiling in the terminal and no ceiling at all inside an IDE.
 * The defaults therefore live in exactly one module, and these tests lock both
 * the resolution rules and the fact that both entry points still route through
 * it — a test that only checked the resolver would keep passing after someone
 * re-inlined a literal into one of the hosts.
 */
describe("resolveRunGuards", () => {
	it("applies the shared defaults when nothing is configured", () => {
		expect(resolveRunGuards()).toEqual({
			maxIterations: CLI_DEFAULT_MAX_ITERATIONS,
			budget: { maxTotalCost: CLI_DEFAULT_MAX_TOTAL_COST_USD },
		});
		expect(CLI_DEFAULT_MAX_ITERATIONS).toBe(50);
		expect(CLI_DEFAULT_MAX_TOTAL_COST_USD).toBe(5);
	});

	it("lets explicit configuration win over the defaults", () => {
		expect(
			resolveRunGuards({ maxIterations: 12, runBudgetMaxTotalCost: 25 }),
		).toEqual({ maxIterations: 12, budget: { maxTotalCost: 25 } });
	});

	it("keeps a ceiling for malformed or non-positive values", () => {
		// The failure mode to avoid is a typo silently removing the guard, so every
		// rejected value falls back to the default rather than being dropped.
		for (const bad of [
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"abc",
			"",
			null,
			undefined,
		]) {
			expect(
				resolveRunGuards({
					maxIterations: bad as never,
					runBudgetMaxTotalCost: bad as never,
				}),
				`input ${String(bad)}`,
			).toEqual({
				maxIterations: CLI_DEFAULT_MAX_ITERATIONS,
				budget: { maxTotalCost: CLI_DEFAULT_MAX_TOTAL_COST_USD },
			});
		}
	});

	it("never emits a budget the runtime would reject", () => {
		// AgentRunBudget validates maxTotalCost as a positive finite number and
		// maxIterations as a positive integer; anything else throws at config build
		// time, which would surface to the user as a crash instead of a guard.
		for (const [iterations, cost] of [
			[1, 0.01],
			[2.7, 0.5],
			[1000, 100],
		] as const) {
			const resolved = resolveRunGuards({
				maxIterations: iterations,
				runBudgetMaxTotalCost: cost,
			});
			expect(Number.isInteger(resolved.maxIterations)).toBe(true);
			expect(resolved.maxIterations).toBeGreaterThan(0);
			expect(Number.isFinite(resolved.budget.maxTotalCost)).toBe(true);
			expect(resolved.budget.maxTotalCost).toBeGreaterThan(0);
		}
	});

	it("floors a fractional iteration count instead of passing it through", () => {
		expect(resolveRunGuards({ maxIterations: 7.9 }).maxIterations).toBe(7);
	});
});

describe("readRunGuardEnv", () => {
	it("reads overrides from the documented env keys", () => {
		expect(
			readRunGuardEnv({
				[RUN_GUARD_ENV_KEYS.maxIterations]: "8",
				[RUN_GUARD_ENV_KEYS.maxTotalCost]: "1.5",
			}),
		).toEqual({ maxIterations: 8, runBudgetMaxTotalCost: 1.5 });
	});

	it("treats blank values as absent rather than as zero", () => {
		// Number("") is 0, which would otherwise read as "unlimited" intent and
		// then be rejected as invalid anyway; keeping it undefined lets the
		// resolver apply the default for the right reason.
		expect(
			readRunGuardEnv({
				[RUN_GUARD_ENV_KEYS.maxIterations]: "  ",
				[RUN_GUARD_ENV_KEYS.maxTotalCost]: "",
			}),
		).toEqual({});
	});

	it("resolves to defaults when the environment is empty", () => {
		expect(resolveRunGuards(readRunGuardEnv({}))).toEqual(
			resolveRunGuards(),
		);
	});
});

describe("guardOverridesFromArgs", () => {
	it("passes only the guard fields through", () => {
		expect(
			guardOverridesFromArgs({
				maxIterations: 3,
				runBudgetMaxTotalCost: 9,
				// Extra flag-parser fields must not leak into the guard block.
				verbose: true,
			} as never),
		).toEqual({ maxIterations: 3, runBudgetMaxTotalCost: 9 });
	});
});

describe("CLI/ACP guardrail parity", () => {
	const srcDir = join(import.meta.dirname, "..");

	function readSource(relative: string): string {
		return readFileSync(join(srcDir, relative), "utf-8");
	}

	it("routes both entry points through the shared resolver", () => {
		// The drift guard: a host that re-inlines its own numbers would still pass
		// every resolver test above while shipping a different ceiling.
		for (const entry of ["main.ts", join("acp", "acpAgent.ts")]) {
			const source = readSource(entry);
			expect(source, entry).toContain("resolveRunGuards");
			expect(source, entry).not.toMatch(/maxIterations:\s*args\.maxIterations\s*\?\?\s*\d/);
			expect(source, entry).not.toMatch(/maxTotalCost:\s*args\.runBudgetMaxTotalCost\s*\?\?\s*\d/);
		}
	});

	it("keeps both hosts on one set of numeric defaults", () => {
		const sources = [readSource("main.ts"), readSource(join("acp", "acpAgent.ts"))];
		for (const source of sources) {
			expect(source).not.toMatch(/\bmaxIterations:\s*\d+/);
			expect(source).not.toMatch(/maxTotalCost:\s*\d+/);
		}
	});

	it("does not let either host shadow the spread guard block", () => {
		// A later `maxIterations:`/`budget:` key in the same object literal would win
		// over the spread and silently restore an unbounded run, which is exactly the
		// bug class this refactor exists to remove.
		for (const entry of ["main.ts", join("acp", "acpAgent.ts")]) {
			const source = readSource(entry);
			expect(source, entry).toMatch(/\.\.\.resolveRunGuards\(/);
			expect(source, entry).not.toMatch(/^\s*maxIterations:\s*(?!undefined)/m);
			expect(source, entry).not.toMatch(/^\s*budget:\s*\{/m);
		}
	});
});