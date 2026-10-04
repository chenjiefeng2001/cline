/**
 * Transient provider/transport error classification and retry policy.
 *
 * This lives in `@cline/llms` rather than in a host because "is this failure worth
 * retrying?" is a fact about the provider/transport, not about any host's UX. It used
 * to live only in the VS Code extension (`apps/vscode/src/sdk/sdk-session-lifecycle.ts`),
 * which meant the CLI had no automatic retry at all: a transient `ECONNRESET` or a
 * provider 503 failed the turn outright on one host and was transparently retried on
 * the other. Two hosts, two behaviours, for the same network event.
 *
 * Kept deliberately as a pure predicate over an `unknown`, so it can classify an
 * error that crossed a process or serialization boundary and arrived as a string.
 */

/** Retry knobs shared by every host, so the two cannot drift apart. */
export interface ProviderRetryPolicy {
	/** Attempts after the first. `3` means up to 4 total attempts. */
	maxRetries: number;
	/** First backoff step; doubled per attempt. */
	baseDelayMs: number;
	/** Ceiling for the backoff. */
	maxDelayMs: number;
	/**
	 * Fraction of the computed delay added as random jitter, to avoid a fleet of
	 * clients retrying in lockstep after a provider recovers.
	 */
	jitterRatio: number;
}

export const DEFAULT_PROVIDER_RETRY_POLICY: ProviderRetryPolicy = {
	maxRetries: 3,
	baseDelayMs: 2_000,
	maxDelayMs: 30_000,
	jitterRatio: 0.2,
};

/**
 * Flatten an error to the text worth matching on.
 *
 * Node surfaces transport failures as a short code (`ECONNRESET`) on `error.code`
 * with a much longer human message, and the code is the more reliable signal — a
 * message can be reworded upstream, a syscall code cannot. `cause` is walked because
 * SDK client wrappers routinely bury the socket error one level down.
 */
function errorText(error: unknown, depth = 0): string {
	if (typeof error === "string") {
		return error;
	}
	if (depth > 4 || error === null || error === undefined) {
		return "";
	}
	if (error instanceof Error) {
		const code = (error as { code?: unknown }).code;
		const parts = [error.name, error.message];
		if (typeof code === "string") {
			parts.push(code);
		}
		const cause = (error as { cause?: unknown }).cause;
		if (cause !== undefined) {
			parts.push(errorText(cause, depth + 1));
		}
		return parts.join(" ");
	}
	if (typeof error === "object") {
		try {
			return JSON.stringify(error) ?? "";
		} catch {
			return "";
		}
	}
	return String(error);
}

/**
 * Whether a failed provider/transport call is worth retrying automatically.
 *
 * Permanent failures (auth, billing, bad request, not-found) return false, because
 * retrying them just burns wall-clock and quota before surfacing the same error.
 */
export function isTransientProviderError(error: unknown): boolean {
	// An abort is a decision, not a fault. Retry would defeat the cancellation.
	if (isAbortLikeError(error)) {
		return false;
	}

	// A timeout is classified by NAME, deliberately not by message: the `net.ts`
	// timeout sets `name === "TIMEOUT"` while its message can read like a cancellation.
	const name = (error as { name?: unknown })?.name;
	if (name === "TimeoutError" || name === "TIMEOUT") {
		return true;
	}

	const text = errorText(error).toLowerCase();
	if (!text) {
		return false;
	}

	// Network / transport.
	if (
		text.includes("econnreset") ||
		text.includes("econnrefused") ||
		text.includes("econnaborted") ||
		text.includes("enotfound") ||
		text.includes("ehostunreach") ||
		text.includes("enetunreach") ||
		text.includes("epipe") ||
		text.includes("socket hang up")
	) {
		return true;
	}

	// TLS handshake failures. These surface either as a Node syscall code or as the
	// OpenSSL message carried on the Error, so both are matched.
	if (
		text.includes("before secure tls connection was established") ||
		text.includes("err_ssl") ||
		text.includes("eprotocol") ||
		text.includes("eproto ")
	) {
		return true;
	}

	// Server-side transient. The phrase forms are checked first, then the bare status
	// codes.
	//
	// The bare codes are matched with plain substring tests ON PURPOSE. A tighter
	// match (requiring "status"/"code"/"HTTP" nearby) was tried and rejected: it stops
	// "503 Service Unavailable" from being retried when a provider words it as
	// "upstream said 503", and it cannot tell "read 502 lines from disk" from a real
	// 502. The asymmetry decides it — a false positive costs one wasted ~2s retry,
	// a false negative loses the user's turn. Erring toward retrying is the right
	// direction for this particular mistake.
	if (
		text.includes("bad gateway") ||
		text.includes("service unavailable") ||
		text.includes("gateway timeout") ||
		text.includes("internal server error")
	) {
		return true;
	}
	if (text.includes("502") || text.includes("503") || text.includes("504")) {
		return true;
	}

	// Rate limiting: transient, and backoff is exactly the right response. Same
	// bias as above.
	if (
		text.includes("429") ||
		text.includes("rate limit") ||
		text.includes("too many requests")
	) {
		return true;
	}

	// Capacity. Narrowed to the two phrasings providers actually use; a bare
	// "capacity" also appears in quota copy that is NOT worth retrying.
	if (
		text.includes("overloaded") ||
		text.includes("overloaded_error") ||
		text.includes("model is at capacity")
	) {
		return true;
	}

	// Streaming stalls. Requiring a stream-related token alongside the failure keeps
	// this from matching any error that merely mentions "reset".
	if (
		text.includes("stream") &&
		(text.includes("stall") ||
			text.includes("reset") ||
			text.includes("broken"))
	) {
		return true;
	}

	return false;
}

/**
 * Whether an error represents a deliberate cancellation.
 *
 * An `AbortError` in any of its spellings, and the SDK's own abort wrapper.
 */
export function isAbortLikeError(error: unknown): boolean {
	if (error === null || typeof error !== "object") {
		return false;
	}
	const name = (error as { name?: unknown }).name;
	return name === "AbortError" || name === "ControlledStopError";
}

/**
 * Backoff for `attempt` (0-based), with jitter.
 *
 * `random` is injectable so the schedule is testable without stubbing globals.
 */
export function computeRetryDelayMs(
	attempt: number,
	policy: ProviderRetryPolicy = DEFAULT_PROVIDER_RETRY_POLICY,
	random: () => number = Math.random,
): number {
	const exponential = Math.min(
		policy.baseDelayMs * 2 ** Math.max(0, attempt),
		policy.maxDelayMs,
	);
	const jitter = exponential * policy.jitterRatio * random();
	return Math.round(exponential + jitter);
}
