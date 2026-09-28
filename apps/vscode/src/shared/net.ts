/**
 * # Network Support for Cline
 *
 * ## Development Guidelines
 *
 * **Do** use `import { fetch } from '@/shared/net'` instead of global `fetch`.
 *
 * Global `fetch` will appear to work in VSCode, but proxy support will be
 * broken in JetBrains or CLI.
 *
 * If you use Axios, **do** call `getAxiosSettings()` and spread into
 * your Axios configuration:
 *
 * ```typescript
 * import { getAxiosSettings } from '@/shared/net'
 * await axios.get(url, {
 *   headers: { 'X-FOO': 'BAR' },
 *   ...getAxiosSettings()
 * })
 * ```
 *
 * **Do** remember to pass our `fetch` into your API clients:
 *
 * ```typescript
 * import OpenAI from "openai"
 * import { fetch } from "@/shared/net"
 * this.client = new OpenAI({
 *   apiKey: '...',
 *   fetch, // Use configured fetch with proxy support
 * })
 * ```
 *
 * If you neglect this step, inference won't work in JetBrains and CLI
 * through proxies.
 *
 * ## Proxy Support
 *
 * Cline uses platform-specific fetch implementations to handle proxy
 * configuration:
 * - **VSCode**: Uses global fetch (VSCode provides proxy configuration)
 * - **JetBrains, CLI**: Uses undici fetch with explicit ProxyAgent
 *
 * Proxy configuration via standard environment variables:
 * - `http_proxy` / `HTTP_PROXY` - Proxy for HTTP requests
 * - `https_proxy` / `HTTPS_PROXY` - Proxy for HTTPS requests
 * - `no_proxy` / `NO_PROXY` - Comma-separated list of hosts to bypass proxy
 *
 * Note, `http_proxy` etc. MUST specify the protocol to use for the proxy,
 * for example, `https_proxy=http://proxy.corp.example:3128`. Simply specifying
 * the proxy hostname will result in errors.
 *
 * ## Certificate Trust
 *
 * Proxies often machine-in-the-middle HTTPS connections. To make this work,
 * they generate self-signed certificates for a host, and the client is
 * configured to trust the proxy as a certificate authority.
 *
 * VSCode transparently pulls trusted certificates from the operating system
 * and configures node trust.
 *
 * JetBrains exports trusted certificates from the OS and writes them to a
 * temporary file, then configures node TLS by setting NODE_EXTRA_CA_CERTS.
 *
 * The CLI's npm wrapper (bin/cline) does the same automatically: it harvests
 * the OS trust store and points the child's NODE_EXTRA_CA_CERTS at a managed
 * bundle, because the Bun runtime does not read the OS store on its own. A
 * user-set NODE_EXTRA_CA_CERTS is merged in rather than replaced.
 *
 * ## Limitations in JetBrains & CLI
 *
 * - Proxy settings are static at startup--restart required for changes
 * - SOCKS proxies, PAC files not supported
 * - Proxy authentication via env vars only
 *
 * These are not fundamental limitations, they just need integration work.
 *
 * ## Troubleshooting
 *
 * 1. Verify proxy env vars: `echo $http_proxy $https_proxy`
 * 2. Check certificates: `echo $NODE_EXTRA_CA_CERTS` (should point to PEM file)
 * 3. View logs: Check ~/.cline/cline-core-service.log for network-related
 *    failures.
 * 4. Test connection: Use `curl -x host:port` etc. to isolate proxy
 *    configuration versus client issues.
 *
 * @example
 * ```typescript
 * // Good - uses configured fetch
 * import { fetch } from '@/shared/net'
 * const response = await fetch(url)
 *
 * // For requests needing custom timeouts:
 * import { createFetch } from '@/shared/net'
 * const slowFetch = createFetch('local')  // 180s timeout
 * const response = await slowFetch(url)
 *
 * // Good - configures axios to use configured fetch
 * import { getAxiosSettings } from '@/shared/net'
 * await axios.get(url, { ...getAxiosSettings() })
 * ```
 */

import { EnvHttpProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from "undici"

type FetchFunction = (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>

let mockFetch: FetchFunction | undefined

// ─── Timeout presets by category ───────────────────────────────────────────
// These match typical latency profiles for each request type.
// Default is generous (5 min) so that LLM API requests are not prematurely
// killed by a fixed timer.  Activity-based timeouts (see createFetch) ensure
// stale connections are still detected.
const DEFAULT_TIMEOUTS: Record<string, number> = {
	default: 300_000, // Most API requests (Anthropic, OpenAI, etc.) – 5 min
	local: 180_000, // Local models (Ollama, LM Studio, etc.)
	thinking: 600_000, // Deep-thinking models (DeepSeek-R1, o1, etc.) – 10 min
	mcp_sse: 45_000, // MCP SSE connection / heartbeats
	market: 10_000, // Marketplace download
	oauth: 60_000, // OAuth callback
} as const

/**
 * Inactivity timeout for streaming responses.  If no bytes arrive within this
 * window the request is considered stalled and aborted.  This covers cases
 * where the connection is open but the provider stops sending data (e.g.
 * server-side error, proxy stall, rate-limit queue).
 */
const STREAM_INACTIVITY_TIMEOUT_MS = 60_000

/**
 * Merges multiple AbortSignals into one. Returns a signal that is aborted
 * when ANY of the input signals is aborted. Cleans up listeners on abort.
 *
 * Useful when you need to combine an external caller's signal with an
 * internal timeout signal.
 *
 * Ported from common-abort-signal patterns; avoids adding a dependency.
 */
function anySignal(...signals: Array<AbortSignal | undefined | null>): AbortSignal {
	const controller = new AbortController()

	for (const signal of signals) {
		if (!signal) continue
		if (signal.aborted) {
			controller.abort(signal.reason)
			return controller.signal
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
	}

	return controller.signal
}

/**
 * Build the platform-specific base fetch (proxy-aware undici for standalone, globalThis.fetch otherwise).
 * This is called once at module init.
 */
function buildBaseFetch(): typeof globalThis.fetch {
	if (process.env.IS_STANDALONE === "true") {
		const agent = new EnvHttpProxyAgent({})
		setGlobalDispatcher(agent)
		return undiciFetch as any as typeof globalThis.fetch
	}
	return globalThis.fetch
}

const baseFetch = buildBaseFetch()

/**
 * Create a proxy-aware fetch wrapper with per-category timeout and
 * multi-dimensional activity-based timeout for streaming responses.
 *
 * ## Timeout Strategy
 *
 * 1. **Total timeout** (time-to-headers) – covers connection setup, TLS handshake,
 *    proxy negotiation, and waiting for response headers. Defaults vary by
 *    category (see {@link DEFAULT_TIMEOUTS}). Once headers arrive the total
 *    timer is cleared so legitimately long LLM streams are not killed mid-body.
 * 2. **Inactivity timeout** – active only when the response body is a
 *    `ReadableStream`.  Resets every time bytes arrive.  If no bytes arrive
 *    within {@link STREAM_INACTIVITY_TIMEOUT_MS} the request is aborted,
 *    even if the total timeout has not been reached.  This catches stalled
 *    streams where the connection is open but no data flows.
 *
 * @param category  Request category used to select the default total timeout.
 * @param options   Optional overrides.
 * @param options.customTimeoutMs  Override the total timeout (ms).  Useful
 *   when the caller knows the expected latency (e.g. local models, user-
 *   configured timeout).
 * @returns A fetch-compatible function with timeout protection.
 *
 * @example
 * ```typescript
 * // Standard 5-min API call
 * const response = await fetch(url)
 *
 * // Local model – keep the category default (180 s)
 * const localFetch = createFetch('local')
 * const response = await localFetch(url)
 *
 * // User-configured 10-min timeout
 * const customFetch = createFetch('default', { customTimeoutMs: 600_000 })
 * const response = await customFetch(url)
 * ```
 */
export function createFetch(
	category: keyof typeof DEFAULT_TIMEOUTS = "default",
	options?: { customTimeoutMs?: number },
): typeof globalThis.fetch {
	const totalTimeoutMs = options?.customTimeoutMs ?? DEFAULT_TIMEOUTS[category] ?? DEFAULT_TIMEOUTS.default

	const timeoutFetch = async function timeoutFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const controller = new AbortController()
		const totalTimer = setTimeout(() => {
			controller.abort(new DOMException(`Request timed out after ${totalTimeoutMs}ms (category: ${category})`, "TIMEOUT"))
		}, totalTimeoutMs)

		try {
			const response = await (mockFetch || baseFetch)(input, {
				...init,
				signal: init?.signal ? anySignal(init.signal, controller.signal) : controller.signal,
			})

			// ── Activity-based timeout for streaming bodies ──────────────
			// Wrap the ReadableStream so that each chunk resets an inactivity
			// timer.  When the timer fires (no bytes for STREAM_INACTIVITY_TIMEOUT_MS)
			// we cancel the reader, which propagates to the underlying connection.
			const body = response.body
			if (body) {
				let inactivityTimer: ReturnType<typeof setTimeout> | undefined
				const reader = body.getReader()

				const resetInactivityTimer = () => {
					clearTimeout(inactivityTimer)
					inactivityTimer = setTimeout(() => {
						reader.cancel(
							new DOMException(
								`Stream stalled – no bytes for ${STREAM_INACTIVITY_TIMEOUT_MS}ms (category: ${category})`,
								"TIMEOUT",
							),
						)
					}, STREAM_INACTIVITY_TIMEOUT_MS)
				}

				// Kick off the first inactivity window
				resetInactivityTimer()

				const teedReadable = new ReadableStream({
					async pull(controller) {
						try {
							const { done, value } = await reader.read()
							if (done) {
								clearTimeout(inactivityTimer)
								controller.close()
							} else {
								resetInactivityTimer()
								controller.enqueue(value)
							}
						} catch (err) {
							clearTimeout(inactivityTimer)
							controller.error(err)
						}
					},
					cancel(reason) {
						clearTimeout(inactivityTimer)
						return reader.cancel(reason)
					},
				})

				return new Response(teedReadable, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				})
			}

			// Non-streaming response – the total timeout is sufficient.
			return response
		} finally {
			clearTimeout(totalTimer)
		}
	}

	// VS Code's global fetch also has `preconnect` (a hint API).
	// Stub it to satisfy the type without adding real support.
	;(timeoutFetch as any).preconnect = () => Promise.resolve(undefined)

	return timeoutFetch as typeof globalThis.fetch
}

/**
 * Platform-configured fetch that respects proxy settings.
 *
 * Default timeout: **5 minutes** (with 60s inactivity detection for streaming).
 * Use `createFetch(category, { customTimeoutMs })` for custom timeouts
 * (e.g. local models, deep-thinking, MCP SSE).
 *
 * Use this instead of global fetch to ensure proper proxy configuration.
 *
 * @example
 * ```typescript
 * import { fetch } from '@/shared/net'
 * const response = await fetch('https://api.example.com')
 * ```
 */
export const fetch: typeof globalThis.fetch = createFetch("default")

/**
 * Mocks `fetch` for testing and calls `callback`. Then restores `fetch`. If the
 * specified callback returns a Promise, the fetch is restored when that Promise
 * is settled.
 * @param theFetch the replacement function to call to implement `fetch`.
 * @param callback `fetch` will be mocked for the duration of `callback()`.
 * @returns the result of `callback()`.
 */
export function mockFetchForTesting<T>(theFetch: FetchFunction, callback: () => T): T {
	const originalMockFetch = mockFetch
	mockFetch = theFetch
	let willResetSync = true
	try {
		const result = callback()
		if (result instanceof Promise) {
			willResetSync = false
			return result.finally(() => {
				mockFetch = originalMockFetch
			}) as typeof result
		}
		return result
	} finally {
		if (willResetSync) {
			mockFetch = originalMockFetch
		}
	}
}

/**
 * Returns axios configuration for fetch adapter mode with our configured fetch.
 * This ensures axios uses our platform-specific fetch implementation with
 * proper proxy configuration.
 *
 * @returns Configuration object with fetch adapter and configured fetch
 *
 * @example
 * ```typescript
 * const response = await axios.get(url, {
 *   headers: { Authorization: 'Bearer token' },
 *   timeout: 5000,
 *   ...getAxiosSettings()
 * })
 * ```
 */
export function getAxiosSettings(): {
	adapter?: any
	fetch?: typeof globalThis.fetch
	maxBodyLength?: number
	maxContentLength?: number
} {
	return {
		adapter: "fetch" as any,
		fetch, // Use our configured fetch
		maxBodyLength: Number.POSITIVE_INFINITY,
		maxContentLength: Number.POSITIVE_INFINITY,
	}
}

/**
 * Check if the given host/URL should bypass the proxy according to NO_PROXY rules.
 *
 * Supports:
 * - Exact hostnames: `localhost`, `192.168.1.1`
 * - Wildcard domains: `*.example.com`, `.example.com`
 * - CIDR notation: `10.0.0.0/8` (prefix match)
 * - Multi-entry: `localhost,*.internal.corp`
 *
 * ALWAYS exempts localhost, 127.0.0.1, and [::1] regardless of NO_PROXY setting.
 * This prevents local MCP servers from being incorrectly routed through a corporate proxy.
 *
 * @example
 * ```typescript
 * import { isExcludedFromProxy } from '@/shared/net'
 *
 * const shouldBypass = isExcludedFromProxy('http://localhost:8080/mcp')
 * // => true (localhost always bypasses)
 *
 * const shouldBypass2 = isExcludedFromProxy('http://mcp.internal.corp')
 * // => true if *.internal.corp is in NO_PROXY
 * ```
 */
export function isExcludedFromProxy(urlOrHost: string): boolean {
	if (!urlOrHost) return false

	const host = extractHost(urlOrHost)

	// Always bypass proxy for localhost / loopback
	if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.startsWith("::1")) {
		return true
	}

	const noProxyRaw = process.env.NO_PROXY ?? process.env.no_proxy ?? ""
	if (!noProxyRaw.trim()) {
		return false
	}

	const entries = noProxyRaw
		.split(",")
		.map((e) => e.trim())
		.filter(Boolean)

	for (const entry of entries) {
		if (matchesNoProxyEntry(host, entry)) {
			return true
		}
	}

	return false
}

/**
 * Extract the hostname from a URL string, or return the input if it's already a hostname.
 */
function extractHost(input: string): string {
	try {
		// If it starts with a protocol, parse as URL
		if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(input)) {
			return new URL(input).hostname
		}
		// Strip port if present
		return input.split(":")[0].replace(/^\[|\]$/g, "")
	} catch {
		// If parsing fails, use the raw input (minus port)
		return input.split(":")[0].replace(/^\[|\]$/g, "")
	}
}

/**
 * Match a hostname against a single NO_PROXY entry.
 */
function matchesNoProxyEntry(host: string, entry: string): boolean {
	if (!entry) return false

	// Wildcard: *.example.com or .example.com
	if (entry.startsWith("*.") || entry.startsWith(".")) {
		const suffix = entry.startsWith("*.") ? entry.slice(1) : entry
		return host.endsWith(suffix) || host === suffix.slice(1)
	}

	// CIDR: 10.0.0.0/8 (basic support — exact prefix match)
	if (entry.includes("/")) {
		const [cidrPrefix] = entry.split("/")
		return host.startsWith(cidrPrefix)
	}

	// IP address or hostname — exact match
	return host === entry
}
