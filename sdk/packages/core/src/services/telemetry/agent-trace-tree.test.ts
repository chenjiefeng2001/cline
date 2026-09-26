import type { AgentModel, AgentModelEvent, AgentTool } from "@cline/shared";
import { context, trace } from "@opentelemetry/api";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

const { AgentRuntime } = await import("@cline/agents");

class ToolCallingModel implements AgentModel {
	private turn = 0;

	async *stream(): AsyncIterable<AgentModelEvent> {
		if (this.turn === 0) {
			this.turn += 1;
			yield {
				type: "tool-call-delta",
				toolCallId: "trace-tool-call",
				toolName: "trace_tool",
				inputText: "{}",
			};
			yield { type: "finish", reason: "tool-calls" };
			return;
		}
		yield { type: "text-delta", text: "done" };
		yield { type: "finish", reason: "stop" };
	}
}

class TextModel implements AgentModel {
	constructor(private readonly text: string) {}

	async *stream(): AsyncIterable<AgentModelEvent> {
		yield { type: "text-delta", text: this.text };
		yield { type: "finish", reason: "stop" };
	}
}

describe("Agent trace tree", () => {
	beforeEach(() => {
		exporter.reset();
	});

	afterAll(async () => {
		await provider.shutdown();
	});

	it("parents the agent run and tool spans to the active context", async () => {
		const tool: AgentTool = {
			name: "trace_tool",
			description: "Trace tool",
			inputSchema: { type: "object" },
			execute: async () => ({ ok: true }),
		};
		const runtime = new AgentRuntime({
			agentId: "trace-agent",
			model: new ToolCallingModel(),
			tools: [tool],
		});
		const externalSpan = provider.getTracer("test").startSpan("external");

		await context.with(trace.setSpan(context.active(), externalSpan), () =>
			runtime.run("Start"),
		);
		externalSpan.end();

		const spans = exporter.getFinishedSpans();
		const runSpan = spans.find((span) => span.name === "agent.run");
		const toolSpan = spans.find((span) => span.name === "agent.tool");
		const externalSpanId = externalSpan.spanContext().spanId;

		expect(runSpan).toBeDefined();
		expect(toolSpan).toBeDefined();
		expect(runSpan?.spanContext().traceId).toBe(
			externalSpan.spanContext().traceId,
		);
		expect(runSpan?.parentSpanContext?.spanId).toBe(externalSpanId);
		expect(toolSpan?.spanContext().traceId).toBe(
			runSpan?.spanContext().traceId,
		);
		expect(toolSpan?.parentSpanContext?.spanId).toBe(
			runSpan?.spanContext().spanId,
		);
	});

	it("inherits the tool context into a nested agent run", async () => {
		const nestedRuntime = new AgentRuntime({
			agentId: "nested-agent",
			model: new TextModel("nested done"),
		});
		const tool: AgentTool = {
			name: "trace_tool",
			description: "Trace tool",
			inputSchema: { type: "object" },
			execute: async () => {
				const result = await nestedRuntime.run("Nested");
				return { output: result.outputText };
			},
		};
		const runtime = new AgentRuntime({
			agentId: "outer-agent",
			model: new ToolCallingModel(),
			tools: [tool],
		});

		await runtime.run("Start");

		const spans = exporter.getFinishedSpans();
		const outerRun = spans.find(
			(span) =>
				span.name === "agent.run" &&
				span.attributes["agent.id"] === "outer-agent",
		);
		const toolSpan = spans.find((span) => span.name === "agent.tool");
		const nestedRun = spans.find(
			(span) =>
				span.name === "agent.run" &&
				span.attributes["agent.id"] === "nested-agent",
		);

		expect(outerRun).toBeDefined();
		expect(toolSpan).toBeDefined();
		expect(nestedRun).toBeDefined();
		expect(toolSpan?.parentSpanContext?.spanId).toBe(
			outerRun?.spanContext().spanId,
		);
		expect(nestedRun?.spanContext().traceId).toBe(
			outerRun?.spanContext().traceId,
		);
		expect(nestedRun?.parentSpanContext?.spanId).toBe(
			toolSpan?.spanContext().spanId,
		);
	});
});
