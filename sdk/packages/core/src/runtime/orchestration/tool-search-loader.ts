import { z } from "zod";
import type { AgentTool, AgentToolDefinition } from "@cline/shared";
import { createTool, validateWithZod, zodToJsonSchema } from "@cline/shared";
import type { CoreLazyToolLoadingConfig } from "../../types/config.js";

/**
 * Name of the meta-tool that reveals deferred tool schemas on demand.
 */
export const TOOL_SEARCH_TOOL_NAME = "tool_search";

/**
 * Tool names deferred by default. Teams carry 18 tools whose schemas dominate
 * the request, yet a run only needs them when the user asks for a team, so they
 * are the highest-value thing to hide behind a search.
 */
export const DEFAULT_DEFERRED_TOOL_PATTERNS = ["team_*"];

function matchesPattern(name: string, pattern: string): boolean {
	if (pattern.endsWith("*")) {
		return name.startsWith(pattern.slice(0, -1));
	}
	return name === pattern;
}

export function isLazyLoadingEnabled(
	config: CoreLazyToolLoadingConfig | undefined,
): boolean {
	// Opt-in: an absent config must read as disabled. Returning true for
	// `undefined` would silently defer team tools for every host that never
	// asked for it, which is the opposite of the documented default.
	return config !== undefined && config.enabled !== false;
}

/**
 * The subset of deferred tools that actually exist in this run.
 *
 * Returns nothing when nothing is deferrable, which is the signal for callers
 * to skip wiring entirely rather than add a `tool_search` tool with an empty
 * catalogue.
 */
export function selectDeferredToolNames(
	tools: readonly AgentToolDefinition[],
	config: CoreLazyToolLoadingConfig | undefined,
): string[] {
	if (!isLazyLoadingEnabled(config)) {
		return [];
	}
	const patterns = config?.defer ?? DEFAULT_DEFERRED_TOOL_PATTERNS;
	const names: string[] = [];
	for (const tool of tools) {
		// A tool that completes the run must stay visible: hiding the only way
		// to finish would strand the model in a loop with nothing to call.
		if (tool.lifecycle?.completesRun) {
			continue;
		}
		if (patterns.some((pattern) => matchesPattern(tool.name, pattern))) {
			names.push(tool.name);
		}
	}
	return names;
}

/**
 * First line of a tool description, trimmed to a catalogue-width budget.
 *
 * The catalogue is the one place deferred tool names have to appear in the
 * request, so it stays to name plus a short gloss. The expensive part — the
 * JSON Schema — is what this feature exists to withhold.
 */
function summarise(description: string, limit = 120): string {
	const firstLine = description.split("\n")[0]?.trim() ?? "";
	if (firstLine.length <= limit) {
		return firstLine;
	}
	return `${firstLine.slice(0, limit - 1).trimEnd()}…`;
}

export interface ToolSearchLoaderOptions {
	/**
	 * Deferred tool definitions present in this run, captured at creation time.
	 *
	 * `AgentToolContext` carries no tool list, so the catalogue has to be closed
	 * over. The orchestrator rebuilds the loader per run, which is what keeps it
	 * accurate as the registered set changes between runs.
	 */
	deferredTools: readonly AgentToolDefinition[];
	/**
	 * Names already revealed. Owned by the session so a tool revealed in an
	 * earlier run stays revealed without a second search.
	 */
	loaded: Set<string>;
	maxResults?: number;
}

/**
 * Words that carry no signal for tool matching.
 *
 * Without this, the query "spawn a teammate" scores every tool: the term "a"
 * occurs inside most tool names and descriptions, so the search would reveal the
 * whole deferred set and forfeit the token saving the feature exists to provide.
 */
const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"any",
	"are",
	"as",
	"at",
	"be",
	"by",
	"can",
	"do",
	"does",
	"for",
	"from",
	"get",
	"how",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"me",
	"my",
	"of",
	"on",
	"or",
	"please",
	"so",
	"that",
	"the",
	"then",
	"there",
	"this",
	"to",
	"use",
	"was",
	"what",
	"when",
	"where",
	"which",
	"will",
	"with",
	"you",
	"your",
]);

/**
 * Splits a query into searchable terms.
 *
 * Drops stop words and single characters, which score spuriously as substrings.
 */
function queryTerms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
}

/**
 * Scores a tool against a free-text query.
 *
 * Deliberately lexical rather than embedding-based: this runs inside the agent
 * loop with no network, and a name match has to outrank a description match or
 * `team_spawn_teammate` never surfaces for the query "spawn teammate".
 */
function scoreTool(tool: AgentToolDefinition, terms: string[]): number {
	if (terms.length === 0) {
		return 0;
	}
	const name = tool.name.toLowerCase();
	const description = tool.description.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (name === term) {
			score += 100;
		} else if (name.includes(term)) {
			score += 25;
		}
		if (description.includes(term)) {
			score += 5;
		}
	}
	return score;
}

