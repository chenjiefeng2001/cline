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

	it("refuses to promote the exact payload cline/cline#10843 reports", async () => {
		// A local coder model emitted this inside message.content. This fork has
		// no write_to_file tool - the editor tool is called `editor` - so the
		// envelope names something the model was never offered and must stay
		// text. It is still a live trap: the model gets no tool result back and
		// can repeat the payload indefinitely. Locked here so the guarantee is
		// explicit rather than incidental, and so any future change to this path
		// has to confront this case deliberately.
		const events = await collect([
			'{"name": "write_to_file", "arguments": {"path":"a.txt"}}',
		]);
		expect(
			events.find((e) => (e as { type?: string }).type === "tool-call-delta"),
		).toBeUndefined();
		const texts = events
			.filter((e) => (e as { type?: string }).type === "text-delta")
			.map((e) => (e as { text: string }).text)
			.join("");
		expect(texts).toContain("write_to_file");
	});

	it("tells the model the unoffered call did not run, and what it could call", async () => {
		// The refusal above is only half the fix. Echoing the payload back gives
		// the model no tool result and no reason to change course, so it repeats
		// it. This is the signal that ends the loop - and it stays text, so the
		// no-promotion guarantee is untouched.
		const events = await collect([
			'{"name": "write_to_file", "arguments": {"path":"a.txt"}}',
		]);
		const texts = events
			.filter((e) => (e as { type?: string }).type === "text-delta")
			.map((e) => (e as { text: string }).text)
			.join("");

		expect(texts).toContain("was not run");
		expect(texts).toContain("write_to_file");
		// Names what does exist, so the model can correct itself.
		expect(texts).toContain("get_weather");
		expect(texts).toContain("run_commands");
		expect(
			events.find((e) => (e as { type?: string }).type === "tool-call-delta"),
		).toBeUndefined();
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

/**
 * A provider that streams a tool call and gets cut off partway — typically at a
 * token cap. The call is never run, but the model is told which call was dropped
 * and why, so it stops re-emitting the identical payload (cline/cline#10551).
 */
describe("truncated tool call envelopes", () => {
	const TOOLS = [{ name: "get_weather" }, { name: "run_commands" }];

	const request = {
		providerId: "openai-compatible",
		modelId: "deepseek-v4-pro",
		tools: TOOLS,
		messages: [{ role: "user", content: "list the files" }],
	} as never;

	const collect = async (chunks: string[]) => {
		const events: unknown[] = [];
		for await (const e of emitAiSdkEvents(
			{
				textStream: (async function* () {
					for (const c of chunks) {
						yield c;
					}
				})(),
			} as never,
			request,
			{ provider: { capabilities: [] } } as never,
		)) {
			events.push(e);
		}
		return events;
	};

	const text = (events: unknown[]) =>
		events
			.filter((e) => (e as { type?: string }).type === "text-delta")
			.map((e) => (e as { text: string }).text)
			.join("");

	it("does not run a call whose arguments were cut off", async () => {
		const events = await collect([
			'{"name":"run_commands","arguments":{"command":"ls -la"',
		]);
		expect(
			events.find((e) => (e as { type?: string }).type === "tool-call-delta"),
		).toBeUndefined();
		expect(
			events.find((e) => (e as { type?: string }).type === "tool-call"),
		).toBeUndefined();
	});

	it("tells the model which call was dropped and that it did not run", async () => {
		const events = await collect([
			'{"name":"run_commands","arguments":{"command":"ls -la"',
		]);
		const message = text(events);
		expect(message).toContain("not executed");
		expect(message).toContain("run_commands");
		expect(message).toContain("cut off");
	});

	it("survives a call arriving across several deltas", async () => {
		const events = await collect([
			'{"name":"run_com',
			'mands","arguments":{"comm',
			'and":"ls"}}',
		]);
		// Whole and well-formed, so this one does run. Same bytes as the
		// unchunked case, split across deltas.
		expect(
			events.find((e) => (e as { type?: string }).type === "tool-call-delta"),
		).toBeDefined();
	});

	it("stays silent when the cut is inside a string literal", async () => {
		// The missing text is value data here, so no closer can be invented and
		// the model gets ordinary prose back rather than a guess.
		const events = await collect([
			'{"name":"run_commands","arguments":{"command":"ls -la ',
		]);
		expect(text(events)).not.toContain("not executed");
	});

	it("stays silent for a truncated call to a tool that was never offered", async () => {
		// The unoffered-tool path owns that message; this must not claim the
		// call was truncated when the real problem is the tool name.
		const events = await collect(['{"name":"delete_everything","arguments":{"tar']);
		expect(text(events)).not.toContain("cut off");
	});

	it("leaves ordinary prose alone", async () => {
		const events = await collect(["here is a list: {a: 1, b: 2"]);
		expect(text(events)).toContain("here is a list");
	});
});
