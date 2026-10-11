/**
 * Bash Executor
 *
 * Built-in implementation for running shell commands using Node.js spawn.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
	type AgentToolContext,
	getDefaultShell,
	getShellArgs,
} from "@cline/shared";
import { TimeoutError } from "../helpers";
import type { ShellExecutor } from "../types";
import {
	createDetachedLogWriter,
	formatTimeoutDetachResult,
	openDetachedCommandLog,
} from "./detached-log";
import {
	MAX_COMMAND_OUTPUT_CHARS,
	truncateCommandOutput,
} from "./output-limits";

interface CollectorSnapshot {
	text: string;
	totalChars: number;
	dropped: boolean;
}

export class CommandExitError extends Error {
	constructor(
		readonly exitCode: number,
		readonly output: string,
	) {
		super(`Command exited with code ${exitCode}`);
		this.name = "CommandExitError";
	}
}

/**
 * Options for the shell executor
 */
export interface ShellExecutorOptions {
	/**
	 * Shell to use for execution
	 * @default "/bin/bash" on Unix, "powershell" on Windows
	 */
	shell?: string;

	/**
	 * Timeout for command execution in milliseconds
	 * @default 30000 (30 seconds)
	 */
	timeoutMs?: number;

	/**
	 * Maximum output kept, in characters. Output beyond this is
	 * middle-truncated: the head and tail are preserved and the middle is
	 * elided, since build and test failures usually live at the end of the
	 * output.
	 * @default 48_000 — see MAX_COMMAND_OUTPUT_CHARS in output-limits.ts
	 */
	maxOutputChars?: number;

	/**
	 * @deprecated Misnamed — the limit was always enforced in characters,
	 * not bytes. Use {@link maxOutputChars}; this alias is honored when
	 * maxOutputChars is not set.
	 */
	maxOutputBytes?: number;

	/**
	 * Environment variables to add/override
	 */
	env?: Record<string, string>;

	/**
	 * Whether to combine stdout and stderr
	 * @default true
	 */
	combineOutput?: boolean;
}

