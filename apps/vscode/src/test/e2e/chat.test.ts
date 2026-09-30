import { expect } from "@playwright/test"
import { e2e } from "./utils/helpers"

e2e("Chat - can send messages and switch between modes", async ({ helper, sidebar }) => {
	// Sign in
	await helper.signin(sidebar)

	// Submit a message
	const inputbox = sidebar.getByTestId("chat-input")
	await expect(inputbox).toBeVisible()
	await inputbox.fill("Hello, Cline!")
	await expect(inputbox).toHaveValue("Hello, Cline!")
	await sidebar.getByTestId("send-button").click()
	await expect(inputbox).toHaveValue("")

	// Wait for the (mock) agent turn to finish before navigating away — the task
	// is persisted to SDK session history when the turn completes, so clicking
	// "New Task" mid-turn races the history write and "Recent" may not show.
	//
	// This is a synchronisation point, not a product assertion, so it gets its own
	// budget rather than the config default (5s on CI/Windows). What it waits for is a
	// three-step async chain - turn completes, task is written to SDK session history,
	// sidebar re-renders - and 5s sits inside the noise of a loaded Windows runner,
	// which is how this failed: the chain completed correctly, just late.
	//
	// Kept well under the 60s per-test timeout so a turn that genuinely never completes
	// still fails rather than hanging. Relaxing the wait is not the same as removing
	// the check: a broken history write still times out here.
	const HISTORY_SYNC_TIMEOUT = 30_000
	await expect(sidebar.getByText("mock Cline API response")).toBeVisible({
		timeout: HISTORY_SYNC_TIMEOUT,
	})

	// Starting a new task should clear the current chat view and show the recent tasks.
	// Same history-write chain as above, so same budget.
	await sidebar.getByRole("button", { name: "New Task", exact: true }).first().click()
	await expect(sidebar.getByText("Recent")).toBeVisible({ timeout: HISTORY_SYNC_TIMEOUT })
	await expect(sidebar.getByText("Hello, Cline!")).toBeVisible({ timeout: HISTORY_SYNC_TIMEOUT })

	// Makes sure the act and plan switches are working correctly
	// Aria-checked state should be true for Act and false for Plan
	const actButton = sidebar.getByRole("switch", { name: "Act" })
	const planButton = sidebar.getByRole("switch", { name: "Plan" })

	// Act button should be active. It doesn't have c
	await expect(actButton).toHaveAttribute("aria-checked", "true")
	await expect(planButton).not.toHaveAttribute("aria-checked", "true")

	await planButton.click()
	await expect(planButton).toHaveAttribute("aria-checked", "true")
	await expect(actButton).not.toHaveAttribute("aria-checked", "true")

	// === slash commands preserve following text ===
	await expect(inputbox).toHaveValue("")
	// Type partial slash command to trigger menu
	await inputbox.fill("/newt")

	// Wait for menu to be visible and click on menu item
	await inputbox.focus()
	await sidebar.getByText("newtask", { exact: false }).click()
	await expect(inputbox).toHaveValue("/newtask ")

	// Add following text to verify it works correctly
	await inputbox.pressSequentially("following text should be preserved")
	await expect(inputbox).toHaveValue("/newtask following text should be preserved")

	// === @ mentions preserve following text ===
	await inputbox.fill("")
	await expect(inputbox).toHaveValue("")

	// Type partial @ mention to trigger menu
	await inputbox.fill("@prob")

	// Wait for menu to be visible and click on menu item
	await sidebar.getByText("Problems", { exact: false }).first().click()
	await expect(inputbox).toHaveValue("@problems ")

	// Add following text to verify it works correctly
	await inputbox.pressSequentially("following text should be preserved")
	await expect(inputbox).toHaveValue("@problems following text should be preserved")
})
