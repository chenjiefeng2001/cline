import { Empty, StringRequest } from "@shared/proto/cline/common"
import { Logger } from "@shared/services/Logger"
import * as vscode from "vscode"

/**
 * # LogOutputChannel: Cline
 *
 * VS Code >= 1.73 supports `{ log: true }` which creates a `LogOutputChannel`.
 * This gives us structured log levels (info, warn, error, debug, trace) and
 * file-backed log persistence in the VS Code Output panel.
 *
 * The channel is also passed to `Logger.setOutputChannel()` so the shared
 * Logger class routes all output through it with proper level mapping.
 *
 * ## Fallback
 *
 * If `createOutputChannel("Cline", { log: true })` fails (e.g. VS Code < 1.73,
 * or test environments), we fall back to a plain `OutputChannel` created
 * WITHOUT the `{ log: true }` option. The Logger class's `setOutputChannel`
 * accepts a partial interface, so the fallback is transparent.
 *
 * The `catch` only swallows `TypeError` (the normal symptom of the options
 * argument being rejected). Other errors are still thrown.
 */
let CLINE_OUTPUT_CHANNEL: vscode.LogOutputChannel | vscode.OutputChannel
try {
	CLINE_OUTPUT_CHANNEL = vscode.window.createOutputChannel("Cline", { log: true })
} catch {
	// Fallback for VS Code < 1.73 or test environments
	CLINE_OUTPUT_CHANNEL = vscode.window.createOutputChannel("Cline")
}

// Appends a log message to all Cline output channels.
export async function debugLog(request: StringRequest): Promise<Empty> {
	CLINE_OUTPUT_CHANNEL.appendLine(request.value)
	return Empty.create({})
}

/**
 * Register the Cline LogOutputChannel within the VSCode extension context.
 *
 * Also wires the channel into `Logger.setOutputChannel()` so all `Logger.*`
 * calls are routed through this channel with proper level mapping.
 *
 * The channel's `dispose()` is registered with `context.subscriptions`,
 * which is called on extension deactivation, ensuring the output channel
 * is cleaned up even if `Logger.setOutputChannel(null)` was not called.
 */
export function registerClineOutputChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
	context.subscriptions.push(CLINE_OUTPUT_CHANNEL)

	// Only wire LogOutputChannel (with trace/debug/info/warn/error) into Logger.
	// The fallback plain OutputChannel is used only for debugLog() appendLine.
	if ("info" in CLINE_OUTPUT_CHANNEL) {
		Logger.setOutputChannel(CLINE_OUTPUT_CHANNEL as any)

		// Ensure Logger's reference is cleared when the channel is disposed
		context.subscriptions.push({
			dispose: () => Logger.setOutputChannel(null),
		})
	}

	return CLINE_OUTPUT_CHANNEL as vscode.OutputChannel
}
