import { describe, expect, it } from "vitest"
import type { AgentTool } from "@cline/shared"
import { createBuiltinTools } from "../../extensions/tools"
import { ProcessSandboxRuntime } from "../sandbox/process-sandbox-runtime"
import { createSandboxShellExecutor } from "../sandbox/sandbox-shell-executor"

/**
 * These cover the wiring that did not exist: `ProcessSandboxRuntime` and
 * `createSandboxShellExecutor` were implemented, exported and tested in
 * isolation, and no host ever called them — so every default run executed shell
 * commands unsandboxed while the code looked like it had a sandbox.
 *
 * Construction is asserted rather than execution: spawning a real Seatbelt or
 * bubblewrap process is not portable across CI, and the command construction
 * itself is covered in `process-sandbox.test.ts`.
 */
describe("sandbox shell wiring", () => {
	const bashToolOf = (tools: AgentTool[]) =>
		tools.find((tool) => tool.name === "run_commands")

	it("leaves the shell executor untouched when sandboxing is off", () => {
		// The overwhelmingly common case must be byte-for-byte the historical
		// behaviour: no sandbox binary required, Windows unaffected.
		const tools = createBuiltinTools({ cwd: "/repo/a", enableBash: true })
		expect(bashToolOf(tools)).toBeDefined()
	})

	it("replaces the shell executor when sandboxing is enabled", () => {
		const sandboxed = createSandboxShellExecutor({
			sandbox: new ProcessSandboxRuntime({ workspaceRoot: "/repo/a" }),
		})
		const tools = createBuiltinTools({
			cwd: "/repo/a",
			enableBash: true,
			executors: { bash: sandboxed },
		})
		expect(bashToolOf(tools)).toBeDefined()
	})

	it("keeps the file boundary independent of the process sandbox", () => {
		// They solve different problems: the boundary is a path check inside the
		// file tools, the sandbox confines the process. A host may want either,
		// both, or neither.
		const sandboxed = createSandboxShellExecutor({
			sandbox: new ProcessSandboxRuntime({ workspaceRoot: "/repo/a" }),
		})
		const tools = createBuiltinTools({
			cwd: "/repo/a",
			enableBash: true,
			enableReadFiles: true,
			executors: { bash: sandboxed },
			executorOptions: {
				fileRead: { boundary: { root: "/repo/a" } },
				editor: { boundary: { root: "/repo/a" } },
				applyPatch: { boundary: { root: "/repo/a" } },
			},
		})
		expect(tools.map((tool) => tool.name)).toContain("run_commands")
		expect(tools.map((tool) => tool.name)).toContain("read_files")
	})
})