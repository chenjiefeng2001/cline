/**
 * Deterministic agent conformance cases.
 *
 * The model-based smoke tests under `evals/` need a live provider, so they
 * cannot gate a pull request: they are slow, need a secret that forks do not
 * have, and vary run to run. This suite is the layer that *can* gate a PR. Every
 * case runs offline against a scripted model and asserts one behavioural
 * guarantee of the agent runtime contract.
 *
 * The two properties that make this usable as a gate:
 *
 * - **No flakes.** Nothing here touches the network, a clock-sensitive
 *   assertion, or a real model, so a failure is a behaviour change rather than
 *   noise. A red gate can be trusted without a re-run.
 * - **Coverage cannot be silently deleted.** A case that is removed or renamed
 *   would otherwise turn the gate green. `CONFORMANCE_BASELINE` pins the case
 *   ids, and the suite fails when the registry and the baseline disagree.
 *   Widening the contract is an explicit baseline edit.
 *
 * Each case is a pure assertion over a scripted runtime, so adding a guarantee
 * means adding one entry here rather than inventing a runner.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentRuntime } from "@cline/agents";
import { resolveBoundedPath } from "../extensions/tools/executors/file-boundary"
import type { FileBoundary } from "../extensions/tools/executors/file-boundary"
import type {
	AgentMessage,
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentTool,
	AgentToolContext,
} from "@cline/shared";

/** A scripted model step: turn a request into a fixed event sequence. */
type ModelStep = (
	request: AgentModelRequest,
) => Iterable<AgentModelEvent> | AsyncIterable<AgentModelEvent>;

class ScriptedModel implements AgentModel {
	public readonly requests: AgentModelRequest[] = [];

	constructor(private readonly steps: ModelStep[]) {}

	async stream(
		request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		this.requests.push(request);
		const step = this.steps.shift();
		if (!step) {
			throw new Error("Scripted model ran out of steps");
		}
		return (async function* () {
			for await (const event of step(request)) {
				yield event;
			}
		})();
	}
}

export interface ConformanceContext {
	/** Text the model "emitted" on the final turn, for assertions. */
	outputText: string;
	/** The finished transcript, for tool-result assertions. */
	messages: readonly AgentMessage[];
	/** Tool inputs the tools under test actually received. */
	toolContexts: AgentToolContext[];
	/** Tool results the runtime produced, in order. */
	toolResultOutputs: unknown[];
	/** One entry per model request, so request counts are assertable. */
	modelRequests: AgentModelRequest[];
	/** The runtime under test, for cases that need its public surface. */
	runtime: ReturnType<typeof createAgentRuntime>;
}

export interface ConformanceCase {
	/** Stable identifier. Pinned by the baseline; do not rename casually. */
	id: string;
	/** The guarantee this case defends. */
	guarantee: string;
	/** Names the security/architecture boundary, so the audit trail can group them. */
	boundary:
		| "runtime-contract"
		| "spend-governance"
		| "tool-contract"
		| "hub-authorization"
		| "file-boundary"
		| "projection-boundary";
	run: () => Promise<ConformanceContext>;
}

function textDelta(text: string): AgentModelEvent {
	return { type: "text-delta", text };
}

function finish(reason: "stop" | "tool-calls" = "stop"): AgentModelEvent {
	return { type: "finish", reason };
}

function toolCall(
	toolCallId: string,
	toolName: string,
	input: Record<string, unknown>,
): AgentModelEvent[] {
	return [
		{
			type: "tool-call-delta",
			toolCallId,
			toolName,
			inputText: JSON.stringify(input),
		},
	];
}

function usage(
	inputTokens: number,
	outputTokens: number,
	totalCost?: number,
): AgentModelEvent {
	return {
		type: "usage",
		usage: {
			inputTokens,
			outputTokens,
			...(totalCost === undefined ? {} : { totalCost }),
		},
	};
}

