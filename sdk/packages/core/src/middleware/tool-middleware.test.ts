import { describe, expect, it, vi } from "vitest";
import { createApprovalMiddleware } from "./approval-middleware";
import {
	BUDGET_EXCEEDED_REASON,
	createBudgetMiddleware,
	isBudgetExceededDenial,
	isToolDenial,
} from "./budget-middleware";
import { createRedactionMiddleware } from "./redaction-middleware";
import { createRetryMiddleware } from "./retry-middleware";
import {
	composeToolMiddleware,
	type ToolMiddleware,
	type ToolMiddlewareContext,
} from "./tool-middleware";

const context: ToolMiddlewareContext = {
	toolName: "read_file",
	toolCallId: "call-1",
	iteration: 1,
	sessionId: "s1",
	agentId: "a1",
	input: { path: "x.txt" },
	policy: { enabled: true, autoApprove: true },
};

describe("composeToolMiddleware", () => {
	it("runs first-registered middleware outermost", async () => {
		const calls: string[] = [];
		const make = (name: string): ToolMiddleware => ({
			name,
			async wrap(execute) {
				calls.push(`${name}:before`);
				const result = await execute();
				calls.push(`${name}:after`);
				return result;
			},
		});
		const chain = composeToolMiddleware([make("a"), make("b"), make("c")]);
		const result = await chain(async () => {
			calls.push("execute");
			return "ok";
		}, context);
		expect(result).toBe("ok");
		expect(calls).toEqual([
			"a:before",
			"b:before",
			"c:before",
			"execute",
			"c:after",
			"b:after",
			"a:after",
		]);
	});

	it("throws when a middleware is registered twice", () => {
		const middleware: ToolMiddleware = {
			name: "dup",
			async wrap(execute) {
				return execute();
			},
		};
		expect(() => composeToolMiddleware([middleware, middleware])).toThrow(
			"duplicate middleware: dup",
		);
	});

	it("passes through untouched when no middlewares are registered", async () => {
		const chain = composeToolMiddleware([]);
		await expect(chain(async () => 42, context)).resolves.toBe(42);
	});
});

describe("createRetryMiddleware", () => {
	it("retries transient failures with injected backoff and succeeds", async () => {
		const sleep = vi.fn(async (_ms: number) => {});
		let attempts = 0;
		const chain = composeToolMiddleware([
			createRetryMiddleware({ maxRetries: 2, backoffMs: 50, sleep }),
		]);
		const result = await chain(async () => {
			attempts += 1;
			if (attempts < 3) {
				throw new Error("transient");
			}
			return "recovered";
		}, context);
		expect(result).toBe("recovered");
		expect(attempts).toBe(3);
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(sleep.mock.calls[0][0]).toBe(50);
		expect(sleep.mock.calls[1][0]).toBe(100);
	});

	it("rethrows the last failure after exhausting retries", async () => {
		const chain = composeToolMiddleware([
			createRetryMiddleware({
				maxRetries: 1,
				backoffMs: 0,
				sleep: async () => {},
			}),
		]);
		let attempts = 0;
		await expect(
			chain(async () => {
				attempts += 1;
				throw new Error("permanent");
			}, context),
		).rejects.toThrow("permanent");
		expect(attempts).toBe(2);
	});

	it("respects the retryOn predicate", async () => {
		const chain = composeToolMiddleware([
			createRetryMiddleware({
				maxRetries: 3,
				backoffMs: 0,
				sleep: async () => {},
				retryOn: (error) => (error as Error).message === "retryable",
			}),
		]);
		let attempts = 0;
		await expect(
			chain(async () => {
				attempts += 1;
				throw new Error("non-retryable");
			}, context),
		).rejects.toThrow("non-retryable");
		expect(attempts).toBe(1);
	});
});

describe("createBudgetMiddleware", () => {
	it("allows calls under budget and denies once exhausted", async () => {
		const budget = createBudgetMiddleware({ maxToolCalls: 2 });
		const chain = composeToolMiddleware([budget]);
		await expect(chain(async () => "one", context)).resolves.toBe("one");
		await expect(chain(async () => "two", context)).resolves.toBe("two");
		const denial = await chain(async () => "three", context);
		expect(isBudgetExceededDenial(denial)).toBe(true);
		if (!isBudgetExceededDenial(denial)) {
			throw new Error("expected denial");
		}
		expect(isBudgetExceededDenial(denial)).toBe(true);
		if (!isBudgetExceededDenial(denial)) {
			throw new Error("expected denial");
		}
		expect(denial.reason).toBe(BUDGET_EXCEEDED_REASON);
		expect(denial.limit).toBe(2);
		expect(denial.spent).toBe(2);
	});

	it("reset clears the spent counter", async () => {
		const budget = createBudgetMiddleware({ maxToolCalls: 1 });
		const chain = composeToolMiddleware([budget]);
		await chain(async () => "first", context);
		expect(isToolDenial(await chain(async () => "second", context))).toBe(true);
		budget.reset?.();
		await expect(chain(async () => "third", context)).resolves.toBe("third");
	});
});

