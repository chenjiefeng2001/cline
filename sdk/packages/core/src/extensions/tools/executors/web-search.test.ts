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
	it("exposes at least one provider and resolves the default", () => {
		expect(listWebSearchProviders().length).toBeGreaterThan(0)
		expect(getWebSearchProvider(undefined).id).toBe(listWebSearchProviders()[0].id)
	})

	it("names the available providers when asked for an unknown one", () => {
		// An unknown id is a configuration error, and the message has to say what the
		// valid options are or the user cannot fix it.
		expect(() => getWebSearchProvider("nope")).toThrow(/Available:/)
	})

	it("refuses the retired providers by name, with a replacement", () => {
		// The capability was originally specified against these two. Accepting a key for
		// a dead endpoint and failing later with a bare 401 is the worst version of
		// this, so the refusal has to happen at configuration time and name what to use
		// instead.
		for (const id of ["google", "bing"]) {
			expect(() => getWebSearchProvider(id), id).toThrow(/retired/i)
			expect(() => getWebSearchProvider(id), id).toThrow(/brave/)
		}
	})

	it("never defaults to a retired provider", () => {
		const fallback = getWebSearchProvider(undefined)
		expect(fallback.retired).toBeUndefined()
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
	it("reports a missing credential instead of returning no results", () => {
		// The distinction that matters: "no matches" and "not configured" look the same
		// as an empty result list, and the model reports the difference as fact.
		const search = createWebSearchExecutor({})
		return expect(search("anything", ctx)).resolves.toMatch(
			/no API key is available[\s\S]*BRAVE_SEARCH_API_KEY/,
		)
	})

	it("names the provider in the missing-credential error", async () => {
		const out = await createWebSearchExecutor({})("q", ctx)
		expect(out).toContain("Brave Search")
	})

	it("distinguishes a genuine zero-result response from a missing credential", async () => {
		const fetchImpl = vi.fn(async () =>
			Promise.resolve(new Response(JSON.stringify({ web: { results: [] } }), { status: 200 })),
		)
		const search = createWebSearchExecutor({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch })
		const out = await search("obscure query", ctx)
		expect(out).toMatch(/No results/)
		expect(out).toMatch(/not a missing credential/)
	})

	it("normalizes provider results to title, url and snippet", async () => {
		const fetchImpl = vi.fn(async () =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						web: {
							results: [
								{ title: "First", url: "https://example.com/1", description: "Snippet one" },
								{ url: "https://example.com/2" },
								{ title: "No url" },
							],
						},
					}),
					{ status: 200 },
				),
			),
		)
		const search = createWebSearchExecutor({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch })
		const out = await search("q", ctx)
		expect(out).toContain("https://example.com/1")
		expect(out).toContain("Snippet one")
		expect(out).toContain("https://example.com/2")
		// A result with no url is unusable, so it is dropped rather than printed blank.
		expect(out).not.toContain("No url")
	})

	it("reports the credential origin without revealing the key", async () => {
		const fetchImpl = vi.fn(async () =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						web: { results: [{ title: "T", url: "https://example.com/1", description: "d" }] },
					}),
					{ status: 200 },
				),
			),
		)
		const search = createWebSearchExecutor({
			apiKey: "super-secret-value",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		const out = await search("q", ctx)
		// Naming the source is what makes "why is it using the wrong key" diagnosable.
		expect(out).toContain("key from setting")
		expect(out).not.toContain("super-secret-value")
	})

	it("turns a rejected key into actionable guidance rather than a bare status", async () => {
		const fetchImpl = vi.fn(async () => Promise.resolve(new Response("nope", { status: 401 })))
		const search = createWebSearchExecutor({ apiKey: "bad", fetchImpl: fetchImpl as unknown as typeof fetch })
		const out = await search("q", ctx)
		expect(out).toContain("401")
		expect(out).toMatch(/key was rejected/)
	})

	it("does not echo the provider error body, which can contain the key", async () => {
		const fetchImpl = vi.fn(async () =>
			Promise.resolve(new Response("invalid key super-secret-value", { status: 400 })),
		)
		const search = createWebSearchExecutor({ apiKey: "super-secret-value", fetchImpl: fetchImpl as unknown as typeof fetch })
		const out = await search("q", ctx)
		expect(out).not.toContain("super-secret-value")
	})

	it("asks for a query rather than searching for nothing", async () => {
		const search = createWebSearchExecutor({ apiKey: "k" })
		expect(await search("   ", ctx)).toMatch(/Provide a search query/)
	})
})
