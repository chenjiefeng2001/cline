import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentAfterToolContext,
	AgentBeforeToolContext,
	AgentExtension,
	AgentHooks,
	AgentRunLifecycleContext,
	AgentRuntimeEvent,
} from "@cline/shared";
import {
	augmentNodeCommandForDebug,
	type BasicLogger,
	type HookControl,
	type HookSessionContext,
	type WorkspaceInfo,
	withResolvedClineBuildEnv,
} from "@cline/shared";
import { ensureHookLogDir } from "@cline/shared/storage";
import { createAgentHooksExtension } from "./hook-extension";
import { listHookConfigFiles } from "./hook-file-config";
import type { HookEventName, HookEventPayload } from "./subprocess";

type HookContextBase = {
	agentId: string;
	conversationId: string;
	parentAgentId: string | null;
};

type HookCommandControl = Omit<HookControl, "appendMessages"> & {
	systemPrompt?: string;
	appendMessages?: unknown[];
};

type HookCommandRunStartContext = HookContextBase & {
	userMessage: string;
};
type HookCommandToolCallStartContext = HookContextBase & {
	iteration: number;
	call: { id: string; name: string; input: unknown };
};
type HookCommandToolCallEndContext = HookContextBase & {
	iteration: number;
	record: {
		id: string;
		name: string;
		input: unknown;
		output: unknown;
		error?: string;
		durationMs: number;
		startedAt: Date;
		endedAt: Date;
	};
};
type HookCommandTurnEndContext = HookContextBase & {
	iteration: number;
	turn: unknown;
};
type HookCommandStopErrorContext = HookContextBase & {
	iteration: number;
	error: Error;
};
type HookCommandSessionShutdownContext = HookContextBase & {
	reason?: string;
};

type HookRuntimeOptions = {
	cwd: string;
	workspacePath: string;
	rootSessionId?: string;
	logger?: BasicLogger;
	toolCallTimeoutMs?: number;
	/**
	 * Upper bound on a blocking hook command.
	 *
	 * The runner is not safe without one. It waits on the child's `close` and nothing
	 * else bounds that wait, so a hook that never exits - a wedged interpreter, a
	 * grandchild holding the stdio pipe open - stalls every tool call for as long as the
	 * default allows, and callers with a shorter budget than that never observe the
	 * timeout at all; they simply lose their run to it.
	 *
	 * @default DEFAULT_HOOK_COMMAND_TIMEOUT_MS
	 */
	timeoutMs?: number;
	/** Structured git + path metadata forwarded into every hook payload. */
	workspaceInfo?: WorkspaceInfo;
};

function mapParams(input: unknown): Record<string, string> {
	if (!input || typeof input !== "object") {
		return {};
	}
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		output[key] = typeof value === "string" ? value : JSON.stringify(value);
	}
	return output;
}

function logHookError(
	logger: BasicLogger | undefined,
	message: string,
	error?: unknown,
): void {
	const detail = error instanceof Error ? `: ${error.message}` : "";
	const text = `${message}${detail}`;
	if (logger) {
		try {
			logger.log(text, {
				severity: "warn",
				...(error !== undefined ? { error } : {}),
			});
		} catch {
			// Logging failures must not break hook execution.
		}
		return;
	}
	console.warn(text);
}

function mergeHookControls(
	current: HookCommandControl | undefined,
	next: HookCommandControl | undefined,
): HookCommandControl | undefined {
	if (!next) {
		return current;
	}
	if (!current) {
		return { ...next };
	}
	const contexts = [current.context, next.context]
		.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		)
		.join("\n");
	const appendMessages = [
		...(current.appendMessages ?? []),
		...(next.appendMessages ?? []),
	];
	return {
		cancel: current.cancel === true || next.cancel === true ? true : undefined,
		review: current.review === true || next.review === true ? true : undefined,
		context: contexts || undefined,
		overrideInput:
			next.overrideInput !== undefined
				? next.overrideInput
				: current.overrideInput,
		systemPrompt:
			next.systemPrompt !== undefined
				? next.systemPrompt
				: current.systemPrompt,
		appendMessages: appendMessages.length > 0 ? appendMessages : undefined,
	};
}

function parseHookControl(value: unknown): HookCommandControl | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const context =
		typeof record.context === "string"
			? record.context
			: typeof record.contextModification === "string"
				? record.contextModification
				: typeof record.errorMessage === "string"
					? record.errorMessage
					: undefined;
	return {
		cancel: typeof record.cancel === "boolean" ? record.cancel : undefined,
		review: typeof record.review === "boolean" ? record.review : undefined,
		context,
		overrideInput: Object.hasOwn(record, "overrideInput")
			? record.overrideInput
			: undefined,
	};
}

