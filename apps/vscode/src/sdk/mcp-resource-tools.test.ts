import type { AgentToolContext } from "@cline/shared"
import { describe, expect, it, vi } from "vitest"
import { createMcpResourceTools, type McpResourceToolDeps } from "./mcp-resource-tools"

/**
 * These tools close the gap where `McpHub` could list and read MCP resources
 * and prompts but nothing exposed them to the model. The tests therefore pin the
 * behaviour a caller depends on: cross-server aggregation (an agent has no notion
 * of "which server"), graceful handling of third-party misbehaviour, and context
 * safety on oversized bodies.
 */
function makeDeps(overrides: Partial<McpResourceToolDeps> = {}): McpResourceToolDeps {
	return {
		listAllResources: vi.fn(async () => ({ resources: [], templates: [] })),
		listAllPrompts: vi.fn(async () => []),
		readResource: vi.fn(async () => ({ contents: [] })),
		...overrides,
	}
}

const ctx: AgentToolContext = { agentId: "agent-1", iteration: 1 }

function byName(tools: ReturnType<typeof createMcpResourceTools>, name: string) {
	const tool = tools.find((t) => t.name === name)
	if (!tool) {
		throw new Error(`tool ${name} not registered`)
	}
	return tool
}

describe("createMcpResourceTools", () => {
	it("registers the three tools", () => {
		const names = createMcpResourceTools(makeDeps()).map((t) => t.name)
		expect(names).toEqual(["list_mcp_resources", "read_mcp_resource", "list_mcp_prompts"])
	})

	it("lists resources across every server, tagging each with its owner", async () => {
		// An agent asking "what can these servers offer" does not know which server
		// owns what, so the listing must span all of them and say which is which.
		const deps = makeDeps({
			listAllResources: vi.fn(async () => ({
				resources: [
					{ serverName: "alpha", uri: "file:///a.md", name: "A", mimeType: "text/markdown" },
					{ serverName: "beta", uri: "file:///b.json" },
				],
				templates: [{ serverName: "beta", uriTemplate: "file:///{id}" }],
			})),
		})
		const result = await byName(createMcpResourceTools(deps), "list_mcp_resources").execute({}, ctx)

		expect(result).toContain("alpha")
		expect(result).toContain("file:///a.md")
		expect(result).toContain("beta")
		expect(result).toContain("file:///{id}")
	})

	it("scopes the listing to one server when asked", async () => {
		const deps = makeDeps({
			listAllResources: vi.fn(async () => ({
				resources: [
					{ serverName: "alpha", uri: "file:///a" },
					{ serverName: "beta", uri: "file:///b" },
				],
				templates: [],
			})),
		})
		const result = await byName(createMcpResourceTools(deps), "list_mcp_resources").execute({ server: "beta" }, ctx)

		expect(result).toContain("beta")
		expect(result).not.toContain("file:///a")
	})

	it("says so plainly when no server publishes resources", async () => {
		// An empty list must read as "nothing here", not as a silent empty response
		// that reads like the tool is broken.
		const result = await byName(createMcpResourceTools(makeDeps()), "list_mcp_resources").execute({}, ctx)
		expect(result).toContain("No MCP resources")
	})

	it("reads a resource and renders text contents", async () => {
		const deps = makeDeps({
			readResource: vi.fn(async () => ({ contents: [{ text: "hello" }, { text: "world" }] })),
		})
		const result = await byName(createMcpResourceTools(deps), "read_mcp_resource").execute(
			{
				server: "alpha",
				uri: "file:///a",
			},
			ctx,
		)
		expect(result).toBe("hello\nworld")
	})

	it("describes binary content instead of pretending it is readable", async () => {
		const deps = makeDeps({
			readResource: vi.fn(async () => ({
				contents: [{ uri: "file:///img.png", mimeType: "image/png" }],
			})),
		})
		const result = await byName(createMcpResourceTools(deps), "read_mcp_resource").execute(
			{
				server: "alpha",
				uri: "file:///img.png",
			},
			ctx,
		)
		expect(result).toContain("binary resource")
		expect(result).toContain("image/png")
	})

	it("truncates an oversized resource and says so", async () => {
		// A third-party server can return a multi-megabyte blob. Without a cap one
		// response evicts the conversation with no mid-turn recovery.
		const deps = makeDeps({
			readResource: vi.fn(async () => ({ contents: [{ text: "x".repeat(500_000) }] })),
		})
		const result = (await byName(createMcpResourceTools(deps), "read_mcp_resource").execute(
			{
				server: "alpha",
				uri: "file:///big",
			},
			ctx,
		)) as string

		expect(result).toContain("truncated")
		expect(result.length).toBeLessThan(200_000)
	})

	it("returns the reason when a resource cannot be read instead of throwing", async () => {
		// A bad URI is a normal result of exploration. Throwing would end the turn
		// over a recoverable mistake.
		const deps = makeDeps({
			readResource: vi.fn(async () => {
				throw new Error("connection refused")
			}),
		})
		const result = await byName(createMcpResourceTools(deps), "read_mcp_resource").execute(
			{
				server: "alpha",
				uri: "file:///missing",
			},
			ctx,
		)
		expect(result).toContain("connection refused")
		expect(result).toContain("file:///missing")
	})

	it("lists prompts with their argument counts", async () => {
		const deps = makeDeps({
			listAllPrompts: vi.fn(async () => [
				{ serverName: "alpha", name: "review", description: "Review a PR", arguments: [{ name: "pr" }] },
				{ serverName: "alpha", name: "summary" },
			]),
		})
		const result = await byName(createMcpResourceTools(deps), "list_mcp_prompts").execute({}, ctx)

		expect(result).toContain("review")
		expect(result).toContain("1 argument")
		expect(result).toContain("summary")
		expect(result).not.toContain("0 argument")
	})

	it("does not batch resource calls with workspace reads", async () => {
		// Each call is a round-trip to a third-party server. Batching them with
		// local reads would let one slow server stall unrelated work.
		for (const tool of createMcpResourceTools(makeDeps())) {
			expect(tool.concurrency, `${tool.name} must not be concurrency-safe`).not.toBe("safe")
		}
	})
})
