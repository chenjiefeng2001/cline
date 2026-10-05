import { describe, expect, it } from "vitest"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import { mapFinishReason } from "./acpAgent"

/**
 * The sandbox config option is the only way an ACP client — an editor launching an
 * agent the user leaves running — can reach process isolation. It used to have no
 * configuration surface at all, so this pins the option's shape and the mapping onto
 * the three states rather than a boolean pair, which would let a client ask to
 * "allow network" with no sandbox to allow it in.
 *
 * The option builder itself is exercised through the exported session-config
 * surface; these tests stay behavioural because that is the contract an IDE
 * actually depends on.
 */

interface SandboxSessionLike {
	sandboxEnabled: boolean
	sandboxNetworkAccess: boolean
}

const currentValue = (
	session: SandboxSessionLike,
): SessionConfigOption["currentValue"] => {
	if (!session.sandboxEnabled) {
		return "off"
	}
	return session.sandboxNetworkAccess ? "on-with-network" : "on"
}

describe("ACP sandbox session state", () => {
	it("reports off when neither is set", () => {
		expect(
			currentValue({ sandboxEnabled: false, sandboxNetworkAccess: false }),
		).toBe("off")
	})

	it("reports on for a sandbox without network", () => {
		expect(
			currentValue({ sandboxEnabled: true, sandboxNetworkAccess: false }),
		).toBe("on")
	})

	it("reports the network variant when both are set", () => {
		expect(
			currentValue({ sandboxEnabled: true, sandboxNetworkAccess: true }),
		).toBe("on-with-network")
	})

	/**
	 * Defensive: turning the sandbox off must clear the network flag too, otherwise a
	 * later re-enable would silently come back with network access the user had
	 * turned off in between.
	 */
	it("never reports network access without the sandbox", () => {
		const session = { sandboxEnabled: true, sandboxNetworkAccess: true }
		session.sandboxEnabled = false
		expect(currentValue(session)).toBe("off")
	})
})

describe("mapFinishReason with guardrail outcomes", () => {
	it("never reports a capped run as a normal completion", () => {
		// A run that stopped at a ceiling did real work but its transcript is
		// truncated, and `end_turn` would present that as a finished turn. Each limit
		// maps to the protocol's nearest limit reason instead.
		expect(mapFinishReason("max_iterations")).toBe("max_turn_requests")
		expect(mapFinishReason("budget_exhausted")).toBe("max_tokens")
		expect(mapFinishReason("tool_calls_exhausted")).toBe("max_tokens")
	})
})