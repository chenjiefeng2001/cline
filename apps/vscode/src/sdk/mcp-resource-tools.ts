import type { AgentTool } from "@cline/shared"
import { createTool, zodToJsonSchema } from "@cline/shared"
import { z } from "zod"
import { Logger } from "@/shared/services/Logger"
import type { McpHub } from "../services/mcp/McpHub"

/**
 * MCP resource and prompt tools.
 *
 * The MCP surface has three parts and Cline only ever exposed one: tools.
 * `McpHub` could list and read resources and list prompts all along (see
 * `listAllResources` / `listAllPrompts`), but nothing surfaced them to the
 * model, so a server publishing resources or prompts was effectively
 * half-connected. This closes that.
 *
 * Split into three tools rather than one, mirroring the granularity the other
 * hosts converged on (Claude Code ships `ListMcpResourcesTool` +
 * `ReadMcpResourceTool`):
 *
 * - `list_mcp_resources` — discovery. Answers "what is available?".
 * - `read_mcp_resource`  — fetch one resource body by URI.
 * - `list_mcp_prompts`   — discovery for prompts.
 *
 * A single overloaded tool would force a discriminator parameter and would put a
 * potentially large resource body in the same result as a listing.
 *
 * Prompt *execution* is deliberately not exposed: `getPrompt` returns a message
 * list, and splicing that into a transcript is a different operation from a tool
 * call. Listing is unambiguous; invocation is a product decision.
 */

const MAX_LISTED_ITEMS = 200
const MAX_RESOURCE_CHARS = 100_000

const listSchema = z.object({
	server: z.string().optional().describe("Restrict the listing to one MCP server name. Omit to list every server."),
})

const readSchema = z.object({
	server: z.string().describe("MCP server name."),
	uri: z.string().describe("Resource URI exactly as listed by list_mcp_resources."),
})

/**
 * Caps a resource body.
 *
 * MCP servers are third-party and may return anything, including a multi-megabyte
 * blob. One oversized resource would evict the conversation from the context
 * window with no way to recover mid-turn, so truncation happens here where the
 * model can be told, rather than downstream where it is invisible.
 */
function capText(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) {
		return { text, truncated: false }
	}
	const head = text.slice(0, Math.floor(limit * 0.6))
	const tail = text.slice(-Math.floor(limit * 0.4))
	return {
		text: `${head}\n\n... [truncated ${text.length - limit} characters] ...\n\n${tail}`,
		truncated: true,
	}
}

function renderResourceContents(contents: unknown): string {
	if (!Array.isArray(contents)) {
		return String(contents ?? "")
	}
	return contents
		.map((entry) => {
			const item = entry as { text?: unknown; uri?: unknown; mimeType?: unknown }
			if (typeof item?.text === "string") {
				return item.text
			}
			if (item?.uri) {
				// Binary content: hand back the descriptor rather than pretending it
				// is readable, so the model can decide how else to get at it.
				return `[binary resource ${String(item.uri)}${item.mimeType ? ` (${String(item.mimeType)})` : ""}]`
			}
			return String(entry)
		})
		.join("\n")
}

/**
 * Narrow view of McpHub, so the tools are testable without a live hub. Keeping
 * this structural rather than importing the class is what lets the tests run
 * without the VS Code host.
 */
export interface McpResourceToolDeps {
	listAllResources(): Promise<{
		resources: Array<{ serverName: string; uri?: string; name?: string; description?: string; mimeType?: string }>
		templates: Array<{ serverName: string; uriTemplate?: string; name?: string; description?: string }>
	}>
	listAllPrompts(): Promise<Array<{ serverName: string; name: string; description?: string; arguments?: unknown[] }>>
	readResource(serverName: string, uri: string): Promise<{ contents?: unknown }>
}

