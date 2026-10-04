import { decodeJwtPayload } from "@cline/shared";

export interface ProviderRequestHeaderClientContext {
	name?: string;
	version?: string;
	versionHeaderFallback?: string;
	platform?: string;
	platformVersion?: string;
	isMultiRoot?: boolean;
}

export interface ProviderRequestHeaderLayers {
	stored?: Record<string, string>;
	config?: Record<string, string>;
	session?: Record<string, string>;
}

export interface OpenAICodexRequestHeaderContext {
	accountId?: string;
	accessToken?: string;
	userAgentVersion?: string;
}

export interface ResolveProviderRequestHeadersInput {
	providerId: string;
	sessionId: string;
	source?: string;
	defaultSource: string;
	client?: ProviderRequestHeaderClientContext;
	coreVersion: string;
	openAiCodex?: OpenAICodexRequestHeaderContext;
	headers?: ProviderRequestHeaderLayers;
	/**
	 * Deployment-level replacements for the derived identity headers.
	 *
	 * These exist because an operator may need to present a specific identity to
	 * an upstream — a self-hosted gateway that expects its own product name, for
	 * example — and the derived values were previously impossible to change:
	 * `resolveProviderRequestHeaders` puts them last, so a value set through
	 * settings or a provider config was always overwritten.
	 *
	 * Only {@link OVERRIDABLE_IDENTITY_HEADERS} may be replaced. Everything else
	 * the provider layer derives (account ids, session ids, task ids) stays
	 * non-overridable on purpose: those identify the authenticated caller, and
	 * letting a config file rewrite them would be a way to misattribute traffic
	 * rather than to describe the client.
	 */
	identityOverrides?: Record<string, string>;
}

/**
 * The only headers a deployment may replace.
 *
 * Keys are matched case-insensitively because HTTP header names are, and the
 * replacement keeps the casing used here so the emitted header set stays stable.
 */
const OVERRIDABLE_IDENTITY_HEADERS = new Set([
	"user-agent",
	"x-client-type",
	"x-title",
	"http-referer",
	"originator",
]);

/** Environment variables that populate {@link ResolveProviderRequestHeadersInput.identityOverrides}. */
export const CLIENT_IDENTITY_ENV_KEYS = {
	userAgent: "CLINE_CLIENT_USER_AGENT",
	clientType: "CLINE_CLIENT_TYPE",
	title: "CLINE_CLIENT_TITLE",
	referer: "CLINE_CLIENT_REFERER",
	originator: "CLINE_CODEX_ORIGINATOR",
} as const;

/**
 * Read identity overrides from the environment.
 *
 * Environment rather than settings, because this is a deployment concern: the
 * same build can be pointed at different upstreams without being reconfigured
 * per user. Blank values are ignored rather than sent as empty headers.
 */
export function resolveClientIdentityOverridesFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
	const candidates: Array<[string, string | undefined]> = [
		["User-Agent", env[CLIENT_IDENTITY_ENV_KEYS.userAgent]],
		["X-CLIENT-TYPE", env[CLIENT_IDENTITY_ENV_KEYS.clientType]],
		["X-Title", env[CLIENT_IDENTITY_ENV_KEYS.title]],
		["HTTP-Referer", env[CLIENT_IDENTITY_ENV_KEYS.referer]],
		["originator", env[CLIENT_IDENTITY_ENV_KEYS.originator]],
	];
	const overrides: Record<string, string> = {};
	for (const [header, value] of candidates) {
		const trimmed = trimNonEmpty(value);
		if (trimmed) {
			overrides[header] = trimmed;
		}
	}
	return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function applyIdentityOverrides(
	headers: Record<string, string>,
	overrides: Record<string, string> | undefined,
): Record<string, string> {
	if (!overrides) {
		return headers;
	}
	const applied: Record<string, string> = { ...headers };
	for (const [header, value] of Object.entries(overrides)) {
		const canonical = Object.keys(applied).find(
			(existing) => existing.toLowerCase() === header.toLowerCase(),
		);
		// A header that is not derived here is left alone instead of being
		// injected, so the override channel cannot be used to add headers.
		if (canonical && OVERRIDABLE_IDENTITY_HEADERS.has(header.toLowerCase())) {
			applied[canonical] = value;
		}
	}
	return applied;
}

const DEFAULT_CLINE_REQUEST_HEADERS: Record<string, string> = {
	"HTTP-Referer": "https://cline.bot",
	"X-Title": "Cline",
	"X-IS-MULTIROOT": "false",
	"X-CLIENT-TYPE": "cline-sdk",
};

function isClineBillingProvider(providerId: string): boolean {
	return providerId === "cline" || providerId === "cline-pass";
}

function trimNonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveSource(
	source: string | undefined,
	defaultSource: string,
): string {
	return trimNonEmpty(source) ?? defaultSource;
}

/**
 * Resolve the client version to report, or `undefined` when there is none.
 *
 * There is deliberately no placeholder. An earlier version fell back to the
 * literal string `"unknown"`, which produced `User-Agent: Cline/unknown` and
 * `X-CLIENT-VERSION: unknown`. A self-reported version that is obviously not a
 * version reads as a malformed client to any upstream that classifies callers,
 * which is the opposite of what a fallback is supposed to achieve.
 */
