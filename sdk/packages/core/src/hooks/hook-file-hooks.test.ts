import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	resolveClineDir,
	resolveDocumentsClineDirectoryPath,
	setClineDir,
	setHomeDir,
} from "@cline/shared/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	HOOK_CONFIG_FILE_EVENT_MAP,
	HookConfigFileName,
} from "./hook-file-config";
import {
	createHookAuditHooks,
	createHookConfigFileExtension,
	createHookConfigFileHooks,
	createPreCompactHookEmitter,
	getWindowsPythonFallbackCommand,
	mergeAgentHooks,
} from "./hook-file-hooks";

async function waitForFile(
	filePath: string,
	timeoutMs = 1500,
): Promise<string> {
	const started = Date.now();
	for (;;) {
		try {
			return await readFile(filePath, "utf8");
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ENOENT" || Date.now() - started >= timeoutMs) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

async function waitForJsonLines(
	filePath: string,
	expectedLines: number,
	timeoutMs = 1500,
): Promise<string[]> {
	const started = Date.now();
	for (;;) {
		const content = await waitForFile(
			filePath,
			Math.max(1, timeoutMs - (Date.now() - started)),
		);
		const lines = content.trim().split("\n").filter(Boolean);
		if (lines.length >= expectedLines) {
			return lines;
		}
		if (Date.now() - started >= timeoutMs) {
			return lines;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function createWorkspaceWithHook(
	fileName: string,
	body: string,
): Promise<{ workspace: string; hookPath: string }> {
	const workspace = await mkdtemp(join(tmpdir(), "hooks-workspace-"));
	const hooksDir = join(workspace, ".clinerules", "hooks");
	await mkdir(hooksDir, { recursive: true });
	const hookPath = join(hooksDir, fileName);
	await writeFile(hookPath, body, "utf8");
	return { workspace, hookPath };
}

function beforeToolContext(input: unknown = { path: "README.md" }) {
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
			input,
		},
		input,
	};
}

function afterToolContext(input: unknown = { path: "README.md" }) {
	const startedAt = new Date("2026-01-01T00:00:00.000Z");
	const endedAt = new Date("2026-01-01T00:00:00.037Z");
	const before = beforeToolContext(input);
	return {
		...before,
		result: { output: "ok" },
		startedAt,
		endedAt,
		durationMs: 37,
	};
}

describe("createHookConfigFileHooks", () => {
	const originalHomeDir = dirname(
		dirname(resolveDocumentsClineDirectoryPath()),
	);
	const originalClineDir = resolveClineDir();
	let isolatedRoot = "";

	beforeAll(async () => {
		isolatedRoot = await mkdtemp(join(tmpdir(), "hooks-home-"));
		const isolatedHomeDir = join(isolatedRoot, "home");
		const isolatedClineDir = join(isolatedRoot, "cline");
		await mkdir(isolatedHomeDir, { recursive: true });
		await mkdir(isolatedClineDir, { recursive: true });
		setHomeDir(isolatedHomeDir);
		setClineDir(isolatedClineDir);
	});

	afterAll(async () => {
		setHomeDir(originalHomeDir);
		setClineDir(originalClineDir);
		if (isolatedRoot) {
			await rm(isolatedRoot, { recursive: true, force: true });
		}
	});

	it("ignores example hook files", async () => {
		const { workspace } = await createWorkspaceWithHook(
			"PreToolUse.example",
			'echo \'HOOK_CONTROL\t{"cancel":true,"context":"should-not-run"}\'\n',
		);
		try {
			const hooks = createHookConfigFileHooks({
				cwd: workspace,
				workspacePath: workspace,
			});
			expect(hooks).toBeUndefined();
		} finally {
			await rm(workspace, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 250,
			});
		}
	});

	/**
	 * `pre_compact` had a full payload schema, a `HookConfigFileName` entry and an
	 * event type — and nothing ever emitted it, while the file-hook table mapped the
	 * name to `undefined`. So a hook a user could write and read about in the docs
	 * simply never fired, and the VS Code extension even ships a template for it.
	 */
	describe("createPreCompactHookEmitter", () => {
		const preCompactData = {
			taskId: "sess_1",
			ulid: "sess_1",
			contextSize: 42,
			compactionStrategy: "basic",
			mode: "auto",
			iteration: 3,
			requestInputTokens: 120_000,
			maxInputTokens: 128_000,
			triggerTokens: 115_200,
			targetTokens: 89_600,
		};

		it("returns undefined when the workspace has no PreCompact hook", async () => {
			const workspace = await mkdtemp(join(tmpdir(), "hooks-workspace-"));
			try {
				expect(
					createPreCompactHookEmitter({ cwd: workspace, workspacePath: workspace }),
				).toBeUndefined();
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		});

		it("maps the PreCompact hook file to the pre_compact event", () => {
			// The regression in one line: this used to be `undefined`.
			expect(HOOK_CONFIG_FILE_EVENT_MAP[HookConfigFileName.PreCompact]).toBe(
				"pre_compact",
			);
		});

		it("emits the compaction payload to the hook process", async () => {
			// The previous version of this test read the hook file back instead of
			// the payload, so it passed whether or not the hook ever ran.
			//
			// Two things make a real assertion possible here:
			//  1. a `.js` hook is inferred as `node <file>`, so it runs identically
			//     on Windows without needing a shell (the reason the old `cat`-based
			//     version had to be skipped on win32);
			//  2. `runAsyncHookCommands` is fire-and-forget, so `emit()` resolves
			//     before the child has run — hence polling rather than a direct read.
			//
			// The payload arrives on stdin, not as a `CLINE_HOOK_PAYLOAD_FILE` env
			// var (the old test read that non-existent variable, so it never saw a
			// payload even when the hook did run).
			const outputPath = join(tmpdir(), `pre-compact-${Date.now()}.json`);
			const workspace = await mkdtemp(join(tmpdir(), "hooks-workspace-"));
			const hooksDir = join(workspace, ".clinerules", "hooks");
			await mkdir(hooksDir, { recursive: true });
			await writeFile(
				join(hooksDir, "precompact.js"),
				[
					'const { writeFileSync } = require("node:fs");',
					'let raw = "";',
					'process.stdin.setEncoding("utf8");',
					'process.stdin.on("data", (chunk) => { raw += chunk; });',
					'process.stdin.on("end", () => writeFileSync(process.env.PRE_COMPACT_OUT, raw));',
				].join("\n"),
				"utf8",
			);
			process.env.PRE_COMPACT_OUT = outputPath;
			try {
				const emit = createPreCompactHookEmitter({
					cwd: workspace,
					workspacePath: workspace,
				});
				expect(emit).toBeTypeOf("function");
				await emit?.(preCompactData);

				const payload = JSON.parse(await waitForFile(outputPath, 5000));
				expect(payload.hookName).toBe("pre_compact");
				expect(payload.preCompact).toMatchObject(preCompactData);
			} finally {
				delete process.env.PRE_COMPACT_OUT;
				await rm(workspace, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 250,
				});
				await rm(outputPath, { force: true });
			}
		});

		it("never rejects, so a broken hook cannot block compaction", async () => {
			// Needs a hook that actually fails. With no hook file the emitter is
			// `undefined` and the old `if (emit)` guard meant this test could never
			// fail — so the "hook failure must not block compaction" guarantee was
			// never actually exercised.
			const workspace = await mkdtemp(join(tmpdir(), "hooks-workspace-"));
			const hooksDir = join(workspace, ".clinerules", "hooks");
			await mkdir(hooksDir, { recursive: true });
			await writeFile(
				join(hooksDir, "precompact.js"),
				'throw new Error("hook exploded");\n',
				"utf8",
			);
			try {
				const emit = createPreCompactHookEmitter({
					cwd: workspace,
					workspacePath: workspace,
				});
				expect(emit).toBeTypeOf("function");
				await expect(emit?.(preCompactData)).resolves.toBeUndefined();
			} finally {
				// The hook is spawned detached, so it may still hold the workspace
				// briefly after emit resolves — retry the removal rather than fail.
				await rm(workspace, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 250,
				});
			}
		});
	});

	it.skipIf(process.platform === "win32")(
		"executes extensionless legacy hook files via bash fallback",
		async () => {
		const { workspace } = await createWorkspaceWithHook(
			"PreToolUse",
			'echo \'HOOK_CONTROL\t{"cancel":true,"context":"legacy-ok"}\'\nexit 0\n',
		);
		try {
			const hooks = createHookConfigFileHooks({
				cwd: workspace,
				workspacePath: workspace,
			});
			expect(hooks?.beforeTool).toBeTypeOf("function");
			const control = await hooks?.beforeTool?.(beforeToolContext());
			expect(control).toMatchObject({ stop: true });
		} finally {
			await rm(workspace, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 250,
			});
		}
	});

	// Same extensionless-bash dependency as the legacy fallback test above.
	it.skipIf(process.platform === "win32")(
		"adapts file hooks into an AgentExtension",
		async () => {
		const { workspace } = await createWorkspaceWithHook(
			"PreToolUse",
			'echo \'HOOK_CONTROL\t{"cancel":true,"context":"extension-ok"}\'\nexit 0\n',
		);
		try {
			const extension = createHookConfigFileExtension({
				cwd: workspace,
				workspacePath: workspace,
			});
			expect(extension?.name).toBe("core.hook_config_files");
			expect(extension?.manifest).toMatchObject({
				capabilities: ["hooks"],
			});
			const control = await extension?.hooks?.beforeTool?.({
				snapshot: {
					agentId: "agent_1",
					conversationId: "conv_1",
					status: "running",
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
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "read_file",
					input: { path: "README.md" },
				},
				input: { path: "README.md" },
			});
			expect(control).toMatchObject({ stop: true });
		} finally {
			await rm(workspace, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 250,
			});
		}
	});

	// Skipped on Windows, and deliberately so. This launcher resolves the shebang to
	// `bash <windows-path>`, and on a Windows runner `bash` is either Git's, which
	// cannot run a shebang script given a Windows path, or WSL's, which mangles the
	// separators and exits 127. The test passed there for entirely the wrong reason -
	// see below - and pretending otherwise would only relocate the false pass.
	//
	// Shebang parsing itself is still covered everywhere, by the argv case below, which
	// needs no process to run.
	it.skipIf(process.platform === "win32")("honors shebang interpreter when present", async () => {
		const { workspace, hookPath } = await createWorkspaceWithHook(
			"PreToolUse",
			'#!/usr/bin/env bash\necho \'HOOK_CONTROL\t{"cancel":false,"context":"shebang-ok"}\'\n',
		)
		// Proves the interpreter actually ran the script, instead of inferring it from
		// the absence of a control block. `beforeTool` returns undefined both when the
		// hook succeeded with cancel:false and when the hook never ran at all, so the
		// original assertion could not tell those apart - and a test that cannot tell
		// them apart still passes when the feature it names is completely broken.
		const marker = join(workspace, "shebang-ran.marker")
		process.env.CLINE_HOOK_TEST_MARKER = marker
		try {
			// Written before the control block, so its presence proves the shebang chose
			// an interpreter that could open the file.
			await writeFile(
				hookPath,
				`#!/usr/bin/env bash\ntouch "$CLINE_HOOK_TEST_MARKER"\necho 'HOOK_CONTROL\t{"cancel":false,"context":"shebang-ok"}'\n`,
				"utf-8",
			)
			const hooks = createHookConfigFileHooks({
				cwd: workspace,
				workspacePath: workspace,
			})
			expect(hooks?.beforeTool).toBeTypeOf("function")
			const control = await hooks?.beforeTool?.(beforeToolContext())
			expect(control).toBeUndefined()
			// The actual subject of the test.
			expect(existsSync(marker), "shebang interpreter did not run the hook script").toBe(true)
		} finally {
			delete process.env.CLINE_HOOK_TEST_MARKER
			await rm(workspace, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 250,
			})
		}
	})

	it("parses review control from hook output", async () => {
		const { workspace } = await createWorkspaceWithHook(
			"PreToolUse.js",
			'console.log(\'HOOK_CONTROL\\t{"review":true,"context":"needs-review"}\')\n',
		);
		try {
			const hooks = createHookConfigFileHooks({
				cwd: workspace,
				workspacePath: workspace,
			});
			expect(hooks?.beforeTool).toBeTypeOf("function");
			const ctx = beforeToolContext({ commands: ["git status"] });
			ctx.tool.name = "run_commands";
			ctx.toolCall.toolName = "run_commands";
			const control = await hooks?.beforeTool?.(ctx);
			expect(control).toBeUndefined();
		} finally {
			await rm(workspace, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 250,
			});
		}
	});

	it("executes python hook files", async () => {
		const { workspace } = await createWorkspaceWithHook(
			"PreToolUse.py",
			'print(\'HOOK_CONTROL\\t{"cancel": false, "context": "python-ok"}\')\n',
		);
		try {
			const hooks = createHookConfigFileHooks({
				cwd: workspace,
				workspacePath: workspace,
			});
			expect(hooks?.beforeTool).toBeTypeOf("function");
			const control = await hooks?.beforeTool?.(beforeToolContext());
			expect(control).toBeUndefined();
		} finally {
			await rm(workspace, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 250,
			});
		}
	}, 15000);

	it("falls back from py -3 to python when the Windows launcher is missing", () => {
		expect(
			getWindowsPythonFallbackCommand(["py", "-3", "hook.py"], "win32", {
				code: "ENOENT",
			}),
		).toEqual(["python", "hook.py"]);
		expect(
			getWindowsPythonFallbackCommand(["py", "-3", "-u", "hook.py"], "win32", {
				code: "ENOENT",
			}),
		).toEqual(["python", "-u", "hook.py"]);
	});

	it("does not rewrite python launch commands when fallback conditions are not met", () => {
		expect(
			getWindowsPythonFallbackCommand(["py", "-3", "hook.py"], "linux", {
				code: "ENOENT",
			}),
		).toBeUndefined();
		expect(
			getWindowsPythonFallbackCommand(["python", "hook.py"], "win32", {
				code: "ENOENT",
			}),
		).toBeUndefined();
		expect(
			getWindowsPythonFallbackCommand(["py", "-3", "hook.py"], "win32", {
				code: "EACCES",
			}),
		).toBeUndefined();
	});

	it.runIf(process.platform === "win32")(
		"executes PowerShell hook files on Windows",
		async () => {
			const { workspace } = await createWorkspaceWithHook(
				"PreToolUse.ps1",
				'Write-Output \'HOOK_CONTROL\t{"cancel": false, "context": "powershell-ok"}\'\n',
			);
			try {
				const hooks = createHookConfigFileHooks({
					cwd: workspace,
					workspacePath: workspace,
				});
				expect(hooks?.beforeTool).toBeTypeOf("function");
				const control = await hooks?.beforeTool?.(beforeToolContext());
				expect(control).toBeUndefined();
			} finally {
				await rm(workspace, {
					recursive: true,
					force: true,
					maxRetries: 3,
					retryDelay: 250,
				});
			}
		},
	);

	it("maps TaskError hook files to agent_error stop events", async () => {
		const outputPath = join(tmpdir(), `hooks-task-error-${Date.now()}.json`);
		const { workspace } = await createWorkspaceWithHook(
			"TaskError.js",
			`let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, data);});\n`,
		);
		try {
			const hooks = createHookConfigFileHooks({
				cwd: workspace,
				workspacePath: workspace,
			});
			await hooks?.afterRun?.({
				snapshot: beforeToolContext().snapshot,
				result: {
					agentId: "agent_1",
					runId: "conv_1",
					status: "failed",
					iterations: 3,
					outputText: "",
					messages: [],
					usage: beforeToolContext().snapshot.usage,
					error: new Error("401 unauthorized"),
				},
			});
			const payload = JSON.parse(await waitForFile(outputPath)) as {
				hookName: string;
				error?: { message?: string };
				taskId?: string;
			};
			expect(payload.hookName).toBe("agent_error");
			expect(payload.error?.message).toBe("401 unauthorized");
			expect(payload.taskId).toBe("conv_1");
		} finally {
			await rm(workspace, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 250,
			});
		}
	});

	it("writes audit tool timing and completed turn payloads", async () => {
		const outputPath = join(tmpdir(), `hooks-audit-${Date.now()}.jsonl`);
		const originalLogPath = process.env.CLINE_HOOKS_LOG_PATH;
		process.env.CLINE_HOOKS_LOG_PATH = outputPath;
		try {
			const hooks = createHookAuditHooks({
				workspacePath: "/workspace",
			});
			await hooks.afterTool?.(afterToolContext());
			await hooks.afterRun?.({
				snapshot: beforeToolContext().snapshot,
				result: {
					agentId: "agent_1",
					runId: "run_1",
					status: "completed",
					iterations: 1,
					outputText: "done",
					messages: [],
					usage: beforeToolContext().snapshot.usage,
				},
			});

			const payloads = (await readFile(outputPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const toolResult = payloads.find(
				(payload) => payload.hookName === "tool_result",
			);
			const agentEnd = payloads.find(
				(payload) => payload.hookName === "agent_end",
			);
			expect(toolResult.tool_result).toMatchObject({
				durationMs: 37,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: "2026-01-01T00:00:00.037Z",
			});
			expect(toolResult.postToolUse.executionTimeMs).toBe(37);
			expect(agentEnd.turn).toEqual({
				outputText: "done",
				status: "completed",
			});
		} finally {
			if (originalLogPath === undefined) {
				delete process.env.CLINE_HOOKS_LOG_PATH;
			} else {
				process.env.CLINE_HOOKS_LOG_PATH = originalLogPath;
			}
			await rm(outputPath, { force: true });
		}
	});

	it("merges before-model controls across hook layers", async () => {
		const hooks = mergeAgentHooks([
			{
				beforeModel: async () => ({
					options: { systemPrompt: "system-a" },
				}),
			},
			{
				beforeModel: async () => ({
					options: { extra: "ctx-a" },
				}),
			},
		]);

		const control = await hooks?.beforeModel?.({
			snapshot: beforeToolContext().snapshot,
			request: {
				messages: [],
				tools: [],
			},
		});

		expect(control).toMatchObject({
			options: { systemPrompt: "system-a", extra: "ctx-a" },
		});
	});

	it("dispatches agent_start and prompt_submit exactly once when both are configured", async () => {
		const outputPath = join(tmpdir(), `hooks-start-prompt-${Date.now()}.jsonl`);
		const { workspace } = await createWorkspaceWithHook(
			"TaskStart.js",
			`let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{require('node:fs').appendFileSync(${JSON.stringify(outputPath)}, data.trim()+"\\n");});\n`,
		);
		try {
			await writeFile(
				join(workspace, ".clinerules", "hooks", "UserPromptSubmit.js"),
				`let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{require('node:fs').appendFileSync(${JSON.stringify(outputPath)}, data.trim()+"\\n");});\n`,
				"utf8",
			);
			const hooks = createHookConfigFileHooks({
				cwd: workspace,
				workspacePath: workspace,
			});
			const snapshot = beforeToolContext().snapshot;
			await hooks?.beforeRun?.({ snapshot: { ...snapshot, iteration: 0 } });
			await hooks?.onEvent?.({
				type: "message-added",
				snapshot,
				message: {
					id: "msg_1",
					role: "user",
					content: [{ type: "text", text: "real prompt" }],
					createdAt: 0,
				},
			});

			const payloads = (await waitForJsonLines(outputPath, 2)).map(
				(line) =>
					JSON.parse(line) as {
						hookName: string;
						userPromptSubmit?: { prompt?: string };
					},
			);
			expect(payloads.map((payload) => payload.hookName).sort()).toEqual([
				"agent_start",
				"prompt_submit",
			]);
			expect(
				payloads.find((payload) => payload.hookName === "prompt_submit")
					?.userPromptSubmit?.prompt,
			).toBe("real prompt");
		} finally {
			await rm(workspace, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 250,
			});
			await rm(outputPath, { force: true });
		}
	});

	it("returns hooks and dispatches abort shutdown when only SessionShutdown is configured", async () => {
		const outputPath = join(
			tmpdir(),
			`hooks-session-shutdown-${Date.now()}.json`,
		);
		const { workspace } = await createWorkspaceWithHook(
			"SessionShutdown.js",
			`let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, data);});\n`,
		);
		try {
			const hooks = createHookConfigFileHooks({
				cwd: workspace,
				workspacePath: workspace,
			});
			expect(hooks?.afterRun).toBeTypeOf("function");
			await hooks?.afterRun?.({
				snapshot: beforeToolContext().snapshot,
				result: {
					agentId: "agent_1",
					runId: "run_1",
					status: "aborted",
					iterations: 1,
					outputText: "",
					messages: [],
					usage: beforeToolContext().snapshot.usage,
					error: new Error("user cancel"),
				},
			});

			const payload = JSON.parse(await waitForFile(outputPath)) as {
				hookName: string;
				reason?: string;
			};
			expect(payload.hookName).toBe("session_shutdown");
			expect(payload.reason).toBe("user cancel");
		} finally {
			await rm(workspace, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 250,
			});
			await rm(outputPath, { force: true });
		}
	});
});
