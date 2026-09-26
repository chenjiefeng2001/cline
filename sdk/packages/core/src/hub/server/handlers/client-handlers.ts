import type {
	HubClientRegistration,
	HubCommandEnvelope,
	HubReplyEnvelope,
} from "@cline/shared";
import { createSessionId } from "@cline/shared";
import type { HubCommandDispatchContext } from "../command-transport";
import { redactCredentialRecord } from "../credential-redaction";
import {
	asPlainRecord,
	errorReply,
	type HubTransportContext,
	okReply,
} from "./context";

export const HUB_CLIENT_ID_TAKEN_ERROR = "hub_client_id_taken";

export function handleClientRegister(
	ctx: HubTransportContext,
	envelope: HubCommandEnvelope,
	dispatch?: HubCommandDispatchContext,
): HubReplyEnvelope {
	const payload = envelope.payload as HubClientRegistration | undefined;
	const clientId =
		payload?.clientId?.trim() ||
		envelope.clientId?.trim() ||
		createSessionId("client_");
	// A client identity is a capability: it owns sessions, receives approvals,
	// and receives event subscriptions. Two live connections must never share
	// one, or either can act for the other. Re-registering from the same
	// connection (a reconnect that reused its id) stays allowed, and an
	// identity whose previous connection is gone may be reclaimed.
	const existing = ctx.clients.get(clientId);
	const ownerConnectionId = existing?.metadata?.connectionId;
	const ownerStillConnected =
		typeof ownerConnectionId === "string" &&
		ctx.liveConnections?.has(ownerConnectionId) === true;
	if (
		existing &&
		dispatch?.connectionId &&
		ownerConnectionId !== dispatch.connectionId &&
		ownerStillConnected
	) {
		return errorReply(
			envelope,
			HUB_CLIENT_ID_TAKEN_ERROR,
			`Client ${clientId} is already registered by another connection.`,
		);
	}
	ctx.clients.set(clientId, {
		clientId,
		clientType: payload?.clientType ?? "unknown",
		displayName: payload?.displayName,
		actorKind: payload?.actorKind ?? "client",
		connectedAt: Date.now(),
		lastSeenAt: Date.now(),
		transport: payload?.transport ?? "native",
		capabilities: payload?.capabilities ?? [],
		metadata: {
			...payload?.metadata,
			// Server-owned provenance, never client supplied: the websocket layer
			// stamps it so a later registration can prove it is the same socket.
			connectionId: dispatch?.connectionId ?? existing?.metadata?.connectionId,
		},
		workspaceContext: payload?.workspaceContext,
	});
	ctx.publish(
		ctx.buildEvent("hub.client.registered", {
			clientId,
			clientType: payload?.clientType ?? "unknown",
			displayName: payload?.displayName,
			connectedAt: Date.now(),
		}),
	);
	return okReply(envelope, { clientId });
}

export function handleClientUpdate(
	ctx: HubTransportContext,
	envelope: HubCommandEnvelope,
): HubReplyEnvelope {
	const clientId = envelope.clientId?.trim();
	const client = clientId ? ctx.clients.get(clientId) : undefined;
	if (!clientId || !client) {
		return errorReply(
			envelope,
			"client_not_found",
			"Client is not registered with this hub.",
		);
	}
	const metadata = asPlainRecord(envelope.payload?.metadata);
	client.lastSeenAt = Date.now();
	if (metadata) {
		client.metadata = JSON.parse(JSON.stringify(metadata));
	}
	return okReply(envelope);
}

export function handleClientUnregister(
	ctx: HubTransportContext,
	envelope: HubCommandEnvelope,
	onClientRemoved: (clientId: string) => void,
): HubReplyEnvelope {
	const clientId = envelope.clientId?.trim();
	if (clientId) {
		ctx.clients.delete(clientId);
		onClientRemoved(clientId);
		ctx.publish(ctx.buildEvent("hub.client.disconnected", { clientId }));
	}
	return okReply(envelope);
}

export function handleClientList(
	ctx: HubTransportContext,
	envelope: HubCommandEnvelope,
): HubReplyEnvelope {
	// Client metadata is client-supplied and the registry is readable by every
	// client, so it is a broadcast surface: redact on the way out rather than
	// trusting a client not to have put a token in it.
	return okReply(envelope, {
		clients: [...ctx.clients.values()].map((client) => ({
			...client,
			...(client.metadata
				? { metadata: redactCredentialRecord(client.metadata) }
				: {}),
		})),
	});
}
