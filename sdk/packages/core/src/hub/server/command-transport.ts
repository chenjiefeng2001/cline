import type {
	HubCommandEnvelope,
	HubEventEnvelope,
	HubReplyEnvelope,
} from "@cline/shared";

/**
 * Server-owned context for one dispatched command.
 *
 * `connectionId` identifies the authenticated socket the command arrived on.
 * Remote transports must supply it so the server can bind a client identity to
 * exactly one connection; in-process callers (A2A mount, tests) omit it and are
 * treated as trusted, because they never traverse a network boundary.
 */
export interface HubCommandDispatchContext {
	connectionId?: string;
}

export interface HubCommandTransport {
	command(
		envelope: HubCommandEnvelope,
		context?: HubCommandDispatchContext,
	): Promise<HubReplyEnvelope>;
	subscribe(
		clientId: string,
		listener: (event: HubEventEnvelope) => void,
		options?: { sessionId?: string },
	): Promise<() => void> | (() => void);
}
