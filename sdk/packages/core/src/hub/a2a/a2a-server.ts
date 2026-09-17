/**
 * A2A server over the hub bus [roadmap P2-1].
 *
 * Exposes the hub session bus through A2A request semantics (per the P0-3
 * freeze mapping §3): `message/send` maps to `session.create` (new task) or
 * `session.send_input` (existing task); `tasks/get` maps to `session.get`;
 * `tasks/cancel` maps to `run.abort`; `tasks/list` maps to `session.list`.
 * The Agent Card is built from hub-derived capabilities.
 *
 * Transport-decoupled: handlers accept a structural hub command client
 * (`NodeHubClient` satisfies it), so HTTP/SSE wiring is a later slice and
 * tests run against stubs.
 */

import type { HubEventEnvelope } from "@cline/shared";
import {
	buildAgentCard,
	type MapSessionToTaskOptions,
	mapSessionToTask,
} from "./a2a-mapping";
import {
	type A2AStreamEvent,
	buildArtifactUpdateEvent,
	buildStatusUpdateEvent,
	isTerminalA2ATaskState,
	mapHubEventToStreamDelta,
} from "./a2a-sse";
import type { A2AAgentCard, A2AAgentSkill, A2ATask } from "./a2a-types";

export interface A2AHubCommandClient {
	command(
		command:
			| "session.list"
			| "session.create"
			| "session.get"
			| "session.send_input"
			| "run.abort",
		payload?: Record<string, unknown>,
		sessionId?: string,
	): Promise<unknown>;
}

/**
 * Event subscription surface the hub client satisfies (`NodeHubClient` and
 * `HubServerTransport` are both structural matches): a listener on the
 * `HubEventEnvelope` stream scoped to a session.
 */
export interface A2AHubEventClient {
	subscribe(
		listener: (event: HubEventEnvelope) => void,
		options?: { sessionId?: string },
	): () => void;
}

export interface A2AStreamOptions {
	/** Terminal A2A states end the stream; idle streams close after a timeout. */
	idleTimeoutMs?: number;
	onClose?: () => void;
}

export interface A2ASendMessageInput {
	/** User prompt (A2A message parts collapsed to text). */
	prompt: string;
	/** Existing task; when absent a new session/task is created. */
	sessionId?: string;
	/** Session config forwarded to `session.create` verbatim. */
	config?: Record<string, unknown>;
	/** Source marker for the created session metadata. */
	source?: string;
}

export interface A2AServerOptions {
	/** Agent Card identity; hub-derived capabilities are always set. */
	agentCard: {
		name: string;
		description?: string;
		url?: string;
		version: string;
		skills?: A2AAgentSkill[];
	};
}

/** Loose hub session projection used by the handlers. */
interface A2ASessionProjection {
	sessionId: string;
	status?: string;
	conversationId?: string;
	source?: string;
}

