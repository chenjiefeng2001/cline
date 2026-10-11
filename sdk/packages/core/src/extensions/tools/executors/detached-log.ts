/**
 * Detached command output logging.
 *
 * When a command outlives its tool timeout the SDK stops waiting but leaves the
 * process running, and its remaining output goes to a host-owned log. Two
 * properties make that handover trustworthy:
 *
 *  1. **No output is lost between the snapshot and the log taking over.** A
 *     collector switches to forwarding inside the same synchronous call that
 *     produces the snapshot, and Node delivers `data` events one at a time, so
 *     every chunk is either wholly inside the snapshot or wholly forwarded.
 *     There is no third case.
 *  2. **Exactly one writer.** All writes are serialised through one drain loop,
 *     so chunks cannot interleave, duplicate or reorder.
 *
 * Nothing here imports a host module: the SDK owns *when* to detach, the host
 * owns the file.
 */

import type {
	AgentToolNotice,
	DetachedCommandLogHandle,
	DetachedCommandLogSink,
} from "@cline/shared";

/**
 * Ceiling on output buffered while the log is still being created.
 *
 * Matches the 10 MB cap hosts apply to detached-command logs, so the in-memory
 * buffer can never promise more than the file behind it can hold. Overflow is
 * disclosed rather than silently swallowed.
 */
export const DETACHED_PENDING_LIMIT_CHARS = 10 * 1024 * 1024;

/** One-shot notification that a detached log stopped recording completely. */
export const DETACHED_OUTPUT_LOG_FAILED_NOTICE: AgentToolNotice = {
	noticeType: "status",
	reason: "detached_output_log_failed",
	message:
		"Output recording for a detached command has stopped, so its log file is incomplete from this point. The command itself may still be running.",
};

export interface DetachedLogWriterOptions {
	/** Surfaces a user-visible notice. Display-only — not visible to the model. */
	emitNotice?: (notice: AgentToolNotice) => void;
	/** Overrides the in-memory ceiling; mainly for tests. */
	pendingLimitChars?: number;
}

export interface DetachedLogWriter {
	/**
	 * Buffer a chunk for the log. Safe before a handle exists: chunks produced
	 * while the sink is still creating the file queue here rather than vanish.
	 */
	enqueue(chunk: string): void;
	/** Hand the queued output to a freshly opened log and start draining. */
	attach(handle: DetachedCommandLogHandle): Promise<void>;
	/** Drain, then close the log exactly once. */
	finish(finalMessage: string): Promise<void>;
	/** True once a write failed permanently; the log can no longer be trusted. */
	readonly failed: boolean;
	/** True if buffered output was dropped because the ceiling was reached. */
	readonly overflowed: boolean;
}

/**
 * Serialises every write to one log behind a single drain loop.
 *
 * The `pumping` guard is what makes concurrent writes impossible: a chunk
 * arriving while a write is in flight is appended to the queue and picked up by
 * the same loop, and the gap between the loop's exit condition and resetting
 * `pumping` contains no `await`, so no other chunk can be dropped on the floor.
 */
export function createDetachedLogWriter(
	options: DetachedLogWriterOptions = {},
): DetachedLogWriter {
	const limit = options.pendingLimitChars ?? DETACHED_PENDING_LIMIT_CHARS;
	const queue: string[] = [];
	let queuedChars = 0;
	let handle: DetachedCommandLogHandle | undefined;
	let draining: Promise<void> | undefined;
	let failed = false;
	let overflowed = false;
	let closed = false;
	let notified = false;

	const notice = (): void => {
		if (notified || !options.emitNotice) {
			return;
		}
		notified = true;
		try {
			options.emitNotice(DETACHED_OUTPUT_LOG_FAILED_NOTICE);
		} catch {
			// A failing notification must not escalate into a failing command.
		}
	};

	const fail = (): void => {
		if (failed) {
			return;
		}
		failed = true;
		queue.length = 0;
		queuedChars = 0;
		notice();
	};

	const pump = (): Promise<void> => {
		if (draining) {
			return draining;
		}
		if (failed || !handle || queue.length === 0) {
			return Promise.resolve();
		}
		const target = handle;
		draining = (async () => {
			try {
				// Re-checked after every await, so a chunk that arrives while a
				// write is in flight is picked up by this same loop.
				while (queue.length > 0) {
					const chunk = queue.shift() as string;
					queuedChars -= chunk.length;
					await target.write(chunk);
				}
			} catch {
				fail();
			}
		})().finally(() => {
			draining = undefined;
		});
		return draining;
	};

	/** Resolves once no write is in flight and nothing is still queued. */
	const settleDrain = async (): Promise<void> => {
		while (draining) {
			await draining;
		}
	};

	return {
		enqueue(chunk: string): void {
			if (!chunk || failed || closed) {
				return;
			}
			if (queuedChars + chunk.length > limit) {
				overflowed = true;
				notice();
				return;
			}
			queue.push(chunk);
			queuedChars += chunk.length;
			void pump();
		},
		async attach(next: DetachedCommandLogHandle): Promise<void> {
			if (handle) {
				return;
			}
			handle = next;
			await pump();
		},
		async finish(finalMessage: string): Promise<void> {
			if (closed || !handle) {
				return;
			}
			closed = true;
			if (!failed) {
				await settleDrain();
			}
			try {
				await handle.close(finalMessage);
			} catch {
				notice();
			}
		},
		get failed(): boolean {
			return failed;
		},
		get overflowed(): boolean {
			return overflowed;
		},
	};
}

/**
 * Open a host log for a command that is being detached, or report that no log
 * exists. A rejected `open` is not an error to swallow silently — the caller
 * must fall back to wording that claims nothing about a file.
 */
export async function openDetachedCommandLog(
	sink: DetachedCommandLogSink,
	input: {
		command: string;
		initialOutput: string;
		truncated: boolean;
	},
): Promise<DetachedCommandLogHandle | undefined> {
	try {
		return await sink.open(input);
	} catch {
		return undefined;
	}
}

/**
 * Result text for a command that timed out and was detached.
 *
 * Every clause is verifiable at the moment the tool returns. There is
 * deliberately no forward guarantee about later output: the model cannot be
 * told about a recording failure after the fact, so promising completeness
 * would be a claim this channel is unable to keep or withdraw.
 */
export function formatTimeoutDetachResult(input: {
	logPath?: string;
	output: string;
	truncated: boolean;
}): string {
	const lines = [
		"This command is still running. The tool stopped waiting for it after the timeout.",
		input.logPath
			? `Output produced up to this point has been written to ${input.logPath}. Further output may continue to be appended to that file, which is not guaranteed.`
			: "Output could not be written to a log file, so output produced from now on is not being captured. Cancel the task to stop the command.",
	];
	if (input.truncated) {
		lines.push(
			"Note: output from before the timeout was already truncated to fit its budget, so this log does not contain everything the command has printed.",
		);
	}
	lines.push(
		input.output.length > 0
			? `Output so far:\n${input.output}`
			: "No output was produced before the timeout.",
	);
	return lines.join("\n");
}