function recordingTool(
	name: string,
	toolContexts: AgentToolContext[],
	toolResultOutputs: unknown[],
): AgentTool<unknown, { echoed: unknown }> {
	return {
		name,
		description: `Conformance tool ${name}`,
		inputSchema: { type: "object" },
		execute: async (input: unknown, context) => {
			toolContexts.push(context);
			const output = { echoed: input };
			toolResultOutputs.push(output);
			return output;
		},
	};
}

function createHarness(options: {
	steps: ModelStep[];
	tools?: AgentTool[];
	toolPolicies?: Record<string, { autoApprove?: boolean; enabled?: boolean }>;
	maxIterations?: number;
	budget?: Parameters<typeof createAgentRuntime>[0]["budget"];
	parentAgentId?: string;
	rootRunId?: string;
}) {
	const toolContexts: AgentToolContext[] = [];
	const toolResultOutputs: unknown[] = [];
	const model = new ScriptedModel(options.steps);
	const runtime = createAgentRuntime({
		sessionId: "conformance-session",
		agentId: "conformance-agent",
		conversationId: "conformance-conversation",
		model,
		tools: options.tools ?? [],
		...(options.toolPolicies ? { toolPolicies: options.toolPolicies } : {}),
		...(options.maxIterations === undefined
			? {}
			: { maxIterations: options.maxIterations }),
		...(options.budget === undefined ? {} : { budget: options.budget }),
		...(options.parentAgentId === undefined
			? {}
			: { parentAgentId: options.parentAgentId }),
		...(options.rootRunId === undefined
			? {}
			: { rootRunId: options.rootRunId }),
	});
	return { runtime, model, toolContexts, toolResultOutputs };
}

async function runHarness(
	options: Parameters<typeof createHarness>[0],
	input = "go",
): Promise<ConformanceContext> {
	const { runtime, model, toolContexts, toolResultOutputs } =
		createHarness(options);
	const result = await runtime.run(input);
	return {
		outputText: result.outputText,
		messages: result.messages,
		toolContexts,
		toolResultOutputs,
		modelRequests: model.requests,
		runtime,
	};
}

