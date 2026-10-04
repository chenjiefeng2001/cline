/**
 * Run guardrails shared by every CLI-hosted entry point.
 *
 * The runtime has always supported `maxIterations` and `AgentRunBudget`
 * (`max_iterations` and `budget_exhausted` are finish reasons, not crashes), but
 * each host had to remember to wire them. The CLI's own path did; the ACP path
 * (`acp/buildConfig`) did not, which meant the same agent had a spend ceiling in
 * a terminal and none inside an IDE. That asymmetry is a reliability problem,
 * not a parity cosmetic, so the defaults live here once and both hosts resolve
 * through the same function.
 *
 * The values intentionally match the VS Code extension
 * (`cline-session-factory.ts`): 50 model round-trips and $5 of spend for a single
 * run. `docs/…/agent-capability-matrix-2026-10-03.md` §1.4 records the three
 * hosts' posture side by side, and `run-guards.test.ts` locks the CLI/ACP pair so
 * the two cannot drift apart again.
 */
export const CLI_DEFAULT_MAX_ITERATIONS = 50;

/**
 * Cost only, matching the extension. A token cap would fight the user's own
 * context-window choice, whereas spend is the thing that cannot be undone.
 */
export const CLI_DEFAULT_MAX_TOTAL_COST_USD = 5;

/** Env overrides, so an ACP/IDE session can be bounded without CLI flags. */
export const RUN_GUARD_ENV_KEYS = {
	maxIterations: "CLINE_MAX_ITERATIONS",
	maxTotalCost: "CLINE_MAX_BUDGET_USD",
} as const;

export interface RunGuardOverrides {
	maxIterations?: number;
	runBudgetMaxTotalCost?: number;
}

export interface ResolvedRunGuards {
	maxIterations: number;
	budget: { maxTotalCost: number };
}

/**
 * Accept only values the runtime will actually honour.
 *
 * `maxTotalCost` is validated by the SDK as a positive finite number and
 * `maxIterations` must be a positive integer, so anything else has to be
 * rejected here. A malformed value falls back to the default rather than being
 * dropped, because "the user typo'd an env var" must never mean "no ceiling".
 * There is deliberately no `0 = unlimited` path on the CLI side: the flags reject
 * it (`commands/program.ts`), and unlike the extension there is no UI promising
 * that 0 removes the ceiling.
 */
function positiveInteger(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number(String(value).trim());
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	const floored = Math.floor(parsed);
	return floored > 0 ? floored : fallback;
}

function positiveFinite(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number(String(value).trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the guardrail block for a run.
 *
 * Overrides win over defaults, and defaults always win over nothing: there is no
 * way to end up with an unbounded run through this function.
 */
export function resolveRunGuards(overrides: RunGuardOverrides = {}): ResolvedRunGuards {
	return {
		maxIterations: positiveInteger(
			overrides.maxIterations,
			CLI_DEFAULT_MAX_ITERATIONS,
		),
		budget: {
			maxTotalCost: positiveFinite(
				overrides.runBudgetMaxTotalCost,
				CLI_DEFAULT_MAX_TOTAL_COST_USD,
			),
		},
	};
}

/**
 * Read guardrail overrides from the environment for entry points that have no
 * flag parser (ACP). Malformed values are passed through untouched so that
 * {@link resolveRunGuards} — not the environment reader — owns the validation
 * and the fallback, keeping one set of rules.
 */
export function readRunGuardEnv(
	env: NodeJS.ProcessEnv = process.env,
): RunGuardOverrides {
	const overrides: RunGuardOverrides = {};
	const rawIterations = env[RUN_GUARD_ENV_KEYS.maxIterations];
	if (rawIterations !== undefined && String(rawIterations).trim() !== "") {
		overrides.maxIterations = Number(rawIterations);
	}
	const rawCost = env[RUN_GUARD_ENV_KEYS.maxTotalCost];
	if (rawCost !== undefined && String(rawCost).trim() !== "") {
		overrides.runBudgetMaxTotalCost = Number(rawCost);
	}
	return overrides;
}

/**
 * Narrow a parsed CLI arg bag down to the guard fields this module consumes.
 *
 * Typed structurally rather than as `Pick<Config, …>` because the two fields
 * arrive from different shapes: `maxIterations` is part of the persisted runtime
 * `Config`, while `runBudgetMaxTotalCost` is produced by the flag parser into
 * `ParsedArgs`. Only the two optional numbers matter here.
 */
export function guardOverridesFromArgs(args: {
	maxIterations?: number;
	runBudgetMaxTotalCost?: number;
}): RunGuardOverrides {
	return {
		maxIterations: args.maxIterations,
		runBudgetMaxTotalCost: args.runBudgetMaxTotalCost,
	};
}