import { describe, expect, it } from "vitest";
import {
	createRunStateBatchResume,
	isRunStateBatchResume,
	MAX_RUN_STATE_BYTES,
	MAX_RUN_STATE_RESUME_STEPS,
	parseRunState,
	RUN_STATE_KIND,
	RUN_STATE_VERSION,
	type RunState,
	type RunStateToolCallBatchStep,
	type RunStateToolCallResume,
	runStateResumeSteps,
	runStateStepForRecord,
	serializeRunState,
} from "./run-state";

function toolCallResume(
	overrides: Partial<RunStateToolCallResume> = {},
): RunStateToolCallResume {
	return {
		type: "tool_call",
		sessionId: "session-1",
		runId: "run-1",
		agentId: "agent-1",
		conversationId: "conversation-1",
		iteration: 1,
		toolCallIndex: 0,
		assistantMessageId: "assistant-1",
		toolCallId: "call-1",
		toolName: "read_files",
		approvalId: "approval-1",
		preparedInputHash: "0123456789abcdef0123456789abcdef",
		...overrides,
	};
}

function state(overrides: Partial<RunState> = {}): RunState {
	return {
		kind: RUN_STATE_KIND,
		version: RUN_STATE_VERSION,
		capturedAt: "2026-09-25T00:00:00.000Z",
		source: "cli",
		interactive: false,
		resume: toolCallResume(),
		transcript: {
			messageCount: 2,
			lastMessageId: "assistant-1",
			transcriptHash: "0123456789abcdef0123456789abcdef",
			systemPromptHash: "0123456789abcdef0123456789abcdef",
		},
		config: {
			providerId: "provider-1",
			modelId: "model-1",
			cwd: "/workspace",
			workspaceRoot: "/workspace",
			systemPrompt: "system prompt",
			mode: "act",
			enableTools: true,
			enableSpawnAgent: false,
			enableAgentTeams: false,
			toolExecution: "sequential",
		},
		...overrides,
	};
}

function batchStep(
	index: number,
	overrides: Partial<RunStateToolCallBatchStep> = {},
): RunStateToolCallBatchStep {
	return {
		stepId: `step:run-1:1:${index}`,
		toolCallIndex: index,
		toolCallId: `call-${index + 1}`,
		toolName: "read_files",
		approvalId: `approval-${index + 1}`,
		preparedInputHash: "0123456789abcdef0123456789abcdef",
		...overrides,
	};
}

function batchState(steps: RunStateToolCallBatchStep[]): RunState {
	return state({
		resume: {
			type: "tool_call_batch",
			sessionId: "session-1",
			runId: "run-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			iteration: 1,
			assistantMessageId: "assistant-1",
			steps,
		},
	});
}

