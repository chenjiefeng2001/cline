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

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
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
	const dispatch = createA2AJsonRpcHandler(options.server);
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
				body = await readRequestBody(req);
			} catch {
				// JSON-RPC semantics: transport-level failures still answer with
				// an HTTP 200 carrying the error in the JSON-RPC envelope.
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
			sendJson(res, 200, response);
			return true;
		}
		return false;
	};
}
