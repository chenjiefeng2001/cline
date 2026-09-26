import type { HubCommandEnvelope } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	HUB_CLIENT_ID_TAKEN_ERROR,
	handleClientRegister,
} from "./client-handlers";
import type { HubTransportContext } from "./context";

function createContext(): HubTransportContext & {
	liveConnections: Set<string>;
} {
	return {
		clients: new Map(),
		liveConnections: new Set<string>(),
		publish: vi.fn(),
		buildEvent: vi.fn((event: string) => ({ event })),
	} as unknown as HubTransportContext & { liveConnections: Set<string> };
}

function registerEnvelope(clientId: string): HubCommandEnvelope {
	return {
		version: "v1",
		command: "client.register",
		requestId: `req-${clientId}`,
		clientId,
		payload: { clientId },
	} as unknown as HubCommandEnvelope;
}

describe("handleClientRegister connection identity", () => {
	it("records the owning connection so a later registration can be compared", () => {
		const ctx = createContext();

		const reply = handleClientRegister(ctx, registerEnvelope("client-1"), {
			connectionId: "conn-1",
		});

		expect(reply.ok).toBe(true);
		expect(ctx.clients.get("client-1")?.metadata?.connectionId).toBe("conn-1");
	});

	it("refuses to take over a client id owned by another live connection", () => {
		const ctx = createContext();
		ctx.liveConnections.add("conn-1");
		ctx.liveConnections.add("conn-2");
		handleClientRegister(ctx, registerEnvelope("client-1"), {
			connectionId: "conn-1",
		});

		const stolen = handleClientRegister(ctx, registerEnvelope("client-1"), {
			connectionId: "conn-2",
		});

		expect(stolen.ok).toBe(false);
		expect(stolen.error?.code).toBe(HUB_CLIENT_ID_TAKEN_ERROR);
		// The original owner keeps the record and its provenance.
		expect(ctx.clients.get("client-1")?.metadata?.connectionId).toBe("conn-1");
	});

	it("lets a reconnect reclaim an id whose previous connection is gone", () => {
		const ctx = createContext();
		ctx.liveConnections.add("conn-1");
		handleClientRegister(ctx, registerEnvelope("client-1"), {
			connectionId: "conn-1",
		});
		// The old socket dropped without unregistering; its record is stale.
		ctx.liveConnections.delete("conn-1");
		ctx.liveConnections.add("conn-2");

		const reconnected = handleClientRegister(
			ctx,
			registerEnvelope("client-1"),
			{
				connectionId: "conn-2",
			},
		);

		expect(reconnected.ok).toBe(true);
		expect(ctx.clients.get("client-1")?.metadata?.connectionId).toBe("conn-2");
	});

	it("allows a reconnect that reuses its own client id", () => {
		const ctx = createContext();
		ctx.liveConnections.add("conn-1");
		handleClientRegister(ctx, registerEnvelope("client-1"), {
			connectionId: "conn-1",
		});

		const reconnected = handleClientRegister(
			ctx,
			registerEnvelope("client-1"),
			{
				connectionId: "conn-1",
			},
		);

		expect(reconnected.ok).toBe(true);
		expect(ctx.clients.get("client-1")?.metadata?.connectionId).toBe("conn-1");
	});

	it("lets a distinct client id register on a second connection", () => {
		const ctx = createContext();
		ctx.liveConnections.add("conn-1");
		ctx.liveConnections.add("conn-2");
		handleClientRegister(ctx, registerEnvelope("client-1"), {
			connectionId: "conn-1",
		});

		const second = handleClientRegister(ctx, registerEnvelope("client-2"), {
			connectionId: "conn-2",
		});

		expect(second.ok).toBe(true);
		expect(ctx.clients.get("client-2")?.metadata?.connectionId).toBe("conn-2");
	});

	it("does not let a client overwrite server-owned provenance", () => {
		const ctx = createContext();
		handleClientRegister(
			ctx,
			{
				...registerEnvelope("client-1"),
				payload: {
					clientId: "client-1",
					metadata: { connectionId: "conn-attacker", role: "admin" },
				},
			} as unknown as HubCommandEnvelope,
			{ connectionId: "conn-1" },
		);

		const record = ctx.clients.get("client-1");
		expect(record?.metadata?.connectionId).toBe("conn-1");
		expect(record?.metadata?.role).toBe("admin");
	});

	it("keeps in-process registrations trusted when no connection is supplied", () => {
		const ctx = createContext();
		handleClientRegister(ctx, registerEnvelope("a2a-client"));
		const again = handleClientRegister(ctx, registerEnvelope("a2a-client"));

		expect(again.ok).toBe(true);
	});
});
