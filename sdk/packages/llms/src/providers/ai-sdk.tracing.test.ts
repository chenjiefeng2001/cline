import type {
	AgentModelEvent,
	GatewayProviderContext,
	GatewayStreamRequest,
} from "@cline/shared";
import { context, trace } from "@opentelemetry/api";
import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

const { createOpenAICompatibleProvider } = await import("./ai-sdk");

const sseBody = [
	`data: ${JSON.stringify({
		id: "completion-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "test-model",
		choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }],
	})}\n\n`,
	`data: ${JSON.stringify({
		id: "completion-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "test-model",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	})}\n\n`,
	"data: [DONE]\n\n",
].join("");

describe("ai-sdk tracing", () => {
	beforeEach(() => {
		exporter.reset();
	});

	afterAll(async () => {
		await provider.shutdown();
	});

	it("parents llm.request to the active agent context", async () => {
		const config = {
			providerId: "openai-compatible",
			apiKey: "test-key",
			baseUrl: "http://fake.local/v1",
			fetch: (async () =>
				new Response(sseBody, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				})) as unknown as typeof fetch,
		};
		const model = {
			id: "test-model",
			providerId: "openai-compatible",
			name: "test-model",
		};
		const providerContext = {
			provider: {
				id: "openai-compatible",
				name: "OpenAI Compatible",
				defaultModelId: "test-model",
				models: [model],
			},
			model,
			config,
		} as unknown as GatewayProviderContext;
		const request = {
			providerId: "openai-compatible",
			modelId: "test-model",
			messages: [
				{
					id: "user-1",
					role: "user",
					content: [{ type: "text", text: "hello" }],
					createdAt: Date.now(),
				},
			],
			tools: [],
		} as unknown as GatewayStreamRequest;
		const modelProvider = await createOpenAICompatibleProvider(config);
		const parentSpan = provider.getTracer("test").startSpan("agent.run");
		const events: AgentModelEvent[] = [];

		await context.with(
			trace.setSpan(context.active(), parentSpan),
			async () => {
				for await (const event of await modelProvider.stream(
					request,
					providerContext,
				)) {
					events.push(event);
				}
			},
		);
		parentSpan.end();

		const requestSpan = exporter
			.getFinishedSpans()
			.find((span) => span.name === "llm.request");

		expect(events.at(-1)?.type).toBe("finish");
		expect(requestSpan).toBeDefined();
		expect(requestSpan?.spanContext().traceId).toBe(
			parentSpan.spanContext().traceId,
		);
		expect(requestSpan?.parentSpanContext?.spanId).toBe(
			parentSpan.spanContext().spanId,
		);
	});
});
