import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Resolve from import.meta.url rather than import.meta.dir: the latter is a Bun
 * extension and is undefined under Vitest, which is exactly what happens the moment
 * a test sits in a path that both runners glob. This directory is covered by
 * vitest.config.ts (src/core/controller/state) and by run-bun-unit-tests.ts at the
 * same time, so which framework loads a file is decided by its import alone, and
 * the path handling has to survive either one.
 */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The webview only ever holds the most recent 200 messages
 * (getStateToPostToWebview's INITIAL_MESSAGE_WINDOW). Everything older exists in the
 * UI solely because loadHistoryBatch answers, so that cursor is the single point
 * where the frontend and the backend can disagree about the same conversation - and
 * it was the one part of the reconciliation path with no logging at all.
 *
 * The state-size line reports the WINDOW, never the conversation. A real 25 minute
 * session logged messages=200 on 105 of 109 state posts and messages=0 on the other
 * 4, nothing in between across multiple turns and streaming. That reads exactly like
 * a stalled pipeline; it is a saturated window over a longer transcript, and the log
 * could not tell the two apart.
 */
const PREPARE = readFileSync(join(HERE, "subscribeToState.ts"), "utf-8")

describe("state log distinguishes the window from the conversation", () => {
	it("reports the true total whenever the webview holds a window", () => {
		// Without this the log can only ever show the window, so a permanently capped
		// transcript is indistinguishable from a stalled one.
		expect(PREPARE).toContain("state.totalMessageCount")
		expect(PREPARE).toMatch(/of \$\{totalCount\}/)
	})
})

describe("loadHistoryBatch reports what it resolved", () => {
	const ctl = readFileSync(join(HERE, "..", "..", "..", "sdk", "SdkController.ts"), "utf-8")
	const body = ctl.slice(ctl.indexOf("async loadHistoryBatch"), ctl.indexOf("async loadHistoryBatch") + 6000)

	it("logs the request cursor and the slice it resolved to", () => {
		expect(body).toContain("loadHistoryBatch(task=")
		// A dead cursor is the failure that loses history silently; the returned count
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
