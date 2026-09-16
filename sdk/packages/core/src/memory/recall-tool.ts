/**
 * Memory recall tool — the agentic-retrieval surface for the memory layer
 * [P1-1 wiring, roadmap].
 *
 * Gap D2 recovery philosophy: structured/keyword queries feed agentic
 * search — the agent recalls project decisions, pitfalls, and codebase
 * fact cards via this tool instead of the "memory in system prompt"
 * anti-pattern. Hosts hand this tool to the agent runtime (e.g. through
 * extraTools) alongside the memory store.
 */

import type { AgentTool, AgentToolContext } from "@cline/shared";
import { createTool, zodToJsonSchema } from "@cline/shared";
import { z } from "zod";
import type { MemoryStore } from "./memory-store";
import type { MemoryQueryFilter, MemoryRecord } from "./models/memory-records";

export const MEMORY_RECALL_TOOL_NAME = "recall_memory";

export const MemoryRecallInputSchema = z.object({
	kind: z
		.enum(["episodic", "semantic", "procedural"])
		.optional()
		.describe("Filter by CoALA memory kind."),
	subtypes: z
		.array(z.string())
		.optional()
		.describe(
			'Filter by subtype (e.g. "decision", "pitfall", "codebase-fact").',
		),
	subject: z
		.string()
		.optional()
		.describe("Exact subject match for semantic fact cards."),
	workspacePath: z
		.string()
		.optional()
		.describe("Project scope; defaults to the host-provided workspace."),
	keyword: z
		.string()
		.optional()
		.describe("Case-insensitive substring match over titles/details/facts."),
	tags: z
		.array(z.string())
		.optional()
		.describe("Match records carrying all of these tags."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Maximum records to return. Defaults to 20."),
});

export type MemoryRecallInput = z.infer<typeof MemoryRecallInputSchema>;

export interface MemoryRecallToolOptions {
	store: MemoryStore;
	/**
	 * Default workspace scope applied when the input does not name one;
	 * fixed value or per-call resolver (e.g. from the call context).
	 */
	workspacePath?: string | ((context: AgentToolContext) => string | undefined);
}

function formatRecord(record: MemoryRecord): Record<string, unknown> {
	if (record.kind === "semantic") {
		return {
			kind: record.kind,
			subtype: record.subtype,
			subject: record.subject,
			fact: record.fact,
			confidence: record.confidence,
			sources: record.sources,
			tags: record.tags,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		};
	}
	return {
		kind: record.kind,
		subtype: record.subtype,
		title: record.title,
		detail: record.detail,
		sessionId: record.sessionId,
		tags: record.tags,
		createdAt: record.createdAt,
	};
}

/**
 * Creates the recall_memory tool over a memory store. The store's own
 * query filter (kind/subtype/subject/keyword/tags/limit) is the retrieval
 * mechanism; superseded semantic facts are excluded by default
 * (activeOnly), so the agent sees the current fact per subject.
 */
export function createMemoryRecallTool(
	options: MemoryRecallToolOptions,
): AgentTool<MemoryRecallInput, { records: Record<string, unknown>[] }> {
	const resolveWorkspace = (context: AgentToolContext): string | undefined =>
		typeof options.workspacePath === "function"
			? options.workspacePath(context)
			: options.workspacePath;
	return createTool({
		name: MEMORY_RECALL_TOOL_NAME,
		description:
			"Recall project memory: episodic decision/pitfall records and semantic " +
			"codebase fact cards. Search by kind, subtype, subject, tags, or keyword; " +
			"superseded facts are excluded so each subject shows its current state.",
		inputSchema: zodToJsonSchema(MemoryRecallInputSchema),
		timeoutMs: 10_000,
		retryable: false,
		maxRetries: 0,
		execute: async (input, context) => {
			const filter: MemoryQueryFilter = {
				kind: input.kind,
				subtypes: input.subtypes,
				subject: input.subject,
				workspacePath: input.workspacePath ?? resolveWorkspace(context),
				tags: input.tags,
				activeOnly: true,
				keyword: input.keyword,
				limit: input.limit ?? 20,
			};
			const records = await options.store.query(filter);
			return { records: records.map(formatRecord) };
		},
	});
}
