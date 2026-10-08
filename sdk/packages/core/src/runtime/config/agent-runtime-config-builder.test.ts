/**
 * Unit tests for `createAgentRuntimeConfig` and its small pure
 * helpers (`buildModelOptions`, `buildMessageModelInfo`,
 * `resolveToolExecution`).
 *
 */

import type {
	AgentConfig,
	AgentModel,
	AgentModelEvent,
	AgentTool,
	ITelemetryService,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	buildMessageModelInfo,
	buildModelOptions,
	type CreateAgentRuntimeConfigInput,
	createAgentRuntimeConfig,
	resolveToolExecution,
} from "./agent-runtime-config-builder";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		providerId: "anthropic",
		modelId: "claude-3-5-sonnet",
		systemPrompt: "You are a helpful assistant.",
		tools: [],
		...overrides,
	};
}

const nullModel: AgentModel = {
	async stream() {
		return (async function* (): AsyncIterable<AgentModelEvent> {
			yield { type: "finish", reason: "stop" };
		})();
	},
};

// ---------------------------------------------------------------------------
// buildModelOptions
// ---------------------------------------------------------------------------

describe("buildModelOptions", () => {
	it("returns undefined when no reasoning/budget fields are set", () => {
		expect(buildModelOptions(makeAgentConfig())).toBeUndefined();
	});

	it("collects all provided fields", () => {
		const config = makeAgentConfig({
			thinking: true,
			reasoningEffort: "high",
			thinkingBudgetTokens: 1024,
			maxTokensPerTurn: 4096,
			temperature: 0.2,
			apiTimeoutMs: 60_000,
		});
		expect(buildModelOptions(config)).toEqual({
			thinking: true,
			reasoningEffort: "high",
			thinkingBudgetTokens: 1024,
			maxTokensPerTurn: 4096,
			temperature: 0.2,
			apiTimeoutMs: 60_000,
		});
	});

	it("omits undefined fields", () => {
		const config = makeAgentConfig({ thinking: true });
		expect(buildModelOptions(config)).toEqual({ thinking: true });
	});
});

// ---------------------------------------------------------------------------
// buildMessageModelInfo
// ---------------------------------------------------------------------------

describe("buildMessageModelInfo", () => {
	it("builds { id, provider, family } from AgentConfig", () => {
		const config = makeAgentConfig({
			providerId: "openai",
			modelId: "gpt-4o",
			providerConfig: { family: "gpt-4" },
		});
		expect(buildMessageModelInfo(config)).toEqual({
			id: "gpt-4o",
			provider: "openai",
			family: "gpt-4",
		});
	});

	it("omits family when not present in providerConfig", () => {
		const config = makeAgentConfig();
		expect(buildMessageModelInfo(config)).toEqual({
			id: "claude-3-5-sonnet",
			provider: "anthropic",
			family: undefined,
		});
	});
});

// ---------------------------------------------------------------------------
// resolveToolExecution
// ---------------------------------------------------------------------------

describe("resolveToolExecution", () => {
	it("returns undefined when unset", () => {
		expect(resolveToolExecution(undefined)).toBeUndefined();
	});

	it("returns 'sequential' for 1", () => {
		expect(resolveToolExecution(1)).toBe("sequential");
	});

	it("returns 'parallel' for >= 2", () => {
		expect(resolveToolExecution(2)).toBe("parallel");
		expect(resolveToolExecution(8)).toBe("parallel");
	});
});

// ---------------------------------------------------------------------------
// createAgentRuntimeConfig
// ---------------------------------------------------------------------------

