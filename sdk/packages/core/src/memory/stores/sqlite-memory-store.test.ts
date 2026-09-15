import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "./sqlite-memory-store";

describe("SqliteMemoryStore", () => {
	let dir: string;
	let store: SqliteMemoryStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cline-memory-"));
		store = new SqliteMemoryStore({ dbPath: join(dir, "memory.db") });
		store.init();
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("appends episodic records with assigned ids and timestamps", () => {
		const record = store.append({
			kind: "episodic",
			subtype: "pitfall",
			title: "win32 spawn quoting",
			detail: "shell:true concatenation truncates paths with spaces",
			workspacePath: "/repo/a",
			tags: ["win32", "spawn"],
		});
		expect(record.kind).toBe("episodic");
		expect(record.id).toBeTruthy();
		expect(record.subtype).toBe("pitfall");
		expect(record.createdAt).toBeTruthy();
		expect(record.tags).toEqual(["win32", "spawn"]);

		const queried = store.query({ kind: "episodic" });
		expect(queried).toHaveLength(1);
		expect(queried[0]?.id).toBe(record.id);
	});

	it("appends semantic fact cards and resolves same-subject conflicts by supersession", () => {
		const first = store.append({
			kind: "semantic",
			subject: "auth:token-refresh",
			fact: "token refresh happens in the gateway layer",
			workspacePath: "/repo/a",
		});
		expect(first.kind).toBe("semantic");
		expect(first.subtype).toBe("codebase-fact");

		const second = store.append({
			kind: "semantic",
			subject: "auth:token-refresh",
			fact: "token refresh happens in the core llms client",
			workspacePath: "/repo/a",
		});

		// Default query excludes superseded facts.
		const active = store.query({ kind: "semantic" });
		expect(active).toHaveLength(1);
		expect(active[0]?.id).toBe(second.id);
		if (active[0]?.kind !== "semantic") {
			throw new Error("expected semantic record");
		}
		expect(active[0]?.fact).toBe(
			"token refresh happens in the core llms client",
		);

		// The trail stays queryable via get().
		const previous = store.get(first.id);
		expect(previous?.kind).toBe("semantic");
		if (previous?.kind !== "semantic") {
			throw new Error("expected semantic record");
		}
		expect(previous.supersededById).toBe(second.id);
	});

	it("scopes supersession to the workspace path", () => {
		store.append({
			kind: "semantic",
			subject: "build:bundle",
			fact: "repo A bundles with esbuild",
			workspacePath: "/repo/a",
		});
		store.append({
			kind: "semantic",
			subject: "build:bundle",
			fact: "repo B bundles with rolldown",
			workspacePath: "/repo/b",
		});
		const all = store.query({ kind: "semantic" });
		expect(all).toHaveLength(2);
		expect(all.map((record) => record.workspacePath).sort()).toEqual([
			"/repo/a",
			"/repo/b",
		]);
	});

	it("filters by workspace, subtype, tags, and keyword", () => {
		store.append({
			kind: "episodic",
			subtype: "decision",
			title: "adopt vitest",
			detail: "migrate mocha suites to vitest",
			workspacePath: "/repo/a",
			tags: ["testing"],
		});
		store.append({
			kind: "episodic",
			subtype: "pitfall",
			title: "parallel starvation",
			detail: "bun --parallel starves cold suites",
			workspacePath: "/repo/b",
			tags: ["testing", "ci"],
		});

		expect(store.query({ workspacePath: "/repo/a" })).toHaveLength(1);
		expect(store.query({ subtypes: ["pitfall"] })).toHaveLength(1);
		expect(store.query({ tags: ["ci"] })).toHaveLength(1);
		expect(store.query({ keyword: "VITEST" })).toHaveLength(1);
		const starved = store.query({ keyword: "starves" })[0];
		expect(starved?.kind).toBe("episodic");
		if (starved?.kind !== "episodic") {
			throw new Error("expected episodic record");
		}
		expect(starved.title).toBe("parallel starvation");
		expect(store.query({ limit: 1 })).toHaveLength(1);
	});

	it("rejects unsupported memory kinds", () => {
		expect(() =>
			store.append({
				kind: "procedural" as never,
			} as never),
		).toThrow("unsupported memory kind");
	});

	it("persists across store instances (WAL durability)", () => {
		store.append({
			kind: "episodic",
			title: "durable",
			detail: "survives reopen",
		});
		store.close();
		const reopened = new SqliteMemoryStore({
			dbPath: join(dir, "memory.db"),
		});
		reopened.init();
		expect(reopened.query({ keyword: "durable" })).toHaveLength(1);
		reopened.close();
	});
});
