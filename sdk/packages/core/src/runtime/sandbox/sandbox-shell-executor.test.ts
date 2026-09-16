import { describe, expect, it, vi } from "vitest";
import type {
	SandboxExecutionRequest,
	SandboxExecutionResult,
	SandboxRuntime,
} from "./sandbox-runtime";
import { SandboxUnavailableError } from "./sandbox-runtime";
import { createSandboxShellExecutor } from "./sandbox-shell-executor";

const makeSandbox = (
	impl: (request: SandboxExecutionRequest) => Promise<SandboxExecutionResult>,
): SandboxRuntime => ({
	backend: "test",
	isAvailable: () => true,
	exec: vi.fn(impl),
});

const ok = (stdout = ""): SandboxExecutionResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
	durationMs: 1,
	timedOut: false,
});

describe("createSandboxShellExecutor", () => {
	it("routes structured commands through the sandbox with argv intact", async () => {
		const sandbox = makeSandbox(async () => ok("built\n"));
		const executor = createSandboxShellExecutor({ sandbox });
		const output = await executor(
			{ command: "npm", args: ["run", "build"] },
			"/repo/a",
			{} as never,
		);
		expect(output).toBe("built\n");
		expect(sandbox.exec).toHaveBeenCalledWith({
			command: "npm",
			args: ["run", "build"],
			cwd: "/repo/a",
		});
	});

	it("wraps plain string commands as <shell> -c <command>", async () => {
		const sandbox = makeSandbox(async () => ok());
		const executor = createSandboxShellExecutor({
			sandbox,
			shell: "bash",
		});
		await executor("npm install && npm test", "/repo/a", {} as never);
		expect(sandbox.exec).toHaveBeenCalledWith({
			command: "bash",
			args: ["-c", "npm install && npm test"],
			cwd: "/repo/a",
		});
	});

	it("defaults the shell to sh", async () => {
		const sandbox = makeSandbox(async () => ok());
		const executor = createSandboxShellExecutor({ sandbox });
		await executor("echo hi", "/repo/a", {} as never);
		expect(sandbox.exec).toHaveBeenCalledWith({
			command: "sh",
			args: ["-c", "echo hi"],
			cwd: "/repo/a",
		});
	});

	it("throws with stderr on non-zero exit", async () => {
		const sandbox = makeSandbox(async () => ({
			exitCode: 2,
			stdout: "",
			stderr: "npm ERR! missing script",
			durationMs: 5,
			timedOut: false,
		}));
		const executor = createSandboxShellExecutor({ sandbox });
		await expect(
			executor(
				{ command: "npm", args: ["run", "nope"] },
				"/repo/a",
				{} as never,
			),
		).rejects.toThrow("npm ERR! missing script");
	});

	it("propagates SandboxUnavailableError fail-closed (no silent downgrade)", async () => {
		const sandbox = makeSandbox(async () => {
			throw new SandboxUnavailableError("seatbelt", "sandbox-exec not found");
		});
		const executor = createSandboxShellExecutor({ sandbox });
		await expect(executor("echo hi", "/repo/a", {} as never)).rejects.toThrow(
			SandboxUnavailableError,
		);
	});
});