describe("createAgentRuntimeConfig", () => {
	it("produces a config with the PLAN §3.2.1 field mapping", () => {
		const agentConfig = makeAgentConfig({
			systemPrompt: "sp",
			providerId: "openai",
			modelId: "gpt-4o",
			providerConfig: { family: "gpt-4" },
			thinking: true,
			reasoningEffort: "high",
			maxIterations: 7,
			budget: { maxTotalCost: 3 },
			maxParallelToolCalls: 4,
			completionPolicy: { requireCompletionTool: true },
			toolPolicies: { "*": { autoApprove: false } },
			requestToolApproval: async () => ({ approved: true }),
			consumePendingUserMessage: () => "steer",
		});
		const tools: AgentTool[] = [
			{
				name: "echo",
				description: "e",
				inputSchema: { type: "object" },
				execute: async () => "x",
			},
		];
		const runtimeConfig = createAgentRuntimeConfig({
			agentConfig,
			sessionId: "session_abc",
			agentId: "agent_abc",
			conversationId: "conversation_abc",
			agentRole: "lead",
			model: nullModel,
			tools,
		});
		expect(runtimeConfig.sessionId).toBe("session_abc");
		expect(runtimeConfig.agentId).toBe("agent_abc");
		expect(runtimeConfig.conversationId).toBe("conversation_abc");
		expect(runtimeConfig.agentRole).toBe("lead");
		expect(runtimeConfig.systemPrompt).toBe("sp");
		expect(runtimeConfig.model).toBe(nullModel);
		expect(runtimeConfig.messageModelInfo).toEqual({
			id: "gpt-4o",
			provider: "openai",
			family: "gpt-4",
		});
		expect(runtimeConfig.modelOptions).toEqual({
			thinking: true,
			reasoningEffort: "high",
		});
		expect(runtimeConfig.tools).toBe(tools);
		expect(runtimeConfig.maxIterations).toBe(7);
		expect(runtimeConfig.budget).toEqual({ maxTotalCost: 3 });
		expect(runtimeConfig.toolExecution).toBe("parallel");
		expect(runtimeConfig.maxParallelToolCalls).toBe(4);
		expect(runtimeConfig.completionPolicy).toEqual({
			requireCompletionTool: true,
		});
		expect(runtimeConfig.toolPolicies).toEqual({
			"*": { autoApprove: false },
		});
		expect(runtimeConfig.requestToolApproval).toBe(
			agentConfig.requestToolApproval,
		);
		expect(runtimeConfig.consumePendingUserMessage).toBe(
			agentConfig.consumePendingUserMessage,
		);
	});

	it("uses the override systemPrompt when provided", () => {
		const runtimeConfig = createAgentRuntimeConfig({
			agentConfig: makeAgentConfig({ systemPrompt: "default" }),
			agentId: "a",
			model: nullModel,
			systemPrompt: "override",
		});
		expect(runtimeConfig.systemPrompt).toBe("override");
	});

	it("populates hooks when provided", () => {
		const beforeRun = vi.fn();
		const runtimeConfig = createAgentRuntimeConfig({
			agentConfig: makeAgentConfig(),
			agentId: "a",
			model: nullModel,
			hooks: { beforeRun },
		});
		expect(runtimeConfig.hooks?.beforeRun).toBe(beforeRun);
	});

	it("omits hooks when none are provided", () => {
		const runtimeConfig = createAgentRuntimeConfig({
			agentConfig: makeAgentConfig(),
			agentId: "a",
			model: nullModel,
		});
		expect(runtimeConfig.hooks).toBeUndefined();
	});

	it("passes through plugins/initialMessages/logger/telemetry", () => {
		const logger = {
			log: vi.fn(),
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
		const telemetryCapture = vi.fn();
		const telemetry = {
			capture: telemetryCapture,
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
		const runtimeConfig = createAgentRuntimeConfig({
			agentConfig: makeAgentConfig(),
			agentId: "a",
			model: nullModel,
			logger,
			telemetry,
			plugins: [{ name: "p1" }],
			initialMessages: [
				{
					id: "m1",
					role: "user",
					content: [{ type: "text", text: "hi" }],
					createdAt: 1,
				},
			],
		});
		expect(runtimeConfig.logger).toBe(logger);
		expect(runtimeConfig.telemetry).toBe(telemetry);
		expect(runtimeConfig.plugins).toHaveLength(1);
		expect(runtimeConfig.initialMessages).toHaveLength(1);
	});
});

/**
 * The tool-call ceiling reached delegated sub-agents but not the lead agent:
 * `maxToolCalls` lives under `execution` on both the session config and
 * `AgentExecutionConfig`, and nothing copied it onto `AgentRuntimeConfig`. The
 * runtime therefore read `undefined` and applied no cap, while `cline.maxToolCalls`
 * and `--max-tool-calls` looked wired all the way to the config layer.
 *
 * The assertion that matters is the behavioural one -- that a run is actually cut
 * off -- because a field-mapping check would have passed while the feature was
 * dead.
 */

/**
 * Model that always asks for the same tool, so a run can only end through the
 * ceiling. Defined here because the scripted model used by the agents package is
 * local to its own test file and not exported.
 */
class LoopingToolCallModel implements AgentModel {
	private remaining = 50;

	async stream(
		_request: Parameters<AgentModel["stream"]>[0],
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.remaining -= 1;
		if (this.remaining < 0) {
			throw new Error("No scripted model step available");
		}
		const callId = `call-${this.remaining}`;
		async function* events(): AsyncGenerator<AgentModelEvent> {
			yield {
				type: "tool-call-delta",
				toolCallId: callId,
				toolName: "noop",
				inputText: "{}",
			};
			yield { type: "finish", reason: "tool-calls" };
		}
		return events();
	}
}

class StoppingModel implements AgentModel {
	async stream(): Promise<AsyncIterable<AgentModelEvent>> {
		async function* events(): AsyncGenerator<AgentModelEvent> {
			// `text` is not part of a finish event; the run's text comes from the
			// text-delta events that precede it.
			yield { type: "text-delta", text: "done" };
			yield { type: "finish", reason: "stop" };
		}
		return events();
	}
}

const testAgentConfig = (execution?: {
	maxToolCalls?: number;
}): CreateAgentRuntimeConfigInput["agentConfig"] =>
	({
		systemPrompt: "test",
		...(execution ? { execution } : {}),
	}) as unknown as CreateAgentRuntimeConfigInput["agentConfig"];

const noopTool = {
	name: "noop",
	description: "does nothing",
	inputSchema: { type: "object", properties: {} },
	execute: async () => ({ ok: true }),
} as unknown as NonNullable<CreateAgentRuntimeConfigInput["tools"]>[number];

/**
 * The tool-call ceiling reached delegated sub-agents but not the lead agent.
 * `maxToolCalls` is declared under `execution` on both the session config and
 * `AgentExecutionConfig`, but `createAgentRuntimeConfig` never copied it onto
 * `AgentRuntimeConfig`. The runtime therefore read `undefined` and applied no cap,
 * while `cline.maxToolCalls` and `--max-tool-calls` looked wired all the way down.
 *
 * The existing ceiling tests in the agents package construct `AgentRuntimeConfig`
 * directly, so they passed the whole time this was dead. That is why the assertion
 * here goes through the builder and then actually runs the loop.
 */
describe("tool-call ceiling reaches the runtime", () => {
	it("copies execution.maxToolCalls onto the runtime config", () => {
		const config = createAgentRuntimeConfig({
			agentConfig: testAgentConfig({ maxToolCalls: 3 }),
			agentId: "test",
			model: new StoppingModel(),
		})
		expect(config.maxToolCalls).toBe(3)
	})

	it("honours the top-level AgentConfig spelling as well", () => {
		// `AgentConfig` declares `maxToolCalls` directly as well as under
		// `execution`. Nothing set the top-level one, so a consumer who reached for it
		// had their ceiling silently discarded. Either spelling must now work.
		const config = createAgentRuntimeConfig({
			agentConfig: {
				systemPrompt: "test",
				maxToolCalls: 7,
			} as unknown as CreateAgentRuntimeConfigInput["agentConfig"],
			agentId: "test",
			model: new StoppingModel(),
		})
		expect(config.maxToolCalls).toBe(7)
	})

	it("prefers the top-level spelling when both are present", () => {
		// Most specific wins, and the precedence is pinned so it cannot drift.
		const config = createAgentRuntimeConfig({
			agentConfig: {
				systemPrompt: "test",
				maxToolCalls: 7,
				execution: { maxToolCalls: 3 },
			} as unknown as CreateAgentRuntimeConfigInput["agentConfig"],
			agentId: "test",
			model: new StoppingModel(),
		})
		expect(config.maxToolCalls).toBe(7)
	})
	it("stays undefined when unset, so an uncapped session is not capped", () => {
		// A default injected here would silently limit every session that never
		// asked for a limit.
		expect(
			createAgentRuntimeConfig({
				agentConfig: testAgentConfig(),
				agentId: "test",
				model: new StoppingModel(),
			}).maxToolCalls,
		).toBeUndefined()

		// Unrelated execution settings must not conjure a ceiling.
		expect(
			createAgentRuntimeConfig({
				agentConfig: testAgentConfig({}),
				agentId: "test",
				model: new StoppingModel(),
			}).maxToolCalls,
		).toBeUndefined()
	})

	it("actually refuses further tool calls once the ceiling is reached", async () => {
		const { AgentRuntime } = await import("@cline/agents")

		const runtimeConfig = createAgentRuntimeConfig({
			agentConfig: testAgentConfig({ maxToolCalls: 2 }),
			agentId: "test",
			model: new LoopingToolCallModel(),
			tools: [noopTool],
		})

		const result = await new AgentRuntime(runtimeConfig).run("go")

		// Without the mapping this ends as `failed` -- the model loop runs until the
		// scripted model runs out of steps, because nothing was capping it.
		expect(result.status).toBe("tool_calls_exhausted")
	})

	it("leaves an uncapped session to finish on its own", async () => {
		const { AgentRuntime } = await import("@cline/agents")

		const runtimeConfig = createAgentRuntimeConfig({
			agentConfig: testAgentConfig(),
			agentId: "test",
			model: new StoppingModel(),
			tools: [noopTool],
		})

		const result = await new AgentRuntime(runtimeConfig).run("go")

		expect(runtimeConfig.maxToolCalls).toBeUndefined()
		expect(result.status).not.toBe("tool_calls_exhausted")
	})
})