function resolveClineClientVersion(
	client: ProviderRequestHeaderClientContext | undefined,
): string | undefined {
	return (
		trimNonEmpty(client?.version) ?? trimNonEmpty(client?.versionHeaderFallback)
	);
}

/** `Cline/1.2.3`, or a bare `Cline` when the version is genuinely unknown. */
function buildClineUserAgent(clientVersion: string | undefined): string {
	return clientVersion ? `Cline/${clientVersion}` : "Cline";
}

function buildClineRequestHeaders(
	input: ResolveProviderRequestHeadersInput,
): Record<string, string> | undefined {
	if (!isClineBillingProvider(input.providerId)) {
		return undefined;
	}
	const source = resolveSource(input.source, input.defaultSource);
	const clientType = trimNonEmpty(input.client?.name) ?? `cline-${source}`;
	const clientVersion = resolveClineClientVersion(input.client);
	const platform = trimNonEmpty(input.client?.platform) ?? source;
	const platformVersion =
		trimNonEmpty(input.client?.platformVersion) ?? clientVersion;
	return applyIdentityOverrides(
		{
			...DEFAULT_CLINE_REQUEST_HEADERS,
			"User-Agent": buildClineUserAgent(clientVersion),
			"X-IS-MULTIROOT": input.client?.isMultiRoot === true ? "true" : "false",
			"X-CLIENT-TYPE": clientType,
			...(clientVersion ? { "X-CLIENT-VERSION": clientVersion } : {}),
			"X-PLATFORM": platform,
			...(platformVersion ? { "X-PLATFORM-VERSION": platformVersion } : {}),
			"X-CORE-VERSION": input.coreVersion,
			"X-Task-ID": input.sessionId,
		},
		input.identityOverrides,
	);
}

function deriveOpenAICodexAccountId(
	accessToken: string | undefined,
): string | undefined {
	const payload = decodeJwtPayload(accessToken) as
		| {
				"https://api.openai.com/auth"?: { chatgpt_account_id?: string };
				organizations?: Array<{ id?: string }>;
				chatgpt_account_id?: string;
		  }
		| undefined;
	const authAccountId =
		payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	if (typeof authAccountId === "string" && authAccountId.length > 0) {
		return authAccountId;
	}
	const orgAccountId = payload?.organizations?.[0]?.id;
	if (typeof orgAccountId === "string" && orgAccountId.length > 0) {
		return orgAccountId;
	}
	const rootAccountId = payload?.chatgpt_account_id;
	if (typeof rootAccountId === "string" && rootAccountId.length > 0) {
		return rootAccountId;
	}
	return undefined;
}

function buildOpenAICodexRequestHeaders(
	input: ResolveProviderRequestHeadersInput,
): Record<string, string> | undefined {
	if (input.providerId !== "openai-codex") {
		return undefined;
	}
	const accountId =
		trimNonEmpty(input.openAiCodex?.accountId) ??
		deriveOpenAICodexAccountId(input.openAiCodex?.accessToken);
	// Prefer the resolved client version over `userAgentVersion`. That field is fed
	// from `process.env.npm_package_version`, which is only set when the process was
	// launched through a package manager script — running the `cline` bin directly
	// leaves it undefined, and the old `?? "1.0.0"` fallback then reported a pinned
	// version that no build of this client has ever been. A caller that does know
	// its version should win over a guess made by the environment.
	const clientVersion =
		resolveClineClientVersion(input.client) ??
		trimNonEmpty(input.openAiCodex?.userAgentVersion);
	return applyIdentityOverrides(
		{
			originator: "cline",
			session_id: input.sessionId,
			"User-Agent": buildClineUserAgent(clientVersion),
			...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
		},
		input.identityOverrides,
	);
}

function resolveRequiredProviderHeaders(
	input: ResolveProviderRequestHeadersInput,
): Record<string, string> | undefined {
	return (
		buildClineRequestHeaders(input) ?? buildOpenAICodexRequestHeaders(input)
	);
}

function resolveDefaultProviderHeaders(
	headers: ProviderRequestHeaderLayers | undefined,
): Record<string, string> | undefined {
	return headers?.session ?? headers?.config ?? headers?.stored;
}

export function resolveProviderRequestHeaders(
	input: ResolveProviderRequestHeadersInput,
): Record<string, string> | undefined {
	const requiredHeaders = resolveRequiredProviderHeaders(input);
	if (requiredHeaders) {
		// Identity overrides land inside `requiredHeaders`, after the derived values
		// and after the stored/config/session layers. That ordering is the whole
		// point: an operator can replace how the client describes itself, but only
		// through the documented channel, and never by editing a header this layer
		// is responsible for.
		return {
			...(input.headers?.stored ?? {}),
			...(input.headers?.config ?? {}),
			...(input.headers?.session ?? {}),
			...requiredHeaders,
		};
	}
	const headers = resolveDefaultProviderHeaders(input.headers);
	return headers ? { ...headers } : undefined;
}