function isAbortReason(reason?: string): boolean {
	const value = String(reason ?? "").toLowerCase();
	return (
		value.includes("cancel") ||
		value.includes("abort") ||
		value.includes("interrupt")
	);
}

function createPayloadBase(
	ctx: HookContextBase,
	options: HookRuntimeOptions,
): Omit<HookEventPayload, "hookName"> {
	const userId =
		process.env.CLINE_USER_ID?.trim() || process.env.USER?.trim() || "unknown";
	const sessionContext: HookSessionContext = {
		rootSessionId: options.rootSessionId || ctx.conversationId,
	};
	return {
		clineVersion: process.env.CLINE_VERSION?.trim() || "",
		timestamp: new Date().toISOString(),
		taskId: ctx.conversationId,
		sessionContext,
		workspaceRoots: options.workspacePath ? [options.workspacePath] : [],
		workspaceInfo: options.workspaceInfo,
		userId,
		agent_id: ctx.agentId,
		parent_agent_id: ctx.parentAgentId,
	} as Omit<HookEventPayload, "hookName">;
}

type HookCommandMap = Partial<Record<HookEventName, string[][]>>;

interface HookCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	parsedJson?: unknown;
	parseError?: string;
	timedOut?: boolean;
}

function parseHookStdout(stdout: string): {
	parsedJson?: unknown;
	parseError?: string;
} {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return {};
	}
	const lines = trimmed
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const prefixed = lines
		.filter((line) => line.startsWith("HOOK_CONTROL\t"))
		.map((line) => line.slice("HOOK_CONTROL\t".length));
	const candidate =
		prefixed.length > 0 ? prefixed[prefixed.length - 1] : trimmed;
	try {
		return { parsedJson: JSON.parse(candidate) };
	} catch (error) {
		return {
			parseError:
				error instanceof Error
					? error.message
					: "Failed to parse hook stdout JSON",
		};
	}
}

async function writeToChildStdin(
	child: ReturnType<typeof spawn>,
	body: string,
): Promise<void> {
	const stdin = child.stdin;
	if (!stdin) {
		throw new Error("hook command failed to create stdin");
	}

	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			stdin.off("error", onError);
			stdin.off("finish", onFinish);
			child.off("close", onChildClose);
		};
		const finish = (error?: Error | null) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			if (error) {
				const code = (error as Error & { code?: string }).code;
				if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
					resolve();
					return;
				}
				reject(error);
				return;
			}
			resolve();
		};
		const onError = (error: Error) => finish(error);
		const onFinish = () => finish();
		const onChildClose = () => finish();
		stdin.on("error", onError);
		stdin.once("finish", onFinish);
		child.once("close", onChildClose);
		try {
			stdin.end(body);
		} catch (error) {
			finish(error as Error);
		}
	});
}

async function runHookCommand(
	payload: HookEventPayload,
	options: {
		command: string[];
		cwd: string;
		env?: NodeJS.ProcessEnv;
		detached: boolean;
		timeoutMs?: number;
	},
): Promise<HookCommandResult | undefined> {
	if (options.command.length === 0) {
		throw new Error("runHookCommand requires non-empty command");
	}
	try {
		return await runHookCommandOnce(payload, options);
	} catch (error) {
		const fallbackCommand = getWindowsPythonFallbackCommand(
			options.command,
			process.platform,
			error,
		);
		if (!fallbackCommand) {
			throw error;
		}
		return await runHookCommandOnce(payload, {
			...options,
			command: fallbackCommand,
		});
	}
}

