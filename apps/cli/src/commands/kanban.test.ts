import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildKanbanSpawnOptions,
	forwardSignalToKanbanProcess,
	isCommandAvailable,
	launchKanban,
	resolveKanbanInstallCommand,
	shouldDetachKanbanProcess,
} from "./kanban";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cline-kanban-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeExecutable(dir: string, name: string): void {
	writeExecutableScript(dir, name, "#!/bin/sh\necho ok\n");
}

/**
 * Writes a fake executable into `dir` so it can be found on PATH.
 *
 * On POSIX that is a single `#!/bin/sh` script. Windows needs more care:
 * `CreateProcess` cannot run an extensionless file, so launching resolves
 * through `PATHEXT` to a `.cmd`. Both names are therefore written on Windows —
 * the `.cmd` for a real launch, and the extensionless copy because several
 * tests pass an explicit `"linux"` platform to the resolver under test, which
 * looks for the bare name only.
 */
function writeExecutableScript(
	dir: string,
	name: string,
	content: string,
	posixContent: string = content,
): void {
	writeFileSync(join(dir, name), content, "utf8");
	chmodSync(join(dir, name), 0o755);

	if (process.platform === "win32") {
		writeFileSync(join(dir, `${name}.cmd`), toBatchScript(posixContent), "utf8");
	}
}

/**
 * Translates the tiny `sh` subset these fixtures use into batch syntax:
 * `exit N` becomes `exit /b N` and `echo X` becomes `echo X`.
 */
function toBatchScript(shSource: string): string {
	return shSource
		.split(/\r?\n/)
		.map((line) => {
			const trimmed = line.trim();
			const exit = /^exit\s+(\S+)$/.exec(trimmed);
			if (exit) {
				return `exit /b ${exit[1]}`;
			}
			return trimmed;
		})
		.filter((line) => line.length > 0)
		.join("\r\n");
}

