/**
 * A2A JSON-RPC 2.0 dispatcher over the A2A server (v1.0 §9 binding).
 *
 * Canonical v1.0 method names are PascalCase (`SendMessage`,
 * `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`,
 * `SubscribeToTask`); push-notification and extended-card methods answer
 * with the v1 application errors because the hub mount implements neither.
 * Task-not-found is -32001, not-cancelable -32002, unsupported operation
 * -32004; unknown methods are -32601, malformed params -32602. This module
 * owns the dispatch (pure, testable against stub servers); the node:http
 * mount lives in `a2a-http.ts`.
 */

import type { A2AServer } from "./a2a-server";
import {
	A2A_SSE_CONTENT_TYPE,
	formatA2ASseFrame,
	isTerminalA2ATaskState,
} from "./a2a-sse";
import type { A2ATask } from "./a2a-types";

export interface A2AJsonRpcRequest {
	jsonrpc?: "2.0";
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

export interface A2AJsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface A2AJsonRpcResponse {
	jsonrpc: "2.0";
	id?: string | number | null;
	result?: unknown;
	error?: A2AJsonRpcError;
}

export const A2A_JSONRPC_PARSE_ERROR = -32700;
export const A2A_JSONRPC_INVALID_REQUEST = -32600;
export const A2A_JSONRPC_METHOD_NOT_FOUND = -32601;
export const A2A_JSONRPC_INVALID_PARAMS = -32602;
export const A2A_JSONRPC_INTERNAL_ERROR = -32603;
/** A2A application error: task not found (v1.0 §5.4). */
export const A2A_TASK_NOT_FOUND = -32001;
/** A2A application error: task not cancelable (v1.0 §5.4). */
export const A2A_TASK_NOT_CANCELABLE = -32002;
/** A2A application error: push notifications unsupported (v1.0 §5.4). */
export const A2A_PUSH_NOTIFICATION_NOT_SUPPORTED = -32003;
/** A2A application error: unsupported operation (v1.0 §5.4). */
export const A2A_UNSUPPORTED_OPERATION = -32004;
/** A2A application error: no extended agent card (v1.0 §5.4). */
export const A2A_EXTENDED_AGENT_CARD_NOT_CONFIGURED = -32007;

/**
 * Result marker for `message/stream`: the dispatch recognised a streaming
 * request and the transport must answer with an SSE response, not a JSON-RPC
 * envelope. Carries the subscription canceler and the framed event source.
 */
export interface A2AJsonRpcStreamResult {
	/** Marker property distinguishing a streaming result. */
	stream: true;
	contentType: typeof A2A_SSE_CONTENT_TYPE;
	/** Writes `data: <json>\n\n` per event until the source closes. */
	subscribe(
		onFrame: (frame: string) => void,
		onClose: (error?: Error) => void,
	): () => void;
}

/**
 * Extracts the text of a request message (A2A parts collapsed). Accepts v1.0
 * oneOf parts (`{ text }`) as well as the pre-v1 `kind`/`type` discriminated
 * text parts, so older clients keep working against the v1 wire values we
 * emit.
 */
export function extractA2ARequestPrompt(
	params: Record<string, unknown> | undefined,
): string | undefined {
	const message =
		params?.message && typeof params.message === "object"
			? (params.message as Record<string, unknown>)
			: undefined;
	const parts = Array.isArray(message?.parts) ? message.parts : [];
	const texts: string[] = [];
	for (const part of parts) {
		if (!part || typeof part !== "object") {
			continue;
		}
		const text = (part as { text?: unknown }).text;
		if (typeof text !== "string") {
			continue;
		}
		const kind = (part as { kind?: unknown }).kind;
		const type = (part as { type?: unknown }).type;
		if (
			(kind === undefined || kind === "text") &&
			(type === undefined || type === "text")
		) {
			texts.push(text);
		}
	}
	const prompt = texts.join("\n").trim();
	return prompt || undefined;
}

/** Extracts the task/context id of a request message, when present. */
export function extractA2ARequestSessionId(
	params: Record<string, unknown> | undefined,
): string | undefined {
	const message =
		params?.message && typeof params.message === "object"
			? (params.message as Record<string, unknown>)
			: undefined;
	for (const key of ["taskId", "contextId", "sessionId"]) {
		const value = message?.[key];
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}
	return undefined;
}

function asError(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/**
 * Builds a JSON-RPC 2.0 dispatcher over the A2A server. The dispatcher is
 * pure (request object in, response object out) so the HTTP mount, tests,
 * and future transports share one dispatch implementation.
 */
export function createA2AJsonRpcHandler(
	server: A2AServer,
	options: { idleTimeoutMs?: number } = {},
): (
	request: A2AJsonRpcRequest,
) => Promise<A2AJsonRpcResponse | A2AJsonRpcStreamResult> {
	return async (request) => {
		const respond = (
			response: Omit<A2AJsonRpcResponse, "jsonrpc">,
		): A2AJsonRpcResponse => ({ jsonrpc: "2.0", ...response });
		if (!request || typeof request !== "object" || Array.isArray(request)) {
			return respond({
				id: null,
				error: {
					code: A2A_JSONRPC_INVALID_REQUEST,
					message: "invalid request",
				},
			});
		}
		if (typeof request.method !== "string" || !request.method) {
			return respond({
				id: request.id ?? null,
				error: {
					code: A2A_JSONRPC_INVALID_REQUEST,
					message: "invalid request: missing method",
				},
			});
		}
		const params = request.params ?? {};
		const stringParam = (key: string): string | undefined => {
			const value = (params as Record<string, unknown>)[key];
			return typeof value === "string" && value.trim() ? value : undefined;
		};
		// v1.0 §9.4.2: every SSE frame is a full JSON-RPC envelope carrying
		// the stream event as `result`, so generic clients can reuse their
		// response path for streamed events.
		const frameStreamEvent = (event: unknown): string =>
			formatA2ASseFrame({
				jsonrpc: "2.0",
				id: request.id ?? null,
				result: event,
			});
		try {
			switch (request.method) {
				case "SendStreamingMessage":
				case "SubscribeToTask": {
					const isSubscribe = request.method === "SubscribeToTask";
					if (!server.supportsStreaming()) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_UNSUPPORTED_OPERATION,
								message: "streaming unavailable: no event source bound",
							},
						});
					}
					if (isSubscribe) {
						const taskId = stringParam("id");
						if (!taskId) {
							return respond({
								id: request.id ?? null,
								error: {
									code: A2A_JSONRPC_INVALID_PARAMS,
									message: "SubscribeToTask requires params.id",
								},
							});
						}
						const existing = await server.getTask(taskId);
						if (!existing) {
							return respond({
								id: request.id ?? null,
								error: {
									code: A2A_TASK_NOT_FOUND,
									message: `task not found: ${taskId}`,
								},
							});
						}
						if (isTerminalA2ATaskState(existing.status.state)) {
							return respond({
								id: request.id ?? null,
								error: {
									code: A2A_UNSUPPORTED_OPERATION,
									message: `task is in a terminal state: ${existing.status.state}`,
								},
							});
						}
						return openTaskStream(existing.id, existing);
					}
					const prompt = extractA2ARequestPrompt(params);
					if (!prompt) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_JSONRPC_INVALID_PARAMS,
								message: "SendStreamingMessage requires message.parts text",
							},
						});
					}
					let task: A2ATask | undefined;
					try {
						task = await server.sendMessage({
							prompt,
							sessionId: extractA2ARequestSessionId(params),
							source: "a2a",
						});
					} catch (error) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_JSONRPC_INTERNAL_ERROR,
								message: asError(error),
							},
						});
					}
					if (!task) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_JSONRPC_INTERNAL_ERROR,
								message: "failed to create task",
							},
						});
					}
					return openTaskStream(task.id, task);
				}
				case "SendMessage": {
					const prompt = extractA2ARequestPrompt(params);
					if (!prompt) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_JSONRPC_INVALID_PARAMS,
								message: "SendMessage requires message.parts text",
							},
						});
					}
					const task = await server.sendMessage({
						prompt,
						sessionId: extractA2ARequestSessionId(params),
						source: "a2a",
					});
					if (!task) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_JSONRPC_INTERNAL_ERROR,
								message: "failed to create task",
							},
						});
					}
					return respond({ id: request.id ?? null, result: { task } });
				}
				case "GetTask": {
					const taskId = stringParam("id");
					if (!taskId) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_JSONRPC_INVALID_PARAMS,
								message: "GetTask requires params.id",
							},
						});
					}
					const task = await server.getTask(taskId);
					if (!task) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_TASK_NOT_FOUND,
								message: `task not found: ${taskId}`,
							},
						});
					}
					return respond({ id: request.id ?? null, result: task });
				}
				case "CancelTask": {
					const taskId = stringParam("id");
					if (!taskId) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_JSONRPC_INVALID_PARAMS,
								message: "CancelTask requires params.id",
							},
						});
					}
					const outcome = await server.cancelTask(taskId);
					if (!outcome.task) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_TASK_NOT_FOUND,
								message: `task not found: ${taskId}`,
							},
						});
					}
					if (!outcome.canceled) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_TASK_NOT_CANCELABLE,
								message: `task is not cancelable: ${outcome.task.status.state}`,
							},
						});
					}
					return respond({ id: request.id ?? null, result: outcome.task });
				}
				case "ListTasks": {
					// The hub bus has no cursor pagination: pageSize bounds the
					// fetch and nextPageToken is always empty. A non-empty
					// pageToken is rejected instead of silently ignored.
					const pageToken = stringParam("pageToken");
					if (pageToken) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_JSONRPC_INVALID_PARAMS,
								message: "ListTasks pagination (pageToken) is not supported",
							},
						});
					}
					const pageSize =
						typeof params.pageSize === "number" &&
						Number.isFinite(params.pageSize)
							? params.pageSize
							: undefined;
					const tasks = await server.listTasks({
						pageSize,
						contextId: stringParam("contextId"),
						status: stringParam("status"),
					});
					return respond({
						id: request.id ?? null,
						result: {
							tasks,
							nextPageToken: "",
							pageSize: pageSize ?? 200,
							totalSize: tasks.length,
						},
					});
				}
				case "CreateTaskPushNotificationConfig":
				case "GetTaskPushNotificationConfig":
				case "ListTaskPushNotificationConfigs":
				case "DeleteTaskPushNotificationConfig":
					return respond({
						id: request.id ?? null,
						error: {
							code: A2A_PUSH_NOTIFICATION_NOT_SUPPORTED,
							message: "push notifications are not supported",
						},
					});
				case "GetExtendedAgentCard":
					return respond({
						id: request.id ?? null,
						error: {
							code: A2A_EXTENDED_AGENT_CARD_NOT_CONFIGURED,
							message: "no extended agent card is configured",
						},
					});
				default:
					return respond({
						id: request.id ?? null,
						error: {
							code: A2A_JSONRPC_METHOD_NOT_FOUND,
							message: `method not found: ${request.method}`,
						},
					});
			}
		} catch (error) {
			return respond({
				id: request.id ?? null,
				error: {
					code: A2A_JSONRPC_INTERNAL_ERROR,
					message: asError(error),
				},
			});
		}

		function openTaskStream(
			sessionId: string,
			task: A2ATask,
		): A2AJsonRpcStreamResult {
			return {
				stream: true,
				contentType: A2A_SSE_CONTENT_TYPE,
				subscribe(onFrame, onClose) {
					let done = false;
					const finish = (error?: Error): void => {
						if (done) {
							return;
						}
						done = true;
						cancel?.();
						onClose?.(error);
					};
					let cancel: (() => void) | undefined;
					try {
						cancel = server.streamTask(
							sessionId,
							task,
							(event) => {
								if (done) {
									return;
								}
								try {
									onFrame(frameStreamEvent(event));
								} catch (error) {
									finish(
										error instanceof Error ? error : new Error(String(error)),
									);
								}
							},
							{
								idleTimeoutMs: options.idleTimeoutMs,
								onClose: () => finish(),
							},
						);
						if (done) {
							cancel();
						}
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
					return () => finish();
				},
			};
		}
	};
}
