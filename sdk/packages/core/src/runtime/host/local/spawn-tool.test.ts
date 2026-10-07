import { describe, expect, it, vi } from "vitest"
import type { CoreSessionConfig } from "../../../types/config"
import type { SpawnToolDeps } from "./spawn-tool"
import { createSessionSpawnTool, isSubAgentDepthAllowed } from "./spawn-tool"

function createDeps(): SpawnToolDeps {
	return {
		getSession: vi.fn().mockReturnValue(undefined),
		subAgentStarts: new Map(),
		onAgentEvent: vi.fn(),
		invokeBackendOptional: vi.fn().mockResolvedValue(undefined),
	}
}

function features(overrides: Partial<CoreSessionConfig> = {}) {
	return {
		enableSpawnAgent: true,
		...overrides,
	} as Pick<CoreSessionConfig, "enableSpawnAgent" | "maxSubAgentDepth">
}

describe("isSubAgentDepthAllowed", () => {
	it("lets the root delegate and stops the delegate by default", () => {
		// The chain was previously unbounded: a sub-agent's tool set re-included
		// `spawn_agent`, so any depth could form. Codex defaults max_depth to 1 for
		// the same reason — deep recursion plus broad delegation instructions turn
		// into fan-out.
		const config = features()
		expect(config.maxSubAgentDepth).toBeUndefined()
		expect(isSubAgentDepthAllowed(config, 0)).toBe(true)
		expect(isSubAgentDepthAllowed(config, 1)).toBe(false)
		expect(isSubAgentDepthAllowed(config, 5)).toBe(false)
	})

	it("refuses everything when spawning is disabled", () => {
		const config = features({ enableSpawnAgent: false })
		expect(isSubAgentDepthAllowed(config, 0)).toBe(false)
	})

	it("honours a deeper limit when asked", () => {
		const config = features({ maxSubAgentDepth: 3 })
		expect(isSubAgentDepthAllowed(config, 2)).toBe(true)
		expect(isSubAgentDepthAllowed(config, 3)).toBe(false)
	})

	it("treats zero as no delegation at all", () => {
		const config = features({ maxSubAgentDepth: 0 })
		expect(isSubAgentDepthAllowed(config, 0)).toBe(false)
	})

	it("normalises a negative limit to zero rather than allowing all depths", () => {
		// A negative depth allowance must not read as "unbounded" — that would
		// reintroduce the original bug through a config typo.
		const config = features({ maxSubAgentDepth: -5 })
		expect(isSubAgentDepthAllowed(config, 0)).toBe(false)
		expect(isSubAgentDepthAllowed(config, 3)).toBe(false)
	})

	it("terminates within a bounded number of levels for any limit", () => {
		for (const maxSubAgentDepth of [0, 1, 3, 10]) {
			const config = features({ maxSubAgentDepth })
			let reached = 0
			while (isSubAgentDepthAllowed(config, reached)) {
				reached += 1
				expect(reached).toBeLessThanOrEqual(maxSubAgentDepth + 1)
			}
			expect(reached).toBe(maxSubAgentDepth)
		}
	})
})

describe("createSessionSpawnTool", () => {
	it("still exposes spawn_agent to the root session", () => {
		const tool = createSessionSpawnTool(
			createDeps(),
			{
				providerId: "cline",
				modelId: "test-model",
				cwd: "/workspace",
				mode: "act",
				enableTools: false,
				enableSpawnAgent: true,
				enableAgentTeams: false,
			} as CoreSessionConfig,
			"root",
		)
		expect(tool.name).toBe("spawn_agent")
		expect(tool.description).toBeTruthy()
	})
})
