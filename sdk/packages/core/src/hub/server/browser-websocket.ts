import type {
	HubClientRegistration,
	HubEventEnvelope,
	HubReplyEnvelope,
	HubTransportFrame,
	ITelemetryService,
} from "@cline/shared";
import {
	captureSdkError,
	createSessionId,
	HUB_COMMAND_SLOW_LOG_MS,
	resolveHubCommandTimeoutMs,
	safeJsonParse,
} from "@cline/shared";
import type { HubCommandTransport } from "./command-transport";
import { logHubMessage } from "./hub-server-logging";

type HubCommandFrame = HubTransportFrame & { kind: "command" };
type HubStreamFrame = Extract<
	HubTransportFrame,
	{ kind: "stream.subscribe" | "stream.unsubscribe" }
>;

/**
 * Commands a connection may issue before it has registered a client identity.
 * Everything else needs a bound identity, because every downstream handler
 * authorizes on `envelope.clientId` and that value used to be self-reported.
 */
const PRE_REGISTRATION_COMMANDS: ReadonlySet<string> = new Set([
	"client.register",
]);

export const HUB_UNREGISTERED_CLIENT_ERROR = "hub_unregistered_client";
export const HUB_CLIENT_ID_MISMATCH_ERROR = "hub_client_id_mismatch";
export const HUB_CLIENT_ID_TAKEN_ERROR = "hub_client_id_taken";

export interface BrowserHubSocketLike {
	send(data: string): void;
	addEventListener(
		type: "message",
		listener: (event: { data: string }) => void,
	): void;
	addEventListener(type: "close", listener: () => void): void;
	removeEventListener(
		type: "message",
		listener: (event: { data: string }) => void,
	): void;
	removeEventListener(type: "close", listener: () => void): void;
}

function commandLogContext(frame: HubCommandFrame) {
	return {
		command: frame.envelope.command,
		requestId: frame.envelope.requestId,
		clientId: frame.envelope.clientId,
		sessionId: frame.envelope.sessionId,
	};
}

function commandErrorReply(
	frame: HubCommandFrame,
	code: string,
	message: string,
): HubReplyEnvelope {
	return {
		version: frame.envelope.version,
		requestId: frame.envelope.requestId,
		ok: false,
		error: { code, message },
	};
}

/**
 * Per-connection identity binding.
 *
 * The websocket upgrade already proved the connection holds the hub bearer
 * token, so the connection itself is the principal. What it must not be able to
 * do is *name* that principal: `envelope.clientId` arrives from the wire, and
 * every session/approval/subscription handler authorizes on it. This object
 * records which client identity the connection registered as, and rewrites
 * inbound envelopes to that identity so a client cannot act as — or subscribe
 * on behalf of — anyone else.
 */
export class ConnectionIdentity {
	private boundClientId: string | undefined;

	constructor(readonly connectionId: string) {}

	get clientId(): string | undefined {
		return this.boundClientId;
	}

	bind(clientId: string): void {
		this.boundClientId = clientId;
	}

	release(): void {
		this.boundClientId = undefined;
	}

	/**
	 * Authorize one inbound command frame. Returns the envelope to dispatch, or
	 * an error reply when the connection is not allowed to issue it.
	 */
	authorizeCommand(frame: HubCommandFrame): HubReplyEnvelope | undefined {
		const claimed = frame.envelope.clientId?.trim() ?? "";
		if (!this.boundClientId) {
			if (!PRE_REGISTRATION_COMMANDS.has(frame.envelope.command)) {
				return commandErrorReply(
					frame,
					HUB_UNREGISTERED_CLIENT_ERROR,
					`Command ${frame.envelope.command} requires a registered client identity on this connection.`,
				);
			}
			return undefined;
		}
		if (claimed && claimed !== this.boundClientId) {
			return commandErrorReply(
				frame,
				HUB_CLIENT_ID_MISMATCH_ERROR,
				`This connection is bound to client ${this.boundClientId} and cannot act as ${claimed}.`,
			);
		}
		if (frame.envelope.clientId !== this.boundClientId) {
			// Rewrite rather than reject: a client that omits the field is
			// claiming the identity it already proved, not a different one.
			frame.envelope.clientId = this.boundClientId;
		}
		return undefined;
	}

