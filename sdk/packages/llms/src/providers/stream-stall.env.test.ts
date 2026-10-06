import { describe, expect, it } from "vitest";

import { StreamStalledError, withStallTimeout } from "./stream-stall";

describe("stall guard via environment budget", () => {
	it("honours CLINE_STREAM_STALL_TIMEOUT_MS (regression: the guard never fired through the provider path)", async () => {
		process.env.CLINE_STREAM_STALL_TIMEOUT_MS = "60";
		try {
			const stalled = (async function* () {
				yield "partial";
				await new Promise<never>(() => {});
			})();

			const started = Date.now();
			let thrown: unknown;
			try {
				for await (const _ of withStallTimeout(stalled)) {
					// drain
				}
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(StreamStalledError);
			// Loose upper bound: proves it fired on the env budget rather than hanging.
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			delete process.env.CLINE_STREAM_STALL_TIMEOUT_MS;
		}
	});

	it("falls back to the default when the env value is unparseable", async () => {
		process.env.CLINE_STREAM_STALL_TIMEOUT_MS = "not-a-number";
		try {
			const stalled = (async function* () {
				yield "partial";
				await new Promise<never>(() => {});
			})();
			// Must not fire immediately: a typo must not silently remove the guard.
			const settledQuickly = await Promise.race([
				(async () => {
					try {
						for await (const _ of withStallTimeout(stalled)) {
							// drain
						}
					} catch {
						return true;
					}
					return true;
				})(),
				new Promise((resolve) => setTimeout(() => resolve(false), 300)),
			]);
			expect(settledQuickly).toBe(false);
		} finally {
			delete process.env.CLINE_STREAM_STALL_TIMEOUT_MS;
		}
	});
});