/**
 * Recover tool calls that a model emitted as assistant text.
 *
 * Some OpenAI-compatible servers - Ollama with Qwen 2.5 Coder and Gemma 4 among
 * them - advertise a `tools` capability but return the call inside
 * `message.content` instead of `message.tool_calls`:
 *
 * ```json
 * {"message":{"role":"assistant","content":"{\"name\":\"get_weather\",\"arguments\":{...}}"}}
 * ```
 *
 * There is no tool call in the stream, so nothing downstream can repair it: the
 * JSON is shown to the user as the assistant's answer and the requested action
 * silently never happens. Reported as cline/cline#14453, and the same shape
 * behind cline/cline#13008.
 *
 * ## Why the buffering is lazy
 *
 * Deciding this requires the *complete* text. Buffering every text delta of every
 * turn would delay the first visible token until the turn ends, which is a real
 * regression on the streaming path.
 *
 * So text is buffered only while it could still become an envelope. A tool-call
 * envelope starts with `{`, so a response whose first non-whitespace character is
 * anything else is flushed immediately and streams normally from then on - prose,
 * which is nearly all traffic, pays nothing. Only output that begins like JSON is
 * held, and held only until it either parses or the turn ends.
 *
 * ## Why promotion is strict
 *
 * Promoting text to a tool call means *executing* something. A false positive is
 * far worse than the original bug, so a candidate must be the entire message,
 * parse as a JSON object, name a tool the model was actually offered, and carry
 * no keys beyond the envelope's own. Anything else is returned as text.
 */

export interface RecoveredToolCall {
	toolName: string;
	toolCallId: string;
	input: unknown;
}

/** Keys an envelope may contain. Anything else means it was not one. */
const ALLOWED_ENVELOPE_KEYS = new Set([
	"name",
	"arguments",
	"parameters",
	"id",
]);

/**
 * Strip a wrapping code fence, so a model that fenced its JSON is still read.
 *
 * Only a leading fence is removed, and only when the fence is opened at the very
 * start; a fence appearing mid-message is content.
 */
function stripCodeFence(text: string): string {
	const match = /^\s*```(?:json|tool_call)?\s*\n?/i.exec(text);
	if (!match) {
		return text;
	}
	const body = text.slice(match[0].length);
	// Only treat the trailing fence as a closer if it is actually at the end.
	return body.replace(/\n?\s*```\s*$/, "");
}

function trimmedCandidate(text: string): string {
	return stripCodeFence(text).trim();
}

/**
 * Can the accumulated text still turn into a tool-call envelope?
 *
 * False means "stop buffering, this is prose" and the caller should flush. The
 * only cheap discriminator used here is the opening character: an envelope is a
 * JSON object, so anything not starting with `{` is definitively not one. That
 * keeps the common case free of latency.
 */
export function couldBecomeToolCallEnvelope(text: string): boolean {
	const candidate = trimmedCandidate(text);
	if (candidate.length === 0) {
		return true; // nothing yet; keep waiting
	}
	return candidate.startsWith("{");
}

/**
 * Parse a completed message as a tool-call envelope.
 *
 * Returns null unless the whole message is a JSON object naming one of
 * `toolNames`. `arguments` and `parameters` are both accepted because providers
 * disagree on which they emit.
 */
export function parseToolCallEnvelope(
	text: string,
	toolNames: readonly string[],
): RecoveredToolCall | null {
	const candidate = trimmedCandidate(text);
	if (!candidate.startsWith("{")) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}

	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!ALLOWED_ENVELOPE_KEYS.has(key)) {
			return null;
		}
	}

	const name = record.name;
	if (typeof name !== "string" || !toolNames.includes(name)) {
		return null;
	}

	const rawArgs = record.arguments ?? record.parameters ?? {};
	if (
		rawArgs !== undefined &&
		(typeof rawArgs !== "object" || rawArgs === null)
	) {
		return null;
	}
	if (Array.isArray(rawArgs)) {
		return null;
	}

	const id = record.id;
	return {
		toolName: name,
		toolCallId: typeof id === "string" && id.length > 0 ? id : "",
		input: (rawArgs ?? {}) as Record<string, unknown>,
	};
}

/**
 * The tool an envelope names, when the envelope is otherwise well-formed but
 * names something the model was never offered.
 *
 * Returns null for anything that is not a recognisable envelope, including
 * prose that happens to be JSON. This never authorises execution - the call is
 * still refused. It exists so the caller can tell the model why, instead of
 * echoing the payload back as prose with no tool result, which leaves the model
 * retrying the identical JSON forever. Reported as cline/cline#10843.
 */
export function readEnvelopeToolName(text: string): string | null {
	const candidate = trimmedCandidate(text);
	if (!candidate.startsWith("{")) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}

	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!ALLOWED_ENVELOPE_KEYS.has(key)) {
			return null;
		}
	}

	const name = record.name;
	if (typeof name !== "string" || name.length === 0) {
		return null;
	}

	const rawArgs = record.arguments ?? record.parameters;
	if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null)) {
		return null;
	}
	if (Array.isArray(rawArgs)) {
		return null;
	}

	return name;
}

