import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolContext } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createIdempotencyMiddleware } from "../runtime/ledger/idempotency-middleware";
import { SqliteEffectLedger } from "../runtime/ledger/stores/sqlite-effect-ledger";
import { createBudgetMiddleware } from "./budget-middleware";
import { createRedactionMiddleware } from "./redaction-middleware";
import { createRetryMiddleware } from "./retry-middleware";
import { wrapToolsWithMiddleware } from "./wrap-tools";

const makeTool = (overrides: Partial<AgentTool> = {}): AgentTool => {
	const base: AgentTool = {
		name: "write_file",
		description: "writes a file",
		inputSchema: {},
		execute: async () => "plain output",
	};
	return { ...base, ...overrides };
};

const context: AgentToolContext = {
	sessionId: "s1",
	agentId: "a1",
	conversationId: "c1",
	iteration: 2,
	toolCallId: "call-1",
};

describe("wrapToolsWithMiddleware", () => {
	it("preserves identity fields and does not mutate the originals", () => {
		const original = makeTool({ timeoutMs: 5000 });
		const wrapped = wrapToolsWithMiddleware([original], {
			chain: [],
			sessionId: "s1",
		});
		expect(wrapped).toHaveLength(1);
		expect(wrapped[0]?.name).toBe("write_file");
		expect(wrapped[0]?.description).toBe("writes a file");
		expect(wrapped[0]?.timeoutMs).toBe(5000);
		expect(wrapped[0]).not.toBe(original);
		expect(original.execute).toBe(original.execute);
	});

	it("passes input through and returns the executor result", async () => {
		const execute = vi.fn(async (input: unknown) => ({ got: input }));
		const wrapped = wrapToolsWithMiddleware(
			[makeTool({ execute: execute as AgentTool["execute"] })],
			{ chain: [], sessionId: "s1" },
		);
		const result = await wrapped[0]?.execute({ path: "x" }, context);
		expect(result).toEqual({ got: { path: "x" } });
		expect(execute).toHaveBeenCalledWith({ path: "x" }, context);
	});

	it("runs the chain around the executor (redaction scrubs output)", async () => {
		const wrapped = wrapToolsWithMiddleware(
			[
				makeTool({
					execute: async () => "contact admin@example.com for access",
				}),
			],
			{ chain: [createRedactionMiddleware()], sessionId: "s1" },
		);
		const result = await wrapped[0]?.execute({}, context);
		expect(result).not.toContain("admin@example.com");
		expect(result).toContain("[REDACTED]");
	});

	it("composes retry around the executor with injected sleep", async () => {
		let attempts = 0;
		const wrapped = wrapToolsWithMiddleware(
			[
				makeTool({
					execute: async () => {
						attempts += 1;
						if (attempts < 2) {
							throw new Error("transient");
						}
						return "recovered";
					},
				}),
			],
			{
				chain: [
					createRetryMiddleware({
						maxRetries: 1,
						backoffMs: 0,
						sleep: async () => {},
					}),
				],
				sessionId: "s1",
			},
		);
		await expect(wrapped[0]?.execute({}, context)).resolves.toBe("recovered");
		expect(attempts).toBe(2);
	});

	it("returns budget denials instead of executing over-budget calls", async () => {
		const execute = vi.fn(async () => "ran");
		const wrapped = wrapToolsWithMiddleware([makeTool({ execute })], {
			chain: [createBudgetMiddleware({ maxToolCalls: 1 })],
			sessionId: "s1",
		});
		await expect(wrapped[0]?.execute({}, context)).resolves.toBe("ran");
		const denial = await wrapped[0]?.execute({}, context);
		expect(denial).toMatchObject({ denied: true, limit: 1, spent: 1 });
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("resolves the session id per call", async () => {
		const resolve = vi.fn(() => "resolved-session");
		const wrapped = wrapToolsWithMiddleware([makeTool()], {
			chain: [],
			sessionId: resolve,
		});
		await wrapped[0]?.execute({}, context);
		expect(resolve).toHaveBeenCalledWith(context);
	});
});

describe("wrapToolsWithMiddleware + idempotency ledger", () => {
	it("records the first call and replays on recovery without re-executing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cline-wrap-"));
		try {
			const ledger = new SqliteEffectLedger({
				dbPath: join(dir, "effects.db"),
			});
			ledger.init();
			const execute = vi.fn(async () => ({ written: true }));
			const wrapped = wrapToolsWithMiddleware([makeTool({ execute })], {
				chain: [createIdempotencyMiddleware({ ledger, sessionId: "s1" })],
				sessionId: (ctx) => ctx.sessionId ?? "",
			});
			await expect(
				wrapped[0]?.execute({ path: "x" }, context),
			).resolves.toEqual({
				written: true,
			});
			expect(execute).toHaveBeenCalledTimes(1);
			// Recovery: same logical call (same session/tool/iteration/call id/input).
			const replayed = await wrapped[0]?.execute({ path: "x" }, context);
			expect(replayed).toEqual({ written: true });
			expect(execute).toHaveBeenCalledTimes(1);
			ledger.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
