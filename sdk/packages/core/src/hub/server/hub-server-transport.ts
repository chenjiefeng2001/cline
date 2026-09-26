import type {
	HubClientRecord,
	HubCommandEnvelope,
	HubEventEnvelope,
	HubReplyEnvelope,
	ToolApprovalRequest,
} from "@cline/shared";
import { captureSdkError, createSessionId } from "@cline/shared";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { CronService } from "../../cron/service/cron-service";
import { HubScheduleCommandService } from "../../cron/service/schedule-command-service";
import { HubScheduleService } from "../../cron/service/schedule-service";
import { DurableToolApprovalCoordinator } from "../../runtime/approval/durable-tool-approval";
import { DurableRunContinuationCoordinator } from "../../runtime/continuation/durable-run-continuation";
import { LocalRuntimeHost } from "../../runtime/host/local-runtime-host";
import type {
	PendingPromptsRuntimeService,
	RuntimeHost,
} from "../../runtime/host/runtime-host";
import { SqliteSessionStore } from "../../services/storage/sqlite-session-store";
import { CoreSessionService } from "../../session/services/session-service";
import {
	type CoreSettingsListInput,
	CoreSettingsService,
	type CoreSettingsToggleInput,
	type CoreSettingsType,
} from "../../settings";
import type { CoreSessionEvent } from "../../types/events";
import type { HubCommandDispatchContext } from "./command-transport";

const hubServerTracer = trace.getTracer("cline.hub.server");

import { redactCredentialRecord } from "./credential-redaction";
import {
	handleApprovalRespond,
	requestToolApproval as requestToolApprovalHandler,
} from "./handlers/approval-handlers";
import {
	cancelPendingCapabilityRequests,
	handleCapabilityProgress,
	handleCapabilityRequest,
	handleCapabilityRespond,
	requestCapability as requestCapabilityHandler,
} from "./handlers/capability-handlers";
import {
	handleClientList,
	handleClientRegister,
	handleClientUnregister,
	handleClientUpdate,
} from "./handlers/client-handlers";
import { handleConnectorCommand } from "./handlers/connector-handlers";
import {
	buildHubEvent,
	type HubTransportContext,
	okReply,
	type PendingApproval,
	type PendingCapabilityRequest,
} from "./handlers/context";
import {
	handleRunAbort,
	handleSessionHook,
	handleSessionInput,
} from "./handlers/run-handlers";
import { authorizeHubSessionCommand } from "./handlers/session-access";
import { projectSessionEvent } from "./handlers/session-event-projector";
import {
	handleSessionAttach,
	handleSessionCompactionGet,
	handleSessionCompactionUpdate,
	handleSessionCreate,
	handleSessionDelete,
	handleSessionDetach,
	handleSessionGet,
	handleSessionList,
	handleSessionMessages,
	handleSessionPendingPrompts,
	handleSessionRemovePendingPrompt,
	handleSessionRestore,
	handleSessionResume,
	handleSessionUpdate,
	handleSessionUpdateConnection,
	handleSessionUpdatePendingPrompt,
} from "./handlers/session-handlers";
import { eventNameForScheduleCommand } from "./hub-schedule-events";
import { logHubBoundaryError } from "./hub-server-logging";
import type { HubWebSocketServerOptions } from "./hub-server-options";
import type { HubSessionState } from "./hub-session-records";
import type { NativeHubTransport } from "./native-transport";

const SETTINGS_TYPES = new Set<CoreSettingsType>([
	"skills",
	"workflows",
	"rules",
	"tools",
	"mcp",
]);

function isPayloadObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOptionalString(
	payload: Record<string, unknown>,
	key: "cwd" | "workspaceRoot" | "id" | "path" | "name",
): string | undefined {
	const value = payload[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`settings payload '${key}' must be a string.`);
	}
	return value;
}

function requireOptionalBoolean(
	payload: Record<string, unknown>,
	key: "enabled",
): boolean | undefined {
	const value = payload[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error(`settings payload '${key}' must be a boolean.`);
	}
	return value;
}

