import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { describe, expect, it } from "vitest"
import { buildToolPolicies, isToolAutoApproved } from "./sdk-tool-policies"

describe("isToolAutoApproved", () => {
	it("does not auto-approve command tools by default", () => {
		expect(isToolAutoApproved("run_commands", DEFAULT_AUTO_APPROVAL_SETTINGS)).toBe(false)
	})

	it("uses executeSafeCommands as the single command approval flag", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
				executeSafeCommands: false,
				executeAllCommands: true,
			},
		}

		expect(isToolAutoApproved("run_commands", settings)).toBe(false)
	})
})

describe("glob approval routing", () => {
	it("is routed through the approval callback rather than silently allowed", () => {
		// The SDK auto-approves tools absent from the policy map. glob reads the
		// filesystem, so leaving it out would let it run even with the
		// readFiles auto-approval toggle switched off.
		const policies = buildToolPolicies(DEFAULT_AUTO_APPROVAL_SETTINGS)

		expect(policies.glob).toEqual({ autoApprove: false })
	})

	it("follows the readFiles toggle", () => {
		const off = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, readFiles: false },
		}
		const on = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, readFiles: true },
		}

		expect(isToolAutoApproved("glob", off)).toBe(false)
		expect(isToolAutoApproved("glob", on)).toBe(true)
	})
})

describe("MCP resource tool approval routing", () => {
	it("routes the catalogue tools through the approval callback", () => {
		const policies = buildToolPolicies(DEFAULT_AUTO_APPROVAL_SETTINGS)

		expect(policies.list_mcp_resources).toEqual({ autoApprove: false })
		expect(policies.read_mcp_resource).toEqual({ autoApprove: false })
		expect(policies.list_mcp_prompts).toEqual({ autoApprove: false })
	})

	it("follows the MCP toggle", () => {
		const off = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: false },
		}
		const on = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: true },
		}

		expect(isToolAutoApproved("read_mcp_resource", off)).toBe(false)
		expect(isToolAutoApproved("read_mcp_resource", on)).toBe(true)
	})
})
