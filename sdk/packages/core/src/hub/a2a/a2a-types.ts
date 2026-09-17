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

/**
 * A2A Task lifecycle states, serialized per A2A v1.0 §5.5 (ProtoJSON):
 * SCREAMING_SNAKE_CASE enum names on the wire. The hub projection never
 * produces UNSPECIFIED/AUTH_REQUIRED (no hub signal maps to them) but the
 * type accepts every non-unspecified state so stored/foreign tasks round-trip.
 */
export type A2ATaskState =
	| "TASK_STATE_SUBMITTED"
	| "TASK_STATE_WORKING"
	| "TASK_STATE_INPUT_REQUIRED"
	| "TASK_STATE_COMPLETED"
	| "TASK_STATE_FAILED"
	| "TASK_STATE_CANCELED"
	| "TASK_STATE_REJECTED"
	| "TASK_STATE_AUTH_REQUIRED";

/** Terminal states per v1.0 §4.1.3 (streams close on these). */
export const A2A_TERMINAL_TASK_STATES: readonly A2ATaskState[] = [
	"TASK_STATE_COMPLETED",
	"TASK_STATE_FAILED",
	"TASK_STATE_CANCELED",
	"TASK_STATE_REJECTED",
];

/**
 * A2A Agent Card v1.0 §4.4.1 (JSON-RPC/HTTP surface subset). The endpoint
 * lives in `supportedInterfaces` (there is no top-level `url` in v1); the
 * hub mount serves this card at `/.well-known/agent-card.json`.
 */
export interface A2AAgentInterface {
	url: string;
	protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON";
}

export interface A2AAgentCard {
	name: string;
	description: string;
	supportedInterfaces: A2AAgentInterface[];
	version: string;
	capabilities: {
		streaming?: boolean;
		pushNotifications?: boolean;
		extendedAgentCard?: boolean;
	};
	defaultInputModes: string[];
	defaultOutputModes: string[];
	skills: A2AAgentSkill[];
}

export interface A2AAgentSkill {
	id: string;
	name: string;
	description: string;
	tags: string[];
}

/** v1.0 §4.1.6 text part (oneOf members carry no `kind` discriminator). */
export interface A2ATextPart {
	text: string;
	metadata?: Record<string, unknown>;
}

/** v1.0 §4.1.7 artifact. */
export interface A2AArtifact {
	artifactId: string;
	name?: string;
	description?: string;
	parts: A2ATextPart[];
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
