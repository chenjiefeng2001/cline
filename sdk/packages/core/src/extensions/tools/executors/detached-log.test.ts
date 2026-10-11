import { describe, expect, it, vi } from "vitest";
import type {
	DetachedCommandLogHandle,
	DetachedCommandLogSink,
} from "@cline/shared";
import { createRollingCollector } from "./bash";
import {
	createDetachedLogWriter,
	DETACHED_OUTPUT_LOG_FAILED_NOTICE,
	formatTimeoutDetachResult,
	openDetachedCommandLog,
} from "./detached-log";

/** Records every write with its arrival order and detects overlap. */
function createRecordingHandle(path = "/tmp/detached.log") {
	const chunks: string[] = [];
	let inFlight = 0;
	let maxConcurrent = 0;
	let closed = 0;
	const handle: DetachedCommandLogHandle = {
		path,
		write: async (chunk: string) => {
			inFlight += 1;
			maxConcurrent = Math.max(maxConcurrent, inFlight);
			// Yield so any second write would overlap if the loop allowed it.
			await new Promise((resolve) => setTimeout(resolve, 0));
			chunks.push(chunk);
			inFlight -= 1;
		},
		close: () => {
			closed += 1;
		},
	};
	return {
		handle,
		chunks,
		get maxConcurrent() {
			return maxConcurrent;
		},
		get closeCount() {
			return closed;
		},
		text: () => chunks.join(""),
	};
}

