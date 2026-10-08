/**
 * Editor Executor
 *
 * Built-in implementation for filesystem editing operations.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveBoundedPath, type FileBoundary } from "./file-boundary"
import type { AgentToolContext } from "@cline/shared";
import type { EditFileInput } from "../schemas";
import type { EditorExecutor } from "../types";

/**
 * Options for the editor executor
 */
export interface EditorExecutorOptions {
	/**
	 * Optional workspace boundary. When set, resolved paths must stay inside it, including
	 * absolute paths, which resolveFilePath otherwise accepts unconditionally. When absent
	 * the historical behaviour is kept.
	 */
	boundary?: FileBoundary;

	/**
	 * File encoding used for read/write operations
	 * @default "utf-8"
	 */
	encoding?: BufferEncoding;

	/**
	 * Restrict relative-path file operations to paths inside cwd.
	 * Absolute paths are always accepted as-is.
	 * @default true
	 */
	restrictToCwd?: boolean;

	/**
	 * Maximum number of diff lines in str_replace output
	 * @default 200
	 */
	maxDiffLines?: number;
}

function resolveFilePath(
	cwd: string,
	inputPath: string,
	restrictToCwd: boolean,
): string {
	const isAbsoluteInput = path.isAbsolute(inputPath);
	const resolved = isAbsoluteInput
		? path.normalize(inputPath)
		: path.resolve(cwd, inputPath);
	if (!restrictToCwd) {
		return resolved;
	}

	// Absolute paths are accepted directly; cwd restriction applies to relative inputs.
	if (isAbsoluteInput) {
		return resolved;
	}

	const rel = path.relative(cwd, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Path must stay within cwd: ${inputPath}`);
	}
	return resolved;
}

/**
 * Editor-side counterpart to the read executor's boundary.
 *
 * resolveFilePath above already rejects relative paths that escape cwd, but it
 * accepts any absolute path and the `..` test is lexical only, so a symlink inside
 * the workspace could still reach outside. When a boundary is configured, the
 * check is delegated to resolveBoundedPath, which does the lexical pass and then
 * the symlink-resolving one. Without a boundary the behaviour is unchanged.
 */
async function resolveEditorPath(
	cwd: string,
	inputPath: string,
	restrictToCwd: boolean,
	boundary: FileBoundary | undefined,
): Promise<string> {
	if (boundary) {
		return resolveBoundedPath(cwd, inputPath, boundary);
	}
	return resolveFilePath(cwd, inputPath, restrictToCwd);
}

function countOccurrences(content: string, needle: string): number {
	if (needle.length === 0) return 0;
	return content.split(needle).length - 1;
}

/**
 * Returns "\r\n" if "\r\n" appears anywhere in the content, otherwise "\n" —
 * including for content with no line breaks at all. Files are uniformly CRLF
 * or uniformly LF in practice; the mixed case that matters is a CRLF file
 * with LF-only lines inserted by earlier releases of this tool, and any
 * surviving "\r\n" — wherever it sits — should pull such a file back to
 * CRLF, which is why this checks for "\r\n" anywhere rather than looking at
 * the first line break. Reads produced via readline strip "\r", so models
 * emit LF-only text even for CRLF files; edits must be normalized to the
 * file's own EOL or they create mixed line endings and break subsequent
 * exact-match replacements.
 */
function detectLineEnding(content: string): "\r\n" | "\n" {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeLineEndings(text: string, eol: "\r\n" | "\n"): string {
	return text.split(/\r\n|\n/).join(eol);
}

function createLineDiff(
	oldContent: string,
	newContent: string,
	maxLines: number,
): string {
	const oldLines = oldContent.split(/\r\n|\n/);
	const newLines = newContent.split(/\r\n|\n/);

	// Trim the common prefix and suffix so only the changed region is emitted;
	// a naive positional compare would mispair every line after an edit that
	// changes the line count.
	let start = 0;
	while (
		start < oldLines.length &&
		start < newLines.length &&
		oldLines[start] === newLines[start]
	) {
		start++;
	}
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (
		oldEnd > start &&
		newEnd > start &&
		oldLines[oldEnd - 1] === newLines[newEnd - 1]
	) {
		oldEnd--;
		newEnd--;
	}

	// Split the line budget between removals and additions so neither side is
	// silently dropped when the other alone would exhaust maxLines.
	const removedCount = oldEnd - start;
	const addedCount = newEnd - start;
	let removedBudget = removedCount;
	let addedBudget = addedCount;
	if (removedCount + addedCount > maxLines) {
		removedBudget = Math.min(
			removedCount,
			Math.max(Math.ceil(maxLines / 2), maxLines - addedCount),
		);
		addedBudget = Math.min(addedCount, maxLines - removedBudget);
	}

	const out: string[] = ["```diff"];
	for (let i = start; i < start + removedBudget; i++) {
		out.push(`-${i + 1}: ${oldLines[i]}`);
	}
	for (let i = start; i < start + addedBudget; i++) {
		out.push(`+${i + 1}: ${newLines[i]}`);
	}

	const omittedRemoved = removedCount - removedBudget;
	const omittedAdded = addedCount - addedBudget;
	if (omittedRemoved > 0 || omittedAdded > 0) {
		out.push(
			`... diff truncated (${omittedRemoved} more removed, ${omittedAdded} more added lines) ...`,
		);
	}

	out.push("```");
	return out.join("\n");
}

async function createFile(
	filePath: string,
	fileText: string,
	encoding: BufferEncoding,
): Promise<string> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, fileText, { encoding });

	// Read the file back and confirm it holds what we asked for. A write that resolves
	// is not proof that all of it landed: a short or partial write leaves the model
	// reading a truncated file, and the success message tells it the job is done, so it
	// moves on and builds on a file that is quietly missing content. That is the
	// "write_to_file truncates content ... especially for large files" report in
	// cline/cline#4384. Compare bytes rather than length alone so an encoding round
	// trip cannot masquerade as truncation.
	const written = await fs.readFile(filePath, encoding);
	if (written !== fileText) {
		const writtenChars = [...written].length;
		const intendedChars = [...fileText].length;
		throw new Error(
			`Write to ${filePath} did not complete: the file on disk holds ${writtenChars} of ${intendedChars} characters. ` +
				`The write was reported as successful but its content does not match what was requested, so it must not be treated as a finished edit. Re-read the file to see what is present, then write the remainder in smaller chunks.`,
		);
	}

	return `File created successfully at: ${filePath}`;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function replaceInFile(
	filePath: string,
	oldStr: string,
	newStr: string | null | undefined,
	encoding: BufferEncoding,
	maxDiffLines: number,
): Promise<string> {
	const content = await fs.readFile(filePath, encoding);
	const eol = detectLineEnding(content);
	const normalizedOldStr = normalizeLineEndings(oldStr, eol);
	const normalizedNewStr = normalizeLineEndings(newStr ?? "", eol);
	const occurrences = countOccurrences(content, normalizedOldStr);

	if (occurrences === 0) {
		throw new Error(`No replacement performed: text not found in ${filePath}.`);
	}

	if (occurrences > 1) {
		throw new Error(
			`No replacement performed: multiple occurrences of text found in ${filePath}.`,
		);
	}

	// Replacer function so "$"-sequences in new_text ($&, $', $`, $$, $n)
	// are inserted literally instead of being expanded by String.replace.
	const updated = content.replace(normalizedOldStr, () => normalizedNewStr);
	await fs.writeFile(filePath, updated, { encoding });

	const diff = createLineDiff(content, updated, maxDiffLines);
	return `Edited ${filePath}\n${diff}`;
}

