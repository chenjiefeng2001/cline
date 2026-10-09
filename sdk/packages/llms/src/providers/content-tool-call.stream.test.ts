import { describe, expect, it } from "vitest";
import { emitAiSdkEvents } from "./ai-sdk";

/**
 * The recovery is only worth anything if it happens on the real stream path, so
 * these drive `emitAiSdkEvents` with the exact shape cline/cline#14453 reports:
 * a provider that advertises tools and returns the call inside message.content
 * with no tool_calls part at all.
 */
describe("content-delivered tool calls", () => {
	const TOOLS = [{ name: "get_weather" }, { name: "run_commands" }];

	const request = {
		providerId: "ollama",
		modelId: "qwen2.5-coder:14b",
		tools: TOOLS,
		messages: [{ role: "user", content: "weather in Madrid" }],
	} as never;

	const textOnlyStream = (chunks: string[]) => ({
		// No fullStream: this is the text-only path.
		textStream: (async function* () {
			for (const c of chunks) {
				yield c;
			}
		})(),
	});

	const collect = async (chunks: string[]) => {
		const events: unknown[] = [];
		for await (const e of emitAiSdkEvents(
			textOnlyStream(chunks) as never,
			request,
			{ provider: { capabilities: [] } } as never,
		)) {
			events.push(e);
		}
		return events;
	};

	it("executes the call instead of printing it as the answer", async () => {
		const events = await collect([
			'{"name": "get_',
			'weather", "arguments": {"city": "Madrid"}}',
		]);

		const call = events.find(
			(e) => (e as { type?: string }).type === "tool-call-delta",
		) as { toolName?: string; inputText?: string } | undefined;

		expect(call).toBeDefined();
		expect(call?.toolName).toBe("get_weather");
		expect(JSON.parse(call?.inputText ?? "{}")).toEqual({ city: "Madrid" });

		// Crucially, the JSON is not also shown to the user as the assistant's reply.
		const texts = events
			.filter((e) => (e as { type?: string }).type === "text-delta")
			.map((e) => (e as { text: string }).text)
			.join("");
		expect(texts).toBe("");
	});

	it("still streams ordinary prose without buffering it to the end", async () => {
		const events = await collect(["Reading ", "the file ", "now."]);
		const texts = events
			.filter((e) => (e as { type?: string }).type === "text-delta")
			.map((e) => (e as { text: string }).text);

		// Flushed on the first delta, so the user sees text immediately rather than
		// after the turn ends.
		expect(texts[0]).toBe("Reading ");
		expect(texts.join("")).toBe("Reading the file now.");
		expect(
			events.find((e) => (e as { type?: string }).type === "tool-call-delta"),
		).toBeUndefined();
	});

	it("refuses to promote a call to a tool that was not offered", async () => {
		const events = await collect(['{"name":"rm_rf","arguments":{"path":"/"}}']);
		expect(
			events.find((e) => (e as { type?: string }).type === "tool-call-delta"),
		).toBeUndefined();
		const texts = events
			.filter((e) => (e as { type?: string }).type === "text-delta")
			.map((e) => (e as { text: string }).text)
			.join("");
		expect(texts).toContain("rm_rf");
	});

	it("promotes a single unchunked envelope too", async () => {
		const events = await collect([
			'{"name":"run_commands","arguments":{"command":"ls"}}',
		]);
		expect(
			events.find((e) => (e as { type?: string }).type === "tool-call-delta"),
		).toBeDefined();
	});

	it("emits the recovered call before the finish event", async () => {
		const events = await collect([
			'{"name":"run_commands","arguments":{"command":"ls"}}',
		]);
		const callIdx = events.findIndex(
			(e) => (e as { type?: string }).type === "tool-call-delta",
		);
		const finishIdx = events.findIndex(
			(e) => (e as { type?: string }).type === "finish",
		);
		expect(callIdx).toBeGreaterThanOrEqual(0);
		expect(finishIdx).toBeGreaterThan(callIdx);
	});
});
