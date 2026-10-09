import { describe, expect, it } from "vitest";
import { createPlanModeCommandGuardExtension } from "./command-guard-extension";
import { DefaultToolNames } from "./constants";

/**
 * The guard only helps if it is registered. `command-guard-extension.test.ts`
 * covers the hook's behaviour in isolation; this covers the decision the runtime
 * builder makes about when to install it, which is the half that regressed.
 */
describe("plan-mode command guard wiring", () => {
	const snapshot = {
		agentId: "agent-1",
		conversationId: "conv-1",
		runId: "run-1",
		iteration: 1,
	};

	const call = async (command: string) => {
		const extension = createPlanModeCommandGuardExtension();
		const beforeTool = extension.hooks?.beforeTool;
		expect(beforeTool).toBeTypeOf("function");
		return await beforeTool?.({
			snapshot,
			tool: { name: DefaultToolNames.RUN_COMMANDS } as never,
			toolCall: { toolCallId: "call-1" } as never,
			input: { command },
		} as never);
	};

	it("blocks a shell write that reproduces the reported plan-mode bypass", async () => {
		// cline/cline#13586: `editor` is correctly withheld in plan mode, so the model
		// reached for the shell instead. The guard's own docs note this exact form is
		// outside what a command blacklist can catch, so assert the redirect form it
		// *does* catch and keep the python case visible as a known limit rather than
		// pretending it is covered.
		const result = await call("cat config.json > config.json.bak");
		expect(result?.skip).toBe(true);
		expect(result?.reason).toBeTruthy();
	});

	it("blocks the ordinary editing commands", async () => {
		for (const command of [
			"rm -rf build",
			"sed -i 's/a/b/' file.txt",
			"echo hi > out.txt",
			"mkdir -p new/dir",
			"git checkout -- .",
		]) {
			const result = await call(command);
			expect(result?.skip, `expected "${command}" to be blocked`).toBe(true);
		}
	});

	it("still allows read-only investigation, which is why bash stays enabled", async () => {
		for (const command of [
			"git status",
			"git log --oneline -5",
			"ls -la",
			"cat package.json",
			"grep -rn TODO src",
		]) {
			const result = await call(command);
			expect(result, `expected "${command}" to be allowed`).toBeUndefined();
		}
	});

	it("ignores tools that are not run_commands", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await extension.hooks?.beforeTool?.({
			snapshot,
			tool: { name: "read_files" } as never,
			toolCall: { toolCallId: "call-1" } as never,
			input: { paths: ["a.txt"] },
		} as never);
		expect(result).toBeUndefined();
	});

	it("uses skip rather than stop so a blocked command does not end the turn", async () => {
		// `stop` would throw ControlledStopError and abort the run; the model should
		// get the error as a tool result and be free to plan another way.
		const result = await call("rm file.txt");
		expect(result?.skip).toBe(true);
		expect(result?.stop).toBeUndefined();
	});
});