/** Tool-result parts of a finished transcript, in order. */
function toolResults(
	messages: readonly AgentMessage[],
): Array<Record<string, unknown>> {
	return messages
		.filter((message) => message.role === "tool")
		.flatMap((message) => message.content)
		.filter(
			(part): part is Extract<typeof part, { type: "tool-result" }> =>
				part.type === "tool-result",
		) as unknown as Array<Record<string, unknown>>;
}

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
	{
		id: "tool-result-completeness-single-tool",
		boundary: "tool-contract",
		guarantee:
			"A tool call always produces a tool result in the transcript the provider will see, so no turn is left unanswered.",
		async run() {
			const toolContexts: AgentToolContext[] = [];
			const toolResultOutputs: unknown[] = [];
			const { runtime, model } = createHarness({
				steps: [
					() => [
						...toolCall("call-1", "echo", { text: "one" }),
						finish("tool-calls"),
					],
					() => [textDelta("done"), finish()],
				],
				tools: [recordingTool("echo", toolContexts, toolResultOutputs)],
			});
			const result = await runtime.run("go");
			return {
				outputText: result.outputText,
				messages: result.messages,
				toolContexts,
				toolResultOutputs,
				modelRequests: model.requests,
				runtime,
			};
		},
	},
	{
		id: "budget-stops-before-next-model-request",
		boundary: "spend-governance",
		guarantee:
			"A reached run budget finishes the in-flight turn, keeps its tool result, and refuses another model request.",
		async run() {
			const toolContexts: AgentToolContext[] = [];
			const toolResultOutputs: unknown[] = [];
			const { runtime, model } = createHarness({
				steps: [
					() => [
						usage(100, 20, 0.5),
						...toolCall("call-1", "echo", { text: "one" }),
						finish("tool-calls"),
					],
				],
				tools: [recordingTool("echo", toolContexts, toolResultOutputs)],
				budget: { maxTotalTokens: 100 },
			});
			const result = await runtime.run("go");
			return {
				outputText: result.outputText,
				messages: result.messages,
				toolContexts,
				toolResultOutputs,
				modelRequests: model.requests,
				runtime,
			};
		},
	},
	{
		id: "budget-absent-does-not-gate",
		boundary: "spend-governance",
		guarantee:
			"With no budget configured the loop is never gated on spend, so adding the guardrail cannot silently truncate existing runs.",
		async run() {
			return runHarness({
				steps: [
					() => [
						...toolCall("call-1", "echo", { text: "one" }),
						finish("tool-calls"),
					],
					() => [textDelta("done"), finish()],
				],
				tools: [recordingTool("echo", [], [])],
			});
		},
	},
	{
		id: "parallel-tool-batch-settles-before-run-ends",
		boundary: "tool-contract",
		guarantee:
			"Every tool call in a multi-tool turn receives a tool result before the run returns, so no provider sees an unanswered tool call.",
		async run() {
			const toolContexts: AgentToolContext[] = [];
			const toolResultOutputs: unknown[] = [];
			const { runtime, model } = createHarness({
				steps: [
					() => [
						...toolCall("call-1", "echo", { text: "a" }),
						...toolCall("call-2", "echo", { text: "b" }),
						finish("tool-calls"),
					],
					() => [textDelta("done"), finish()],
				],
				tools: [recordingTool("echo", toolContexts, toolResultOutputs)],
			});
			const result = await runtime.run("go");
			return {
				outputText: result.outputText,
				messages: result.messages,
				toolContexts,
				toolResultOutputs,
				modelRequests: model.requests,
				runtime,
			};
		},
	},
	{
		id: "tool-context-carries-stable-step-identity",
		boundary: "tool-contract",
		guarantee:
			"Each tool call carries a stable stepId so an effect can be reconciled to the exact step across a restart.",
		async run() {
			const toolContexts: AgentToolContext[] = [];
			const toolResultOutputs: unknown[] = [];
			const { runtime, model } = createHarness({
				steps: [
					() => [
						...toolCall("call-1", "echo", { text: "one" }),
						finish("tool-calls"),
					],
					() => [textDelta("done"), finish()],
				],
				tools: [recordingTool("echo", toolContexts, toolResultOutputs)],
			});
			await runtime.run("go");
			return {
				outputText: "",
				messages: runtime.snapshot().messages,
				toolContexts,
				toolResultOutputs,
				modelRequests: model.requests,
				runtime,
			};
		},
	},
	{
		id: "delegated-run-reports-its-agent-chain",
		boundary: "runtime-contract",
		guarantee:
			"A delegated agent reports its parent and chain-root run through tool context, so a durable host can describe the chain it cannot rebuild.",
		async run() {
			const toolContexts: AgentToolContext[] = [];
			const toolResultOutputs: unknown[] = [];
			const { runtime, model } = createHarness({
				steps: [
					() => [
						...toolCall("call-1", "echo", { text: "one" }),
						finish("tool-calls"),
					],
					() => [textDelta("done"), finish()],
				],
				tools: [recordingTool("echo", toolContexts, toolResultOutputs)],
				parentAgentId: "conformance-parent",
				rootRunId: "conformance-root-run",
			});
			await runtime.run("go");
			return {
				outputText: "",
				messages: runtime.snapshot().messages,
				toolContexts,
				toolResultOutputs,
				modelRequests: model.requests,
				runtime,
			};
		},
	},
	{
		id: "lead-run-reports-no-agent-chain",
		boundary: "runtime-contract",
		guarantee:
			"A lead agent reports no parent or chain root, so ownership is never inferred for a session's own agent.",
		async run() {
			const toolContexts: AgentToolContext[] = [];
			const toolResultOutputs: unknown[] = [];
			const { runtime, model } = createHarness({
				steps: [
					() => [
						...toolCall("call-1", "echo", { text: "one" }),
						finish("tool-calls"),
					],
					() => [textDelta("done"), finish()],
				],
				tools: [recordingTool("echo", toolContexts, toolResultOutputs)],
			});
			await runtime.run("go");
			return {
				outputText: "",
				messages: runtime.snapshot().messages,
				toolContexts,
				toolResultOutputs,
				modelRequests: model.requests,
				runtime,
			};
		},
	},
	{
		id: "file-boundary-refuses-path-that-escapes-the-root",
		boundary: "file-boundary",
		guarantee:
			"A path the model supplies that resolves outside every configured root is refused inside the tool, so the refusal reaches the model as a tool error and never as file contents.",
		async run() {
			// Real directories, not placeholders: containment is checked by realpath,
			// which throws for a root that does not exist. A fake root would make the
			// boundary refuse everything and the case would pass for the wrong reason.
			const dirs = makeBoundaryFixture();
			const toolContexts: AgentToolContext[] = [];
			const toolResultOutputs: unknown[] = [];
			const { runtime, model } = createHarness({
				steps: [
					() => [
						...toolCall("call-1", "read_bounded", {
							path: join(dirs.cwd, "..", "outside", "secret.txt"),
						}),
						finish("tool-calls"),
					],
					() => [textDelta("done"), finish()],
				],
				tools: [boundaryTool("read_bounded", dirs.cwd, { root: dirs.root }, toolContexts, toolResultOutputs)],
			});
			const result = await runtime.run("go");
			await dirs.dispose();
			return {
				outputText: result.outputText,
				messages: result.messages,
				toolContexts,
				toolResultOutputs,
				modelRequests: model.requests,
				runtime,
			};
		},
	},
	{
		id: "file-boundary-honours-configured-additional-roots",
		boundary: "file-boundary",
		guarantee:
			"A path inside a configured additional root is allowed, so an opt-in multi-root workspace stays usable without the boundary being widened by default.",
		async run() {
			const dirs = makeBoundaryFixture();
			const toolContexts: AgentToolContext[] = [];
			const toolResultOutputs: unknown[] = [];
			const { runtime, model } = createHarness({
				steps: [
					() => [
						...toolCall("call-1", "read_bounded", {
							path: join(dirs.shared, "notes.md"),
						}),
						finish("tool-calls"),
					],
					() => [textDelta("done"), finish()],
				],
				tools: [
					boundaryTool(
						"read_bounded",
						dirs.cwd,
						{ root: dirs.root, additionalRoots: [dirs.shared] },
						toolContexts,
						toolResultOutputs,
					),
				],
			});
			const result = await runtime.run("go");
			await dirs.dispose();
			return {
				outputText: result.outputText,
				messages: result.messages,
				toolContexts,
				toolResultOutputs,
				modelRequests: model.requests,
				runtime,
			};
		},
	},
];

