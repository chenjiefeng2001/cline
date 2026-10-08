/**
 * Apply Patch Executor
 *
 * Built-in implementation for the documented GPT-5 apply_patch grammar.
 * It accepts the freeform patch body directly and tolerates the legacy shell
 * wrapper form used by older prompts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveBoundedPath, type FileBoundary } from "./file-boundary";
import type { AgentToolContext } from "@cline/shared";
import type { ApplyPatchInput } from "../schemas";
import type { ApplyPatchExecutor } from "../types";
import {
	BASH_WRAPPERS,
	DiffError,
	PATCH_MARKERS,
	PatchActionType,
	type PatchChunk,
	PatchParser,
	type PatchWarning,
} from "./apply-patch-parser";

export interface PatchFileChange {
	type: PatchActionType;
	oldContent?: string;
	newContent?: string;
	movePath?: string;
}

interface NormalizedPatchInput {
	lines: string[];
}

/**
 * Options for the apply_patch executor
 */
export interface ApplyPatchExecutorOptions {
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
	 * Optional workspace boundary. When set it is authoritative and wins over
	 * 
estrictToCwd, because it is the stronger guarantee and is the one that
	 * realpath-resolves. Unset leaves the historical lexical behaviour in place.
	 */
	boundary?: FileBoundary;
}

/**
 * Resolve a path the patch will read or write.
 *
 * When a boundary is configured it is authoritative and this delegates to
 * `resolveBoundedPath`, which realpaths both sides. That closes two holes the old
 * lexical check had, and both were reachable:
 *
 *   - a symlink *inside* the workspace that points outside it passed `rel.startsWith("..")`
 *     because nothing resolved the link, so the check could not see where the file
 *     actually was
 *   - absolute inputs returned early, because the check only ever applied to
 *     relative ones, so `C:\...` and `/etc/...` were accepted outright
 *
 * A configured boundary also deliberately overrides `restrictToCwd: false`. That
 * option is the legacy weaker knob; letting it silently defeat an explicitly
 * configured security boundary would mean a host could turn the boundary off by
 * leaving an unrelated default in place. With no boundary configured, behaviour is
 * unchanged: the lexical check still applies to relative paths when
 * `restrictToCwd` is true.
 */
async function resolveFilePath(
	cwd: string,
	inputPath: string,
	restrictToCwd: boolean,
	boundary: FileBoundary | undefined,
): Promise<string> {
	if (boundary) {
		return resolveBoundedPath(cwd, inputPath, boundary)
	}
	const isAbsoluteInput = path.isAbsolute(inputPath);
	const resolved = isAbsoluteInput
		? path.normalize(inputPath)
		: path.resolve(cwd, inputPath);
	if (!restrictToCwd || isAbsoluteInput) {
		return resolved;
	}

	const rel = path.relative(cwd, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new DiffError(`Path must stay within cwd: ${inputPath}`);
	}
	return resolved;
}

function normalizeLineEndings(input: string): string[] {
	return input.split("\n").map((line) => line.replace(/\r$/, ""));
}

function isWrapperLine(line: string): boolean {
	if (line.trim() === "") {
		return false;
	}
	return BASH_WRAPPERS.some((wrapper) => line.startsWith(wrapper));
}

function trimWrapperLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;

	while (start < end && isWrapperLine(lines[start] ?? "")) {
		start++;
	}

	while (end > start && isWrapperLine(lines[end - 1] ?? "")) {
		end--;
	}

	return lines.slice(start, end);
}

function normalizePatchInput(input: string): NormalizedPatchInput {
	const rawLines = normalizeLineEndings(input);
	const beginIndex = rawLines.findIndex((line) =>
		line.startsWith(PATCH_MARKERS.BEGIN),
	);
	let endIndex = -1;
	for (let i = rawLines.length - 1; i >= 0; i--) {
		if (rawLines[i]?.startsWith(PATCH_MARKERS.END)) {
			endIndex = i;
			break;
		}
	}

	if (beginIndex !== -1 || endIndex !== -1) {
		if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
			throw new DiffError(
				"Invalid patch text - incomplete sentinels. Try breaking it into smaller patches.",
			);
		}
		const lines = rawLines.slice(beginIndex, endIndex + 1);
		return {
			lines,
		};
	}

	const stripped = trimWrapperLines(rawLines);
	while (stripped.length > 0 && stripped[0] === "") {
		stripped.shift();
	}
	while (stripped.length > 0 && stripped[stripped.length - 1] === "") {
		stripped.pop();
	}

	const lines = [PATCH_MARKERS.BEGIN, ...stripped, PATCH_MARKERS.END];
	return {
		lines,
	};
}