async function runHookCommandOnce(
	payload: HookEventPayload,
	options: {
		command: string[];
		cwd: string;
		env?: NodeJS.ProcessEnv;
		detached: boolean;
		timeoutMs?: number;
	},
): Promise<HookCommandResult | undefined> {
	const command = augmentNodeCommandForDebug(options.command, {
		env: options.env,
		debugRole: "hook",
	});
	const child = spawn(command[0], command.slice(1), {
		cwd: options.cwd,
		env: withResolvedClineBuildEnv(options.env),
		stdio: options.detached
			? ["pipe", "ignore", "ignore"]
			: ["pipe", "pipe", "pipe"],
		detached: options.detached,
		// Prevent a console window from flashing on Windows (especially when
		// detached, which would otherwise allocate a new console).
		windowsHide: true,
	});
	const spawned = new Promise<void>((resolve) => {
		child.once("spawn", () => resolve());
	});
	const childError = new Promise<never>((_, reject) => {
		child.once("error", (error) => reject(error));
	});

	// Every listener that can observe the child's lifetime is attached HERE,
	// synchronously at spawn, and not after an await.
	//
	// This is a lost-event bug, not a style preference. `writeToChildStdin` attaches
	// its own `child.once("close")` to survive a child that exits early, and it is
	// awaited below. A hook that fails immediately - crashes on an unresolved module,
	// or exits before reading stdin - closes while that await is pending, and the
	// `close` is consumed there. If this function then attached its own `close`
	// listener afterwards, the event had already fired, nothing would ever resolve
	// the result, and the call would hang until whatever timeout the caller has.
	//
	// It reproduces as an intermittent hang, because it is a race: it needs the child
	// to exit inside that await window, which is more likely on a loaded Windows
	// runner and for a hook that is failing (the case where you most want an error
	// rather than a hang).
	const body = JSON.stringify(payload);

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let timeoutId: NodeJS.Timeout | undefined;
	let settleResult: ((value: HookCommandResult) => void) | undefined;
	const result = new Promise<HookCommandResult>((resolve) => {
		settleResult = resolve;
	});

	if (options.detached) {
		await Promise.race([spawned, childError]);
		await writeToChildStdin(child, body);
		child.unref();
		return;
	}

	if (!child.stdout || !child.stderr) {
		throw new Error("hook command failed to create stdout/stderr");
	}
	child.stdout.on("data", (chunk: Buffer | string) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer | string) => {
		stderr += chunk.toString();
	});
	child.once("close", (exitCode) => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		const { parsedJson, parseError } = parseHookStdout(stdout);
		settleResult?.({
			exitCode,
			stdout,
			stderr,
			parsedJson,
			parseError,
			timedOut,
		});
	});

	await Promise.race([spawned, childError]);
	if ((options.timeoutMs ?? 0) > 0) {
		timeoutId = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
	}
	await writeToChildStdin(child, body);

	return await Promise.race([result, childError]);
}

function parseShebangCommand(path: string): string[] | undefined {
	try {
		const content = readFileSync(path, "utf8");
		const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
		if (!firstLine?.startsWith("#!")) {
			return undefined;
		}
		const shebang = firstLine.slice(2).trim();
		if (!shebang) {
			return undefined;
		}
		const tokens = shebang.split(/\s+/).filter(Boolean);
		return tokens.length > 0 ? tokens : undefined;
	} catch {
		return undefined;
	}
}