describe("kanban command helpers", () => {
	afterEach(() => {
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detects commands in PATH", () => {
		const dir = createTempDir();
		writeExecutable(dir, "kanban");

		expect(isCommandAvailable("kanban", { PATH: dir }, "linux")).toBe(true);
		expect(isCommandAvailable("missing", { PATH: dir }, "linux")).toBe(false);
	});

	it("detaches kanban into a process group on unix-like platforms", () => {
		expect(shouldDetachKanbanProcess("darwin")).toBe(true);
		expect(shouldDetachKanbanProcess("linux")).toBe(true);
		expect(buildKanbanSpawnOptions({}, "darwin")).toMatchObject({
			stdio: "inherit",
			detached: true,
		});
	});

	it("keeps kanban attached on windows", () => {
		expect(shouldDetachKanbanProcess("win32")).toBe(false);
		expect(buildKanbanSpawnOptions({}, "win32")).toMatchObject({
			stdio: "inherit",
			detached: false,
			shell: true,
		});
	});

	it("prefers npm for kanban installs", () => {
		const dir = createTempDir();
		writeExecutable(dir, "npm");
		writeExecutable(dir, "pnpm");
		writeExecutable(dir, "bun");

		expect(resolveKanbanInstallCommand({ PATH: dir }, "linux")).toEqual({
			packageManager: "npm",
			command: "npm",
			args: ["install", "-g", "kanban@latest"],
			displayCommand: "npm install -g kanban@latest",
		});
	});

	it("uses the preferred package manager when available", () => {
		const dir = createTempDir();
		writeExecutable(dir, "npm");
		writeExecutable(dir, "pnpm");
		writeExecutable(dir, "bun");

		expect(resolveKanbanInstallCommand({ PATH: dir }, "linux", "pnpm")).toEqual(
			{
				packageManager: "pnpm",
				command: "pnpm",
				args: ["add", "-g", "kanban@latest"],
				displayCommand: "pnpm add -g kanban@latest",
			},
		);
		expect(resolveKanbanInstallCommand({ PATH: dir }, "linux", "bun")).toEqual({
			packageManager: "bun",
			command: "bun",
			args: ["add", "-g", "kanban@latest"],
			displayCommand: "bun add -g kanban@latest",
		});
	});

	it("falls back when the preferred package manager is unavailable", () => {
		const dir = createTempDir();
		writeExecutable(dir, "npm");

		expect(resolveKanbanInstallCommand({ PATH: dir }, "linux", "pnpm")).toEqual(
			{
				packageManager: "npm",
				command: "npm",
				args: ["install", "-g", "kanban@latest"],
				displayCommand: "npm install -g kanban@latest",
			},
		);
	});

	it("falls back to pnpm and bun for kanban installs", () => {
		const pnpmDir = createTempDir();
		writeExecutable(pnpmDir, "pnpm");
		expect(
			resolveKanbanInstallCommand({ PATH: pnpmDir }, "linux")?.displayCommand,
		).toBe("pnpm add -g kanban@latest");

		const bunDir = createTempDir();
		writeExecutable(bunDir, "bun");
		expect(
			resolveKanbanInstallCommand({ PATH: bunDir }, "linux")?.displayCommand,
		).toBe("bun add -g kanban@latest");
	});

	it("fails when kanban is missing and no installer is available", async () => {
		process.env.PATH = "";

		await expect(launchKanban()).resolves.toBe(1);
	});

	it("returns the kanban process exit code", async () => {
		const dir = createTempDir();
		writeExecutableScript(dir, "kanban", "#!/bin/sh\nexit 7\n");
		process.env.PATH = dir;

		await expect(launchKanban()).resolves.toBe(7);
	});

	it("installs kanban before launch when missing", async () => {
		const dir = createTempDir();
		const isWindows = process.platform === "win32";
		// CreateProcess cannot run an extensionless file, so on Windows the install
		// target has to be a `.cmd`; POSIX needs a shebang script.
		const target = join(dir, isWindows ? "kanban.cmd" : "kanban");
		const stubContents = isWindows ? "exit /b 6" : "#!/bin/sh\nexit 6\n";
		const stubPath = join(dir, "kanban.cmd.stub");
		writeFileSync(stubPath, stubContents, "utf8");

		const installCommand = isWindows
			? // `copy` is the cmd builtin; `cp` does not exist there, so a POSIX
				// command here would silently install nothing.
				`copy /Y "${stubPath}" "${target}" >NUL`
			: // This script runs with PATH pointing only at the temp directory, so it
				// cannot use `cat` or `chmod`: both are PATH lookups that fail, and they
				// fail silently — the installer exits 0 having installed nothing, and the
				// test then fails on the launcher's "not found in PATH" branch instead of
				// on the thing it means to check. Windows never saw this because `copy` is
				// a cmd builtin. Node is already running this test, so materialise the
				// file through it and depend on nothing from PATH.
				`"${process.execPath}" -e ${JSON.stringify(
					`require("fs").writeFileSync(process.argv[1], ${JSON.stringify(stubContents)}, { mode: 0o755 })`,
				)} "${target}"`;

		writeExecutableScript(
			dir,
			"npm",
			`#!/bin/sh\n${installCommand}\nexit 0\n`,
		);
		process.env.PATH = dir;

		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		try {
			await expect(launchKanban()).resolves.toBe(6);
		} finally {
			stdoutWrite.mockRestore();
		}
	});

	it("signals the detached kanban process group on unix-like platforms", () => {
		const killProcess = vi.fn();
		const child = {
			pid: 4321,
			kill: vi.fn(),
		};

		forwardSignalToKanbanProcess({
			child,
			signal: "SIGINT",
			platform: "darwin",
			killProcess,
		});

		expect(killProcess).toHaveBeenCalledWith(-4321, "SIGINT");
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("signals the child process directly on windows", () => {
		const killProcess = vi.fn();
		const child = {
			pid: 4321,
			kill: vi.fn(),
		};

		forwardSignalToKanbanProcess({
			child,
			signal: "SIGTERM",
			platform: "win32",
			killProcess,
		});

		expect(killProcess).not.toHaveBeenCalled();
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});
});
