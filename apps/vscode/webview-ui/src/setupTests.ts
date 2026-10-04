import "@testing-library/jest-dom"
import { vi } from "vitest"

// "Official" jest workaround for mocking window.matchMedia()
// https://jestjs.io/docs/manual-mocks#mocking-methods-which-are-not-implemented-in-jsdom

Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: vi.fn().mockImplementation((query) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(), // Deprecated
		removeListener: vi.fn(), // Deprecated
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
})

// jsdom implements MouseEvent but not PointerEvent, so `fireEvent.pointerDown`
// delivers an event whose `button`, `clientY` and `pointerId` are all undefined.
// A component that inspects them then takes a branch the product never takes — the
// webview runs in Chromium, where these fields exist. Polyfilled here rather than
// per test file so every pointer gesture is exercised against the real shape.
if (typeof globalThis.PointerEvent === "undefined") {
	class PointerEventPolyfill extends MouseEvent {
		readonly pointerId: number
		readonly pointerType: string
		readonly isPrimary: boolean
		readonly width: number
		readonly height: number
		readonly pressure: number

		constructor(type: string, params: PointerEventInit = {}) {
			super(type, params)
			this.pointerId = params.pointerId ?? 1
			this.pointerType = params.pointerType ?? "mouse"
			this.isPrimary = params.isPrimary ?? true
			this.width = params.width ?? 1
			this.height = params.height ?? 1
			this.pressure = params.pressure ?? 0
		}
	}

	vi.stubGlobal("PointerEvent", PointerEventPolyfill)
	globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent
}

// Mock VSCode API for webview tests
vi.stubGlobal("acquireVsCodeApi", () => ({
	postMessage: vi.fn(),
	getState: vi.fn(),
	setState: vi.fn(),
}))
