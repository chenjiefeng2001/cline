/**
 * Unified credential redaction for hub projections.
 *
 * A credential reaches a client through three broadcast surfaces: hub events,
 * the session record projection, and the client registry record. Auditing each
 * projection separately is how the same leak comes back, so redaction is applied
 * at those choke points instead of per field.
 *
 * Two independent mechanisms:
 *
 * 1. **Key-based masking.** A value under a credential-ish key is replaced
 *    wholesale, whatever it looks like. This is the reliable one — it does not
 *    depend on recognizing a secret's shape.
 * 2. **Shape-based masking.** Credential text embedded in a free-form string
 *    (`Authorization: Bearer …`, `api_key=…`) is masked, because a system prompt
 *    or a tool description can carry a pasted key.
 *
 * Only projections are redacted. Nothing here changes what is persisted or what
 * the runtime actually uses for a request, so this cannot break a provider call.
 */

import type { JsonValue } from "@cline/shared";

export const HUB_REDACTED = "[REDACTED]";

const MAX_REDACTION_DEPTH = 12;
const MAX_REDACTION_ARRAY_ITEMS = 2_000;

/**
 * Keys whose value is always a credential. Matched case-insensitively on the
 * key with separators removed, so `api_key`, `apiKey`, `API-KEY`, and
 * `x-api-key` all match.
 */
const CREDENTIAL_KEY_PATTERN =
	/^(?:x|cline|openai|anthropic|aws|azure|google|github|gitlab|slack|stripe|npm|db|database)?(apikey|accesstoken|refreshtoken|idtoken|authtoken|authorization|auth|bearer|secret|clientsecret|password|passwd|pwd|credential|credentials|privatekey|sessiontoken|pat|token)$/;

/** Keys that merely *contain* a credential word, e.g. `openaiApiKeyForTeam`. */
const CREDENTIAL_KEY_FRAGMENT_PATTERN =
	/(apikey|accesstoken|refreshtoken|idtoken|authtoken|clientsecret|privatekey|sessiontoken|secret|password|passwd|credential|authorization|bearer)/;

const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE_ASSIGNMENT_PATTERN =
	/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret))\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"'}\]]+)/gi;
const PROVIDER_KEY_SHAPES: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{12,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bAKIA[0-9A-Z]{12,}/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
	/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

function normalizeKey(key: string): string {
	return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export function isCredentialKey(key: string): boolean {
	const normalized = normalizeKey(key);
	if (normalized.length === 0) {
		return false;
	}
	if (CREDENTIAL_KEY_PATTERN.test(normalized)) {
		return true;
	}
	// A fragment match only counts when the key is not a known-safe name, so
	// `secretCount` and `tokenBudget` survive while `openaiApiKey` does not.
	return (
		CREDENTIAL_KEY_FRAGMENT_PATTERN.test(normalized) &&
		!/count|length|budget|limit|expiry|expires|at$|id$/.test(normalized)
	);
}

export function redactCredentialText(value: string): string {
	let out = value;
	out = out.replace(BEARER_PATTERN, `$1 ${HUB_REDACTED}`);
	out = out.replace(
		KEY_VALUE_ASSIGNMENT_PATTERN,
		(_match, key: string, separator: string) =>
			`${key}${separator}${HUB_REDACTED}`,
	);
	for (const pattern of PROVIDER_KEY_SHAPES) {
		out = out.replace(pattern, HUB_REDACTED);
	}
	return out;
}

/**
 * Deep-redact a projection. Keys are masked wholesale; strings are scanned for
 * credential shapes. Non-plain values (functions, class instances) are dropped
 * rather than rebuilt, so a projection can never smuggle a live object out.
 */
export function redactCredentials<T>(
	value: T,
	depth = 0,
): JsonValue | undefined {
	if (value === null || value === undefined) {
		return value === null ? null : undefined;
	}
	if (typeof value === "string") {
		return redactCredentialText(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (depth >= MAX_REDACTION_DEPTH) {
		return HUB_REDACTED;
	}
	if (Array.isArray(value)) {
		return value
			.slice(0, MAX_REDACTION_ARRAY_ITEMS)
			.map((item) => redactCredentials(item, depth + 1) ?? null);
	}
	if (typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			// A class instance (Error, Date, Map, …) has no meaningful JSON
			// projection; dropping it is safer than enumerating its fields.
			return undefined;
		}
		const result: Record<string, JsonValue | undefined> = {};
		for (const [key, item] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (isCredentialKey(key)) {
				result[key] = item === undefined ? undefined : HUB_REDACTED;
				continue;
			}
			const redacted = redactCredentials(item, depth + 1);
			if (redacted !== undefined) {
				result[key] = redacted;
			}
		}
		return result;
	}
	// Functions, symbols, and anything else cannot be projected safely.
	return undefined;
}

/** Redact a record projection, preserving its `undefined` entries. */
export function redactCredentialRecord<T extends Record<string, unknown>>(
	record: T,
): Record<string, JsonValue | undefined> {
	const redacted = redactCredentials(record);
	if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) {
		return {};
	}
	return redacted as Record<string, JsonValue | undefined>;
}
