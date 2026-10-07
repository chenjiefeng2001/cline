import type { AgentConfig } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegatedAgentConfigProvider } from "./delegated-agent";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];

const runMock = vi.fn();
const getAgentIdMock = vi.fn(() => "sub-agent-1");
const getConversationIdMock = vi.fn(() => "conv-sub-1");
const agentConstructorSpy = vi.fn();
const agentConstructorDepsSpy = vi.fn();

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => {
	return {
		SessionRuntime: class MockSessionRuntime {
			constructor(config: unknown, deps: unknown) {
				agentConstructorSpy(config);
				agentConstructorDepsSpy(deps);
			}

			getAgentId(): string {
				return getAgentIdMock();
			}

			getConversationId(): string {
				return getConversationIdMock();
			}

			subscribeEvents(): () => void {
				return () => {};
			}

			async run(input: string): Promise<unknown> {
				return runMock(input);
			}
		},
	};
});

describe("createSpawnAgentTool", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("creates a sub-agent, forwards callbacks, and returns normalized output", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 2,
			finishReason: "completed",
			usage: { inputTokens: 11, outputTokens: 7 },
		});

		const onSubAgentStart = vi.fn();
		const onSubAgentEnd = vi.fn();
		const createSubAgentTools = vi.fn().mockResolvedValue([]);
		const extensions = [
			{
				name: "sample-ext",
				manifest: { capabilities: ["hooks"] },
				hooks: { onEvent: vi.fn() },
			} as AgentExtension,
		];

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
				extensions,
			}),
			defaultMaxIterations: 4,
			createSubAgentTools,
			onSubAgentStart,
			onSubAgentEnd,
		});

		const output = await tool.execute(
			{
				systemPrompt: "You are focused",
				task: "Do delegated work",
			},
			{
				agentId: "parent-1",
				conversationId: "conv-parent",
				iteration: 3,
			},
		);

		expect(createSubAgentTools).toHaveBeenCalledTimes(1);
		expect(runMock).toHaveBeenCalledWith("Do delegated work");
		expect(onSubAgentStart).toHaveBeenCalledTimes(1);
		expect(onSubAgentEnd).toHaveBeenCalledTimes(1);
		expect(output).toEqual({
			text: "sub-agent result",
			iterations: 2,
			finishReason: "completed",
			usage: {
				inputTokens: 11,
				outputTokens: 7,
			},
		});
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				parentAgentId: "parent-1",
				maxIterations: 4,
				extensions,
			}),
		);
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.not.objectContaining({
				prepareTurn: expect.anything(),
			}),
		);
	});

	it("propagates the root session and tool wrapper to delegated agents", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		const wrapTools = vi.fn((tools) => tools);
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
				sessionId: "configured-session",
			}),
			subAgentTools: [],
			wrapTools,
		});

		await tool.execute(
			{ systemPrompt: "System", task: "Task" },
			{
				sessionId: "root-session",
				agentId: "parent-agent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "root-session" }),
		);
		expect(agentConstructorDepsSpy).toHaveBeenCalledWith({ wrapTools });
	});

	it("seeds the delegated agent chain from the parent tool context", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{ systemPrompt: "System", task: "Task" },
			{
				agentId: "grandparent-agent",
				runId: "run-middle",
				rootRunId: "run_root",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				parentAgentId: "grandparent-agent",
				rootRunId: "run_root",
			}),
		);
		// The chain root is carried on the orchestrator deps, never as the
		// child's own first run id.
		expect(agentConstructorDepsSpy).toHaveBeenCalledWith({
			chainRootRunId: "run_root",
		});
	});

	it("uses the parent run id as the chain root for a lead agent", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{ systemPrompt: "System", task: "Task" },
			{ agentId: "lead-agent", runId: "run_lead", iteration: 1 },
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({ rootRunId: "run_lead" }),
		);
		expect(agentConstructorDepsSpy).toHaveBeenCalledWith({
			chainRootRunId: "run_lead",
		});
	});

	it("passes extension hooks through delegated config", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const extensions = [
			{
				name: "before-start-ext",
				manifest: {
					capabilities: ["hooks"],
				},
				hooks: { beforeModel: vi.fn() },
			} as AgentExtension,
		];

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
				extensions,
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "You are focused",
				task: "Do delegated work",
			},
			{
				agentId: "parent-1",
				conversationId: "conv-parent",
				iteration: 3,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				extensions,
			}),
		);
	});

	it("propagates sub-agent errors and still reports onSubAgentEnd", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockRejectedValue(new Error("sub-agent failed"));
		const onSubAgentEnd = vi.fn();

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
			onSubAgentEnd,
		});

		await expect(
			tool.execute(
				{
					systemPrompt: "System",
					task: "Fail task",
				},
				{
					agentId: "parent-2",
					conversationId: "conv-parent",
					iteration: 1,
				},
			),
		).rejects.toThrow("sub-agent failed");

		expect(onSubAgentEnd).toHaveBeenCalledTimes(1);
		expect(onSubAgentEnd).toHaveBeenCalledWith(
			expect.objectContaining({
				parentAgentId: "parent-2",
				error: expect.any(Error),
			}),
		);
	});

	it("leaves maxIterations unset when neither input nor default is provided", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "System",
				task: "Do task",
			},
			{
				agentId: "parent-3",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				maxIterations: undefined,
			}),
		);
	});

	it("appends workspace metadata for cline sub-agents when missing", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const workspaceMetadata = `# Workspace Configuration
{
  "workspaces": {
    "/repo/demo": {
      "hint": "demo"
    }
  }
}`;

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "cline",
				modelId: "anthropic/claude-sonnet-4.6",
				cwd: "/repo/demo",
				workspaceMetadata,
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "You are a specialist teammate.",
				task: "Investigate module boundaries",
			},
			{
				agentId: "parent-4",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: expect.stringContaining(workspaceMetadata),
			}),
		);
	});

	it("does not duplicate workspace metadata for cline sub-agents", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const inputSystemPrompt = `You are a specialist teammate.

# Workspace Configuration
{
  "workspaces": {
    "/repo/demo": {
      "hint": "demo"
    }
  }
}`;

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "cline",
				modelId: "anthropic/claude-sonnet-4.6",
				cwd: "/repo/demo",
				workspaceMetadata: "# Workspace Configuration\n{}",
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: inputSystemPrompt,
				task: "Investigate module boundaries",
			},
			{
				agentId: "parent-5",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: inputSystemPrompt,
			}),
		);
	});

	it("resolves connection settings lazily at execution time", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "cline",
			modelId: "stale-model",
			apiKey: "oauth-access-old",
			temperature: 0.3,
		});
		const updateConnectionDefaults = vi.spyOn(
			configProvider,
			"updateConnectionDefaults",
		);
		configProvider.updateConnectionDefaults({
			apiKey: "oauth-access-new",
			modelId: "updated-model",
		});

		const tool = createSpawnAgentTool({
			configProvider,
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "System",
				task: "Do task",
			},
			{
				agentId: "parent-6",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(updateConnectionDefaults).toHaveBeenCalledTimes(1);
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "oauth-access-new",
				modelId: "updated-model",
				temperature: 0.3,
			}),
		);
	});
});

