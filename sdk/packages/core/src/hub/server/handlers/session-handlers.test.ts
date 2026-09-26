import { describe, expect, it, vi } from "vitest";
import {
	handleSessionRestore,
	readSessionConnectionUpdate,
} from "./session-handlers";

describe("readSessionConnectionUpdate", () => {
	it("enables thinking when a positive budget is supplied without thinking", () => {
		expect(readSessionConnectionUpdate({ thinkingBudgetTokens: 2048 })).toEqual(
			{
				thinking: true,
				thinkingBudgetTokens: 2048,
			},
		);
	});

	it("lets explicit thinking disable override reasoning fields", () => {
		const updates = readSessionConnectionUpdate({
			thinking: false,
			reasoningEffort: "high",
			thinkingBudgetTokens: 2048,
		});

		expect(updates.thinking).toBe(false);
		expect(Object.hasOwn(updates, "reasoningEffort")).toBe(true);
		expect(updates.reasoningEffort).toBeUndefined();
		expect(Object.hasOwn(updates, "thinkingBudgetTokens")).toBe(true);
		expect(updates.thinkingBudgetTokens).toBeUndefined();
	});
});

describe("handleSessionRestore", () => {
	it("delegates restore orchestration to the execution host", async () => {
		const restoreSession = vi.fn().mockResolvedValue({
			checkpoint: { ref: "checkpoint", createdAt: 1, runCount: 1 },
		});
		const startSession = vi.fn();
		const ctx = {
			sessionHost: { restoreSession, startSession },
			requestCapability: vi.fn(),
		} as never;
		const envelope = {
			command: "session.restore",
			requestId: "request-1",
			clientId: "client-1",
			payload: {
				sessionId: "source-session",
				checkpointRunCount: 1,
				restore: { messages: false, workspace: false },
			},
		} as never;

		await handleSessionRestore(ctx, envelope, vi.fn());

		expect(restoreSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "source-session",
				checkpointRunCount: 1,
				start: expect.objectContaining({
					config: expect.objectContaining({ sessionId: expect.any(String) }),
				}),
			}),
		);
		expect(startSession).not.toHaveBeenCalled();
	});
});