function extractFilesForOperations(
	lines: readonly string[],
	markers: readonly string[],
): string[] {
	const files = new Set<string>();

	for (const line of lines) {
		for (const marker of markers) {
			if (line.startsWith(marker)) {
				files.add(line.substring(marker.length).trim());
				break;
			}
		}
	}

	return [...files];
}

function applyChunks(
	content: string,
	chunks: PatchChunk[],
	filePath: string,
): string {
	if (chunks.length === 0) {
		return content;
	}

	const lines = content.split("\n");
	const result: string[] = [];
	let currentIndex = 0;

	// Chunks arrive in the order the model wrote them, which need not be file order -
	// a model routinely emits a later function's hunk before an earlier one's. Applying
	// them in arrival order walked the file backwards and produced either scrambled
	// output or a "currentIndex > chunk.origIndex" abort, so a patch that was correct
	// on its own terms failed outright. Reported as cline/cline#4384 (see also #4067).
	//
	// Sort by resolved file position first. Array#sort is specified as stable, so two
	// hunks landing on the same offset keep their emission order.
	const ordered = chunks
		.map((chunk, order) => ({ chunk, order }))
		.sort((a, b) => a.chunk.origIndex - b.chunk.origIndex || a.order - b.order)
		.map((entry) => entry.chunk);

	for (const chunk of ordered) {
		if (chunk.origIndex > lines.length) {
			throw new DiffError(
				`${filePath}: chunk.origIndex ${chunk.origIndex} > lines.length ${lines.length}`,
			);
		}
		// A hunk has to start at or after the end of the previous one. Anything earlier
		// means the two contexts matched ambiguously and overlap, which is reported
		// rather than silently interleaved.
		if (currentIndex > chunk.origIndex) {
			throw new DiffError(
				`${filePath}: hunk at line ${chunk.origIndex + 1} overlaps the preceding hunk and cannot be applied unambiguously`,
			);
		}
		result.push(...lines.slice(currentIndex, chunk.origIndex));
		result.push(...chunk.insLines);
		currentIndex = chunk.origIndex + chunk.delLines.length;
	}

	result.push(...lines.slice(currentIndex));
	return result.join("\n");
}

async function loadFiles(
	lines: readonly string[],
	cwd: string,
	encoding: BufferEncoding,
	restrictToCwd: boolean,
	boundary: FileBoundary | undefined,
): Promise<Record<string, string>> {
	const filesToLoad = extractFilesForOperations(lines, [
		PATCH_MARKERS.UPDATE,
		PATCH_MARKERS.DELETE,
	]);
	const files: Record<string, string> = {};

	for (const filePath of filesToLoad) {
		const absolutePath = await resolveFilePath(cwd, filePath, restrictToCwd, boundary);
		let fileContent: string;
		try {
			fileContent = await fs.readFile(absolutePath, encoding);
		} catch {
			throw new DiffError(`File not found: ${filePath}`);
		}
		files[filePath] = fileContent.replace(/\r\n/g, "\n");
	}

	return files;
}

function patchToChanges(
	patch: ReturnType<PatchParser["parse"]>["patch"],
	originalFiles: Record<string, string>,
): Record<string, PatchFileChange> {
	const changes: Record<string, PatchFileChange> = {};

	for (const [filePath, action] of Object.entries(patch.actions)) {
		switch (action.type) {
			case PatchActionType.DELETE:
				changes[filePath] = {
					type: PatchActionType.DELETE,
					oldContent: originalFiles[filePath],
				};
				break;
			case PatchActionType.ADD:
				if (action.newFile === undefined) {
					throw new DiffError("ADD action without file content");
				}
				changes[filePath] = {
					type: PatchActionType.ADD,
					newContent: action.newFile,
				};
				break;
			case PatchActionType.UPDATE:
				changes[filePath] = {
					type: PatchActionType.UPDATE,
					oldContent: originalFiles[filePath],
					newContent: applyChunks(
						originalFiles[filePath] ?? "",
						action.chunks,
						filePath,
					),
					movePath: action.movePath,
				};
				break;
		}
	}

	return changes;
}

