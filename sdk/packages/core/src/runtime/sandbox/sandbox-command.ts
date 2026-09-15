/**
 * Process sandbox command construction [roadmap P1-2].
 *
 * Gap D4: execution isolation relied on toolPolicies + human approval
 * ("approval as sandbox"). The mainstream baseline (Claude Code local
 * default) is a process-level sandbox: macOS Seatbelt / Linux bubblewrap,
 * with workspace-write semantics — everything allowed, writes confined to
 * the workspace.
 *
 * This module owns the *pure* command construction and platform detection;
 * `buildProcessSandboxCommand` returns `undefined` on platforms without a
 * process sandbox (win32) so callers fail closed via
 * {@link detectProcessSandbox} instead of silently running unsandboxed.
 * No sandboxing is executed here — construction is testable on every
 * platform without spawning the sandbox binary.
 */

import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type ProcessSandboxBackend = "seatbelt" | "bubblewrap";

/** A command + argv ready for `spawn`. */
export interface PlatformCommand {
	command: string;
	args: string[];
}

export interface ProcessSandboxCommandInput {
	command: string;
	args: string[];
	/** Workspace root that stays writable inside the sandbox. */
	workspaceRoot: string;
	backend: ProcessSandboxBackend;
	/** Platform override (tests); defaults to `process.platform`. */
	platform?: NodeJS.Platform;
}

/**
 * Builds the Seatbelt profile for workspace-write semantics: default allow,
 * file writes confined to the workspace root. The profile text is passed as
 * an argv element (never through a shell), so only the subpath needs quotes.
 */
export function buildSeatbeltProfile(workspaceRoot: string): string {
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* (subpath "${workspaceRoot}"))`,
	].join(" ");
}

/**
 * Wraps a command with the platform process sandbox. Returns `undefined`
 * when the platform has no process sandbox (win32) — callers treat that as
 * fail-closed, not as a fallback to unsandboxed execution.
 */
export function buildProcessSandboxCommand(
	input: ProcessSandboxCommandInput,
): PlatformCommand | undefined {
	const platform = input.platform ?? process.platform;
	if (platform === "win32") {
		return undefined;
	}
	if (input.backend === "seatbelt") {
		return {
			command: "sandbox-exec",
			args: [
				"-p",
				buildSeatbeltProfile(input.workspaceRoot),
				input.command,
				...input.args,
			],
		};
	}
	if (input.backend === "bubblewrap") {
		// Read-only root + workspace bind (later binds win over earlier),
		// basic device nodes, and die-with-parent so orphaned sandboxes
		// cannot outlive the caller.
		return {
			command: "bwrap",
			args: [
				"--ro-bind",
				"/",
				"/",
				"--bind",
				input.workspaceRoot,
				input.workspaceRoot,
				"--dev",
				"/dev",
				"--proc",
				"/proc",
				"--die-with-parent",
				"--",
				input.command,
				...input.args,
			],
		};
	}
	return undefined;
}

export interface ProcessSandboxDetection {
	available: boolean;
	backend?: ProcessSandboxBackend;
	/** Absolute path of the sandbox binary, when found on PATH. */
	binaryPath?: string;
	reason?: string;
}

export interface ProcessSandboxDetectOptions {
	backend?: ProcessSandboxBackend;
	/** Platform override (tests); defaults to `process.platform`. */
	platform?: NodeJS.Platform;
	/** PATH override (tests); defaults to `process.env.PATH`. */
	pathEnv?: string;
}

/** Platform-default backend for a sandbox-capable platform. */
export function defaultProcessSandboxBackend(
	platform: NodeJS.Platform,
): ProcessSandboxBackend | undefined {
	if (platform === "darwin") {
		return "seatbelt";
	}
	if (platform === "linux") {
		return "bubblewrap";
	}
	return undefined;
}

function findBinaryOnPath(
	binaryName: string,
	pathEnv: string | undefined,
): string | undefined {
	if (!pathEnv) {
		return undefined;
	}
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) {
			continue;
		}
		const candidate = isAbsolute(binaryName)
			? binaryName
			: join(dir, binaryName);
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Detects process-sandbox availability. win32 and other unsupported
 * platforms report `available: false` with a reason — callers decide
 * between failing closed or falling back to approval-gated execution.
 */
export function detectProcessSandbox(
	options: ProcessSandboxDetectOptions = {},
): ProcessSandboxDetection {
	const platform = options.platform ?? process.platform;
	const backend = options.backend ?? defaultProcessSandboxBackend(platform);
	if (!backend) {
		return {
			available: false,
			reason: `process sandbox requires macOS (Seatbelt) or Linux (bubblewrap); ${platform} is unsupported`,
		};
	}
	const binaryName = backend === "seatbelt" ? "sandbox-exec" : "bwrap";
	const binaryPath = findBinaryOnPath(
		binaryName,
		options.pathEnv ?? process.env.PATH,
	);
	if (!binaryPath) {
		return {
			available: false,
			backend,
			reason: `${binaryName} not found on PATH`,
		};
	}
	return { available: true, backend, binaryPath };
}