/**
 * Close a JSON prefix that was cut off, so the *name* can be read back.
 *
 * This never authorises execution and never produces arguments for the caller.
 * It exists so a truncated call can be named in the refusal the model receives,
 * instead of the payload being echoed back as prose with no tool result — which
 * is what leaves a model re-emitting the identical JSON until it trips the
 * mistake limit (cline/cline#10551).
 *
 * Refuses outright when the cut landed inside a string literal: there the
 * missing text is value data, and any closing we invented would be a guess about
 * what the model meant.
 */
function closeTruncatedJson(candidate: string): string | null {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;

	for (const ch of candidate) {
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" || ch === "[") {
			stack.push(ch);
			continue;
		}
		if (ch === "}" || ch === "]") {
			const open = stack.pop();
			if (open === undefined) {
				return null;
			}
			if (ch === "}" ? open !== "{" : open !== "[") {
				return null;
			}
		}
	}

	if (inString || escaped || stack.length === 0) {
		// Unterminated literal: the remainder is value data, not structure.
		// Nothing was open: this was not a cut-off envelope to begin with.
		return null;
	}

	const closed = candidate + stack.reverse().map((open) => (open === "{" ? "}" : "]")).join("");
	try {
		JSON.parse(closed);
		return closed;
	} catch {
		// The cut landed somewhere a closer cannot fix (a dangling key, a
		// half-written number). Not a shape we can speak to.
		return null;
	}
}

/**
 * The offered tool named by an envelope whose JSON was cut off mid-stream.
 *
 * Returns null unless the repaired prefix parses AND names a tool this session
 * actually offered, under the same allow-list {@link parseToolCallEnvelope}
 * applies. That conjunction is what makes this safe to name: a mis-parse has to
 * still land on a real tool name to produce a message.
 */
export function readTruncatedEnvelopeToolName(
	text: string,
	toolNames: readonly string[],
): string | null {
	const candidate = trimmedCandidate(text);
	if (!candidate.startsWith("{")) {
		return null;
	}
	try {
		// Well-formed envelopes are handled by the real paths; this is only the
		// cut-off case.
		JSON.parse(candidate);
		return null;
	} catch {
		// Expected.
	}

	const closed = closeTruncatedJson(candidate);
	if (closed === null) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(closed);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}

	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!ALLOWED_ENVELOPE_KEYS.has(key)) {
			return null;
		}
	}

	const name = record.name;
	if (typeof name !== "string" || name.length === 0 || !toolNames.includes(name)) {
		return null;
	}
	return name;
}

/**
 * Accumulates text deltas and decides, at the end, whether they were a tool call.
 *
 * `push` returns the text to emit immediately when the buffer can be released;
 * once released every later delta streams straight through. `finish` returns the
 * recovery decision for whatever is still buffered.
 */
export function createToolCallTextBuffer(options: {
	toolNames: readonly string[];
	makeToolCallId: () => string;
}): {
	push: (delta: string) => { flush: string } | undefined;
	finish: () =>
		| { kind: "tool-call"; toolCall: RecoveredToolCall }
		| { kind: "unoffered-tool"; toolName: string; text: string }
		| { kind: "truncated-tool-call"; toolName: string; text: string }
		| { kind: "text"; text: string }
		| undefined;
	released: () => boolean;
	drainAsText: () => string | undefined;
} {
	const { toolNames, makeToolCallId } = options;
	let buffered = "";
	let released = false;

	return {
		push(delta: string): { flush: string } | undefined {
			if (released) {
				return undefined;
			}
			buffered += delta;
			if (couldBecomeToolCallEnvelope(buffered)) {
				return undefined;
			}
			released = true;
			const flush = buffered;
			buffered = "";
			return { flush };
		},
		/**
		 * Give up on promotion and return the buffered text.
		 *
		 * Needed when something else in the same turn has already decided the
		 * outcome - a real `tool-call` part, for instance - so the text is emitted
		 * before that event rather than after it.
		 */
		drainAsText(): string | undefined {
			if (released) {
				return undefined;
			}
			released = true;
			const text = buffered;
			buffered = "";
			return text.length > 0 ? text : undefined;
		},
		finish() {
			if (released) {
				return undefined;
			}
			const text = buffered;
			buffered = "";
			released = true;
			if (text.trim().length === 0) {
				return undefined;
			}
			const toolCall = parseToolCallEnvelope(text, toolNames);
			if (toolCall) {
				return {
					kind: "tool-call",
					toolCall: {
						...toolCall,
						toolCallId: toolCall.toolCallId || makeToolCallId(),
					},
				};
			}
			// Still refused. The caller only needs to know the name so it can say
			// so in the response, which is what breaks the retry loop.
			const unofferedName = readEnvelopeToolName(text);
			if (unofferedName !== null) {
				return { kind: "unoffered-tool", toolName: unofferedName, text };
			}
			// A call to a real tool whose JSON was cut off. Naming it is safe;
			// running it is not, because the arguments are incomplete.
			const truncatedName = readTruncatedEnvelopeToolName(text, toolNames);
			if (truncatedName !== null) {
				return { kind: "truncated-tool-call", toolName: truncatedName, text };
			}
			return { kind: "text", text };
		},
		released: () => released,
	};
}