function formatSkippedHunkFailure(warnings: readonly PatchWarning[]): string {
	const lines = [
		`Patch could not be applied because ${warnings.length} hunk${warnings.length === 1 ? "" : "s"} did not match the current file content.`,
	];

	for (const warning of warnings) {
		const hunkNumber =
			warning.chunkIndex === undefined
				? "unknown"
				: String(warning.chunkIndex + 1);
		lines.push(`${warning.path}: hunk ${hunkNumber}: ${warning.message}`);
		if (warning.context) {
			lines.push(`Context:\n${warning.context}`);
		}
	}

	return lines.join("\n");
}

async function applyChanges(
	changes: Record<string, PatchFileChange>,
	cwd: string,
	encoding: BufferEncoding,
	restrictToCwd: boolean,
	boundary: FileBoundary | undefined,
): Promise<string[]> {
	const touched: string[] = [];

	for (const [filePath, change] of Object.entries(changes)) {
		const sourceAbsPath = await resolveFilePath(cwd, filePath, restrictToCwd, boundary);
		switch (change.type) {
			case PatchActionType.DELETE:
				await fs.rm(sourceAbsPath, { force: true });
				touched.push(`${filePath}: [deleted]`);
				break;
			case PatchActionType.ADD:
				if (change.newContent === undefined) {
					throw new DiffError(`Cannot create ${filePath} with no content`);
				}
				await fs.mkdir(path.dirname(sourceAbsPath), { recursive: true });
				await fs.writeFile(sourceAbsPath, change.newContent, { encoding });
				touched.push(filePath);
				break;
			case PatchActionType.UPDATE: {
				if (change.newContent === undefined) {
					throw new DiffError(
						`UPDATE change for ${filePath} has no new content`,
					);
				}

				if (change.movePath) {
					const moveAbsPath = await resolveFilePath(
						cwd,
						change.movePath,
						restrictToCwd,
						boundary,
					);
					await fs.mkdir(path.dirname(moveAbsPath), { recursive: true });
					await fs.writeFile(moveAbsPath, change.newContent, { encoding });
					await fs.rm(sourceAbsPath, { force: true });
					touched.push(`${filePath} -> ${change.movePath}`);
				} else {
					await fs.writeFile(sourceAbsPath, change.newContent, { encoding });
					touched.push(filePath);
				}
				break;
			}
		}
	}

	return touched;
}

/**
 * Parse a patch and compute the per-file changes it would apply, without
 * writing anything to disk. Reads the current contents of the files the patch
 * references. Exposed so hosts can preview a patch (e.g. in a diff editor)
 * before the executor applies it.
 */
export async function computePatchChanges(
	patchText: string,
	cwd: string,
	options: ApplyPatchExecutorOptions = {},
): Promise<{ changes: Record<string, PatchFileChange>; fuzz: number }> {
	const { encoding = "utf-8", restrictToCwd = true, boundary } = options;
	const normalizedInput = normalizePatchInput(patchText);
	const currentFiles = await loadFiles(
		normalizedInput.lines,
		cwd,
		encoding,
		restrictToCwd,
		boundary,
	);
	const parser = new PatchParser(normalizedInput.lines, currentFiles);
	const { patch, fuzz } = parser.parse();
	if (patch.warnings && patch.warnings.length > 0) {
		throw new DiffError(formatSkippedHunkFailure(patch.warnings));
	}

	return { changes: patchToChanges(patch, currentFiles), fuzz };
}

/**
 * Create an apply_patch executor using Node.js fs module.
 */
export function createApplyPatchExecutor(
	options: ApplyPatchExecutorOptions = {},
): ApplyPatchExecutor {
	const { encoding = "utf-8", restrictToCwd = true, boundary } = options;

	return async (
		input: ApplyPatchInput,
		cwd: string,
		_context: AgentToolContext,
	): Promise<string> => {
		const { changes, fuzz } = await computePatchChanges(input.input, cwd, {
			encoding,
			restrictToCwd,
			boundary,
		});
		const touched = await applyChanges(
			changes,
			cwd,
			encoding,
			restrictToCwd,
			boundary,
		);

		const responseLines = [
			"Successfully applied patch to the following files:",
		];
		for (const file of touched) {
			responseLines.push(file);
		}
		if (fuzz > 0) {
			responseLines.push(
				`\n\nNote: Patch applied with fuzz factor ${fuzz}`);
		}
		return responseLines.join("\n");
	};
}
