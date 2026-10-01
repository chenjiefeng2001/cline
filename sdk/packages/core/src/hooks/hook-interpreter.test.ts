import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createHookConfigFileHooks, UnsupportedHookInterpreterError } from "./hook-file-hooks"
import {
	isWindowsBashShim,
	resetWindowsGitBashCacheForTesting,
	resolveWindowsGitBash,
	setWindowsGitBashResolverForTesting,
} from "./windows-git-bash"

/**
 * A Unix-shell hook on Windows: which `bash` it gets, and what happens when none works.
 *
 * Measured on a stock Windows machine, because the two cases look identical from the
 * code and are not identical in fact:
 *
 *   - `bash` on PATH is `C:\Windows\System32\bash.exe`, the WSL shim. It strips the
 *     separators out of a Windows path and exits 127 without running the hook:
 *     `/bin/bash: C:Users...PreToolUse: No such file or directory`. Nothing is
 *     printed, so the hook looks like it simply has nothing to say.
 *   - `C:\Program Files\Git\bin\bash.exe` opens the same file, as a Windows path or a
 *     POSIX path, and exits 0.
 *
 * So the resolution has to pick a real shell and skip the shim, and only refuse when
 * there is no real shell - refusing outright would have removed a case that works.
 */
const isWindows = process.platform === "win32"
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe"
const WSL_SHIM = "C:\\Windows\\System32\\bash.exe"

function logger() {
	const lines: string[] = []
	return {
		lines,
		// logHookError routes through logger.log with a severity, not logger.warn.
		sink: {
			log: (m: string) => lines.push(m),
			warn: (m: string) => lines.push(m),
			error: (m: string) => lines.push(m),
			info: () => {},
			debug: () => {},
		} as never,
	}
}

/** Minimal AgentBeforeToolContext, matching the shape hook-file-hooks.test.ts builds. */
function beforeToolContext(input: unknown = { path: "README.md" }) {
	return {
		snapshot: {
			agentId: "agent_1",
			conversationId: "conv_1",
			runId: "run_1",
			status: "running" as const,
			iteration: 1,
			messages: [],
			pendingToolCalls: [],
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		},
		tool: {
			name: "read_file",
			description: "",
			inputSchema: {},
			execute: async () => "",
		},
		toolCall: {
			type: "tool-call" as const,
			toolCallId: "call_1",
			toolName: "read_file",
			input,
		},
		input,
	}
}

async function workspaceWith(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hook-interp-"))
	const hooks = join(dir, ".clinerules", "hooks")
	await mkdir(hooks, { recursive: true })
	for (const [name, body] of Object.entries(files)) {
		await writeFile(join(hooks, name), body, "utf-8")
	}
	return dir
}

async function withWorkspace(files: Record<string, string>, run: (dir: string) => Promise<void>) {
	const dir = await workspaceWith(files)
	try {
		await run(dir)
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
	}
}

afterEach(() => {
	resetWindowsGitBashCacheForTesting()
})