/**
 * Real directory tree for the boundary cases: a workspace root, a sibling that is
 * permitted only when configured, and a sibling that is never permitted.
 */
function makeBoundaryFixture() {
	const base = mkdtempSync(join(tmpdir(), "conformance-boundary-"))
	const root = join(base, "workspace")
	const shared = join(base, "shared")
	const outside = join(base, "outside")
	for (const dir of [root, shared, outside]) {
		mkdirSync(dir)
	}
	return {
		base,
		root,
		shared,
		outside,
		cwd: root,
		dispose: () => rmSync(base, { recursive: true, force: true }),
	}
}

/**
 * A tool that resolves its input against a real file boundary.
 *
 * Uses the shipped resolver rather than a re-implementation, so the case fails if
 * the boundary's behaviour drifts - which is the point of pinning it now that the
 * boundary is live.
 */
function boundaryTool(
	name: string,
	cwd: string,
	boundary: FileBoundary,
	toolContexts: AgentToolContext[],
	toolResultOutputs: unknown[],
): AgentTool<unknown, { echoed: unknown }> {
	return {
		name,
		description: `Conformance tool ${name}`,
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
		execute: async (input: unknown, context) => {
			toolContexts.push(context);
			const target = (input as { path: string }).path;
			const output = { echoed: await resolveBoundedPath(cwd, target, boundary) };
			toolResultOutputs.push(output);
			return output;
		},
	}
}

export { toolResults, ScriptedModel };
