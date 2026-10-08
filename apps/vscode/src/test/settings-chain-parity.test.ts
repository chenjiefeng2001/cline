import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The VS Code settings chain is four hand-maintained copies of the same fact:
 *
 *   1. `state-keys.ts`            — the global-state key and its default
 *   2. `package.json`             — the `cline.*` setting the user can change
 *   3. `vscode-settings-bridge.ts`— the setting -> state-key mapping
 *   4. `ExtensionStateContext.tsx`— the webview's default value
 *
 * plus, separately, `cline-session-factory.ts` reading the key into the session
 * config. Nothing in the toolchain connects them: a key added to `state-keys.ts`
 * and never bridged compiles, ships, and is simply not configurable from the
 * settings UI -- the exact failure that made the OS sandbox unreachable from this
 * host before it was mapped.
 *
 * Scope is deliberately the *runtime guardrails* -- the settings that reach
 * `CoreSessionConfig` and actually bound a run. It is not "every key in
 * `state-keys.ts`": that file holds 227 global-state keys of which 38 are
 * user-facing settings, so a blanket parity rule would be asserting something
 * untrue. Model and provider configuration is likewise out of scope, being
 * written through its own RPCs.
 */

/**
 * Settings that must reach the runtime as a guardrail, paired with the
 * `cline.*` setting key when it differs from the state key.
 *
 * The pairing is written out rather than assumed equal because several are
 * legitimately named differently -- `cline.maxIterations` writes
 * `maxIterationsSetting`, for instance. An identity assumption would either miss
 * that or report it as drift.
 */
const RUNTIME_GUARDRAILS: ReadonlyArray<readonly [stateKey: string, settingsKey: string]> = [
	["maxIterationsSetting", "maxIterations"],
	["maxParallelToolCalls", "maxParallelToolCalls"],
	["maxToolCalls", "maxToolCalls"],
	["maxSubAgentDepth", "maxSubAgentDepth"],
	["runBudgetMaxTotalCost", "runBudgetMaxTotalCost"],
	["fileBoundaryEnabled", "fileBoundaryEnabled"],
	["fileBoundaryAdditionalRoots", "fileBoundaryAdditionalRoots"],
	["sandboxEnabled", "sandboxEnabled"],
	["sandboxNetworkAccess", "sandboxNetworkAccess"],
	["sandboxBackend", "sandboxBackend"],
	["agentTeamsEnabled", "agentTeamsEnabled"],
	["lazyToolLoading", "lazyToolLoading"],
]

/** Repo-root-relative reader, so a path mistake fails loudly rather than silently. */
function read(relative: string): string {
	return readFileSync(join(__dirname, "..", "..", "..", "..", relative), "utf8")
}

const stateKeys = read("apps/vscode/src/shared/storage/state-keys.ts")
const packageJson = read("apps/vscode/package.json")
const settingsBridge = read("apps/vscode/src/hosts/vscode/vscode-settings-bridge.ts")
const extensionStateContext = read("apps/vscode/webview-ui/src/context/ExtensionStateContext.tsx")
const sessionFactory = read("apps/vscode/src/sdk/cline-session-factory.ts")

describe("VS Code settings chain", () => {
	it("declares every runtime guardrail as a global-state key", () => {
		for (const [stateKey] of RUNTIME_GUARDRAILS) {
			expect(stateKeys).toContain(`${stateKey}: { default:`)
		}
	})

	it("exposes every runtime guardrail as a cline.* setting", () => {
		for (const [, settingsKey] of RUNTIME_GUARDRAILS) {
			expect(packageJson).toContain(`"cline.${settingsKey}"`)
		}
	})

	it("bridges every runtime guardrail to its state key", () => {
		// The gap this exists for: a setting the user can see and change, with no
		// mapping, so changing it does nothing.
		for (const [stateKey, settingsKey] of RUNTIME_GUARDRAILS) {
			expect(settingsBridge).toMatch(new RegExp(`^\\t${settingsKey}: "${stateKey}",?$`, "m"))
		}
	})

	it("gives every runtime guardrail a webview default", () => {
		for (const [stateKey] of RUNTIME_GUARDRAILS) {
			expect(extensionStateContext).toContain(`${stateKey}:`)
		}
	})

	it("reads every runtime guardrail into the session config", () => {
		// Without this the four copies are a well-kept record of a setting that
		// still does not bound anything.
		for (const [stateKey] of RUNTIME_GUARDRAILS) {
			expect(sessionFactory).toContain(`getGlobalSettingsKey("${stateKey}")`)
		}
	})
})
