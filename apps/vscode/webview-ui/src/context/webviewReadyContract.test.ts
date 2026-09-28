import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * A webview panel that renders "Something went wrong displaying this content"
 * leaves Cline.log completely silent, and that is what closing VSCodium mid-session
 * produced. Three independent causes, all structural:
 *
 * 1. ChatErrorBoundary swallowed the error. A boundary is exactly the component that
 *    stops an error reaching window.onerror, which is where the load guard added in
 *    c7a945618 listens. So every boundary-caught render failure bypassed the reporting
 *    path that commit introduced, and VS Code discards the devtools console on close.
 *
 * 2. webview_ready was the last statement of the effect that owns the state
 *    subscription. A throw in the optional wiring before it aborted the effect, so
 *    ready was never sent - the extension's watchdog then reported a blank panel -
 *    and the cleanup was never returned, leaking the subscription for the next mount.
 *
 * 3. Nothing reported which stage the webview reached, so "never ready" was a single
 *    undifferentiated outcome.
 *
 * Asserted against source rather than by rendering, because the failure is an
 * exception escaping an effect body, which a unit test would have to simulate
 * through React's scheduling.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const ctx = readFileSync(join(HERE, "ExtensionStateContext.tsx"), "utf-8")
const boundary = readFileSync(join(HERE, "..", "components", "chat", "ChatErrorBoundary.tsx"), "utf-8")

describe("error boundaries report to the extension", () => {
	it("forwards a caught error instead of only logging it", () => {
		expect(boundary).toContain("reportWebviewError")
		expect(boundary).toContain("componentDidCatch")
		// The component stack is what makes the report actionable; without it the log
		// just says something failed somewhere in a chat widget.
		expect(boundary).toContain("componentStack")
	})
})

describe("webview_ready is not gated on optional wiring", () => {
	const effectStart = ctx.indexOf("stateSubscriptionRef.current = StateServiceClient.subscribeToState")
	const ready = ctx.indexOf('postMessage({ type: "webview_ready" })')
	const endOfEffect = ctx.indexOf("}, [])", ready)

	it("is sent after the state subscription is wired", () => {
		expect(effectStart).toBeGreaterThan(-1)
		expect(ready).toBeGreaterThan(effectStart)
	})

	it("is sent before the optional wiring, and that wiring is guarded", () => {
		// Terminal profiles / relinquish control / account button all sit between the
		// ready signal and the end of the effect. They are best-effort, so a failure
		// must not cost us the ready signal or the cleanup.
		const terminal = ctx.indexOf("getAvailableTerminalProfiles", ready)
		expect(terminal).toBeGreaterThan(-1)
		expect(terminal).toBeLessThan(endOfEffect)
		expect(ctx).toContain("Optional webview wiring failed after ready")
	})

	it("still returns the cleanup when the optional wiring throws", () => {
		// Declared outside the try so the catch path can hand back whatever was built;
		// returning nothing here would leak the state subscription on the next mount.
		expect(ctx).toMatch(/let cleanup: \(\(\) => void\) \| undefined/)
		const afterCatch = ctx.slice(ctx.indexOf("Optional webview wiring failed after ready"))
		expect(afterCatch).toMatch(/return cleanup/)
	})
})
