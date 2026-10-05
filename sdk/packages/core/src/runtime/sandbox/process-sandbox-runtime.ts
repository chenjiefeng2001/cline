/**
 * Local process sandbox runtime — the first `SandboxRuntime` adapter
 * [roadmap P1-2].
 *
 * Wraps commands with the platform process sandbox (macOS Seatbelt /
 * Linux bubblewrap, workspace-write semantics — aligned with the Claude
 * Code local default). Fail-closed: when the sandbox backend is
 * unavailable the runtime throws {@link SandboxUnavailableError} instead
 * of silently running unsandboxed.
 */

import { spawnPlatformCommand } from "../../utils/shell-spawn";
import {
	buildProcessSandboxCommand,
	defaultProcessSandboxBackend,
	detectProcessSandbox,
	type ProcessSandboxBackend,
} from "./sandbox-command";
import {
	type SandboxExecutionRequest,
	type SandboxExecutionResult,
	type SandboxRuntime,
	SandboxUnavailableError,
} from "./sandbox-runtime";

/** Cap for captured output so a chatty sandboxed command cannot exhaust memory. */
const OUTPUT_CAP_CHARS = 1_000_000;

export interface ProcessSandboxRuntimeOptions {
	/** Explicit backend; defaults to the platform default (darwin/linux). */
	backend?: ProcessSandboxBackend;
	/** Workspace root that stays writable inside the sandbox. */
	workspaceRoot: string;
	/**
	 * Whether sandboxed commands may reach the network. Defaults to `false`.
	 * Forwarded to the command builder, which denies `network*` on Seatbelt and
	 * unshares the network namespace on bubblewrap.
	 */
	networkAccess?: boolean;
	/** PATH override for detection (tests). */
	pathEnv?: string;
	/** Platform override for detection (tests). */
	platform?: NodeJS.Platform;
}

function appendCapped(target: string, chunk: string): string {
	const next = target + chunk;
	return next.length > OUTPUT_CAP_CHARS
		? next.slice(0, OUTPUT_CAP_CHARS)
		: next;
}

export class ProcessSandboxRuntime implements SandboxRuntime {
	readonly backend: ProcessSandboxBackend;
	private readonly workspaceRoot: string;
	private readonly networkAccess?: boolean;
	private readonly pathEnv?: string;
	private readonly platformOverride?: NodeJS.Platform;

	constructor(options: ProcessSandboxRuntimeOptions) {
		const platform = options.platform ?? process.platform;
		this.backend =
			options.backend ?? defaultProcessSandboxBackend(platform) ?? "seatbelt";
		this.workspaceRoot = options.workspaceRoot;
		this.networkAccess = options.networkAccess;
		this.pathEnv = options.pathEnv;
		this.platformOverride = options.platform;
	}

	private detect() {
		return detectProcessSandbox({
			backend: this.backend,
			pathEnv: this.pathEnv,
			platform: this.platformOverride,
		});
	}

	isAvailable(): boolean {
		return this.detect().available;
	}

	async exec(
		request: SandboxExecutionRequest,
	): Promise<SandboxExecutionResult> {
		const detection = this.detect();
		if (!detection.available || !detection.binaryPath) {
			throw new SandboxUnavailableError(
				this.backend,
				detection.reason ?? `sandbox backend unavailable: ${this.backend}`,
			);
		}
		const sandboxed = buildProcessSandboxCommand({
			command: request.command,
			args: request.args,
			workspaceRoot: this.workspaceRoot,
			networkAccess: this.networkAccess,
			backend: this.backend,
		});
		if (!sandboxed) {
			throw new SandboxUnavailableError(
				this.backend,
				`process sandbox is unsupported on this platform: ${process.platform}`,
			);
		}
		// Route through the detected absolute binary path, not the bare name,
		// so the resolved sandbox is exactly the one detection found.
		return execSandboxedCommand({
			command: detection.binaryPath,
			args: sandboxed.args,
			cwd: request.cwd,
			timeoutMs: request.timeoutMs,
		});
	}
}

function execSandboxedCommand(request: {
	command: string;
	args: string[];
	cwd?: string;
	timeoutMs?: number;
}): Promise<SandboxExecutionResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const child = spawnPlatformCommand(request.command, request.args, {
			cwd: request.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = request.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, request.timeoutMs)
			: undefined;

		const settle = (exitCode: number | null) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			resolve({
				exitCode,
				stdout,
				stderr,
				durationMs: Date.now() - startedAt,
				timedOut,
			});
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = appendCapped(stdout, chunk.toString("utf8"));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendCapped(stderr, chunk.toString("utf8"));
		});
		child.on("error", (error: Error) => {
			stderr = appendCapped(stderr, `\n${error.message}`);
			settle(null);
		});
		child.on("close", (code) => {
			settle(code);
		});
	});
}