describe("detached output handover", () => {
	describe("collector.detachTo", () => {
		it("loses and duplicates nothing across the handover boundary", () => {
			const collector = createRollingCollector(1_000_000);
			const before = ["line-1\n", "line-2\n", "line-3\n"];
			const during = ["line-4\n", "line-5\n", "line-6\n"];
			const after = ["line-7\n", "line-8\n"];

			for (const chunk of before) {
				collector.append(Buffer.from(chunk));
			}

			// Everything the sink produces while open() is still pending lands
			// here — this is the window the old snapshot-then-open ordering lost.
			const forwarded: string[] = [];
			const snapshot = collector.detachTo((chunk) => forwarded.push(chunk));

			for (const chunk of during) {
				collector.append(Buffer.from(chunk));
			}

			const log = snapshot.text + forwarded.join("");

			expect(log).toBe([...before, ...during].join(""));
			expect(forwarded).toEqual(during);

			for (const chunk of after) {
				collector.append(Buffer.from(chunk));
			}

			const full = snapshot.text + forwarded.join("");
			expect(full).toBe([...before, ...during, ...after].join(""));
			// Every line appears exactly once.
			const counts = new Map<string, number>();
			for (const line of full.split("\n").filter(Boolean)) {
				counts.set(line, (counts.get(line) ?? 0) + 1);
			}
			expect([...counts.values()].every((n) => n === 1)).toBe(true);
		});

		it("reports truncation of pre-detach output rather than hiding it", () => {
			const collector = createRollingCollector(64);
			collector.append(Buffer.from("a".repeat(200)));
			const snapshot = collector.detachTo(() => {});
			expect(snapshot.dropped).toBe(true);
		});
	});

	describe("writer", () => {
		it("writes with a concurrency of exactly one", async () => {
			const recorder = createRecordingHandle();
			const writer = createDetachedLogWriter();
			for (let i = 0; i < 25; i += 1) {
				writer.enqueue(`chunk-${i};`);
			}
			await writer.attach(recorder.handle);
			await writer.finish("[done]");

			expect(recorder.maxConcurrent).toBe(1);
			expect(recorder.text()).toBe(
				Array.from({ length: 25 }, (_, i) => `chunk-${i};`).join(""),
			);
			expect(recorder.closeCount).toBe(1);
		});

		it("preserves arrival order across the attach boundary", async () => {
			const recorder = createRecordingHandle();
			const writer = createDetachedLogWriter();
			// Queued before a handle exists, exactly as output produced during
			// an async open() would be.
			writer.enqueue("snapshot;");
			writer.enqueue("during-open-1;");
			writer.enqueue("during-open-2;");
			await writer.attach(recorder.handle);
			writer.enqueue("after-attach;");
			await writer.finish("[done]");

			expect(recorder.text()).toBe(
				"snapshot;during-open-1;during-open-2;after-attach;",
			);
		});

		it("closes a handle exactly once", async () => {
			const recorder = createRecordingHandle();
			const writer = createDetachedLogWriter();
			writer.enqueue("x;");
			await writer.attach(recorder.handle);
			await writer.finish("[first]");
			await writer.finish("[second]");
			expect(recorder.closeCount).toBe(1);
		});

		it("does not close a handle that was never opened", async () => {
			const recorder = createRecordingHandle();
			const writer = createDetachedLogWriter();
			writer.enqueue("x;");
			await writer.finish("[done]");
			expect(recorder.closeCount).toBe(0);
		});

		it("discloses pending overflow instead of dropping it silently", async () => {
			const emitNotice = vi.fn();
			const recorder = createRecordingHandle();
			const writer = createDetachedLogWriter({
				emitNotice,
				pendingLimitChars: 10,
			});
			writer.enqueue("x".repeat(50));
			expect(writer.overflowed).toBe(true);

			await writer.attach(recorder.handle);
			expect(emitNotice).toHaveBeenCalledWith(
				DETACHED_OUTPUT_LOG_FAILED_NOTICE,
			);
		});

		it("treats a throwing write as permanent and tells the user once", async () => {
			const emitNotice = vi.fn();
			let closeCount = 0;
			const writer = createDetachedLogWriter({ emitNotice });
			writer.enqueue("before;");
			await writer.attach({
				path: "/tmp/detached.log",
				write: () => {
					throw new Error("disk full");
				},
				close: () => {
					closeCount += 1;
				},
			});
			writer.enqueue("after-failure;");

			expect(writer.failed).toBe(true);
			expect(emitNotice).toHaveBeenCalledTimes(1);
			expect(emitNotice).toHaveBeenCalledWith(
				DETACHED_OUTPUT_LOG_FAILED_NOTICE,
			);

			// The log is still closed, so no handle and no temp file leak.
			await writer.finish("[done]");
			expect(closeCount).toBe(1);
		});

		it("treats a rejected async write as permanent", async () => {
			const emitNotice = vi.fn();
			const writer = createDetachedLogWriter({ emitNotice });
			writer.enqueue("before;");
			await writer.attach({
				path: "/tmp/detached.log",
				write: async () => {
					await Promise.resolve();
					throw new Error("EIO");
				},
				close: () => {},
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(writer.failed).toBe(true);
			expect(emitNotice).toHaveBeenCalledTimes(1);
		});
	});

	describe("openDetachedCommandLog", () => {
		it("reports failure instead of inventing a path", async () => {
			const sink: DetachedCommandLogSink = {
				open: () => {
					throw new Error("no space left on device");
				},
			};
			const handle = await openDetachedCommandLog(sink, {
				command: "sleep 100",
				initialOutput: "partial",
				truncated: false,
			});
			expect(handle).toBeUndefined();
		});
	});

	describe("formatTimeoutDetachResult", () => {
		it("makes no forward guarantee about later output", () => {
			const text = formatTimeoutDetachResult({
				logPath: "/tmp/run.log",
				output: "so far",
				truncated: false,
			});
			expect(text).toContain("still running");
			expect(text).toContain("stopped waiting");
			expect(text).toContain("/tmp/run.log");
			// The claim must stay true even if recording later dies.
			expect(text).toContain("not guaranteed");
			expect(text).not.toMatch(/will be (recorded|captured|written)/i);
		});

		it("quotes no path when no log exists", () => {
			const text = formatTimeoutDetachResult({
				output: "so far",
				truncated: false,
			});
			expect(text).toContain("still running");
			expect(text).toContain("not being captured");
			expect(text).not.toMatch(/\/tmp\/|\.log\b/);
		});

		it("discloses pre-timeout truncation", () => {
			const text = formatTimeoutDetachResult({
				logPath: "/tmp/run.log",
				output: "",
				truncated: true,
			});
			expect(text).toContain("truncated");
		});
	});
});
