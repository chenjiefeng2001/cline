import type { ClineMessage, TurnState } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatState, MessageHandlers } from "../../types/chatTypes"
import { ActionButtons } from "./ActionButtons"

// Render VSCodeButton as a native button so `disabled` is observable in the DOM.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
}))

const mockTurnState = vi.fn<() => TurnState | undefined>(() => undefined)
vi.mock("../../../../../context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ foregroundCommandRunning: false }),
	useMessagesState: () => ({ turnState: mockTurnState() }),
}))

function fileApprovalAsk(ts: number, path: string): ClineMessage {
	return {
		ts,
		type: "ask",
		ask: "tool",
		text: JSON.stringify({ tool: "newFileCreated", path }),
		partial: false,
	}
}

function completionResultAsk(ts: number): ClineMessage {
	return { ts, type: "ask", ask: "completion_result", text: "", partial: false }
}

function makeChatState(): ChatState {
	return {
		inputValue: "",
		selectedImages: [],
		selectedFiles: [],
		setInputValue: vi.fn(),
		setSelectedImages: vi.fn(),
		setSelectedFiles: vi.fn(),
		setSendingDisabled: vi.fn(),
	} as unknown as ChatState
}

describe("ActionButtons", () => {
	it("does not render a scroll button when there are no action buttons", () => {
		mockTurnState.mockReturnValue(undefined)
		const task: ClineMessage = {
			ts: 1,
			type: "ask",
			ask: "followup",
			text: "Anything else?",
			partial: false,
		}

		render(
			<ActionButtons
				chatState={makeChatState()}
				messageHandlers={{ executeButtonAction: vi.fn() } as unknown as MessageHandlers}
				messages={[task]}
				mode="act"
				task={task}
			/>,
		)

		expect(screen.queryByRole("button")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Scroll to bottom")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Scroll to top")).not.toBeInTheDocument()
	})

	it("re-enables the buttons when a second identical approval ask arrives", async () => {
		// Regression: the button configs are shared singletons, so two consecutive
		// "create file" asks return the same object. Clicking the first latches a
		// local processing flag; the latch must clear when the next ask arrives so
		// the user can act on it.
		mockTurnState.mockReturnValue({ phase: "awaiting_approval", anchorTs: 1 })
		const executeButtonAction = vi.fn().mockResolvedValue(undefined)
		const messageHandlers = {
			executeButtonAction,
		} as unknown as MessageHandlers

		const task = fileApprovalAsk(1, "/notes.txt")
		const props = {
			task,
			chatState: makeChatState(),
			messageHandlers,
			mode: "act" as const,
		}

		const { rerender } = render(<ActionButtons {...props} messages={[task]} />)

		const save = screen.getByRole("button", { name: "Save" })
		expect(save).not.toBeDisabled()

		// Approving latches the processing flag, disabling the buttons.
		fireEvent.click(save)
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

		// A second create-file ask arrives. Its config is the same object as the
		// first, but the anchored timestamp changes — buttons must re-enable.
		const secondAsk = fileApprovalAsk(2, "/notes2.txt")
		mockTurnState.mockReturnValue({ phase: "awaiting_approval", anchorTs: 2 })
		rerender(<ActionButtons {...props} messages={[task, secondAsk]} />)

		expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled()
		expect(screen.getByRole("button", { name: "Reject" })).not.toBeDisabled()
	})
})

describe("ActionButtons latch self-healing", () => {
	beforeEach(() => {
		mockTurnState.mockReset()
	})

	function renderCompleted() {
		const executeButtonAction = vi.fn().mockResolvedValue(undefined)
		const task = completionResultAsk(1_700_000_000_000)
		const props = {
			task,
			chatState: makeChatState(),
			messageHandlers: { executeButtonAction } as unknown as MessageHandlers,
			mode: "act" as const,
		}
		const utils = render(<ActionButtons {...props} messages={[task]} />)
		const newTask = () => screen.getByRole("button", { name: "Start New Task" })
		const setPhase = (turnState: TurnState) => {
			mockTurnState.mockReturnValue(turnState)
			utils.rerender(<ActionButtons {...props} messages={[task]} />)
		}
		return { ...utils, newTask, setPhase, executeButtonAction }
	}

	it("disables the button right after a click so the action cannot be double-submitted", () => {
		// A finished loop. The backend does not stamp anchorTs on the terminal
		// transition, so askIdentity degenerates to lastMessage.ts + button labels.
		mockTurnState.mockReturnValue({ phase: "completed", seq: 7 })
		const { newTask, executeButtonAction } = renderCompleted()

		fireEvent.click(newTask())
		expect(executeButtonAction).toHaveBeenCalledTimes(1)
		expect(newTask()).toBeDisabled()
	})

	it("keeps the button disabled across same-seq re-renders", () => {
		// The latch's original purpose: the trailing bookkeeping re-renders that
		// arrive before the backend advances the turn must not re-enable the button.
		mockTurnState.mockReturnValue({ phase: "completed", seq: 7 })
		const { newTask, setPhase } = renderCompleted()

		fireEvent.click(newTask())
		expect(newTask()).toBeDisabled()

		setPhase({ phase: "completed", seq: 7 })
		expect(newTask()).toBeDisabled()
	})

	it("re-enables once the turn advances, even though askIdentity is unchanged", () => {
		// The regression this fixes: the latch was released only when the RPC
		// rejected, so a SUCCESSFUL action left it set. With no anchorTs on the
		// completed transition, askIdentity is "<lastMessage.ts>:Start New Task:",
		// which repeats across turns - so the footer stayed permanently dead and,
		// with the config's sendingDisabled, so did the input. Keying the latch on
		// turnState.seq as well makes it self-healing without weakening the
		// same-turn guard.
		mockTurnState.mockReturnValue({ phase: "completed", seq: 7 })
		const { newTask, setPhase, executeButtonAction } = renderCompleted()

		fireEvent.click(newTask())
		expect(executeButtonAction).toHaveBeenCalledTimes(1)
		expect(newTask()).toBeDisabled()

		// Same phase and same anchor-free identity; only the turn seq moves on.
		setPhase({ phase: "completed", seq: 8 })
		expect(newTask()).not.toBeDisabled()

		fireEvent.click(newTask())
		expect(executeButtonAction).toHaveBeenCalledTimes(2)
		expect(executeButtonAction).toHaveBeenLastCalledWith("new_task", "", [], [])
	})

	it("releases the latch when the action fails so the user is not stuck", async () => {
		mockTurnState.mockReturnValue({ phase: "completed", seq: 7 })
		const executeButtonAction = vi.fn().mockRejectedValue(new Error("rpc failed"))
		const task = completionResultAsk(1_700_000_000_000)
		const props = {
			task,
			chatState: makeChatState(),
			messageHandlers: { executeButtonAction } as unknown as MessageHandlers,
			mode: "act" as const,
		}
		render(<ActionButtons {...props} messages={[task]} />)

		const newTask = () => screen.getByRole("button", { name: "Start New Task" })
		fireEvent.click(newTask())
		await vi.waitFor(() => expect(executeButtonAction).toHaveBeenCalledTimes(1))
		await vi.waitFor(() => expect(newTask()).not.toBeDisabled())
	})
})
