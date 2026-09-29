import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { HookProcess } from "./HookProcess"

/**
 * The hook lifecycle diagnostics have to survive into the failure, not just exist.
 *
 * This exists because the failure that prompted it was undecidable from its message:
 * CI reported `Module not found '...UserPromptSubmit.js'` alongside a scriptPath of
 * `UserPromptSubmit.ps1`, with no record of what was actually launched. Instrumentation
 * nobody can see is not instrumentation, so these assert the timeline reaches the
 * error text and says which command ran.
 *
 * The fixtures are platform-shaped rather than uniform: this launcher runs hooks
 * through PowerShell on Windows and through the shell on Unix, so a `.js` fixture is
 * not executable here on Windows at all. Writing one and reading the failure as a
 * diagnostics bug would be the wrong lesson.
 */
const isWindows = process.platform === "win32"

/** A hook that exits non-zero without producing output. */
function failingHook(): { name: string; body: string } {
	return isWindows
		? { name: "UserPromptSubmit.ps1", body: "exit 7\n" }
		: { name: "UserPromptSubmit.sh", body: "#!/bin/sh\nexit 7\n" }
}

/** A hook that reads stdin, writes to stdout, and exits 0. */
function succeedingHook(): { name: string; body: string } {
	return isWindows
		? {
				name: "UserPromptSubmit.ps1",
				body:
					"$input | Out-String | Write-Output\n" +
					'$stdin = [Console]::In.ReadToEnd()\nWrite-Output "{\\"ok\\":true}"\n',
			}
		: {
				name: "UserPromptSubmit.sh",
				body: "#!/bin/sh\ncat > /dev/null\necho '{\"ok\":true}'\n",
			}
}

/** A hook that never exits on its own. */
function stallingHook(): { name: string; body: string } {
	return isWindows
		? { name: "UserPromptSubmit.ps1", body: "Start-Sleep -Seconds 120\n" }
		: { name: "UserPromptSubmit.sh", body: "#!/bin/sh\nsleep 120\n" }
}

async function withHook<T>(fixture: { name: string; body: string }, fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "hook-diag-"))
	try {
		await writeFile(join(dir, fixture.name), fixture.body, "utf-8")
		return await fn(dir)
	} finally {
		// Best effort. A hook that was just killed can still hold its working directory
		// open, and on Windows that surfaces as EBUSY for a second or so. That is an
		// artefact of killing a process on this platform, not a defect under test, and a
		// temp directory left behind is the right trade for not failing a passing
		// assertion. A genuine file-handle leak is not what this file is testing.
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
	}
}

describe("hook lifecycle diagnostics", () => {
	it("reports the launch command and timeline when the hook exits non-zero", async () => {
		const fixture = failingHook()
		const error = await withHook(fixture, async (dir) => {
			const proc = new HookProcess(join(dir, fixture.name), 8_000, undefined, dir)
			return proc.run(JSON.stringify({ hook_event_name: "UserPromptSubmit" })).then(
				() => undefined,
				(e: unknown) => (e instanceof Error ? e.message : String(e)),
			)
		})
		expect(error, "hook was expected to exit non-zero").toBeDefined()
		// The whole point: a failure says what ran, not only that it ran.
		expect(error).toContain("hook lifecycle:")
		expect(error).toContain("launch-config")
		expect(error).toContain("command=")
		expect(error).toContain("close")
	})

	it("records launch, stdin and close in order", async () => {
		const fixture = failingHook()
		const error = await withHook(fixture, async (dir) => {
			const proc = new HookProcess(join(dir, fixture.name), 8_000, undefined, dir)
			return proc.run(JSON.stringify({ hook_event_name: "UserPromptSubmit" })).then(
				() => undefined,
				(e: unknown) => (e instanceof Error ? e.message : String(e)),
			)
		})
		const text = error ?? ""
		const launchIdx = text.indexOf("launch-config")
		const stdinIdx = text.indexOf("stdin-written")
		const closeIdx = text.indexOf("close")
		expect(launchIdx).toBeGreaterThan(-1)
		// Ordering is the diagnostic. A close before stdin-written, or a close that never
		// appears, is the signature that separates a lost event from a slow child.
		expect(stdinIdx).toBeGreaterThan(launchIdx)
		expect(closeIdx).toBeGreaterThan(stdinIdx)
	})

	it("emits a diagnostic event before killing a stalled hook", async () => {
		// A hang that produces nothing is the failure mode hardest to act on, because
		// the log ends exactly where the evidence should begin. The trace has to be
		// written before the kill, not only into a rejection nobody may read.
		const fixture = stallingHook()
		await withHook(fixture, async (dir) => {
			const proc = new HookProcess(join(dir, fixture.name), 1_000, undefined, dir)
			const diagnostics: string[] = []
			proc.on("diagnostic", (text: string) => diagnostics.push(text))
			const failure = await proc.run(JSON.stringify({ hook_event_name: "UserPromptSubmit" })).then(
				() => undefined,
				(e: unknown) => (e instanceof Error ? e.message : String(e)),
			)
			expect(failure).toContain("hook lifecycle:")
			expect(diagnostics.length).toBeGreaterThan(0)
			expect(diagnostics[0]).toContain("timeout-fired")
			expect(diagnostics[0]).toContain("launch-config")
		})
	})

	it("leaves a successful hook's behaviour untouched", async () => {
		// Guards the instrumentation against changing behaviour: a passing hook must
		// still resolve, with no trace bolted onto its success path.
		const fixture = succeedingHook()
		const result = await withHook(fixture, async (dir) => {
			const proc = new HookProcess(join(dir, fixture.name), 8_000, undefined, dir)
			const lines: string[] = []
			proc.on("line", (line: string) => lines.push(line))
			try {
				await proc.run(JSON.stringify({ hook_event_name: "UserPromptSubmit" }))
				return { ok: true as const, lines }
			} catch (error) {
				return { ok: false as const, lines, error: error instanceof Error ? error.message : String(error) }
			}
		})
		expect(result.error ?? "").toBe("")
		expect(result.ok).toBe(true)
	})
})
