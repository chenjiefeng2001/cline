/**
 * A2A SSE streaming helpers — `message/stream` over the HTTP mount [roadmap
 * P2-1 wiring].
 *
 * Per the P0-3 freeze mapping (§3), `message/stream` maps to
 * `stream.subscribe` + `assistant.delta` / `reasoning.delta` / `tool.*` —
 * the hub event stream projects directly onto the A2A Task lifecycle:
 * `run.started`/`run.heartbeat` → `working`, `approval.requested` →
 * `input-required` (the natural HITL fit), `run.completed`/`run.failed`/
 * `run.aborted` → `completed`/`failed`/`canceled` (terminal).
 *
 * Pure functions per the freeze doc: framing + event mapping live here so
 * the server handlers, the HTTP mount, and tests share one implementation.
 */

import type { A2ATask, A2ATaskState } from "./a2a-types";

/** SSE content type for streaming responses (`message/stream`). */
export const A2A_SSE_CONTENT_TYPE = "text/event-stream";

/**
 * A2A TaskStatusUpdateEvent: a streamed status transition for a task
 * (`kind: "status-update"` per the A2A spec). Terminal states carry
 * `final: true`; the stream closes after the final event.
 */
export interface A2ATaskStatusUpdateEvent {
	kind: "status-update";
	taskId: string;
	/** Correlates tasks of one conversation; hub session id. */
	contextId: string;
	status: {
		state: A2ATaskState;
		timestamp?: string;
	};
	final: boolean;
}

/** Streamed event payloads: the initial task snapshot or a status update. */
export type A2AStreamEvent =
	| A2ATask
	| A2ATaskStatusUpdateEvent
	| A2AArtifactUpdateEvent;

export interface A2AArtifactUpdateEvent {
	kind: "artifact-update";
	taskId: string;
	contextId: string;
	artifact: {
		artifactId: string;
		name?: string;
		parts: Array<{ kind: "text"; text: string }>;
	};
	append: boolean;
	lastChunk: boolean;
}

/**
 * Maps a hub event name onto the A2A Task state machine (per the frozen
 * freeze mapping §3). Progress events (`assistant.delta`, `reasoning.delta`,
 * `tool.*`) and run lifecycle (`run.started`/`run.heartbeat`) map to
 * `working`; `approval.requested` maps to `input-required` with
 * `approval.resolved` as the natural inverse; the run terminals map onto the
 * A2A terminal states. Events without a task-state mapping return undefined
 * (no status-update emitted).
 */
export function mapHubEventToTaskState(
	event: string | undefined,
): A2ATaskState | undefined {
	switch (event) {
		case "run.started":
		case "run.heartbeat":
		case "assistant.delta":
		case "reasoning.delta":
		case "tool.started":
		case "tool.updated":
		case "tool.finished":
		case "approval.resolved":
			return "working";
		case "approval.requested":
			return "input-required";
		case "run.completed":
			return "completed";
		case "run.failed":
			return "failed";
		case "run.aborted":
			return "canceled";
		default:
			return undefined;
	}
}

/** Whether a task state ends the stream (A2A terminal states). */
export function isTerminalA2ATaskState(state: A2ATaskState): boolean {
	return state === "completed" || state === "failed" || state === "canceled";
}

/**
 * Builds a TaskStatusUpdateEvent. `contextId` defaults to the task id (the
 * hub session id correlates both per the freeze mapping).
 */
export function buildStatusUpdateEvent(
	taskId: string,
	state: A2ATaskState,
	final: boolean,
	contextId?: string,
): A2ATaskStatusUpdateEvent {
	return {
		kind: "status-update",
		taskId,
		contextId: contextId ?? taskId,
		status: {
			state,
			timestamp: new Date().toISOString(),
		},
		final,
	};
}

export function buildArtifactUpdateEvent(
	taskId: string,
	text: string,
	options?: { append?: boolean; lastChunk?: boolean; contextId?: string },
): A2AArtifactUpdateEvent {
	return {
		kind: "artifact-update",
		taskId,
		contextId: options?.contextId ?? taskId,
		artifact: {
			artifactId: `${taskId}:output`,
			name: "output",
			parts: [{ kind: "text", text }],
		},
		append: options?.append ?? false,
		lastChunk: options?.lastChunk ?? false,
	};
}

export interface A2ADeltaMapping {
	statusState?: A2ATaskState;
	artifactText?: string;
}

export function mapHubEventToStreamDelta(
	event: string | undefined,
	payload: Record<string, unknown> | undefined,
): A2ADeltaMapping {
	const state = mapHubEventToTaskState(event);
	const mapping: A2ADeltaMapping = state ? { statusState: state } : {};
	if (event === "assistant.delta") {
		const text = payload?.text;
		if (typeof text === "string" && text.length > 0) {
			mapping.artifactText = text;
		}
	}
	return mapping;
}

/**
 * Frames one SSE event: `data: <json>\n\n`. JSON.stringify output contains
 * no raw newlines, so a single `data:` line is always well-formed.
 */
export function formatA2ASseFrame(data: unknown): string {
	return `data: ${JSON.stringify(data)}\n\n`;
}
