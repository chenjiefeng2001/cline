import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * These guard the webview's failure reporting. A blank Cline panel previously left
 * no durable trace at all: VS Code discards the webview console, the extension log
 * ended at "Webview view resolved", and the webview never posted webview_ready, so
 * there was nothing to tell a maintainer or a user what had happened.
 *
 * The HTML guard is the only code that runs when the bundle itself fails, which is
 * why it has to live in the template rather than in application code: an import
 * that throws during evaluation never reaches main.tsx.
 *
 * Asserted against the raw template text rather than a rendered document, because
 * the failure mode is "the script never ran" and a test that evaluates the script
 * could not reproduce it.
 */
const HTML = readFileSync(join(import.meta.dir, "WebviewProvider.ts"), "utf-8")

function htmlTemplate(): string {
	// The literal returned by getHtmlContent().
	const start = HTML.indexOf("<!DOCTYPE html>")
	expect(start, "getHtmlContent() template not found").toBeGreaterThan(-1)
	const end = HTML.indexOf("</html>", start)
	return HTML.slice(start, end)
}

describe("webview HTML load guard", () => {
	const html = htmlTemplate()
	// HTML comments stripped: the guard's own explanatory comments spell out the very
	// API names the assertions below count, so counting against raw markup would
	// match the prose as well as the code.
	const executable = html.replace(/<!--[\s\S]*?-->/g, "")

	it("installs a guard before the bundle script tag", () => {
		const guard = html.indexOf("webview_error")
		const bundle = html.indexOf('type="module"')
		expect(guard).toBeGreaterThan(-1)
		expect(bundle).toBeGreaterThan(-1)
		// Order matters: a guard after the module tag would not run first.
		expect(guard).toBeLessThan(bundle)
	})

	it("reports load failures from resource elements, which do not bubble", () => {
		// Capture phase is what makes <script>/<link> load errors observable at all.
		expect(html).toContain("t.tagName")
		expect(html).toMatch(/addEventListener\(\s*"error"/)
		// ...and the listener must be registered with capture=true.
		const listener = html.slice(html.indexOf('"error"'), html.indexOf('"error"') + 900)
		expect(listener).toMatch(/true\s*,?\s*\)/)
	})

	it("forwards unhandled rejections", () => {
		expect(html).toContain("unhandledrejection")
	})

	it("instruments serviceWorker.register so an attempt can be attributed", () => {
		// A repo-wide and install-wide search finds no register() call in Cline, in any
		// installed extension, or in VSCodium, yet VS Code surfaces a registration
		// failure when this panel opens. This is the only code that runs in this
		// document, so wrapping register() is what turns "cannot find the caller" into
		// a named stack - and silence rules this document out. Report-only: the
		// original must still be called, or the guard would be changing behaviour.
		expect(executable).toContain("navigator.serviceWorker.register")
		expect(executable).toContain("register() caller stack")
		expect(executable).toContain("originalRegister")
	})

	it("acquires the VS Code API and hands the instance to the app", () => {
		const executable = html.replace(/<!--[\s\S]*?-->/g, "")
		const callSites = executable.match(/acquireVsCodeApi\s*\(\s*\)/g) ?? []
		expect(callSites).toHaveLength(1)
		expect(executable).toContain("__clineVsCodeApi")
	})
})

describe("platform.config reuses the guard's VS Code API instance", () => {
	const src = readFileSync(
		join(import.meta.dir, "..", "..", "..", "webview-ui", "src", "config", "platform.config.ts"),
		"utf-8",
	)

	it("does not call acquireVsCodeApi when the guard already did", () => {
		expect(src).toContain("__clineVsCodeApi")
		// The fallback must be guarded by ??, not evaluated eagerly.
		expect(src).toMatch(/preAcquiredApi\s*\?\?/)
	})
})
