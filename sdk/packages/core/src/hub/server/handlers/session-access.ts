/**
 * Unified session access control for hub commands.
 *
 * A client identity is not authority over a session. The hub keeps live
 * ownership (`createdByClientId`) and participants per session, and every
 * session-scoped command declares how much authority it needs. The transport
 * checks that table once, before dispatch, so authorization cannot drift per
 * handler again.
 *
 * The model is deliberately tiered:
 *
 * - `read`  — any registered client. Sessions stay observable across clients so
 *             a UI can watch a session it did not create.
 * - `write` — the owner or a `participant`. Drives the run (start/abort/restore)
 *             without changing the session's configuration or lifetime.
 * - `own`   — the owner alone. Anything destructive, long-lived, or that
 *             re-points the session at another workspace/provider.
 *
 * `observer` is read-only by construction: attaching never grants write, so a
 * client cannot escalate by calling `session.attach`.
 */

import type { HubCommandEnvelope, HubReplyEnvelope } from "@cline/shared";
import {
	errorReply,
	extractSessionId,
	type HubTransportContext,
} from "./context";

/** Authority a command needs against the session it addresses. */
export type HubSessionAccess = "own" | "write" | "read";

/** Authority a client actually holds over a session. */
export type HubSessionRole = "owner" | "participant" | "observer" | "none";

export const HUB_SESSION_FORBIDDEN_ERROR = "session_wrong_client";

/**
 * Access required per session-scoped command. Commands that are not session
 * scoped (client registry, settings, connectors, schedules) are absent and are
 * authorized elsewhere or not at all.
 */
const SESSION_COMMAND_ACCESS: Readonly<
	Partial<Record<HubCommandEnvelope["command"], HubSessionAccess>>
> = {
	// Destructive, long-lived, or re-points the session: owner only.
	"session.delete": "own",
	"session.resume": "own",
	"session.update": "own",
	"session.update_connection": "own",
	"session.compaction.get": "own",
	"session.compaction.update": "own",
	"session.update_pending_prompt": "own",
	"session.remove_pending_prompt": "own",
	// Drives execution: the owner or a participant.
	"run.start": "write",
	"session.send_input": "write",
	"run.abort": "write",
	"session.restore": "write",
	"session.hook": "write",
	// Observation: any registered client.
	"session.get": "read",
	"session.list": "read",
	"session.messages": "read",
	"session.attach": "read",
	"session.detach": "read",
	"session.pending_prompts": "read",
};

export function hubSessionAccessForCommand(
	command: HubCommandEnvelope["command"],
): HubSessionAccess | undefined {
	return SESSION_COMMAND_ACCESS[command];
}

function roleAllowsAccess(
	role: HubSessionRole,
	access: HubSessionAccess,
): boolean {
	if (access === "read") {
		return true;
	}
	if (access === "write") {
		return role === "owner" || role === "participant";
	}
	return role === "owner";
}

/**
 * Resolve the authority one client holds over one session.
 *
 * Returns `none` when the session has no live hub state. Ownership lives only in
 * memory by design — session metadata is client-writable, so a persisted owner
 * claim could be replayed. A session whose state was lost (daemon restart) is
 * therefore unowned until a client claims it through `session.attach`.
 */
export function resolveHubSessionRole(
	ctx: HubTransportContext,
	sessionId: string,
	clientId: string,
): HubSessionRole {
	const state = ctx.sessionState.get(sessionId);
	if (!state) {
		return "none";
	}
	if (state.createdByClientId && state.createdByClientId === clientId) {
		return "owner";
	}
	const participant = state.participants.get(clientId);
	switch (participant?.role) {
		case "creator":
			return "owner";
		case "participant":
			return "participant";
		case "observer":
			return "observer";
		default:
			return "none";
	}
}

/**
 * Enforce the table for one command. Returns an error reply to send back, or
 * `undefined` when the command may proceed. Commands with no session id fall
 * through to their handler, which reports the more specific addressing error.
 */
export function authorizeHubSessionCommand(
	ctx: HubTransportContext,
	envelope: HubCommandEnvelope,
): HubReplyEnvelope | undefined {
	const access = hubSessionAccessForCommand(envelope.command);
	if (!access) {
		return undefined;
	}
	const sessionId = extractSessionId(envelope);
	if (!sessionId) {
		return undefined;
	}
	const clientId = envelope.clientId?.trim() ?? "";
	if (!clientId) {
		// No client identity means no client to authorize: this is an in-process
		// caller (the A2A mount, internal handlers, tests). A remote caller can
		// never reach this branch, because the websocket connection principal
		// refuses unregistered commands and stamps the bound identity on every
		// frame it does forward.
		return undefined;
	}
	const role = resolveHubSessionRole(ctx, sessionId, clientId);
	if (roleAllowsAccess(role, access)) {
		return undefined;
	}
	const requirement =
		access === "own" ? "session owner" : "session owner or participant";
	const detail =
		role === "none"
			? `Client ${clientId} is not attached to session ${sessionId}`
			: `Client ${clientId} is ${role} on session ${sessionId}`;
	return errorReply(
		envelope,
		HUB_SESSION_FORBIDDEN_ERROR,
		`${envelope.command} requires ${requirement}. ${detail}.`,
	);
}
