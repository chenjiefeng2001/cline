import { mkdtempSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolContext,
	AgentToolNotice,
	DetachedCommandLogSink,
} from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createShellExecutor } from "./bash";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return true;
		}
		await sleep(20);
	}
	return predicate();
}

const LINE_COUNT = 20;
const LINE_INTERVAL_MS = 40;
const SCRIPT_DURATION_MS = LINE_COUNT * LINE_INTERVAL_MS;

let workDir: string;
let markerPath: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "cline-detach-"));
	markerPath = join(workDir, "survived.txt");
});

afterEach(async () => {
	// A detached command may still be releasing its last file handle when the
	// test ends, and Windows refuses the delete until it does. Retry briefly,
	// then leave the directory to the OS: failing a test over a temp directory
	// would report a product defect that does not exist.
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			rmSync(workDir, { recursive: true, force: true });
			return;
		} catch {
			await sleep(50);
		}
	}
});

/**
 * Emits a numbered sequence, then records that it ran to completion. The
 * marker is the only reliable evidence of whether the process was killed, so
 * every lifecycle assertion below is built on it rather than on internals.
 */
function markerCommand() {
	const script = `
		const fs = require("fs");
		let i = 0;
		const id = setInterval(() => {
			process.stdout.write("line-" + (++i) + "\\n");
			if (i >= ${LINE_COUNT}) {
				clearInterval(id);
				fs.writeFileSync(${JSON.stringify(markerPath)}, "completed");
			}
		}, ${LINE_INTERVAL_MS});
	`;
	return { command: process.execPath, args: ["-e", script] };
}

interface TestSink {
	sink: DetachedCommandLogSink;
	writes: string[];
	notices: AgentToolNotice[];
	opens: number;
	closes: number;
}

function createTestSink(
	options: { openDelayMs?: number; failOpen?: boolean; failWrite?: boolean } = {},
): TestSink {
	const writes: string[] = [];
	const notices: AgentToolNotice[] = [];
	const state = { opens: 0, closes: 0 };
	return {
		sink: {
			open: async ({ initialOutput }) => {
				state.opens += 1;
				if (options.openDelayMs) {
					// Output keeps arriving for the whole of this window.
					await sleep(options.openDelayMs);
				}
				if (options.failOpen) {
					throw new Error("cannot create log file");
				}
				void initialOutput;
				return {
					path: "/virtual/detached.log",
					write: (chunk: string) => {
						if (options.failWrite) {
							throw new Error("EIO");
						}
						writes.push(chunk);
					},
					close: () => {
						state.closes += 1;
					},
				};
			},
		},
		writes,
		notices,
		get opens() {
			return state.opens;
		},
		get closes() {
			return state.closes;
		},
	};
}

function contextWith(
	overrides: Partial<AgentToolContext>,
): AgentToolContext {
	return {
		agentId: "test-agent",
		iteration: 1,
		...overrides,
	} as AgentToolContext;
}

