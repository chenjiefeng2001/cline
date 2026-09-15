/**
 * Redaction middleware [roadmap P1-4].
 *
 * Scrubs sensitive patterns (PII/secrets) from tool outputs before they
 * reach the model or the transcript. Applies to string results, string
 * array items, and string values inside plain objects (depth-limited);
 * non-string payloads pass through untouched.
 */

import type { ToolMiddleware, ToolMiddlewareContext } from "./tool-middleware";

export const DEFAULT_REDACTION_REPLACEMENT = "[REDACTED]";

/** Built-in secret/PII patterns: emails, bearer tokens, common key shapes. */
export const DEFAULT_REDACTION_PATTERNS: RegExp[] = [
	/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\bghp_[A-Za-z0-9]{20,}/g,
	/\bAKIA[0-9A-Z]{12,}/g,
];

export interface RedactionMiddlewareOptions {
	/** Patterns to scrub; defaults to the built-in secret/PII set. */
	patterns?: RegExp[];
	/** Replacement text. Defaults to "[REDACTED]". */
	replacement?: string;
	/** Max object depth scanned. Defaults to 4. */
	maxDepth?: number;
}

export function createRedactionMiddleware(
	options: RedactionMiddlewareOptions = {},
): ToolMiddleware {
	const patterns = options.patterns ?? DEFAULT_REDACTION_PATTERNS;
	const replacement = options.replacement ?? DEFAULT_REDACTION_REPLACEMENT;
	const maxDepth = Math.max(1, options.maxDepth ?? 4);

	const scrubString = (value: string): string => {
		let out = value;
		for (const pattern of patterns) {
			out = out.replace(pattern, replacement);
		}
		return out;
	};

	const scrub = (value: unknown, depth: number): unknown => {
		if (typeof value === "string") {
			return scrubString(value);
		}
		if (depth >= maxDepth) {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map((item) => scrub(item, depth + 1));
		}
		// Only plain objects are rebuilt; class instances (Buffer, Date, ...)
		// pass through untouched — Object.entries would destroy them.
		if (
			value &&
			typeof value === "object" &&
			(Object.getPrototypeOf(value) === Object.prototype ||
				Object.getPrototypeOf(value) === null)
		) {
			const out: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(value)) {
				out[key] = scrub(item, depth + 1);
			}
			return out;
		}
		return value;
	};

	return {
		name: "redaction",
		async wrap(execute, _context: ToolMiddlewareContext) {
			return scrub(await execute(), 0);
		},
	};
}
