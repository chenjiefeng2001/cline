import { describe, expect, it } from "vitest";
import { mapFinishReason } from "./acpAgent";

/**
 * Guardrail stops are the reason this mapping matters. Before ACP had any
 * budget ceiling it did not matter; now that it shares the CLI's guardrails, a
 * budget-capped run must not be reported to the IDE as a normal completion.
 */
describe("mapFinishReason", () => {
	it("reports a normal completion as end_turn", () => {
		expect(mapFinishReason("completed")).toBe("end_turn");
	});

	it("reports an aborted run as cancelled", () => {
		expect(mapFinishReason("aborted")).toBe("cancelled");
	});

	it("reports the iteration guardrail as a turn-request limit", () => {
		expect(mapFinishReason("max_iterations")).toBe("max_turn_requests");
	});

	it("does not report a budget-capped run as end_turn", () => {
		// The regression this guards: an IDE client would show a spend-capped run
		// as a clean finish, so the user would never learn the ceiling was hit.
		expect(mapFinishReason("budget_exhausted")).not.toBe("end_turn");
		expect(mapFinishReason("budget_exhausted")).toBe("max_tokens");
	});

	it("falls back to end_turn for reasons with no ACP equivalent", () => {
		expect(mapFinishReason("mistake_limit")).toBe("end_turn");
		expect(mapFinishReason("something_new")).toBe("end_turn");
	});
});