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
	buildStatusUpdateEvent,
	isTerminalA2ATaskState,
	mapHubEventToTaskState,
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
		this.card = buildAgentCard(options.agentCard);
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

	/** A2A `tasks/cancel`: aborts the hub run (`run.abort`). */
	async cancelTask(sessionId: string): Promise<{ canceled: boolean }> {
		await this.client.command("run.abort", { sessionId }, sessionId);
		return { canceled: true };
	}

	/** A2A `tasks/list`: all hub sessions projected onto tasks. */
	async listTasks(
		options?: {
			limit?: number;
		} & MapSessionToTaskOptions,
	): Promise<A2ATask[]> {
		const reply = await this.client.command("session.list", {
			limit: options?.limit ?? 200,
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
			if (task) {
				tasks.push(task);
			}
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
		const task = await this.sendMessage(input);
		const sessionId = task?.id;
		if (!sessionId || !this.events) {
			return () => {};
		}
		return this.streamTask(sessionId, task, onEvent, options);
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
			return () => {};
		}
		let closed = false;
		let unsubscribe = () => {};
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (): void => {
			if (closed) {
				return;
			}
			closed = true;
			clearTimeout(idleTimer);
			unsubscribe();
		};
		const emit = (event: A2AStreamEvent, final: boolean): void => {
			if (closed) {
				return;
			}
			onEvent(event);
			if (final) {
				finish();
			}
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
		unsubscribe = this.events.subscribe(
			(event) => {
				armIdleTimer();
				const state = mapHubEventToTaskState(event.event);
				if (!state) {
					return;
				}
				emit(
					buildStatusUpdateEvent(
						sessionId,
						state,
						isTerminalA2ATaskState(state),
						event.sessionId,
					),
					isTerminalA2ATaskState(state),
				);
			},
			{ sessionId },
		);
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
