/**
 * A2A core objects typed for the hub mapping [roadmap P2-1].
 *
 * Gap D3: the protocol surface is one-way (only in, never out) — the hub is
 * already "the shape of an agent-to-agent bus" but speaks a private dialect.
 * Per the P0-3 vocabulary freeze (`doc/hub-webview-protocol-freeze-v1-*
 * .md` §3), the hub session bus and the A2A Task lifecycle are naturally
 * isomorphic (session/run/approval ↔ task/working/input-required), making
 * the A2A server the lowest-cost protocol outlet.
 *
 * External protocol details (event/method names, state machine) follow the
 * directional mapping frozen in the P0-3 doc; drift rules: additions allowed
 * with mapping-table registration, renames/deletes require v2.
 */

/** A2A Task lifecycle states (subset mapped from hub session/run state). */
export type A2ATaskState =
	| "submitted"
	| "working"
	| "input-required"
	| "completed"
	| "failed"
	| "canceled";

/**
 * A2A Agent Card: the discovery document declaring capabilities and skills.
 * Hub-derived capabilities: streaming=true (SSE-style event stream) and
 * pushNotifications=true (ui.notify broadcast + connector channels).
 */
export interface A2AAgentCard {
	name: string;
	description?: string;
	/** A2A endpoint url; HTTP/SSE wiring is a later slice. */
	url?: string;
	version: string;
	capabilities: {
		streaming: boolean;
		pushNotifications: boolean;
	};
	defaultInputModes?: string[];
	defaultOutputModes?: string[];
	skills: A2AAgentSkill[];
}

export interface A2AAgentSkill {
	id: string;
	name: string;
	description?: string;
	tags?: string[];
}

/** A2A Task: the hub session projected onto the A2A lifecycle. */
export interface A2ATask {
	id: string;
	/** Correlates tasks of one conversation; hub session id. */
	contextId: string;
	status: {
		state: A2ATaskState;
		timestamp?: string;
	};
	/** Cross-reference back to the private hub vocabulary. */
	metadata?: {
		sessionId?: string;
		source?: string;
		pendingApproval?: boolean;
	};
}