function parseSettingsListInput(payload: unknown): CoreSettingsListInput {
	if (payload === undefined) {
		return {};
	}
	if (!isPayloadObject(payload)) {
		throw new Error("settings.list payload must be an object.");
	}
	return {
		cwd: requireOptionalString(payload, "cwd"),
		workspaceRoot: requireOptionalString(payload, "workspaceRoot"),
		availabilityContext: isPayloadObject(payload.availabilityContext)
			? (payload.availabilityContext as CoreSettingsListInput["availabilityContext"])
			: undefined,
	};
}

function parseSettingsToggleInput(payload: unknown): CoreSettingsToggleInput {
	if (!isPayloadObject(payload)) {
		throw new Error("settings.toggle payload must be an object.");
	}
	const { type } = payload;
	if (
		typeof type !== "string" ||
		!SETTINGS_TYPES.has(type as CoreSettingsType)
	) {
		throw new Error(
			"settings.toggle payload 'type' must be one of: skills, workflows, rules, tools, mcp.",
		);
	}
	return {
		...parseSettingsListInput(payload),
		type: type as CoreSettingsType,
		id: requireOptionalString(payload, "id"),
		path: requireOptionalString(payload, "path"),
		name: requireOptionalString(payload, "name"),
		enabled: requireOptionalBoolean(payload, "enabled"),
	};
}

/** @internal Exported for unit testing fetch/runtime wiring. */
export class HubServerTransport implements NativeHubTransport {
	private readonly clients = new Map<string, HubClientRecord>();
	/**
	 * Connections currently attached to this transport. A client identity whose
	 * owning connection is no longer here can be reclaimed by a reconnecting
	 * client that reuses its id, so an abrupt disconnect cannot permanently
	 * block a legitimate client.
	 */
	private readonly liveConnections = new Set<string>();
	private readonly listeners = new Map<
		string,
		Set<{ sessionId?: string; listener: (event: HubEventEnvelope) => void }>
	>();
	private readonly sessionState = new Map<string, HubSessionState>();
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	private readonly approvalCoordinator: DurableToolApprovalCoordinator;
	private readonly ownsApprovalCoordinator: boolean;
	private readonly continuationCoordinator: DurableRunContinuationCoordinator;
	private readonly ownsContinuationCoordinator: boolean;
	private readonly pendingCapabilityRequests = new Map<
		string,
		PendingCapabilityRequest
	>();
	private readonly suppressNextTerminalEventBySession = new Map<
		string,
		string
	>();
	private readonly schedules: HubScheduleService;
	private readonly scheduleCommands: HubScheduleCommandService;
	private readonly settings: CoreSettingsService;
	private readonly cronService?: CronService;
	private readonly sessionHost: RuntimeHost &
		Partial<PendingPromptsRuntimeService>;
	private readonly hubId = createSessionId("hub_");
	private readonly ctx: HubTransportContext;

