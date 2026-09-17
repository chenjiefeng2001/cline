/**
 * A2A HTTP mount — wires the A2A server into a node:http server [P2-1
 * wiring, roadmap].
 *
 * Follows the hub-websocket-server handler pattern: a mountable
 * `(req, res)` handler for `http.createServer`. Endpoints per the A2A spec:
 * GET `<basePath>/.well-known/agent.json` serves the Agent Card (discovery
 * document); POST `<basePath>` dispatches JSON-RPC 2.0 requests.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { type A2AJsonRpcRequest, createA2AJsonRpcHandler } from "./a2a-jsonrpc";
import type { A2AServer } from "./a2a-server";

export const A2A_AGENT_CARD_WELL_KNOWN_PATH = ".well-known/agent.json";

export interface A2AHttpMountOptions {
	server: A2AServer;
	/** Base path for the A2A endpoint. Defaults to "/a2a". */
	basePath?: string;
	maxBodyBytes?: number;
	heartbeatIntervalMs?: number;
	idleTimeoutMs?: number;
}

function normalizeBasePath(basePath: string): string {
	const trimmed = basePath.replace(/\/+$/, "");
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}

class RequestBodyTooLargeError extends Error {}

function readRequestBody(
	req: IncomingMessage,
	maxBodyBytes: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer: Buffer | undefined;
		let size = 0;
		const cleanup = (): void => {
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
			req.off("aborted", onAborted);
			buffer = undefined;
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onAborted = (): void => {
			onError(new Error("request aborted"));
		};
		const onData = (chunk: Buffer): void => {
			if (chunk.length > maxBodyBytes - size) {
				req.pause();
				onError(new RequestBodyTooLargeError("request body too large"));
				return;
			}
			buffer ??= Buffer.allocUnsafe(maxBodyBytes);
			chunk.copy(buffer, size);
			size += chunk.length;
		};
		const onEnd = (): void => {
			const body = buffer?.toString("utf8", 0, size) ?? "";
			cleanup();
			resolve(body);
		};
		if (req.aborted || req.destroyed) {
			onAborted();
			return;
		}
		if (Number(req.headers["content-length"]) > maxBodyBytes) {
			onError(new RequestBodyTooLargeError("request body too large"));
			return;
		}
		req.on("data", onData);
		req.once("end", onEnd);
		req.once("error", onError);
		req.once("aborted", onAborted);
	});
}

/**
 * Mounts the A2A HTTP handler. Returns a standard `(req, res)` handler;
 * returns `false`-like control is not needed — hosts that mount multiple
 * handlers chain them (call this one first, fall through when it returns
 * false).
 */
export function mountA2AHttpHandler(
	options: A2AHttpMountOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
	const basePath = normalizeBasePath(options.basePath ?? "/a2a");
	const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
	const dispatch = createA2AJsonRpcHandler(options.server, {
		idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
	});
	return async (req, res) => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		let pathname = requestUrl.pathname.replace(/\/+$/, "");
		if (!pathname) {
			pathname = "/";
		}
		// Agent Card discovery document.
		if (
			req.method === "GET" &&
			pathname === `${basePath}/${A2A_AGENT_CARD_WELL_KNOWN_PATH}`
		) {
			sendJson(res, 200, options.server.getAgentCard());
			return true;
		}
		// JSON-RPC 2.0 over POST.
		if (req.method === "POST" && pathname === basePath) {
			let body: string;
			try {
				body = await readRequestBody(req, maxBodyBytes);
			} catch (error) {
				if (req.aborted || res.destroyed) {
					return true;
				}
				if (error instanceof RequestBodyTooLargeError) {
					req.resume();
					sendJson(res, 413, { error: "request body too large" });
					return true;
				}
				sendJson(res, 200, {
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "failed to read request body" },
				});
				return true;
			}
			let request: A2AJsonRpcRequest;
			try {
				request = JSON.parse(body) as A2AJsonRpcRequest;
			} catch {
				sendJson(res, 200, {
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "parse error" },
				});
				return true;
			}
			const response = await dispatch(request);
			if ("stream" in response && response.stream === true) {
				if (req.aborted || res.destroyed) {
					return true;
				}
				res.statusCode = 200;
				res.setHeader("content-type", response.contentType);
				res.setHeader("cache-control", "no-cache");
				res.setHeader("connection", "keep-alive");
				let closed = false;
				let cancel: (() => void) | undefined;
				let heartbeat: ReturnType<typeof setInterval> | undefined;
				const close = (): void => {
					if (closed) {
						return;
					}
					closed = true;
					clearInterval(heartbeat);
					res.off("close", close);
					res.off("error", close);
					req.off("aborted", close);
					try {
						cancel?.();
					} finally {
						if (!res.destroyed && !res.writableEnded) {
							res.end();
						}
					}
				};
				const write = (frame: string): void => {
					if (closed) {
						return;
					}
					try {
						res.write(frame);
					} catch {
						close();
					}
				};
				res.on("close", close);
				res.on("error", close);
				req.on("aborted", close);
				try {
					res.flushHeaders();
					cancel = response.subscribe(write, close);
					if (closed) {
						cancel();
					} else if (heartbeatIntervalMs > 0) {
						heartbeat = setInterval(
							() => write(": ping\n\n"),
							heartbeatIntervalMs,
						);
						heartbeat.unref();
					}
				} catch {
					close();
				}
				return true;
			}
			sendJson(res, 200, response);
			return true;
		}
		return false;
	};
}
