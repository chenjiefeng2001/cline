/**
 * Search providers.
 *
 * Deliberately a registry rather than a switch statement, because the two providers
 * this was originally specified for are both gone:
 *
 *   - Bing Search API was retired 2025-08-11; Microsoft steers callers to Azure AI
 *     Agents grounding, which is a model feature rather than a raw results API
 *   - Google Custom Search JSON API is closed to new customers and shuts down for
 *     existing ones on 2027-01-01
 *
 * So a provider is added by appending to this list and nothing else changes -
 * the tool, the credential resolution and the host settings are all provider
 * agnostic. The default is Brave, which is the closest surviving analogue to
 * Custom Search: one key, query in and results out as JSON, no Cloud project and no
 * search index to stand up.
 */

/** One normalized search result, whatever the provider returned. */
export interface WebSearchResult {
	title: string
	url: string
	snippet: string
}

/** Where a resolved credential came from, for diagnostics. Never log the value. */
export type CredentialSource = "env" | "setting"

export interface ResolvedCredential {
	value: string
	source: CredentialSource
	/** Which variable or setting, for the "how do I fix this" message. */
	origin: string
}

export interface WebSearchProvider {
	/** Stable id used in host settings. */
	id: string
	/** Human label for error messages. */
	label: string
	/**
	 * Environment variables that can supply the credential, highest priority first.
	 * The first non-empty one wins, ahead of any host setting.
	 */
	apiKeyEnvVars: string[]
	/** Endpoint, exposed so it can be asserted in tests. */
	endpoint: string
	/**
	 * Whether this provider can still be used.
	 *
	 * Recorded in the registry rather than only in a comment, so the two providers this
	 * was originally specified for cannot come back by accident as if nothing had
	 * happened to them. A retired provider is rejected by name, and the message says
	 * why and what to use instead - which is more useful than an adapter that accepts a
	 * key and then fails with a bare 401 months later.
	 */
	retired?: { since: string; reason: string; useInstead: string }
	search(
		query: string,
		options: {
			apiKey: string
			maxResults: number
			signal: AbortSignal
			fetchImpl: typeof fetch
		},
	): Promise<WebSearchResult[]>
}

function braveProvider(): WebSearchProvider {
	return {
		id: "brave",
		label: "Brave Search",
		apiKeyEnvVars: ["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"],
		endpoint: "https://api.search.brave.com/res/v1/web/search",
		async search(query, options) {
			const url = new URL("https://api.search.brave.com/res/v1/web/search")
			url.searchParams.set("q", query)
			url.searchParams.set("count", String(Math.min(options.maxResults, 20)))
			const response = await options.fetchImpl(url, {
				headers: {
					accept: "application/json",
					"accept-encoding": "gzip",
					"x-subscription-token": options.apiKey,
				},
				signal: options.signal,
			})
			if (!response.ok) {
				// Surface the status but not the body: providers echo the key back in
				// some error payloads, and this string reaches logs and the model.
				throw new Error(
					`Brave Search returned HTTP ${response.status}${
						response.status === 401 || response.status === 403
							? " (the API key was rejected - check that the key is valid and the plan is active)"
							: ""
					}.`,
				)
			}
			const body = (await response.json()) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
			}
			return (body.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url.length > 0)
				.slice(0, options.maxResults)
				.map((r) => ({
					title: (r.title ?? r.url ?? "").trim(),
					url: r.url as string,
					snippet: (r.description ?? "").trim(),
				}))
		},
	}
}

/**
 * The two providers this capability was originally specified against.
 *
 * They are registered as retired rather than omitted, so a host still configured for
 * one gets told what happened instead of "unknown provider", and so nobody re-adds a
 * working-looking adapter later without seeing that the endpoint is gone. They are not
 * selectable: `getWebSearchProvider` rejects them by name.
 */
function retiredProviders(): WebSearchProvider[] {
	const unavailable = async (): Promise<WebSearchResult[]> => {
		// Unreachable via getWebSearchProvider, which rejects before this is called.
		// Present so the shape stays total rather than relying on a throw.
		throw new Error("retired provider")
	}
	return [
		{
			id: "google",
			label: "Google Custom Search JSON API",
			apiKeyEnvVars: ["GOOGLE_SEARCH_API_KEY", "GOOGLE_API_KEY"],
			endpoint: "https://www.googleapis.com/customsearch/v1",
			retired: {
				since: "2027-01-01 (closed to new customers)",
				reason:
					"Google has closed the Custom Search JSON API to new customers and is shutting it down for existing ones on 2027-01-01.",
				useInstead: "brave",
			},
			search: unavailable,
		},
		{
			id: "bing",
			label: "Bing Search API",
			apiKeyEnvVars: ["BING_SEARCH_API_KEY"],
			endpoint: "https://api.bing.microsoft.com/v7.0/search",
			retired: {
				since: "2025-08-11",
				reason:
					"Microsoft retired the Bing Search API on 2025-08-11. The suggested successor, Azure AI Agents grounding, is a model feature rather than a raw results API.",
				useInstead: "brave",
			},
			search: unavailable,
		},
	]
}

const PROVIDERS: readonly WebSearchProvider[] = [braveProvider(), ...retiredProviders()]

export function listWebSearchProviders(): readonly WebSearchProvider[] {
	return PROVIDERS
}

export function getWebSearchProvider(id: string | undefined): WebSearchProvider {
	const wanted = id?.trim() || PROVIDERS[0].id
	const found = PROVIDERS.find((p) => p.id === wanted)
	if (!found) {
		throw new Error(
			`Unknown web search provider "${wanted}". Available: ${PROVIDERS.map((p) => p.id).join(", ")}.`,
		)
	}
	if (found.retired) {
		// Said at configuration time, with the replacement named. Silently accepting a
		// key for a dead endpoint and failing later with a bare 401 is the worst
		// version of this: the user has done everything right and gets told nothing.
		throw new Error(
			`Web search provider "${found.id}" (${found.label}) is retired and cannot be used. ` +
				`Retired ${found.retired.since}: ${found.retired.reason} ` +
				`Use "${found.retired.useInstead}" instead.`,
		)
	}
	return found
}

/**
 * Resolve the credential, environment first.
 *
 * The env vars are consulted before the host setting on purpose: an operator
 * exporting a key in the environment is overriding whatever the UI happens to have
 * stored, which is what makes it possible to run against a different account or
 * rotate a key without editing settings. A blank value in either place is treated as
 * absent rather than used, so an exported-but-empty variable cannot shadow a real
 * stored credential with an empty one.
 */
export function resolveWebSearchCredential(
	provider: WebSearchProvider,
	settingValue: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedCredential | undefined {
	for (const name of provider.apiKeyEnvVars) {
		const value = env[name]?.trim()
		if (value) {
			return { value, source: "env", origin: name }
		}
	}
	const fromSetting = settingValue?.trim()
	if (fromSetting) {
		return { value: fromSetting, source: "setting", origin: "the web search API key setting" }
	}
	return undefined
}
