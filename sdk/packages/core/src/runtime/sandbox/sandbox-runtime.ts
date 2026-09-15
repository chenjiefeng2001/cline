/**
 * Sandbox runtime adapter interface [roadmap P1-2].
 *
 * The isolation-layer contract from the gap analysis (D4): one interface
 * for sandboxed execution so backends (process sandbox, Docker, E2B) are
 * drop-ins, and remote mode is naturally compatible with cloud sandboxes.
 * The first adapter is the local process sandbox
 * (`process-sandbox-runtime.ts`); Docker/E2B backends implement the same
 * contract later without touching executors.
 */

/** Execution request routed through a sandbox backend. */
export interface SandboxExecutionRequest {
	command: string;
	args: string[];
	cwd?: string;
	timeoutMs?: number;
}

export interface SandboxExecutionResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
}

export const SANDBOX_UNAVAILABLE_ERROR_CODE = "sandbox_unavailable";

/**
 * Thrown when the requested sandbox backend is unavailable. Fail-closed by
 * contract: callers decide between failing, prompting approval, or
 * explicitly running unsandboxed — the runtime never silently downgrades.
 */
export class SandboxUnavailableError extends Error {
	readonly code = SANDBOX_UNAVAILABLE_ERROR_CODE;

	constructor(
		readonly backend: string,
		message?: string,
	) {
		super(
			message ??
				`sandbox backend unavailable: ${backend} (fail-closed; run unsandboxed explicitly if intended)`,
		);
		this.name = "SandboxUnavailableError";
	}
}

export function isSandboxUnavailableError(
	error: unknown,
): error is SandboxUnavailableError {
	return (
		error instanceof SandboxUnavailableError ||
		(typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === SANDBOX_UNAVAILABLE_ERROR_CODE)
	);
}

export interface SandboxRuntime {
	/** Backend identifier ("seatbelt" | "bubblewrap" | "docker" | "e2b" | ...). */
	readonly backend: string;
	isAvailable(): Promise<boolean> | boolean;
	exec(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
}
