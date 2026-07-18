/**
 * # Diagnostic Report Export
 *
 * One-click generation of a diagnostic report for troubleshooting.
 * Collects environment info, recent errors, sanitized settings, and
 * active configuration state — all in a single Markdown document.
 *
 * ## Usage
 *
 * ```bash
 * # Via VS Code command palette:
 * Cline: Export Diagnostic Report
 * ```
 *
 * Or call programmatically:
 * ```typescript
 * import { exportDiagnosticReport } from '@/services/diagnostics/diagnostic-export'
 * await exportDiagnosticReport(extensionContext)
 * ```
 */

import * as os from "os"
import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"

// ---------------------------------------------------------------------------
// Known sensitive keys that must be masked in the report
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERNS = [
	/api[_-]?key/i,
	/access[_-]?key/i,
	/secret[_-]?key/i,
	/^token$/i,
	/password/i,
	/^secret$/i,
	/client[_-]?secret/i,
	/refresh[_-]?token/i,
]

function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

/**
 * Recursively sanitize an object by masking sensitive field values.
 * String values matching sensitive keys are truncated to `prefixLen + "****" + suffixLen`.
 */
function sanitizeValue(key: string, value: unknown): unknown {
	if (typeof value === "string" && isSensitiveKey(key)) {
		const v = value as string
		if (v.length <= 8) return "****"
		return v.slice(0, 4) + "****" + v.slice(-4)
	}
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const sanitized: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			sanitized[k] = sanitizeValue(k, v)
		}
		return sanitized
	}
	if (Array.isArray(value)) {
		return value.map((item, idx) => sanitizeValue(`${key}[${idx}]`, item))
	}
	return value
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

interface DiagnosticReport {
	generatedAt: string
	environment: Record<string, string>
	extensionInfo: Record<string, string>
	recentErrors: string[]
	settings: Record<string, unknown>
	activeConfig: Record<string, unknown>
	mcpServers: unknown[]
}

