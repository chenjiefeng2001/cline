import type { HubCommandEnvelope } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	ensureSessionParticipant,
	ensureSessionState,
	type HubTransportContext,
} from "./context";
import {
	authorizeHubSessionCommand,
	HUB_SESSION_FORBIDDEN_ERROR,
	hubSessionAccessForCommand,
	resolveHubSessionRole,
} from "./session-access";

function createContext(): HubTransportContext {
	return {
		clients: new Map(),
		sessionState: new Map(),
		pendingApprovals: new Map(),
		pendingCapabilityRequests: new Map(),
		suppressNextTerminalEventBySession: new Map(),
		publish: vi.fn(),
		buildEvent: vi.fn((event: string) => ({ event })),
		requestCapability: vi.fn(),
		sessionHost: {},
	} as unknown as HubTransportContext;
}

function command(
	name: HubCommandEnvelope["command"],
	clientId: string,
	sessionId: string,
): HubCommandEnvelope {
	return {
		version: "v1",
		requestId: `req-${name}`,
		command: name,
		clientId,
		sessionId,
	} as unknown as HubCommandEnvelope;
}

describe("resolveHubSessionRole", () => {
	it("reads ownership from live hub state", () => {
		const ctx = createContext();
		ensureSessionState(ctx, "session-1", "owner-client", "creator");
		ensureSessionParticipant(ctx, "session-1", "writer-client", "participant");
		ensureSessionParticipant(ctx, "session-1", "viewer-client", "observer");

		expect(resolveHubSessionRole(ctx, "session-1", "owner-client")).toBe(
			"owner",
		);
		expect(resolveHubSessionRole(ctx, "session-1", "writer-client")).toBe(
			"participant",
		);
		expect(resolveHubSessionRole(ctx, "session-1", "viewer-client")).toBe(
			"observer",
		);
		expect(resolveHubSessionRole(ctx, "session-1", "stranger")).toBe("none");
	});

	it("reports none for a session with no live state", () => {
		expect(resolveHubSessionRole(createContext(), "missing", "owner")).toBe(
			"none",
		);
	});
});

describe("hubSessionAccessForCommand", () => {
	it("reserves destructive and re-pointing commands for the owner", () => {
		for (const name of [
			"session.delete",
			"session.resume",
			"session.update",
			"session.update_connection",
			"session.compaction.get",
			"session.compaction.update",
			"session.update_pending_prompt",
			"session.remove_pending_prompt",
		] as const) {
			expect(hubSessionAccessForCommand(name)).toBe("own");
		}
	});

	it("lets a participant drive execution but not observe-only commands", () => {
		for (const name of [
			"run.start",
			"session.send_input",
			"run.abort",
			"session.restore",
			"session.hook",
		] as const) {
			expect(hubSessionAccessForCommand(name)).toBe("write");
		}
	});

	it("treats session observation as readable", () => {
		for (const name of [
			"session.get",
			"session.list",
			"session.messages",
			"session.attach",
			"session.detach",
			"session.pending_prompts",
		] as const) {
			expect(hubSessionAccessForCommand(name)).toBe("read");
		}
	});

	it("does not classify non-session commands", () => {
		for (const name of [
			"client.list",
			"settings.list",
			"approval.respond",
			"ui.notify",
		] as const) {
			expect(hubSessionAccessForCommand(name)).toBeUndefined();
		}
	});
});