describe("run state", () => {
	it("round-trips a strict versioned tool-call state", () => {
		const value = state({
			recoveryOwner: "owner-1",
			serverRuntime: {
				configExtensions: ["rules", "skills"],
				skills: ["review"],
				sourceReference: {
					version: 1,
					algorithm: "sha256",
					digest: "a".repeat(64),
				},
			},
		});
		const serialized = serializeRunState(value);
		expect(parseRunState(serialized)).toEqual(value);
		expect(serialized).not.toContain("secret");
	});

	it("round-trips a parallel tool execution state and rejects unknown modes", () => {
		const parallel = state({
			config: { ...state().config, toolExecution: "parallel" },
		});
		expect(
			parseRunState(serializeRunState(parallel)).config.toolExecution,
		).toBe("parallel");
		expect(() =>
			parseRunState(
				JSON.stringify({
					...state(),
					config: { ...state().config, toolExecution: "concurrent" },
				}),
			),
		).toThrow("toolExecution");
	});

	it("rejects unknown fields, unsupported versions, and invalid hashes", () => {
		for (const value of [
			{ ...state(), unexpected: "secret" },
			{ ...state(), version: 2 },
			{
				...state(),
				resume: toolCallResume({ preparedInputHash: "bad" }),
			},
			{
				...state(),
				transcript: {
					...state().transcript,
					transcriptHash: "bad",
				},
			},
		]) {
			expect(() => parseRunState(JSON.stringify(value))).toThrow();
		}
	});

	it("round-trips a persisted step identity", () => {
		const value = state({
			resume: toolCallResume({ stepId: "step:run-1:1:0" }),
		});
		const parsed = parseRunState(serializeRunState(value));
		expect(isRunStateBatchResume(parsed.resume)).toBe(false);
		expect(runStateResumeSteps(parsed.resume)[0]?.stepId).toBe(
			"step:run-1:1:0",
		);
	});

	it("rejects malformed step identities", () => {
		for (const stepId of [
			"step-1-1-0",
			"step:run 1:1:0",
			"step::1:0",
			"step:run-1:x:0",
			"step:run-1:1",
			"step:run-1:1:0:extra",
			42,
		]) {
			expect(() =>
				parseRunState(
					JSON.stringify({
						...state(),
						resume: { ...toolCallResume(), stepId },
					}),
				),
			).toThrow("resume.stepId");
		}
	});

	it("rejects unsupported JSON values before serialization", () => {
		const functionValue = state() as RunState & { callback?: unknown };
		functionValue.callback = () => "secret";
		expect(() => serializeRunState(functionValue)).toThrow();

		const bigintValue = state() as RunState & { count?: unknown };
		bigintValue.count = 1n;
		expect(() => serializeRunState(bigintValue)).toThrow();

		const cyclicValue = state() as RunState & { self?: unknown };
		cyclicValue.self = cyclicValue;
		expect(() => serializeRunState(cyclicValue)).toThrow();

		const nonFiniteValue = state() as RunState & { count?: unknown };
		nonFiniteValue.count = Number.NaN;
		expect(() => serializeRunState(nonFiniteValue)).toThrow();
	});

	it("rejects oversized state and source-like fields", () => {
		const oversized = state({
			config: {
				...state().config,
				systemPrompt: "x".repeat(MAX_RUN_STATE_BYTES + 1),
			},
		});
		expect(() => serializeRunState(oversized)).toThrow();

		const sourceValue = state() as RunState & { instructions?: unknown };
		sourceValue.instructions = "source secret";
		expect(() => serializeRunState(sourceValue)).toThrow();
	});

	it("rejects invalid tool policies and server runtime selectors", () => {
		const prototypePolicy = JSON.parse(
			'{"__proto__":{"enabled":true}}',
		) as Record<string, unknown>;
		expect(() =>
			parseRunState(
				JSON.stringify({
					...state(),
					config: {
						...state().config,
						toolPolicies: prototypePolicy,
					},
				}),
			),
		).not.toThrow();
		expect(() =>
			parseRunState(
				JSON.stringify({
					...state(),
					config: {
						...state().config,
						toolPolicies: { read_files: { enabled: "yes" } },
					},
				}),
			),
		).toThrow();
		expect(() =>
			parseRunState(
				JSON.stringify({
					...state(),
					serverRuntime: {
						configExtensions: ["plugins"],
					},
				}),
			),
		).toThrow();
	});

	it("round-trips a turn-level batch cursor", () => {
		const value = batchState([batchStep(0), batchStep(1)]);
		const parsed = parseRunState(serializeRunState(value));
		expect(isRunStateBatchResume(parsed.resume)).toBe(true);
		expect(parsed.resume).toEqual(value.resume);
		expect(
			runStateStepForRecord(parsed, {
				toolCallIndex: 1,
				toolCallId: "call-2",
				toolName: "read_files",
				approvalId: "approval-2",
				preparedInputHash: "0123456789abcdef0123456789abcdef",
			})?.stepId,
		).toBe("step:run-1:1:1");
		expect(
			runStateStepForRecord(parsed, {
				toolCallIndex: 0,
				toolCallId: "call-1",
				toolName: "read_files",
				approvalId: "approval-1",
				preparedInputHash: "ffffffffffffffffffffffffffffffff",
			}),
		).toBeUndefined();
	});

	it("builds a batch cursor from a per-step cursor", () => {
		const batch = createRunStateBatchResume(toolCallResume(), [
			batchStep(0),
			batchStep(1),
		]);
		expect(batch.type).toBe("tool_call_batch");
		expect(batch.steps).toHaveLength(2);
		expect(() =>
			createRunStateBatchResume(toolCallResume(), [batchStep(1)]),
		).toThrow("toolCallIndex must be 0");
	});

	it("rejects incomplete, duplicated, and oversized batch cursors", () => {
		const cases: [string, unknown][] = [
			["1 to", batchState([])],
			[
				"duplicate approval",
				batchState([batchStep(0), batchStep(1, { approvalId: "approval-1" })]),
			],
			[
				"duplicate tool call",
				batchState([batchStep(0), batchStep(1, { toolCallId: "call-1" })]),
			],
			[
				"duplicate step",
				batchState([batchStep(0), batchStep(1, { stepId: "step:run-1:1:0" })]),
			],
			[
				"must contain 1 to",
				batchState(
					Array.from({ length: MAX_RUN_STATE_RESUME_STEPS + 1 }, (_, index) =>
						batchStep(index),
					),
				),
			],
		];
		for (const [message, value] of cases) {
			expect(() => parseRunState(JSON.stringify(value))).toThrow(message);
		}
		const unknownStepField = batchState([batchStep(0)]);
		(
			unknownStepField.resume as unknown as {
				steps: Record<string, unknown>[];
			}
		).steps[0] = { ...batchStep(0), input: { path: "secret" } };
		expect(() => parseRunState(JSON.stringify(unknownStepField))).toThrow(
			"unsupported field",
		);
	});

	it("normalizes a single tool-call cursor into one resume step", () => {
		expect(
			runStateResumeSteps(toolCallResume({ stepId: "step:run-1:1:0" })),
		).toEqual([
			{
				stepId: "step:run-1:1:0",
				toolCallIndex: 0,
				toolCallId: "call-1",
				toolName: "read_files",
				approvalId: "approval-1",
				preparedInputHash: "0123456789abcdef0123456789abcdef",
			},
		]);
	});

	it("round-trips a serializable agent block", () => {
		const value = state({
			agent: {
				agentId: "agent-2",
				agentRole: "reviewer",
				parentAgentId: "agent-1",
				rootRunId: "run-root",
			},
		});
		const parsed = parseRunState(serializeRunState(value));
		expect(parsed.agent).toEqual(value.agent);
	});

	it("rejects inconsistent agent identities", () => {
		for (const agent of [
			{ agentId: "" },
			{ agentId: "agent-1", parentAgentId: "agent-1" },
			{ agentId: "agent-1", rootRunId: "run-root" },
			{ agentId: "agent-1", agentRole: "x".repeat(65) },
			{ agentId: "agent-1", unexpected: "secret" },
		]) {
			expect(() =>
				parseRunState(JSON.stringify({ ...state(), agent })),
			).toThrow();
		}
	});

	it("round-trips a run budget so a resumed run keeps its guardrail", () => {
		const value = state({
			config: {
				...state().config,
				budget: { maxTotalTokens: 120_000, maxTotalCost: 2.5 },
			},
		});
		const parsed = parseRunState(serializeRunState(value));
		expect(parsed.config.budget).toEqual({
			maxTotalTokens: 120_000,
			maxTotalCost: 2.5,
		});
	});

	it("rejects a malformed run budget instead of dropping the guardrail", () => {
		for (const budget of [
			{ maxTotalTokens: 0 },
			{ maxTotalTokens: -1 },
			{ maxTotalCost: Number.POSITIVE_INFINITY },
			{ maxCalls: 3 },
			"nope",
		]) {
			expect(() =>
				parseRunState(
					JSON.stringify({ ...state(), config: { ...state().config, budget } }),
				),
			).toThrow();
		}
	});
});
