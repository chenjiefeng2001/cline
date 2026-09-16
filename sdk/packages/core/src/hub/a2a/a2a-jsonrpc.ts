/**
 * A2A JSON-RPC 2.0 dispatcher over the A2A server [P2-1 wiring, roadmap].
 *
 * The A2A protocol surface is JSON-RPC over HTTP: `message/send`,
 * `tasks/get`, `tasks/cancel`, `tasks/list`. This module owns the dispatch
 * (pure, testable against stub servers); the node:http mount lives in
 * `a2a-http.ts`. Per the A2A spec: task-not-found is a typed application
 * error (-32001), unknown methods are -32601, malformed params -32602.
 */

import type { A2AServer } from "./a2a-server";

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
/** A2A application error: task not found. */
export const A2A_TASK_NOT_FOUND = -32001;

/** Extracts the text of a request message (A2A text parts collapsed). */
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
		if (
			part &&
			typeof part === "object" &&
			((part as { kind?: unknown }).kind === "text" ||
				(part as { type?: unknown }).type === "text") &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			texts.push((part as { text: string }).text);
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
): (request: A2AJsonRpcRequest) => Promise<A2AJsonRpcResponse> {
	return async (request) => {
		const respond = (
			response: Omit<A2AJsonRpcResponse, "jsonrpc">,
		): A2AJsonRpcResponse => ({ jsonrpc: "2.0", ...response });
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
		try {
			switch (request.method) {
				case "message/send": {
					const prompt = extractA2ARequestPrompt(params);
					if (!prompt) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_JSONRPC_INVALID_PARAMS,
								message: "message/send requires message.parts text",
							},
						});
					}
					const task = await server.sendMessage({
						prompt,
						sessionId: extractA2ARequestSessionId(params),
						source: "a2a",
					});
					return respond({ id: request.id ?? null, result: task });
				}
				case "tasks/get": {
					const taskId =
						typeof params.id === "string" && params.id.trim()
							? params.id
							: undefined;
					if (!taskId) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_JSONRPC_INVALID_PARAMS,
								message: "tasks/get requires params.id",
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
				case "tasks/cancel": {
					const taskId =
						typeof params.id === "string" && params.id.trim()
							? params.id
							: undefined;
					if (!taskId) {
						return respond({
							id: request.id ?? null,
							error: {
								code: A2A_JSONRPC_INVALID_PARAMS,
								message: "tasks/cancel requires params.id",
							},
						});
					}
					const outcome = await server.cancelTask(taskId);
					return respond({ id: request.id ?? null, result: outcome });
				}
				case "tasks/list": {
					const limit =
						typeof params.limit === "number" && Number.isFinite(params.limit)
							? params.limit
							: undefined;
					const tasks = await server.listTasks(
						limit === undefined ? undefined : { limit },
					);
					return respond({ id: request.id ?? null, result: tasks });
				}
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
	};
}