describe("shell timeout detach", () => {
	it("detaches on timeout without killing the command", async () => {
		const test = createTestSink({ openDelayMs: 250 });
		const executor = createShellExecutor({ timeoutMs: 200 });

		const result = await executor(
			markerCommand(),
			workDir,
			contextWith({
				detachedCommandLog: test.sink,
				emitNotice: (notice) => test.notices.push(notice),
			}),
		);

		expect(result).toContain("still running");
		expect(result).toContain("stopped waiting");
		expect(result).toContain("/virtual/detached.log");
		expect(result).toContain("not guaranteed");

		// Proof the process tree was never terminated: it ran to completion
		// well after the tool stopped waiting.
		expect(await waitFor(() => existsSync(markerPath))).toBe(true);
	}, 15000);

	it("records output produced during a delayed open, in order and without gaps", async () => {
		const test = createTestSink({ openDelayMs: 250 });
		const executor = createShellExecutor({ timeoutMs: 200 });

		await executor(
			markerCommand(),
			workDir,
			contextWith({ detachedCommandLog: test.sink }),
		);
		expect(await waitFor(() => existsSync(markerPath))).toBe(true);
		await sleep(50);

		const log = test.writes.join("");
		const found = log.match(/line-\d+/g) ?? [];

		// Starts at line-1 and each subsequent entry is exactly one higher:
		// that single assertion covers ordering, gaps and duplicates at once.
		// A fixed expected count would instead be a race — how many lines land
		// before the timeout depends on spawn latency under load.
		expect(found.length).toBeGreaterThan(LINE_COUNT / 2);
		found.forEach((line, index) => {
			expect(line).toBe(`line-${index + 1}`);
		});
	}, 15000);

	it("closes a successfully opened handle exactly once", async () => {
		const test = createTestSink();
		const executor = createShellExecutor({ timeoutMs: 200 });

		await executor(
			markerCommand(),
			workDir,
			contextWith({ detachedCommandLog: test.sink }),
		);
		expect(await waitFor(() => existsSync(markerPath))).toBe(true);
		expect(await waitFor(() => test.closes === 1)).toBe(true);
		expect(test.opens).toBe(1);
		expect(test.closes).toBe(1);
	}, 15000);

	it("tells the user when recording stops after the result was returned", async () => {
		const test = createTestSink({ failWrite: true });
		const executor = createShellExecutor({ timeoutMs: 200 });

		const result = await executor(
			markerCommand(),
			workDir,
			contextWith({
				detachedCommandLog: test.sink,
				emitNotice: (notice) => test.notices.push(notice),
			}),
		);

		// The result itself still promised a log, which is why the failure has
		// to be reported rather than swallowed.
		expect(result).toContain("/virtual/detached.log");
		expect(
			await waitFor(() => test.notices.some((n) => n.reason === "detached_output_log_failed")),
		).toBe(true);
		expect(test.notices[0].noticeType).toBe("status");

		// A failed log is not a reason to kill the command.
		expect(await waitFor(() => existsSync(markerPath))).toBe(true);
	}, 15000);

	it("quotes no path when the log cannot be created", async () => {
		const test = createTestSink({ failOpen: true });
		const executor = createShellExecutor({ timeoutMs: 200 });

		const result = await executor(
			markerCommand(),
			workDir,
			contextWith({ detachedCommandLog: test.sink }),
		);

		expect(result).toContain("still running");
		expect(result).toContain("not being captured");
		expect(result).not.toContain("/virtual/detached.log");
		expect(test.opens).toBe(1);
		expect(test.closes).toBe(0);

		expect(await waitFor(() => existsSync(markerPath))).toBe(true);
	}, 15000);

	it("kills on cancel, which is not a timeout", async () => {
		const test = createTestSink();
		const executor = createShellExecutor({ timeoutMs: 10_000 });
		const controller = new AbortController();

		const pending = executor(
			markerCommand(),
			workDir,
			contextWith({
				detachedCommandLog: test.sink,
				signal: controller.signal,
			}),
		);
		await sleep(80);
		controller.abort();

		await expect(pending).rejects.toThrow(/aborted/i);
		expect(test.opens).toBe(0);

		// The cancel path terminated the process, unlike the timeout path.
		await sleep(SCRIPT_DURATION_MS + 300);
		expect(existsSync(markerPath)).toBe(false);
	}, 15000);

	it("keeps the existing timeout behaviour when no sink is provided", async () => {
		const executor = createShellExecutor({ timeoutMs: 200 });

		await expect(
			executor(markerCommand(), workDir, contextWith({})),
		).rejects.toThrow(/timed out/i);

		await sleep(SCRIPT_DURATION_MS + 300);
		expect(existsSync(markerPath)).toBe(false);
	}, 15000);

	it("returns normal output when the command finishes before the timeout", async () => {
		const test = createTestSink();
		const executor = createShellExecutor({ timeoutMs: 20_000 });

		const result = await executor(
			{ command: process.execPath, args: ["-e", "console.log('done')"] },
			workDir,
			contextWith({ detachedCommandLog: test.sink }),
		);

		expect(result).toContain("done");
		expect(test.opens).toBe(0);
	}, 15000);
});
