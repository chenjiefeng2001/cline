import { execFileSync } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setClineDir } from "@cline/shared/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createTaskWorktree,
	getTaskWorktreesHomePath,
	pruneTaskWorktrees,
} from "./worktree";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath);
		return true;
	} catch {
		return false;
	}
}

describe("createTaskWorktree", () => {
	let sandboxRoot: string;
	let clineDir: string;
	let repoPath: string;
	let nonRepoPath: string;
	let originalClineDir: string | undefined;

	beforeEach(async () => {
		sandboxRoot = await mkdtemp(path.join(tmpdir(), "cline-sdk-worktree-"));
		clineDir = path.join(sandboxRoot, ".cline");
		repoPath = path.join(sandboxRoot, "myrepo");
		nonRepoPath = path.join(sandboxRoot, "not-a-repo");
		originalClineDir = process.env.CLINE_DIR;
		process.env.CLINE_DIR = clineDir;
		setClineDir(clineDir);

		await writeFile(path.join(sandboxRoot, ".keep"), "");
		await rm(repoPath, { recursive: true, force: true });
		await rm(nonRepoPath, { recursive: true, force: true });
		await mkdir(repoPath, { recursive: true });
		await mkdir(nonRepoPath, { recursive: true });

		git(repoPath, ["init", "-q", "-b", "main"]);
		await writeFile(path.join(repoPath, "file.txt"), "hello");
		git(repoPath, ["add", "."]);
		git(repoPath, [
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=Test",
			"commit",
			"-q",
			"-m",
			"init",
		]);
	});

	afterEach(async () => {
		if (originalClineDir === undefined) {
			delete process.env.CLINE_DIR;
		} else {
			process.env.CLINE_DIR = originalClineDir;
		}
		setClineDir(originalClineDir ?? path.join("~", ".cline"));
		await rm(sandboxRoot, { recursive: true, force: true });
	});

	it("places worktrees under ~/.cline/worktrees", () => {
		expect(getTaskWorktreesHomePath()).toBe(path.join(clineDir, "worktrees"));
	});

	it("creates a detached worktree at ~/.cline/worktrees/<taskId>/<repoName>", async () => {
		const result = await createTaskWorktree({
			cwd: repoPath,
			taskId: "my-task",
		});

		expect(result.success).toBe(true);
		expect(result.taskId).toBe("my-task");
		expect(result.repoRoot).toBeDefined();
		expect(result.path).toBeDefined();
		if (!result.repoRoot || !result.path) {
			throw new Error("Expected worktree result to include repoRoot and path.");
		}
		const worktreePath = result.path;

		expect(await realpath(result.repoRoot)).toBe(await realpath(repoPath));
		expect(result.path).toBe(
			path.join(clineDir, "worktrees", "my-task", "myrepo"),
		);
		expect(git(worktreePath, ["rev-parse", "--is-inside-work-tree"])).toBe(
			"true",
		);
		expect(git(worktreePath, ["rev-parse", "HEAD"])).toBe(
			git(repoPath, ["rev-parse", "HEAD"]),
		);
		expect(git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
			"HEAD",
		);
	});

	it("generates a Kanban-style short taskId when none is provided", async () => {
		const result = await createTaskWorktree({ cwd: repoPath });

		expect(result.success).toBe(true);
		expect(result.taskId).toMatch(/^[0-9a-f]{5}$/i);
		expect(result.taskId).toBeDefined();
		if (!result.taskId) {
			throw new Error("Expected generated taskId.");
		}
		expect(result.path).toBe(
			path.join(clineDir, "worktrees", result.taskId, "myrepo"),
		);
	});

	it("rejects when cwd is not a git repository", async () => {
		const result = await createTaskWorktree({ cwd: nonRepoPath });

		expect(result.success).toBe(false);
		expect(result.message).toMatch(/Not a git repository/);
	});

	it("cleans up the task directory when git worktree add fails", async () => {
		const emptyRepoPath = path.join(sandboxRoot, "empty-repo");
		await mkdir(emptyRepoPath, { recursive: true });
		git(emptyRepoPath, ["init", "-q", "-b", "main"]);

		const result = await createTaskWorktree({
			cwd: emptyRepoPath,
			taskId: "empty",
		});

		expect(result.success).toBe(false);
		expect(result.message).toMatch(/Failed to create worktree/);
		expect(await pathExists(path.join(clineDir, "worktrees", "empty"))).toBe(
			false,
		);
	});

	it("rejects unsafe taskIds", async () => {
		const traversal = await createTaskWorktree({
			cwd: repoPath,
			taskId: "../escape",
		});
		const nullByte = await createTaskWorktree({
			cwd: repoPath,
			taskId: "safe\0../escape",
		});

		expect(traversal.success).toBe(false);
		expect(traversal.message).toMatch(/Invalid worktree id/);
		expect(nullByte.success).toBe(false);
		expect(nullByte.message).toMatch(/Invalid worktree id/);
	});
});

