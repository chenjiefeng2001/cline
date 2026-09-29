import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHookConfigFileHooks } from "./hook-file-hooks"

/**
 * A hook that exits before reading stdin must report its exit, not hang.
 *
 * `writeToChildStdin` registers its own `close` listener so it can survive a child
 * that dies early, and it is awaited before the result promise's listener used to be
 * attached. A hook that exits inside that window therefore consumed the only `close`
 * event, and the result never settled - the call hung until the caller's timeout.
 *
 * That is the worst possible shape for a failing hook: a hook that is broken is
 * exactly the one that exits early, and it turns a reportable error into a hang. It
 * surfaced as an intermittent 30s test timeout, because it is a race with process
 * startup - more likely on a loaded Windows runner, and in CI it showed up on the
 * prompt-submit hook as a reported execution error after a "killed 1 dangling
 * process" line.
 *
 * Every case asserts the hook was actually wired before checking that it settles.
 * Without that, a hook that was never discovered would return undefined immediately
 * and these cases would pass without exercising anything.
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
			input: { path: "README.md" },
		},
		input: { path: "README.md" },
	}
}

/** Resolve "TIMED_OUT" if the hook has not settled within `budgetMs`. */
function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | "TIMED_OUT"> {
	return Promise.race([
		work,
		new Promise<"TIMED_OUT">((resolve) => setTimeout(() => resolve("TIMED_OUT"), budgetMs)),
	])
}

async function withHookScript<T>(
	fileName: string,
	body: string,
	fn: (workspace: string) => Promise<T>,
): Promise<T> {
	const workspace = await mkdtemp(join(tmpdir(), "hook-early-exit-"))
	try {
		const hooksDir = join(workspace, ".clinerules", "hooks")
		await mkdir(hooksDir, { recursive: true })
		await writeFile(join(hooksDir, fileName), body, "utf8")
		return await fn(workspace)
	} finally {
		await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
	}
}

/** Build the hooks and prove the case is wired, so it cannot pass vacuously. */
function wiredBeforeTool(workspace: string) {
	const hooks = createHookConfigFileHooks({ cwd: workspace, workspacePath: workspace })
	expect(hooks?.beforeTool, "hook was not discovered, so the case would be vacuous").toBeTypeOf(
		"function",
	)
	return hooks?.beforeTool as (ctx: unknown) => Promise<unknown>
}

describe("hook that exits before reading stdin", () => {
	it("settles instead of hanging when the hook exits immediately", async () => {
		await withHookScript("PreToolUse.js", "process.exit(3);\n", async (workspace) => {
			const beforeTool = wiredBeforeTool(workspace)
			// An explicit short budget, so a regression fails in seconds rather than
			// stalling on the framework default.
			const settled = await withBudget(beforeTool(beforeToolContext()), 5_000)
			expect(settled).not.toBe("TIMED_OUT")
		})
	})

	it("settles when the hook crashes at startup", async () => {
		// The shape seen in CI: a hook that cannot resolve a module exits at once.
		await withHookScript(
			"PreToolUse.js",
			"require('this-module-does-not-exist');\n",
			async (workspace) => {
				const beforeTool = wiredBeforeTool(workspace)
				const settled = await withBudget(beforeTool(beforeToolContext()), 5_000)
				expect(settled).not.toBe("TIMED_OUT")
			},
		)
	})

	it("settles on every one of ten concurrent invocations", async () => {
		// The original symptom was intermittent, so a single pass proves little. Ten
		// at once both widen the window and make a regression reproducible in one run.
		await withHookScript("PreToolUse.js", "process.exit(1);\n", async (workspace) => {
			const beforeTool = wiredBeforeTool(workspace)
			const outcomes = await Promise.all(
				Array.from({ length: 10 }, () =>
					withBudget(beforeTool(beforeToolContext()), 15_000),
				),
			)
			expect(outcomes.filter((o) => o === "TIMED_OUT")).toHaveLength(0)
		})
	})

	it("still delivers the payload to a hook that reads stdin", async () => {
		// Guards against over-correcting: attaching the listeners earlier must not
		// swallow output or change behaviour for a well-behaved hook.
		await withHookScript(
			"PreToolUse.js",
			"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write('HOOK_CONTROL\\t'+JSON.stringify({cancel:false,context:'payload-ok'}))});\n",
			async (workspace) => {
				const beforeTool = wiredBeforeTool(workspace)
				const settled = await withBudget(beforeTool(beforeToolContext()), 10_000)
				expect(settled).not.toBe("TIMED_OUT")
				expect(settled).toBeUndefined()
			},
		)
	})
})