function isMissingCommandError(error: unknown): boolean {
	return !!(
		error &&
		typeof error === "object" &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

export function getWindowsPythonFallbackCommand(
	command: string[],
	platform = process.platform,
	error?: unknown,
): string[] | undefined {
	if (platform !== "win32" || !isMissingCommandError(error)) {
		return undefined;
	}
	if (command[0] !== "py" || command[1] !== "-3") {
		return undefined;
	}
	return ["python", ...command.slice(2)];
}

function normalizeHookInterpreter(tokens: string[]): string[] | undefined {
	if (tokens.length === 0) {
		return undefined;
	}
	const [rawCommand, ...rest] = tokens;
	const normalizedCommand = rawCommand.replace(/\\/g, "/").toLowerCase();
	const commandName = normalizedCommand.split("/").at(-1) ?? normalizedCommand;

	if (commandName === "env") {
		return normalizeHookInterpreter(rest);
	}

	if (commandName === "bash" || commandName === "sh" || commandName === "zsh") {
		return [commandName, ...rest];
	}

	if (commandName === "python3" || commandName === "python") {
		return process.platform === "win32"
			? ["py", "-3", ...rest]
			: [commandName, ...rest];
	}

	return tokens;
}

/** Shells that cannot execute a hook script given a Windows path. */
function isUnixShell(interpreter: string | undefined): boolean {
	if (!interpreter) {
		return false;
	}
	const name = interpreter.replace(/\\/g, "/").toLowerCase().split("/").at(-1)
	return name === "bash" || name === "sh" || name === "zsh" || name === "env"
}

function inferHookCommand(path: string, platform = process.platform): string[] {
	const shebang = parseShebangCommand(path);
	if (shebang && shebang.length > 0) {
		// Refused outright on Windows rather than attempted.
		//
		// `bash <windows-path>` cannot work here: Git's bash cannot open a Windows path
		// handed to it as an argument, and WSL's bash strips the separators and exits
		// 127. Attempting it gave a fast, silent failure - the hook simply never ran,
		// with nothing in the log but the mangled path. Measured at 12/12 runs, so it
		// was not even intermittent. Saying so up front is the useful behaviour: the
		// user learns their hook is not running, and is told what to write instead.
		if (platform === "win32" && isUnixShell(normalizeHookInterpreter(shebang)?.[0] ?? shebang[0])) {
			throw new UnsupportedHookInterpreterError(
				path,
				shebang.join(" "),
				"The only bash on a Windows machine is either Git's, which cannot execute a script given a Windows path, or WSL's, which mangles the path and exits 127.",
			)
		}
		return [...(normalizeHookInterpreter(shebang) ?? shebang), path];
	}
	const lowered = path.toLowerCase();
	if (
		lowered.endsWith(".sh") ||
		lowered.endsWith(".bash") ||
		lowered.endsWith(".zsh")
	) {
		return ["bash", path];
	}
	if (
		lowered.endsWith(".js") ||
		lowered.endsWith(".mjs") ||
		lowered.endsWith(".cjs")
	) {
		return augmentNodeCommandForDebug(["node", path], {
			debugRole: "hook",
		});
	}
	if (
		lowered.endsWith(".ts") ||
		lowered.endsWith(".mts") ||
		lowered.endsWith(".cts")
	) {
		return ["bun", "run", path];
	}
	if (lowered.endsWith(".py")) {
		return process.platform === "win32"
			? ["py", "-3", path]
			: ["python3", path];
	}
	if (lowered.endsWith(".ps1")) {
		return [
			process.platform === "win32" ? "powershell" : "pwsh",
			"-File",
			path,
		];
	}
	// Default to bash for legacy hook files with no extension/shebang.
	return ["bash", path];
}

/**
 * Raised when a hook cannot be launched on this platform at all.
 *
 * Distinct from a hook that launches and fails. A hook that runs and exits non-zero is
 * the hook's own problem and the user should see its stderr; this one is ours, and the
 * only useful thing to do is tell the user how to write the hook for their platform.
 */
export class UnsupportedHookInterpreterError extends Error {
	constructor(
		readonly scriptPath: string,
		readonly interpreter: string,
		readonly reason: string,
	) {
		super(
			`Hook ${scriptPath} declares "#!${interpreter}", which cannot run on Windows. ` +
				`${reason} ` +
				`Write the hook as PowerShell instead: rename it to ` +
				`${scriptPath.replace(/\.[^.]*$/, "")}.ps1 and it will be launched with ` +
				`powershell -File automatically. Nothing was executed.`,
		)
		this.name = "UnsupportedHookInterpreterError"
	}
}

function createHookCommandMap(
	workspacePath: string,
	onUnsupported?: (error: UnsupportedHookInterpreterError) => void,
): HookCommandMap {
	const map: HookCommandMap = {};
	for (const file of listHookConfigFiles(workspacePath)) {
		if (!file.hookEventName) {
			continue;
		}
		const hookEventName = file.hookEventName;
		const existing = map[hookEventName] ?? [];
		try {
			existing.push(inferHookCommand(file.path));
		} catch (error) {
			// One unusable hook must not take the rest down with it: reported and skipped,
			// so the user sees which file is the problem and the hooks that do work still
			// do.
			if (error instanceof UnsupportedHookInterpreterError) {
				onUnsupported?.(error);
				continue;
			}
			throw error;
		}
		map[hookEventName] = existing;
	}
	return map;
}

async function runBlockingHookCommands(options: {
	commands: string[][];
	payload: HookEventPayload;
	cwd: string;
	logger?: BasicLogger;
	timeoutMs?: number;
}): Promise<HookCommandControl | undefined> {
	let merged: HookCommandControl | undefined;
	for (const command of options.commands) {
		const commandLabel = command.join(" ");
		try {
			const result = await runHookCommand(options.payload, {
				command,
				cwd: options.cwd,
				env: withResolvedClineBuildEnv(process.env),
				detached: false,
				timeoutMs: options.timeoutMs,
			});
			if (result?.timedOut) {
				// The resolved argv, not just the label. A hook timeout is otherwise
				// undecidable on Windows, where the same script may launch as bash, as
				// WSL's bash, or not at all - and "which one" is the whole question.
				logHookError(
					options.logger,
					`hook command timed out: ${commandLabel} (argv=${JSON.stringify(command)}, cwd=${options.cwd})`,
				);
				continue;
			}
			if (result?.parseError) {
				logHookError(
					options.logger,
					`hook command returned invalid JSON control output: ${commandLabel} (${result.parseError})`,
				);
				continue;
			}
			merged = mergeHookControls(merged, parseHookControl(result?.parsedJson));
		} catch (error) {
			logHookError(
				options.logger,
				`hook command failed: ${commandLabel}`,
				error,
			);
		}
	}
	return merged;
}

function runAsyncHookCommands(options: {
	commands: string[][];
	payload: HookEventPayload;
	cwd: string;
	logger?: BasicLogger;
}): void {
	for (const command of options.commands) {
		const commandLabel = command.join(" ");
		void runHookCommand(options.payload, {
			command,
			cwd: options.cwd,
			env: withResolvedClineBuildEnv(process.env),
			detached: true,
		}).catch((error) => {
			logHookError(
				options.logger,
				`hook command failed: ${commandLabel}`,
				error,
			);
		});
	}
}

function baseContextFromSnapshot(
	snapshot: AgentRunLifecycleContext["snapshot"],
): HookContextBase {
	return {
		agentId: snapshot.agentId,
		conversationId:
			snapshot.conversationId ?? snapshot.runId ?? snapshot.agentId,
		parentAgentId: snapshot.parentAgentId ?? null,
	};
}

function runStartContext(
	ctx: AgentRunLifecycleContext,
	userMessage: string,
): HookCommandRunStartContext {
	return {
		...baseContextFromSnapshot(ctx.snapshot),
		userMessage,
	};
}

function toolCallStartContext(
	ctx: AgentBeforeToolContext,
): HookCommandToolCallStartContext {
	return {
		...baseContextFromSnapshot(ctx.snapshot),
		iteration: ctx.snapshot.iteration,
		call: {
			id: ctx.toolCall.toolCallId,
			name: ctx.toolCall.toolName,
			input: ctx.input,
		},
	};
}

function toolCallEndContext(
	ctx: AgentAfterToolContext,
): HookCommandToolCallEndContext {
	return {
		...baseContextFromSnapshot(ctx.snapshot),
		iteration: ctx.snapshot.iteration,
		record: {
			id: ctx.toolCall.toolCallId,
			name: ctx.toolCall.toolName,
			input: ctx.input,
			output: ctx.result.output,
			error: ctx.result.isError ? String(ctx.result.output) : undefined,
			durationMs: ctx.durationMs,
			startedAt: ctx.startedAt,
			endedAt: ctx.endedAt,
		},
	};
}

function textFromMessageContent(
	content: readonly { type: string; text?: string }[],
): string {
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function beforeToolResultFromControl(
	control: HookCommandControl | undefined,
): { stop?: boolean; reason?: string; input?: unknown } | undefined {
	if (!control) {
		return undefined;
	}
	const result: { stop?: boolean; reason?: string; input?: unknown } = {};
	if (control.cancel === true) {
		result.stop = true;
	}
	if (control.overrideInput !== undefined) {
		result.input = control.overrideInput;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export function createHookAuditHooks(options: {
	rootSessionId?: string;
	workspacePath: string;
	workspaceInfo?: WorkspaceInfo;
}): AgentHooks {
	const runtimeOptions: HookRuntimeOptions = {
		cwd: options.workspacePath,
		workspacePath: options.workspacePath,
		rootSessionId: options.rootSessionId,
		workspaceInfo: options.workspaceInfo,
	};

	const append = (payload: HookEventPayload): void => {
		const line = `${JSON.stringify({
			ts: new Date().toISOString(),
			...payload,
		})}\n`;
		const envPath = process.env.CLINE_HOOKS_LOG_PATH?.trim() || undefined;
		const logPath = envPath ?? join(ensureHookLogDir(), "hooks.jsonl");
		ensureHookLogDir(logPath);
		appendFileSync(logPath, line, "utf8");
	};

	return {
		beforeRun: async (ctx: AgentRunLifecycleContext) => {
			const commandCtx = runStartContext(ctx, "");
			append({
				...createPayloadBase(commandCtx, runtimeOptions),
				hookName: "agent_start",
				taskStart: { taskMetadata: {} },
			});
			return undefined;
		},
		beforeTool: async (ctx: AgentBeforeToolContext) => {
			const commandCtx = toolCallStartContext(ctx);
			append({
				...createPayloadBase(commandCtx, runtimeOptions),
				hookName: "tool_call",
				iteration: commandCtx.iteration,
				tool_call: {
					id: commandCtx.call.id,
					name: commandCtx.call.name,
					input: commandCtx.call.input,
				},
				preToolUse: {
					toolName: commandCtx.call.name,
					parameters: mapParams(commandCtx.call.input),
				},
			});
			return undefined;
		},
		afterTool: async (ctx: AgentAfterToolContext) => {
			const commandCtx = toolCallEndContext(ctx);
			append({
				...createPayloadBase(commandCtx, runtimeOptions),
				hookName: "tool_result",
				iteration: commandCtx.iteration,
				tool_result: commandCtx.record,
				postToolUse: {
					toolName: commandCtx.record.name,
					parameters: mapParams(commandCtx.record.input),
					result:
						typeof commandCtx.record.output === "string"
							? commandCtx.record.output
							: JSON.stringify(commandCtx.record.output),
					success: !commandCtx.record.error,
					executionTimeMs: commandCtx.record.durationMs,
				},
			});
			return undefined;
		},
		afterRun: async ({ snapshot, result }) => {
			const base = baseContextFromSnapshot(snapshot);
			if (result.status === "completed") {
				append({
					...createPayloadBase(base, runtimeOptions),
					hookName: "agent_end",
					iteration: result.iterations,
					turn: { outputText: result.outputText, status: result.status },
					taskComplete: { taskMetadata: {} },
				});
				return;
			}
			if (result.status === "aborted" || isAbortReason(result.error?.message)) {
				append({
					...createPayloadBase(base, runtimeOptions),
					hookName: "agent_abort",
					reason: result.error?.message,
					taskCancel: { taskMetadata: {} },
				});
				return;
			}
			if (result.error) {
				append({
					...createPayloadBase(base, runtimeOptions),
					hookName: "agent_error",
					iteration: result.iterations,
					error: {
						name: result.error.name,
						message: result.error.message,
						stack: result.error.stack,
					},
				});
			}
		},
		onEvent: async (event: AgentRuntimeEvent) => {
			if (event.type !== "message-added" || event.message.role !== "user") {
				return;
			}
			const commandCtx = runStartContext(
				{ snapshot: event.snapshot },
				textFromMessageContent(event.message.content),
			);
			append({
				...createPayloadBase(commandCtx, runtimeOptions),
				hookName: "prompt_submit",
				userPromptSubmit: {
					prompt: commandCtx.userMessage,
					attachments: [],
				},
			});
		},
	};
}

/**
 * Default upper bound on a single blocking hook command, in milliseconds.
 *
 * Deliberately generous: a hook is user-supplied code and may legitimately do real
 * work. The important property is that it exists, and that a host can lower it via
 * `HookRuntimeOptions.timeoutMs` when its own budget is shorter.
 */
export const DEFAULT_HOOK_COMMAND_TIMEOUT_MS = 120_000

export function createHookConfigFileHooks(
	options: HookRuntimeOptions,
): AgentHooks | undefined {
	const commandMap = createHookCommandMap(options.workspacePath, (error) => {
		// Surfaced through the hook logger rather than thrown, so one unusable hook does
		// not stop the usable ones from loading - and the user is told which file is the
		// problem and what to write instead. Silently skipping it would be the very
		// failure this replaces.
		logHookError(
			options.logger,
			`${error.message} This hook was skipped; the other hooks in this workspace are unaffected.`,
		)
	})
	const hasAnyHooks = Object.values(commandMap).some(
		(commands) => commands.length > 0,
	);
	if (!hasAnyHooks) {
		return undefined;
	}

	const runAgentStart = async (
		ctx: HookContextBase,
		hookName: "agent_start" | "agent_resume",
	): Promise<void> => {
		const commandPaths = commandMap[hookName] ?? [];
		if (commandPaths.length === 0) {
			return;
		}
		runAsyncHookCommands({
			commands: commandPaths,
			cwd: options.cwd,
			logger: options.logger,
			payload:
				hookName === "agent_resume"
					? {
							...createPayloadBase(ctx, options),
							hookName,
							taskResume: {
								taskMetadata: {},
								previousState: {},
							},
						}
					: {
							...createPayloadBase(ctx, options),
							hookName,
							taskStart: { taskMetadata: {} },
						},
		});
	};

	const runPromptSubmit = async (
		ctx: HookCommandRunStartContext,
	): Promise<void> => {
		const promptSubmit = commandMap.prompt_submit ?? [];
		if (promptSubmit.length > 0) {
			runAsyncHookCommands({
				commands: promptSubmit,
				cwd: options.cwd,
				logger: options.logger,
				payload: {
					...createPayloadBase(ctx, options),
					hookName: "prompt_submit",
					userPromptSubmit: {
						prompt: ctx.userMessage,
						attachments: [],
					},
				},
			});
		}
	};

	const runToolCallStart = async (
		ctx: HookCommandToolCallStartContext,
	): Promise<HookCommandControl | undefined> => {
		const commandPaths = commandMap.tool_call ?? [];
		if (commandPaths.length === 0) {
			return undefined;
		}
		return runBlockingHookCommands({
			commands: commandPaths,
			cwd: options.cwd,
			logger: options.logger,
			timeoutMs: options.timeoutMs ?? options.toolCallTimeoutMs ?? DEFAULT_HOOK_COMMAND_TIMEOUT_MS,
			payload: {
				...createPayloadBase(ctx, options),
				hookName: "tool_call",
				iteration: ctx.iteration,
				tool_call: {
					id: ctx.call.id,
					name: ctx.call.name,
					input: ctx.call.input,
				},
				preToolUse: {
					toolName: ctx.call.name,
					parameters: mapParams(ctx.call.input),
				},
			},
		});
	};

	const runToolCallEnd = async (
		ctx: HookCommandToolCallEndContext,
	): Promise<void> => {
		const commandPaths = commandMap.tool_result ?? [];
		if (commandPaths.length === 0) {
			return;
		}
		runAsyncHookCommands({
			commands: commandPaths,
			cwd: options.cwd,
			logger: options.logger,
			payload: {
				...createPayloadBase(ctx, options),
				hookName: "tool_result",
				iteration: ctx.iteration,
				tool_result: ctx.record,
				postToolUse: {
					toolName: ctx.record.name,
					parameters: mapParams(ctx.record.input),
					result:
						typeof ctx.record.output === "string"
							? ctx.record.output
							: JSON.stringify(ctx.record.output),
					success: !ctx.record.error,
					executionTimeMs: ctx.record.durationMs,
				},
			},
		});
	};

	const runTurnEnd = async (ctx: HookCommandTurnEndContext): Promise<void> => {
		const commandPaths = commandMap.agent_end ?? [];
		if (commandPaths.length === 0) {
			return;
		}
		runAsyncHookCommands({
			commands: commandPaths,
			cwd: options.cwd,
			logger: options.logger,
			payload: {
				...createPayloadBase(ctx, options),
				hookName: "agent_end",
				iteration: ctx.iteration,
				turn: ctx.turn,
				taskComplete: { taskMetadata: {} },
			},
		});
	};

	const runStopError = async (
		ctx: HookCommandStopErrorContext,
	): Promise<void> => {
		const commandPaths = commandMap.agent_error ?? [];
		if (commandPaths.length === 0) {
			return;
		}
		runAsyncHookCommands({
			commands: commandPaths,
			cwd: options.cwd,
			logger: options.logger,
			payload: {
				...createPayloadBase(ctx, options),
				hookName: "agent_error",
				iteration: ctx.iteration,
				error: {
					name: ctx.error.name,
					message: ctx.error.message,
					stack: ctx.error.stack,
				},
			},
		});
	};

	const runSessionShutdown = async (
		ctx: HookCommandSessionShutdownContext,
	): Promise<void> => {
		if (isAbortReason(ctx.reason)) {
			const abortCommands = commandMap.agent_abort ?? [];
			if (abortCommands.length > 0) {
				runAsyncHookCommands({
					commands: abortCommands,
					cwd: options.cwd,
					logger: options.logger,
					payload: {
						...createPayloadBase(ctx, options),
						hookName: "agent_abort",
						reason: ctx.reason,
						taskCancel: { taskMetadata: {} },
					},
				});
			}
		}
		const shutdownCommands = commandMap.session_shutdown ?? [];
		if (shutdownCommands.length === 0) {
			return;
		}
		runAsyncHookCommands({
			commands: shutdownCommands,
			cwd: options.cwd,
			logger: options.logger,
			payload: {
				...createPayloadBase(ctx, options),
				hookName: "session_shutdown",
				reason: ctx.reason,
			},
		});
	};

	const hooks: AgentHooks = {};
	if (
		(commandMap.agent_start?.length ?? 0) > 0 ||
		(commandMap.agent_resume?.length ?? 0) > 0 ||
		(commandMap.prompt_submit?.length ?? 0) > 0
	) {
		if (
			(commandMap.agent_start?.length ?? 0) > 0 ||
			(commandMap.agent_resume?.length ?? 0) > 0
		) {
			hooks.beforeRun = async (ctx: AgentRunLifecycleContext) => {
				const hookName =
					process.env.CLINE_HOOK_AGENT_RESUME === "1"
						? "agent_resume"
						: "agent_start";
				await runAgentStart(baseContextFromSnapshot(ctx.snapshot), hookName);
				return undefined;
			};
		}
		if ((commandMap.prompt_submit?.length ?? 0) > 0) {
			hooks.onEvent = async (event: AgentRuntimeEvent) => {
				if (event.type !== "message-added" || event.message.role !== "user") {
					return;
				}
				await runPromptSubmit(
					runStartContext(
						{ snapshot: event.snapshot },
						textFromMessageContent(event.message.content),
					),
				);
			};
		}
	}
	if ((commandMap.tool_call?.length ?? 0) > 0) {
		hooks.beforeTool = async (ctx: AgentBeforeToolContext) => {
			const control = await runToolCallStart(toolCallStartContext(ctx));
			return beforeToolResultFromControl(control);
		};
	}
	if ((commandMap.tool_result?.length ?? 0) > 0) {
		hooks.afterTool = async (ctx: AgentAfterToolContext) => {
			await runToolCallEnd(toolCallEndContext(ctx));
			return undefined;
		};
	}
	if ((commandMap.agent_end?.length ?? 0) > 0) {
		hooks.afterRun = async ({ snapshot, result }) => {
			if (result.status !== "completed") {
				return;
			}
			await runTurnEnd({
				...baseContextFromSnapshot(snapshot),
				iteration: result.iterations,
				turn: {
					outputText: result.outputText,
					status: result.status,
				},
			});
		};
	}
	if (
		(commandMap.agent_error?.length ?? 0) > 0 ||
		(commandMap.agent_abort?.length ?? 0) > 0 ||
		(commandMap.session_shutdown?.length ?? 0) > 0
	) {
		const previousAfterRun = hooks.afterRun;
		hooks.afterRun = async (ctx) => {
			await previousAfterRun?.(ctx);
			const { snapshot, result } = ctx;
			if (result.status === "aborted" || isAbortReason(result.error?.message)) {
				await runSessionShutdown({
					...baseContextFromSnapshot(snapshot),
					reason: result.error?.message,
				});
				return;
			}
			if (result.error) {
				await runStopError({
					...baseContextFromSnapshot(snapshot),
					iteration: result.iterations,
					error: result.error,
				});
			}
		};
	}
	return hooks;
}

export function createHookConfigFileExtension(
	options: HookRuntimeOptions,
): AgentExtension | undefined {
	return createAgentHooksExtension(
		"core.hook_config_files",
		createHookConfigFileHooks(options),
	);
}

function mergeHookFunction<K extends keyof AgentHooks>(
	layers: AgentHooks[],
	key: K,
): AgentHooks[K] | undefined {
	const handlers = layers
		.map((layer) => layer[key])
		.filter((handler) => typeof handler === "function");
	if (handlers.length === 0) {
		return undefined;
	}
	return (async (ctx: unknown) => {
		let merged: Record<string, unknown> | undefined;
		for (const handler of handlers) {
			const next = await (handler as (arg: unknown) => unknown)(ctx);
			if (!next || typeof next !== "object") {
				continue;
			}
			const record = next as Record<string, unknown>;
			merged = {
				...(merged ?? {}),
				...record,
				stop:
					merged?.stop === true || record.stop === true ? true : record.stop,
				options:
					merged?.options || record.options
						? {
								...((merged?.options as Record<string, unknown> | undefined) ??
									{}),
								...((record.options as Record<string, unknown> | undefined) ??
									{}),
							}
						: undefined,
			};
		}
		return merged;
	}) as AgentHooks[K];
}

export function mergeAgentHooks(
	layers: Array<AgentHooks | undefined>,
): AgentHooks | undefined {
	const activeLayers = layers.filter(
		(layer): layer is AgentHooks => layer !== undefined,
	);
	if (activeLayers.length === 0) {
		return undefined;
	}

	return {
		beforeRun: mergeHookFunction(activeLayers, "beforeRun"),
		afterRun: mergeHookFunction(activeLayers, "afterRun"),
		beforeModel: mergeHookFunction(activeLayers, "beforeModel"),
		afterModel: mergeHookFunction(activeLayers, "afterModel"),
		beforeTool: mergeHookFunction(activeLayers, "beforeTool"),
		afterTool: mergeHookFunction(activeLayers, "afterTool"),
		onEvent: mergeHookFunction(activeLayers, "onEvent"),
	};
}