/**
 * Nothing ever removed a task worktree, so every `--worktree` run left a full
 * detached checkout behind indefinitely. These pin the retention rule and the
 * git-metadata cleanup, since a deleted directory that git still tracks produces
 * a misleading `git worktree list`.
 */
describe("pruneTaskWorktrees", () => {
	let sandboxRoot: string;
	let clineDir: string;
	let repoPath: string;
	let originalClineDir: string | undefined;

	beforeEach(async () => {
		sandboxRoot = await mkdtemp(path.join(tmpdir(), "cline-prune-worktree-"));
		clineDir = path.join(sandboxRoot, ".cline");
		repoPath = path.join(sandboxRoot, "myrepo");
		originalClineDir = process.env.CLINE_DIR;
		process.env.CLINE_DIR = clineDir;
		setClineDir(clineDir);

		await mkdir(repoPath, { recursive: true });
		git(repoPath, ["init", "-q", "-b", "main"]);
		await writeFile(path.join(repoPath, "file.txt"), "hello");
		git(repoPath, ["add", "."]);
		git(repoPath, [
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=Test",
			"commit",
			"-q",
			"-m",
			"init",
		]);
	});

	afterEach(async () => {
		if (originalClineDir === undefined) {
			delete process.env.CLINE_DIR;
		} else {
			process.env.CLINE_DIR = originalClineDir;
		}
		await rm(sandboxRoot, { recursive: true, force: true });
	});

	async function makeWorktree(taskId = "abcde"): Promise<string> {
		const result = await createTaskWorktree({ cwd: repoPath, taskId });
		if (!result.success || !result.path) {
			throw new Error(`worktree setup failed: ${result.message}`);
		}
		return result.path;
	}

	/** Backdates a worktree so it looks older than the retention window. */
	async function backdate(target: string, days: number): Promise<void> {
		const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		await utimes(target, when, when);
		const entries = await readdir(target, { withFileTypes: true });
		for (const entry of entries.slice(0, 20)) {
			if (entry.isDirectory()) {
				await backdate(path.join(target, entry.name), days);
			}
		}
	}

	it("is a no-op when no worktree has ever been created", async () => {
		const result = await pruneTaskWorktrees();
		expect(result.removed).toEqual([]);
		expect(result.failed).toBe(0);
	});

	it("removes a worktree older than the retention window", async () => {
		const worktreePath = await makeWorktree();
		await backdate(worktreePath, 30);

		const result = await pruneTaskWorktrees({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
		expect(result.removed).toContain(worktreePath);
		expect(await pathExists(worktreePath)).toBe(false);
	});

	it("keeps a recent worktree", async () => {
		// The whole point of the age check: destroying uncommitted work from a
		// concurrent session would be far worse than a stale directory.
		const worktreePath = await makeWorktree();
		const result = await pruneTaskWorktrees({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
		expect(result.removed).toEqual([]);
		expect(result.skipped).toContain(worktreePath);
		expect(await pathExists(worktreePath)).toBe(true);
	});

	it("keeps a worktree that has been written to recently", async () => {
		// A long-running task keeps writing inside its worktree; the root entry can
		// still look old, so only the newest mtime in the tree should count.
		const worktreePath = await makeWorktree();
		await backdate(worktreePath, 30);
		await writeFile(path.join(worktreePath, "fresh.txt"), "recent work");

		const result = await pruneTaskWorktrees({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
		expect(result.removed).toEqual([]);
		expect(await pathExists(worktreePath)).toBe(true);
	});

	it("stops git tracking a worktree it removes", async () => {
		const taskId = "ggg33";
		const worktreePath = await makeWorktree(taskId);
		// Assert on the task id, not the leaf: the leaf is the workspace label, which
		// the main worktree also carries.
		expect(git(repoPath, ["worktree", "list"])).toContain(taskId);

		await backdate(worktreePath, 30);
		await pruneTaskWorktrees({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 });

		// A deleted directory git still lists is how `git worktree list` starts
		// reporting phantom entries.
		expect(git(repoPath, ["worktree", "list"])).not.toContain(taskId);
	});

	it("removes the now-empty task directory", async () => {
		const worktreePath = await makeWorktree();
		// Layout is <home>/<taskId>/<workspaceLabel>, so the task directory is the
		// worktree's immediate parent.
		const taskDir = path.dirname(worktreePath);
		await backdate(worktreePath, 30);
		await pruneTaskWorktrees({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
		expect(await pathExists(taskDir)).toBe(false);
	});

	it("prunes several stale worktrees in one pass", async () => {
		const first = await makeWorktree("aaa11");
		const second = await makeWorktree("bbb22");
		await backdate(first, 30);
		await backdate(second, 31);

		const result = await pruneTaskWorktrees({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
		expect(result.removed).toHaveLength(2);
		expect(await pathExists(first)).toBe(false);
		expect(await pathExists(second)).toBe(false);
	});
});