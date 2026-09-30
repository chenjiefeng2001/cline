import {
	getWebSearchProvider,
	resolveWebSearchCredential,
} from "./web-search-providers"
import type { WebSearchProvider, WebSearchResult } from "./web-search-providers"
import type { AgentToolContext } from "@cline/shared"

export { listWebSearchProviders } from "./web-search-providers"
export type { WebSearchResult } from "./web-search-providers"

export interface WebSearchExecutorOptions {
	/**
	 * Provider id. Defaults to the first registered provider.
	 * Ignored by hosts that expose no provider choice.
	 */
	provider?: string
	/**
	 * Google Custom Search Search Engine ID, used with the key. Optional because only
	 * Google needs it, and its absence is reported by the API.
	 */
	requestEngineId?: string
	/**
	 * Credential from host settings, used only when no environment variable is set.
	 * See resolveWebSearchCredential for the precedence rule.
	 */
	apiKey?: string
	/** Maximum results to return. @default 5 */
	maxResults?: number
	/** Per-request timeout in milliseconds. @default 15000 */
	timeoutMs?: number
	/** Injectable for tests. */
	fetchImpl?: typeof fetch
}

export type WebSearchExecutor = (
	query: string,
	context: AgentToolContext,
) => Promise<string>

/**
 * `web_search`.
 *
 * Off by default at the host level, and that default is a privacy decision rather
 * than a maturity one: a search sends the model's query text to a third party, which
 * is a different kind of egress than reading a file. A host that turns it on is
 * choosing that.
 *
 * A missing credential is reported as a specific, actionable error rather than an
 * empty result list. Returning "no results" for a key that was never configured is
 * indistinguishable from a query that genuinely matched nothing, and the model will
 * confidently report that the web has no information on the subject.
 */
export function createWebSearchExecutor(
	options: WebSearchExecutorOptions = {},
): WebSearchExecutor {
	const {
		provider: providerId,
		apiKey: settingApiKey,
		requestEngineId: settingEngineId,
		maxResults = 5,
		timeoutMs = 15_000,
		fetchImpl = fetch,
	} = options

	// Resolved once: a provider or credential that does not exist cannot be fixed
	// mid-run, and re-reporting it on every call would bury the message.
	let provider: WebSearchProvider | undefined
	let credential: ReturnType<typeof resolveWebSearchCredential>
	let initError: string | undefined
	try {
		provider = getWebSearchProvider(providerId)
		credential = resolveWebSearchCredential(provider, settingApiKey)
		if (!credential) {
			initError =
				`Web search is enabled but no API key is available. Set ${provider.apiKeyEnvVars[0]} ` +
				`in the environment (which takes priority), or configure the API key in settings. ` +
				`Provider: ${provider.label}.`
		}
	} catch (error) {
		initError = error instanceof Error ? error.message : String(error)
	}

	return async (query, _context) => {
		if (initError) {
			return initError
		}
		const trimmed = query.trim()
		if (!trimmed) {
			return "Provide a search query."
		}
		assertUsable(fetchImpl)
		const active = provider as WebSearchProvider
		const key = credential as NonNullable<typeof credential>

		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const results = await active.search(trimmed, {
				apiKey: key.value,
				...(active.id === "google" ? { engineId: settingEngineId?.trim() || undefined } : {}),
				maxResults,
				signal: controller.signal,
				fetchImpl,
			})
			return formatResults(trimmed, active, key, results)
		} catch (error) {
			if (controller.signal.aborted) {
				return `Web search timed out after ${timeoutMs}ms. Retry, or narrow the query.`
			}
			return error instanceof Error ? error.message : `Web search failed: ${String(error)}`
		} finally {
			clearTimeout(timer)
		}
	}
}

function assertUsable(fetchImpl: typeof fetch): void {
	if (typeof fetchImpl !== "function") {
		throw new Error("web_search requires a fetch implementation")
	}
}

function formatResults(
	query: string,
	provider: WebSearchProvider,
	credential: NonNullable<ReturnType<typeof resolveWebSearchCredential>>,
	results: WebSearchResult[],
): string {
	if (results.length === 0) {
		return `No results for "${query}" via ${provider.label}. That is a real absence of matches, not a missing credential.`
	}
	const lines = [
		`${results.length} result(s) for "${query}" via ${provider.label} (key from ${credential.source}: ${credential.origin}):`,
		"",
	]
	for (const [i, r] of results.entries()) {
		lines.push(`${i + 1}. ${r.title || r.url}`)
		lines.push(`   ${r.url}`)
		if (r.snippet) {
			lines.push(`   ${r.snippet}`)
		}
		lines.push("")
	}
	return lines.join("\n")
}