async function collectEnvironmentInfo(): Promise<Record<string, string>> {
	return {
		OS: `${os.platform()} ${os.release()} (${os.arch()})`,
		Hostname: os.hostname(),
		CPUs: `${os.cpus().length} cores`,
		Memory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB`,
		Node: process.version,
		Shell: process.env.SHELL ?? process.env.ComSpec ?? "unknown",
	}
}

async function collectExtensionInfo(context: vscode.ExtensionContext): Promise<Record<string, string>> {
	const pkg = context.extension.packageJSON
	return {
		Version: pkg.version ?? "unknown",
		ID: context.extension.id,
		"VS Code": vscode.version,
		UIKind: vscode.env.uiKind === vscode.UIKind.Desktop ? "Desktop" : "Web",
		Remote: vscode.env.remoteName ?? "local",
		Language: vscode.env.language,
	}
}

async function collectRecentErrors(limit = 50): Promise<string[]> {
	// Read from Logger's in-memory ring buffer
	const allLogs = Logger.getRecentLogs()
	// Filter for ERROR, WARN, and fatal-level entries
	const errors = allLogs.filter((entry) => entry.level === "ERROR" || entry.level === "WARN")
	if (errors.length === 0) {
		return [
			"Recent errors are available in the Cline Output Channel:",
			"  View → Output → Select 'Cline' from dropdown",
			"  Or run: Developer: Set Log Level → Error",
			"",
			"Full diagnostic logs (JSONL): ~/.cline/data/logs/",
		]
	}
	return errors.slice(-limit).map((entry) => `[${entry.ts}] [${entry.level}] ${entry.message}`)
}

async function collectSettings(): Promise<Record<string, unknown>> {
	try {
		const stateManager = StateManager.get()
		if (!stateManager) return { error: "StateManager not initialized" }

		// Collect global settings
		const allKeys: string[] = [
			"apiProvider",
			"model",
			"mode",
			"preferredLanguage",
			"autoApprovalEnabled",
			"browserViewportSize",
			"enableCheckpointsSetting",
			"useAutoCondense",
			"maxOpenTabs",
			"isPlanMode",
			"isPlanActEnabled",
			"soundEnabled",
			"soundVolume",
			"writingStyle",
		]

		const settings: Record<string, unknown> = {}
		for (const key of allKeys) {
			try {
				// Use type assertion to bypass strict typed key check — the key may
				// be any valid settings key stored in state, not just the narrow union.
				const value = (stateManager as any).getGlobalSettingsKey(key)
				if (value !== undefined) {
					settings[key] = value
				}
			} catch {
				// skip unavailable keys
			}
		}

		return sanitizeValue("settings", settings) as Record<string, unknown>
	} catch (error) {
		return { error: `Failed to read settings: ${error}` }
	}
}

async function collectActiveConfig(): Promise<Record<string, unknown>> {
	try {
		const stateManager = StateManager.get()
		if (!stateManager) return { error: "StateManager not initialized" }

		const apiProvider = (stateManager as any).getGlobalSettingsKey("apiProvider") ?? "none"
		const actModeProvider = (stateManager as any).getGlobalSettingsKey("actModeApiProvider") ?? apiProvider
		const planModeProvider = (stateManager as any).getGlobalSettingsKey("planModeApiProvider") ?? apiProvider

		return {
			apiProvider,
			actModeProvider,
			planModeProvider,
			mcpServerCount: "check Cline MCP view",
			// telemetry: telemetryService.isOptedIn ? "opted in" : "opted out",
		}
	} catch (error) {
		return { error: `Failed to read active config: ${error}` }
	}
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

async function buildReport(context: vscode.ExtensionContext): Promise<DiagnosticReport> {
	return {
		generatedAt: new Date().toISOString(),
		environment: await collectEnvironmentInfo(),
		extensionInfo: await collectExtensionInfo(context),
		recentErrors: await collectRecentErrors(),
		settings: await collectSettings(),
		activeConfig: await collectActiveConfig(),
		mcpServers: [],
	}
}

function formatReportAsMarkdown(report: DiagnosticReport): string {
	const lines: string[] = [
		"# Cline Diagnostic Report",
		"",
		`**Generated:** ${report.generatedAt}`,
		"",
		"---",
		"",
		"## Environment",
		"",
	]

	for (const [key, value] of Object.entries(report.environment)) {
		lines.push(`| ${key} | ${value} |`)
	}

	lines.push("", "## Extension Info", "")
	for (const [key, value] of Object.entries(report.extensionInfo)) {
		lines.push(`| ${key} | ${value} |`)
	}

	lines.push("", "## Recent Errors", "")
	if (report.recentErrors.length === 0) {
		lines.push("_No recent errors recorded._")
	} else {
		for (const err of report.recentErrors) {
			lines.push(`- ${err}`)
		}
	}

	lines.push("", "## Settings (Sanitized)", "")
	lines.push("```json")
	lines.push(JSON.stringify(report.settings, null, 2))
	lines.push("```")

	lines.push("", "## Active Configuration", "")
	for (const [key, value] of Object.entries(report.activeConfig)) {
		lines.push(`| ${key} | ${value} |`)
	}

	lines.push("", "---", "_Report auto-generated by Cline Diagnostic Export_")

	return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a new VS Code editor tab with the full diagnostic report.
 *
 * @param context - The extension context (used to read package.json version etc.)
 */
export async function exportDiagnosticReport(context: vscode.ExtensionContext): Promise<void> {
	const report = await buildReport(context)
	const markdown = formatReportAsMarkdown(report)

	const doc = await vscode.workspace.openTextDocument({
		content: markdown,
		language: "markdown",
	})
	await vscode.window.showTextDocument(doc)
}

/**
 * Register the `cline.exportDiagnosticReport` VS Code command.
 *
 * Call from extension activation:
 * ```typescript
 * registerDiagnosticCommand(context)
 * ```
 */
export function registerDiagnosticCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("cline.exportDiagnosticReport", () => {
			exportDiagnosticReport(context)
		}),
	)
}