describe("authorizeHubSessionCommand", () => {
	function seeded(): HubTransportContext {
		const ctx = createContext();
		ensureSessionState(ctx, "session-1", "owner-client", "creator");
		ensureSessionParticipant(ctx, "session-1", "writer-client", "participant");
		ensureSessionParticipant(ctx, "session-1", "viewer-client", "observer");
		return ctx;
	}

	it("lets the owner run every session command", () => {
		const ctx = seeded();
		for (const name of [
			"session.delete",
			"run.start",
			"session.get",
		] as const) {
			expect(
				authorizeHubSessionCommand(
					ctx,
					command(name, "owner-client", "session-1"),
				),
			).toBeUndefined();
		}
	});

	it("refuses an observer anything that writes", () => {
		const ctx = seeded();
		for (const name of [
			"session.delete",
			"session.resume",
			"session.update",
			"session.update_connection",
			"session.compaction.update",
			"session.update_pending_prompt",
			"run.start",
			"run.abort",
			"session.restore",
			"session.hook",
		] as const) {
			const reply = authorizeHubSessionCommand(
				ctx,
				command(name, "viewer-client", "session-1"),
			);
			expect(reply?.ok).toBe(false);
			expect(reply?.error?.code).toBe(HUB_SESSION_FORBIDDEN_ERROR);
		}
	});

	it("still lets an observer read", () => {
		const ctx = seeded();
		for (const name of [
			"session.get",
			"session.messages",
			"session.attach",
			"session.pending_prompts",
		] as const) {
			expect(
				authorizeHubSessionCommand(
					ctx,
					command(name, "viewer-client", "session-1"),
				),
			).toBeUndefined();
		}
	});

	it("lets a participant drive a run but not reconfigure or delete", () => {
		const ctx = seeded();
		for (const name of [
			"run.start",
			"run.abort",
			"session.send_input",
		] as const) {
			expect(
				authorizeHubSessionCommand(
					ctx,
					command(name, "writer-client", "session-1"),
				),
			).toBeUndefined();
		}
		for (const name of [
			"session.delete",
			"session.update",
			"session.update_connection",
			"session.resume",
		] as const) {
			expect(
				authorizeHubSessionCommand(
					ctx,
					command(name, "writer-client", "session-1"),
				)?.error?.code,
			).toBe(HUB_SESSION_FORBIDDEN_ERROR);
		}
	});

	it("refuses a client that never attached", () => {
		const ctx = seeded();
		const reply = authorizeHubSessionCommand(
			ctx,
			command("session.delete", "stranger", "session-1"),
		);
		expect(reply?.ok).toBe(false);
		expect(reply?.error?.message).toContain("not attached");
	});

	it("refuses writes to a session whose live state was lost", () => {
		// Ownership lives only in memory, so a session with no live state has no
		// provable owner and must not be writable by an unauthenticated guess.
		const ctx = createContext();
		expect(
			authorizeHubSessionCommand(
				ctx,
				command("run.start", "client-1", "session-1"),
			)?.error?.code,
		).toBe(HUB_SESSION_FORBIDDEN_ERROR);
		// Reading stays open so a restarted daemon can still be observed.
		expect(
			authorizeHubSessionCommand(
				ctx,
				command("session.get", "client-1", "session-1"),
			),
		).toBeUndefined();
	});

	it("treats an envelope without a client identity as an in-process caller", () => {
		const ctx = seeded();
		expect(
			authorizeHubSessionCommand(ctx, {
				version: "v1",
				requestId: "req-internal",
				command: "run.start",
				sessionId: "session-1",
			} as unknown as HubCommandEnvelope),
		).toBeUndefined();
	});

	it("defers to the handler when no session is addressed", () => {
		const ctx = seeded();
		expect(
			authorizeHubSessionCommand(ctx, {
				version: "v1",
				requestId: "req-no-session",
				command: "session.get",
				clientId: "viewer-client",
			} as unknown as HubCommandEnvelope),
		).toBeUndefined();
	});

	it("cannot be escalated by attaching first", () => {
		const ctx = createContext();
		ensureSessionState(ctx, "session-1", "owner-client", "creator");
		// Attaching registers the client as an observer, never a writer.
		ensureSessionParticipant(ctx, "session-1", "viewer-client", "observer");
		expect(
			authorizeHubSessionCommand(
				ctx,
				command("run.start", "viewer-client", "session-1"),
			)?.error?.code,
		).toBe(HUB_SESSION_FORBIDDEN_ERROR);
	});
});
