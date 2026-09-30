import { describe, expect, it, vi } from "vitest"
import {
	getWebSearchProvider,
	listWebSearchProviders,
	resolveWebSearchCredential,
} from "./web-search-providers"
import { createWebSearchExecutor } from "./web-search"
import type { AgentToolContext } from "@cline/shared"

/**
 * Web search credential handling and reporting.
 *
 * The precedence rule is the point: an operator exporting a key in the environment is
 * overriding whatever the UI has stored, which is what makes it possible to run
 * against a different account or rotate a key without touching settings.
 */
const ctx = { sessionId: "s", agentId: "a", conversationId: "c", iteration: 1, toolCallId: "t" } as AgentToolContext

describe("web search provider registry", () => {
	it("defaults to Google Custom Search, as configured", () => {
		expect(getWebSearchProvider(undefined).id).toBe("google")
		expect(getWebSearchProvider(undefined).retired?.since).toMatch(/2027-01-01/)
	})

	it("keeps every provider selectable despite a retirement date", () => {
		// The endpoints are on their way out, but a configured provider is still
		// attempted: refusing at configuration time would make the tool unusable rather
		// than making the deadline visible.
		for (const id of ["google", "bing", "brave"]) {
			expect(getWebSearchProvider(id).id, id).toBe(id)
		}
	})

	it("names the available providers when asked for an unknown one", () => {
		// An unknown id is a configuration error, and the message has to say what the
		// valid options are or the user cannot fix it.
		expect(() => getWebSearchProvider("nope")).toThrow(/Available:/)
	})
})

describe("credential precedence: env over setting", () => {
	const provider = getWebSearchProvider("brave")

	it("prefers the environment variable over the setting", () => {
		const c = resolveWebSearchCredential(provider, "from-setting", {
			BRAVE_SEARCH_API_KEY: "from-env",
		})
		expect(c).toEqual({ value: "from-env", source: "env", origin: "BRAVE_SEARCH_API_KEY" })
	})

	it("falls back to the setting when no environment variable is set", () => {
		const c = resolveWebSearchCredential(provider, "from-setting", {})
		expect(c).toEqual({
			value: "from-setting",
			source: "setting",
			origin: "the web search API key setting",
		})
	})

	it("honours the documented env var order", () => {
		// The primary name wins when both are exported.
		const c = resolveWebSearchCredential(provider, undefined, {
			BRAVE_API_KEY: "secondary",
			BRAVE_SEARCH_API_KEY: "primary",
		})
		expect(c?.value).toBe("primary")
		const c2 = resolveWebSearchCredential(provider, undefined, { BRAVE_API_KEY: "secondary" })
		expect(c2?.value).toBe("secondary")
	})

	it("treats a blank env var as absent rather than shadowing a real setting", () => {
		// Otherwise exporting an empty variable silently disables a working key.
		const c = resolveWebSearchCredential(provider, "from-setting", {
			BRAVE_SEARCH_API_KEY: "   ",
		})
		expect(c?.source).toBe("setting")
		expect(c?.value).toBe("from-setting")
	})

	it("returns nothing when neither source has a value", () => {
		expect(resolveWebSearchCredential(provider, undefined, {})).toBeUndefined()
		expect(resolveWebSearchCredential(provider, "  ", { BRAVE_SEARCH_API_KEY: "" })).toBeUndefined()
	})
})

