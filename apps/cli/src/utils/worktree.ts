import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { resolveClineDir } from "@cline/shared/storage";

const execFileAsync = promisify(execFile);
const TASK_ID_LENGTH = 5;

export interface CreateTaskWorktreeResult {
	success: boolean;
	message: string;
	path?: string;
	taskId?: string;
	repoRoot?: string;
}

export function getTaskWorktreesHomePath(): string {
	return path.join(resolveClineDir(), "worktrees");
}

function getWorkspaceFolderLabelForWorktreePath(repoPath: string): string {
	const folder = path.basename(repoPath.replace(/[\\/]+$/g, "")) || "workspace";
	const cleaned = [...folder]
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
		.join("")
		.trim();
	return cleaned || "workspace";
}

function createShortTaskId(): string {
	return randomUUID().replaceAll("-", "").slice(0, TASK_ID_LENGTH);
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function checkGitInstalled(): Promise<boolean> {
	try {
		await execFileAsync("git", ["--version"], { windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

async function getGitRootPath(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", cwd, "rev-parse", "--show-toplevel"],
			{ windowsHide: true },
		);
		const root = stdout.trim();
		return root || null;
	} catch {
		return null;
	}
}

export async function createTaskWorktree(options: {
	cwd: string;
	taskId?: string;
}): Promise<CreateTaskWorktreeResult> {
	if (!(await checkGitInstalled())) {
		return {
			success: false,
			message: "Git is not installed. --worktree requires git on PATH.",
		};
	}

	const repoRoot = await getGitRootPath(options.cwd);
	if (!repoRoot) {
		return {
			success: false,
			message: `Not a git repository: ${options.cwd}. --worktree requires a git repo.`,
		};
	}

	let taskId = options.taskId?.trim() || createShortTaskId();
	if (
		taskId.includes("/") ||
		taskId.includes("\\") ||
		taskId.includes("..") ||
		taskId.includes("\0")
	) {
		return { success: false, message: `Invalid worktree id: ${taskId}` };
	}

	const workspaceLabel = getWorkspaceFolderLabelForWorktreePath(repoRoot);
	let worktreePath = path.join(
		getTaskWorktreesHomePath(),
		taskId,
		workspaceLabel,
	);
	if (!options.taskId) {
		for (
			let attempt = 0;
			attempt < 16 && (await pathExists(worktreePath));
			attempt += 1
		) {
			taskId = createShortTaskId();
			worktreePath = path.join(
				getTaskWorktreesHomePath(),
				taskId,
				workspaceLabel,
			);
		}
	}

	const parentDir = path.dirname(worktreePath);
	const parentDirExisted = await pathExists(parentDir);

	try {
		await mkdir(parentDir, { recursive: true });
		await execFileAsync(
			"git",
			["-C", repoRoot, "worktree", "add", "--detach", worktreePath, "HEAD"],
			{ windowsHide: true },
		);
		return {
			success: true,
			message: `Worktree created at ${worktreePath}`,
			path: worktreePath,
			taskId,
			repoRoot,
		};
	} catch (error) {
		if (!parentDirExisted) {
			await rm(parentDir, { recursive: true, force: true }).catch(() => {});
		}
		return {
			success: false,
			message: `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * How old a task worktree must be before it is eligible for removal.
 *
 * Deliberately well beyond any realistic single task: a worktree is a full
 * checkout, so removing a recent one could destroy uncommitted work from a
 * concurrent session.
 */
const WORKTREE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Removes task worktrees older than the retention window.
 *
 * Every `--worktree` run creates a full detached checkout, and nothing ever
 * removed them: the directories accumulated indefinitely and, because git tracks
 * worktrees in `.git/worktrees`, `git worktree list` filled with entries whose
 * directories no longer exist once a user cleaned up by hand.
 *
 * Only directories under the managed home are considered, and a worktree still
 * registered with git is unregistered first so the repo's metadata does not keep
 * pointing at a directory this function is about to delete. Anything that cannot
 * be removed is skipped rather than throwing, since a stale directory must not
 * abort a run.
 *
 * Returns a summary rather than logging, so the caller decides how to surface it.
 */
export async function pruneTaskWorktrees(options?: {
	maxAgeMs?: number;
	now?: number;
}): Promise<PruneTaskWorktreesResult> {
	const maxAgeMs = options?.maxAgeMs ?? WORKTREE_MAX_AGE_MS;
	const now = options?.now ?? Date.now();
	const removed: string[] = [];
	const skipped: string[] = [];
	let failed = 0;

	let taskDirs: Dirent[];
	try {
		taskDirs = await readdir(getTaskWorktreesHomePath(), { withFileTypes: true });
	} catch {
		// No worktrees have ever been created.
		return { removed, skipped, failed };
	}

	for (const taskDir of taskDirs) {
		if (!taskDir.isDirectory()) {
			continue;
		}
		const taskPath = path.join(getTaskWorktreesHomePath(), taskDir.name);
		let workspaceDirs: Dirent[];
		try {
			workspaceDirs = await readdir(taskPath, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const workspaceDir of workspaceDirs) {
			if (!workspaceDir.isDirectory()) {
				continue;
			}
			const worktreePath = path.join(taskPath, workspaceDir.name);
			try {
				const stats = await stat(worktreePath);
				// Compare the newest mtime in the tree: a long-running task keeps
				// writing inside its worktree, and its root entry can still look old.
				const newest = Math.max(stats.mtimeMs, await newestMtimeMs(worktreePath));
				if (now - newest <= maxAgeMs) {
					skipped.push(worktreePath);
					continue;
				}
				await unregisterWorktree(worktreePath);
				await rm(worktreePath, { recursive: true, force: true });
				removed.push(worktreePath);
			} catch {
				// A worktree we cannot stat or delete is left alone.
				failed += 1;
			}
		}
		// Drop the task directory once its worktrees are gone, so the home does not
		// fill with empty shells.
		if (removed.some((entry) => entry.startsWith(`${taskPath}${path.sep}`))) {
			await rm(taskPath, { recursive: true, force: true }).catch(() => {});
		}
	}

	return { removed, skipped, failed };
}

export interface PruneTaskWorktreesResult {
	removed: string[];
	skipped: string[];
	failed: number;
}

/**
 * Newest mtime in a directory tree, bounded in depth.
 *
 * Bounded because a node_modules inside a stale worktree can hold hundreds of
 * thousands of entries; walking all of it would make a cleanup slower than the
 * thing being cleaned. The top of the tree is where a live task writes anyway.
 */
async function newestMtimeMs(dir: string, depth = 2): Promise<number> {
	let newest = 0;
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		if (depth <= 0) {
			continue;
		}
		const child = path.join(dir, entry.name);
		try {
			const stats = await stat(child);
			newest = Math.max(newest, stats.mtimeMs, await newestMtimeMs(child, depth - 1));
		} catch {
			// Unreadable entry; the parent's mtime still counts.
		}
	}
	return newest;
}

/**
 * Unregisters a worktree from its repository so `.git/worktrees` stops pointing
 * at a directory that is about to be deleted. No-ops when the path is not a
 * registered worktree or when the owning repo cannot be determined.
 */
async function unregisterWorktree(worktreePath: string): Promise<void> {
	try {
		await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--git-common-dir"], {
			windowsHide: true,
		});
	} catch {
		// Not a live worktree (or git is gone); deleting the directory is still right.
		return;
	}
	try {
		// Must run with -C inside the repository: invoked from the process cwd it
		// fails outright, which left `.git/worktrees` pointing at deleted directories.
		await execFileAsync(
			"git",
			["-C", worktreePath, "worktree", "remove", "--force", worktreePath],
			{ windowsHide: true },
		);
		return;
	} catch {
		// Best effort: fall back to deleting the directory and then pruning the
		// stale administrative entry so `git worktree list` stays accurate.
	}
	try {
		await execFileAsync("git", ["-C", worktreePath, "worktree", "prune"], {
			windowsHide: true,
		});
	} catch {
		// Nothing further to do; the rm in the caller still removes the directory.
	}
}