import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createHookConfigFileHooks,
	UnsupportedHookInterpreterError,
} from "./hook-file-hooks";

/**
 * A hook that cannot run on this platform is refused by name, not attempted.
 *
 * On Windows a `#!/usr/bin/env bash` hook resolves to `bash <windows-path>`, which
 * cannot work: Git's bash cannot open a Windows path given as an argument, and WSL's
 * strips the separators and exits 127. That was measured at 12/12 runs - a fast,
 * silent failure in which the hook simply never ran, with nothing but a mangled path in
 * the log. Worse than failing, because a hook that silently does nothing is
 * indistinguishable from a hook that is not needed.
 *
 * So it is refused up front, with the reason and the PowerShell equivalent named. These
 * cases live here rather than in hook-file-hooks.test.ts because that file's shebang case
 * skips on Windows - it cannot, since the shebang never runs - which left the refusal
 * itself with no coverage on the only platform that needs it.
 */
const isWindows = process.platform === "win32";

function logger() {
	const lines: string[] = [];
	return {
		lines,
		// logHookError routes through logger.log with a severity, not logger.warn.
		sink: {
			log: (m: string) => lines.push(m),
			warn: (m: string) => lines.push(m),
			error: (m: string) => lines.push(m),
			info: () => {},
			debug: () => {},
		} as never,
	};
}

async function workspaceWith(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hook-interp-"));
	const hooks = join(dir, ".clinerules", "hooks");
	await mkdir(hooks, { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		await writeFile(join(hooks, name), body, "utf-8");
	}
	return dir;
}

async function withWorkspace(
	files: Record<string, string>,
	run: (dir: string) => Promise<void>,
) {
	const dir = await workspaceWith(files);
	try {
		await run(dir);
	} finally {
		await rm(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 300,
		}).catch(() => {});
	}
}

describe("unusable hook interpreter", () => {
	it.skipIf(!isWindows)(
		"refuses a Unix shebang on Windows and names PowerShell",
		async () => {
			await withWorkspace(
				{ PreToolUse: "#!/usr/bin/env bash\necho hi\n" },
				async (dir) => {
					const log = logger();
					const hooks = createHookConfigFileHooks({
						cwd: dir,
						workspacePath: dir,
						logger: log.sink,
					});
					// No hook was loaded, so there is nothing to run.
					expect(hooks).toBeUndefined();
					const text = log.lines.join("\n");
					expect(text).toContain("cannot run on Windows");
					expect(text).toContain("PowerShell");
					expect(text).toMatch(/\.ps1/);
					// And it says the others are unaffected, so the message does not read as
					// "all your hooks are broken".
					expect(text).toContain("unaffected");
				},
			);
		},
	);

	it.skipIf(!isWindows)(
		"still loads a PowerShell hook alongside a rejected one",
		async () => {
			// The point of skipping per file rather than failing the whole workspace: one
			// unusable hook must not disable the ones that do work.
			await withWorkspace(
				{
					PreToolUse: "#!/usr/bin/env bash\necho hi\n",
					"PostToolUse.ps1": 'Write-Output "{}"\n',
				},
				async (dir) => {
					const log = logger();
					const hooks = createHookConfigFileHooks({
						cwd: dir,
						workspacePath: dir,
						logger: log.sink,
					});
					expect(
						hooks?.afterTool,
						"the PowerShell hook should still load",
					).toBeTypeOf("function");
					expect(log.lines.join("\n")).toContain("cannot run on Windows");
				},
			);
		},
	);

	it.skipIf(isWindows)("accepts a Unix shebang off Windows", async () => {
		await withWorkspace(
			{ PreToolUse: "#!/usr/bin/env bash\necho hi\n" },
			async (dir) => {
				const log = logger();
				const hooks = createHookConfigFileHooks({
					cwd: dir,
					workspacePath: dir,
					logger: log.sink,
				});
				expect(hooks?.beforeTool, "a Unix shebang is fine on Unix").toBeTypeOf(
					"function",
				);
				expect(log.lines.join("\n")).not.toContain("cannot run on Windows");
			},
		);
	});
});

describe("UnsupportedHookInterpreterError", () => {
	it("carries the path, the interpreter and the reason", () => {
		const e = new UnsupportedHookInterpreterError(
			"/ws/PreToolUse",
			"/usr/bin/env bash",
			"because",
		);
		expect(e.scriptPath).toBe("/ws/PreToolUse");
		expect(e.interpreter).toBe("/usr/bin/env bash");
		expect(e.reason).toBe("because");
		// Suggests the .ps1 name by dropping whatever extension the hook had.
		expect(e.message).toContain("/ws/PreToolUse.ps1");
	});
});
