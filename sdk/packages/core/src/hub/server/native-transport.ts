import type {
	HubCommandEnvelope,
	HubEventEnvelope,
	HubReplyEnvelope,
} from "@cline/shared";
import type {
	HubCommandDispatchContext,
	HubCommandTransport,
} from "./command-transport";

export interface NativeHubTransport {
	handleCommand(
		envelope: HubCommandEnvelope,
		context?: HubCommandDispatchContext,
	): Promise<HubReplyEnvelope>;
	subscribe(
		clientId: string,
		listener: (event: HubEventEnvelope) => void,
		options?: { sessionId?: string },
	): () => void;
}

export class NativeHubTransportAdapter implements HubCommandTransport {
	constructor(private readonly transport: NativeHubTransport) {}

	command(
		envelope: HubCommandEnvelope,
		context?: HubCommandDispatchContext,
	): Promise<HubReplyEnvelope> {
		return this.transport.handleCommand(envelope, context);
	}

	subscribe(
		clientId: string,
		listener: (event: HubEventEnvelope) => void,
		options?: { sessionId?: string },
	): () => void {
		return this.transport.subscribe(clientId, listener, options);
	}
}
