import type { CoreSessionConfig } from "@cline/core"
import { type AgentTool, createTool } from "@cline/shared"
import type { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { diagnosticsToProblemsString } from "@/integrations/diagnostics"
import { DiagnosticSeverity } from "@/shared/proto/index.cline"
import { buildSessionConfig, type SessionConfigInput } from "./cline-session-factory"
import { buildAgentHooks, type HookMessageEmitter } from "./hooks-adapter"

export interface SdkSessionConfigBuilderOptions {
	stateManager: StateManager
	emitHookMessage: HookMessageEmitter
	onSwitchToActMode: () => void
	shouldStopAfterModeSwitch?: () => boolean
	onConsecutiveMistakeLimitReached?: CoreSessionConfig["onConsecutiveMistakeLimitReached"]
}

export class SdkSessionConfigBuilder {
	constructor(private readonly options: SdkSessionConfigBuilderOptions) {}

	async build(input: SessionConfigInput): Promise<Awaited<ReturnType<typeof buildSessionConfig>>> {
		const config = await buildSessionConfig(input)
		if (this.options.onConsecutiveMistakeLimitReached) {
			config.onConsecutiveMistakeLimitReached = this.options.onConsecutiveMistakeLimitReached
		}

		const baseHooks = buildAgentHooks(this.options.stateManager, this.options.emitHookMessage)
		config.hooks = {
			...baseHooks,
			beforeModel: async (ctx) => {
				const baseControl = await baseHooks.beforeModel?.(ctx)
				if (this.options.shouldStopAfterModeSwitch?.()) {
					return {
						...baseControl,
						stop: true,
					}
				}
				return baseControl
			},
		}
		if (input.mode === "plan") {
			// Match the CLI interactive runtime: plan-mode sessions expose a
			// switch_to_act_mode tool in addition to the read-only planning tools.
			config.extraTools = [...(config.extraTools ?? []), this.createSwitchToActModeTool()]
		} else {
			// The switch tool is plan-only in the CLI and should disappear after
			// rebuilding the session in act mode.
			config.extraTools = config.extraTools?.filter((tool) => tool.name !== "switch_to_act_mode")
		}

		// Available in both modes: a planning pass is exactly when you want to know
		// the editor already sees errors, before planning a change.
		config.extraTools = [...(config.extraTools ?? []), createGetDiagnosticsTool()]

		return config
	}

	private createSwitchToActModeTool(): AgentTool {
		return createTool({
			name: "switch_to_act_mode",
			description:
				"Switch from plan mode to act mode. Switching to act mode immediately starts executing the plan, so only call this after the user has explicitly approved the plan in a message sent AFTER you presented it (e.g. 'looks good', 'go ahead', 'switch to act mode'). " +
				"Never call this in the same turn you present a plan, never call it proactively, and never treat the original task request as approval.",
			inputSchema: {
				type: "object",
				properties: {},
			},
			timeoutMs: 5000,
			retryable: false,
			maxRetries: 0,
			// End the run cleanly right after the tool result instead of letting the
			// loop start another iteration that the beforeModel stop hook would abort.
			// An aborted run leaves a dangling api_req_started spinner behind, which the
			// webview renders as "API Request Cancelled".
			lifecycle: {
				completesRun: true,
			},
			execute: async () => {
				const currentMode = this.options.stateManager.getGlobalSettingsKey("mode")
				if (currentMode === "act") {
					return "Already in act mode."
				}
				this.options.onSwitchToActMode()
				return "You successfully switched to act mode, proceed with the plan. You now have access to editing files and running commands. (The switch_to_act_mode tool is only available in plan mode.)"
			},
		})
	}
}

/**
 * Exposes the editor's language-server diagnostics to the model.
 *
 * The bridge, proto and formatter already existed for the `@workspace:problems`
 * mention, so this capability was fully built and reachable only by a user typing
 * a mention -- the inverse of a dead setting: working, but not available to the
 * agent. Contributing it here rather than in core is the correct layer, since
 * only an editor host has a language server; a core tool would be empty
 * everywhere else.
 */
function createGetDiagnosticsTool(): AgentTool {
	return createTool({
		name: "get_diagnostics",
		description:
			"Report errors and warnings that the editor's language servers currently report for workspace files. " +
			"Use this after editing code to confirm a change type-checks, or to find pre-existing problems before starting work. " +
			"Only covers files a language server is active for.",
		inputSchema: {
			type: "object",
			properties: {
				severity: {
					type: "string",
					enum: ["error", "warning"],
					description: "Lowest severity to include. Defaults to warnings, i.e. both.",
				},
			},
		},
		timeoutMs: 10000,
		retryable: false,
		execute: async (input: unknown) => {
			const requested = (input as { severity?: unknown } | undefined)?.severity
			const severities =
				requested === "error"
					? [DiagnosticSeverity.DIAGNOSTIC_ERROR]
					: [DiagnosticSeverity.DIAGNOSTIC_ERROR, DiagnosticSeverity.DIAGNOSTIC_WARNING]

			const response = await HostProvider.workspace.getDiagnostics({})
			const fileDiagnostics = response.fileDiagnostics ?? []

			if (fileDiagnostics.length === 0) {
				// Deliberately not "no errors found". An empty result is equally what a
				// workspace with no language server looks like, so telling the model the
				// code is clean would be a claim nothing supports.
				return "No diagnostics are available. Either there are no problems, or no language server is running for these files -- this tool cannot tell the two apart."
			}

			const formatted = await diagnosticsToProblemsString(fileDiagnostics, severities)
			if (!formatted.trim()) {
				const label = requested === "error" ? "errors" : "errors or warnings"
				return `No ${label} found in ${fileDiagnostics.length} file(s) that have diagnostics.`
			}
			return formatted
		},
	})
}
