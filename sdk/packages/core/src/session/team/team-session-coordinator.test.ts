import type { AgentFinishReason } from "@cline/shared";
import { describe, expect, it } from "vitest";
import type { ActiveSession } from "../../types/session";
import { shouldAutoContinueTeamRuns } from "./team-session-coordinator";

function session(overrides: Partial<ActiveSession> = {}): ActiveSession {
	return {
		aborting: false,
		config: { enableAgentTeams: true },
		activeTeamRunIds: new Set(["team-run-1"]),
		pendingTeamRunUpdates: [],
		...overrides,
	} as unknown as ActiveSession;
}

describe("shouldAutoContinueTeamRuns", () => {
	it("continues completed and iteration-capped runs that still have team work", () => {
		for (const finishReason of ["completed", "max_iterations"] as const) {
			expect(shouldAutoContinueTeamRuns(session(), finishReason)).toBe(true);
		}
	});

	it("does not continue a run that stopped because its budget was exhausted", () => {
		// Continuing here would issue exactly the model call the budget refused
		// to pay for.
		expect(shouldAutoContinueTeamRuns(session(), "budget_exhausted")).toBe(
			false,
		);
	});

	it("does not continue aborted, failed, or mistake-limited runs", () => {
		for (const finishReason of [
			"aborted",
			"error",
			"mistake_limit",
		] as AgentFinishReason[]) {
			expect(shouldAutoContinueTeamRuns(session(), finishReason)).toBe(false);
		}
	});

	it("does not continue when there is no pending team work", () => {
		expect(
			shouldAutoContinueTeamRuns(
				session({ activeTeamRunIds: new Set(), pendingTeamRunUpdates: [] }),
				"completed",
			),
		).toBe(false);
	});

	it("does not continue while the session is aborting", () => {
		expect(
			shouldAutoContinueTeamRuns(session({ aborting: true }), "completed"),
		).toBe(false);
	});
});
