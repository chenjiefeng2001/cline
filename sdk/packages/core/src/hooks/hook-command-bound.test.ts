import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHookConfigFileHooks, DEFAULT_HOOK_COMMAND_TIMEOUT_MS } from "./hook-file-hooks"

/**
 * A blocking hook command always has a reachable upper bound.
 *
 * `runBlockingHookCommands` waits on the child's `close` and nothing else bounds that
 * wait. The only bound that existed was `toolCallTimeoutMs ?? 120000`, and
 * `HookRuntimeOptions` had no generic `timeoutMs` at all - so a hook that never exited
 * stalled every tool call for two minutes, and any caller with a shorter budget than
 * that (a 30s test framework, for one) never saw the timeout at all. It just lost its
 * run, with the log ending exactly where the evidence should begin.
 *
 * Reproduced deterministically before the fix: a `.js` hook that never exits left
 * `beforeTool` pending indefinitely, every time. With `timeoutMs` set it returns in
 * roughly the bound and reports the timeout.
 */
function beforeToolContext() {
	return {
		snapshot: {
			agentId: "agent_1",
			conversationId: "conv_1",
			runId: "run_1",
			status: "running" as const,
			iteration: 1,
			messages: [],
			pendingToolCalls: [],
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		},
		tool: { name: "read_file", description: "", inputSchema: {}, execute: async () => "" },
		toolCall: {
			type: "tool-call" as const,
			toolCallId: "call_1",
			toolName: "read_file",
			input: { path: "README.md" },
		},
		input: { path: "README.md" },
	}
}

async function withHook<T>(
	fileName: string,
	body: string,
	timeoutMs: number | undefined,
	fn: (workspace: string) => Promise<T>,
): Promise<T> {
	const workspace = await mkdtemp(join(tmpdir(), "hook-bound-"))
	try {
		const hooksDir = join(workspace, ".clinerules", "hooks")
		await mkdir(hooksDir, { recursive: true })
		await writeFile(join(hooksDir, fileName), body, "utf-8")
		return await fn(workspace)
	} finally {
		await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
	}
}

/** Never exits on its own. */
const WEDGED = "setInterval(() => {}, 1000);\n"

describe("blocking hook command bound", () => {
	it("exposes a finite default bound", () => {
		expect(DEFAULT_HOOK_COMMAND_TIMEOUT_MS).toBeGreaterThan(0)
		expect(Number.isFinite(DEFAULT_HOOK_COMMAND_TIMEOUT_MS)).toBe(true)
	})

	it("returns within the configured bound when a hook never exits", async () => {
		await withHook("PreToolUse.js", WEDGED, 700, async (workspace) => {
			const hooks = createHookConfigFileHooks({ cwd: workspace, workspacePath: workspace, timeoutMs: 700 })
			// Asserted before awaiting, so a hook that was never discovered cannot make
			// this pass vacuously - which is how the first attempt at an equivalent test
			// passed three of four cases for entirely the wrong reason.
			expect(hooks?.beforeTool, "hook was not discovered").toBeTypeOf("function")

			const started = Date.now()
			const control = await hooks?.beforeTool?.(beforeToolContext() as never)
			const elapsed = Date.now() - started

			// Before the fix this await never settled. Generous ceiling so the assertion
			// is about the bound being honoured, not about how fast the machine is.
			expect(elapsed).toBeLessThan(20_000)
			expect(elapsed).toBeGreaterThanOrEqual(600)
			// A killed hook is skipped, not propagated: the turn continues without it.
			expect(control).toBeUndefined()
		})
	})

	it("does not kill a hook that completes in time", async () => {
		// Guards the bound against firing on a healthy hook and silently dropping it.
		await withHook(
			"PreToolUse.js",
			"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write('HOOK_CONTROL\\t'+JSON.stringify({cancel:false,context:'ok'}))});\n",
			30_000,
			async (workspace) => {
				const hooks = createHookConfigFileHooks({
					cwd: workspace,
					workspacePath: workspace,
					timeoutMs: 30_000,
				})
				expect(hooks?.beforeTool).toBeTypeOf("function")
				expect(await hooks?.beforeTool?.(beforeToolContext() as never)).toBeUndefined()
			},
		)
	})
})