/**
 * Backgrounding is only safe because of the run registry: without it the child
 * would finish where nobody can read it and its tokens would be spent invisibly.
 * These tests pin that contract, including the abort detail that is easy to get
 * wrong and impossible to notice.
 */
describe("spawn_agent background mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const provider = () =>
		createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "mock-model",
		});

	const resolved = (text: string) => ({
		text,
		iterations: 1,
		finishReason: "completed",
		usage: { inputTokens: 5, outputTokens: 3 },
	});

	it("returns a runId immediately without waiting for the child", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { SubAgentRunRegistry } = await import(
			"../../../runtime/orchestration/subagent-run-registry.js"
		);
		let release: (() => void) | undefined;
		runMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () => resolve(resolved("late answer"));
				}),
		);
		const runs = new SubAgentRunRegistry();
		const tool = createSpawnAgentTool({ configProvider: provider(), runs });

		const output = (await tool.execute(
			{ systemPrompt: "focused", task: "long work", background: true },
			{ agentId: "parent", conversationId: "conv", iteration: 1 },
		)) as unknown as { started: boolean; runId: string };

		// The call must not have waited: that is the entire point.
		expect(output.started).toBe(true);
		expect(output.runId).toBeTruthy();
		expect(runs.get(output.runId)?.status).toBe("running");

		release?.();
		await vi.waitFor(() => expect(runs.get(output.runId)?.status).toBe("completed"));
		expect(runs.get(output.runId)?.resultText).toBe("late answer");
	});

	it("records a failure so the work is not silently lost", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { SubAgentRunRegistry } = await import(
			"../../../runtime/orchestration/subagent-run-registry.js"
		);
		runMock.mockRejectedValue(new Error("provider 500"));
		const runs = new SubAgentRunRegistry();
		const tool = createSpawnAgentTool({ configProvider: provider(), runs });

		const output = (await tool.execute(
			{ systemPrompt: "focused", task: "doomed work", background: true },
			{ agentId: "parent", conversationId: "conv", iteration: 1 },
		)) as unknown as { runId: string };

		await vi.waitFor(() =>
			expect(runs.get(output.runId)?.status).toBe("failed"),
		);
		expect(runs.get(output.runId)?.error).toContain("provider 500");
	});

	it("does NOT inherit the parent turn's abort signal", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { SubAgentRunRegistry } = await import(
			"../../../runtime/orchestration/subagent-run-registry.js"
		);
		runMock.mockResolvedValue(resolved("done"));
		const runs = new SubAgentRunRegistry();
		const tool = createSpawnAgentTool({ configProvider: provider(), runs });
		const controller = new AbortController();

		await tool.execute(
			{ systemPrompt: "focused", task: "background work", background: true },
			{
				agentId: "parent",
				conversationId: "conv",
				iteration: 1,
				signal: controller.signal,
			},
		);

		// Inheriting it would abort the child the moment the starting turn ended,
		// which is the opposite of backgrounding.
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.not.objectContaining({ abortSignal: expect.anything() }),
		);
	});

	it("still inherits the abort signal for a normal blocking spawn", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue(resolved("done"));
		const tool = createSpawnAgentTool({ configProvider: provider() });
		const controller = new AbortController();

		await tool.execute(
			{ systemPrompt: "focused", task: "blocking work" },
			{
				agentId: "parent",
				conversationId: "conv",
				iteration: 1,
				signal: controller.signal,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({ abortSignal: controller.signal }),
		);
	});

	it("refuses backgrounding when no registry is configured", async () => {
		// Falling back to a blocking run would ignore what the caller asked for,
		// and running detached would lose the result. Both are worse than failing.
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const tool = createSpawnAgentTool({ configProvider: provider() });
		await expect(
			tool.execute(
				{ systemPrompt: "focused", task: "work", background: true },
				{ agentId: "parent", conversationId: "conv", iteration: 1 },
			),
		).rejects.toThrow(/run registry/i);
		expect(runMock).not.toHaveBeenCalled();
	});

	it("still forwards lifecycle callbacks for a background run", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { SubAgentRunRegistry } = await import(
			"../../../runtime/orchestration/subagent-run-registry.js"
		);
		runMock.mockResolvedValue(resolved("answer"));
		const onSubAgentStart = vi.fn();
		const onSubAgentEnd = vi.fn();
		const tool = createSpawnAgentTool({
			configProvider: provider(),
			runs: new SubAgentRunRegistry(),
			onSubAgentStart,
			onSubAgentEnd,
		});

		await tool.execute(
			{ systemPrompt: "focused", task: "work", background: true },
			{ agentId: "parent", conversationId: "conv", iteration: 1 },
		);

		await vi.waitFor(() => expect(onSubAgentEnd).toHaveBeenCalledTimes(1));
		expect(onSubAgentStart).toHaveBeenCalledTimes(1);
	});

	it("labels a run from the task when no label is given", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { SubAgentRunRegistry } = await import(
			"../../../runtime/orchestration/subagent-run-registry.js"
		);
		runMock.mockResolvedValue(resolved("done"));
		const runs = new SubAgentRunRegistry();
		const tool = createSpawnAgentTool({ configProvider: provider(), runs });

		const output = (await tool.execute(
			{ systemPrompt: "f", task: "Check the auth flow", background: true },
			{ agentId: "parent", conversationId: "conv", iteration: 1 },
		)) as unknown as { label: string };
		// Status listings are unreadable if every row is blank.
		expect(output.label).toBe("Check the auth flow");
	});
});