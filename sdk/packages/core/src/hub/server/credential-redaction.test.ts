import { describe, expect, it } from "vitest";
import {
	HUB_REDACTED,
	isCredentialKey,
	redactCredentialRecord,
	redactCredentials,
	redactCredentialText,
} from "./credential-redaction";

describe("isCredentialKey", () => {
	it("recognizes credential keys across separator and case styles", () => {
		for (const key of [
			"apiKey",
			"api_key",
			"API-KEY",
			"x-api-key",
			"openaiApiKey",
			"accessToken",
			"refresh_token",
			"authorization",
			"Authorization",
			"clientSecret",
			"password",
			"credential",
			"privateKey",
			"sessionToken",
		]) {
			expect(isCredentialKey(key), key).toBe(true);
		}
	});

	it("does not treat lookalike metadata keys as credentials", () => {
		for (const key of [
			"tokenBudget",
			"secretCount",
			"maxTokens",
			"passwordExpiry",
			"agentId",
			"sessionId",
			"title",
		]) {
			expect(isCredentialKey(key), key).toBe(false);
		}
	});
});

describe("redactCredentialText", () => {
	it("masks bearer tokens", () => {
		expect(
			redactCredentialText("Authorization: Bearer abcdef0123456789xyz"),
		).toContain(HUB_REDACTED);
		expect(
			redactCredentialText("Authorization: Bearer abcdef0123456789xyz"),
		).not.toContain("abcdef0123456789xyz");
	});

	it("masks key/value assignments", () => {
		const scrubbed = redactCredentialText(
			'curl -H "api_key=sk-proj-abcdefghijklmnop" https://example.test',
		);
		expect(scrubbed).not.toContain("sk-proj-abcdefghijklmnop");
		expect(scrubbed).toContain(HUB_REDACTED);
	});

	it("masks well-known provider key shapes", () => {
		for (const secret of [
			"sk-abcdefghijklmnopqrst",
			"ghp_abcdefghijklmnopqrstuvwxyz012345",
			"AKIAIOSFODNN7EXAMPLE",
			"xoxb-123456789012-abcdefghijkl",
		]) {
			expect(redactCredentialText(`value ${secret} end`), secret).not.toContain(
				secret,
			);
		}
	});

	it("leaves ordinary text alone", () => {
		const text = "Refactor the parser in src/parse.ts and rerun the tests.";
		expect(redactCredentialText(text)).toBe(text);
	});
});

describe("redactCredentials", () => {
	it("masks credential values by key wherever they appear", () => {
		const result = redactCredentials({
			provider: "anthropic",
			apiKey: "sk-live-abcdefghijklmnop",
			nested: { deeper: { password: "hunter2" } },
			list: [{ secret: "s3cr3t" }],
		});

		expect(result).toEqual({
			provider: "anthropic",
			apiKey: HUB_REDACTED,
			nested: { deeper: { password: HUB_REDACTED } },
			list: [{ secret: HUB_REDACTED }],
		});
	});

	it("masks credentials embedded in free-form strings", () => {
		const result = redactCredentials({
			systemPrompt: "Use ANTHROPIC_API_KEY=sk-abcdefghijklmnop for calls",
		});
		expect(JSON.stringify(result)).not.toContain("sk-abcdefghijklmnop");
	});

	it("preserves non-credential scalars and null", () => {
		expect(redactCredentials({ a: 1, b: true, c: null, d: "plain" })).toEqual({
			a: 1,
			b: true,
			c: null,
			d: "plain",
		});
	});

	it("drops class instances instead of enumerating their fields", () => {
		class Secretive {
			get apiKey(): string {
				return "sk-should-not-leak";
			}
		}
		const result = redactCredentials({ inner: new Secretive() });
		expect(JSON.stringify(result)).not.toContain("sk-should-not-leak");
		expect(result).toEqual({ inner: undefined });
	});

	it("stops recursing at the depth limit rather than walking forever", () => {
		let deep: Record<string, unknown> = { apiKey: "sk-deep" };
		for (let i = 0; i < 40; i += 1) {
			deep = { child: deep };
		}
		expect(() => redactCredentials(deep)).not.toThrow();
	});

	it("caps array length so a huge projection cannot exhaust the publisher", () => {
		const result = redactCredentials({
			items: new Array(5_000).fill("x"),
		}) as { items: unknown[] };
		expect(result.items.length).toBeLessThanOrEqual(2_000);
	});
});

describe("redactCredentialRecord", () => {
	it("keeps record shape and returns an empty object for non-records", () => {
		expect(redactCredentialRecord({ apiKey: "sk-x", title: "keep" })).toEqual({
			apiKey: HUB_REDACTED,
			title: "keep",
		});
		expect(redactCredentialRecord("not a record" as never)).toEqual({});
	});
});
