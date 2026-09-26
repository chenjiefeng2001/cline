import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import HydrationGate from "./HydrationGate"

const useExtensionState = vi.fn()
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => useExtensionState(),
}))

describe("HydrationGate", () => {
	beforeEach(() => {
		useExtensionState.mockReset()
	})

	it("renders nothing once state has hydrated", () => {
		useExtensionState.mockReturnValue({ didHydrateState: true, hydrationTimedOut: false, retryHydration: vi.fn() })
		const { container } = render(<HydrationGate />)
		expect(container).toBeEmptyDOMElement()
	})

	it("shows a loading indicator instead of a blank panel while hydrating", () => {
		useExtensionState.mockReturnValue({ didHydrateState: false, hydrationTimedOut: false, retryHydration: vi.fn() })
		render(<HydrationGate />)
		// The regression this guards: App used to `return null` here, so a
		// dropped first state frame produced an empty panel with no explanation.
		expect(screen.getByTestId("hydration-loading")).toBeInTheDocument()
		expect(screen.queryByTestId("hydration-retry")).not.toBeInTheDocument()
	})

	it("surfaces an actionable error with a retry control after a timeout", () => {
		const retryHydration = vi.fn()
		useExtensionState.mockReturnValue({ didHydrateState: false, hydrationTimedOut: true, retryHydration })
		render(<HydrationGate />)

		expect(screen.queryByTestId("hydration-loading")).not.toBeInTheDocument()
		expect(screen.getByText(/could not load its state/i)).toBeInTheDocument()

		fireEvent.click(screen.getByTestId("hydration-retry"))
		expect(retryHydration).toHaveBeenCalledTimes(1)
	})
})
