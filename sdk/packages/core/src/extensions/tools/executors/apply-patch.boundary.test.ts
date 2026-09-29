import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApplyPatchExecutor, type ApplyPatchExecutorOptions } from "./apply-patch"
import type { FileBoundary } from "./file-boundary"
import type { AgentToolContext } from "@cline/shared"

/**
 * apply_patch under a workspace boundary.
 *
 * This executor had no boundary at all, and its own guard was weaker in two specific
 * ways that were both reachable:
 *
 *   1. the guard was lexical, so a symlink sitting *inside* the workspace that points
 *      outside it passed - the file was outside, the path did not look like it
 *   2. absolute inputs returned early and were accepted outright
 *
 * Together with read and write being bounded while patch was not, the boundary could
 * be bypassed by asking the model to prefer the other file tool. These cases pin all
 * three write paths - read for the diff, the write itself, and a move target.
 */
let root: string
let outside: string
let boundary: FileBoundary

const ctx = { sessionId: "s", agentId: "a", conversationId: "c", iteration: 1, toolCallId: "t" } as AgentToolContext

beforeEach(() => {
	const base = mkdtempSync(join(tmpdir(), "apply-patch-boundary-"))
	root = join(base, "workspace")
	outside = join(base, "outside")
	mkdirSync(root)
	mkdirSync(outside)
	boundary = { root }
})

afterEach(() => {
	rmSync(join(root, ".."), { recursive: true, force: true })
})

function run(patch: string, options: ApplyPatchExecutorOptions = { boundary }) {
	return createApplyPatchExecutor(options)({ input: patch }, root, ctx)
}

/** A patch that updates `file` by replacing its single line. */
function updatePatch(file: string) {
	return [
		`*** Begin Patch`,
		`*** Update File: ${file}`,
		`@@`,
		`-before`,
		`+after`,
		`*** End Patch`,
	].join("\n")
}

describe("apply_patch workspace boundary", () => {
	beforeEach(() => {
		writeFileSync(join(root, "inside.txt"), "before\n", "utf-8")
	})

	it("refuses a relative path that escapes the root", async () => {
		writeFileSync(join(outside, "target.txt"), "before\n", "utf-8")
		await expect(run(updatePatch("../outside/target.txt"))).rejects.toThrow()
		// The file outside must be untouched, not merely reported as an error.
		expect(readFileSync(join(outside, "target.txt"), "utf-8")).toBe("before\n")
	})

	it("refuses an absolute path outside the root", async () => {
		// The old guard returned early for absolute inputs and accepted them outright.
		const victim = join(outside, "absolute.txt")
		writeFileSync(victim, "before\n", "utf-8")
		await expect(run(updatePatch(victim))).rejects.toThrow()
		expect(readFileSync(victim, "utf-8")).toBe("before\n")
	})

	it("refuses a symlink that points outside the root", async () => {
		// The case a lexical check cannot see: the path is inside the root, the file
		// is not. This is the reason resolveBoundedPath realpaths both sides.
		const victim = join(outside, "linked.txt")
		writeFileSync(victim, "before\n", "utf-8")
		const link = join(root, "link.txt")
		symlinkSync(victim, link, "file")
		await expect(run(updatePatch("link.txt"))).rejects.toThrow()
		expect(readFileSync(victim, "utf-8")).toBe("before\n")
	})

	it("allows a path inside the root", async () => {
		await run(updatePatch("inside.txt"))
		expect(readFileSync(join(root, "inside.txt"), "utf-8")).toBe("after\n")
	})

	it("refuses a move target outside the root", async () => {
		// The move destination is resolved separately from the source, so bounding
		// only the source would leave a write outside the root.
		const victim = join(outside, "moved.txt")
		const patch = [
			`*** Begin Patch`,
			`*** Update File: inside.txt`,
			`*** Move to: ${victim}`,
			`@@`,
			`-before`,
			`+after`,
			`*** End Patch`,
		].join("\n")
		await expect(run(patch)).rejects.toThrow()
		expect(existsSyncSafe(victim)).toBe(false)
	})

	it("lets a configured boundary win over restrictToCwd: false", async () => {
		// restrictToCwd is the legacy weaker knob. A host that leaves it false while
		// configuring a boundary must not thereby switch the boundary off.
		const victim = join(outside, "override.txt")
		writeFileSync(victim, "before\n", "utf-8")
		await expect(run(updatePatch(victim), { boundary, restrictToCwd: false })).rejects.toThrow()
		expect(readFileSync(victim, "utf-8")).toBe("before\n")
	})

	it("honours additional roots", async () => {
		writeFileSync(join(outside, "notes.md"), "before\n", "utf-8")
		await run(updatePatch(join(outside, "notes.md")), {
			boundary: { root, additionalRoots: [outside] },
		})
		expect(readFileSync(join(outside, "notes.md"), "utf-8")).toBe("after\n")
	})

	it("leaves the historical behaviour untouched when no boundary is configured", async () => {
		// Regression guard: hosts that never configured a boundary must not suddenly
		// get one, or this change would break every out-of-workspace workflow.
		const victim = join(outside, "unbounded.txt")
		writeFileSync(victim, "before\n", "utf-8")
		await run(updatePatch(victim), {})
		expect(readFileSync(victim, "utf-8")).toBe("after\n")
	})
})

function existsSyncSafe(p: string): boolean {
	try {
		readFileSync(p, "utf-8")
		return true
	} catch {
		return false
	}
}
