/**
 * Official multi-agent orchestration patterns [roadmap P1-3].
 *
 * Two composable patterns published on top of the hub's session bus so
 * integrations stop re-inventing private orchestration semantics:
 *
 * - **handoff**: session ownership transfer between hub clients
 *   (`session.detach` from the current owner, `session.attach` on the
 *   target) — the hub bus already carries both primitives.
 * - **evaluator**: independent evaluation sessions with a structured
 *   critique schema. The evaluator runs in its own session and receives
 *   only the artifact under review (never the producing conversation), so
 *   self-assessment inflation cannot leak into the verdict
 *   (Planner→Generator→Evaluator with structured artifact handoff).
 *
 * Both helpers are transport-decoupled: they accept structural client
 * shapes (`NodeHubClient`, `ClineCore.start`, or stubs in tests).
 */

// ---------------------------------------------------------------------------
// Evaluator pattern
// ---------------------------------------------------------------------------

/**
 * Structural session outcome consumed by the evaluator helpers, mirroring the
 * `StartSessionResult` envelope returned by `ClineCore.start(...)`: the rich
 * `AgentResult` carried in `result` satisfies the structural subset below,
 * and test stubs can provide the minimal `{ sessionId, result: { text } }`.
 */
export interface EvaluatorSessionOutcome {
	/** Session id of the started evaluator session, when known. */
	sessionId?: string;
	/** Session result; only the final text and message log are consumed. */
	result?: {
		/** Final text output of the session. */
		text?: string;
		/** Message log; scanned for tool_result-emitted critiques as a fallback. */
		messages?: ReadonlyArray<{
			content?: ReadonlyArray<{ type?: unknown; content?: unknown }>;
		}>;
	};
}

/** Structured critique produced by an evaluator session. */
export interface AgentCritique {
	verdict: "approve" | "revise" | "reject";
	/** 0–100 self-consistency score for the artifact under review. */
	score: number;
	strengths: string[];
	weaknesses: string[];
	risks: string[];
	suggestions: string[];
	summary: string;
}

const CRITIQUE_VERDICTS = new Set(["approve", "revise", "reject"]);

/**
 * Builds the evaluator prompt: the artifact plus instructions, with the
 * critique schema spelled out so the model can emit parseable JSON. The
 * prompt deliberately contains no producing-conversation context.
 */
export function buildEvaluatorPrompt(input: {
	artifact: string;
	instructions?: string;
}): string {
	const lines = [
		"You are an independent evaluator. Assess the artifact below on its own",
		"merits. Do not assume anything about how it was produced.",
		"",
		"## Artifact under review",
		"",
		input.artifact,
	];
	if (input.instructions?.trim()) {
		lines.push("", "## Evaluation focus", "", input.instructions.trim());
	}
	lines.push(
		"",
		"## Required output",
		"",
		"End your reply with a single JSON object (fenced or plain) shaped exactly like:",
		'{"verdict":"approve|revise|reject","score":0-100,"strengths":[...],"weaknesses":[...],"risks":[...],"suggestions":[...],"summary":"..."}',
	);
	return lines.join("\n");
}

function isCritiqueLike(value: Record<string, unknown>): boolean {
	return (
		typeof value.verdict === "string" &&
		CRITIQUE_VERDICTS.has(value.verdict) &&
		typeof value.summary === "string"
	);
}

/**
 * Parses a structured {@link AgentCritique} from an evaluator output. Accepts
 * the object directly, a raw JSON string, or the first ```json fenced block
 * inside a longer reply. Returns `undefined` when nothing critique-shaped is
 * found so callers can fall back to the raw text.
 */
