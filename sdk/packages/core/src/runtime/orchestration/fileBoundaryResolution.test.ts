import { describe, expect, it } from "vitest"
import { resolveFileBoundary } from "./runtime-builder"

/**
 * The boundary has to be resolved from session config, not merely available.
 *
 * The executors accepted any absolute path for their whole life, and when the
 * boundary was first built it was still inert because nothing passed one down - the
 * option existed on the executors and no caller supplied it. These cases pin the
 * resolution so the "configured but not wired" shape cannot come back.
 */
describe("resolveFileBoundary", () => {
	it("is undefined when the host configured nothing", () => {
		// Presence is the opt-in. The extension only sets the key when the user has the
		// guard on, so an absent key and an explicit enabled:false are the two ways to be
		// unconstrained, and both must stay reachable from configuration.
		expect(resolveFileBoundary({}, "/repo")).toBeUndefined()
		expect(resolveFileBoundary({ fileBoundary: { enabled: false } }, "/repo")).toBeUndefined()
	})

	it("treats a present-but-empty config as opting in", () => {
		// `{}` means "on, with defaults", not "off". Anything else makes a host that
		// passes an empty object believe it enabled a guard that is not there.
		expect(resolveFileBoundary({ fileBoundary: {} }, "/repo")).toEqual({
			root: "/repo",
			additionalRoots: [],
		})
	})

	it("derives the root from workspaceRoot, falling back to cwd", () => {
		// workspaceRoot is the right root: a multi-root workspace spans folders under
		// it, whereas cwd can be a subdirectory of the session.
		expect(resolveFileBoundary({ fileBoundary: {}, workspaceRoot: "/ws" }, "/repo")).toEqual({
			root: "/ws",
			additionalRoots: [],
		})
		expect(resolveFileBoundary({ fileBoundary: {} }, "/repo")).toEqual({
			root: "/repo",
			additionalRoots: [],
		})
	})

	it("carries additional roots through", () => {
		expect(
			resolveFileBoundary(
				{ fileBoundary: { additionalRoots: ["/other", "/tmp/scratch"] }, workspaceRoot: "/ws" },
				"/repo",
			),
		).toEqual({ root: "/ws", additionalRoots: ["/other", "/tmp/scratch"] })
	})

	it("treats an explicit roots list as root-plus-extras, and honours its first entry", () => {
		expect(
			resolveFileBoundary({ fileBoundary: { roots: ["/explicit", "/also"] }, workspaceRoot: "/ws" }, "/repo"),
		).toEqual({ root: "/explicit", additionalRoots: ["/also"] })
	})

	it("appends roots to additionalRoots rather than replacing them", () => {
		// A host that names both is expressing "these plus those"; silently dropping
		// either would be the kind of quiet narrowing that is hard to notice.
		expect(
			resolveFileBoundary(
				{ fileBoundary: { roots: ["/a"], additionalRoots: ["/b"] }, workspaceRoot: "/ws" },
				"/repo",
			),
		).toEqual({ root: "/a", additionalRoots: ["/b"] })
	})
})
