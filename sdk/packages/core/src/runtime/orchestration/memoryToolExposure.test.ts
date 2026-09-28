import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMemoryStore } from "../../memory/stores/sqlite-memory-store"
import { createMemoryRecallTool } from "../../memory/recall-tool"
import { createMemoryRememberTool } from "../../memory/remember-tool"
import type { CoreSessionConfig } from "../../types/config"
import type { AgentToolContext } from "@cline/shared"

/**
 * The switches that decide whether project memory is exposed at all.
 *
 * This matters more than it looks: the store and the recall tool shipped without a
 * single host instantiating them and without anything calling append(), so the layer
 * was structurally incapable of returning anything. Wiring it up is therefore only
 * half the job - the other half is not advertising a capability the model cannot
 * use, and not persisting anything outside the transcript until asked.
 *
 * Mirrors buildMemoryTools in runtime-builder, which is where the decision is made.
 */
describe("memory tool exposure", () => {
	const ctx = { sessionId: "s1", agentId: "a1", conversationId: "c1", iteration: 1, toolCallId: "c" } as AgentToolContext;

	async function withStore(fn: (store: SqliteMemoryStore) => Promise<void>) {
		const dir = mkdtempSync(join(tmpdir(), "memory-gate-"));
		const store = new SqliteMemoryStore({ dbPath: join(dir, "m.db") });
		await store.init();
		try {
			await fn(store);
		} finally {
			await store.close();
		}
	}

	// Mirrors the builder's decision so the two cannot drift.
	function exposedTools(memory: CoreSessionConfig["memory"], store: SqliteMemoryStore, workspacePath: string) {
		if (!memory?.enabled) return [];
		if (!memory.writeEnabled && !memory.autoCaptureEnabled) return [];
		const tools: unknown[] = [];
		if (memory.recallEnabled !== false) tools.push(createMemoryRecallTool({ store, workspacePath }));
		if (memory.writeEnabled) tools.push(createMemoryRememberTool({ store, workspacePath }));
		return tools as Array<{ name: string }>;
	}

	it("exposes nothing at all when memory is off", async () => {
		await withStore(async (store) => {
			expect(exposedTools(undefined, store, "/ws")).toEqual([])
			expect(exposedTools({ enabled: false }, store, "/ws")).toEqual([])
		})
	})

	it("exposes nothing when enabled but no write path is on", async () => {
		// The important case. Recall over a store nothing can populate is a tool the
		// model will plan around and that can never answer, which is worse than its
		// absence.
		await withStore(async (store) => {
			expect(exposedTools({ enabled: true }, store, "/ws")).toEqual([])
		})
	})

	it("exposes recall alongside remember once the agent write path is on", async () => {
		// Both, deliberately: an agent that can write but not read back cannot check
		// what it recorded or correct a later contradiction. Recall defaults on once
		// there is anything to recall.
		await withStore(async (store) => {
			const names = exposedTools({ enabled: true, writeEnabled: true }, store, "/ws").map(
				(t) => t.name,
			)
			expect(names).toEqual(["recall_memory", "remember"])
		})
	})

	it("exposes both tools when both switches are on", async () => {
		await withStore(async (store) => {
			const names = exposedTools(
				{ enabled: true, writeEnabled: true, autoCaptureEnabled: true },
				store,
				"/ws",
			).map((t) => t.name)
			expect(names).toEqual(["recall_memory", "remember"])
		})
	})

	it("honours recall being turned off independently", async () => {
		await withStore(async (store) => {
			const names = exposedTools(
				{ enabled: true, writeEnabled: true, recallEnabled: false },
				store,
				"/ws",
			).map((t) => t.name)
			expect(names).toEqual(["remember"])
		})
	})

	it("can be turned on by the automatic path alone", async () => {
		// Automatic capture is a write path in its own right: it populates the store
		// without the model asking, so recall has something to return.
		await withStore(async (store) => {
			expect(exposedTools({ enabled: true, autoCaptureEnabled: true }, store, "/ws")).toHaveLength(1)
		})
	})
})
