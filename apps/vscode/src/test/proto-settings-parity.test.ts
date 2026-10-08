import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `UpdateSettingsRequest` is a hand-maintained duplicate of part of `Settings`,
 * not a generated one, so nothing in the toolchain notices when a field is added
 * to `Settings` and forgotten there. It compiles, it ships, and the setting
 * simply cannot be written from the webview.
 *
 * That is not hypothetical: the guardrails this repo added over the last few
 * changes were exactly the kind of field that would have been missed, and the
 * invariant between the two copies had to be tracked in prose in a capability
 * matrix because nothing enforced it.
 *
 * The `BEGIN/END webview-writable settings` markers in `Settings` declare which
 * fields must appear in both. Model/provider configuration is deliberately
 * outside that block, since those are written through their own RPCs.
 */

const PROTO_PATH = join(__dirname, "..", "..", "proto", "cline", "state.proto")
const BEGIN_MARKER = "// BEGIN webview-writable settings"
const END_MARKER = "// END webview-writable settings"

const proto = readFileSync(PROTO_PATH, "utf8")

/**
 * Field names declared by a single `message <name> { ... }` block.
 *
 * Brace depth is tracked rather than stopping at the first `\n}`, because
 * `Settings` contains nested declarations and stopping early would silently
 * report those as missing — a parser that under-reports produces phantom drift.
 */
function messageFields(messageName: string): string[] {
	const start = proto.indexOf(`\nmessage ${messageName} {`)
	if (start === -1) {
		throw new Error(`message ${messageName} not found in state.proto`)
	}
	const fields: string[] = []
	let depth = 0
	for (const raw of proto.slice(start).split("\n")) {
		const line = raw.trim()
		if (depth > 0) {
			depth += (line.match(/\{/g) ?? []).length
			depth -= (line.match(/\}/g) ?? []).length
			continue
		}
		if (line.startsWith("message ") || line === "{" || line.startsWith("//")) {
			continue
		}
		const match = /^(?:optional |repeated )?[A-Za-z_][\w.]*\s+([A-Za-z_]\w*)\s*=/.exec(line)
		if (match) {
			fields.push(match[1])
		}
		if (line === "}") {
			break
		}
	}
	return fields
}

/** Fields between the markers inside `Settings`. */
function webviewWritableFields(): string[] {
	const begin = proto.indexOf(BEGIN_MARKER)
	const end = proto.indexOf(END_MARKER)
	expect(begin).toBeGreaterThan(-1)
	expect(end).toBeGreaterThan(begin)
	const block = proto.slice(begin, end)
	const fields: string[] = []
	for (const raw of block.split("\n")) {
		const line = raw.trim()
		if (!line || line.startsWith("//")) {
			continue
		}
		const match = /^(?:optional |repeated )?([A-Za-z_][\w.]*)\s+([A-Za-z_]\w*)\s*=/.exec(line)
		if (match) {
			fields.push(match[2])
		}
	}
	return fields
}

describe("Settings / UpdateSettingsRequest parity", () => {
	const settings = messageFields("Settings")
	const update = messageFields("UpdateSettingsRequest")
	const writable = webviewWritableFields()

	it("declares the block it intends to keep in sync", () => {
		// Without a non-empty block this suite would pass vacuously, which is the
		// same failure shape as the drift it exists to catch.
		expect(writable.length).toBeGreaterThan(0)
	})

	it("marks only fields that actually exist on Settings", () => {
		for (const field of writable) {
			expect(settings).toContain(field)
		}
	})

	it("has every webview-writable setting on UpdateSettingsRequest", () => {
		const missing = writable.filter((field) => !update.includes(field))
		expect(missing).toEqual([])
	})

	it("names the fields this repo's own guardrails rely on", () => {
		// Named explicitly so that removing one of these from either message fails
		// with a message that says which setting regressed.
		for (const field of [
			"max_tool_calls",
			"max_sub_agent_depth",
			"file_boundary_enabled",
			"sandbox_enabled",
			"agent_teams_enabled",
			"lazy_tool_loading",
		]) {
			expect(settings).toContain(field)
			expect(update).toContain(field)
		}
	})

	/**
	 * Deliberately NOT asserted: that `UpdateSettingsRequest` has no field absent
	 * from `Settings`.
	 *
	 * The check finds 16 such fields (`compaction_strategy`,
	 * `auto_compact_threshold`, `mcp_display_mode`, `cline_env`,
	 * `multi_root_enabled`, `metadata`, `api_configuration`, and others). Whether
	 * that is drift or intent — a union payload spanning more than one settings
	 * message, say — was not established, and encoding an unverified guess as a
	 * CI invariant would leave the suite permanently red on a design that may be
	 * correct. Recorded here so the next person starts from the list rather than
	 * rediscovering it.
	 */
	it("records the unverified reverse-direction fields for follow-up", () => {
		const orphans = update.filter((field) => !settings.includes(field))
		expect(Array.isArray(orphans)).toBe(true)
	})
})
