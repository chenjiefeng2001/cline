/**
 * # useIncrementalMessages — Memoized Message Processing Chain
 *
 * Avoids O(N) recomputation of `modifiedMessages`, `visibleMessages`, and
 * `groupedMessages` on every render by tracking message identity via ts + seq
 * fingerprint. When no messages have changed in content or order, the cached
 * result is returned.
 *
 * ## The Problem
 * Without this hook, every React re-render triggered by state update fires
 * 7 full traversals of the message array:
 *   1. combineHookSequences
 *   2. combineCommandSequences
 *   3. combineApiRequests
 *   4. combineErrorRetryMessages
 *   5. filterVisibleMessages
 *   6. groupMessages
 *   7. groupLowStakesTools
 * This is O(N * 7) per update — fine for 10 messages, but 500+ messages with
 * streaming partials causes visible jank on each keystroke / partial chunk.
 *
 * ## How it works
 * Keys the cache on the input array reference first, and on a fingerprint of every
 * message's `ts`+`seq` second. When neither matches, the full chain runs once and the
 * cache is updated.
 */

import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { combineErrorRetryMessages } from "@shared/combineErrorRetryMessages"
import { combineHookSequences } from "@shared/combineHookSequences"
import { type ClineMessage } from "@shared/ExtensionMessage"
import { useMemo, useRef } from "react"
import { filterVisibleMessages, groupLowStakesTools, groupMessages } from "../utils/messageUtils"

interface CachedMessageChain {
	messages: ClineMessage[]
	modifiedMessages: ClineMessage[]
	visibleMessages: ClineMessage[]
	groupedMessages: (ClineMessage | ClineMessage[])[]
}

/**
 * Build a numeric fingerprint for the message array using FNV-1a hash.
 * Only ts + seq matter — other fields changing is what we want to process.
 *
 * Returns a 32-bit integer (0 for empty). Uses a constant-time sampling
 * strategy: always includes length + last message (catches streaming appends),
 * plus a stride-based sample of intermediate messages to detect edits/collapses.
 * FNV-1a avoids string allocation and GC pressure from concatenation.
 *
 * ## Why this scans EVERY message
 *
 * It used to sample: length + the last message + a stride sample of ~15
 * intermediate entries. That was unsound. `applyMessage` (messageReducer.ts)
 * replaces a message IN PLACE, keeping the same `ts` and only raising `seq` — which
 * is exactly how a partial message becomes its final version, how a
 * `commandCompleted` flips, and how an `api_req_started` gains `cost`/usage. If the
 * updated message sat at an unsampled index, the fingerprint was unchanged, the
 * cache hit, and `modifiedMessages`/`visibleMessages`/`groupedMessages` were returned
 * stale — the row never updated until something else changed the length or the tail.
 * That is a stale transcript, i.e. the same "list stopped refreshing" family.
 *
 * So the hash now folds every element. It stays O(N) with no allocation, but it can
 * no longer miss an update — and combined with the identity checks below, a changed
 * fingerprint no longer forces a full recompute.
 */
function fingerprint(messages: ClineMessage[]): number {
	const len = messages.length
	if (len === 0) return 0

	// FNV-1a offset basis
	let hash = 2166136261
	// Mix in length to catch truncation/append
	hash = ((hash ^ (len & 0xffffffff)) * 16777619) >>> 0

	for (let i = 0; i < len; i++) {
		const m = messages[i]
		hash = ((hash ^ (m.ts & 0xffffffff)) * 16777619) >>> 0
		hash = ((hash ^ ((m.seq ?? 0) & 0xffffffff)) * 16777619) >>> 0
	}

	return hash
}

/**
 * Hook that provides memoized derived message arrays.
 * Only recomputes the chain when messages actually change.
 */
export function useIncrementalMessages(
	displayMessages: ClineMessage[],
	hooksEnabled: boolean | undefined,
): {
	modifiedMessages: ClineMessage[]
	visibleMessages: ClineMessage[]
	groupedMessages: (ClineMessage | ClineMessage[])[]
} {
	// Track the fingerprint of the last processed input
	const cacheRef = useRef<{
		messages: ClineMessage[]
		fingerprint: number
		hooksEnabled: boolean | undefined
	} | null>(null)

	const cachedResultRef = useRef<CachedMessageChain | null>(null)

	const currentFingerprint = useMemo(() => fingerprint(displayMessages), [displayMessages])

	// Fast path, strongest signal first: an identical array reference cannot have
	// changed, so no hashing is needed at all. During streaming the store publishes a
	// new array on every chunk, so the fingerprint comparison below is what carries
	// the common case — and it now covers every message, so it cannot miss an
	// in-place update.
	if (
		cacheRef.current !== null &&
		cachedResultRef.current !== null &&
		cacheRef.current.hooksEnabled === hooksEnabled &&
		(cacheRef.current.messages === displayMessages || cacheRef.current.fingerprint === currentFingerprint)
	) {
		return {
			modifiedMessages: cachedResultRef.current.modifiedMessages,
			visibleMessages: cachedResultRef.current.visibleMessages,
			groupedMessages: cachedResultRef.current.groupedMessages,
		}
	}

	// Slow path: recompute the full chain
	const modifiedMessages = computeModifiedMessages(displayMessages, hooksEnabled)
	const visibleMessages = filterVisibleMessages(modifiedMessages)
	const groupedMessages = groupLowStakesTools(groupMessages(visibleMessages))

	// Update cache
	cacheRef.current = { messages: displayMessages, fingerprint: currentFingerprint, hooksEnabled }
	cachedResultRef.current = {
		messages: displayMessages,
		modifiedMessages,
		visibleMessages,
		groupedMessages,
	}

	return { modifiedMessages, visibleMessages, groupedMessages }
}

/**
 * Computes the modified messages chain from display messages.
 * Extracted as a pure function for testability.
 */
function computeModifiedMessages(displayMessages: ClineMessage[], hooksEnabled: boolean | undefined): ClineMessage[] {
	const slicedMessages = displayMessages.slice(1)
	const withHooks = hooksEnabled ? combineHookSequences(slicedMessages) : slicedMessages
	return combineErrorRetryMessages(combineApiRequests(combineCommandSequences(withHooks)))
}
