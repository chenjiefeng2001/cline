import { readFile, stat } from "node:fs/promises";
import {
	PathEscapesRootError,
	resolveContainedPath,
} from "@cline/shared/storage";

const MAX_USER_FILE_BYTES = 20 * 1_000 * 1_024;

export interface UserFileContainment {
	/**
	 * Root the attached file must resolve inside. The host supplies the session
	 * workspace, because `userFiles` arrives from a remote client and would
	 * otherwise be an arbitrary file read on the host.
	 */
	workspaceRoot?: string;
}

/**
 * Read an attached user file into model context.
 *
 * When a workspace root is known the path is confined to it *after* following
 * symlinks, so neither `../` traversal, an absolute path elsewhere, nor a
 * symlink planted inside the workspace can pull a file from outside. The
 * rejection is a policy decision, so it is surfaced as a distinct error instead
 * of being folded into the generic read failure.
 */
export async function loadUserFileContent(
	path: string,
	containment: UserFileContainment = {},
): Promise<string> {
	const workspaceRoot = containment.workspaceRoot?.trim();
	let resolved = path;
	if (workspaceRoot) {
		try {
			resolved = await resolveContainedPath(workspaceRoot, path, {
				mustExist: true,
			});
		} catch (error) {
			if (error instanceof PathEscapesRootError) {
				throw new UserFileOutsideWorkspaceError(path, workspaceRoot);
			}
			throw error;
		}
	}
	const fileStat = await stat(resolved);
	if (!fileStat.isFile()) {
		throw new Error("Path is not a file");
	}
	if (fileStat.size > MAX_USER_FILE_BYTES) {
		throw new Error("File is too large to read into context.");
	}
	const content = await readFile(resolved, "utf8");
	if (content.includes("\u0000")) {
		throw new Error("Cannot read binary file into context.");
	}
	return content;
}

export class UserFileOutsideWorkspaceError extends Error {
	constructor(
		readonly path: string,
		readonly workspaceRoot: string,
	) {
		super(
			`File is outside the session workspace and cannot be attached: ${path}`,
		);
		this.name = "UserFileOutsideWorkspaceError";
	}
}
