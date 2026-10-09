import { describe, expect, it } from "vitest";
import {
	couldBecomeToolCallEnvelope,
	createToolCallTextBuffer,
	parseToolCallEnvelope,
} from "./content-tool-call";

const TOOLS = ["run_commands", "get_weather", "read_files"] as const;

describe("parseToolCallEnvelope", () => {
	it("recovers the exact shape cline/cline#14453 reports", () => {
		// Ollama + Qwen 2.5 Coder returned this inside message.content, with no
		// tool_calls field at all.
		const content =
			'{\n "name": "get_weather",\n "arguments": {\n "city": "Madrid"\n }\n}';
		expect(parseToolCallEnvelope(content, TOOLS)).toEqual({
			toolName: "get_weather",
			toolCallId: "",
			input: { city: "Madrid" },
		});
	});

	it("accepts parameters as well as arguments", () => {
		const parsed = parseToolCallEnvelope(
			'{"name":"read_files","parameters":{"paths":["a.ts"]}}',
			TOOLS,
		);
		expect(parsed?.input).toEqual({ paths: ["a.ts"] });
	});

	it("keeps a supplied id as the tool call id", () => {
		const parsed = parseToolCallEnvelope(
			'{"id":"call_42","name":"run_commands","arguments":{"command":"ls"}}',
			TOOLS,
		);
		expect(parsed?.toolCallId).toBe("call_42");
	});

	it("reads an envelope wrapped in a code fence", () => {
		const parsed = parseToolCallEnvelope(
			'```json\n{"name":"run_commands","arguments":{"command":"ls"}}\n```',
			TOOLS,
		);
		expect(parsed?.toolName).toBe("run_commands");
	});

	it("refuses a tool the model was never offered", () => {
		// The single most important refusal: promoting this would execute a tool the
		// model could not legitimately have called.
		expect(
			parseToolCallEnvelope(
				'{"name":"delete_everything","arguments":{}}',
				TOOLS,
			),
		).toBeNull();
	});

	it("refuses ordinary prose that happens to be JSON", () => {
		for (const content of [
			'{"city":"Madrid","temperature":22}',
			'{"name":"Bob","age":30}',
			'["run_commands"]',
			"just a string",
			"",
		]) {
			expect(parseToolCallEnvelope(content, TOOLS), content).toBeNull();
		}
	});

	it("refuses when the envelope is only part of the message", () => {
		// Trailing prose means the model was explaining, not calling. Requiring the
		// whole message is what keeps a false positive from executing anything.
		expect(
			parseToolCallEnvelope(
				'{"name":"run_commands","arguments":{"command":"ls"}} -- done',
				TOOLS,
			),
		).toBeNull();
		expect(
			parseToolCallEnvelope(
				'Here is the call:\n{"name":"run_commands","arguments":{}}',
				TOOLS,
			),
		).toBeNull();
	});

	it("refuses when arguments are not an object", () => {
		expect(
			parseToolCallEnvelope(
				'{"name":"run_commands","arguments":"ls -la"}',
				TOOLS,
			),
		).toBeNull();
		expect(
			parseToolCallEnvelope('{"name":"run_commands","arguments":[1,2]}', TOOLS),
		).toBeNull();
	});

	it("defaults missing arguments to an empty object", () => {
		expect(
			parseToolCallEnvelope('{"name":"run_commands"}', TOOLS)?.input,
		).toEqual({});
	});
});

describe("couldBecomeToolCallEnvelope", () => {
	it("keeps buffering anything that starts like a JSON object", () => {
		expect(couldBecomeToolCallEnvelope("")).toBe(true);
		expect(couldBecomeToolCallEnvelope('{"na')).toBe(true);
		expect(couldBecomeToolCallEnvelope("  ```json\n{")).toBe(true);
	});

	it("releases immediately for prose", () => {
		// This is the property that keeps the streaming path free of latency: prose
		// never starts with `{`.
		expect(couldBecomeToolCallEnvelope("I'll read the file")).toBe(false);
		expect(couldBecomeToolCallEnvelope("`ls` first")).toBe(false);
	});
});

describe("createToolCallTextBuffer", () => {
	const make = () =>
		createToolCallTextBuffer({
			toolNames: TOOLS,
			makeToolCallId: () => "generated-id",
		});

	it("promotes a complete envelope streamed in pieces", () => {
		const buffer = make();
		const deltas = [
			'{"name": "get_',
			'weather", "argum',
			'ents": {"city": "Madrid"}}',
		];
		for (const d of deltas) {
			expect(buffer.push(d)).toBeUndefined();
		}
		const decision = buffer.finish();
		expect(decision).toEqual({
			kind: "tool-call",
			toolCall: {
				toolName: "get_weather",
				toolCallId: "generated-id",
				input: { city: "Madrid" },
			},
		});
	});

	it("flushes prose on the first delta and streams the rest untouched", () => {
		const buffer = make();
		expect(buffer.push("Reading the file")).toEqual({
			flush: "Reading the file",
		});
		expect(buffer.released()).toBe(true);
		// After release, deltas pass straight through with no buffering at all.
		expect(buffer.push(" now")).toBeUndefined();
		expect(buffer.finish()).toBeUndefined();
	});

	it("returns buffered JSON that turned out not to be a call as text", () => {
		const buffer = make();
		buffer.push('{"city":"Madrid",');
		buffer.push('"temperature":22}');
		expect(buffer.finish()).toEqual({
			kind: "text",
			text: '{"city":"Madrid","temperature":22}',
		});
	});

	it("reports nothing for an empty turn", () => {
		expect(make().finish()).toBeUndefined();
	});
});