	constructor(readonly options: HubWebSocketServerOptions) {
		if (options.sessionHost) {
			this.sessionHost = options.sessionHost;
			const hostWithCoordinator = options.sessionHost as RuntimeHost & {
				getToolApprovalCoordinator?: () => DurableToolApprovalCoordinator;
				getRunContinuationCoordinator?: () => DurableRunContinuationCoordinator;
			};
			const hostCoordinator =
				hostWithCoordinator.getToolApprovalCoordinator?.();
			const hostContinuationCoordinator =
				hostWithCoordinator.getRunContinuationCoordinator?.();
			if (
				options.approvalCoordinator &&
				hostCoordinator &&
				options.approvalCoordinator !== hostCoordinator
			) {
				throw new Error(
					"Hub approval coordinator must match the session host coordinator",
				);
			}
			if (
				options.continuationCoordinator &&
				hostContinuationCoordinator &&
				options.continuationCoordinator !== hostContinuationCoordinator
			) {
				throw new Error(
					"Hub continuation coordinator must match the session host coordinator",
				);
			}
			this.approvalCoordinator =
				options.approvalCoordinator ??
				hostCoordinator ??
				new DurableToolApprovalCoordinator();
			this.ownsApprovalCoordinator =
				options.approvalCoordinator === undefined && !hostCoordinator;
			this.continuationCoordinator =
				options.continuationCoordinator ??
				hostContinuationCoordinator ??
				new DurableRunContinuationCoordinator();
			this.ownsContinuationCoordinator =
				options.continuationCoordinator === undefined &&
				!hostContinuationCoordinator;
		} else {
			this.approvalCoordinator =
				options.approvalCoordinator ?? new DurableToolApprovalCoordinator();
			this.ownsApprovalCoordinator = options.approvalCoordinator === undefined;
			this.continuationCoordinator =
				options.continuationCoordinator ??
				new DurableRunContinuationCoordinator();
			this.ownsContinuationCoordinator =
				options.continuationCoordinator === undefined;
			this.sessionHost = new LocalRuntimeHost({
				sessionService: new CoreSessionService(new SqliteSessionStore()),
				fetch: options.fetch,
				telemetry: options.telemetry,
				approvalCoordinator: this.approvalCoordinator,
				continuationCoordinator: this.continuationCoordinator,
				recoveryOwner: options.a2a?.recoveryOwner?.trim(),
			});
		}
		this.ctx = {
			clients: this.clients,
			sessionState: this.sessionState,
			pendingApprovals: this.pendingApprovals,
			approvalCoordinator: this.approvalCoordinator,
			continuationCoordinator: this.continuationCoordinator,
			pendingCapabilityRequests: this.pendingCapabilityRequests,
			liveConnections: this.liveConnections,
			suppressNextTerminalEventBySession:
				this.suppressNextTerminalEventBySession,
			telemetry: options.telemetry,
			sessionHost: this.sessionHost,
			publish: (event) => this.publish(event),
			buildEvent: buildHubEvent,
			requestCapability: (
				sessionId,
				capabilityName,
				payload,
				targetClientId,
				onProgress,
			) =>
				requestCapabilityHandler(
					this.ctx,
					sessionId,
					capabilityName,
					payload,
					targetClientId,
					onProgress,
				),
		};
		this.schedules = new HubScheduleService({
			...options.scheduleOptions,
			runtimeHandlers: options.runtimeHandlers,
			eventPublisher: (eventType, payload) => {
				const mapped =
					eventType === "schedule.execution.completed"
						? "schedule.execution_completed"
						: eventType === "schedule.execution.failed"
							? "schedule.execution_failed"
							: undefined;
				if (!mapped) {
					return;
				}
				this.publish(
					buildHubEvent(
						mapped,
						payload && typeof payload === "object"
							? (payload as Record<string, unknown>)
							: undefined,
					),
				);
			},
		});
		this.scheduleCommands = new HubScheduleCommandService(this.schedules);
		this.settings = options.settingsService ?? new CoreSettingsService();
		if (options.cronOptions) {
			this.cronService = new CronService({
				runtimeHandlers: options.runtimeHandlers,
				...options.cronOptions,
			});
		}
		this.sessionHost.subscribe((event: CoreSessionEvent) => {
			void projectSessionEvent(this.ctx, event).catch((error) => {
				logHubBoundaryError("session event handling failed", error);
				captureSdkError(this.options.telemetry, {
					component: "core",
					operation: "hub.session_event_project",
					error,
					severity: "error",
					handled: true,
					context: {
						eventType: event.type,
						sessionId: event.payload.sessionId,
					},
				});
			});
		});
	}

	getCronService(): CronService | undefined {
		return this.cronService;
	}

	getHubId(): string {
		return this.hubId;
	}

	async start(): Promise<void> {
		this.approvalCoordinator.setPreservePendingApprovals(false);
		this.continuationCoordinator.setPreservePending(false);
		try {
			await this.options.startupRecovery?.();
		} catch (error) {
			logHubBoundaryError("startup recovery failed", error);
			captureSdkError(this.options.telemetry, {
				component: "core",
				operation: "hub.startup_recovery",
				error,
				severity: "error",
				handled: true,
			});
		}
		await this.schedules.start();
		if (this.cronService) {
			try {
				await this.cronService.start();
			} catch (err) {
				console.error("[hub] cron service start failed", err);
			}
		}
	}

