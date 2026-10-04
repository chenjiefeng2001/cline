import { describe, expect, it, vi } from "vitest";
import { withTransientRetry } from "./retry";

/**
 * The CLI had no automatic retry at all while the VS Code extension retried
 * transparently, so the same `ECONNRESET` failed a CLI run outright and was invisible
 * in the IDE. The classification and backoff now live in `@cline/llms`; this wrapper
 * only owns the loop, so these tests cover the loop.
 */
const NO_JITTER_POLICY = {
	maxRetries: 3,
	baseDelayMs: 1,
	maxDelayMs: 1,
	jitterRatio: 0,
};

const transient = () => new Error("read ECONNRESET");
const permanent = () => new Error("401 Unauthorized: invalid api key");
const aborted = () =>
	Object.assign(new Error("aborted"), { name: "AbortError" });

describe("withTransientRetry", () => {
	it("returns the first successful result without sleeping", async () => {
		const operation = vi.fn().mockResolvedValue("ok");
		const sleep = vi.fn().mockResolvedValue(undefined);

		await expect(
			withTransientRetry(operation, { policy: NO_JITTER_POLICY, sleep }),
		).resolves.toBe("ok");
		expect(operation).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("retries a transient failure and then succeeds", async () => {
		const operation = vi
			.fn()
			.mockRejectedValueOnce(transient())
			.mockRejectedValueOnce(transient())
			.mockResolvedValue("recovered");
		const sleep = vi.fn().mockResolvedValue(undefined);
		const onRetry = vi.fn();

		await expect(
			withTransientRetry(operation, {
				policy: NO_JITTER_POLICY,
				sleep,
				onRetry,
			}),
		).resolves.toBe("recovered");
		expect(operation).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(onRetry).toHaveBeenCalledTimes(2);
		expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, maxRetries: 3 });
		expect(onRetry.mock.calls[1]?.[0]).toMatchObject({ attempt: 2, maxRetries: 3 });
	});

	it("gives up after maxRetries and rethrows the last error", async () => {
		const operation = vi.fn().mockRejectedValue(transient());
		const sleep = vi.fn().mockResolvedValue(undefined);

		await expect(
			withTransientRetry(operation, { policy: NO_JITTER_POLICY, sleep }),
		).rejects.toThrow("ECONNRESET");
		// 1 initial attempt + 3 retries.
		expect(operation).toHaveBeenCalledTimes(4);
		expect(sleep).toHaveBeenCalledTimes(3);
	});

	it("does not retry a permanent failure", async () => {
		const operation = vi.fn().mockRejectedValue(permanent());
		const sleep = vi.fn().mockResolvedValue(undefined);

		await expect(
			withTransientRetry(operation, { policy: NO_JITTER_POLICY, sleep }),
		).rejects.toThrow("401");
		expect(operation).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("never retries an abort, so Ctrl-C is not raced by a queued retry", async () => {
		const operation = vi.fn().mockRejectedValue(aborted());
		const sleep = vi.fn().mockResolvedValue(undefined);

		await expect(
			withTransientRetry(operation, { policy: NO_JITTER_POLICY, sleep }),
		).rejects.toThrow("aborted");
		expect(operation).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("passes the attempt number to the operation", async () => {
		const seen: number[] = [];
		const operation = vi.fn(async (attempt: number) => {
			seen.push(attempt);
			if (attempt < 2) throw transient();
			return "ok";
		});

		await expect(
			withTransientRetry(operation, {
				policy: NO_JITTER_POLICY,
				sleep: vi.fn().mockResolvedValue(undefined),
			}),
		).resolves.toBe("ok");
		expect(seen).toEqual([0, 1, 2]);
	});

	it("stops retrying once the signal is aborted mid-flight", async () => {
		// The ACP path owns an AbortController: a transient error that arrives
		// after the user pressed cancel must not be retried, or the session sits
		// through a backoff for a turn that is already abandoned.
		const controller = new AbortController();
		const operation = vi.fn(async () => {
			controller.abort();
			throw transient();
		});
		const sleep = vi.fn().mockResolvedValue(undefined);

		await expect(
			withTransientRetry(operation, {
				policy: NO_JITTER_POLICY,
				sleep,
				signal: controller.signal,
			}),
		).rejects.toThrow("ECONNRESET");
		expect(operation).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});
});