	/** Authorize a stream frame and return the client id it may act as. */
	authorizeStream(frame: HubStreamFrame): string | HubReplyEnvelope {
		const claimed = frame.clientId?.trim() ?? "";
		if (!this.boundClientId) {
			return streamDenial(
				HUB_UNREGISTERED_CLIENT_ERROR,
				"Event subscription requires a registered client identity on this connection.",
			);
		}
		if (claimed && claimed !== this.boundClientId) {
			return streamDenial(
				HUB_CLIENT_ID_MISMATCH_ERROR,
				`This connection is bound to client ${this.boundClientId} and cannot subscribe as ${claimed}.`,
			);
		}
		return this.boundClientId;
	}
}

/**
 * Stream frames carry no request id, so a denial is reported with a synthetic
 * one. Clients correlate denials by error code, not by request id.
 */
function streamDenial(code: string, message: string): HubReplyEnvelope {
	return {
		version: "v1",
		requestId: createSessionId("hreq_"),
		ok: false,
		error: { code, message },
	};
}

export class BrowserWebSocketHubAdapter {
	constructor(
		private readonly transport: HubCommandTransport,
		private readonly telemetry?: ITelemetryService,
	) {}

	/**
	 * Attach one authenticated connection. `connectionId` is the server-issued
	 * principal for this socket: it is minted by the upgrade path, stamped onto
	 * every dispatched command, and used to prove a client identity is not shared
	 * with another live connection.
	 */
	attach(socket: BrowserHubSocketLike, connectionId?: string): () => void {
		const subscriptions = new Map<string, () => void>();
		const identity = new ConnectionIdentity(
			connectionId?.trim() || createSessionId("hconn_"),
		);
		let closed = false;

		const sendFrame = (frame: HubTransportFrame): void => {
			try {
				socket.send(JSON.stringify(frame));
			} catch (error) {
				console.error(
					`[hub] failed to send websocket frame: ${
						error instanceof Error
							? error.stack || error.message
							: String(error)
					}`,
				);
			}
		};

		const onEvent = (envelope: HubEventEnvelope): void => {
			sendFrame({ kind: "event", envelope });
		};

		const onMessage = async (event: { data: string }): Promise<void> => {
			try {
				const frame = JSON.parse(event.data) as HubTransportFrame;
				switch (frame.kind) {
					case "command": {
						const denied = identity.authorizeCommand(frame);
						if (denied) {
							logHubMessage("warn", "command.denied", {
								...commandLogContext(frame),
								connectionId: identity.connectionId,
								errorCode: denied.error?.code,
							});
							captureSdkError(this.telemetry, {
								component: "core",
								operation: "hub.unauthorized_command",
								error: new Error(denied.error?.message ?? "Unauthorized"),
								severity: "warn",
								handled: true,
								context: {
									...commandLogContext(frame),
									connectionId: identity.connectionId,
								},
							});
							sendFrame({ kind: "reply", envelope: denied });
							break;
						}
						const startedAt = performance.now();
						let settled = false;
						const context = commandLogContext(frame);
						logHubMessage("info", "command.start", context);
						const slowTimer = setTimeout(() => {
							if (settled) return;
							logHubMessage("warn", "command.slow", {
								...context,
								elapsedMs: Math.round(performance.now() - startedAt),
							});
						}, HUB_COMMAND_SLOW_LOG_MS);
						const commandPromise = this.transport.command(frame.envelope, {
							connectionId: identity.connectionId,
						});
						commandPromise.then(
							(lateReply) => {
								if (!settled) return;
								logHubMessage(
									lateReply.ok ? "warn" : "error",
									"command.late_end",
									{
										...context,
										elapsedMs: Math.round(performance.now() - startedAt),
										ok: lateReply.ok,
										errorCode: lateReply.error?.code,
										errorMessage: lateReply.error?.message,
									},
								);
							},
							(error) => {
								if (!settled) return;
								logHubMessage("error", "command.late_error", {
									...context,
									elapsedMs: Math.round(performance.now() - startedAt),
									error,
								});
							},
						);
						let timedOut = false;
						let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
						let reply: HubReplyEnvelope;
						const timeoutMs = resolveHubCommandTimeoutMs(
							frame.envelope.command,
							frame.envelope.timeoutMs,
						);
						try {
							reply =
								timeoutMs === null
									? await commandPromise
									: await Promise.race([
											commandPromise,
											new Promise<HubReplyEnvelope>((resolve) => {
												timeoutTimer = setTimeout(() => {
													timedOut = true;
													captureSdkError(this.telemetry, {
														component: "core",
														operation: "hub.command_timeout",
														error: new Error(
															`Hub command ${frame.envelope.command} did not complete within ${timeoutMs}ms.`,
														),
														severity: "error",
														handled: true,
														context: {
															...context,
															timeoutMs,
														},
													});
													resolve(
														commandErrorReply(
															frame,
															"hub_command_timeout",
															`Hub command ${frame.envelope.command} did not complete within ${timeoutMs}ms. Check hub-daemon.log for command.start/command.slow logs with requestId ${frame.envelope.requestId}.`,
														),
													);
												}, timeoutMs);
											}),
										]);
						} catch (error) {
							clearTimeout(slowTimer);
							if (timeoutTimer) clearTimeout(timeoutTimer);
							throw error;
						}
						settled = timedOut;
						clearTimeout(slowTimer);
						if (timeoutTimer) clearTimeout(timeoutTimer);
						const durationMs = Math.round(performance.now() - startedAt);
						if (timedOut) {
							logHubMessage("error", "command.timeout", {
								...context,
								durationMs,
								timeoutMs,
							});
						} else {
							logHubMessage(reply.ok ? "info" : "warn", "command.end", {
								...context,
								durationMs,
								ok: reply.ok,
								errorCode: reply.error?.code,
								errorMessage: reply.error?.message,
							});
						}
						if (frame.envelope.command === "client.register" && reply.ok) {
							const registration = (frame.envelope.payload ??
								{}) as unknown as HubClientRegistration;
							const clientId =
								registration.clientId?.trim() ||
								frame.envelope.clientId?.trim() ||
								(reply.payload as { clientId?: string } | undefined)?.clientId;
							if (clientId) {
								identity.bind(clientId);
							}
						} else if (
							frame.envelope.command === "client.unregister" &&
							reply.ok
						) {
							identity.release();
						}
						sendFrame({
							kind: "reply",
							envelope: reply satisfies HubReplyEnvelope,
						});
						break;
					}
					case "stream.subscribe": {
						const authorized = identity.authorizeStream(frame);
						if (typeof authorized !== "string") {
							sendFrame({ kind: "reply", envelope: authorized });
							break;
						}
						frame.clientId = authorized;
						const key = `${frame.clientId}:${frame.sessionId ?? "*"}`;
						if (subscriptions.has(key)) {
							break;
						}
						const unsubscribe = await this.transport.subscribe(
							frame.clientId,
							onEvent,
							{ sessionId: frame.sessionId },
						);
						subscriptions.set(key, unsubscribe);
						break;
					}
					case "stream.unsubscribe": {
						const authorized = identity.authorizeStream(frame);
						if (typeof authorized !== "string") {
							sendFrame({ kind: "reply", envelope: authorized });
							break;
						}
						frame.clientId = authorized;
						const key = `${frame.clientId}:${frame.sessionId ?? "*"}`;
						subscriptions.get(key)?.();
						subscriptions.delete(key);
						break;
					}
					case "reply":
					case "event":
						break;
				}
			} catch (error) {
				const parsed =
					typeof event.data === "string"
						? safeJsonParse<HubTransportFrame>(event.data)
						: undefined;
				if (!parsed || parsed.kind !== "command") {
					logHubMessage("error", "rejected malformed websocket frame", {
						error,
					});
					return;
				}
				logHubMessage("error", "command.error", {
					...commandLogContext(parsed),
					error,
				});
				captureSdkError(this.telemetry, {
					component: "core",
					operation: "hub.websocket_command",
					error,
					severity: "error",
					handled: true,
					context: commandLogContext(parsed),
				});
				sendFrame({
					kind: "reply",
					envelope: commandErrorReply(
						parsed,
						"command_failed",
						error instanceof Error ? error.message : "Unknown hub error",
					),
				});
			}
		};

		const onClose = (): void => {
			if (closed) {
				return;
			}
			closed = true;
			for (const unsubscribe of subscriptions.values()) {
				unsubscribe();
			}
			subscriptions.clear();
			const clientId = identity.clientId;
			if (clientId) {
				void this.transport.command(
					{
						version: "v1",
						command: "client.unregister",
						clientId,
					},
					{ connectionId: identity.connectionId },
				);
			}
			identity.release();
			socket.removeEventListener("message", onMessage);
			socket.removeEventListener("close", onClose);
		};

		socket.addEventListener("message", onMessage);
		socket.addEventListener("close", onClose);

		return onClose;
	}
}
