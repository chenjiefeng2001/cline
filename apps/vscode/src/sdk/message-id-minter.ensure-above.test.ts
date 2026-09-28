import { describe, expect, it } from "vitest"
import { MessageIdMinter } from "./message-id-minter"

/**
 * `ts` is the identity of a ClineMessage, not an ordering hint.
 * messageReducer.applyMessage looks a message up with
 * `findIndex(m => m.ts === incoming.ts)` and, on a hit, assigns
 * `messages[index] = incoming` - so a repeated ts does not append, it silently
 * REPLACES an existing message.
 *
 * MessageIdMinter is an in-memory counter seeded at 0 that only lives as long as
 * the extension host process (ExtensionMessage.ts documents both the freshness
 * seq and the epoch as "increasing per process"). Messages outlive it: they are
 * persisted to task history and read back after a reload with their original ids
 * intact, because finalizeMessagesForSave() copies each message and never
 * rewrites ts.
 *
 * So without ensureAbove() the sequence is: a window reload restarts the counter
 * at 1, history yields messages that already use ts=1,2,3, and the first
 * interaction message minted after the load is ts=1 - which overwrites the first
 * historical message. On a resumed task that is silently lost history.
 */
describe("MessageIdMinter.ensureAbove", () => {
	it("does not re-mint ids that persisted history already uses after a host restart", () => {
		const persistedTs = [1, 2, 3]
		const afterRestart = new MessageIdMinter()

		// The load path reserves past the transcript it just read.
		afterRestart.ensureAbove(Math.max(...persistedTs))

		const minted = [afterRestart.nextId(), afterRestart.nextId(), afterRestart.nextId()]
		expect(minted).toEqual([4, 5, 6])
		expect(minted.filter((ts) => persistedTs.includes(ts))).toHaveLength(0)
	})

	it("is a no-op when history is behind the counter, so a live process is unaffected", () => {
		const minter = new MessageIdMinter()
		minter.ensureAbove(50)
		expect(minter.nextId()).toBe(51)

		const live = new MessageIdMinter()
		live.nextId()
		live.nextId()
		live.ensureAbove(1) // history older than what this process already minted
		expect(live.nextId()).toBe(3)
	})

	it("keeps array order equal to ts order when history holds a Date.now() resume marker", () => {
		// appendFreshResumeMessage stamps Date.now() (~1.8e12), which is larger than
		// any counter id. SdkController.loadHistoryBatch sorts by ts, so if the minter
		// were not advanced the next minted id (1) would sort before the marker and
		// the transcript would reorder under the sort.
		const resumeMarkerTs = Date.now()
		const minter = new MessageIdMinter()
		minter.ensureAbove(resumeMarkerTs)

		const next = minter.nextId()
		expect(next).toBeGreaterThan(resumeMarkerTs)
	})

	it("ignores non-finite input rather than poisoning the counter", () => {
		const minter = new MessageIdMinter()
		minter.ensureAbove(Number.NaN)
		minter.ensureAbove(Number.POSITIVE_INFINITY)
		expect(minter.nextId()).toBe(1)
	})
})