	async stop(): Promise<void> {
		this.approvalCoordinator.setPreservePendingApprovals(true);
		this.continuationCoordinator.setPreservePending(true);
		this.approvalCoordinator.releaseWaiters(
			"Hub shutting down before approval was resolved.",
		);
		cancelPendingCapabilityRequests(
			this.ctx,
			() => true,
			"Hub shutting down before capability request was resolved.",
		);
		try {
			await this.sessionHost.dispose("hub_server_stop");
		} finally {
			if (this.ownsApprovalCoordinator) {
				await this.approvalCoordinator.close();
			}
			if (this.ownsContinuationCoordinator) {
				await this.continuationCoordinator.close();
			}
		}
		await this.schedules.dispose();
		if (this.cronService) {
			try {
				await this.cronService.dispose();
			} catch (err) {
				console.error("[hub] cron service stop failed", err);
			}
		}
	}

	/**
	 * Mark a websocket connection as attached. The websocket server calls this
	 * once per accepted socket; the connection id is what later registrations
	 * are compared against.
	 */
	beginConnection(connectionId: string): void {
		if (connectionId) {
			this.liveConnections.add(connectionId);
		}
	}

	/**
	 * Mark a websocket connection as gone and drop any client identity it still
	 * owned, so a reconnecting client that reuses its id is not locked out by a
	 * record left behind by an abrupt disconnect.
	 */
	endConnection(connectionId: string): void {
		if (!connectionId) {
			return;
		}
		this.liveConnections.delete(connectionId);
		for (const [clientId, client] of [...this.clients]) {
			if (client.metadata?.connectionId === connectionId) {
				this.clients.delete(clientId);
				this.publish(
					buildHubEvent("hub.client.disconnected", { clientId }, undefined),
				);
			}
		}
	}

