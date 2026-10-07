/**
 * Session-scoped registry for backgrounded sub-agent runs.
 *
 * `spawn_agent` has exactly one result channel today: the blocking return value,
 * so the child's text, finish reason and token usage reach the parent only as a
 * tool result in the same turn. That is why backgrounding it without a registry
 * would be fire-and-forget — the work would finish somewhere nobody can read,
 * spending tokens invisibly.
 *
 * This is that missing piece. It is deliberately a plain per-session map rather
 * than a reuse of `AgentTeamsRuntime.runs`: that registry is gated on
 * `enableAgentTeams`, and every one of its paths assumes a live member with
 * `role: "teammate"`. A plain sub-agent would also emit `RunQueued`, which
 * `trackTeamRunState` folds into the team completion guard's accounting.
 *
 * Records live for the session, not the run, so a later turn can read a result
 * the run that started it has already finished.
 */

export type SubAgentRunStatus = "running" | "completed" | "failed";

export interface SubAgentRunRecord {
	runId: string;
	/** Sub-agent id, which is also the durable sub-session key. */
	subAgentId: string;
	conversationId: string;
	/** Short caller-supplied label, used in status output. */
	label: string;
	task: string;
	status: SubAgentRunStatus;
	startedAt: number;
	completedAt?: number;
	/** Child's final text. Truncated on read so a long result cannot flood a turn. */
	resultText?: string;
	error?: string;
	finishReason?: string;
	iterations?: number;
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

/**
 * Caps how much of a child's output is carried. A sub-agent that wrote a long
 * report would otherwise push the parent's next turn over its own budget, which
 * trades one context problem for another.
 */
const MAX_RESULT_CHARS = 4000;

let runCounter = 0;

export class SubAgentRunRegistry {
	private readonly runs = new Map<string, SubAgentRunRecord>();
	private readonly waiters = new Set<() => void>();

	/** Next id for this registry. Monotonic and session-scoped. */
	private nextRunId(): string {
		runCounter += 1;
		return `subrun_${runCounter.toString().padStart(5, "0")}`;
	}

	start(params: {
		subAgentId: string;
		conversationId: string;
		label: string;
		task: string;
	}): SubAgentRunRecord {
		const record: SubAgentRunRecord = {
			runId: this.nextRunId(),
			...params,
			status: "running",
			startedAt: Date.now(),
		};
		this.runs.set(record.runId, record);
		return record;
	}

	complete(
		runId: string,
		result: {
			text?: string;
			finishReason?: string;
			iterations?: number;
			usage?: { inputTokens: number; outputTokens: number };
		},
	): void {
		const record = this.runs.get(runId);
		if (!record) {
			return;
		}
		record.status = "completed";
		record.completedAt = Date.now();
		record.finishReason = result.finishReason;
		record.iterations = result.iterations;
		record.usage = result.usage;
		const text = result.text?.trim();
		record.resultText = text
			? text.length > MAX_RESULT_CHARS
				? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${text.length - MAX_RESULT_CHARS} chars]`
				: text
			: undefined;
		this.notify();
	}

	fail(runId: string, error: unknown): void {
		const record = this.runs.get(runId);
		if (!record) {
			return;
		}
		record.status = "failed";
		record.completedAt = Date.now();
		record.error = error instanceof Error ? error.message : String(error);
		this.notify();
	}

	get(runId: string): SubAgentRunRecord | undefined {
		return this.runs.get(runId);
	}

	list(): SubAgentRunRecord[] {
		return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	hasRunning(): boolean {
		return [...this.runs.values()].some((run) => run.status === "running");
	}

	/**
	 * Waits for a run to settle. Returns immediately when it is already finished,
	 * which is what lets a caller poll without special-casing the common case.
	 */
	async await(runId: string, timeoutMs?: number): Promise<SubAgentRunRecord | undefined> {
		const isSettled = () => {
			const record = this.runs.get(runId);
			return !record || record.status !== "running";
		};
		if (isSettled()) {
			return this.runs.get(runId);
		}
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onSettled = () => {
				if (isSettled()) {
					cleanup();
					resolve(this.runs.get(runId));
				}
			};
			const cleanup = () => {
				this.waiters.delete(onSettled);
				if (timer) {
					clearTimeout(timer);
				}
			};
			this.waiters.add(onSettled);
			// A timeout resolves rather than rejects: the run may legitimately still
			// be going, and the caller can read its status with a later call.
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					cleanup();
					resolve(this.runs.get(runId));
				}, timeoutMs);
			}
		});
	}

	private notify(): void {
		for (const waiter of [...this.waiters]) {
			waiter();
		}
	}

	/**
	 * Drops finished records so a long session does not accumulate every sub-agent
	 * result it has ever run. Running records are never dropped.
	 */
	pruneFinished(): number {
		let removed = 0;
		for (const [runId, record] of [...this.runs]) {
			if (record.status !== "running") {
				this.runs.delete(runId);
				removed += 1;
			}
		}
		return removed;
	}

	clear(): void {
		this.runs.clear();
		this.notify();
	}
}

/** Compact projection for tool output, mirroring how team runs summarise results. */
export function describeSubAgentRun(record: SubAgentRunRecord): Record<string, unknown> {
	const elapsedMs =
		(record.completedAt ?? Date.now()) - record.startedAt;
	return {
		runId: record.runId,
		label: record.label,
		status: record.status,
		subAgentId: record.subAgentId,
		elapsedMs,
		...(record.finishReason ? { finishReason: record.finishReason } : {}),
		...(record.iterations !== undefined ? { iterations: record.iterations } : {}),
		...(record.usage ? { usage: record.usage } : {}),
		...(record.error ? { error: record.error } : {}),
		...(record.resultText ? { resultText: record.resultText } : {}),
	};
}