describe("which bash a Unix-shell hook gets on Windows", () => {
	it.skipIf(!isWindows)("routes a shebang hook at an installed Git bash, not the WSL shim", async () => {
		await withWorkspace({ PreToolUse: "#!/usr/bin/env bash\necho hi\n" }, async (dir) => {
			const log = logger()
			const hooks = createHookConfigFileHooks({
				cwd: dir,
				workspacePath: dir,
				logger: log.sink,
			})
			// The hook loads, and whatever it resolves to is not the shim.
			expect(hooks?.beforeTool, "a Unix-shell hook loads when a real bash exists").toBeTypeOf("function")
			expect(log.lines.join("\n")).not.toContain("cannot run")
			expect(log.lines.join("\n")).not.toContain("No usable bash")
		})
	})

	it.skipIf(!isWindows)("treats a .sh hook with no shebang exactly like one with a shebang", async () => {
		// The bug this pins: the refusal used to live only in the shebang branch, so the
		// same file with its shebang deleted was silently attempted against the shim.
		// Both spellings produce `bash <windows-path>`; both must be resolved the same way.
		await withWorkspace({ PreToolUse: "echo hi\n" }, async (dir) => {
			const log = logger()
			const hooks = createHookConfigFileHooks({
				cwd: dir,
				workspacePath: dir,
				logger: log.sink,
			})
			expect(hooks?.beforeTool, "an extensionless shell hook loads too").toBeTypeOf("function")
			expect(log.lines.join("\n")).not.toContain("No usable bash")
		})
	})

	it.skipIf(!isWindows)("actually runs a shell hook through the resolved bash", async () => {
		// The resolution is only worth anything if the hook then runs and its output is
		// honoured, so this is the end-to-end claim: a `.sh` hook with no shebang, launched
		// through the bash that was found, whose `cancel` blocks the tool call. Accepting
		// the file into the command map is not the same claim as executing it.
		const bash = resolveWindowsGitBash()
		if (!bash) {
			// No bash on this machine: the refusal path above is the behaviour under test
			// here, and passing anyway would make this test green for the wrong reason.
			return
		}
		await withWorkspace({ "PreToolUse.sh": 'echo \'{"cancel":true,"reason":"blocked by hook"}\'\n' }, async (dir) => {
			const log = logger()
			const hooks = createHookConfigFileHooks({ cwd: dir, workspacePath: dir, logger: log.sink })
			const result = await hooks?.beforeTool?.(beforeToolContext() as never)
			// `stop` is the SDK hook contract's name for the hook's `cancel`: the tool call
			// is blocked, which can only happen if the process ran and its JSON was read.
			expect(result?.stop).toBe(true)
			expect(log.lines.join("\n")).not.toContain("No usable bash")
		})
	}, 20_000)

	it.skipIf(!isWindows)("refuses the hook by name when no bash can be resolved", async () => {
		// The refusal is the branch with the most user consequence and, on a machine
		// with Git for Windows, the one least reachable - hence the resolver seam.
		setWindowsGitBashResolverForTesting(() => undefined)
		await withWorkspace(
			{
				PreToolUse: "#!/usr/bin/env bash\necho hi\n",
				"PostToolUse.ps1": 'Write-Output "{}"\n',
			},
			async (dir) => {
				const log = logger()
				const hooks = createHookConfigFileHooks({
					cwd: dir,
					workspacePath: dir,
					logger: log.sink,
				})
				// The PowerShell hook beside it still loads: one unusable hook must not
				// take the workspace's other hooks down with it.
				expect(hooks?.afterTool, "the PowerShell hook still loads").toBeTypeOf("function")
				const text = log.lines.join("\n")
				// Named, with the reason, the real alternative, and the .ps1 to rename to.
				expect(text).toContain("PreToolUse")
				expect(text).toContain("No usable bash")
				expect(text).toContain("Git for Windows")
				expect(text).toMatch(/\.ps1/)
				expect(text).toContain("Nothing was executed")
				// And it says the others are unaffected, so the message does not read as
				// "all your hooks are broken".
				expect(text).toContain("unaffected")
			},
		)
	})

	it.skipIf(!isWindows)("refuses an extensionless hook the same way, without claiming a shebang it does not have", async () => {
		setWindowsGitBashResolverForTesting(() => undefined)
		await withWorkspace({ PreToolUse: "echo hi\n" }, async (dir) => {
			const log = logger()
			createHookConfigFileHooks({ cwd: dir, workspacePath: dir, logger: log.sink })
			const text = log.lines.join("\n")
			expect(text).toContain("No usable bash")
			// The file declares nothing, so describing it as declaring a shebang would be
			// wrong in the one detail the user has to act on.
			expect(text).not.toContain('declares "#!')
		})
	})
})

