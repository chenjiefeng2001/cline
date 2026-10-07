import { describe, expect, it, vi } from "vitest"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"

const mocks = vi.hoisted(() => ({
	buildSessionConfig: vi.fn(),
	buildAgentHooks: vi.fn(() => ({})),
	getDiagnostics: vi.fn(),
}))

vi.mock("./cline-session-factory", () => ({
	buildSessionConfig: mocks.buildSessionConfig,
}))

vi.mock("./hooks-adapter", () => ({
	buildAgentHooks: mocks.buildAgentHooks,
}))

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: {
		workspace: {
			getDiagnostics: mocks.getDiagnostics,
			// The real formatter resolves cwd to make paths relative; without this the
			// happy-path test fails on a stub, not on the behaviour under test.
			getWorkspacePaths: () => ({ paths: ["/workspace"] }),
		},
	},
}))

vi.mock("@/integrations/diagnostics", async () => {
	const actual = await vi.importActual<typeof import("@/integrations/diagnostics")>("@/integrations/diagnostics")
	return actual
})

import { DiagnosticSeverity } from "@/shared/proto/index.cline"

describe("SdkSessionConfigBuilder", () => {
	it("adds the CLI plan-mode switch_to_act_mode tool only in plan mode", async () => {
		const stateManager = {
			getGlobalSettingsKey: vi.fn(() => "plan"),
		}
		const onSwitchToActMode = vi.fn()
		const builder = new SdkSessionConfigBuilder({
			stateManager: stateManager as never,
			emitHookMessage: vi.fn(),
			onSwitchToActMode,
		})

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [],
			hooks: {},
		})
		const planConfig = await builder.build({ cwd: "/workspace", mode: "plan" })
		const switchTool = planConfig.extraTools?.find((tool) => tool.name === "switch_to_act_mode")
		expect(switchTool).toBeDefined()
		// Ends the run cleanly after the tool result so the loop never starts an
		// iteration that the stop hook would abort (which surfaced in the webview
		// as "API Request Cancelled").
		expect(switchTool?.lifecycle?.completesRun).toBe(true)
		expect(await switchTool?.execute({}, {} as never)).toBe(
			"You successfully switched to act mode, proceed with the plan. You now have access to editing files and running commands. (The switch_to_act_mode tool is only available in plan mode.)",
		)
		expect(onSwitchToActMode).toHaveBeenCalledOnce()

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [switchTool],
			hooks: {},
		})
		const actConfig = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(actConfig.extraTools?.some((tool) => tool.name === "switch_to_act_mode")).toBe(false)
	})

	it("stops before the next model call after switch_to_act_mode queues a mode change", async () => {
		const baseBeforeModel = vi.fn(async () => ({ metadata: "base" }))
		mocks.buildAgentHooks.mockReturnValueOnce({ beforeModel: baseBeforeModel })
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })

		const builder = new SdkSessionConfigBuilder({
			stateManager: {} as never,
			emitHookMessage: vi.fn(),
			onSwitchToActMode: vi.fn(),
			shouldStopAfterModeSwitch: () => true,
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })

		await expect(config.hooks?.beforeModel?.({} as never)).resolves.toEqual({
			metadata: "base",
			stop: true,
		})
		expect(baseBeforeModel).toHaveBeenCalledOnce()
	})

	it("passes the mistake-limit callback into the SDK config without overriding SDK execution defaults", async () => {
		const onConsecutiveMistakeLimitReached = vi.fn()
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, execution: { maxRetries: 1 } })

		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: vi.fn(() => 3) } as never,
			emitHookMessage: vi.fn(),
			onSwitchToActMode: vi.fn(),
			onConsecutiveMistakeLimitReached,
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })

		expect(config.execution).toEqual({ maxRetries: 1 })
		expect(config.onConsecutiveMistakeLimitReached).toBe(onConsecutiveMistakeLimitReached)
	})
})

/**
 * The diagnostics bridge, proto and formatter already existed for the
 * `@workspace:problems` mention. These pin that the model can now reach the same
 * capability, and that its degradation path is honest rather than reassuring.
 */
describe("get_diagnostics tool", () => {
	const fileDiagnostics = [
		{
			filePath: "/workspace/src/app.ts",
			diagnostics: [
				{
					message: "Type 'string' is not assignable to type 'number'.",
					range: { start: { line: 9, character: 2 }, end: { line: 9, character: 8 } },
					severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
					source: "ts",
				},
			],
		},
	]

	async function buildTool() {
		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: vi.fn(() => "act") } as never,
			emitHookMessage: vi.fn(),
			onSwitchToActMode: vi.fn(),
		})
		mocks.buildSessionConfig.mockResolvedValueOnce({ extraTools: [], hooks: {} })
		const config = await builder.build({ cwd: "/workspace", mode: "act" })
		const tool = config.extraTools?.find((t) => t.name === "get_diagnostics")
		if (!tool) {
			throw new Error("expected a get_diagnostics tool")
		}
		return tool
	}

	it("is contributed in act mode, not only plan mode", async () => {
		const tool = await buildTool()
		expect(tool).toBeDefined()
	})

	it("reports errors the language server found", async () => {
		mocks.getDiagnostics.mockResolvedValueOnce({ fileDiagnostics })
		const tool = await buildTool()
		const out = await tool.execute({}, {} as never)
		expect(String(out)).toContain("not assignable")
		expect(String(out)).toContain("src/app.ts")
	})

	it("does not claim the code is clean when no diagnostics exist", async () => {
		// An empty result is indistinguishable from "no language server", so
		// reporting "no errors" would assert something nothing supports.
		mocks.getDiagnostics.mockResolvedValueOnce({ fileDiagnostics: [] })
		const tool = await buildTool()
		const out = String(await tool.execute({}, {} as never))
		expect(out).not.toMatch(/no errors/i)
		expect(out).toMatch(/cannot tell the two apart/i)
	})

	it("survives a response with no fileDiagnostics field", async () => {
		mocks.getDiagnostics.mockResolvedValueOnce({})
		const tool = await buildTool()
		await expect(tool.execute({}, {} as never)).resolves.toBeTruthy()
	})

	it("filters to errors when asked", async () => {
		mocks.getDiagnostics.mockResolvedValueOnce({
			fileDiagnostics: [
				{
					filePath: "/workspace/src/w.ts",
					diagnostics: [
						{
							message: "a warning only",
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							severity: DiagnosticSeverity.DIAGNOSTIC_WARNING,
							source: "ts",
						},
					],
				},
			],
		})
		const tool = await buildTool()
		const out = String(await tool.execute({ severity: "error" }, {} as never))
		expect(out).not.toContain("a warning only")
		expect(out).toMatch(/no errors found/i)
	})

	it("says the tool cannot tell when every diagnostic is below the requested severity", async () => {
		mocks.getDiagnostics.mockResolvedValueOnce({
			fileDiagnostics: [
				{
					filePath: "/workspace/src/i.ts",
					diagnostics: [
						{
							message: "just a hint",
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							severity: DiagnosticSeverity.DIAGNOSTIC_INFORMATION,
							source: "ts",
						},
					],
				},
			],
		})
		const tool = await buildTool()
		const out = String(await tool.execute({}, {} as never))
		expect(out).toMatch(/no errors or warnings found/i)
		expect(out).toContain("1 file")
	})
})
