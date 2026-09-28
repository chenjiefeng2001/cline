import { z } from "zod"
import type { AgentTool, AgentToolContext } from "@cline/shared"
import { createTool, zodToJsonSchema } from "@cline/shared"
import type { MemoryStore } from "./memory-store"
import type { MemoryRecord, MemoryRecordInput } from "./models/memory-records"
import { MEMORY_RECALL_TOOL_NAME } from "./recall-tool"

/** Name of the write-side tool. Paired with {@link MEMORY_RECALL_TOOL_NAME}. */
export const MEMORY_REMEMBER_TOOL_NAME = "remember";

const MemoryRememberInputSchema = z.object({
	kind: z.enum(["episodic", "semantic"]).describe(
		"episodic = a decision, pitfall or discovery worth recalling later in this or a " +
			"later session. semantic = a durable fact about the codebase, where a " +
			"newer fact on the same subject supersedes the older one.",
	),
	subtype: z
		.string()
		.optional()
		.describe("Defaults to 'decision' for episodic and 'codebase-fact' for semantic."),
	title: z.string().optional().describe("Episodic only: one line naming the decision."),
	detail: z.string().optional().describe("Episodic only: what was decided and why it mattered."),
	subject: z.string().optional().describe("Semantic only: the thing the fact is about."),
	fact: z.string().optional().describe("Semantic only: the fact itself."),
	confidence: z.number().min(0).max(1).optional().describe("Semantic only, 0..1."),
	tags: z.array(z.string()).optional(),
});

export type MemoryRememberInput = z.infer<typeof MemoryRememberInputSchema>;

export interface MemoryRememberToolOptions {
	store: MemoryStore;
	workspacePath?: string;
}

function formatRecord(record: MemoryRecord): Record<string, unknown> {
	// MemoryRecord is a discriminated union, so the content fields only exist on one
	// branch. Narrowing on kind is what keeps the projected shape honest instead of
	// reading a property that is absent on the other variant.
	return record.kind === "episodic"
		? {
				id: record.id,
				kind: record.kind,
				subtype: record.subtype,
				title: record.title,
				detail: record.detail,
				createdAt: record.createdAt,
			}
		: {
				id: record.id,
				kind: record.kind,
				subtype: record.subtype,
				subject: record.subject,
				fact: record.fact,
				createdAt: record.createdAt,
			};
}

/**
 * Write path for project memory, paired with `recall_memory`.
 *
 * Until now the store had an `append()` that nothing called and a recall tool that
 * no host instantiated, so the layer could only ever return empty. This is the
 * agent-initiated half of the write strategy: the model decides a decision or a
 * codebase fact is worth carrying forward, and names it here.
 *
 * The two record kinds are validated separately because they are different claims.
 * An episodic record is "this happened and here is why", which stays true as
 * history. A semantic record is "this is the current state of X", and the store
 * supersedes the previous active record for the same subject, so a later
 * correction replaces the earlier belief rather than sitting beside it
 * contradictorily. A half-filled record of either kind would be a claim with no
 * content, so it is rejected rather than stored.
 */
export function createMemoryRememberTool(
	options: MemoryRememberToolOptions,
): AgentTool<MemoryRememberInput, Record<string, unknown>> {
	return createTool<MemoryRememberInput, Record<string, unknown>>({
		name: MEMORY_REMEMBER_TOOL_NAME,
		description:
			"Save a decision, pitfall or durable codebase fact so it can be recalled in this " +
			"or a later session. Use for things that were non-obvious and cost time to work " +
			"out, not for things already written down in the repository. Episodic records are " +
			"history; semantic records supersede the previous fact for the same subject.",
		inputSchema: zodToJsonSchema(MemoryRememberInputSchema),
		timeoutMs: 10_000,
		retryable: false,
		maxRetries: 0,
		execute: async (input, _context: AgentToolContext) => {
			const workspacePath = options.workspacePath;
			if (input.kind === "episodic") {
				if (!input.title?.trim() || !input.detail?.trim()) {
					throw new Error(
						"Episodic memory needs both `title` and `detail`. A record without a " +
							"decision in it is not worth keeping.",
					);
				}
				const record: MemoryRecordInput = {
					kind: "episodic",
					subtype: input.subtype ?? "decision",
					title: input.title.trim(),
					detail: input.detail.trim(),
					workspacePath,
					tags: input.tags,
				};
				return { record: formatRecord(await options.store.append(record)) };
			}

			if (!input.subject?.trim() || !input.fact?.trim()) {
				throw new Error(
					"Semantic memory needs both `subject` and `fact`. The subject is what a " +
						"later recall will search on.",
				);
			}
			const record: MemoryRecordInput = {
				kind: "semantic",
				subtype: input.subtype ?? "codebase-fact",
				subject: input.subject.trim(),
				fact: input.fact.trim(),
				confidence: input.confidence,
				workspacePath,
				tags: input.tags,
			};
			return { record: formatRecord(await options.store.append(record)) };
		},
	});
}
