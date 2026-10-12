import type { AgentToolContext, DetachedCommandLogSink } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createShellExecutor } from "./bash";

// The literal requirement is that a timeout must not reach the process-tree
// termination mechanism. A marker file can only show that the process survived;
// it cannot distinguish "never called" from "called and failed", because the
// Windows branch spawns taskkill fire-and-forget. So count the calls directly.
const kills = vi.hoisted(() => [] as string[]);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		default: actual,
		spawn: (...args: Parameters<typeof actual.spawn>) => {
			const command = args[0];
			if (typeof command === "string" && /taskkill/i.test(command)) {
				kills.push("taskkill");
			}
			return actual.spawn(...args);
		},
	};
});

const POSIX_KILL = process.platform === "win32" ? "taskkill" : "process.kill";
const sleeper = { command: process.execPath, args: ["-e", "setTimeout(() => {}, 3000)"] };

function contextWith(sink?: DetachedCommandLogSink): AgentToolContext {
	return {
		agentId: "test-agent",
		iteration: 1,
		...(sink ? { detachedCommandLog: sink } : {}),
	} as AgentToolContext;
}

const noopSink: DetachedCommandLogSink = {
	open: () => ({
		path: "/virtual/detached.log",
		write: () => {},
		close: () => {},
	}),
};

describe("timeout never terminates the process tree", () => {
	it("does not call the kill mechanism when detaching", async () => {
		kills.length = 0;
		const killSpy = vi.spyOn(process, "kill");

		const executor = createShellExecutor({ timeoutMs: 150 });
		const result = await executor(sleeper, process.cwd(), contextWith(noopSink));

		expect(result).toContain("still running");
		expect(kills).toEqual([]);
		expect(killSpy).not.toHaveBeenCalled();

		killSpy.mockRestore();
	}, 15000);

	it("does call the kill mechanism when the user cancels", async () => {
		kills.length = 0;
		const killSpy = vi.spyOn(process, "kill");

		const executor = createShellExecutor({ timeoutMs: 10_000 });
		const controller = new AbortController();
		const pending = executor(sleeper, process.cwd(), {
			...contextWith(noopSink),
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		controller.abort();

		await expect(pending).rejects.toThrow(/aborted/i);

		const terminated =
			kills.length > 0 || killSpy.mock.calls.length > 0;
		expect(terminated).toBe(true);
		expect(POSIX_KILL).toBeTruthy();

		killSpy.mockRestore();
	}, 15000);

	it("does call the kill mechanism on a plain timeout when no sink is provided", async () => {
		kills.length = 0;
		const killSpy = vi.spyOn(process, "kill");

		const executor = createShellExecutor({ timeoutMs: 150 });
		await expect(
			executor(sleeper, process.cwd(), contextWith()),
		).rejects.toThrow(/timed out/i);

		expect(kills.length > 0 || killSpy.mock.calls.length > 0).toBe(true);

		killSpy.mockRestore();
	}, 15000);
});
