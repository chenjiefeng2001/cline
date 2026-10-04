import type {
	AgentMessage,
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentRuntimePlugin,
	AgentTool,
	AgentToolContext,
	ITelemetryService,
} from "@cline/shared";
import { AGENT_UNEXPECTED_REASONING_TOKENS_EVENT } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime, type AgentRuntimeResumeToolCall } from "./index";

class ScriptedModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];

	constructor(
		private readonly steps: Array<
			(
				request: AgentModelRequest,
			) => Iterable<AgentModelEvent> | AsyncIterable<AgentModelEvent>
		>,
	) {}

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const step = this.steps.shift();
		if (!step) {
			throw new Error("No scripted model step available");
		}
		return toAsyncIterable(step(request));
	}
}

async function* toAsyncIterable(
	events: Iterable<AgentModelEvent> | AsyncIterable<AgentModelEvent>,
): AsyncIterable<AgentModelEvent> {
	for await (const event of events) {
		yield event;
	}
}

const createEchoTool = (): AgentTool<{ text: string }, { echoed: string }> => ({
	name: "echo",
	description: "Echo input text",
	inputSchema: { type: "object" },
	async execute(input) {
		return { echoed: input.text };
	},
});

describe("AgentRuntime", () => {
	it("completes a simple turn without tools", async () => {
		const model = new ScriptedModel([
			() => [
				{ type: "text-delta", text: "hello" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({ model });

		const result = await runtime.run("Hi");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("hello");
		expect(result.messages).toHaveLength(2);
		expect(model.requests).toHaveLength(1);
	});

	it("consumes a configured run id after the first execution", async () => {
		const model = new ScriptedModel([
			() => [
				{ type: "text-delta", text: "first" },
				{ type: "finish", reason: "stop" },
			],
			() => [
				{ type: "text-delta", text: "second" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({ model, runId: "configured-run" });

		const first = await runtime.run("First");
		const second = await runtime.continue("Second");

		expect(first.runId).toBe("configured-run");
		expect(second.runId).toMatch(/^run_/);
		expect(second.runId).not.toBe("configured-run");
	});

	it("calls afterRun before the terminal event for a completed run", async () => {
		const lifecycle: string[] = [];
		const model = new ScriptedModel([
			() => [
				{ type: "text-delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			hooks: {
				afterRun: ({ result }) => {
					lifecycle.push(`afterRun:${result.status}`);
				},
				onEvent: (event) => {
					if (event.type === "run-finished" || event.type === "run-failed") {
						lifecycle.push(`event:${event.type}`);
					}
				},
			},
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(lifecycle).toEqual(["afterRun:completed", "event:run-finished"]);
	});

	it("fails a turn that hits the model output token limit before completion", async () => {
		const logger = {
			debug: vi.fn(),
			log: vi.fn(),
			error: vi.fn(),
		};
		const model = new ScriptedModel([
			() => [
				{ type: "reasoning-delta", text: "thinking..." },
				{ type: "finish", reason: "max-tokens" },
			],
		]);
		const runtime = new AgentRuntime({ model, logger });

		const result = await runtime.run("Hi");

		expect(result.status).toBe("failed");
		expect(result.error?.message).toContain("maximum output token limit");
		expect(model.requests).toHaveLength(1);
		expect(result.messages).toHaveLength(2);
		expect(result.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "reasoning", text: "thinking..." }],
		});
		expect(logger.log).toHaveBeenCalledWith(
			"Agent loop caught error",
			expect.objectContaining({
				severity: "error",
				status: "failed",
				errorMessage: expect.stringContaining("maximum output token limit"),
				iteration: 1,
				assistantContentPartCount: 1,
			}),
		);
		expect(logger.error).toHaveBeenCalledWith(
			"Agent run failed",
			expect.objectContaining({
				error: expect.objectContaining({
					message: expect.stringContaining("maximum output token limit"),
				}),
			}),
		);
	});

	it("does not persist an empty assistant message when the model stream fails", async () => {
		const model = new ScriptedModel([
			() => [{ type: "finish", reason: "error", error: "upstream failed" }],
		]);
		const addedMessages: AgentMessage[] = [];
		const runtime = new AgentRuntime({ model });
		runtime.subscribe((event) => {
			if (event.type === "message-added") {
				addedMessages.push(event.message);
			}
		});

		const result = await runtime.run("Hi");

		expect(result.status).toBe("failed");
		expect(result.error?.message).toBe("upstream failed");
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.role).toBe("user");
		expect(addedMessages.map((message) => message.role)).toEqual(["user"]);
	});

	it("does not complete or persist history when the model returns no content", async () => {
		const model = new ScriptedModel([
			() => [{ type: "finish", reason: "stop" }],
		]);
		const runtime = new AgentRuntime({ model });

		const result = await runtime.run("Hi");

		expect(result.status).toBe("failed");
		expect(result.error?.message).toBe("Model returned empty response");
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.role).toBe("user");
	});

	it("surfaces a mid-stream auth failure even after text was emitted", async () => {
		// Regression: a 401 that arrives AFTER the stream produced text used to be
		// swallowed. `message.content` was non-empty, so the `toolCalls.length === 0`
		// guard never fired, the provider's "re-authenticate your Cline account"
		// string was returned as if the model had said it, and because nothing threw
		// the host never refreshed the token. The run silently "succeeded".
		const model = new ScriptedModel([
			() => [
				{ type: "text-delta", text: "Unauthorized: Please sign in" },
				{
					type: "finish",
					reason: "error",
					error:
						"Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account.",
				},
			],
		]);
		const runtime = new AgentRuntime({ model });

		const result = await runtime.run("Hi");

		expect(result.status).toBe("failed");
		expect(result.error?.message).toContain("re-authenticate your Cline account");
		// The decisive assertion: the run FAILED. Before this fix the same script
		// returned status "completed" with the auth string as its answer, so the
		// host's auth-retry wrapper never ran and no token refresh happened.
		expect(result.outputText).not.toContain("re-authenticate your Cline account");
	});

	it("keeps a non-auth stream error recoverable when a tool call was emitted", async () => {
		// The counterpart to the case above, and the reason the auth case cannot be
		// fixed by making every `reason: "error"` fatal: a tool-input parse error is
		// deliberately recoverable so the model can try again.
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "echo",
					inputText: '{"text":"hi"}',
				},
				{ type: "finish", reason: "error", error: "upstream hiccup" },
			],
			() => [
				{ type: "text-delta", text: "recovered" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({ model, tools: [createEchoTool()] });

		const result = await runtime.run("Hi");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("recovered");
	});

	it("calls afterRun before run-failed for a failed run", async () => {
		const lifecycle: string[] = [];
		const model = new ScriptedModel([
			() => [{ type: "finish", reason: "error", error: "upstream failed" }],
		]);
		const runtime = new AgentRuntime({
			model,
			hooks: {
				afterRun: ({ result }) => {
					lifecycle.push(`afterRun:${result.status}`);
				},
				onEvent: (event) => {
					if (event.type === "run-finished" || event.type === "run-failed") {
						lifecycle.push(`event:${event.type}`);
					}
				},
			},
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("failed");
		expect(result.error?.message).toBe("upstream failed");
		expect(lifecycle).toEqual(["afterRun:failed", "event:run-failed"]);
	});

	it("executes a tool call and continues the loop", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "echo",
					inputText: '{"text":"hi"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolMessage = request.messages.at(-1) as AgentMessage;
				expect(toolMessage.role).toBe("tool");
				return [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const execute = vi.fn(
			async (input: { text: string }, context: AgentToolContext) => ({
				echoed: input.text,
				runId: context.runId,
				stepId: context.stepId,
				toolCallIndex: context.toolCallIndex,
			}),
		);
		const tool = {
			...createEchoTool(),
			execute,
		} as AgentTool<{ text: string }, unknown>;
		const runtime = new AgentRuntime({
			model,
			tools: [tool],
			runId: "run_fixed",
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(
			result.messages.filter((message) => message.role === "tool"),
		).toHaveLength(1);
		expect(result.outputText).toBe("done");
		expect(result.runId).toBe("run_fixed");
		expect(execute).toHaveBeenCalledWith(
			{ text: "hi" },
			expect.objectContaining({
				runId: "run_fixed",
				stepId: "step:run_fixed:1:0",
				toolCallIndex: 0,
			}),
		);
	});

	it("validates tool input before execution and returns a model-visible error", async () => {
		const executeTool = vi.fn(async () => ({ ok: true }));
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_validation",
					toolName: "validated",
					inputText: '{"value":"wrong"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				expect(request.messages.at(-1)?.content[0]).toMatchObject({
					type: "tool-result",
					isError: true,
					output: {
						error: expect.stringContaining("value must be a number"),
					},
				});
				return [
					{ type: "text-delta", text: "validation recovered" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const tool: AgentTool<{ value: number }> = {
			name: "validated",
			description: "Validated tool",
			inputSchema: { type: "object" },
			validateInput: (input) => {
				const value = (input as { value?: unknown }).value;
				if (typeof value !== "number") {
					throw new Error("value must be a number");
				}
				return { value };
			},
			execute: executeTool,
		};
		const runtime = new AgentRuntime({ model, tools: [tool] });

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("validation recovered");
		expect(executeTool).not.toHaveBeenCalled();
	});

	it("times out tool execution without aborting the agent run", async () => {
		let observedAbort = false;
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_timeout",
					toolName: "slow",
					inputText: "{}",
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				expect(request.messages.at(-1)?.content[0]).toMatchObject({
					type: "tool-result",
					isError: true,
					output: {
						error: expect.stringContaining("timed out after 10ms"),
					},
				});
				return [
					{ type: "text-delta", text: "timeout recovered" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const slowTool: AgentTool = {
			name: "slow",
			description: "Slow tool",
			inputSchema: { type: "object" },
			timeoutMs: 10,
			execute: async (_input, context) =>
				new Promise((_resolve, reject) => {
					const onAbort = (): void => {
						observedAbort = true;
						reject(context.signal?.reason ?? new Error("aborted"));
					};
					if (context.signal?.aborted) {
						onAbort();
					} else {
						context.signal?.addEventListener("abort", onAbort, { once: true });
					}
				}),
		};
		const runtime = new AgentRuntime({ model, tools: [slowTool] });

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("timeout recovered");
		expect(observedAbort).toBe(true);
	});

	it("retries explicitly retryable tools with bounded backoff", async () => {
		let attempts = 0;
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_retry",
					toolName: "retryable",
					inputText: "{}",
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				expect(request.messages.at(-1)?.content[0]).toMatchObject({
					type: "tool-result",
					output: { attempts: 3 },
				});
				return [
					{ type: "text-delta", text: "retry recovered" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const retryableTool: AgentTool = {
			name: "retryable",
			description: "Retryable tool",
			inputSchema: { type: "object" },
			timeoutMs: 100,
			retryable: true,
			maxRetries: 2,
			execute: async () => {
				attempts += 1;
				if (attempts < 3) {
					throw new Error("transient failure");
				}
				return { attempts };
			},
		};
		const runtime = new AgentRuntime({
			model,
			tools: [retryableTool],
			toolRetryDelayMs: 0,
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("retry recovered");
		expect(attempts).toBe(3);
	});

	it("does not retry tools unless explicitly marked retryable", async () => {
		let attempts = 0;
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_no_retry",
					toolName: "non_retryable",
					inputText: "{}",
				},
				{ type: "finish", reason: "tool-calls" },
			],
			() => [
				{ type: "text-delta", text: "no retry" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const nonRetryableTool: AgentTool = {
			name: "non_retryable",
			description: "Non-retryable tool",
			inputSchema: { type: "object" },
			retryable: false,
			maxRetries: 3,
			execute: async () => {
				attempts += 1;
				throw new Error("permanent failure");
			},
		};
		const runtime = new AgentRuntime({ model, tools: [nonRetryableTool] });

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(attempts).toBe(1);
		expect(
			result.messages.find((message) => message.role === "tool"),
		).toMatchObject({
			content: [
				{
					isError: true,
					output: { error: "permanent failure" },
				},
			],
		});
	});

	it("waits for parallel tools and preserves every tool result after a hook failure", async () => {
		let slowFinished = false;
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_bad",
					toolName: "bad",
					inputText: "{}",
				},
				{
					type: "tool-call-delta",
					toolCallId: "call_slow",
					toolName: "slow",
					inputText: "{}",
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolMessages = request.messages.slice(-2);
				expect(toolMessages).toMatchObject([
					{
						role: "tool",
						content: [
							{
								toolCallId: "call_bad",
								isError: true,
								output: { error: "after hook failed" },
							},
						],
					},
					{
						role: "tool",
						content: [
							{
								toolCallId: "call_slow",
								output: { ok: true },
							},
						],
					},
				]);
				return [
					{ type: "text-delta", text: "parallel recovered" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			toolExecution: "parallel",
			tools: [
				{
					name: "bad",
					description: "Bad hook tool",
					inputSchema: { type: "object" },
					execute: async () => ({ ok: true }),
				},
				{
					name: "slow",
					description: "Slow successful tool",
					inputSchema: { type: "object" },
					execute: async () => {
						await new Promise((resolve) => setTimeout(resolve, 20));
						slowFinished = true;
						return { ok: true };
					},
				},
			],
			hooks: {
				afterTool: ({ tool }) => {
					if (tool.name === "bad") {
						throw new Error("after hook failed");
					}
				},
			},
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("parallel recovered");
		expect(slowFinished).toBe(true);
		expect(
			result.messages.filter((message) => message.role === "tool"),
		).toHaveLength(2);
	});

	it("limits parallel tool concurrency without reordering results", async () => {
		let active = 0;
		let maxActive = 0;
		const model = new ScriptedModel([
			() => [
				...["one", "two", "three"].map((id) => ({
					type: "tool-call-delta" as const,
					toolCallId: `call_${id}`,
					toolName: "limited",
					inputText: "{}",
				})),
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				expect(request.messages.slice(-3)).toMatchObject([
					{ content: [{ toolCallId: "call_one" }] },
					{ content: [{ toolCallId: "call_two" }] },
					{ content: [{ toolCallId: "call_three" }] },
				]);
				return [
					{ type: "text-delta", text: "limited" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			toolExecution: "parallel",
			maxParallelToolCalls: 2,
			tools: [
				{
					name: "limited",
					description: "Concurrency-limited tool",
					inputSchema: { type: "object" },
					// Opt in, or the exclusive default runs it alone and the cap is
					// never exercised.
					concurrency: "safe",
					execute: async () => {
						active += 1;
						maxActive = Math.max(maxActive, active);
						await new Promise((resolve) => setTimeout(resolve, 15));
						active -= 1;
						return { ok: true };
					},
				},
			],
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(maxActive).toBe(2);
		expect(
			result.messages.filter((message) => message.role === "tool"),
		).toHaveLength(3);
	});

	it("settles every tool in a terminal batch before completing the run", async () => {
		let regularFinished = false;
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_terminal",
					toolName: "finish",
					inputText: "{}",
				},
				{
					type: "tool-call-delta",
					toolCallId: "call_regular",
					toolName: "regular",
					inputText: "{}",
				},
				{ type: "finish", reason: "tool-calls" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			toolExecution: "parallel",
			tools: [
				{
					name: "finish",
					description: "Terminal tool",
					inputSchema: { type: "object" },
					lifecycle: { completesRun: true },
					execute: async () => "finished",
				},
				{
					name: "regular",
					description: "Regular batch tool",
					inputSchema: { type: "object" },
					execute: async () => {
						await new Promise((resolve) => setTimeout(resolve, 20));
						regularFinished = true;
						return { ok: true };
					},
				},
			],
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.iterations).toBe(1);
		expect(result.outputText).toBe("finished");
		expect(regularFinished).toBe(true);
		expect(
			result.messages.filter((message) => message.role === "tool"),
		).toHaveLength(2);
	});

	it("injects a pending user message after tool results and before the next model request", async () => {
		const consumePendingUserMessage = vi.fn(() => "steer now");
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "echo",
					inputText: '{"text":"hi"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const assistantMessage = request.messages.at(-3);
				const toolMessage = request.messages.at(-2);
				const steerMessage = request.messages.at(-1);
				expect(assistantMessage?.role).toBe("assistant");
				expect(
					assistantMessage?.content.some((part) => part.type === "tool-call"),
				).toBe(true);
				expect(toolMessage?.role).toBe("tool");
				expect(toolMessage?.content).toEqual([
					expect.objectContaining({
						type: "tool-result",
						toolCallId: "call_1",
					}),
				]);
				expect(steerMessage).toMatchObject({
					role: "user",
					content: [{ type: "text", text: "steer now" }],
				});
				return [
					{ type: "text-delta", text: "steered done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const addedMessages: AgentMessage[] = [];
		const runtime = new AgentRuntime({
			model,
			tools: [createEchoTool()],
			consumePendingUserMessage,
		});
		runtime.subscribe((event) => {
			if (event.type === "message-added") {
				addedMessages.push(event.message);
			}
		});

		const result = await runtime.run("Start");

		expect(consumePendingUserMessage).toHaveBeenCalledTimes(1);
		expect(model.requests).toHaveLength(2);
		expect(result.status).toBe("completed");
		expect(result.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"user",
			"assistant",
		]);
		expect(
			addedMessages.some(
				(message) =>
					message.role === "user" &&
					message.content.some(
						(part) => part.type === "text" && part.text === "steer now",
					),
			),
		).toBe(true);
	});

	it("injects pending user messages before prepareTurn projects the provider request", async () => {
		const consumePendingUserMessage = vi.fn(() => "steer before prepare");
		const prepareTurn = vi.fn(
			(context: { messages: readonly AgentMessage[] }) => ({
				messages: context.messages.slice(),
			}),
		);
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "echo",
					inputText: '{"text":"hi"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				expect(request.messages.at(-1)).toMatchObject({
					role: "user",
					content: [{ type: "text", text: "steer before prepare" }],
				});
				return [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [createEchoTool()],
			prepareTurn,
			consumePendingUserMessage,
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(prepareTurn).toHaveBeenCalledTimes(2);
		expect(consumePendingUserMessage).toHaveBeenCalledTimes(1);
		expect(result.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"user",
			"assistant",
		]);
		const secondPrepareMessages = prepareTurn.mock.calls[1]?.[0].messages;
		expect(secondPrepareMessages.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "steer before prepare" }],
		});
	});

	it("lets prepareTurn project tool results after pending user input is added", async () => {
		const consumePendingUserMessage = vi.fn(() => "latest steering");
		const hugeToolOutput = "x".repeat(100_000);
		const prepareTurn = vi.fn(
			(context: { messages: readonly AgentMessage[] }) => {
				const latest = context.messages.at(-1);
				if (
					latest?.role === "user" &&
					latest.content.some(
						(part) => part.type === "text" && part.text === "latest steering",
					)
				) {
					return {
						messages: context.messages.filter(
							(message) => message.role !== "tool",
						),
					};
				}
				return { messages: context.messages.slice() };
			},
		);
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_large",
					toolName: "large",
					inputText: "{}",
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				expect(JSON.stringify(request.messages)).not.toContain(hugeToolOutput);
				expect(request.messages.at(-1)).toMatchObject({
					role: "user",
					content: [{ type: "text", text: "latest steering" }],
				});
				return [
					{ type: "text-delta", text: "compacted" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [
				{
					name: "large",
					description: "Large output",
					inputSchema: { type: "object" },
					execute: async () => hugeToolOutput,
				},
			],
			prepareTurn,
			consumePendingUserMessage,
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("compacted");
		expect(prepareTurn).toHaveBeenCalledTimes(2);
		const secondPrepareMessages = prepareTurn.mock.calls[1]?.[0].messages;
		expect(JSON.stringify(secondPrepareMessages)).toContain(hugeToolOutput);
		expect(secondPrepareMessages.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "latest steering" }],
		});
	});

	it("continues when completionGuard rejects a no-tool response", async () => {
		const submitTool: AgentTool<{ summary: string }, string> = {
			name: "submit",
			description: "Submit final answer",
			inputSchema: { type: "object" },
			lifecycle: { completesRun: true },
			async execute(input) {
				return `submitted: ${input.summary}`;
			},
		};
		const model = new ScriptedModel([
			() => [
				{ type: "text-delta", text: "I am done" },
				{ type: "finish", reason: "stop" },
			],
			(request) => {
				const reminder = request.messages.at(-1);
				expect(reminder?.role).toBe("user");
				expect(
					reminder?.content.some(
						(part) => part.type === "text" && part.text.includes("submit"),
					),
				).toBe(true);
				return [
					{
						type: "tool-call-delta",
						toolCallId: "call_submit",
						toolName: "submit",
						inputText: '{"summary":"done"}',
					},
					{ type: "finish", reason: "tool-calls" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [submitTool],
			completionPolicy: {
				completionGuard: () =>
					"[SYSTEM] This run is not complete until you call submit.",
			},
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.iterations).toBe(2);
		expect(result.outputText).toBe("submitted: done");
		expect(model.requests).toHaveLength(2);
	});

	it("announces and enforces required completion tools from tool lifecycle metadata", async () => {
		const submitTool: AgentTool<{ summary: string }, string> = {
			name: "custom_finish",
			description: "Submit final answer",
			inputSchema: { type: "object" },
			lifecycle: { completesRun: true },
			async execute(input) {
				return `submitted: ${input.summary}`;
			},
		};
		const model = new ScriptedModel([
			(request) => {
				const reminder = request.messages.at(-1);
				expect(reminder?.role).toBe("user");
				expect(
					reminder?.content.some(
						(part) =>
							part.type === "text" && part.text.includes("custom_finish"),
					),
				).toBe(true);
				return [
					{ type: "text-delta", text: "I am done" },
					{ type: "finish", reason: "stop" },
				];
			},
			(request) => {
				const reminder = request.messages.at(-1);
				expect(reminder?.role).toBe("user");
				expect(
					reminder?.content.some(
						(part) =>
							part.type === "text" && part.text.includes("custom_finish"),
					),
				).toBe(true);
				return [
					{
						type: "tool-call-delta",
						toolCallId: "call_submit",
						toolName: "custom_finish",
						inputText: '{"summary":"done"}',
					},
					{ type: "finish", reason: "tool-calls" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [submitTool],
			completionPolicy: { requireCompletionTool: true },
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.iterations).toBe(2);
		expect(result.outputText).toBe("submitted: done");
		expect(model.requests).toHaveLength(2);
	});

	it("finishes immediately after a successful terminal tool call", async () => {
		const submitTool: AgentTool<{ summary: string }, string> = {
			name: "submit",
			description: "Submit final answer",
			inputSchema: { type: "object" },
			lifecycle: { completesRun: true },
			async execute(input) {
				return input.summary;
			},
		};
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_submit",
					toolName: "submit",
					inputText: '{"summary":"finished"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [submitTool],
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.iterations).toBe(1);
		expect(result.outputText).toBe("finished");
		expect(model.requests).toHaveLength(1);
	});

	it("preserves structured multimodal tool results for the next model request", async () => {
		const structuredOutput = [
			{ type: "text", text: "Successfully read image" },
			{ type: "image", data: "QkFTRTY0REFUQQ==", mediaType: "image/jpeg" },
		];
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_img",
					toolName: "read_file",
					inputText: '{"path":"/tmp/image.jpg"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolMessage = request.messages.at(-1) as AgentMessage;
				expect(toolMessage.role).toBe("tool");
				expect(toolMessage.content[0]).toMatchObject({
					type: "tool-result",
					toolCallId: "call_img",
					toolName: "read_file",
					output: structuredOutput,
				});
				return [
					{ type: "text-delta", text: "saw image" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [
				{
					name: "read_file",
					description: "Read file",
					inputSchema: { type: "object" },
					execute: async () => structuredOutput,
				},
			],
		});

		const result = await runtime.run("Inspect image");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("saw image");
	});

	it("preserves plain tool outputs that contain an output property", async () => {
		const plainOutput = {
			output: "nested value",
			status: "ok",
			count: 2,
		};
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_plain",
					toolName: "plain_output",
					inputText: "{}",
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolMessage = request.messages.at(-1) as AgentMessage;
				expect(toolMessage.role).toBe("tool");
				expect(toolMessage.content[0]).toMatchObject({
					type: "tool-result",
					toolCallId: "call_plain",
					toolName: "plain_output",
					output: plainOutput,
				});
				return [
					{ type: "text-delta", text: "preserved" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [
				{
					name: "plain_output",
					description: "Return a plain object with an output key",
					inputSchema: { type: "object" },
					execute: async () => plainOutput,
				},
			],
		});

		const result = await runtime.run("Run tool");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("preserved");
	});

	it("requests approval when a tool policy disables auto-approval", async () => {
		const executeTool = vi.fn(async () => ({ echoed: "hi" }));
		const requestToolApproval = vi.fn(async () => ({
			approved: false,
			reason: "denied by test",
		}));
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_approval",
					toolName: "echo",
					inputText: '{"text":"hi"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolMessage = request.messages.at(-1) as AgentMessage;
				expect(toolMessage.role).toBe("tool");
				expect(toolMessage.content[0]).toMatchObject({
					type: "tool-result",
					isError: true,
					output: { error: "denied by test" },
				});
				return [
					{ type: "text-delta", text: "approval handled" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			sessionId: "session_test",
			agentId: "agent_test",
			conversationId: "conversation_test",
			model,
			tools: [
				{
					name: "echo",
					description: "Echo input text",
					inputSchema: { type: "object" },
					execute: executeTool,
				},
			],
			toolPolicies: { "*": { autoApprove: false } },
			requestToolApproval,
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("approval handled");
		expect(executeTool).not.toHaveBeenCalled();
		expect(requestToolApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session_test",
				agentId: "agent_test",
				conversationId: "conversation_test",
				iteration: 1,
				runId: expect.any(String),
				stepId: expect.any(String),
				assistantMessageId: expect.any(String),
				toolCallIndex: 0,
				toolCallId: "call_approval",
				toolName: "echo",
				input: { text: "hi" },
				policy: { autoApprove: false },
				signal: expect.anything(),
			}),
		);
	});

	it("carries the delegated agent chain into tool contexts and approvals", async () => {
		const seenContexts: AgentToolContext[] = [];
		const requestToolApproval = vi.fn(async () => ({ approved: true }));
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_chain",
					toolName: "echo",
					inputText: '{"text":"hi"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			() => [
				{ type: "text-delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			sessionId: "session_chain",
			agentId: "agent_child",
			parentAgentId: "agent_parent",
			rootRunId: "run_root",
			conversationId: "conversation_child",
			model,
			tools: [
				{
					name: "echo",
					description: "Echo input text",
					inputSchema: { type: "object" },
					execute: async (_input, context) => {
						seenContexts.push(context);
						return { echoed: "hi" };
					},
				},
			],
			toolPolicies: { "*": { autoApprove: false } },
			requestToolApproval,
		});

		await runtime.run("Start");

		expect(requestToolApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent_child",
				parentAgentId: "agent_parent",
				rootRunId: "run_root",
			}),
		);
		expect(seenContexts[0]).toMatchObject({
			agentId: "agent_child",
			parentAgentId: "agent_parent",
			rootRunId: "run_root",
		});
	});

	it("omits the agent chain for a lead agent", async () => {
		const requestToolApproval = vi.fn(async () => ({ approved: true }));
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_lead",
					toolName: "echo",
					inputText: '{"text":"hi"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			() => [
				{ type: "text-delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			sessionId: "session_lead",
			agentId: "agent_lead",
			conversationId: "conversation_lead",
			model,
			tools: [
				{
					name: "echo",
					description: "Echo input text",
					inputSchema: { type: "object" },
					execute: async () => ({ echoed: "hi" }),
				},
			],
			toolPolicies: { "*": { autoApprove: false } },
			requestToolApproval,
		});

		await runtime.run("Start");

		const request = requestToolApproval.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(request.agentId).toBe("agent_lead");
		expect(request).not.toHaveProperty("parentAgentId");
		expect(request).not.toHaveProperty("rootRunId");
	});

	it("applies beforeTool approval policy overrides before executing tools", async () => {
		const executeTool = vi.fn(async () => ({ echoed: "hi" }));
		const requestToolApproval = vi.fn(async () => ({
			approved: false,
			reason: "live policy denied",
		}));
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_live_policy",
					toolName: "echo",
					inputText: '{"text":"hi"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolMessage = request.messages.at(-1) as AgentMessage;
				expect(toolMessage.role).toBe("tool");
				expect(toolMessage.content[0]).toMatchObject({
					type: "tool-result",
					isError: true,
					output: { error: "live policy denied" },
				});
				return [
					{ type: "text-delta", text: "live policy handled" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			sessionId: "session_test",
			agentId: "agent_test",
			conversationId: "conversation_test",
			model,
			tools: [
				{
					name: "echo",
					description: "Echo input text",
					inputSchema: { type: "object" },
					execute: executeTool,
				},
			],
			toolPolicies: { "*": { autoApprove: true } },
			hooks: {
				beforeTool: () => ({ policy: { autoApprove: false } }),
			},
			requestToolApproval,
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("live policy handled");
		expect(executeTool).not.toHaveBeenCalled();
		expect(requestToolApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session_test",
				agentId: "agent_test",
				conversationId: "conversation_test",
				iteration: 1,
				runId: expect.any(String),
				stepId: expect.any(String),
				assistantMessageId: expect.any(String),
				toolCallIndex: 0,
				toolCallId: "call_live_policy",
				toolName: "echo",
				input: { text: "hi" },
				policy: { autoApprove: false },
				signal: expect.anything(),
			}),
		);
	});

	it("stores tool calls but skips execution when metadata disables external execution", async () => {
		const executeTool = vi.fn(async () => ({ echoed: "hi" }));
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "echo",
					inputText: '{"text":"hi"}',
					metadata: {
						toolSource: {
							providerId: "openai-codex",
							modelId: "gpt-5-codex",
							executionMode: "provider",
						},
					},
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolMessage = request.messages.at(-1) as AgentMessage;
				expect(toolMessage.role).toBe("tool");
				return [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [
				{
					name: "echo",
					description: "Echo input text",
					inputSchema: { type: "object" },
					execute: executeTool,
				},
			],
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("done");
		expect(executeTool).not.toHaveBeenCalled();
		const toolMessages = result.messages.filter(
			(message) => message.role === "tool",
		);
		expect(toolMessages).toHaveLength(1);
		expect(toolMessages[0]?.content).toEqual([
			expect.objectContaining({
				type: "tool-result",
				toolCallId: "call_1",
				toolName: "echo",
				isError: true,
				output: {
					error: "Tool execution is disabled for provider openai-codex",
				},
			}),
		]);
	});

	it("shows provider-disabled message even when tool is not registered locally", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "shell",
					inputText: '{"command":"echo hi"}',
					metadata: {
						toolSource: {
							providerId: "openai-codex",
							executionMode: "provider",
						},
					},
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolMessage = request.messages.at(-1) as AgentMessage;
				expect(toolMessage.role).toBe("tool");
				return [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [], // shell tool is not registered
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("done");
		const toolMessages = result.messages.filter(
			(message) => message.role === "tool",
		);
		expect(toolMessages).toHaveLength(1);
		expect(toolMessages[0]?.content).toEqual([
			expect.objectContaining({
				type: "tool-result",
				toolCallId: "call_1",
				toolName: "shell",
				isError: true,
				output: {
					error: "Tool execution is disabled for provider openai-codex",
				},
			}),
		]);
	});

	it("normalizes JSON-encoded string fields when the tool schema expects arrays", async () => {
		const executeTool = vi.fn(async (input: { commands: string[] }) => ({
			joined: input.commands.join(" && "),
		}));
		const beforeTool = vi.fn();
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_commands",
					toolName: "commands",
					inputText: JSON.stringify({
						commands: JSON.stringify(["git status", "bun test"]),
					}),
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolMessage = request.messages.at(-1) as AgentMessage;
				expect(toolMessage.role).toBe("tool");
				expect(toolMessage.content[0]).toMatchObject({
					type: "tool-result",
					toolName: "commands",
					output: { joined: "git status && bun test" },
				});
				return [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [
				{
					name: "commands",
					description: "Run commands",
					inputSchema: {
						type: "object",
						properties: {
							commands: {
								type: "array",
								items: { type: "string" },
							},
						},
					},
					execute: executeTool,
				},
			],
			hooks: {
				beforeTool,
			},
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(executeTool).toHaveBeenCalledWith(
			{ commands: ["git status", "bun test"] },
			expect.anything(),
		);
		expect(beforeTool).toHaveBeenCalledWith(
			expect.objectContaining({
				input: { commands: ["git status", "bun test"] },
				toolCall: expect.objectContaining({
					input: { commands: ["git status", "bun test"] },
				}),
			}),
		);
	});

	it("preserves JSON-looking strings when the tool schema expects strings", async () => {
		const executeTool = vi.fn(async (input: { text: string }) => ({
			echoed: input.text,
		}));
		const jsonText = JSON.stringify({ keep: "as text" });
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_text",
					toolName: "echo_json",
					inputText: JSON.stringify({ text: jsonText }),
				},
				{ type: "finish", reason: "tool-calls" },
			],
			() => [
				{ type: "text-delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [
				{
					name: "echo_json",
					description: "Echo JSON-looking text",
					inputSchema: {
						type: "object",
						properties: {
							text: { type: "string" },
						},
					},
					execute: executeTool,
				},
			],
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(executeTool).toHaveBeenCalledWith(
			{ text: jsonText },
			expect.anything(),
		);
	});

	it("treats an unset maxIterations as unlimited", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "echo",
					inputText: '{"text":"first"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_2",
					toolName: "echo",
					inputText: '{"text":"second"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			() => [
				{ type: "text-delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({ model, tools: [createEchoTool()] });

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.iterations).toBe(3);
		expect(result.outputText).toBe("done");
	});

	it("supports plugin-contributed tools and hooks", async () => {
		const beforeRun = vi.fn();
		const plugin: AgentRuntimePlugin = {
			name: "plugin-tool",
			setup: () => ({
				hooks: {
					beforeRun,
				},
				tools: [
					{
						name: "plugin_tool",
						description: "Provided by a plugin",
						inputSchema: { type: "object" },
						execute: async () => ({ ok: true }),
					},
				],
			}),
		};
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_plugin",
					toolName: "plugin_tool",
					inputText: "{}",
				},
				{ type: "finish", reason: "tool-calls" },
			],
			() => [
				{ type: "text-delta", text: "plugin complete" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const runtime = new AgentRuntime({
			model,
			conversationId: "conversation_plugin",
			plugins: [plugin],
		});
		const result = await runtime.run("Run plugin");

		expect(beforeRun).toHaveBeenCalledOnce();
		expect(beforeRun).toHaveBeenCalledWith({
			snapshot: expect.objectContaining({
				conversationId: "conversation_plugin",
			}),
		});
		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("plugin complete");
	});

	it("unwinds cleanly when beforeRun stops the run", async () => {
		const events: string[] = [];
		const afterRunStatuses: string[] = [];
		let stopNextRun = true;
		const runtime = new AgentRuntime({
			model: new ScriptedModel([
				() => [
					{ type: "text-delta", text: "second run" },
					{ type: "finish", reason: "stop" },
				],
			]),
			hooks: {
				beforeRun: async () => {
					if (!stopNextRun) {
						return undefined;
					}
					stopNextRun = false;
					return { stop: true, reason: "blocked" };
				},
				afterRun: ({ result }) => {
					afterRunStatuses.push(result.status);
				},
			},
		});
		runtime.subscribe((event) => {
			events.push(event.type);
		});

		const first = await runtime.run("first");
		const second = await runtime.run("second");

		expect(first.status).toBe("aborted");
		expect(first.error).toBeUndefined();
		expect(afterRunStatuses).toEqual(["aborted", "completed"]);
		expect(events[0]).toBe("run-finished");
		expect(events).toContain("run-started");
		expect(events.at(-1)).toBe("run-finished");
		expect(second.status).toBe("completed");
		expect(second.outputText).toBe("second run");
		expect(runtime.snapshot().status).toBe("completed");
	});

	it("annotates assistant messages with per-turn metrics and model info", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "usage",
					usage: {
						inputTokens: 12,
						outputTokens: 7,
						cacheReadTokens: 3,
						cacheWriteTokens: 2,
						reasoningTokenCount: 5,
						totalCost: 0.42,
					},
				},
				{ type: "text-delta", text: "hello" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			messageModelInfo: {
				id: "anthropic/claude-sonnet-4.6",
				provider: "openrouter",
				family: "claude-sonnet",
			},
		});

		const result = await runtime.run("Hi");
		const assistant = result.messages.at(-1);

		expect(assistant?.role).toBe("assistant");
		expect(assistant?.modelInfo).toEqual({
			id: "anthropic/claude-sonnet-4.6",
			provider: "openrouter",
			family: "claude-sonnet",
		});
		expect(assistant?.metrics).toEqual({
			inputTokens: 12,
			outputTokens: 7,
			cacheReadTokens: 3,
			cacheWriteTokens: 2,
			reasoningTokenCount: 5,
			cost: 0.42,
		});
	});

	it("captures telemetry when disabled reasoning still reports reasoning tokens", async () => {
		const telemetry = {
			capture: vi.fn(),
			captureRequired: vi.fn(),
			setDistinctId: vi.fn(),
			setMetadata: vi.fn(),
			updateMetadata: vi.fn(),
			setCommonProperties: vi.fn(),
			updateCommonProperties: vi.fn(),
			isEnabled: () => true,
			recordCounter: vi.fn(),
			recordHistogram: vi.fn(),
			recordGauge: vi.fn(),
			flush: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		} as unknown as ITelemetryService;
		const model = new ScriptedModel([
			() => [
				{
					type: "usage",
					usage: {
						inputTokens: 12,
						outputTokens: 7,
						reasoningTokenCount: 5,
					},
				},
				{ type: "text-delta", text: "hello" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			modelOptions: { thinking: false },
			messageModelInfo: {
				id: "z-ai/glm-4.7",
				provider: "openrouter",
			},
			telemetry,
		});

		await runtime.run("Hi");

		expect(telemetry.capture).toHaveBeenCalledWith(
			expect.objectContaining({
				event: AGENT_UNEXPECTED_REASONING_TOKENS_EVENT,
				properties: expect.objectContaining({
					providerId: "openrouter",
					modelId: "z-ai/glm-4.7",
					requestedThinking: false,
					reasoningTokenCount: 5,
					iteration: 1,
				}),
			}),
		);
	});

	it("stops a run from beforeModel hooks and returns an aborted result", async () => {
		const model = new ScriptedModel([
			() => [
				{ type: "text-delta", text: "should not happen" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			hooks: {
				beforeModel: () => ({ stop: true, reason: "approval required" }),
			},
		});

		const result = await runtime.run("Stop early");

		expect(result.status).toBe("aborted");
		expect(result.error).toBeUndefined();
		expect(result.outputText).toBe("");
		expect(model.requests).toHaveLength(0);
	});

	it("projects the provider request without overwriting canonical messages", async () => {
		const projectedMessage: AgentMessage = {
			id: "msg_projected",
			role: "user",
			content: [{ type: "text", text: "projected context" }],
			createdAt: 1,
		};
		const notices: string[] = [];
		const prepareTurn = vi.fn((context) => {
			expect(context.messages).toHaveLength(1);
			expect(context.messages[0]?.content).toEqual([
				{ type: "text", text: "large context" },
			]);
			context.emitStatusNotice?.("auto-compacting", {
				reason: "auto_compaction",
			});
			return {
				messages: [projectedMessage],
				systemPrompt: "projected system",
			};
		});
		const beforeModel = vi.fn(({ request }) => {
			expect(request.systemPrompt).toBe("projected system");
			expect(request.messages).toEqual([projectedMessage]);
			return undefined;
		});
		const model = new ScriptedModel([
			(request) => {
				expect(request.systemPrompt).toBe("projected system");
				expect(request.messages).toEqual([projectedMessage]);
				return [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			systemPrompt: "original system",
			prepareTurn,
			hooks: { beforeModel },
		});
		runtime.subscribe((event) => {
			if (event.type === "status-notice") {
				notices.push(event.message);
			}
		});

		const result = await runtime.run("large context");

		expect(prepareTurn).toHaveBeenCalledTimes(1);
		expect(beforeModel).toHaveBeenCalledTimes(1);
		expect(notices).toEqual(["auto-compacting"]);
		expect(model.requests[0]?.messages).toEqual([projectedMessage]);
		expect(result.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "large context" }],
		});
		expect(result.messages).toHaveLength(2);
		expect(result.messages).not.toContainEqual(projectedMessage);
		expect(model.requests).toHaveLength(1);
	});

	it("merges beforeModel options metadata into the model request", async () => {
		const model = new ScriptedModel([
			(request) => {
				expect(request.options?.metadata).toMatchObject({
					sessionId: "session-1",
					runId: "run-1",
					iteration: 1,
				});
				return [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			modelOptions: { metadata: { existing: true } },
			hooks: {
				beforeModel: () => ({
					options: {
						metadata: {
							sessionId: "session-1",
							runId: "run-1",
							iteration: 1,
						},
					},
				}),
			},
		});

		await runtime.run("capture metadata");

		expect(model.requests).toHaveLength(1);
		expect(model.requests[0]?.options?.metadata).toMatchObject({
			existing: true,
			sessionId: "session-1",
			runId: "run-1",
			iteration: 1,
		});
	});

	it("stamps runtime identity metadata onto model requests", async () => {
		const model = new ScriptedModel([
			(request) => {
				const metadata = request.options?.metadata as
					| Record<string, unknown>
					| undefined;
				expect(metadata).toMatchObject({
					sessionId: "session-runtime",
					agentId: "agent-runtime",
					conversationId: "conversation-runtime",
					iteration: 1,
				});
				expect(typeof metadata?.runId).toBe("string");
				return [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			sessionId: "session-runtime",
			agentId: "agent-runtime",
			conversationId: "conversation-runtime",
			model,
		});

		await runtime.run("capture metadata");

		expect(model.requests).toHaveLength(1);
	});

	it("does not synthesize session or conversation ids in model request metadata", async () => {
		const model = new ScriptedModel([
			(request) => {
				const metadata = request.options?.metadata as
					| Record<string, unknown>
					| undefined;
				expect(metadata).not.toHaveProperty("sessionId");
				expect(metadata).not.toHaveProperty("conversationId");
				expect(metadata).toMatchObject({
					agentId: "agent-runtime",
					iteration: 1,
				});
				expect(typeof metadata?.runId).toBe("string");
				return [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			agentId: "agent-runtime",
			model,
		});

		await runtime.run("capture metadata");

		expect(model.requests).toHaveLength(1);
	});

	it("preserves the existing system prompt when prepareTurn returns only messages", async () => {
		const projectedMessage: AgentMessage = {
			id: "msg_projected",
			role: "user",
			content: [{ type: "text", text: "projected context" }],
			createdAt: 1,
		};
		const model = new ScriptedModel([
			(request) => {
				expect(request.systemPrompt).toBe("original system");
				expect(request.messages).toEqual([projectedMessage]);
				return [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			systemPrompt: "original system",
			prepareTurn: () => ({ messages: [projectedMessage] }),
		});

		await runtime.run("large context");

		expect(model.requests).toHaveLength(1);
	});

	it("can block a tool through beforeTool hooks", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "blocked",
					toolName: "echo",
					inputText: '{"text":"x"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolResult = request.messages.at(-1)?.content[0];
				expect(toolResult).toMatchObject({
					type: "tool-result",
					isError: true,
				});
				return [
					{ type: "text-delta", text: "recovered" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [createEchoTool()],
			hooks: {
				beforeTool: () => ({ skip: true, reason: "policy denied" }),
			},
		});

		const result = await runtime.run("Block it");

		expect(result.status).toBe("completed");
		const toolMessage = result.messages.find(
			(message) => message.role === "tool",
		);
		expect(toolMessage?.content[0]).toMatchObject({
			type: "tool-result",
			isError: true,
		});
	});

	it("treats invalid tool-call JSON as a tool error instead of failing the run", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "bad_json",
					toolName: "echo",
					inputText: '{"text":"bad\\x"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolResult = request.messages.at(-1)?.content[0];
				expect(toolResult).toMatchObject({
					type: "tool-result",
					toolName: "echo",
					isError: true,
					output: {
						error: expect.stringContaining(
							"Tool call echo emitted invalid JSON arguments",
						),
					},
				});
				return [
					{ type: "text-delta", text: "recovered" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({ model, tools: [createEchoTool()] });

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("recovered");
	});

	it("recovers when a model stream reports an invalid tool input error after a tool call", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "bad_json",
					toolName: "echo",
					inputText: '{"text": find /tmp | head -20}',
				},
				{
					type: "finish",
					reason: "error",
					error: "Invalid input for tool echo",
				},
			],
			(request) => {
				const toolMessage = request.messages.at(-1) as AgentMessage;
				expect(toolMessage.role).toBe("tool");
				expect(toolMessage.content[0]).toMatchObject({
					type: "tool-result",
					toolName: "echo",
					isError: true,
					output: {
						error: expect.stringContaining(
							"Tool call echo emitted invalid JSON arguments",
						),
					},
				});
				return [
					{ type: "text-delta", text: "recovered" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({ model, tools: [createEchoTool()] });

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("recovered");
		expect(
			result.messages.filter((message) => message.role === "tool"),
		).toHaveLength(1);
	});

	it("merges metadata from repeated tool-call deltas", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_with_metadata",
					toolName: "echo",
					inputText: '{"text":"hi"}',
					metadata: {
						thoughtSignature: "sig_123",
					},
				},
				{
					type: "tool-call-delta",
					toolCallId: "call_with_metadata",
					toolName: "echo",
					metadata: {
						inputParseError: "adapter rejected tool input",
					},
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const assistantMessage = request.messages.find(
					(message) => message.role === "assistant",
				);
				const toolCall = assistantMessage?.content.find(
					(part) => part.type === "tool-call",
				);
				expect(toolCall).toMatchObject({
					type: "tool-call",
					metadata: {
						thoughtSignature: "sig_123",
						inputParseError: "adapter rejected tool input",
					},
				});
				const toolResult = request.messages.at(-1)?.content[0];
				expect(toolResult).toMatchObject({
					type: "tool-result",
					isError: true,
					output: {
						error: "adapter rejected tool input",
					},
				});
				return [
					{ type: "text-delta", text: "recovered" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const executeTool = vi.fn(async () => ({ echoed: "hi" }));
		const runtime = new AgentRuntime({
			model,
			tools: [
				{
					name: "echo",
					description: "Echo input text",
					inputSchema: { type: "object" },
					execute: executeTool,
				},
			],
		});

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("recovered");
		expect(executeTool).not.toHaveBeenCalled();
	});

	it("accepts corrected full argument snapshots for the same streamed tool call", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "echo",
					inputText: '{"text":"oops"}',
				},
				{
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "echo",
					inputText: '{"text":"fixed"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			(request) => {
				const toolResult = request.messages.at(-1)?.content[0];
				expect(toolResult).toMatchObject({
					type: "tool-result",
					toolName: "echo",
					output: { echoed: "fixed" },
				});
				return [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const runtime = new AgentRuntime({ model, tools: [createEchoTool()] });

		const result = await runtime.run("Start");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("done");
	});

	it("executes tools in parallel but preserves assistant order in appended messages", async () => {
		const executionOrder: string[] = [];
		const finishOrder: string[] = [];
		// `concurrency: "safe"` is what puts a tool in a parallel batch. The contract
		// default is "exclusive", so a test that means to demonstrate parallelism has
		// to opt in.
		const slow: AgentTool = {
			name: "slow",
			description: "slow tool",
			inputSchema: { type: "object" },
			concurrency: "safe",
			async execute() {
				executionOrder.push("slow-start");
				await new Promise((resolve) => setTimeout(resolve, 25));
				finishOrder.push("slow-finish");
				return { name: "slow" };
			},
		};
		const fast: AgentTool = {
			name: "fast",
			description: "fast tool",
			inputSchema: { type: "object" },
			concurrency: "safe",
			async execute() {
				executionOrder.push("fast-start");
				finishOrder.push("fast-finish");
				return { name: "fast" };
			},
		};
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "slow_call",
					toolName: "slow",
					inputText: "{}",
				},
				{
					type: "tool-call-delta",
					toolCallId: "fast_call",
					toolName: "fast",
					inputText: "{}",
				},
				{ type: "finish", reason: "tool-calls" },
			],
			() => [
				{ type: "text-delta", text: "done" },
				{ type: "finish", reason: "stop" },
			],
		]);

		const runtime = new AgentRuntime({
			model,
			tools: [slow, fast],
			toolExecution: "parallel",
		});

		const result = await runtime.run("Parallel");

		expect(executionOrder).toEqual(["slow-start", "fast-start"]);
		expect(finishOrder).toEqual(["fast-finish", "slow-finish"]);
		const toolMessages = result.messages.filter(
			(message) => message.role === "tool",
		);
		expect(toolMessages[0]?.content[0]).toMatchObject({ toolName: "slow" });
		expect(toolMessages[1]?.content[0]).toMatchObject({ toolName: "fast" });
	});

	/**
	 * `toolExecution: "parallel"` used to hand the whole turn's tool calls to the
	 * worker pool at once, which is only correct if every tool in the batch is safe to
	 * run beside the others — and nothing in the tool contract said which those were.
	 * Two `editor` calls on one file, or two `run_commands` calls sharing the terminal's
	 * working directory, would interleave. Each tool now declares its own
	 * `concurrency`, and this covers how the runtime honours it.
	 */
	describe("concurrency partitioning", () => {
		const toolCall = (toolName: string, id: string) => ({
			type: "tool-call-delta" as const,
			toolCallId: id,
			toolName,
			inputText: "{}",
		});

		/** Model that emits the given tool names in one turn, then finishes. */
		const modelEmitting = (names: string[]) =>
			new ScriptedModel([
				() => [
					...names.map((name, i) => toolCall(name, `${name}_${i}`)),
					{ type: "finish", reason: "tool-calls" },
				],
				() => [
					{ type: "text-delta", text: "done" },
					{ type: "finish", reason: "stop" },
				],
			]);

		const tracker = (log: string[], name: string, delayMs = 20) => ({
			name,
			description: `${name} tool`,
			inputSchema: { type: "object" },
			execute: async () => {
				log.push(`${name}:start`);
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				log.push(`${name}:end`);
				return { name };
			},
		});

		it("batches consecutive safe tools and runs unsafe tools alone, in order", async () => {
			const log: string[] = [];
			const runtime = new AgentRuntime({
				model: modelEmitting(["read_a", "write", "read_b", "read_c"]),
				toolExecution: "parallel",
				tools: [
					{ ...tracker(log, "read_a"), concurrency: "safe" as const },
					// `write` deliberately has no `concurrency`, i.e. the exclusive default.
					tracker(log, "write"),
					{ ...tracker(log, "read_b", 30), concurrency: "safe" as const },
					// Distinct durations so the interleaving of the concurrent pair is
					// deterministic; two equal-length tasks can finish either way.
					{ ...tracker(log, "read_c", 5), concurrency: "safe" as const },
				],
			});

			await runtime.run("go");

			// read_a starts; `write` cannot begin until read_a has finished; then
			// read_b and read_c overlap. A whole-batch pool would have started all four.
			expect(log).toEqual([
				"read_a:start",
				"read_a:end",
				"write:start",
				"write:end",
				"read_b:start",
				"read_c:start",
				"read_c:end",
				"read_b:end",
			]);
		});

		it("runs every tool serially when none opted in", async () => {
			const log: string[] = [];
			const runtime = new AgentRuntime({
				model: modelEmitting(["a", "b", "c"]),
				toolExecution: "parallel",
				tools: [tracker(log, "a"), tracker(log, "b"), tracker(log, "c")],
			});

			await runtime.run("go");

			// Default "exclusive" means "parallel" degrades to sequential rather than
			// racing. This is the property that makes the new default safe.
			expect(log).toEqual([
				"a:start",
				"a:end",
				"b:start",
				"b:end",
				"c:start",
				"c:end",
			]);
		});

		it("emits tool results in emission order regardless of completion order", async () => {
			const log: string[] = [];
			const runtime = new AgentRuntime({
				model: modelEmitting(["slow", "quick"]),
				toolExecution: "parallel",
				tools: [
					{ ...tracker(log, "slow", 40), concurrency: "safe" as const },
					{ ...tracker(log, "quick", 1), concurrency: "safe" as const },
				],
			});

			const result = await runtime.run("go");

			// quick finishes first...
			expect(log.indexOf("quick:end")).toBeLessThan(log.indexOf("slow:end"));
			// ...but the transcript still records them in the order the model asked.
			const toolMessages = result.messages.filter((m) => m.role === "tool");
			expect(toolMessages[0]?.content[0]).toMatchObject({ toolName: "slow" });
			expect(toolMessages[1]?.content[0]).toMatchObject({ toolName: "quick" });
		});
	});

	it("captures events, logger calls, telemetry, and failed tool runs", async () => {
		const telemetry = {
			capture: vi.fn(),
			captureRequired: vi.fn(),
			setDistinctId: vi.fn(),
			setMetadata: vi.fn(),
			updateMetadata: vi.fn(),
			setCommonProperties: vi.fn(),
			updateCommonProperties: vi.fn(),
			isEnabled: () => true,
			recordCounter: vi.fn(),
			recordHistogram: vi.fn(),
			recordGauge: vi.fn(),
			flush: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		} as unknown as ITelemetryService;
		const logger = {
			debug: vi.fn(),
			log: vi.fn(),
			error: vi.fn(),
		};
		const events: string[] = [];
		const model = new ScriptedModel([
			() => [
				{
					type: "tool-call-delta",
					toolCallId: "boom_call",
					toolName: "boom",
					inputText: "{}",
				},
				{ type: "finish", reason: "tool-calls" },
			],
			() => [{ type: "finish", reason: "error", error: "model failed" }],
		]);
		const runtime = new AgentRuntime({
			model,
			logger,
			telemetry,
			tools: [
				{
					name: "boom",
					description: "throws",
					inputSchema: { type: "object" },
					async execute() {
						throw new Error("tool exploded");
					},
				},
			],
		});
		runtime.subscribe((event) => {
			events.push(event.type);
		});

		const result = await runtime.run("Fail");

		expect(result.status).toBe("failed");
		expect(events).toContain("run-failed");
		expect(logger.log).toHaveBeenCalledWith(
			"Agent loop caught error",
			expect.objectContaining({
				severity: "error",
				status: "failed",
				errorMessage: "model failed",
			}),
		);
		expect(logger.error).toHaveBeenCalled();
		expect(telemetry.capture).toHaveBeenCalled();
	});

	it("propagates agent identity including role through snapshots and plugin setup", async () => {
		const setup = vi.fn(() => undefined);
		const plugin: AgentRuntimePlugin = {
			name: "identity",
			setup,
		};
		const model = new ScriptedModel([
			() => [
				{ type: "text-delta", text: "ok" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			agentId: "lead-1",
			agentRole: "lead",
			model,
			plugins: [plugin],
		});

		const snapshots: Array<{ agentId: string; agentRole?: string }> = [];
		runtime.subscribe((event) => {
			snapshots.push({
				agentId: event.snapshot.agentId,
				agentRole: event.snapshot.agentRole,
			});
		});

		const result = await runtime.run("Identity");

		expect(setup).toHaveBeenCalledWith({
			agentId: "lead-1",
			agentRole: "lead",
			systemPrompt: undefined,
		});
		expect(result.agentId).toBe("lead-1");
		expect(result.agentRole).toBe("lead");
		expect(snapshots.every((snapshot) => snapshot.agentId === "lead-1")).toBe(
			true,
		);
		expect(snapshots.every((snapshot) => snapshot.agentRole === "lead")).toBe(
			true,
		);
	});

	it("resets usage between consecutive run/continue calls", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "usage",
					usage: { inputTokens: 100, outputTokens: 20, totalCost: 0.5 },
				},
				{ type: "text-delta", text: "first" },
				{ type: "finish", reason: "stop" },
			],
			() => [
				{
					type: "usage",
					usage: { inputTokens: 200, outputTokens: 40, totalCost: 1.0 },
				},
				{ type: "text-delta", text: "second" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({ model });

		const first = await runtime.run("Turn 1");
		expect(first.usage).toMatchObject({
			inputTokens: 100,
			outputTokens: 20,
			totalCost: 0.5,
		});

		const second = await runtime.continue("Turn 2");
		expect(second.usage).toMatchObject({
			inputTokens: 200,
			outputTokens: 40,
			totalCost: 1.0,
		});
	});

	it("stops before the next model request once the token budget is reached", async () => {
		const notices: Array<{ message: string; metadata?: unknown }> = [];
		const model = new ScriptedModel([
			() => [
				{
					type: "usage",
					usage: { inputTokens: 100, outputTokens: 20, totalCost: 0.5 },
				},
				{
					type: "tool-call-delta",
					toolCallId: "call_budget",
					toolName: "echo",
					inputText: '{"text":"one"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [createEchoTool()],
			budget: { maxTotalTokens: 100 },
			hooks: {
				onEvent: (event) => {
					if (event.type === "status-notice") {
						notices.push({
							message: event.message,
							metadata: event.metadata,
						});
					}
				},
			},
		});

		const result = await runtime.run("Go");

		// The turn that crossed the cap still completes — the tool call keeps its
		// tool result — but no second model request is paid for.
		expect(result.status).toBe("budget_exhausted");
		expect(result.iterations).toBe(1);
		expect(result.usage).toMatchObject({
			inputTokens: 100,
			outputTokens: 20,
			totalCost: 0.5,
		});
		expect(model.requests).toHaveLength(1);
		const toolMessage = result.messages.find(
			(message) => message.role === "tool",
		) as AgentMessage | undefined;
		expect(toolMessage?.content[0]).toMatchObject({
			type: "tool-result",
			output: { echoed: "one" },
		});
		expect(notices).toHaveLength(1);
		expect(notices[0]?.metadata).toMatchObject({
			kind: "budget_exhausted",
			limit: "maxTotalTokens",
			cap: 100,
			used: 120,
		});
	});

	it("keeps running while usage stays under every configured cap", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "usage",
					usage: { inputTokens: 10, outputTokens: 5, totalCost: 0.01 },
				},
				{
					type: "tool-call-delta",
					toolCallId: "call_ok",
					toolName: "echo",
					inputText: '{"text":"one"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
			() => [
				{
					type: "usage",
					usage: { inputTokens: 20, outputTokens: 8, totalCost: 0.02 },
				},
				{ type: "text-delta", text: "all done" },
				{ type: "finish", reason: "stop" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [createEchoTool()],
			budget: { maxTotalTokens: 10_000, maxTotalCost: 5 },
		});

		const result = await runtime.run("Go");

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("all done");
		expect(result.usage).toMatchObject({
			inputTokens: 30,
			outputTokens: 13,
		});
	});

	it("stops on a cost cap independently of the token caps", async () => {
		const model = new ScriptedModel([
			() => [
				{
					type: "usage",
					usage: { inputTokens: 1, outputTokens: 1, totalCost: 0.3 },
				},
				{
					type: "tool-call-delta",
					toolCallId: "call_cost",
					toolName: "echo",
					inputText: '{"text":"one"}',
				},
				{ type: "finish", reason: "tool-calls" },
			],
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [createEchoTool()],
			// Token caps are effectively unlimited, so only cost can stop this run.
			budget: { maxTotalTokens: 1_000_000, maxTotalCost: 0.25 },
		});

		const result = await runtime.run("Go");

		expect(result.status).toBe("budget_exhausted");
		expect(model.requests).toHaveLength(1);
	});

	it("rejects a malformed run budget instead of running unbounded", () => {
		expect(
			() => new AgentRuntime({ model: new ScriptedModel([]), budget: {} }),
		).not.toThrow();
		expect(
			() =>
				new AgentRuntime({
					model: new ScriptedModel([]),
					budget: { maxTotalTokens: 0 },
				}),
		).toThrow("maxTotalTokens must be a positive finite number");
		expect(
			() =>
				new AgentRuntime({
					model: new ScriptedModel([]),
					budget: { maxTotalCost: Number.NaN },
				}),
		).toThrow("maxTotalCost must be a positive finite number");
		expect(
			() =>
				new AgentRuntime({
					model: new ScriptedModel([]),
					budget: { maxCalls: 3 } as never,
				}),
		).toThrow("unsupported field: maxCalls");
	});

	it("resumes an approved persisted tool call without replaying the model turn", async () => {
		const initialMessages: AgentMessage[] = [
			{
				id: "msg_resume_user",
				role: "user",
				content: [{ type: "text", text: "Run it" }],
				createdAt: 1,
			},
			{
				id: "msg_resume_assistant",
				role: "assistant",
				content: [
					{ type: "text", text: "I will run it" },
					{
						type: "tool-call",
						toolCallId: "call_resume",
						toolName: "echo",
						input: { text: "hi" },
					},
				],
				createdAt: 2,
			},
		];
		const model = new ScriptedModel([
			(request) => {
				expect(request.messages.at(-1)).toMatchObject({
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "call_resume",
							toolName: "echo",
							output: { echoed: "hi" },
						},
					],
				});
				expect(request.options?.metadata).toMatchObject({
					runId: "run_resume",
					iteration: 2,
				});
				return [
					{ type: "text-delta", text: "resumed done" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const execute = vi.fn(async (input: { text: string }) => ({
			echoed: input.text,
		}));
		const beforeTool = vi.fn();
		const requestToolApproval = vi.fn(async () => ({ approved: true }));
		const runtime = new AgentRuntime({
			model,
			initialMessages,
			tools: [
				{
					name: "echo",
					description: "Echo input text",
					inputSchema: { type: "object" },
					execute,
				},
			],
			hooks: { beforeTool },
			requestToolApproval,
		});
		const events: string[] = [];
		runtime.subscribe((event) => events.push(event.type));

		const result = await runtime.resumePendingToolCall({
			runId: "run_resume",
			iteration: 1,
			assistantMessageId: "msg_resume_assistant",
			toolCallId: "call_resume",
			toolName: "echo",
			preparedInput: { text: "hi" },
			approval: { approved: true },
		});

		expect(result.status).toBe("completed");
		expect(result.runId).toBe("run_resume");
		expect(result.iterations).toBe(2);
		expect(result.outputText).toBe("resumed done");
		expect(result.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		expect(model.requests).toHaveLength(1);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith(
			{ text: "hi" },
			expect.objectContaining({
				iteration: 1,
				runId: "run_resume",
				stepId: "step:run_resume:1:0",
				toolCallId: "call_resume",
				toolCallIndex: 0,
			}),
		);
		expect(beforeTool).not.toHaveBeenCalled();
		expect(requestToolApproval).not.toHaveBeenCalled();
		expect(events).toEqual(
			expect.arrayContaining([
				"run-started",
				"turn-started",
				"tool-started",
				"tool-finished",
				"message-added",
				"turn-finished",
				"assistant-message",
				"run-finished",
			]),
		);
	});

	it("resumes a decided multi-tool batch in persisted order", async () => {
		const initialMessages: AgentMessage[] = [
			{
				id: "msg_batch_user",
				role: "user",
				content: [{ type: "text", text: "Run both" }],
				createdAt: 1,
			},
			{
				id: "msg_batch_assistant",
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call_batch_1",
						toolName: "echo",
						input: { text: "first" },
					},
					{
						type: "tool-call",
						toolCallId: "call_batch_2",
						toolName: "echo",
						input: { text: "second" },
					},
				],
				createdAt: 2,
			},
		];
		const model = new ScriptedModel([
			(request) => {
				const results = request.messages
					.filter((message) => message.role === "tool")
					.flatMap((message) => message.content);
				expect(results.map((part) => part.toolCallId)).toEqual([
					"call_batch_1",
					"call_batch_2",
				]);
				expect(results[0]).toMatchObject({
					toolCallId: "call_batch_1",
					output: { echoed: "first" },
				});
				return [
					{ type: "text-delta", text: "batch resumed" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const execute = vi.fn(async (input: { text: string }) => ({
			echoed: input.text,
		}));
		const runtime = new AgentRuntime({
			model,
			initialMessages,
			tools: [
				{
					name: "echo",
					description: "Echo input text",
					inputSchema: { type: "object" },
					execute,
				},
			],
		});

		const result = await runtime.resumePendingToolBatch({
			runId: "run_batch",
			iteration: 1,
			assistantMessageId: "msg_batch_assistant",
			calls: [
				{
					stepId: "step:run_batch:1:0",
					toolCallId: "call_batch_1",
					toolName: "echo",
					preparedInput: { text: "first" },
					approval: { approved: true },
				},
				{
					stepId: "step:run_batch:1:1",
					toolCallId: "call_batch_2",
					toolName: "echo",
					preparedInput: { text: "second" },
					approval: { approved: false, reason: "denied by reviewer" },
				},
			],
		});

		expect(result.error?.message).toBeUndefined();
		expect(result.status).toBe("completed");
		expect(result.runId).toBe("run_batch");
		expect(result.outputText).toBe("batch resumed");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenNthCalledWith(
			1,
			{ text: "first" },
			expect.objectContaining({
				stepId: "step:run_batch:1:0",
				toolCallIndex: 0,
			}),
		);
		const results = result.messages
			.filter((message) => message.role === "tool")
			.flatMap((message) => message.content);
		expect(results[1]).toMatchObject({
			toolCallId: "call_batch_2",
			isError: true,
			output: { denied: true, reason: "denied by reviewer" },
		});
	});

	it("rejects a resume batch that does not match the persisted tool calls", async () => {
		const initialMessages: AgentMessage[] = [
			{
				id: "msg_batch_bad_user",
				role: "user",
				content: [{ type: "text", text: "Run both" }],
				createdAt: 1,
			},
			{
				id: "msg_batch_bad_assistant",
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call_bad_1",
						toolName: "echo",
						input: { text: "first" },
					},
					{
						type: "tool-call",
						toolCallId: "call_bad_2",
						toolName: "echo",
						input: { text: "second" },
					},
				],
				createdAt: 2,
			},
		];
		const createRuntime = () =>
			new AgentRuntime({
				model: new ScriptedModel([]),
				initialMessages,
				tools: [
					{
						name: "echo",
						description: "Echo input text",
						inputSchema: { type: "object" },
						execute: vi.fn(async () => ({ echoed: "hi" })),
					},
				],
			});
		const base = {
			runId: "run_bad",
			iteration: 1,
			assistantMessageId: "msg_batch_bad_assistant",
		};

		const mismatched = await createRuntime().resumePendingToolBatch({
			...base,
			calls: [
				{
					toolCallId: "call_bad_1",
					toolName: "echo",
					preparedInput: { text: "first" },
					approval: { approved: true },
				},
			],
		});
		expect(mismatched.status).toBe("failed");
		expect(mismatched.error?.message).toMatch(/do not match the resume batch/);

		const duplicated = await createRuntime().resumePendingToolBatch({
			...base,
			calls: [
				{
					toolCallId: "call_bad_1",
					toolName: "echo",
					preparedInput: { text: "first" },
					approval: { approved: true },
				},
				{
					toolCallId: "call_bad_1",
					toolName: "echo",
					preparedInput: { text: "first" },
					approval: { approved: true },
				},
			],
		});
		expect(duplicated.status).toBe("failed");
		expect(duplicated.error?.message).toMatch(/duplicate tool call id/);

		const tampered = await createRuntime().resumePendingToolBatch({
			...base,
			calls: [
				{
					toolCallId: "call_bad_1",
					toolName: "echo",
					preparedInput: { text: "tampered" },
					approval: { approved: true },
				},
				{
					toolCallId: "call_bad_2",
					toolName: "echo",
					preparedInput: { text: "second" },
					approval: { approved: true },
				},
			],
		});
		expect(tampered.status).toBe("failed");
		expect(tampered.error?.message).toMatch(/prepared input does not match/);

		const empty = await createRuntime().resumePendingToolBatch({
			...base,
			calls: [],
		});
		expect(empty.status).toBe("failed");
		expect(empty.error?.message).toMatch(/1 to 16 entries/);
	});

	it("resumes a denied tool call with a structured denial result", async () => {
		const initialMessages: AgentMessage[] = [
			{
				id: "msg_denied_user",
				role: "user",
				content: [{ type: "text", text: "Run it" }],
				createdAt: 1,
			},
			{
				id: "msg_denied_assistant",
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call_denied",
						toolName: "echo",
						input: { text: "hi" },
					},
				],
				createdAt: 2,
			},
		];
		const model = new ScriptedModel([
			(request) => {
				expect(request.messages.at(-1)?.content[0]).toMatchObject({
					type: "tool-result",
					toolCallId: "call_denied",
					isError: true,
					output: { denied: true, reason: "user denied" },
				});
				return [
					{ type: "text-delta", text: "denial handled" },
					{ type: "finish", reason: "stop" },
				];
			},
		]);
		const execute = vi.fn(async () => ({ echoed: "hi" }));
		const beforeTool = vi.fn();
		const requestToolApproval = vi.fn(async () => ({ approved: true }));
		const runtime = new AgentRuntime({
			model,
			initialMessages,
			tools: [
				{
					name: "echo",
					description: "Echo input text",
					inputSchema: { type: "object" },
					execute,
				},
			],
			hooks: { beforeTool },
			requestToolApproval,
		});

		const result = await runtime.resumePendingToolCall({
			runId: "run_denied",
			iteration: 1,
			assistantMessageId: "msg_denied_assistant",
			toolCallId: "call_denied",
			toolName: "echo",
			preparedInput: { text: "hi" },
			approval: { approved: false, reason: "user denied" },
		});

		expect(result.status).toBe("completed");
		expect(result.outputText).toBe("denial handled");
		expect(model.requests).toHaveLength(1);
		expect(execute).not.toHaveBeenCalled();
		expect(beforeTool).not.toHaveBeenCalled();
		expect(requestToolApproval).not.toHaveBeenCalled();
		expect(
			result.messages.find((message) => message.role === "tool")?.content[0],
		).toMatchObject({
			type: "tool-result",
			toolCallId: "call_denied",
			isError: true,
			output: { denied: true, reason: "user denied" },
		});
	});

	it("fails closed when resume identity or prepared input does not match", async () => {
		const initialMessages: AgentMessage[] = [
			{
				id: "msg_mismatch_assistant",
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call_mismatch",
						toolName: "echo",
						input: { text: "expected" },
					},
				],
				createdAt: 1,
			},
		];
		const baseInput: AgentRuntimeResumeToolCall = {
			runId: "run_mismatch",
			iteration: 1,
			assistantMessageId: "msg_mismatch_assistant",
			toolCallId: "call_mismatch",
			toolName: "echo",
			preparedInput: { text: "expected" },
			approval: { approved: true },
		};
		const cases: AgentRuntimeResumeToolCall[] = [
			{ ...baseInput, assistantMessageId: "msg_wrong" },
			{ ...baseInput, toolCallId: "call_wrong" },
			{ ...baseInput, preparedInput: { text: "wrong" } },
		];

		for (const input of cases) {
			const execute = vi.fn(async () => ({ echoed: "expected" }));
			const model = new ScriptedModel([]);
			const runtime = new AgentRuntime({
				model,
				initialMessages,
				tools: [
					{
						name: "echo",
						description: "Echo input text",
						inputSchema: { type: "object" },
						execute,
					},
				],
			});

			const result = await runtime.resumePendingToolCall(input);

			expect(result.status).toBe("failed");
			expect(result.error?.message).toMatch(/mismatch|does not match/);
			expect(model.requests).toHaveLength(0);
			expect(execute).not.toHaveBeenCalled();
		}
	});

	it("rejects duplicate and multiple persisted tool calls", async () => {
		const duplicateMessages: AgentMessage[] = [
			{
				id: "msg_duplicate_assistant",
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call_duplicate",
						toolName: "echo",
						input: { text: "hi" },
					},
					{
						type: "tool-call",
						toolCallId: "call_duplicate",
						toolName: "echo",
						input: { text: "hi" },
					},
				],
				createdAt: 1,
			},
		];
		const multipleMessages: AgentMessage[] = [
			{
				id: "msg_multiple_assistant",
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call_first",
						toolName: "echo",
						input: { text: "hi" },
					},
					{
						type: "tool-call",
						toolCallId: "call_second",
						toolName: "echo",
						input: { text: "hi" },
					},
				],
				createdAt: 1,
			},
		];
		const cases = [
			{
				messages: duplicateMessages,
				input: {
					runId: "run_duplicate",
					iteration: 1,
					assistantMessageId: "msg_duplicate_assistant",
					toolCallId: "call_duplicate",
					toolName: "echo",
					preparedInput: { text: "hi" },
					approval: { approved: true },
				} satisfies AgentRuntimeResumeToolCall,
			},
			{
				messages: multipleMessages,
				input: {
					runId: "run_multiple",
					iteration: 1,
					assistantMessageId: "msg_multiple_assistant",
					toolCallId: "call_first",
					toolName: "echo",
					preparedInput: { text: "hi" },
					approval: { approved: true },
				} satisfies AgentRuntimeResumeToolCall,
			},
		];

		for (const testCase of cases) {
			const execute = vi.fn(async () => ({ echoed: "hi" }));
			const model = new ScriptedModel([]);
			const runtime = new AgentRuntime({
				model,
				initialMessages: testCase.messages,
				tools: [
					{
						name: "echo",
						description: "Echo input text",
						inputSchema: { type: "object" },
						execute,
					},
				],
			});

			const result = await runtime.resumePendingToolCall(testCase.input);

			expect(result.status).toBe("failed");
			expect(result.error?.message).toMatch(/do not match the resume batch/);
			expect(model.requests).toHaveLength(0);
			expect(execute).not.toHaveBeenCalled();
		}
	});
});
