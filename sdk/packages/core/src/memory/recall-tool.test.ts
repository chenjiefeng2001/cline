import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryRecallTool } from "./recall-tool";
import { SqliteMemoryStore } from "./stores/sqlite-memory-store";

describe("createMemoryRecallTool", () => {
	let dir: string;
	let store: SqliteMemoryStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-recall-"));
		store = new SqliteMemoryStore({ dbPath: join(dir, "memory.db") });
		store.append({
			kind: "episodic",
			subtype: "pitfall",
			title: "win32 spawn quoting",
			detail: "shell:true concatenation truncates paths with spaces",
			workspacePath: "/repo/a",
			tags: ["win32", "spawn"],
		});
		store.append({
			kind: "semantic",
			subject: "auth:token-refresh",
			fact: "token refresh happens in the core llms client",
			workspacePath: "/repo/a",
		});
		store.append({
			kind: "semantic",
			subject: "auth:token-refresh",
			fact: "token refresh happens in the gateway layer",
			workspacePath: "/repo/a",
		});
		store.append({
			kind: "episodic",
			subtype: "decision",
			title: "other repo note",
			detail: "unrelated",
			workspacePath: "/repo/b",
		});
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns formatted records filtered by keyword and workspace", async () => {
		const tool = createMemoryRecallTool({
			store,
			workspacePath: "/repo/a",
		});
		const result = await tool.execute({ keyword: "spawn" }, {
			agentId: "a1",
		} as never);
		expect(result.records).toHaveLength(1);
		expect(result.records[0]).toMatchObject({
			kind: "episodic",
			subtype: "pitfall",
			title: "win32 spawn quoting",
		});
	});

	it("excludes superseded semantic facts (activeOnly)", async () => {
		const tool = createMemoryRecallTool({ store });
		const result = await tool.execute(
			{ kind: "semantic", subject: "auth:token-refresh" },
			{ agentId: "a1" } as never,
		);
		expect(result.records).toHaveLength(1);
		expect(result.records[0]?.fact).toBe(
			"token refresh happens in the gateway layer",
		);
	});

	it("applies the workspace resolver from the call context", async () => {
		const tool = createMemoryRecallTool({
			store,
			workspacePath: (context) =>
				(context as { cwd?: string }).cwd as string | undefined,
		});
		const result = await tool.execute({ kind: "episodic" }, {
			agentId: "a1",
			cwd: "/repo/b",
		} as never);
		expect(result.records).toHaveLength(1);
		expect(result.records[0]?.title).toBe("other repo note");
	});

	it("filters by tags and respects the limit", async () => {
		const tool = createMemoryRecallTool({ store });
		const tagged = await tool.execute({ tags: ["win32"] }, {
			agentId: "a1",
		} as never);
		expect(tagged.records).toHaveLength(1);
		const limited = await tool.execute({ workspacePath: "/repo/a", limit: 1 }, {
			agentId: "a1",
		} as never);
		expect(limited.records).toHaveLength(1);
	});

	it("exposes the tool definition with a JSON schema", () => {
		const tool = createMemoryRecallTool({ store });
		expect(tool.name).toBe("recall_memory");
		expect(tool.description).toContain("Recall project memory");
		expect(tool.inputSchema).toBeTruthy();
	});
});
