/**
 * A2A mapping — hub session/run state projected onto the A2A Task lifecycle
 * [roadmap P2-1].
 *
 * Pure functions per the P0-3 freeze mapping (§3): private hub vocabulary in,
 * A2A objects out. The approval mapping is the natural fit called out in the
 * freeze doc: HITL approval (approval.requested) IS A2A's input-required.
 */

import type {
	A2AAgentCard,
	A2AAgentInterface,
	A2AAgentSkill,
	A2ATask,
	A2ATaskState,
} from "./a2a-types";

/** Loose hub session projection accepted by the mapper. `SessionRecord` satisfies it structurally. */
export interface A2ASessionProjectionInput {
	sessionId?: string;
	status?: string;
	conversationId?: string;
	source?: string;
}

export interface MapSessionToTaskOptions {
	/** Whether an approval.requested is pending for this session. */
	hasPendingApproval?: boolean;
}

/**
 * Maps a hub session status (plus pending-approval flag) onto the A2A Task
 * state machine. Pending approval overrides everything short of terminal
 * states — a running session waiting on approval is `input-required`.
 */
export function mapSessionStatusToTaskState(
	status: string,
	options: MapSessionToTaskOptions = {},
): A2ATaskState {
	switch (status) {
		case "completed":
			return "TASK_STATE_COMPLETED";
		case "failed":
			return "TASK_STATE_FAILED";
		case "cancelled":
			return "TASK_STATE_CANCELED";
		case "running":
		case "pending":
			return options.hasPendingApproval
				? "TASK_STATE_INPUT_REQUIRED"
				: "TASK_STATE_WORKING";
		// "idle" and unknown statuses: accepted but not started → submitted.
		default:
			return options.hasPendingApproval
				? "TASK_STATE_INPUT_REQUIRED"
				: "TASK_STATE_SUBMITTED";
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Projects a hub session record onto an A2A Task. Unknown record shapes
 * (loose payloads) degrade gracefully — the task id falls back to the
 * sessionId and the state to `submitted`.
 */
export function mapSessionToTask(
	record: A2ASessionProjectionInput | undefined,
	options: MapSessionToTaskOptions = {},
): A2ATask | undefined {
	const sessionId = record?.sessionId;
	if (!sessionId) {
		return undefined;
	}
	const state = mapSessionStatusToTaskState(record?.status ?? "idle", options);
	return {
		id: sessionId,
		contextId: asString(record?.conversationId) ?? sessionId,
		status: {
			state,
			timestamp: new Date().toISOString(),
		},
		metadata: {
			sessionId,
			source: asString(record?.source),
			pendingApproval: options.hasPendingApproval,
		},
	};
}

/**
 * Builds the A2A Agent Card (v1.0 §4.4.1) from hub-derived capabilities.
 * The endpoint is declared in `supportedInterfaces` (v1 has no top-level
 * `url`). `pushNotifications` stays false: the hub mount implements no push
 * delivery or push-config storage, and advertising an unimplemented
 * capability would be non-conformant (the P0-3 draft's `true` is amended).
 */
export function buildAgentCard(input: {
	name: string;
	description?: string;
	url?: string;
	version: string;
	skills?: A2AAgentSkill[];
	/** Reflects whether an event source is actually bound (SSE capability). */
	streaming?: boolean;
}): A2AAgentCard {
	const interfaces: A2AAgentInterface[] = input.url
		? [{ url: input.url, protocolBinding: "JSONRPC" }]
		: [];
	return {
		name: input.name,
		description: input.description ?? "",
		supportedInterfaces: interfaces,
		version: input.version,
		capabilities: {
			streaming: input.streaming ?? true,
			pushNotifications: false,
		},
		defaultInputModes: ["text"],
		defaultOutputModes: ["text"],
		skills: input.skills ?? [],
	};
}