async function insertInFile(
	filePath: string,
	insertLineOneBased: number,
	newStr: string,
	encoding: BufferEncoding,
): Promise<string> {
	const content = await fs.readFile(filePath, encoding);
	const eol = detectLineEnding(content);
	const lines = content.split(/\r\n|\n/);
	const maxBoundaryLine = lines.length + 1;

	if (insertLineOneBased < 1 || insertLineOneBased > maxBoundaryLine) {
		throw new Error(
			`Invalid insert_line: ${insertLineOneBased}. insert_line must be a positive one-based boundary line in the range 1-${maxBoundaryLine}. Use ${maxBoundaryLine} to append at EOF.`,
		);
	}

	const insertLine = insertLineOneBased - 1;
	lines.splice(insertLine, 0, ...newStr.split(/\r\n|\n/));
	await fs.writeFile(filePath, lines.join(eol), { encoding });

	return `Inserted content at line ${insertLineOneBased} in ${filePath}.`;
}

/**
 * Create an editor executor using Node.js fs module
 */
export function createEditorExecutor(
	options: EditorExecutorOptions = {},
): EditorExecutor {
	const {
		encoding = "utf-8",
		restrictToCwd = true,
		maxDiffLines = 200,
	} = options;
	const boundary = options.boundary;

	return async (
		input: EditFileInput,
		cwd: string,
		_context: AgentToolContext,
	): Promise<string> => {
		const filePath = await resolveEditorPath(cwd, input.path, restrictToCwd, boundary);

		if (input.insert_line != null) {
			return insertInFile(
				filePath,
				input.insert_line, // One-based index
				input.new_text,
				encoding,
			);
		}

		if (!(await fileExists(filePath))) {
			return createFile(filePath, input.new_text, encoding);
		}
		if (input.old_text == null) {
			throw new Error(
				"Parameter `old_text` is required when editing an existing file without `insert_line`",
			);
		}

		return replaceInFile(
			filePath,
			input.old_text,
			input.new_text,
			encoding,
			maxDiffLines,
		);
	};
}
