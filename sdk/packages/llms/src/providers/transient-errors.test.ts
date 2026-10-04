import { describe, expect, it } from "vitest";
import {
	computeRetryDelayMs,
	DEFAULT_PROVIDER_RETRY_POLICY,
	isAbortLikeError,
	isTransientProviderError,
} from "./transient-errors";

/**
 * This classifier used to live only in the VS Code extension, which meant the CLI
 * had no automatic retry: the same `ECONNRESET` failed a CLI run outright and was
 * transparently retried in the IDE. It is a pure predicate over an `unknown` because
 * a failure that crossed a process or serialization boundary often arrives as a bare
 * string, and because the whole point is to be testable without a network.
 */
describe("isTransientProviderError", () => {
	describe("retries", () => {
		const transient: Array<[string, unknown]> = [
			[
				"ECONNRESET before TLS, as reported by the exact user-visible message",
				new Error(
					"Cannot connect to API: Client network socket disconnected before secure TLS connection was established: Client network socket disconnected before secure TLS connection was established (ECONNRESET)",
				),
			],
			[
				"ECONNRESET carried only on the syscall code",
				Object.assign(new Error("socket failure"), { code: "ECONNRESET" }),
			],
			[
				"ECONNREFUSED",
				Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
			],
			["ENOTFOUND", Object.assign(new Error("dns"), { code: "ENOTFOUND" })],
			["socket hang up", new Error("socket hang up")],
			["502", new Error("upstream said 502")],
			["503", new Error("503 Service Unavailable")],
			["504", new Error("gateway timeout 504")],
			["bad gateway", new Error("Bad Gateway")],
			["429", new Error("429 Too Many Requests")],
			["rate limit", new Error("rate limit exceeded")],
			["overloaded", new Error("model overloaded, try again")],
			["model at capacity", new Error("The model is at capacity")],
			["stream stalled", new Error("stream stalled and reset")],
			["a bare string", "ECONNRESET"],
		];

		it.each(transient)("%s", (_label, error) => {
			expect(isTransientProviderError(error)).toBe(true);
		});

		it("classifies a TIMEOUT-named error as transient despite its message", () => {
			// The net.ts timeout sets name="TIMEOUT" while the message can read like a
			// cancellation. Classifying by message here would silently drop real retries.
			const error = new Error("The operation was aborted");
			error.name = "TIMEOUT";
			expect(isTransientProviderError(error)).toBe(true);
		});

		it("finds a socket error nested one cause deep", () => {
			// SDK client wrappers routinely bury the socket error.
			const inner = Object.assign(new Error("read ECONNRESET"), {
				code: "ECONNRESET",
			});
			const outer = new Error("request failed", { cause: inner });
			expect(isTransientProviderError(outer)).toBe(true);
		});
	});

	describe("does not retry", () => {
		const permanent: Array<[string, unknown]> = [
			["an abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
			[
				"a hook-requested stop",
				Object.assign(new Error("stop"), { name: "ControlledStopError" }),
			],
			["an auth failure", new Error("401 Unauthorized: invalid api key")],
			["a billing failure", new Error("402 Payment Required")],
			["a bad request", new Error("400 Bad Request: unknown model")],
			["a not-found", new Error("404 model not found")],
			["an ordinary TypeError", new TypeError("x is not a function")],
		];

		it.each(permanent)("%s", (_label, error) => {
			expect(isTransientProviderError(error)).toBe(false);
		});

		// Documented bias rather than an accident: a bare status code is matched with a
		// substring test, so an incidental "502" is retried. That is deliberate — a
		// false positive costs one ~2s retry, a false negative loses the turn — and a
		// tighter match was tried and rejected because it also stops retrying providers
		// that word a real 503 as "upstream said 503".
		it("retries an incidental 502 rather than risk losing the turn", () => {
			expect(
				isTransientProviderError(new Error("read 502 lines from disk")),
			).toBe(true);
		});

		it("does not retry a capacity mention that is really a quota wall", () => {
			// "capacity" alone appeared in quota copy that is not worth retrying.
			expect(
				isTransientProviderError(
					new Error("monthly capacity reached for your plan"),
				),
			).toBe(false);
		});

		it("handles null, undefined and non-errors without throwing", () => {
			for (const value of [null, undefined, 0, "", [], {}]) {
				expect(isTransientProviderError(value)).toBe(false);
			}
		});
	});
});

describe("isAbortLikeError", () => {
	it("recognizes both abort spellings", () => {
		expect(isAbortLikeError(new DOMException("x", "AbortError"))).toBe(true);
		expect(
			isAbortLikeError(
				Object.assign(new Error("x"), { name: "ControlledStopError" }),
			),
		).toBe(true);
	});

	it("ignores non-objects and unrelated errors", () => {
		expect(isAbortLikeError("AbortError")).toBe(false);
		expect(isAbortLikeError(new Error("ECONNRESET"))).toBe(false);
	});
});

describe("computeRetryDelayMs", () => {
	it("doubles per attempt up to the ceiling, with bounded jitter", () => {
		const policy = {
			maxRetries: 5,
			baseDelayMs: 1000,
			maxDelayMs: 10_000,
			jitterRatio: 0.2,
		};
		// random() === 0 removes the jitter term, exposing the raw schedule.
		const noJitter = () => 0;
		expect(computeRetryDelayMs(0, policy, noJitter)).toBe(1000);
		expect(computeRetryDelayMs(1, policy, noJitter)).toBe(2000);
		expect(computeRetryDelayMs(2, policy, noJitter)).toBe(4000);
		expect(computeRetryDelayMs(3, policy, noJitter)).toBe(8000);
		// Ceiling clamps rather than continuing to double.
		expect(computeRetryDelayMs(4, policy, noJitter)).toBe(10_000);
		expect(computeRetryDelayMs(9, policy, noJitter)).toBe(10_000);
	});

	it("adds jitter on top, and never a negative delay for a hostile random()", () => {
		const policy = {
			maxRetries: 3,
			baseDelayMs: 1000,
			maxDelayMs: 10_000,
			jitterRatio: 0.2,
		};
		expect(computeRetryDelayMs(0, policy, () => 1)).toBe(1200);
		expect(computeRetryDelayMs(0, policy, () => 0.5)).toBe(1100);
		expect(computeRetryDelayMs(0, policy, () => 0)).toBe(1000);
	});

	it("treats a negative attempt as attempt 0", () => {
		expect(
			computeRetryDelayMs(-3, DEFAULT_PROVIDER_RETRY_POLICY, () => 0),
		).toBe(DEFAULT_PROVIDER_RETRY_POLICY.baseDelayMs);
	});

	it("defaults to the shared policy so both hosts back off identically", () => {
		expect(computeRetryDelayMs(0, undefined, () => 0)).toBe(
			DEFAULT_PROVIDER_RETRY_POLICY.baseDelayMs,
		);
		expect(DEFAULT_PROVIDER_RETRY_POLICY.maxRetries).toBe(3);
	});
});
