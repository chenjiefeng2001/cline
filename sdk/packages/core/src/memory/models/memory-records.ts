/**
 * CoALA-typed memory records [roadmap P1-1].
 *
 * The long-term memory layer fills gap D2 (only "working memory" existed).
 * Records follow the CoALA four-way typing, narrowed to the coding-scenario
 * slice the roadmap calls for:
 *
 * - **episodic** — project-level decision records and pitfalls (what was
 *   decided, what broke, when). Append-only; the log itself is the history.
 * - **semantic** — codebase fact cards keyed by subject. A new fact on the
 *   same subject supersedes the previous one (temporal version trail,
 *   `supersededById`), so queries can resolve conflicts by recency instead
 *   of guessing which fact is current.
 * - **procedural** — reserved in {@link MemoryKind} for future skills/rules
 *   routing; no record shape is published in this slice.
 *
 * Retrieval philosophy: structured/keyword queries here feed agentic search;
 * vector recall is a later increment, not a substitute.
 */

/** CoALA memory kinds; `procedural` is reserved for a future slice. */
export type MemoryKind = "episodic" | "semantic" | "procedural";

/** Project-level decision or pitfall record (append-only). */
export interface EpisodicMemoryRecord {
	id: string;
	kind: "episodic";
	/** e.g. "decision" | "pitfall". */
	subtype: string;
	title: string;
	detail: string;
	workspacePath?: string;
	sessionId?: string;
	tags: string[];
	createdAt: string;
}

/**
 * Codebase fact card keyed by subject. Appending a new fact with the same
 * subject supersedes the previous active fact — the trail stays queryable
 * via `supersededById` (temporal conflict resolution, not overwrite).
 */
export interface SemanticMemoryRecord {
	id: string;
	kind: "semantic";
	/** e.g. "codebase-fact". */
	subtype: string;
	/** Conflict-resolution key (e.g. "auth:token-refresh-flow"). */
	subject: string;
	fact: string;
	/** 0–1 self-reported confidence, when the writer knows better. */
	confidence?: number;
	sources: string[];
	workspacePath?: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	/** id of the fact that replaced this one, when superseded. */
	supersededById?: string;
}

export type MemoryRecord = EpisodicMemoryRecord | SemanticMemoryRecord;

/** Input for appending an episodic record; ids/timestamps are assigned. */
export interface EpisodicMemoryInput {
	kind: "episodic";
	/** Defaults to "decision". */
	subtype?: string;
	title: string;
	detail: string;
	workspacePath?: string;
	sessionId?: string;
	tags?: string[];
}

/** Input for appending a semantic fact card; ids/timestamps are assigned. */
export interface SemanticMemoryInput {
	kind: "semantic";
	/** Defaults to "codebase-fact". */
	subtype?: string;
	subject: string;
	fact: string;
	confidence?: number;
	sources?: string[];
	workspacePath?: string;
	tags?: string[];
}

export type MemoryRecordInput = EpisodicMemoryInput | SemanticMemoryInput;

/** Structured query over the memory layer. */
export interface MemoryQueryFilter {
	kind?: MemoryKind;
	subtypes?: string[];
	/** Exact subject match (semantic fact cards). */
	subject?: string;
	workspacePath?: string;
	sessionId?: string;
	tags?: string[];
	/** Exclude superseded semantic records. Defaults to `true`. */
	activeOnly?: boolean;
	/** Case-insensitive substring match over title/detail/fact/subject. */
	keyword?: string;
	limit?: number;
}