describe("resolving a usable bash on Windows", () => {
	it("recognises the WSL shim wherever it appears", () => {
		expect(isWindowsBashShim(WSL_SHIM)).toBe(true)
		expect(isWindowsBashShim("c:\\windows\\system32\\bash.exe")).toBe(true)
		expect(isWindowsBashShim("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe")).toBe(true)
		expect(isWindowsBashShim("C:/Windows/System32/bash.exe")).toBe(true)
		expect(isWindowsBashShim(GIT_BASH)).toBe(false)
	})

	it("prefers an installed Git bash over the shim sitting first on PATH", () => {
		// The shim is first on PATH on a stock machine, so a PATH-first strategy would
		// pick it and every Unix-shell hook would silently do nothing.
		const resolved = resolveWindowsGitBash({
			env: {
				PATH: `C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;${"C:\\Program Files\\Git\\cmd"}`,
				ProgramFiles: "C:\\Program Files",
			} as NodeJS.ProcessEnv,
			exists: (candidate) => candidate === GIT_BASH || candidate.toLowerCase().includes("system32"),
		})
		expect(resolved).toBe(GIT_BASH)
	})

	it("returns nothing rather than the shim when no real bash is installed", () => {
		const resolved = resolveWindowsGitBash({
			env: {
				PATH: "C:\\Windows\\System32;C:\\Windows",
				ProgramFiles: "C:\\Program Files",
			} as NodeJS.ProcessEnv,
			exists: (candidate) => candidate.toLowerCase().includes("system32"),
		})
		expect(resolved).toBeUndefined()
	})

	it("honours GIT_INSTALL_ROOT ahead of the Program Files copy", () => {
		const custom = "D:\\tools\\PortableGit"
		const resolved = resolveWindowsGitBash({
			env: {
				GIT_INSTALL_ROOT: custom,
				ProgramFiles: "C:\\Program Files",
			} as NodeJS.ProcessEnv,
			exists: (candidate) => candidate.startsWith(custom) || candidate.startsWith("C:\\Program Files\\Git"),
		})
		expect(resolved).toBe(`${custom}\\bin\\bash.exe`)
	})
})

describe("interpreters that are not Unix shells", () => {
	it.skipIf(!isWindows)("still resolves PowerShell hooks when no bash exists at all", async () => {
		// PowerShell is the platform-native answer, so refusing for lack of bash must not
		// cost a Windows user the one interpreter that always works.
		setWindowsGitBashResolverForTesting(() => undefined)
		await withWorkspace(
			{
				"PreToolUse.ps1": 'Write-Output "{}"\n',
				"PostToolUse.ps1": 'Write-Output "{}"\n',
			},
			async (dir) => {
				const log = logger()
				const hooks = createHookConfigFileHooks({ cwd: dir, workspacePath: dir, logger: log.sink })
				expect(hooks?.beforeTool).toBeTypeOf("function")
				expect(hooks?.afterTool).toBeTypeOf("function")
				expect(log.lines.join("\n")).not.toContain("No usable bash")
			},
		)
	})

	it.skipIf(isWindows)("accepts a Unix shebang off Windows", async () => {
		await withWorkspace({ PreToolUse: "#!/usr/bin/env bash\necho hi\n" }, async (dir) => {
			const log = logger()
			const hooks = createHookConfigFileHooks({ cwd: dir, workspacePath: dir, logger: log.sink })
			expect(hooks?.beforeTool, "a Unix shebang is fine on Unix").toBeTypeOf("function")
			expect(log.lines.join("\n")).not.toContain("No usable bash")
		})
	})
})

describe("UnsupportedHookInterpreterError", () => {
	it("carries the path, the interpreter, the reason and how it was inferred", () => {
		const e = new UnsupportedHookInterpreterError("/ws/PreToolUse", "/usr/bin/env bash", "because")
		expect(e.scriptPath).toBe("/ws/PreToolUse")
		expect(e.interpreter).toBe("/usr/bin/env bash")
		expect(e.reason).toBe("because")
		expect(e.origin).toBe("shebang")
		// Suggests the .ps1 name by dropping whatever extension the hook had.
		expect(e.message).toContain("/ws/PreToolUse.ps1")
		expect(e.message).toContain('declares "#!/usr/bin/env bash"')
	})

	it("describes an inferred interpreter without inventing a shebang", () => {
		const e = new UnsupportedHookInterpreterError("/ws/PreToolUse.sh", "bash", "because", "filename")
		expect(e.origin).toBe("filename")
		expect(e.message).toContain("/ws/PreToolUse.ps1")
		expect(e.message).toContain('"bash /ws/PreToolUse.sh"')
		expect(e.message).not.toContain('declares "#!')
	})
})