interface SpawnConfig {
	executable: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

/**
 * Collects stream output with bounded memory: the first half of the budget
 * is kept verbatim, the rest rolls so the latest output always survives.
 *
 * Exported so the detach handover can be tested without a real process: the
 * invariant it protects is about chunk ordering, which timing-based tests can
 * only sample, not prove.
 */
export function createRollingCollector(maxChars: number) {
	const headLimit = Math.ceil(maxChars / 2);
	const tailLimit = Math.max(1, maxChars - headLimit);
	// StringDecoder keeps multibyte UTF-8 sequences split across stream
	// chunks intact instead of corrupting them at chunk boundaries.
	const decoder = new StringDecoder("utf8");
	let head = "";
	let tail = "";
	let totalChars = 0;
	let forward: ((text: string) => void) | undefined;

	const appendText = (text: string): void => {
		if (!text) return;
		totalChars += text.length;
		const headRoom = headLimit - head.length;
		if (headRoom > 0) {
			head += text.slice(0, headRoom);
			tail = (tail + text.slice(headRoom)).slice(-tailLimit);
		} else {
			tail = (tail + text).slice(-tailLimit);
		}
		// Only ever set by detachTo. Output forwarded from here on belongs to
		// the detached log, not to the rolling window, whose whole purpose is
		// to discard the oldest bytes — exactly the ones a handover must keep.
		forward?.(text);
	};

	return {
		append(data: Buffer): void {
			appendText(decoder.write(data));
		},
		/**
		 * Take the snapshot and start forwarding, in one synchronous step.
		 *
		 * Splitting these into two calls would reopen the handover window:
		 * `open()` is asynchronous, so a second call after it resolves would
		 * leave a gap in which new output reached only the rolling window and
		 * was discarded. Node delivers `data` events one at a time and cannot
		 * interleave with this synchronous block, so every chunk is wholly on
		 * one side of it — none is lost and none is written twice.
		 *
		 * `decoder.end()` is deliberately not called here: those buffered bytes
		 * are a prefix of the next chunk, so they surface as the first forwarded
		 * text, which is their correct position after the snapshot.
		 */
		detachTo(onChunk: (text: string) => void) {
			forward = onChunk;
			return {
				text: head + tail,
				totalChars,
				dropped: totalChars > head.length + tail.length,
			};
		},
		snapshot() {
			// Flush bytes the decoder buffered for an incomplete multibyte
			// sequence at end-of-stream; otherwise the final characters of
			// non-ASCII output are silently dropped.
			appendText(decoder.end());
			return {
				text: head + tail,
				totalChars,
				dropped: totalChars > head.length + tail.length,
			};
		},
	};
}

function spawnAndCollect(
	config: SpawnConfig,
	context: AgentToolContext,
	timeoutMs: number,
	maxOutputChars: number,
	combineOutput: boolean,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const isWindows = process.platform === "win32";

		const child = spawn(config.executable, config.args, {
			cwd: config.cwd,
			env: { ...process.env, ...config.env },
			stdio: ["pipe", "pipe", "pipe"],
			detached: !isWindows,
			// Prevent a console window from flashing on Windows when the
			// parent process has no console (or a different console).
			// No-op on non-Windows platforms.
			windowsHide: true,
		});
		const childPid = child.pid;

		const stdout = createRollingCollector(maxOutputChars);
		const stderr = createRollingCollector(maxOutputChars);
		let killed = false;
		let settled = false;
		let detached = false;

		const sink = context.detachedCommandLog;
		// Created up front so output arriving while the sink is still creating
		// the file has somewhere to go. Without a handle it buffers instead of
		// writing, which is what keeps the handover window free of gaps.
		const detachWriter = sink
			? createDetachedLogWriter({ emitNotice: context.emitNotice })
			: undefined;
		const forwardChunk = (chunk: string): void => {
			detachWriter?.enqueue(chunk);
		};

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		const killProcessTree = () => {
			if (!childPid) return;
			if (isWindows) {
				const killer = spawn(
					"taskkill",
					["/pid", String(childPid), "/T", "/F"],
					{ stdio: "ignore", shell: true, windowsHide: true },
				);
				killer.unref();
				return;
			}
			try {
				process.kill(-childPid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		const killAndReject = (error: Error) => {
			killed = true;
			killProcessTree();
			settle(() => reject(error));
		};

		const combineSnapshots = (out: CollectorSnapshot, err: CollectorSnapshot) => ({
			text: combineOutput
				? out.text + (err.text ? `\n[stderr]\n${err.text}` : "")
				: out.text,
			truncated: out.dropped || (combineOutput && err.dropped),
		});

		/**
		 * Stop waiting without stopping the command.
		 *
		 * Deliberately does not touch `killed` or `killProcessTree`: a timeout
		 * means the tool gave up waiting, not that the process failed. The child
		 * keeps running and keeps writing to the log.
		 */
		const detachOnTimeout = async (): Promise<void> => {
			if (!sink) {
				return;
			}
			// The command can finish in the same tick the timer fires, or be
			// cancelled just before. Either way its own outcome owns the result;
			// reporting "still running" for a process that already ended would
			// be the exact false claim this path exists to avoid.
			if (settled || killed) {
				return;
			}
			detached = true;
			// Stop the abort listener: once detached, the user was told the
			// command is still running, so a later cancel must not kill it.
			cleanup();

			const captured = combineSnapshots(
				stdout.detachTo(forwardChunk),
				stderr.detachTo(forwardChunk),
			);
			// Synchronous, immediately after detachTo and with no await in
			// between, so the snapshot is always the log's first content and no
			// forwarded chunk can overtake it.
			detachWriter?.enqueue(captured.text);

			const handle = await openDetachedCommandLog(sink, {
				command: config.args.join(" "),
				initialOutput: captured.text,
				truncated: captured.truncated,
			});

			if (!handle) {
				settle(() =>
					resolve(
						formatTimeoutDetachResult({
							output: captured.text,
							truncated: captured.truncated,
						}),
					),
				);
				return;
			}

			// A cancel that landed while the sink was opening already killed the
			// process and settled the promise. The log still has to be closed,
			// or its handle leaks and a temp file is never finalised.
			if (settled || killed) {
				await detachWriter?.finish(
					"[Command was cancelled before its detached log finished opening]",
				);
				return;
			}

			await detachWriter?.attach(handle);
			settle(() =>
				resolve(
					formatTimeoutDetachResult({
						logPath: handle.path,
						output: captured.text,
						truncated: captured.truncated,
					}),
				),
			);
		};

		const timeout = setTimeout(
			() =>
				sink
					? void detachOnTimeout()
					: killAndReject(
							new TimeoutError(`Command timed out after ${timeoutMs}ms`, timeoutMs),
						),
			timeoutMs,
		);

		const abortHandler = () => killAndReject(new Error("Command was aborted"));

		if (context.signal) {
			context.signal.addEventListener("abort", abortHandler);
		}

		const cleanup = () => {
			clearTimeout(timeout);
			context.signal?.removeEventListener("abort", abortHandler);
		};

		child.stdout?.on("data", (data: Buffer) => {
			stdout.append(data);
		});

		child.stderr?.on("data", (data: Buffer) => {
			stderr.append(data);
		});

		child.on("close", (code) => {
			cleanup();
			if (detached) {
				void detachWriter?.finish(
					code === 0
						? "[Command completed with exit code 0 after the tool stopped waiting]"
						: `[Command completed with exit code ${code ?? 1} after the tool stopped waiting]`,
				);
				return;
			}
			if (killed) return;

			const out = stdout.snapshot();
			const err = stderr.snapshot();

			if (code !== 0) {
				const exitCode = code ?? 1;
				let failureOutput = combineOutput
					? out.text + (err.text ? `\n[stderr]\n${err.text}` : "")
					: out.text;
				const dropped = out.dropped || (combineOutput && err.dropped);
				const totalChars = combineOutput
					? out.totalChars + err.totalChars
					: out.totalChars;
				if (dropped || failureOutput.length > maxOutputChars) {
					failureOutput = truncateCommandOutput(failureOutput, {
						maxChars: maxOutputChars,
						totalChars,
					});
				}
				const result =
					failureOutput.length > 0
						? `[Command exited with code ${exitCode}]\n${failureOutput}`
						: `[Command exited with code ${exitCode}]`;
				settle(() => reject(new CommandExitError(exitCode, result)));
			} else {
				let output = combineOutput
					? out.text + (err.text ? `\n[stderr]\n${err.text}` : "")
					: out.text;
				const dropped = out.dropped || (combineOutput && err.dropped);
				if (dropped || output.length > maxOutputChars) {
					const totalChars = combineOutput
						? out.totalChars + err.totalChars
						: out.totalChars;
					output = truncateCommandOutput(output, {
						maxChars: maxOutputChars,
						totalChars,
					});
				}
				settle(() => resolve(output));
			}
		});

		child.on("error", (error) => {
			cleanup();
			if (detached) {
				void detachWriter?.finish(
					`[Command failed after detaching: ${error.message}]`,
				);
				return;
			}
			settle(() =>
				reject(new Error(`Failed to execute command: ${error.message}`)),
			);
		});
	});
}

/**
 * Create a shell executor using Node.js spawn
 *
 * @example
 * ```typescript
 * const shell = createShellExecutor({
 *   timeoutMs: 60000, // 1 minute timeout
 *   shell: "/bin/zsh",
 * })
 *
 * const output = await shell("ls -la", "/path/to/project", context)
 * ```
 */
export function createShellExecutor(
	options: ShellExecutorOptions = {},
): ShellExecutor {
	const {
		shell = getDefaultShell(process.platform),
		timeoutMs = 30000,
		env = {},
		combineOutput = true,
	} = options;
	const maxOutputChars =
		options.maxOutputChars ??
		options.maxOutputBytes ??
		MAX_COMMAND_OUTPUT_CHARS;

	const executorFn: ShellExecutor = (command, cwd, context) => {
		const isStructured = typeof command !== "string";
		return spawnAndCollect(
			{
				executable: isStructured ? command.command : shell,
				args: isStructured
					? (command.args ?? [])
					: getShellArgs(shell, command),
				cwd,
				env,
			},
			context,
			timeoutMs,
			maxOutputChars,
			combineOutput,
		);
	};

	// Always true: spawnAndCollect arms its own timer unconditionally, so the
	// wrapper must not race it with a second one.
	executorFn.managesOwnTimeout = true;

	return executorFn;
}
