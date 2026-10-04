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
	// The subscription used to be spelled out inline here. It is now created by
	// subscribeToStateStream(), which is the only place allowed to subscribe — both
	// this mount and the self-healing re-subscription in requestFullSync go through
	// it so a recovery can never install a less capable frame handler than the one
	// it replaced. The contract under test is unchanged: ready is sent after the
	// state subscription is wired.
	const effectStart = ctx.indexOf("stateSubscriptionRef.current = subscribeToStateStream(")
	const ready = ctx.indexOf('postMessage({ type: "webview_ready" })')
	const endOfEffect = ctx.indexOf("}, [])", ready)

	it("routes the mount-time subscription through subscribeToStateStream", () => {
		expect(effectStart).toBeGreaterThan(-1)
		// ...and that helper is the one carrying both stream channels.
		const helper = ctx.slice(ctx.indexOf("const subscribeToStateStream"))
		expect(helper).toContain("onResponse: handleStateFrame")
	})

	it("has exactly one subscribeToState call site, so recovery cannot downgrade the handler", () => {
		// `requestFullSync` cancels the mount subscription and installs a replacement.
		// When that replacement was spelled out inline it handled only `stateJson` and
		// ignored `deltaJson`, so one detected delta gap permanently cost the webview
		// delta handling — and the gap detector itself, which lived in the discarded
		// closure, so it could never recover or be re-detected. During a turn the host
		// skips the full snapshot whenever it shipped deltas, which froze `turnState`
		// and the footer/input gate for the remainder of the turn.
		//
		// Collapsing both call sites onto `subscribeToStateStream` makes that class of
		// regression structurally impossible: there is nowhere else to subscribe.
		const occurrences = ctx.split("StateServiceClient.subscribeToState(").length - 1
		expect(occurrences).toBe(1)
	})

	it("handles both the snapshot and the delta channel in one frame handler", () => {
		const handler = ctx.slice(ctx.indexOf("const handleStateFrame"), ctx.indexOf("const subscribeToStateStream"))
		expect(handler).toContain("if (response.stateJson)")
		expect(handler).toContain("if (response.deltaJson)")
		expect(handler).toContain('case "append_message"')
		// The gap detector must live in the shared handler too, otherwise a recovery
		// subscription could not notice the NEXT gap.
		expect(handler).toContain("requestFullSyncRef.current()")
	})

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
