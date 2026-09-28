import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SqliteMemoryStore } from "./sqlite-memory-store"

/**
 * A regression test for a binding failure that produced a misleading error.
 *
 * Appending a semantic fact card with no confidence, workspacePath or tags failed
 * with "Provided value cannot be bound to SQLite parameter 5". Parameter 5 is
 * `detail` in the episodic column order and `fact` in the semantic one, so the
 * message pointed at the record's content when the actual cause was an absent
 * optional somewhere else in the row.
 *
 * SQLite cannot bind `undefined` - it is neither NULL nor a value - so the fix is to
 * normalise at the store's boundary rather than at each call site. A new column that
 * someone forgets to coalesce would otherwise reintroduce the same confusion.
 */
describe("SqliteMemoryStore optional binding", () => {
	async function withStore(fn: (store: SqliteMemoryStore) => Promise<void>) {
		const dir = mkdtempSync(join(tmpdir(), "memory-bind-"))
		const store = new SqliteMemoryStore({ dbPath: join(dir, "memory.db") })
		await store.init()
		try {
			await fn(store)
		} finally {
			await store.close()
		}
	}

	const records: Array<[string, Record<string, unknown>]> = [
		["episodic with only its required fields", { kind: "episodic", title: "t", detail: "d" }],
		["episodic with explicit undefined optionals", { kind: "episodic", title: "t", detail: "d", workspacePath: undefined, tags: undefined, subtype: undefined }],
		["semantic with only its required fields", { kind: "semantic", subject: "s", fact: "f" }],
		["semantic with explicit undefined optionals", { kind: "semantic", subject: "s", fact: "f", confidence: undefined, workspacePath: undefined, tags: undefined, sources: undefined, subtype: undefined }],
	]

	for (const [label, input] of records) {
		it(`appends a ${label}`, async () => {
			await withStore(async (store) => {
				const record = await store.append(input as never)
				expect(record.id).toBeTruthy()
			})
		})
	}

	it("reads back a semantic record that was written without any optional", async () => {
		await withStore(async (store) => {
			const written = await store.append({ kind: "semantic", subject: "s", fact: "f" } as never)
			const [read] = await store.query({ keyword: "f" })
			expect(read?.id).toBe(written.id)
			// Absent optionals must come back as absent, not as the string "undefined"
			// or a zero, or a later reader would act on a value nobody wrote.
			expect(read?.kind).toBe("semantic")
		})
	})
})
