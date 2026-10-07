import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		exclude: ["src/**/*.e2e.test.ts"],
		// Same budget `@cline/core` already sets, for the same reason: several
		// suites here do real work rather than pure assertions. `withSqliteBusyRetry`
		// deliberately sleeps through a backoff (50ms base, 3 retries, so ~350ms in
		// the exhausted case), and `ensureSessionSchema` migrates a legacy table in
		// place. Measured on an idle machine the slowest test is ~450ms, which is 11x
		// headroom against vitest's 5s default -- and on a loaded Windows runner that
		// margin is not enough, producing failures that move between unrelated tests
		// from run to run. A timeout raised on evidence is a fix; one raised to make a
		// red build green is not, so the numbers are recorded here rather than a
		// bare number.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
