import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMemoryStore } from "./stores/sqlite-memory-store"
import { createMemoryRememberTool, MEMORY_REMEMBER_TOOL_NAME } from "./remember-tool"
import { createMemoryRecallTool, MEMORY_RECALL_TOOL_NAME } from "./recall-tool"
import type { AgentToolContext } from "@cline/shared"

const ctx: AgentToolContext = {
	sessionId: "s1",
	agentId: "a1",
	conversationId: "c1",
	iteration: 1,
	toolCallId: "call-1",
} as AgentToolContext;

/**
 * The write path, which did not exist.
 *
 * The store had an `append()` that nothing called and a recall tool that no host
 * instantiated, so the whole layer could only ever come back empty. These cases cover
 * the two things that make the pair useful: an agent-initiated write actually lands
 * and is then recallable, and the two record kinds are validated differently because
 * they make different kinds of claim - an episodic record is history and stays true,
 * a semantic record is the current state of a subject and supersedes the previous one.
 */
describe("remember tool", () => {
	async function withStore(fn: (store: SqliteMemoryStore) => Promise<void>) {
		const dir = mkdtempSync(join(tmpdir(), "memory-write-"));
		const store = new SqliteMemoryStore({ dbPath: join(dir, "memory.db") });
		await store.init();
		try {
			await fn(store);
		} finally {
			await store.close();
		}
	}

	it("is named distinctly from the recall tool", () => {
		// Two tools that collapse to one name would silently shadow each other in the
		// model's tool list.
		expect(MEMORY_REMEMBER_TOOL_NAME).toBe("remember")
		expect(MEMORY_RECALL_TOOL_NAME).not.toBe(MEMORY_REMEMBER_TOOL_NAME)
	})

	it("writes an episodic record that recall can then find", async () => {
		await withStore(async (store) => {
			const remember = createMemoryRememberTool({ store, workspacePath: "/ws" })
			const written = (await remember.execute(
				{
					kind: "episodic",
					title: "Use git stash create for checkpoints",
					detail: "git stash push would dirty the user's working tree list.",
				},
				ctx,
			)) as { record: { id: string } }
			expect(written.record.id).toBeTruthy()

			const recall = createMemoryRecallTool({ store })
			const found = (await recall.execute({ keyword: "stash" }, ctx)) as {
				records: Array<{ title?: string }>
			}
			expect(found.records.some((r) => r.title === "Use git stash create for checkpoints")).toBe(true)
		})
	})

	it("writes a semantic fact card that recall finds by subject", async () => {
		await withStore(async (store) => {
			const remember = createMemoryRememberTool({ store, workspacePath: "/ws" })
			await remember.execute(
				{ kind: "semantic", subject: "build.sdk", fact: "Run from sdk/, not the repo root." },
				ctx,
			)
			const recall = createMemoryRecallTool({ store })
			const found = (await recall.execute({ subject: "build.sdk" }, ctx)) as {
				records: Array<{ fact?: string }>
			}
			expect(found.records[0]?.fact).toContain("sdk/")
		})
	})

	it("rejects an episodic record with no content rather than storing an empty claim", async () => {
		// A record that says nothing is a row the model will later recall and have to
		// reason about, for no information. Refusing at write time is cheaper than
		// filtering it out at every read.
		await withStore(async (store) => {
			const remember = createMemoryRememberTool({ store })
			await expect(remember.execute({ kind: "episodic", title: "  " }, ctx)).rejects.toThrow(
				/needs both/,
			)
		})
	})

	it("rejects a semantic record with no fact", async () => {
		await withStore(async (store) => {
			const remember = createMemoryRememberTool({ store })
			await expect(
				remember.execute({ kind: "semantic", subject: "x" }, ctx),
			).rejects.toThrow(/needs both/)
		})
	})

	it("applies the documented default subtypes", async () => {
		await withStore(async (store) => {
			const remember = createMemoryRememberTool({ store })
			const episodic = (await remember.execute(
				{ kind: "episodic", title: "t", detail: "d" },
				ctx,
			)) as { record: { subtype: string } }
			expect(episodic.record.subtype).toBe("decision")

			const semantic = (await remember.execute(
				{ kind: "semantic", subject: "s", fact: "f" },
				ctx,
			)) as { record: { subtype: string } }
			expect(semantic.record.subtype).toBe("codebase-fact")
		})
	})
})
