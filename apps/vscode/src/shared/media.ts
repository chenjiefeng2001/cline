/**
 * # Media Offload for Base64 Data
 *
 * ## Why
 *
 * Base64-encoded images (e.g. browser screenshots) can be hundreds of KB each.
 * When these are embedded in `ClineMessage` bodies, every `postStateToWebview()`
 * serializes and ships them over the gRPC bridge, bloating IPC payloads and
 * causing UI jank.
 *
 * ## Solution
 *
 * Offload Base64 data to the local filesystem at write time and serve them via
 * VS Code's `webview.asWebviewUri()`. Messages carry a lightweight file://
 * reference instead of the raw data.
 *
 * ## Cleanup
 *
 * Offloaded files older than `MEDIA_TTL_MS` (24 hours) are purged lazily on
 * the next offload call. This avoids unbounded disk growth without adding a
 * background sweep timer.
 */

import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"

const MEDIA_DIR = "media"
const MEDIA_TTL_MS = 24 * 60 * 60 * 1_000 // 24 hours

/**
 * Get the media cache directory, creating it if necessary.
 */
function getMediaDir(): string {
	const dataDir = process.env.CLINE_DIR || path.join(require("os").homedir(), ".cline")
	const mediaDir = path.join(dataDir, "data", MEDIA_DIR)
	if (!fs.existsSync(mediaDir)) {
		fs.mkdirSync(mediaDir, { recursive: true })
	}
	return mediaDir
}

/**
 * Purge offloaded files that are older than MEDIA_TTL_MS.
 * Called lazily on each `offloadBase64()`.
 */
function purgeStaleFiles(mediaDir: string): void {
	try {
		const now = Date.now()
		for (const entry of fs.readdirSync(mediaDir)) {
			const filePath = path.join(mediaDir, entry)
			try {
				const stat = fs.statSync(filePath)
				if (now - stat.mtimeMs > MEDIA_TTL_MS) {
					fs.unlinkSync(filePath)
				}
			} catch {
				// ignore individual file errors
			}
		}
	} catch {
		// ignore directory read errors
	}
}

/**
 * Generate a unique, hashed filename for a Base64 data URI.
 */
function hashData(data: string): string {
	let hash = 0
	for (let i = 0; i < data.length; i++) {
		const chr = data.charCodeAt(i)
		hash = (hash << 5) - hash + chr
		hash |= 0
	}
	return Math.abs(hash).toString(36)
}

/**
 * Extract the file extension from a Base64 data URI prefix.
 */
function extensionFromMime(mime: string): string {
	switch (mime) {
		case "image/png":
			return "png"
		case "image/webp":
			return "webp"
		case "image/jpeg":
		case "image/jpg":
			return "jpg"
		case "image/gif":
			return "gif"
		case "image/svg+xml":
			return "svg"
		default:
			return "bin"
	}
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Offload a Base64 data URI to a local temp file and return a `vscode-webview-resource://`
 * URI that the webview can load.
 */
export function offloadBase64(dataUri: string, webview?: vscode.Webview): string {
	if (!dataUri.startsWith("data:")) return dataUri

	try {
		const mediaDir = getMediaDir()
		purgeStaleFiles(mediaDir)

		const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/)
		if (!matches) return dataUri

		const mime = matches[1]
		const base64Data = matches[2]
		const ext = extensionFromMime(mime)
		const filename = `img_${hashData(base64Data)}.${ext}`
		const filePath = path.join(mediaDir, filename)

		if (!fs.existsSync(filePath)) {
			fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"))
		}

		if (webview) {
			return webview.asWebviewUri(vscode.Uri.file(filePath)).toString()
		}
		return `file://${filePath}`
	} catch {
		return dataUri
	}
}

/**
 * Offload a screenshot result object in-place.
 */
export function offloadScreenshot(result: { screenshot?: string }, webview?: vscode.Webview): void {
	if (result.screenshot && result.screenshot.startsWith("data:image")) {
		result.screenshot = offloadBase64(result.screenshot, webview)
	}
}