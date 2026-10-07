import { describe, expect, it } from "vitest"
import { commanderToParsedArgs, createProgram } from "./program"

/**
 * `--bare` is only meaningful if it reaches the resolver before any config is
 * read. These pin the flag side; the filtering itself is covered in
 * `sdk/packages/shared/src/storage/bare-mode.test.ts`.
 */
describe("--bare flag", () => {
	const parse = (argv: string[]) =>
		commanderToParsedArgs(createProgram().parse(argv, { from: "user" }))

	it("is absent unless passed", () => {
		expect(parse([]).bare).toBeUndefined()
	})

	it("sets the flag when passed", () => {
		expect(parse(["--bare"]).bare).toBe(true)
	})

	it("documents what it suppresses and what it keeps", () => {
		// A flag that silently changed session persistence would be worse than one
		// that did not exist, so the help text has to state the boundary.
		const help = createProgram().helpInformation()
		expect(help).toContain("--bare")
		expect(help).toContain("repository")
	})
})
