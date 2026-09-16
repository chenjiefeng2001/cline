/**
 * Sandbox shell executor — routes shell commands through a SandboxRuntime
 * [P1-2 wiring, roadmap].
 *
 * The isolation-layer wiring point for the run_commands executor surface:
 * hosts hand this executor to `createShellTool` instead of the stock one,
 * and every command runs inside the sandbox (Seatbelt/bubblewrap
 * workspace-write). Fail-closed by contract: when the sandbox backend is
 * unavailable the typed `SandboxUnavailableError` propagates — the wrapper
 * never silently downgrades to unsandboxed execution.
 */

import type { ShellExecutor } from "../../extensions/tools/types";
import type {
	SandboxExecutionRequest,
	SandboxRuntime,
} from "./sandbox-runtime";

export interface SandboxShellExecutorOptions {
	sandbox: SandboxRuntime;
	/**
	 * Shell for plain string commands under the sandbox (they carry shell
	 * syntax; the sandbox wraps them as `<shell> -c <command>`).
	 * Defaults to "sh".
	 */
	shell?: string;
}

export function createSandboxShellExecutor(
	options: SandboxShellExecutorOptions,
): ShellExecutor {
	const shell = options.shell ?? "sh";
	return async (command, cwd) => {
		const request: SandboxExecutionRequest =
			typeof command === "string"
				? { command: shell, args: ["-c", command], cwd }
				: {
						command: command.command,
						args: command.args ?? [],
						cwd,
					};
		const result = await options.sandbox.exec(request);
		if (result.exitCode !== 0) {
			throw new Error(
				result.stderr.trim() || `command exited with code ${result.exitCode}`,
			);
		}
		return result.stdout;
	};
}