describe("createRedactionMiddleware", () => {
	const middleware = createRedactionMiddleware();

	it("scrubs secrets from string results", async () => {
		const chain = composeToolMiddleware([middleware]);
		const result = await chain(
			async () =>
				"contact ops@example.com or use Bearer abc123secret and key sk-verysecret99",
			context,
		);
		expect(result).not.toContain("ops@example.com");
		expect(result).not.toContain("abc123secret");
		expect(result).not.toContain("sk-verysecret99");
		expect(result).toContain("[REDACTED]");
	});

	it("scrubs string fields inside object results without touching other types", async () => {
		const chain = composeToolMiddleware([middleware]);
		const result = (await chain(
			async () => ({
				note: "email: dev@example.com",
				count: 3,
				flag: true,
				nested: { secret: "ghp_abcdefghijklmnopqrst" },
				items: ["AKIAIOSFODNN7EXAMPLE", 7],
			}),
			context,
		)) as Record<string, unknown>;
		expect(result.note).not.toContain("dev@example.com");
		expect(result.count).toBe(3);
		expect(result.flag).toBe(true);
		const nested = result.nested as { secret: string };
		expect(nested.secret).not.toContain("ghp_");
		expect((result.items as unknown[])[1]).toBe(7);
	});

	it("passes non-string payloads through untouched", async () => {
		const chain = composeToolMiddleware([middleware]);
		const payload = { buffer: Buffer.from("ops@example.com") };
		const result = (await chain(async () => payload, context)) as {
			buffer: Buffer;
		};
		expect(result.buffer.toString()).toContain("ops@example.com");
	});
});

describe("createApprovalMiddleware", () => {
	const makeOptions = (approved: boolean, reason?: string) => ({
		requestApproval: vi.fn(async () => ({ approved, reason })),
		buildRequest: (ctx: ToolMiddlewareContext) => ({
			sessionId: ctx.sessionId ?? "",
			agentId: ctx.agentId ?? "",
			conversationId: ctx.conversationId ?? "",
			iteration: ctx.iteration,
			toolCallId: ctx.toolCallId,
			toolName: ctx.toolName,
			input: ctx.input,
			policy: { enabled: true, autoApprove: false },
		}),
	});

	it("asks the host for approval-required tools and executes when approved", async () => {
		const options = makeOptions(true);
		const chain = composeToolMiddleware([createApprovalMiddleware(options)]);
		const result = await chain(async () => "executed", {
			...context,
			policy: { enabled: true, autoApprove: false },
		});
		expect(result).toBe("executed");
		expect(options.requestApproval).toHaveBeenCalledTimes(1);
	});

	it("returns a structured denial instead of executing a rejected call", async () => {
		const options = makeOptions(false, "policy: production writes");
		const chain = composeToolMiddleware([createApprovalMiddleware(options)]);
		const result = await chain(async () => "should not run", {
			...context,
			policy: { enabled: true, autoApprove: false },
		});
		expect(isToolDenial(result)).toBe(true);
		if (isToolDenial(result)) {
			expect(result.reason).toBe("policy: production writes");
		}
	});

	it("passes approval-free tools through without asking", async () => {
		const options = makeOptions(false);
		const chain = composeToolMiddleware([createApprovalMiddleware(options)]);
		const result = await chain(async () => "auto", context);
		expect(result).toBe("auto");
		expect(options.requestApproval).not.toHaveBeenCalled();
	});
});

describe("full chain composition", () => {
	it("approval -> budget -> retry -> redaction, in order", async () => {
		const calls: string[] = [];
		const tracer: ToolMiddleware = {
			name: "tracer",
			async wrap(execute, ctx) {
				calls.push(ctx.toolCallId);
				return execute();
			},
		};
		const approval = createApprovalMiddleware({
			requestApproval: async () => ({ approved: true }),
			buildRequest: () => ({
				sessionId: "s",
				agentId: "a",
				conversationId: "c",
				iteration: 1,
				toolCallId: "call-1",
				toolName: "read_file",
				input: null,
				policy: { enabled: true, autoApprove: false },
			}),
		});
		const budget = createBudgetMiddleware({ maxToolCalls: 5 });
		const retry = createRetryMiddleware({
			maxRetries: 1,
			backoffMs: 0,
			sleep: async () => {},
		});
		const chain = composeToolMiddleware([
			approval,
			tracer,
			budget,
			retry,
			createRedactionMiddleware(),
		]);
		let attempts = 0;
		const result = await chain(
			async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("transient");
				}
				return "write to admin@example.com";
			},
			{ ...context, policy: { enabled: true, autoApprove: false } },
		);
		expect(attempts).toBe(2);
		expect(calls).toEqual(["call-1"]);
		expect(result).not.toContain("admin@example.com");
	});
});