	async handleCommand(
		envelope: HubCommandEnvelope,
		dispatch?: HubCommandDispatchContext,
	): Promise<HubReplyEnvelope> {
		// No-op span unless a TracerProvider is registered. Pairs with the
		// client-side "hub.command" span via hub.request_id correlation.
		const span = hubServerTracer.startSpan("hub.dispatch", {
			attributes: {
				"hub.command": envelope.command,
				"hub.request_id": envelope.requestId,
				"hub.session_id": envelope.sessionId,
				"hub.client_id": envelope.clientId,
				"hub.connection_id": dispatch?.connectionId ?? "",
			},
		});
		try {
			const reply = await this.dispatchCommand(envelope, dispatch);
			if (!reply.ok) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: `${reply.error?.code ?? "unknown"}: ${reply.error?.message ?? ""}`,
				});
			}
			this.captureFailedReply(envelope, reply);
			return reply;
		} catch (error) {
			span.recordException(error as Error);
			span.setStatus({ code: SpanStatusCode.ERROR });
			captureSdkError(this.options.telemetry, {
				component: "core",
				operation: "hub.command",
				error,
				severity: "error",
				handled: false,
				context: this.commandTelemetryContext(envelope),
			});
			throw error;
		} finally {
			span.end();
		}
	}

	private async dispatchCommand(
		envelope: HubCommandEnvelope,
		dispatch?: HubCommandDispatchContext,
	): Promise<HubReplyEnvelope> {
		// One authorization table for every session-scoped command, checked
		// before dispatch so no handler can forget it.
		const forbidden = authorizeHubSessionCommand(this.ctx, envelope);
		if (forbidden) {
			return forbidden;
		}
		switch (envelope.command) {
			case "client.register":
				return handleClientRegister(this.ctx, envelope, dispatch);
			case "client.update":
				return handleClientUpdate(this.ctx, envelope);
			case "client.unregister":
				return handleClientUnregister(this.ctx, envelope, (clientId) => {
					this.listeners.delete(clientId);
					this.detachClientFromSessions(clientId);
				});
			case "client.list":
				return handleClientList(this.ctx, envelope);
			case "session.create":
				return await handleSessionCreate(
					this.ctx,
					envelope,
					(request: ToolApprovalRequest) =>
						requestToolApprovalHandler(this.ctx, request),
				);
			case "session.restore":
				return await handleSessionRestore(
					this.ctx,
					envelope,
					(request: ToolApprovalRequest) =>
						requestToolApprovalHandler(this.ctx, request),
				);
			case "session.resume":
				return await handleSessionResume(this.ctx, envelope);
			case "session.attach":
				return await handleSessionAttach(this.ctx, envelope);
			case "session.detach":
				return await handleSessionDetach(this.ctx, envelope);
			case "session.get":
				return await handleSessionGet(this.ctx, envelope);
			case "session.messages":
				return await handleSessionMessages(this.ctx, envelope);
			case "session.compaction.get":
				return await handleSessionCompactionGet(this.ctx, envelope);
			case "session.list":
				return await handleSessionList(this.ctx, envelope);
			case "session.update":
				return await handleSessionUpdate(this.ctx, envelope);
			case "session.update_connection":
				return await handleSessionUpdateConnection(this.ctx, envelope);
			case "session.compaction.update":
				return await handleSessionCompactionUpdate(this.ctx, envelope);
			case "session.pending_prompts":
				return await handleSessionPendingPrompts(this.ctx, envelope);
			case "session.update_pending_prompt":
				return await handleSessionUpdatePendingPrompt(this.ctx, envelope);
			case "session.remove_pending_prompt":
				return await handleSessionRemovePendingPrompt(this.ctx, envelope);
			case "session.delete":
				return await handleSessionDelete(this.ctx, envelope);
			case "session.hook":
				return await handleSessionHook(this.ctx, envelope);
			case "run.start":
			case "session.send_input":
				return await handleSessionInput(this.ctx, envelope);
			case "run.abort":
				return await handleRunAbort(this.ctx, envelope);
			case "capability.request":
				return await handleCapabilityRequest(this.ctx, envelope);
			case "approval.respond":
				return await handleApprovalRespond(this.ctx, envelope);
			case "capability.respond":
				return handleCapabilityRespond(this.ctx, envelope);
			case "capability.progress":
				return handleCapabilityProgress(this.ctx, envelope);
			case "ui.notify":
				this.publish(buildHubEvent("ui.notify", envelope.payload ?? {}));
				return okReply(envelope);
			case "ui.show_window":
				this.publish(buildHubEvent("ui.show_window", envelope.payload ?? {}));
				return okReply(envelope);
			case "settings.list":
				return await this.handleSettingsList(envelope);
			case "settings.toggle":
				return await this.handleSettingsToggle(envelope);
			case "connector.channels":
			case "connector.configure":
			case "connector.delete_config":
				return await handleConnectorCommand(this.ctx, envelope);
			case "settings.get":
			case "settings.patch":
				return {
					version: envelope.version,
					requestId: envelope.requestId,
					ok: false,
					error: {
						code: "not_implemented",
						message: `${envelope.command} is not implemented yet.`,
					},
				};
			default: {
				const reply = await this.scheduleCommands.handleCommand(envelope);
				if (reply.ok) {
					const event = eventNameForScheduleCommand(envelope.command);
					if (event) {
						this.publish(buildHubEvent(event, reply.payload));
					}
				}
				return reply;
			}
		}
	}

	private captureFailedReply(
		envelope: HubCommandEnvelope,
		reply: HubReplyEnvelope,
	): void {
		if (
			reply.ok ||
			!reply.error ||
			!shouldCaptureHubReplyError(reply.error.code)
		) {
			return;
		}
		captureSdkError(this.options.telemetry, {
			component: "core",
			operation: "hub.command_reply",
			error: new Error(reply.error.message),
			severity: reply.error.code === "session_not_found" ? "warn" : "error",
			handled: true,
			context: {
				...this.commandTelemetryContext(envelope),
				errorCode: reply.error.code,
			},
		});
	}

	private commandTelemetryContext(envelope: HubCommandEnvelope) {
		return {
			command: envelope.command,
			requestId: envelope.requestId,
			clientId: envelope.clientId,
			sessionId:
				typeof envelope.payload?.sessionId === "string"
					? envelope.payload.sessionId
					: envelope.sessionId,
		};
	}

	private async handleSettingsList(
		envelope: HubCommandEnvelope,
	): Promise<HubReplyEnvelope> {
		try {
			const snapshot = await this.settings.list(
				parseSettingsListInput(envelope.payload),
			);
			return {
				version: envelope.version,
				requestId: envelope.requestId,
				ok: true,
				payload: { snapshot },
			};
		} catch (error) {
			return {
				version: envelope.version,
				requestId: envelope.requestId,
				ok: false,
				error: {
					code: "settings_list_failed",
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	private async handleSettingsToggle(
		envelope: HubCommandEnvelope,
	): Promise<HubReplyEnvelope> {
		try {
			const result = await this.settings.toggle(
				parseSettingsToggleInput(envelope.payload),
			);
			this.publish(
				buildHubEvent("settings.changed", {
					types: result.changedTypes,
					snapshot: result.snapshot,
				}),
			);
			return {
				version: envelope.version,
				requestId: envelope.requestId,
				ok: true,
				payload: {
					snapshot: result.snapshot,
					changedTypes: result.changedTypes,
				},
			};
		} catch (error) {
			return {
				version: envelope.version,
				requestId: envelope.requestId,
				ok: false,
				error: {
					code: "settings_toggle_failed",
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	subscribe(
		clientId: string,
		listener: (event: HubEventEnvelope) => void,
		options?: { sessionId?: string },
	): () => void {
		const current = this.listeners.get(clientId) ?? new Set();
		const entry = { sessionId: options?.sessionId, listener };
		current.add(entry);
		this.listeners.set(clientId, current);
		return () => {
			const listeners = this.listeners.get(clientId);
			if (!listeners) {
				return;
			}
			listeners.delete(entry);
			if (listeners.size === 0) {
				this.listeners.delete(clientId);
			}
		};
	}

	private detachClientFromSessions(clientId: string): void {
		for (const [sessionId, state] of this.sessionState.entries()) {
			state.participants.delete(clientId);
			if (state.createdByClientId === clientId) {
				state.createdByClientId = undefined;
			}
			if (state.participants.size === 0) {
				this.sessionState.delete(sessionId);
			}
		}
		cancelPendingCapabilityRequests(
			this.ctx,
			(request) => request.targetClientId === clientId,
			`Capability owner client ${clientId} disconnected before request was resolved.`,
		);
	}

	/**
	 * Fan an event out to subscribers.
	 *
	 * Payloads are redacted here rather than per publisher: this is the single
	 * point every broadcast passes through, so a new event cannot leak a
	 * credential by forgetting to sanitize. Redaction is applied to the payload
	 * only — event name, session id, and event id are addressing, not data.
	 */
	private publish(event: HubEventEnvelope): void {
		const projection: HubEventEnvelope =
			event.payload === undefined
				? event
				: {
						...event,
						payload: redactCredentialRecord(
							event.payload as Record<string, unknown>,
						),
					};
		for (const entries of this.listeners.values()) {
			for (const entry of entries) {
				if (entry.sessionId && entry.sessionId !== projection.sessionId) {
					continue;
				}
				try {
					entry.listener(projection);
				} catch (error) {
					logHubBoundaryError(
						`listener threw while publishing ${event.event}`,
						error,
					);
					captureSdkError(this.options.telemetry, {
						component: "core",
						operation: "hub.publish",
						error,
						severity: "warn",
						handled: true,
						context: {
							event: event.event,
							sessionId: event.sessionId,
						},
					});
				}
			}
		}
	}
}

function shouldCaptureHubReplyError(code: string): boolean {
	return (
		code === "session_not_found" ||
		code === "session_messages_not_found" ||
		code === "hub_command_timeout" ||
		code.endsWith("_failed")
	);
}
