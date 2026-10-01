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
 * So a provider is added by appending to this list and nothing else changes - the
 * tool, the credential resolution and the host settings are all provider agnostic.
 *
 * The default is Google, and it is named in DEFAULT_WEB_SEARCH_PROVIDER_ID rather
 * than inherited from the array order. It is not the closest surviving analogue to
 * Custom Search - Brave is, and that is what this comment used to claim, which is
 * precisely why the default had to become a value you can see: a default that lives
 * in an array index cannot be argued about, and reordering the array would change it
 * for every user who never chose a provider.
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
			/**
			 * Secondary credential, for providers that need one. Google Custom Search
			 * requires a Search Engine ID (`cx`) in addition to the API key, so this is
			 * not a hypothetical field.
			 */
			engineId?: string
			maxResults: number
			signal: AbortSignal
			fetchImpl: typeof fetch
		},
	): Promise<WebSearchResult[]>
}

/**
 * Google Custom Search JSON API.
 *
 * Needs two credentials: an API key and a Search Engine ID (`cx`). The endpoint is
 * closed to new customers and shuts down for existing ones on 2027-01-01, so the
 * `retired` metadata below stays attached: the request is still made, because that is
 * the configured provider, but a failure says what happened rather than reporting a
 * bare status.
 */
function googleProvider(): WebSearchProvider {
	return {
		id: "google",
		label: "Google Custom Search JSON API",
		apiKeyEnvVars: ["GOOGLE_SEARCH_API_KEY", "GOOGLE_API_KEY"],
		endpoint: "https://www.googleapis.com/customsearch/v1",
		retired: {
			since: "2027-01-01 (closed to new customers)",
			reason:
				"Google closed the Custom Search JSON API to new customers and shuts it down for existing ones on 2027-01-01. Existing keys keep working until then.",
			useInstead: "brave",
		},
		async search(query, options) {
			const url = new URL("https://www.googleapis.com/customsearch/v1")
			url.searchParams.set("q", query)
			url.searchParams.set("key", options.apiKey)
			url.searchParams.set("num", String(Math.min(options.maxResults, 10)))
			// Absent cx is a 400 from the API, so say which credential is missing rather
			// than letting the user decode a provider error message.
			if (options.engineId) {
				url.searchParams.set("cx", options.engineId)
			}
			const response = await options.fetchImpl(url, {
				headers: { accept: "application/json" },
				signal: options.signal,
			})
			if (!response.ok) {
				throw new Error(
					`Google Custom Search returned HTTP ${response.status}` +
						describeKeyFailure(response.status, !options.engineId) +
						`. This API is closed to new customers and retires 2027-01-01.`,
				)
			}
			const body = (await response.json()) as {
				items?: Array<{ title?: string; link?: string; snippet?: string }>
			}
			return (body.items ?? [])
				.filter((r) => typeof r.link === "string" && r.link.length > 0)
				.slice(0, options.maxResults)
				.map((r) => ({
					title: (r.title ?? r.link ?? "").trim(),
					url: r.link as string,
					snippet: stripHtmlTags(r.snippet ?? ""),
				}))
		},
	}
}

/**
 * Bing Search API.
 *
 * Retired on 2025-08-11, so this will fail against the live endpoint. It is kept
 * because it is a configured provider and the failure should be legible, not because it
 * is expected to return results.
 */
function bingProvider(): WebSearchProvider {
	return {
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
		async search(query, options) {
			const url = new URL("https://api.bing.microsoft.com/v7.0/search")
			url.searchParams.set("q", query)
			url.searchParams.set("count", String(Math.min(options.maxResults, 50)))
			const response = await options.fetchImpl(url, {
				headers: {
					accept: "application/json",
					"ocp-apim-subscription-key": options.apiKey,
				},
				signal: options.signal,
			})
			if (!response.ok) {
				throw new Error(
					`Bing Search returned HTTP ${response.status}` +
						describeKeyFailure(response.status, false) +
						`. The Bing Search API was retired on 2025-08-11, so this endpoint is not expected to serve results.`,
				)
			}
			const body = (await response.json()) as {
				webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }> }
			}
			return (body.webPages?.value ?? [])
				.filter((r) => typeof r.url === "string" && r.url.length > 0)
				.slice(0, options.maxResults)
				.map((r) => ({
					title: (r.name ?? r.url ?? "").trim(),
					url: r.url as string,
					snippet: stripHtmlTags(r.snippet ?? ""),
				}))
		},
	}
}

/** Guidance for an auth failure, without echoing any credential. */
function describeKeyFailure(status: number, missingSecondary: boolean): string {
	if (missingSecondary) {
		return " (a Search Engine ID is also required - set the cx / search engine id)"
	}
	return status === 401 || status === 403 ? " (the API key was rejected)" : ""
}

/** Providers return snippets as HTML fragments; the model does not need the markup. */
function stripHtmlTags(input: string): string {
	return input
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim()
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

const PROVIDERS: readonly WebSearchProvider[] = [googleProvider(), bingProvider(), braveProvider()]

/**
 * Provider used when the host has no `webSearchProvider` setting.
 *
 * Named rather than read off `PROVIDERS[0]`, because the array order is not a
 * decision anyone reading this file can see: inserting a provider at the top would
 * change the default for every user who never chose one, with nothing in the diff
 * saying so. This default is also contested - Google is closed to new customers and
 * retires 2027-01-01, and Brave is the nearest surviving analogue - so it is the kind
 * of value that gets argued about, and an argument needs a target. Changing it is an
 * edit here plus a grep for this constant, not a silent reordering.
 */
export const DEFAULT_WEB_SEARCH_PROVIDER_ID = "google"

export function listWebSearchProviders(): readonly WebSearchProvider[] {
	return PROVIDERS
}

export function getWebSearchProvider(id: string | undefined): WebSearchProvider {
	const wanted = id?.trim() || DEFAULT_WEB_SEARCH_PROVIDER_ID
	const found = PROVIDERS.find((p) => p.id === wanted)
	if (!found) {
		throw new Error(
			`Unknown web search provider "${wanted}". Available: ${PROVIDERS.map((p) => p.id).join(", ")}.`,
		)
	}
	// A retired provider is still selectable, so the request is still made. What the
	// retirement buys is a legible failure: each adapter appends the deadline to its own
	// error, so whoever hits it learns why the endpoint stopped answering instead of
	// assuming their key is wrong. Refusing at configuration time would have been wrong
	// while this is the default - it would make the tool unusable rather than making the
	// deadline visible. DEFAULT_WEB_SEARCH_PROVIDER_ID is where that default is changed.
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
