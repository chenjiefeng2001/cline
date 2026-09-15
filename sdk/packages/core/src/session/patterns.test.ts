import { describe, expect, it, vi } from "vitest";
import {
	buildEvaluatorPrompt,
	handoffSession,
	parseAgentCritique,
	runAgentEvaluation,
} from "./patterns";

describe("parseAgentCritique", () => {
	it("parses a direct critique object", () => {
		const critique = parseAgentCritique({
			verdict: "approve",
			score: 87,
			strengths: ["clear structure"],
			weaknesses: [],
			risks: ["minor"],
			suggestions: ["add tests"],
			summary: "solid work",
		});
		expect(critique).toEqual({
			verdict: "approve",
			score: 87,
			strengths: ["clear structure"],
			weaknesses: [],
			risks: ["minor"],
			suggestions: ["add tests"],
			summary: "solid work",
		});
	});

	it("parses a fenced JSON block from a longer reply", () => {
		const reply = [
			"Overall the artifact looks good.",
			"",
			"```json",
			JSON.stringify({
				verdict: "revise",
				score: 55,
				strengths: [],
				weaknesses: ["missing error handling"],
				risks: [],
				suggestions: ["wrap IO"],
				summary: "needs revision",
			}),
			"```",
		].join("\n");
		const critique = parseAgentCritique(reply);
		expect(critique?.verdict).toBe("revise");
		expect(critique?.score).toBe(55);
		expect(critique?.summary).toBe("needs revision");
	});

	it("parses a raw JSON string", () => {
		const critique = parseAgentCritique(
			'{"verdict":"reject","score":10,"summary":"broken"}',
		);
		expect(critique?.verdict).toBe("reject");
		expect(critique?.summary).toBe("broken");
	});

	it("clamps score into 0-100 and tolerates missing arrays", () => {
		const critique = parseAgentCritique({
			verdict: "approve",
			score: 150,
			summary: "ok",
		});
		expect(critique?.score).toBe(100);
		expect(critique?.strengths).toEqual([]);
	});

	it("returns undefined for non-critique shapes and invalid JSON", () => {
		expect(
			parseAgentCritique({ verdict: "maybe", summary: "" }),
		).toBeUndefined();
		expect(parseAgentCritique("not json at all")).toBeUndefined();
		expect(parseAgentCritique('{"verdict":"approve"')).toBeUndefined();
		expect(parseAgentCritique(undefined)).toBeUndefined();
		expect(parseAgentCritique(42)).toBeUndefined();
	});
});

describe("buildEvaluatorPrompt", () => {
	it("contains the artifact, focus, and schema instruction", () => {
		const prompt = buildEvaluatorPrompt({
			artifact: "diff --git a/x b/x",
			instructions: "focus on security",
		});
		expect(prompt).toContain("independent evaluator");
		expect(prompt).toContain("diff --git a/x b/x");
		expect(prompt).toContain("focus on security");
		expect(prompt).toContain('"verdict"');
	});

	it("omits the focus section when no instructions are given", () => {
		const prompt = buildEvaluatorPrompt({ artifact: "artifact body" });
		expect(prompt).toContain("artifact body");
		expect(prompt).not.toContain("Evaluation focus");
	});
});

describe("runAgentEvaluation", () => {
	it("starts a session and parses the structured critique", async () => {
		const start = vi.fn(async (_prompt: string) => ({
			sessionId: "eval-1",
			result: {
				text: `review done\n\`\`\`json\n${JSON.stringify({
					verdict: "approve",
					score: 90,
					strengths: ["correct"],
					weaknesses: [],
					risks: [],
					suggestions: [],
					summary: "fine",
				})}\n\`\`\``,
			},
		}));
		const outcome = await runAgentEvaluation({
			artifact: "the artifact",
			start,
		});
		expect(start).toHaveBeenCalledTimes(1);
		expect(start.mock.calls[0][0]).toContain("the artifact");
		expect(outcome.sessionId).toBe("eval-1");
		expect(outcome.critique?.verdict).toBe("approve");
		expect(outcome.critique?.score).toBe(90);
	});

	it("falls back to rawText when the evaluator emits unparseable output", async () => {
		const outcome = await runAgentEvaluation({
			artifact: "artifact",
			start: async () => ({
				sessionId: "eval-2",
				result: { text: "looks fine to me" },
			}),
		});
		expect(outcome.critique).toBeUndefined();
		expect(outcome.rawText).toBe("looks fine to me");
	});

	it("returns undefined critique when the session produced no result", async () => {
		const outcome = await runAgentEvaluation({
			artifact: "artifact",
			start: async () => ({ sessionId: "eval-3" }),
		});
		expect(outcome.sessionId).toBe("eval-3");
		expect(outcome.critique).toBeUndefined();
		expect(outcome.rawText).toBeUndefined();
	});

	it("recovers the critique from a tool_result content block when the final text is unparseable", async () => {
		const critiqueBody = JSON.stringify({
			verdict: "reject",
			score: 20,
			strengths: [],
			weaknesses: ["broken"],
			risks: [],
			suggestions: [],
			summary: "emitted via tool",
		});
		const outcome = await runAgentEvaluation({
			artifact: "artifact",
			start: async () => ({
				sessionId: "eval-4",
				result: {
					text: "verdict emitted through the structured-output tool",
					messages: [
						{
							content: [{ type: "tool_result", content: critiqueBody }],
						},
					],
				},
			}),
		});
		expect(outcome.critique?.verdict).toBe("reject");
		expect(outcome.critique?.score).toBe(20);
		expect(outcome.critique?.summary).toBe("emitted via tool");
	});

	it("ignores tool_result blocks that carry no critique", async () => {
		const outcome = await runAgentEvaluation({
			artifact: "artifact",
			start: async () => ({
				sessionId: "eval-5",
				result: {
					text: "plain text",
					messages: [
						{
							content: [{ type: "tool_result", content: '{"ok":true}' }],
						},
					],
				},
			}),
		});
		expect(outcome.critique).toBeUndefined();
		expect(outcome.rawText).toBe("plain text");
	});
});

describe("handoffSession", () => {
	it("detaches from the source then attaches on the target, in order", async () => {
		const calls: string[] = [];
		const makeClient = (label: string) => ({
			command: vi.fn(async (command: string) => {
				calls.push(`${label}:${command}`);
				return {};
			}),
		});
		const from = makeClient("from");
		const to = makeClient("to");
		const outcome = await handoffSession({
			sessionId: "session-1",
			from,
			to,
		});
		expect(outcome).toEqual({
			sessionId: "session-1",
			detached: true,
			attached: true,
		});
		expect(calls).toEqual(["from:session.detach", "to:session.attach"]);
		expect(from.command).toHaveBeenCalledWith(
			"session.detach",
			{ sessionId: "session-1" },
			"session-1",
		);
		expect(to.command).toHaveBeenCalledWith(
			"session.attach",
			{ sessionId: "session-1" },
			"session-1",
		);
	});

	it("propagates detach failures before attach runs", async () => {
		const to = { command: vi.fn(async () => ({})) };
		const from = {
			command: vi.fn(async () => {
				throw new Error("hub unreachable");
			}),
		};
		await expect(handoffSession({ sessionId: "s", from, to })).rejects.toThrow(
			"hub unreachable",
		);
		expect(to.command).not.toHaveBeenCalled();
	});
});
