import { describe, expect, it } from "vitest"
import {
	SUPPORTED_MCP_PROTOCOL_VERSIONS,
	advertisedMcpProtocolVersion,
} from "./mcp-protocol"

/**
 * The client advertised MCP 2024-11-05 and discarded the initialize response
 * entirely, so the revision a server actually agreed to was never seen. A pairing
 * that did not match looked identical to one that did, and any later failure
 * presented as something unrelated.
 *
 * The fix keeps backward compatibility, which matters more than being current:
 * the field is full of servers that only speak the oldest revision, so an
 * unsupported answer has to be refused while an older one is honoured.
 */
describe("MCP protocol negotiation", () => {
	it("advertises the newest revision it can speak", () => {
		expect(advertisedMcpProtocolVersion()).toBe(SUPPORTED_MCP_PROTOCOL_VERSIONS[0])
	})

	it("still accepts the oldest revision, because that is what most servers speak", () => {
		// Regressing this would break every server that has not been updated, which is
		// a far larger failure than never negotiating at all.
		expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).toContain("2024-11-05")
	})

	it("recognises the revisions in between, not just the two ends", () => {
		expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).toContain("2025-03-26")
	})

	it("does not claim support for a revision it cannot speak", () => {
		// Guard against a version being added to the list by reflex. Only revisions
		// whose tools/list and tools/call shapes this client sends are listed.
		expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).not.toContain("2026-07-28")
	})

	it("is ordered newest first, so the advertised version is the current one", () => {
		const sorted = [...SUPPORTED_MCP_PROTOCOL_VERSIONS].sort().reverse()
		expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).toEqual(sorted)
	})
})
