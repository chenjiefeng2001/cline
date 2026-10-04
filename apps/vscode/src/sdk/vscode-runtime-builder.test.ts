import { describe, expect, it, vi } from "vitest"
import type { McpHub } from "../services/mcp/McpHub"
import { createVscodeExtraTools } from "./vscode-runtime-builder"

/**
 * createVscodeExtraTools is the single place where host-supplied tools reach the
 * agent, so a tool that is built but never added here is invisible to the model
 * even though every unit test on the tool itself passes. This pins the wiring.
 */
function fakeHub(overrides: Partial<Record<string, unknown>> = {}): McpHub {
	return {
		getServers: () => [],
		listAllResources: vi.fn(async () => ({ resources: [], templates: [] })),
		listAllPrompts: vi.fn(async () => []),
		readResource: vi.fn(async () => ({ contents: [] })),
		...overrides,
	} as unknown as McpHub
}

describe("createVscodeExtraTools", () => {
	it("exposes MCP resource and prompt tools to the agent", async () => {
		const tools = await createVscodeExtraTools(fakeHub())
		const names = tools.map((t) => t.name)

		// Without these three, a server that publishes resources or prompts is
		// half-connected: the data sits in McpHub with no route to the model.
		expect(names).toContain("list_mcp_resources")
		expect(names).toContain("read_mcp_resource")
		expect(names).toContain("list_mcp_prompts")
	})

	it("keeps the resource tools alongside attempt_completion", async () => {
		const tools = await createVscodeExtraTools(fakeHub())
		const names = tools.map((t) => t.name)

		expect(names).toContain("attempt_completion")
		// Order matters only for readability of logs, but attempt_completion has
		// always been first; the MCP tools are additive and must not displace it.
		expect(names[0]).toBe("attempt_completion")
	})
})
