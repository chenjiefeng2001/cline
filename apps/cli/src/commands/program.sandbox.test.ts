import { describe, expect, it } from "vitest"
import { commanderToParsedArgs, createProgram } from "./program"

/**
 * The gap these guard against: `--sandbox` was declared, parsed into `ParsedArgs`,
 * and then never handed to the session config, so enabling it changed nothing.
 * A flag's reachability has to be asserted, not assumed.
 */
describe("--sandbox flag", () => {
	const parse = (argv: string[]) =>
		commanderToParsedArgs(createProgram().parse(argv, { from: "user" }))

	it("leaves the sandbox unset by default", () => {
		expect(parse([]).sandbox).toBeUndefined()
	})

	it("enables the sandbox without network access", () => {
		expect(parse(["--sandbox"]).sandbox).toEqual({
			enabled: true,
			networkAccess: false,
		})
	})

	it("enables the sandbox and allows network when asked", () => {
		expect(parse(["--sandbox-network"]).sandbox).toEqual({
			enabled: true,
			networkAccess: true,
		})
	})

	it("keeps data-dir isolation separate from the process sandbox", () => {
		// `--data-dir` relocates state; `--sandbox` confines the process. They were
		// once the same field, which is how a data-directory feature came to be
		// mistaken for a sandbox that was never wired.
		const parsed = parse(["--data-dir", "/tmp/state"])
		expect(parsed.isolatedState).toBe(true)
		expect(parsed.sandbox).toBeUndefined()
	})
})