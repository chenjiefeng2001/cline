import { describe, expect, it } from "vitest";
import {
	CLIENT_IDENTITY_ENV_KEYS,
	resolveClientIdentityOverridesFromEnv,
	resolveProviderRequestHeaders,
} from "./request-headers";

function jwtWithPayload(payload: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.sig`;
}

describe("resolveProviderRequestHeaders", () => {
	it("adds required Cline billing headers after stored, config, and session layers", () => {
		const headers = resolveProviderRequestHeaders({
			providerId: "cline",
			sessionId: "sess-1",
			source: "cli",
			defaultSource: "core",
			client: {
				name: "cline-cli",
				version: "3.0.38",
			},
			coreVersion: "0.2.0",
			headers: {
				stored: {
					"X-CLIENT-TYPE": "stored-client",
					"x-stored": "stored",
					"x-shared": "stored-loses",
				},
				config: {
					"X-Task-ID": "config-task",
					"x-config": "config",
					"x-shared": "config-wins",
				},
				session: {
					"X-CLIENT-VERSION": "session-version",
					"x-session": "session",
				},
			},
		});

		expect(headers).toMatchObject({
			"HTTP-Referer": "https://cline.bot",
			"X-Title": "Cline",
			"User-Agent": "Cline/3.0.38",
			"X-IS-MULTIROOT": "false",
			"X-CLIENT-TYPE": "cline-cli",
			"X-CLIENT-VERSION": "3.0.38",
			"X-PLATFORM": "cli",
			"X-PLATFORM-VERSION": "3.0.38",
			"X-CORE-VERSION": "0.2.0",
			"X-Task-ID": "sess-1",
			"x-config": "config",
			"x-session": "session",
			"x-shared": "config-wins",
			"x-stored": "stored",
		});
	});

	it("uses host client context for Cline billing headers when provided", () => {
		const headers = resolveProviderRequestHeaders({
			providerId: "cline-pass",
			sessionId: "sess-vscode",
			source: "core",
			defaultSource: "core",
			client: {
				name: "VSCode Extension",
				version: "9.9.9",
				platform: "Visual Studio Code",
				platformVersion: "1.103.0",
				isMultiRoot: true,
			},
			coreVersion: "0.2.0",
		});

		expect(headers).toMatchObject({
			"User-Agent": "Cline/9.9.9",
			"X-IS-MULTIROOT": "true",
			"X-CLIENT-TYPE": "VSCode Extension",
			"X-CLIENT-VERSION": "9.9.9",
			"X-PLATFORM": "Visual Studio Code",
			"X-PLATFORM-VERSION": "1.103.0",
			"X-CORE-VERSION": "0.2.0",
			"X-Task-ID": "sess-vscode",
		});
	});

	it("adds OpenAI Codex headers and derives the account id from the access token", () => {
		const token = jwtWithPayload({
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct-derived",
			},
		});

		const headers = resolveProviderRequestHeaders({
			providerId: "openai-codex",
			sessionId: "sess-codex",
			defaultSource: "cli",
			coreVersion: "0.2.0",
			openAiCodex: {
				accessToken: token,
				userAgentVersion: "3.0.38",
			},
			headers: {
				stored: {
					originator: "stored-originator",
					"x-stored": "stored",
				},
				config: {
					session_id: "config-session",
					"x-config": "config",
				},
			},
		});

		expect(headers).toMatchObject({
			originator: "cline",
			session_id: "sess-codex",
			"User-Agent": "Cline/3.0.38",
			"ChatGPT-Account-Id": "acct-derived",
			"x-config": "config",
			"x-stored": "stored",
		});
	});

	it("preserves existing precedence for providers without required headers", () => {
		expect(
			resolveProviderRequestHeaders({
				providerId: "anthropic",
				sessionId: "sess-plain",
				defaultSource: "cli",
				coreVersion: "0.2.0",
				headers: {
					stored: { "x-stored": "stored" },
					config: { "x-config": "config" },
				},
			}),
		).toEqual({ "x-config": "config" });

		expect(
			resolveProviderRequestHeaders({
				providerId: "anthropic",
				sessionId: "sess-plain",
				defaultSource: "cli",
				coreVersion: "0.2.0",
				headers: {
					stored: { "x-stored": "stored" },
					config: { "x-config": "config" },
					session: { "x-session": "session" },
				},
			}),
		).toEqual({ "x-session": "session" });
	});
});

/**
 * A caller that reports a version it does not have is worse than one that reports
 * none: `Cline/unknown` and `Cline/1.0.0` both read as a spoofed client to an
 * upstream that classifies callers. These tests exist because the previous
 * fallbacks did exactly that, and they only failed on a real request path.
 */
describe("resolveProviderRequestHeaders - version reporting", () => {
	it("omits the version rather than reporting the literal string unknown", () => {
		const headers = resolveProviderRequestHeaders({
			providerId: "cline",
			sessionId: "sess-noversion",
			defaultSource: "cli",
			coreVersion: "0.2.0",
		});

		expect(headers?.["User-Agent"]).toBe("Cline");
		expect(headers).not.toHaveProperty("X-CLIENT-VERSION");
		expect(headers).not.toHaveProperty("X-PLATFORM-VERSION");
		expect(JSON.stringify(headers)).not.toContain("unknown");
	});

	it("reports the configured version when the host knows it", () => {
		const headers = resolveProviderRequestHeaders({
			providerId: "cline",
			sessionId: "sess-version",
			defaultSource: "cli",
			coreVersion: "0.2.0",
			client: { version: "3.0.44" },
		});

		expect(headers?.["User-Agent"]).toBe("Cline/3.0.44");
		expect(headers?.["X-CLIENT-VERSION"]).toBe("3.0.44");
	});

	it("falls back to the header a host supplied instead of a placeholder", () => {
		const headers = resolveProviderRequestHeaders({
			providerId: "cline",
			sessionId: "sess-fallback",
			defaultSource: "cli",
			coreVersion: "0.2.0",
			client: { versionHeaderFallback: "4.1.0" },
		});

		expect(headers?.["User-Agent"]).toBe("Cline/4.1.0");
	});

	it("prefers the real client version over an absent npm_package_version for Codex", () => {
		// `userAgentVersion` is fed from process.env.npm_package_version, which is
		// undefined unless the process was started through a package script. Running
		// the `cline` bin directly therefore used to fall back to a pinned "1.0.0"
		// that no build ever reported.
		const headers = resolveProviderRequestHeaders({
			providerId: "openai-codex",
			sessionId: "sess-codex",
			defaultSource: "cli",
			coreVersion: "0.2.0",
			client: { version: "3.0.44" },
			openAiCodex: { userAgentVersion: undefined },
		});

		expect(headers?.["User-Agent"]).toBe("Cline/3.0.44");
	});

	it("keeps using the supplied Codex version when the host reports none", () => {
		const headers = resolveProviderRequestHeaders({
			providerId: "openai-codex",
			sessionId: "sess-codex",
			defaultSource: "cli",
			coreVersion: "0.2.0",
			openAiCodex: { userAgentVersion: "2.2.2" },
		});

		expect(headers?.["User-Agent"]).toBe("Cline/2.2.2");
	});

	it("sends no fabricated version for Codex when nothing is known", () => {
		const headers = resolveProviderRequestHeaders({
			providerId: "openai-codex",
			sessionId: "sess-codex",
			defaultSource: "cli",
			coreVersion: "0.2.0",
			openAiCodex: {},
		});

		expect(headers?.["User-Agent"]).toBe("Cline");
		expect(JSON.stringify(headers)).not.toContain("1.0.0");
	});
});

describe("resolveProviderRequestHeaders - identity overrides", () => {
	const clineInput = {
		providerId: "cline",
		sessionId: "sess-override",
		defaultSource: "cli",
		coreVersion: "0.2.0",
		client: { name: "cline-cli", version: "3.0.44" },
	} as const;

	it("lets a deployment replace the identity it presents", () => {
		const headers = resolveProviderRequestHeaders({
			...clineInput,
			identityOverrides: {
				"User-Agent": "SelfHosted/2.0",
				"X-CLIENT-TYPE": "self-hosted",
				"X-Title": "Self Hosted",
				"HTTP-Referer": "https://llm.internal",
			},
		});

		expect(headers?.["User-Agent"]).toBe("SelfHosted/2.0");
		expect(headers?.["X-CLIENT-TYPE"]).toBe("self-hosted");
		expect(headers?.["X-Title"]).toBe("Self Hosted");
		expect(headers?.["HTTP-Referer"]).toBe("https://llm.internal");
		// Untouched derived headers still report their real values.
		expect(headers?.["X-CORE-VERSION"]).toBe("0.2.0");
		expect(headers?.["X-Task-ID"]).toBe("sess-override");
	});

	it("replaces the Codex originator without touching the account id", () => {
		const headers = resolveProviderRequestHeaders({
			providerId: "openai-codex",
			sessionId: "sess-codex",
			defaultSource: "cli",
			coreVersion: "0.2.0",
			client: { version: "3.0.44" },
			openAiCodex: { accountId: "acct-real" },
			identityOverrides: { originator: "my-gateway" },
		});

		expect(headers?.originator).toBe("my-gateway");
		expect(headers?.["ChatGPT-Account-Id"]).toBe("acct-real");
	});

	it("refuses to override headers that identify the caller rather than the client", () => {
		// The override channel describes the client. Allowing it to rewrite an
		// account id or a session id would let a config file misattribute traffic,
		// so those stay out of reach even though they sit in the same object.
		const headers = resolveProviderRequestHeaders({
			providerId: "openai-codex",
			sessionId: "sess-codex",
			defaultSource: "cli",
			coreVersion: "0.2.0",
			openAiCodex: { accountId: "acct-real" },
			identityOverrides: {
				"ChatGPT-Account-Id": "acct-someone-else",
				session_id: "session-someone-else",
				"X-Task-ID": "task-someone-else",
				"X-CORE-VERSION": "9.9.9",
			},
		});

		expect(headers?.["ChatGPT-Account-Id"]).toBe("acct-real");
		expect(headers?.session_id).toBe("sess-codex");
		expect(headers).not.toHaveProperty("X-Task-ID");
		expect(headers).not.toHaveProperty("X-CORE-VERSION");
	});

	it("refuses to override the Cline task id", () => {
		const headers = resolveProviderRequestHeaders({
			providerId: "cline",
			sessionId: "sess-real",
			defaultSource: "cli",
			coreVersion: "0.2.0",
			identityOverrides: {
				"X-Task-ID": "task-someone-else",
				"X-CORE-VERSION": "9.9.9",
			},
		});

		expect(headers?.["X-Task-ID"]).toBe("sess-real");
		expect(headers?.["X-CORE-VERSION"]).toBe("0.2.0");
	});

	it("cannot be used to inject a header the layer does not send", () => {
		const headers = resolveProviderRequestHeaders({
			...clineInput,
			identityOverrides: { "X-Injected": "value" },
		});

		expect(headers).not.toHaveProperty("X-Injected");
	});

	it("matches override header names case-insensitively", () => {
		const headers = resolveProviderRequestHeaders({
			...clineInput,
			identityOverrides: { "user-agent": "CaseInsensitive/1.0" },
		});

		expect(headers?.["User-Agent"]).toBe("CaseInsensitive/1.0");
	});
});

describe("resolveClientIdentityOverridesFromEnv", () => {
	it("maps the documented environment variables", () => {
		expect(
			resolveClientIdentityOverridesFromEnv({
				[CLIENT_IDENTITY_ENV_KEYS.userAgent]: "SelfHosted/2.0",
				[CLIENT_IDENTITY_ENV_KEYS.clientType]: "self-hosted",
				[CLIENT_IDENTITY_ENV_KEYS.title]: "Self Hosted",
				[CLIENT_IDENTITY_ENV_KEYS.referer]: "https://llm.internal",
				[CLIENT_IDENTITY_ENV_KEYS.originator]: "my-gateway",
			}),
		).toEqual({
			"User-Agent": "SelfHosted/2.0",
			"X-CLIENT-TYPE": "self-hosted",
			"X-Title": "Self Hosted",
			"HTTP-Referer": "https://llm.internal",
			originator: "my-gateway",
		});
	});

	it("ignores blank values instead of sending empty headers", () => {
		// Number("") and friends are 0; an empty header is worse than an absent one.
		expect(
			resolveClientIdentityOverridesFromEnv({
				[CLIENT_IDENTITY_ENV_KEYS.userAgent]: "   ",
				[CLIENT_IDENTITY_ENV_KEYS.clientType]: "",
			}),
		).toBeUndefined();
	});

	it("returns undefined when the environment says nothing", () => {
		expect(resolveClientIdentityOverridesFromEnv({})).toBeUndefined();
	});
});