/**
 * Builds the `tool_search` tool plus the `beforeModel` hook that hides
 * unrevealed deferred tools from the model.
 *
 * The deferred tools stay registered in the runtime's tool map the whole time.
 * This hook only narrows what the model is *shown*, so a revealed tool is
 * immediately executable with no registry mutation and no prompt-cache rewrite
 * beyond the one iteration where the set changed.
 */
export function createToolSearchLoader(options: ToolSearchLoaderOptions): {
	tool: AgentTool<any, any>;
	beforeModel: (ctx: {
		request: { tools: readonly AgentToolDefinition[] };
	}) => { tools: AgentToolDefinition[] };
} {
	const deferred = new Map(
		options.deferredTools.map((tool) => [tool.name, tool] as const),
	);
	const maxResults = Math.max(1, options.maxResults ?? 5);

	/** Tools the model may see but has not asked to load yet. */
	const catalogue = (tools: readonly AgentToolDefinition[]): AgentToolDefinition[] =>
		tools.filter((tool) => deferred.has(tool.name) && !options.loaded.has(tool.name));

	/**
	 * The catalogue is the only place deferred names reach the request, so it
	 * stays to name plus a one-line gloss — the JSON Schema is exactly what this
	 * feature withholds until a search earns it.
	 */
	const ToolSearchInputSchema = z.object({
		query: z
			.string()
			.min(1)
			.describe(
				"What you want to do, in plain words, e.g. 'spawn a teammate to review the diff'.",
			),
		limit: z
			.number()
			.int()
			.min(1)
			.max(maxResults)
			.optional()
			.describe(`Maximum tools to reveal. At most ${maxResults}.`),
	});

	/**
	 * Derived per read rather than once, mirroring the `skills` tool: the runtime
	 * rebuilds tool definitions for every model request, so a value computed at
	 * construction would keep advertising already-revealed tools as "unloaded" for
	 * the rest of the session and invite the model to search for them again.
	 */
	const describe = () => {
		const catalogue = [...deferred.values()]
			.filter((tool) => !options.loaded.has(tool.name))
			.map((tool) => `- ${tool.name}: ${summarise(tool.description)}`)
			.join("\n");
		const header =
			"Search for tools that are available in this session but whose full schemas are not loaded yet, and reveal the best matches so they become callable. " +
			"Use this when you need a capability you cannot see a tool for. Revealed tools are callable on your next turn.";
		// Once everything is revealed the catalogue is empty, and a header with
		// nothing under it reads as a broken tool rather than a finished job.
		return catalogue
			? `${header}\n\nUnloaded tools available to search:\n${catalogue}`
			: `${header}\n\nEvery deferred tool in this session has already been revealed, so there is nothing left to search for.`;
	};

	const searchTool = createTool<
		{ query: string; limit?: number },
		{ revealed: string[]; message: string }
	>({
		name: TOOL_SEARCH_TOOL_NAME,
		description: describe(),
		inputSchema: zodToJsonSchema(ToolSearchInputSchema),
		execute: async (input) => {
			// The schema is passed as JSON Schema, so `createTool` cannot attach a
			// Zod validator; validate here or a malformed query would silently
			// match nothing.
			const { query, limit } = validateWithZod(ToolSearchInputSchema, input);
			const terms = queryTerms(query);
			const visible = [...deferred.values()].filter(
				(tool) => !options.loaded.has(tool.name),
			);
			const ranked = visible
				.map((tool) => ({ tool, score: scoreTool(tool, terms) }))
				.filter((entry) => entry.score > 0)
				.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
				.slice(0, limit ?? maxResults);
			const revealed = ranked.map((entry) => entry.tool.name);
			for (const name of revealed) {
				options.loaded.add(name);
			}
			return {
				revealed,
				message:
					revealed.length === 0
						? "No matching tools. Try different words, or work with the tools you already have."
						: `Now callable: ${revealed.join(", ")}.`,
			};
		},
	});
	// The runtime rebuilds definitions per request, so a getter re-derives the
	// catalogue at exactly the send-to-model boundary.
	Object.defineProperty(searchTool, "description", {
		get: describe,
		enumerable: true,
		configurable: true,
	});

	const beforeModel = (ctx: {
		request: { tools: readonly AgentToolDefinition[] };
	}): { tools: AgentToolDefinition[] } => {
		const hidden = new Set(catalogue(ctx.request.tools).map((tool) => tool.name));
		return {
			tools: ctx.request.tools.filter((tool) => !hidden.has(tool.name)),
		};
	};

	return { tool: searchTool, beforeModel };
}