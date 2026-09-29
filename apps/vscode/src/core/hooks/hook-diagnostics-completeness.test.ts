import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { HookProcess } from "./HookProcess"

/**
 * The diagnostics have to be complete, not merely present.
 *
 * This exists because the previous trace was created inside the async IIFE that
 * performs the spawn. Every path before that point - already-aborted, and the abort
 * handler - rejected with "cancelled" and left no record at all. A spurious abort was
 * then indistinguishable from a hook that misbehaved.
 *
 * So the question is no longer "did I add a trace" but "is any exit path able to
 * terminate without one". A test that only asserts a trace appears on the paths its
 * author remembered cannot answer that. The first case below therefore reads the
 * source and checks that every `resolve()`/`reject()` route goes through settle().
 * Adding an exit path without diagnostics then fails the suite, rather than being
 * discovered later as silence.
 */
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, "HookProcess.ts"), "utf8")

const isWindows = process.platform === "win32"

function fixture(exitCode: number) {
	return isWindows
		? { name: "UserPromptSubmit.ps1", body: `exit ${exitCode}\n` }
		: { name: "UserPromptSubmit.sh", body: `#!/bin/sh\nexit ${exitCode}\n` }
}

describe("hook diagnostics completeness", () => {
	it("routes every terminal state through settle()", () => {
		// The direct expression of the invariant, rather than a proxy: a reject that
		// does not settle is a path that terminates with no record of itself. Counting
		// occurrences of describeTrace would have passed while a bare reject sat in the
		// file, which is the failure this whole test exists to prevent.
		// A window, not a single line: a reject whose argument spans several lines
		// carries settle() further down, and matching per-line produced a false
		// positive on a correctly instrumented timeout path. A guard that cries wolf
		// gets deleted.
		const lines = source.split("\n")
		const bareRejects = lines
			.map((line, i) => ({ line, i }))
			.filter(({ line }) => /\breject\(/.test(line))
			.filter(
				({ i }) =>
					!lines
						.slice(i, i + 6)
						.join("\n")
						.includes("settle("),
			)
		expect(
			bareRejects.map(({ line, i }) => `line ${i + 1}: ${line.trim().slice(0, 90)}`),
			"every reject must settle, or the chain can terminate without evidence",
		).toEqual([])
	})

	it("stamps a terminal state on success as well as on failure", () => {
		// Success used to resolve silently, so "ran fine" and "never ran" looked alike.
		expect(source).toContain('settle("success")')
	})

	it("records the pre-spawn phases, which is where the silent aborts were", () => {
		expect(source).toContain("abort-check")
		expect(source).toContain('settle("cancelled-before-start")')
		expect(source).toContain('settle("aborted")')
	})

	it("names every terminal state it claims to cover", () => {
		for (const state of [
			"success",
			"exit",
			"timeout",
			"aborted",
			"cancelled-before-start",
			"spawn-error",
			"stdin-write-failed",
			"setup-threw",
		]) {
			expect(source, `no settle() for terminal state "${state}"`).toContain(`settle("${state}"`)
		}
	})

	it("emits the trace on every terminal state, not only on failure", () => {
		// The emit lives in settle(), which is what makes the completeness claim above
		// hold rather than being an aspiration.
		const settleBody = source.slice(source.indexOf("const settle ="), source.indexOf("// Wrap in try/finally"))
		expect(settleBody).toContain('this.emit("diagnostic"')
	})
})

describe("terminal states actually report", () => {
	it("reports a terminal state for a failing hook", async () => {
		const f = fixture(3)
		const dir = await mkdtemp(join(tmpdir(), "hook-complete-"))
		try {
			await writeFile(join(dir, f.name), f.body, "utf-8")
			const proc = new HookProcess(join(dir, f.name), 8_000, undefined, dir)
			const diagnostics: string[] = []
			proc.on("diagnostic", (text: string) => diagnostics.push(text))
			const failure = await proc.run(JSON.stringify({ hook_event_name: "UserPromptSubmit" })).then(
				() => undefined,
				(e: unknown) => (e instanceof Error ? e.message : String(e)),
			)
			expect(failure).toContain("terminal:")
			expect(diagnostics.length).toBeGreaterThan(0)
			expect(diagnostics[0]).toContain("terminal:")
		} finally {
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
		}
	})

	it("reports a terminal state when already aborted before starting", async () => {
		// The exact case that used to be silent. A hook that never launched must be
		// distinguishable from one that launched and failed.
		const f = fixture(0)
		const dir = await mkdtemp(join(tmpdir(), "hook-abort-"))
		try {
			await writeFile(join(dir, f.name), f.body, "utf-8")
			const controller = new AbortController()
			controller.abort()
			const proc = new HookProcess(join(dir, f.name), 8_000, controller.signal, dir)
			const failure = await proc.run(JSON.stringify({ hook_event_name: "UserPromptSubmit" })).then(
				() => undefined,
				(e: unknown) => (e instanceof Error ? e.message : String(e)),
			)
			expect(failure).toContain("cancelled-before-start")
			// And it must show the phases it did reach, so the reader can see the spawn
			// never happened.
			expect(failure).toContain("abort-check")
			expect(failure).not.toContain("spawn-returned")
		} finally {
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
		}
	})
})
