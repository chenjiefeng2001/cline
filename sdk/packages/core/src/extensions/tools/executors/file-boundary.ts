import { resolveContainedPath } from "@cline/shared/storage"
import path from "node:path"

/**
 * Optional workspace boundary for a file-touching executor.
 *
 * Absent, both executors behave exactly as they always have: any absolute path is
 * accepted. That is the historical behaviour and it is what makes working on files
 * outside the repository possible, so it stays the fallback rather than becoming a
 * throw.
 */
export interface FileBoundary {
	/** Root the resolved path must stay inside. */
	root: string
	/**
	 * Extra roots that are also permitted, for multi-root workspaces or a checkout
	 * that legitimately lives elsewhere. Checked in order; the first match wins.
	 */
	additionalRoots?: string[]
}

export class PathOutsideBoundaryError extends Error {
	constructor(
		readonly requestedPath: string,
		readonly boundary: FileBoundary,
	) {
		super(
			`Path is outside the permitted workspace: ${requestedPath}. ` +
				`Permitted roots: ${[boundary.root, ...(boundary.additionalRoots ?? [])].join(", ")}. ` +
				`Nothing was read or written. If this file genuinely needs to be accessible, ` +
				`ask the user to add its directory to the allowed roots.`,
		)
		this.name = "PathOutsideBoundaryError"
	}
}

/**
 * Resolve a possibly-relative path against `cwd` and assert it stays within the
 * configured boundary.
 *
 * Every permitted root is checked with {@link resolveContainedPath}, which
 * realpath-resolves both sides. That is the only check that is actually
 * authoritative: a lexical `..` comparison is not enough, because a symlink that
 * *sits* inside the workspace can point anywhere, so the path looks contained
 * lexically while the file is not. A lexical pre-filter was tried here first and is
 * exactly what let that case through - it is deliberately not used, so the cost is
 * one realpath per root per call, and the guarantee does not depend on the input's
 * shape.
 */
export async function resolveBoundedPath(
	cwd: string,
	inputPath: string,
	boundary: FileBoundary | undefined,
): Promise<string> {
	// `path.resolve`, not `path.normalize`, for the absolute branch. On Windows
	// `path.isAbsolute("/shared/notes.md")` is true, so normalize was taken, and it
	// returns the path still drive-relative as "\shared\notes.md". The roots go through
	// realpath and come back drive-qualified as "C:\shared", so the containment check
	// compared two paths on different bases and `path.relative` reported an escape -
	// rejecting a path that was genuinely inside a permitted root. Models emit rooted
	// POSIX-style paths, so this was reachable, not theoretical. Resolving assigns the
	// drive the same way the roots get theirs, and a genuinely different drive still
	// fails to contain, which is the correct answer.
	//
	// The relative branch keeps `cwd` explicitly: a bare `path.resolve(inputPath)`
	// would silently resolve against the process directory instead, which happens to
	// be right only when the host's cwd is the workspace and wrong in every daemon,
	// test and remote session where it is not.
	const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(cwd, inputPath)
	if (!boundary) {
		return resolved
	}

	for (const root of [boundary.root, ...(boundary.additionalRoots ?? [])]) {
		try {
			return await resolveContainedPath(root, resolved, { mustExist: false })
		} catch {
			// Not inside this root; try the next one.
		}
	}

	throw new PathOutsideBoundaryError(resolved, boundary)
}
