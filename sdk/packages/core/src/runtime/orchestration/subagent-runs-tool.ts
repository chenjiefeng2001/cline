import { z } from "zod";
import {
	createTool,
	validateWithZod,
	zodToJsonSchema,
	type AgentTool,
} from "@cline/shared";
import {
	describeSubAgentRun,
	type SubAgentRunRecord,
	type SubAgentRunRegistry,
} from "./subagent-run-registry";

const ReadInput = z.object({
	runId: z
		.string()
		.trim()
		.min(1)
		.describe("Run id returned by spawn_agent when background was requested."),
	includeResult: z
		.boolean()
		.optional()
		.describe(
			"Include the sub-agent's final text. Off by default, since a long result can be large enough to matter in the response itself.",
		),
});

const AwaitInput = z.object({
	runId: z
		.string()
		.trim()
		.min(1)
		.describe("Run id to wait for."),
	timeoutMs: z
		.number()
		.int()
		.min(1)
		.max(600_000)
		.optional()
		.describe(
			"How long to wait before returning the current status. Defaults to 60000. Timing out leaves the run going.",
		),
	includeResult: z
		.boolean()
		.optional()
		.describe("Include the sub-agent's final text when it has finished."),
});

/**
 * Reads results of sub-agents started with `background: true`.
 *
 * Without this, backgrounding would be fire-and-forget: the work would finish
 * where nobody can see it and its tokens would be spent invisibly. The registry
 * plus this tool is the retrieval path that makes backgrounding safe.
 */
export function createSubAgentRunsTool(
	runs: SubAgentRunRegistry,
): AgentTool<unknown, unknown> {
	return createTool<unknown, Record<string, unknown>>({
		name: "subagent_runs",
		description:
			"Inspect sub-agents started with `background: true`. Use `list` to see what is running or finished, " +
			"`read` to fetch one result by runId, `await` to block until one finishes, and `prune` to drop finished " +
			"records. A backgrounded sub-agent's result is not delivered to you automatically — read it here or you " +
			"will have paid for the work without using it.",
		inputSchema: zodToJsonSchema(
			z.discriminatedUnion("action", [
				z.object({
					action: z.literal("list").describe("List all background runs and their status."),
				}),
				z.object({
					action: z.literal("read").describe("Read one run's status and, optionally, its result."),
					runId: ReadInput.shape.runId,
					includeResult: ReadInput.shape.includeResult,
				}),
				z.object({
					action: z
						.literal("await")
						.describe("Wait for a run to finish, then report it."),
					runId: AwaitInput.shape.runId,
					timeoutMs: AwaitInput.shape.timeoutMs,
					includeResult: AwaitInput.shape.includeResult,
				}),
				z.object({
					action: z
						.literal("prune")
						.describe("Delete finished records. Running ones are kept."),
				}),
			]),
		),
		execute: async (input) => {
			const { action } = input as { action?: unknown };
			if (action === "list") {
				const all = runs.list();
				return {
					runs: all.map((run) =>
						describeSubAgentRun({
							...(run as SubAgentRunRecord),
							// Status listing deliberately omits result text; `read` is the
							// way to get the payload.
							resultText: undefined,
						}),
					),
					running: runs.hasRunning(),
				};
			}
			if (action === "read") {
				const { runId, includeResult } = validateWithZod(ReadInput, input);
				const record = runs.get(runId);
				if (!record) {
					return { error: `Unknown run: ${runId}` };
				}
				if (includeResult) {
					// Reading the result is what marks it collected. Without this the
					// completion guard could never tell a result that was used from one
					// that was paid for and ignored.
					runs.markRead(runId);
				}
				return {
					run: describeSubAgentRun(
						includeResult ? record : { ...record, resultText: undefined },
					),
				};
			}
			if (action === "await") {
				const { runId, timeoutMs, includeResult } = validateWithZod(
					AwaitInput,
					input,
				);
				if (!runs.get(runId)) {
					return { error: `Unknown run: ${runId}` };
				}
				const record = await runs.await(runId, timeoutMs ?? 60_000);
				if (!record) {
					return { error: `Unknown run: ${runId}` };
				}
				// Only a settled run counts as collected; a timeout leaves it unread so
				// the guard still prompts.
				if (includeResult && record.status !== "running") {
					runs.markRead(runId);
				}
				return {
					run: describeSubAgentRun(
						includeResult ? record : { ...record, resultText: undefined },
					),
					stillRunning: record.status === "running",
				};
			}
			if (action === "prune") {
				return { pruned: runs.pruneFinished() };
			}
			// Unreachable via the schema; kept so a malformed call explains itself
			// rather than returning an empty result that reads as "no runs".
			return { error: `Unsupported action: ${String(action)}` };
		},
		timeoutMs: 660_000,
		retryable: false,
	});
}