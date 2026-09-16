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

import {
	buildAgentCard,
	type MapSessionToTaskOptions,
	mapSessionToTask,
} from "./a2a-mapping";
import type {
	A2AAgentCard,
	A2AAgentSkill,
	A2ATask,
	A2ATaskState,
} from "./a2a-types";

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
	private readonly card: A2AAgentCard;

	constructor(client: A2AHubCommandClient, options: A2AServerOptions) {
		this.client = client;
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
}

export type { A2AAgentCard, A2AAgentSkill, A2ATask, A2ATaskState };