describe("web_search reporting", () => {
	it("reports a missing credential instead of returning no results", async () => {
		// The distinction that matters: "no matches" and "not configured" look the same
		// as an empty result list, and the model reports the difference as fact.
		const search = createWebSearchExecutor({ provider: "brave" })
		const out = await search("anything", ctx)
		expect(out).toMatch(/no API key is available/)
		expect(out).toMatch(/BRAVE_SEARCH_API_KEY/)
	})

	it("names the default provider and its environment variable", async () => {
		// The default is Google, so an unconfigured install should be told exactly
		// which variable to set rather than a generic message.
		const out = await createWebSearchExecutor({})("q", ctx)
		expect(out).toContain("Google Custom Search")
		expect(out).toContain("GOOGLE_SEARCH_API_KEY")
	})

	it("distinguishes a genuine zero-result response from a missing credential", async () => {
		const fetchImpl = vi.fn(async () =>
			Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 })),
		)
		const search = createWebSearchExecutor({
			requestEngineId: "cx",
			apiKey: "k",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const out = await search("obscure query", ctx)
		expect(out).toMatch(/No results/)
		expect(out).toMatch(/not a missing credential/)
	})

	it("normalizes provider results to title, url and snippet", async () => {
		const fetchImpl = vi.fn(async () =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						items: [
							{ title: "First", link: "https://example.com/1", snippet: "Snippet one" },
							{ link: "https://example.com/2" },
							{ title: "No link" },
						],
					}),
					{ status: 200 },
				),
			),
		)
		const search = createWebSearchExecutor({
			requestEngineId: "cx",
			apiKey: "k",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const out = await search("q", ctx)
		expect(out).toContain("https://example.com/1")
		expect(out).toContain("Snippet one")
		expect(out).toContain("https://example.com/2")
		// A result with no url is unusable, so it is dropped rather than printed blank.
		expect(out).not.toContain("No link")
	})

	it("reports the credential origin without revealing the key", async () => {
		const fetchImpl = vi.fn(async () =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						items: [{ title: "T", link: "https://example.com/1", snippet: "d" }],
					}),
					{ status: 200 },
				),
			),
		)
		const search = createWebSearchExecutor({
			requestEngineId: "cx",
			apiKey: "super-secret-value",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const out = await search("q", ctx)
		// Naming the source is what makes "why is it using the wrong key" diagnosable.
		expect(out).toContain("key from setting")
		expect(out).not.toContain("super-secret-value")
	})

	it("turns a rejected key into actionable guidance rather than a bare status", async () => {
		const fetchImpl = vi.fn(async () => Promise.resolve(new Response("nope", { status: 403 })))
		const search = createWebSearchExecutor({
			provider: "brave",
			apiKey: "bad",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const out = await search("q", ctx)
		expect(out).toContain("403")
		expect(out).toMatch(/rejected/)
	})

	it("does not echo the provider error body, which can contain the key", async () => {
		const fetchImpl = vi.fn(async () =>
			Promise.resolve(new Response("invalid key super-secret-value", { status: 400 })),
		)
		const search = createWebSearchExecutor({
			provider: "brave",
			apiKey: "super-secret-value",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const out = await search("q", ctx)
		expect(out).not.toContain("super-secret-value")
	})

	it("asks for a query rather than searching for nothing", async () => {
		const search = createWebSearchExecutor({ apiKey: "k" })
		expect(await search("   ", ctx)).toMatch(/Provide a search query/)
	})
})

describe("google adapter", () => {
	const json = (body: unknown, status = 200) =>
		Promise.resolve(new Response(JSON.stringify(body), { status }))

	it("sends key, engine id and query, and maps items to normalized results", async () => {
		const fetchImpl = vi.fn(async () =>
			json({
				items: [
					{ title: "First", link: "https://example.com/1", snippet: "<b>Bold</b> text" },
					{ title: "No link" },
				],
			}),
		)
		const search = createWebSearchExecutor({
			apiKey: "key-123",
			requestEngineId: "cx-456",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const out = await search("q", ctx)

		const url = new URL((fetchImpl.mock.calls[0] as unknown as [URL])[0].toString())
		expect(url.searchParams.get("key")).toBe("key-123")
		expect(url.searchParams.get("cx")).toBe("cx-456")
		expect(url.searchParams.get("q")).toBe("q")
		expect(out).toContain("https://example.com/1")
		// Snippets arrive as HTML fragments; the model does not need the markup.
		expect(out).toContain("Bold text")
		expect(out).not.toContain("<b>")
		expect(out).not.toContain("No link")
	})

	it("names the missing Search Engine ID when the key alone is not enough", async () => {
		// Google needs two credentials. Without saying which one is absent, the user
		// sees a bare 400 and has to guess.
		const fetchImpl = vi.fn(async () => Promise.resolve(new Response("{}", { status: 400 })))
		const search = createWebSearchExecutor({
			apiKey: "key-123",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const out = await search("q", ctx)
		expect(out).toMatch(/Search Engine ID/)
		expect(out).toMatch(/2027-01-01/)
	})

	it("reports a rejected key without echoing it", async () => {
		const fetchImpl = vi.fn(async () => Promise.resolve(new Response("bad key", { status: 403 })))
		const search = createWebSearchExecutor({
			apiKey: "super-secret-value",
			requestEngineId: "cx",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const out = await search("q", ctx)
		expect(out).toMatch(/403/)
		expect(out).toMatch(/rejected/)
		expect(out).not.toContain("super-secret-value")
	})

	it("states the retirement when Bing fails against its dead endpoint", async () => {
		const fetchImpl = vi.fn(async () => Promise.resolve(new Response("gone", { status: 410 })))
		const search = createWebSearchExecutor({
			provider: "bing",
			apiKey: "k",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const out = await search("q", ctx)
		expect(out).toMatch(/retired on 2025-08-11/)
	})
})
