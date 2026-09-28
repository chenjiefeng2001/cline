import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The webview only ever holds the most recent 200 messages
 * (getStateToPostToWebview's INITIAL_MESSAGE_WINDOW). Everything older exists in
 * the UI solely because loadHistoryBatch answers. That makes this cursor the single
 * point where the frontend and the backend can disagree about the same
 * conversation, and it used to be the one part of the reconciliation path with no
 * logging at all.
 *
 * The state-size log reports the WINDOW, not the conversation. A real session
 * produced a flat "messages=200" across 105 consecutive posts, which reads like a
 * stuck pipeline and is in fact a saturated window over a longer transcript. The
 * total is now reported next to it so the divergence is stated rather than inferred.
 */
const PREPARE = readFileSync(join(import.meta.dir, "subscribeToState.ts"), "utf-8")

describe("state log distinguishes the window from the conversation", () => {
	it("reports the true total whenever the webview holds a window", () => {
		// Without this the log can only ever show the window, so a permanently
		// capped transcript is indistinguishable from a stalled one.
		expect(PREPARE).toContain("state.totalMessageCount")
		expect(PREPARE).toMatch(/of \$\{totalCount\}/)
	})
})

describe("loadHistoryBatch reports what it resolved", () => {
	const ctl = readFileSync(join(import.meta.dir, "..", "..", "..", "sdk", "SdkController.ts"), "utf-8")
	const start = ctl.indexOf("async loadHistoryBatch")
	const body = ctl.slice(start, start + 6000)

	it("logs the request cursor and the slice it resolved to", () => {
		expect(body).toContain("loadHistoryBatch(task=")
		// A dead cursor is the failure that loses history silently; the outcome count
		// is what proves the gap actually closed.
		expect(body).toMatch(/hasMore=\$\{hasMore\}/)
	})

	it("warns specifically when the webview cursor is not in the transcript's order", () => {
		// beforeIndex === -1 means beforeTs is at or below our oldest message. The
		// webview believes there is more history; reporting "no more messages" is
		// accurate but leaves the UI looking permanently truncated with no reason.
		expect(body).toMatch(/matched no position in/)
		expect(body).toContain("older history will not load")
	})
})
