/**
 * Glob Executor
 *
 * Built-in implementation for finding files by name pattern.
 *
 * `search_codebase` answers "where is this text?"; it cannot answer "which files
 * are named *.spec.ts?" without a per-file content scan per pattern. Globbing by
 * name is a different question with a different cost profile, so it gets its own
 * executor rather than being bolted onto search as a special regex.
 *
 * The matching source is the shared workspace file index (`getFileIndex`), the
 * same one `search_codebase` falls back to. That is a deliberate choice:
 *
 * - The index already excludes VCS metadata (`.git`), and when the workspace is
 *   a git repository ripgrep's listing also honours `.gitignore`, so glob cannot
 *   surface build output or dependencies that search would never have shown.
 *   What is excluded depends on which indexer path runs, so glob promises only
 *   what both guarantee rather than overstating coverage.
 * - Results are relative POSIX paths inside the workspace, so a pattern can never
 *   walk out of the workspace: there is no path resolution step for the model to
 *   exploit, and a `../` pattern simply matches nothing.
 * - The index is built by a worker and cached, so repeated globs in a turn cost
 *   one directory walk rather than one walk per pattern.
 */

import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { getFileIndex } from "../../../services/workspace";
import type { GlobExecutor } from "../types";
import { MAX_GLOB_OUTPUT_CHARS } from "./output-limits";

export interface GlobExecutorOptions {
	/**
	 * Maximum number of paths returned per pattern.
	 * @default 200
	 */
	maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 200;

/**
 * Compiles a glob pattern to a RegExp.
 *
 * Standard glob semantics, deliberately not a shell's:
 * - `*` matches any run of characters except `/`
 * - `?` matches exactly one character except `/`
 * - `**` matches across `/` (including zero segments)
 * - `[abc]` / `[a-z]` character classes are supported, `!`/`^` negates
 *
 * Everything else is literal. There is no brace expansion and no backslash
 * escaping beyond what the platform path separator needs, because a model
 * writing patterns from a description will not produce brace lists reliably and
 * a silently-different dialect is worse than a missing convenience.
 */
export function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
	let source = "";

	for (let i = 0; i < normalized.length; i++) {
		const char = normalized[i];

		if (char === "*") {
			const isGlobstar = normalized[i + 1] === "*";
			if (isGlobstar) {
				i++;
				// `**/` must also match zero directories, so `**/foo` matches
				// `foo` at the root. Handling the slash inside the group keeps
				// that true without a second alternative in the pattern.
				if (normalized[i + 1] === "/") {
					i++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}

		if (char === "?") {
			source += "[^/]";
			continue;
		}

		if (char === "[") {
			const close = normalized.indexOf("]", i + 1);
			if (close === -1) {
				// Unterminated class: treat the bracket as a literal rather than
				// swallowing the rest of the pattern into a broken class.
				source += "\\[";
				continue;
			}
			let body = normalized.slice(i + 1, close);
			if (body.startsWith("!")) {
				body = `^${body.slice(1)}`;
			}
			source += `[${body}]`;
			i = close;
			continue;
		}

		source += char.replace(/[.+^${}()|\\]/g, "\\$&");
	}

	return new RegExp(`^${source}$`);
}

/**
 * Resolve a model-supplied `path` argument against the workspace root, refusing
 * anything that leaves it.
 *
 * The index itself cannot leak files outside the workspace, but silently
 * returning nothing for `path: "../../.."` would read as "no files match" and
 * send the model hunting for the wrong reason. An explicit error is the
 * truthful answer.
 */
export function resolveGlobScope(
	cwd: string,
	scope: string | undefined,
): { root: string } | { error: string } {
	if (!scope || scope.trim() === "" || scope === ".") {
		return { root: cwd };
	}

	const normalizedCwd = path.resolve(cwd);
	const resolved = path.resolve(normalizedCwd, scope);

	const relative = path.relative(normalizedCwd, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		return { error: `Path "${scope}" is outside the workspace root.` };
	}

	return { root: resolved };
}

/**
 * Create a glob executor.
 *
 * @example
 * ```typescript
 * const glob = createGlobExecutor({ maxResults: 500 })
 * const paths = await glob("src/**\/*.test.ts", "/path/to/project", context)
 * ```
 */
export function createGlobExecutor(options: GlobExecutorOptions = {}): GlobExecutor {
	const { maxResults = DEFAULT_MAX_RESULTS } = options;

	return async (
		pattern: string,
		cwd: string,
		context: AgentToolContext,
	): Promise<string> => {
		if (context.signal?.aborted) {
			throw new Error("Glob operation aborted");
		}

		const scope = resolveGlobScope(cwd, context.globPath);
		if ("error" in scope) {
			throw new Error(scope.error);
		}

		// A bare filename pattern is the common case ("*.spec.ts") and users
		// expect it to match at any depth, the way a shell glob in the current
		// directory does not but every glob tool behaves. Anchoring bare
		// patterns to any basename would otherwise return nothing for nested
		// projects like `apps/vscode/src/...`.
		const hasSeparator = pattern.replace(/\\/g, "/").includes("/");
		const effectivePattern = hasSeparator ? pattern : `**/${pattern}`;
		const matcher = globToRegExp(effectivePattern);

		const index = await getFileIndex(scope.root);

		if (context.signal?.aborted) {
			throw new Error("Glob operation aborted");
		}

		const prefix = path.relative(cwd, scope.root).split(path.sep).join("/");
		const matches: string[] = [];
		for (const relativePath of index) {
			if (matches.length >= maxResults) {
				break;
			}
			// Re-anchor results on the workspace root so the model gets one
			// consistent coordinate system regardless of the scope it asked for.
			const workspacePath = prefix ? `${prefix}/${relativePath}` : relativePath;
			if (matcher.test(workspacePath)) {
				matches.push(workspacePath);
			}
		}

		matches.sort();

		if (matches.length === 0) {
			return `No files matched pattern: ${pattern}`;
		}

		const truncatedResults = matches.length >= maxResults;
		const lines = [
			`Found ${matches.length}${truncatedResults ? "+" : ""} file${matches.length === 1 ? "" : "s"} matching: ${pattern}`,
			"",
		];
		lines.push(...matches);
		if (truncatedResults) {
			lines.push(
				"",
				`(Showing first ${maxResults} matches. Narrow the pattern or pass a subdirectory via path.)`,
			);
		}

		const output = lines.join("\n");
		if (output.length <= MAX_GLOB_OUTPUT_CHARS) {
			return output;
		}
		const headLimit = Math.ceil(MAX_GLOB_OUTPUT_CHARS / 2);
		return (
			`${output.slice(0, headLimit)}\n` +
			`[... glob output truncated: ${output.length} chars total. ` +
			"Narrow the pattern or add a path to view the elided matches ...]\n" +
			output.slice(-Math.max(1, MAX_GLOB_OUTPUT_CHARS - headLimit))
		);
	};
}