export function createMcpResourceTools(deps: McpResourceToolDeps): AgentTool[] {
	return [
		createTool({
			name: "list_mcp_resources",
			description:
				"List the resources and resource templates published by the connected MCP servers. " +
				"Use this before read_mcp_resource — resources are addressed by server and URI, " +
				"and neither is guessable. Returns nothing when no server publishes resources.",
			inputSchema: zodToJsonSchema(listSchema),
			// Read-only, but each call is a round-trip to third-party servers, so it is
			// NOT batched with workspace reads — a slow server must not stall local work.
			concurrency: "exclusive",
			retryable: true,
			maxRetries: 1,
			execute: async (input: unknown) => {
				const { server } = listSchema.parse(input ?? {}) as { server?: string }
				const { resources, templates } = await deps.listAllResources()
				const scoped = server ? resources.filter((r) => r.serverName === server) : resources
				const scopedTemplates = server ? templates.filter((t) => t.serverName === server) : templates

				if (scoped.length === 0 && scopedTemplates.length === 0) {
					return `No MCP resources${server ? ` on server "${server}"` : ""}. Servers may simply not publish resources.`
				}

				const lines: string[] = []
				if (scoped.length > 0) {
					lines.push(
						`Resources (${scoped.length}${scoped.length > MAX_LISTED_ITEMS ? `, showing first ${MAX_LISTED_ITEMS}` : ""}):`,
					)
					for (const resource of scoped.slice(0, MAX_LISTED_ITEMS)) {
						lines.push(
							`- ${resource.serverName} | ${resource.uri ?? "(no uri)"}` +
								`${resource.name ? ` | name=${resource.name}` : ""}` +
								`${resource.mimeType ? ` | ${resource.mimeType}` : ""}` +
								`${resource.description ? `\n  ${resource.description}` : ""}`,
						)
					}
					if (scoped.length > MAX_LISTED_ITEMS) {
						lines.push(`... ${scoped.length - MAX_LISTED_ITEMS} more resources not shown.`)
					}
				}
				if (scopedTemplates.length > 0) {
					lines.push(`\nResource templates (${scopedTemplates.length}):`)
					for (const template of scopedTemplates.slice(0, MAX_LISTED_ITEMS)) {
						lines.push(
							`- ${template.serverName} | ${template.uriTemplate ?? "(no uriTemplate)"}` +
								`${template.name ? ` | name=${template.name}` : ""}` +
								`${template.description ? `\n  ${template.description}` : ""}`,
						)
					}
				}
				return lines.join("\n")
			},
		}),

		createTool({
			name: "read_mcp_resource",
			description:
				"Read the contents of one MCP resource, addressed by server name and URI. " +
				"Call list_mcp_resources first unless you already know both. Large bodies are truncated.",
			inputSchema: zodToJsonSchema(readSchema),
			concurrency: "exclusive",
			retryable: true,
			maxRetries: 1,
			execute: async (input: unknown) => {
				const { server, uri } = readSchema.parse(input) as { server: string; uri: string }
				try {
					const response = await deps.readResource(server, uri)
					const body = capText(renderResourceContents(response?.contents), MAX_RESOURCE_CHARS)
					return body.truncated ? `${body.text}\n\n[resource truncated at ${MAX_RESOURCE_CHARS} characters]` : body.text
				} catch (error) {
					// A missing or unreachable resource is a normal outcome of an
					// exploratory tool, not a run-ending fault. Returning the reason
					// lets the model try another URI instead of stalling the turn.
					const message = error instanceof Error ? error.message : String(error)
					return `Failed to read ${uri} from ${server}: ${message}`
				}
			},
		}),

		createTool({
			name: "list_mcp_prompts",
			description:
				"List the prompts published by the connected MCP servers, with their argument counts. " +
				"Returns nothing when no server publishes prompts.",
			inputSchema: zodToJsonSchema(listSchema),
			concurrency: "exclusive",
			retryable: true,
			maxRetries: 1,
			execute: async (input: unknown) => {
				const { server } = listSchema.parse(input ?? {}) as { server?: string }
				const prompts = await deps.listAllPrompts()
				const scoped = server ? prompts.filter((p) => p.serverName === server) : prompts
				if (scoped.length === 0) {
					return `No MCP prompts${server ? ` on server "${server}"` : ""}. Servers may simply not publish prompts.`
				}
				const lines = [
					`Prompts (${scoped.length}${scoped.length > MAX_LISTED_ITEMS ? `, showing first ${MAX_LISTED_ITEMS}` : ""}):`,
				]
				for (const prompt of scoped.slice(0, MAX_LISTED_ITEMS)) {
					const args = Array.isArray(prompt.arguments) ? prompt.arguments.length : 0
					lines.push(
						`- ${prompt.serverName} | ${prompt.name}` +
							`${args > 0 ? ` | ${args} argument${args === 1 ? "" : "s"}` : ""}` +
							`${prompt.description ? `\n  ${prompt.description}` : ""}`,
					)
				}
				if (scoped.length > MAX_LISTED_ITEMS) {
					lines.push(`... ${scoped.length - MAX_LISTED_ITEMS} more prompts not shown.`)
				}
				return lines.join("\n")
			},
		}),
	]
}

/**
 * Build the tools against a live hub, degrading to an empty set on failure
 * rather than aborting session creation — an MCP problem must not stop the
 * session from starting.
 */
export function createMcpResourceToolsSafe(mcpHub: McpHub): AgentTool[] {
	try {
		return createMcpResourceTools(mcpHub as unknown as McpResourceToolDeps)
	} catch (error) {
		Logger.warn(
			`[McpResourceTools] Failed to build MCP resource tools: ${error instanceof Error ? error.message : String(error)}`,
		)
		return []
	}
}