export function parseAgentCritique(output: unknown): AgentCritique | undefined {
	let candidate: unknown = output;
	if (typeof candidate === "string") {
		const text = candidate.trim();
		const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
		const jsonCandidate =
			fence?.[1]?.trim() ||
			(text.startsWith("{") ? text : /(\{[\s\S]*\})/.exec(text)?.[1]);
		if (!jsonCandidate) {
			return undefined;
		}
		try {
			candidate = JSON.parse(jsonCandidate);
		} catch {
			return undefined;
		}
	}
	if (!candidate || typeof candidate !== "object") {
		return undefined;
	}
	const value = candidate as Record<string, unknown>;
	if (!isCritiqueLike(value)) {
		return undefined;
	}
	return {
		verdict: value.verdict as AgentCritique["verdict"],
		score:
			typeof value.score === "number" && Number.isFinite(value.score)
				? Math.max(0, Math.min(100, value.score))
				: 0,
		strengths: toStringArray(value.strengths),
		weaknesses: toStringArray(value.weaknesses),
		risks: toStringArray(value.risks),
		suggestions: toStringArray(value.suggestions),
		summary: value.summary as string,
	};
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

export interface AgentEvaluationInput {
	/** The artifact under review (code diff, document, plan). */
	artifact: string;
	/** Optional focus instructions for the evaluator. */
	instructions?: string;
	/**
	 * Starts the independent evaluator session with the given prompt and
	 * resolves to its outcome. Satisfied by `ClineCore.start(...)` and by
	 * minimal stubs in tests.
	 */
	start: (
		prompt: string,
	) => Promise<EvaluatorSessionOutcome> | EvaluatorSessionOutcome;
}

export interface AgentEvaluationResult {
	sessionId?: string;
	/** Structured critique parsed from the evaluator session, when parseable. */
	critique?: AgentCritique;
	/** Raw final text of the evaluator session (fallback for unparseable output). */
	rawText?: string;
}

/**
 * Runs the evaluator pattern: starts an independent session whose only input
 * is the artifact (plus optional focus instructions), waits for its final
 * text, and parses the structured critique. `critique` is `undefined` when
 * the evaluator failed to emit parseable JSON — `rawText` always carries the
 * verdict text so callers can log or re-ask.
 */
export async function runAgentEvaluation(
	input: AgentEvaluationInput,
): Promise<AgentEvaluationResult> {
	const prompt = buildEvaluatorPrompt({
		artifact: input.artifact,
		instructions: input.instructions,
	});
	const started = await input.start(prompt);
	const rawText = extractFinalText(started.result);
	const critique =
		parseAgentCritique(rawText) ??
		parseAgentCritiqueFromMessages(started.result);
	return {
		sessionId: started.sessionId,
		critique,
		rawText,
	};
}

function extractFinalText(
	result: EvaluatorSessionOutcome["result"],
): string | undefined {
	const text = result?.text?.trim();
	return text || undefined;
}

/**
 * Fallback: scans the evaluator session's tool-result outputs for a
 * structured critique (some integrations emit it through a structured-output
 * tool instead of the final text).
 */
function parseAgentCritiqueFromMessages(
	result: EvaluatorSessionOutcome["result"],
): AgentCritique | undefined {
	for (const message of result?.messages ?? []) {
		for (const part of message.content ?? []) {
			if (
				part &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "tool_result" &&
				"content" in part
			) {
				const critique = parseAgentCritique(
					toolResultText((part as { content?: unknown }).content),
				);
				if (critique) {
					return critique;
				}
			}
		}
	}
	return undefined;
}

/** Joins a tool-result payload (string or content-block array) into text. */
function toolResultText(payload: unknown): string | undefined {
	if (typeof payload === "string") {
		return payload;
	}
	if (!Array.isArray(payload)) {
		return undefined;
	}
	return (
		payload
			.filter(
				(item): item is { type: "text"; text: string } =>
					!!item &&
					typeof item === "object" &&
					(item as { type?: unknown }).type === "text" &&
					typeof (item as { text?: unknown }).text === "string",
			)
			.map((item) => item.text)
			.join("\n") || undefined
	);
}

// ---------------------------------------------------------------------------
// Handoff pattern
// ---------------------------------------------------------------------------

/** Structural shape of a hub command client (`NodeHubClient` satisfies it). */
export interface HubSessionCommandClient {
	command: (
		command: "session.detach" | "session.attach",
		payload?: Record<string, unknown>,
		sessionId?: string,
	) => Promise<unknown>;
}

export interface SessionHandoffInput {
	sessionId: string;
	/** Current owner; its `session.detach` releases ownership. */
	from: HubSessionCommandClient;
	/** Target owner; its `session.attach` claims ownership. */
	to: HubSessionCommandClient;
}

export interface SessionHandoffResult {
	sessionId: string;
	detached: boolean;
	attached: boolean;
}

/**
 * Runs the handoff pattern: detaches the session from the current owner and
 * attaches it to the target over the hub bus (`session.detach` →
 * `session.attach`). Both commands are awaited in order so the target's
 * attach never races the source's detach.
 */
export async function handoffSession(
	input: SessionHandoffInput,
): Promise<SessionHandoffResult> {
	await input.from.command(
		"session.detach",
		{ sessionId: input.sessionId },
		input.sessionId,
	);
	await input.to.command(
		"session.attach",
		{ sessionId: input.sessionId },
		input.sessionId,
	);
	return {
		sessionId: input.sessionId,
		detached: true,
		attached: true,
	};
}
