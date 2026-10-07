import { describe, expect, it } from "vitest";
import { commanderToParsedArgs, createProgram } from "./program";

/**
 * Same class of gap `--sandbox` had: the flag is only worth having if it reaches
 * the session config. Asserted here so a rename or a dropped option fails a test
 * rather than silently disabling the feature for every CLI user.
 */
describe("--lazy-tool-loading", () => {
	const parse = (argv: string[]) =>
		commanderToParsedArgs(createProgram().parse(argv, { from: "user" }));

	it("leaves lazy loading off by default", () => {
		expect(parse([]).lazyToolLoading).toBeUndefined();
	});

	it("sets the flag when passed", () => {
		expect(parse(["--lazy-tool-loading"]).lazyToolLoading).toBe(true);
	});

	it("documents the deferral in help text", () => {
		const help = createProgram().helpInformation();
		expect(help).toContain("--lazy-tool-loading");
		expect(help).toContain("tool_search");
	});
});