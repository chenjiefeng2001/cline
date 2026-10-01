import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"

/**
 * Locating a `bash` that can actually open a Windows path.
 *
 * A Unix-shell hook on Windows is launched as `bash <windows-path>`, and whether
 * that works depends entirely on *which* bash is resolved - not on the hook:
 *
 *   - Git for Windows ships `Git\bin\bash.exe`, which accepts a Windows path, a
 *     POSIX path, or a path with spaces. Measured: exit 0.
 *   - The `bash` on PATH on a stock Windows machine is the WSL shim
 *     (`C:\Windows\System32\bash.exe`, plus the WindowsApps alias). It strips the
 *     separators out of a Windows path and exits 127 without running the hook.
 *     Measured: `/bin/bash: C:Users...PreToolUse: No such file or directory`.
 *
 * That second case is the dangerous one, because nothing is printed by the hook and
 * the failure is reported as a bare exit code. So resolution cannot be "whatever is
 * on PATH": the shim has to be recognised and skipped, and a hook that needs a shell
 * has to be refused when no real one is installed rather than attempted against it.
 *
 * Resolution is synchronous and filesystem-only. Probing by spawning, as the
 * PowerShell resolver in the extension host does, would mean launching a process per
 * hook load to answer a question `existsSync` answers, and the answer would then be
 * unobservable in a unit test.
 */

/** Locations whose `bash.exe` is the WSL shim rather than a shell. */
const WINDOWS_BASH_SHIM_MARKERS = ["\\windows\\system32\\", "\\windowsapps\\", "\\sysnative\\"]

/**
 * True for a path that resolves to the WSL `bash` shim.
 *
 * Exported because "we skipped the shim" is the whole point of this module and is
 * otherwise invisible: on a machine where the shim is first on PATH, returning it
 * produces a hook that silently does nothing.
 */
export function isWindowsBashShim(candidate: string): boolean {
	const normalized = candidate.replace(/\//g, "\\").toLowerCase()
	return WINDOWS_BASH_SHIM_MARKERS.some((marker) => normalized.includes(marker))
}

function candidateRoots(env: NodeJS.ProcessEnv): string[] {
	const roots: string[] = []
	const push = (root: string | undefined) => {
		if (root?.trim()) {
			roots.push(root.trim())
		}
	}
	push(env.ProgramW6432)
	push(env.ProgramFiles)
	push(env["ProgramFiles(x86)"])
	if (env.LOCALAPPDATA?.trim()) {
		roots.push(join(env.LOCALAPPDATA.trim(), "Programs"))
	}
	return roots
}

/**
 * Absolute paths that are worth probing, in preference order.
 *
 * `GIT_INSTALL_ROOT` comes first: someone who exported it wants that copy rather than
 * whatever happens to sit in Program Files. Both shapes are probed because the
 * variable is not consistent about which one it holds - Git Bash exports the install
 * root that contains `bin/`, while some installers and docs point at the parent that
 * contains `Git/`. Probing both is cheaper than being wrong about a user's toolchain.
 *
 * `bin` before `usr\bin` because `bin\bash.exe` is the one on PATH for a normal Git
 * for Windows install, and using the same copy the user's own shell would use is the
 * difference between a hook that behaves like their terminal and one that does not.
 */
export function getWindowsGitBashCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
	const absolute: string[] = []
	const installRoot = env.GIT_INSTALL_ROOT?.trim()
	if (installRoot) {
		absolute.push(join(installRoot, "bin", "bash.exe"))
		absolute.push(join(installRoot, "usr", "bin", "bash.exe"))
		absolute.push(join(installRoot, "Git", "bin", "bash.exe"))
	}
	for (const root of candidateRoots(env)) {
		absolute.push(join(root, "Git", "bin", "bash.exe"))
		absolute.push(join(root, "Git", "usr", "bin", "bash.exe"))
	}

	// PATH last, and only as a fallback: it is the only source that can hand back the
	// WSL shim, which is filtered rather than trusted.
	const fromPath = (env.PATH ?? env.Path ?? "")
		.split(delimiter)
		.map((entry) => entry.trim().replace(/^"|"$/g, ""))
		.filter(Boolean)
		.flatMap((dir) => [join(dir, "bash.exe"), join(dir, "bash")])

	return [...new Set([...absolute, ...fromPath])]
}

export type WindowsGitBashResolverOptions = {
	env?: NodeJS.ProcessEnv
	exists?: (candidate: string) => boolean
}

let cached: { key: string; resolved: string | undefined } | undefined
let resolverOverride: ((env: NodeJS.ProcessEnv) => string | undefined) | undefined

/**
 * Test seam: replaces the filesystem lookup.
 *
 * Needed because the branch that matters most - "no bash installed, so refuse the
 * hook" - cannot be reached on a developer machine that has Git for Windows, which is
 * most of them. The refusal is the behaviour with the most user consequence and the
 * least coverage otherwise, so it gets a seam rather than a comment.
 */
export function setWindowsGitBashResolverForTesting(
	resolver: ((env: NodeJS.ProcessEnv) => string | undefined) | null,
): void {
	resolverOverride = resolver ?? undefined
	cached = undefined
}

/** Test seam: drops the memoised lookup. */
export function resetWindowsGitBashCacheForTesting(): void {
	resolverOverride = undefined
	cached = undefined
}

/**
 * Absolute path of a `bash` on this machine that can run a Windows-path hook script,
 * or undefined when there is none.
 *
 * Cached per environment: hook files are inferred on every session start and the
 * answer cannot change without the process restarting.
 */
export function resolveWindowsGitBash(options: WindowsGitBashResolverOptions = {}): string | undefined {
	if (resolverOverride) {
		return resolverOverride(options.env ?? process.env)
	}
	const env = options.env ?? process.env
	const exists = options.exists ?? existsSync
	const key = JSON.stringify([env.GIT_INSTALL_ROOT, env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], env.LOCALAPPDATA, env.PATH ?? env.Path])
	if (cached?.key === key) {
		return cached.resolved
	}
	let resolved: string | undefined
	for (const candidate of getWindowsGitBashCandidates(env)) {
		if (isWindowsBashShim(candidate)) {
			continue
		}
		if (exists(candidate)) {
			resolved = candidate
			break
		}
	}
	cached = { key, resolved }
	return resolved
}