function extractPayload(reply: unknown): Record<string, unknown> | undefined {
	if (
		reply &&
		typeof reply === "object" &&
		"payload" in reply &&
		(reply as { payload?: unknown }).payload &&
		typeof (reply as { payload?: unknown }).payload === "object"
	) {
		return (reply as { payload: Record<string, unknown> }).payload;
	}
	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function extractSessionProjection(
	payload: Record<string, unknown> | undefined,
): A2ASessionProjection | undefined {
	const session =
		payload?.session && typeof payload.session === "object"
			? (payload.session as Record<string, unknown>)
			: undefined;
	const sessionId = asString(session?.sessionId);
	if (!session || !sessionId) {
		return undefined;
	}
	const metadata =
		session.metadata && typeof session.metadata === "object"
			? (session.metadata as Record<string, unknown>)
			: undefined;
	return {
		sessionId,
		status: asString(session.status),
		conversationId: asString(metadata?.conversationId),
		source: asString(metadata?.source),
	};
}

export class A2AServer {
	private readonly client: A2AHubCommandClient;
	private readonly events?: A2AHubEventClient;
	private readonly card: A2AAgentCard;

	constructor(
		client: A2AHubCommandClient,
		options: A2AServerOptions,
		events?: A2AHubEventClient,
	) {
		this.client = client;
		this.events = events;
		this.card = buildAgentCard({
			...options.agentCard,
			// The card reflects the real capability: without a bound event
			// source `message/stream` fails, so the card must not claim it.
			streaming: events !== undefined,
		});
	}

	/** A2A Agent Card (discovery document). */
	getAgentCard(): A2AAgentCard {
		return this.card;
	}

	/**
	 * A2A `message/send`: an existing task receives input via
	 * `session.send_input`; a new prompt creates a task via `session.create`
	 * (hub session + queued run).
	 */
	async sendMessage(input: A2ASendMessageInput): Promise<A2ATask | undefined> {
		if (input.sessionId) {
			await this.client.command(
				"session.send_input",
				{ prompt: input.prompt, ...(input.config ?? {}) },
				input.sessionId,
			);
			return mapSessionToTask(
				{ sessionId: input.sessionId, status: "running" },
				{ hasPendingApproval: false },
			);
		}
		const reply = await this.client.command("session.create", {
			metadata: {
				source: input.source ?? "a2a",
				prompt: input.prompt,
			},
			...(input.config ?? {}),
		});
		const projection = extractSessionProjection(extractPayload(reply));
		return mapSessionToTask(
			projection ? { status: "idle", ...projection } : undefined,
		);
	}

	/** A2A `tasks/get`: hub session projected onto the A2A lifecycle. */
	async getTask(sessionId: string): Promise<A2ATask | undefined> {
		const reply = await this.client.command(
			"session.get",
			undefined,
			sessionId,
		);
		const payload = extractPayload(reply);
		const projection = extractSessionProjection(payload);
		return mapSessionToTask(projection, {
			hasPendingApproval: payload?.pendingApproval === true,
		});
	}

	/**
	 * A2A `CancelTask`: aborts the hub run (`run.abort`). Returns the task
	 * after the abort; a missing task yields `undefined` (→ TaskNotFound)
	 * and an already-terminal task yields `{ canceled: false }` (→
	 * TaskNotCancelable per v1.0 §3.1.5).
	 */
	async cancelTask(
		sessionId: string,
	): Promise<{ canceled: boolean; task?: A2ATask }> {
		const before = await this.getTask(sessionId);
		if (!before) {
			return { canceled: false };
		}
		if (isTerminalA2ATaskState(before.status.state)) {
			return { canceled: false, task: before };
		}
		await this.client.command("run.abort", { sessionId }, sessionId);
		return { canceled: true, task: (await this.getTask(sessionId)) ?? before };
	}

	/**
	 * A2A `ListTasks`: hub sessions projected onto tasks. `pageSize` bounds
	 * the hub fetch; `contextId`/`status` filter the projected tasks. Hub
	 * sessions carry no cursor pagination, so `totalSize` is the filtered
	 * count and callers must leave `pageToken` empty (the dispatcher rejects
	 * it with InvalidParams).
	 */
	async listTasks(
		options?: {
			pageSize?: number;
			contextId?: string;
			status?: string;
		} & MapSessionToTaskOptions,
	): Promise<A2ATask[]> {
		const reply = await this.client.command("session.list", {
			limit: options?.pageSize ?? 200,
		});
		const sessions = Array.isArray(
			(reply as { payload?: { sessions?: unknown[] } }).payload?.sessions,
		)
			? ((reply as { payload: { sessions: Record<string, unknown>[] } }).payload
					.sessions as Record<string, unknown>[])
			: [];
		const tasks: A2ATask[] = [];
		for (const session of sessions) {
			const projection = extractSessionProjection({ session });
			const task = mapSessionToTask(projection, options);
			if (!task) {
				continue;
			}
			if (options?.contextId && task.contextId !== options.contextId) {
				continue;
			}
			if (options?.status && task.status.state !== options.status) {
				continue;
			}
			tasks.push(task);
		}
		return tasks;
	}

	/**
	 * A2A `message/stream` [P2-1 SSE]: sends the message exactly like
	 * `sendMessage`, then yields the session's hub event stream projected
	 * onto the A2A Task lifecycle (per the freeze mapping §3): the initial
	 * task snapshot first, then `TaskStatusUpdateEvent`s for every mapped hub
	 * event, ending after the first terminal state. The returned unsubscribe
	 * detaches the listener and stops the idle timer.
	 */
	async streamMessage(
		input: A2ASendMessageInput,
		onEvent: (event: A2AStreamEvent) => void,
		options: A2AStreamOptions = {},
	): Promise<() => void> {
		let task: A2ATask | undefined;
		try {
			task = await this.sendMessage(input);
		} catch (error) {
			options.onClose?.();
			throw error;
		}
		if (!task) {
			options.onClose?.();
			return () => {};
		}
		return this.streamTask(task.id, task, onEvent, options);
	}

	/** Whether an event source was bound at construction (SSE capability). */
	supportsStreaming(): boolean {
		return this.events !== undefined;
	}

	/**
	 * Streams an existing task: subscribes to the session's hub events and
	 * yields the initial task snapshot plus status updates until a terminal
	 * A2A state. Returns the unsubscribe function.
	 */
	streamTask(
		sessionId: string,
		task: A2ATask,
		onEvent: (event: A2AStreamEvent) => void,
		options: A2AStreamOptions = {},
	): () => void {
		if (!this.events) {
			options.onClose?.();
			return () => {};
		}
		let closed = false;
		let unsubscribe: (() => void) | undefined;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const contextId = task.contextId || sessionId;
		let sawArtifactText = false;
		const finish = (): void => {
			if (closed) {
				return;
			}
			closed = true;
			clearTimeout(idleTimer);
			try {
				unsubscribe?.();
			} finally {
				options.onClose?.();
			}
		};
		const emit = (event: A2AStreamEvent, final: boolean): void => {
			if (closed) {
				return;
			}
			try {
				onEvent(event);
			} catch (error) {
				finish();
				throw error;
			}
			if (final) {
				finish();
			}
		};
		const emitArtifact = (text: string, lastChunk: boolean): void => {
			emit(
				buildArtifactUpdateEvent(sessionId, text, {
					contextId,
					append: sawArtifactText,
					lastChunk,
				}),
				false,
			);
			sawArtifactText = true;
		};
		// Initial snapshot: the task as it stands when the stream opens.
		emit(task, isTerminalA2ATaskState(task.status.state));
		if (closed) {
			return () => {};
		}
		const armIdleTimer = (): void => {
			if (options.idleTimeoutMs === undefined) {
				return;
			}
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => finish(), options.idleTimeoutMs);
		};
		armIdleTimer();
		try {
			unsubscribe = this.events.subscribe(
				(event) => {
					if (closed) {
						return;
					}
					if (
						typeof event.sessionId === "string" &&
						event.sessionId !== sessionId
					) {
						return;
					}
					armIdleTimer();
					const mapping = mapHubEventToStreamDelta(event.event, event.payload);
					const state = mapping.statusState;
					if (mapping.artifactText !== undefined) {
						emitArtifact(mapping.artifactText, false);
					}
					if (!state) {
						return;
					}
					const final = isTerminalA2ATaskState(state);
					if (final && sawArtifactText) {
						emitArtifact("", true);
					}
					emit(buildStatusUpdateEvent(sessionId, state, contextId), final);
				},
				{ sessionId },
			);
			if (closed) {
				unsubscribe();
			}
		} catch (error) {
			finish();
			throw error;
		}
		return finish;
	}
}

export type {
	A2AStreamEvent,
	A2ATaskStatusUpdateEvent,
} from "./a2a-sse";
export type {
	A2AAgentCard,
	A2AAgentSkill,
	A2ATask,
	A2ATaskState,
} from "./a2a-types";
