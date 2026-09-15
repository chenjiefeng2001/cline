/**
 * Long-term memory abstraction [roadmap P1-1].
 *
 * The gap analysis (D2) concluded the missing piece is a *layer*, not a
 * feature: one memory interface plus at least one backend, so integrations
 * stop re-inventing private continuity semantics (`.clinerules` files +
 * unread JSONL history). Backends implement this contract; the first
 * adapter is the local sqlite store (`stores/sqlite-memory-store.ts`),
 * with hosted providers (Mem0/Zep/Letta) as future drop-ins.
 */

import type {
	MemoryQueryFilter,
	MemoryRecord,
	MemoryRecordInput,
} from "./models/memory-records";

export interface MemoryStore {
	init(): Promise<void> | void;
	/**
	 * Appends a record. Episodic records are append-only; semantic fact
	 * cards auto-supersede the previous active record on the same subject
	 * (conflict resolution by recency, trail kept via `supersededById`).
	 */
	append(input: MemoryRecordInput): Promise<MemoryRecord> | MemoryRecord;
	get(id: string): Promise<MemoryRecord | undefined> | MemoryRecord | undefined;
	query(filter?: MemoryQueryFilter): Promise<MemoryRecord[]> | MemoryRecord[];
}
