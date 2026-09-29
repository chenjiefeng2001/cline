import { describe, expect, it } from "vitest"
import type { HubReplyEnvelope, HubTransportFrame } from "@cline/shared"
import {
	ConnectionIdentity,
	HUB_CLIENT_ID_MISMATCH_ERROR,
	HUB_UNREGISTERED_CLIENT_ERROR,
} from "./browser-websocket"

// The two frame shapes are narrowed locally in browser-websocket rather than
// exported, so they are re-derived here from the shared transport union.
type HubCommandFrame = HubTransportFrame & { kind: "command" }
type HubStreamFrame = Extract<
	HubTransportFrame,
	{ kind: "stream.subscribe" | "stream.unsubscribe" }
>

/**
 * The hub authorization boundary.
 *
 * The websocket upgrade already proved the connection holds the bearer token, so the
 * connection is the principal. What it must not be able to do is *name* that
 * principal: every session, approval and subscription handler authorizes on
 * `envelope.clientId`, and that value arrives from the wire. These cases pin the
 * three ways a client could otherwise escalate, and the one path that is deliberately
 * allowed.
 *
 * This had no coverage anywhere before: no test file referenced the identity at all.
 * A security boundary with no test is a boundary that survives only by nobody having
 * touched the code.
 */
function command(envelope: {
	command: string
	clientId?: string
}): HubCommandFrame {
	return {
		kind: "command",
		envelope: {
			version: "v1",
			command: envelope.command as HubCommandFrame["envelope"]["command"],
			...(envelope.clientId === undefined ? {} : { clientId: envelope.clientId }),
		},
	}
}

function denialCode(reply: HubReplyEnvelope | undefined): string | undefined {
	return reply?.error?.code
}

describe("ConnectionIdentity", () => {
	describe("before registering", () => {
		it("allows the registration command itself", () => {
			// Otherwise a client could never obtain an identity in the first place.
			const identity = new ConnectionIdentity("conn-1")
			expect(identity.authorizeCommand(command({ command: "client.register" }))).toBeUndefined()
		})

		it("refuses every other command", () => {
			// A self-reported clientId is not a credential, so an unbound connection
			// gets no session, approval or control surface at all.
			const identity = new ConnectionIdentity("conn-1")
			for (const name of [
				"session.create",
				"session.start",
				"approval.resolve",
				"session.cancel",
			]) {
				const reply = identity.authorizeCommand(command({ command: name, clientId: "victim" }))
				expect(denialCode(reply), name).toBe(HUB_UNREGISTERED_CLIENT_ERROR)
			}
		})

		it("refuses subscriptions", () => {
			const identity = new ConnectionIdentity("conn-1")
			const frame: HubStreamFrame = { kind: "stream.subscribe", clientId: "victim" }
			const result = identity.authorizeStream(frame)
			expect(typeof result).not.toBe("string")
			expect((result as HubReplyEnvelope).error?.code).toBe(HUB_UNREGISTERED_CLIENT_ERROR)
		})
	})

	describe("after binding", () => {
		it("refuses to act as a different client", () => {
			// The escalation this whole object exists to prevent.
			const identity = new ConnectionIdentity("conn-1")
			identity.bind("client-a")
			const reply = identity.authorizeCommand(
				command({ command: "session.create", clientId: "client-b" }),
			)
			expect(denialCode(reply)).toBe(HUB_CLIENT_ID_MISMATCH_ERROR)
		})

		it("refuses to subscribe as a different client", () => {
			const identity = new ConnectionIdentity("conn-1")
			identity.bind("client-a")
			const result = identity.authorizeStream({ kind: "stream.subscribe", clientId: "client-b" })
			expect(typeof result).not.toBe("string")
			expect((result as HubReplyEnvelope).error?.code).toBe(HUB_CLIENT_ID_MISMATCH_ERROR)
		})

		it("rewrites an omitted clientId instead of trusting it", () => {
			// Omission is not a claim of some other identity, so this is allowed - but
			// the envelope is rewritten rather than passed through, so no downstream
			// handler ever sees an undefined principal it might default to something.
			const identity = new ConnectionIdentity("conn-1")
			identity.bind("client-a")
			const frame = command({ command: "session.create" })
			expect(identity.authorizeCommand(frame)).toBeUndefined()
			expect(frame.envelope.clientId).toBe("client-a")
		})

		it("ignores surrounding whitespace when comparing", () => {
			// Trimming keeps a padding difference from reading as an escalation, which
			// would otherwise let a client lock itself out of its own session.
			const identity = new ConnectionIdentity("conn-1")
			identity.bind("client-a")
			expect(
				identity.authorizeCommand(command({ command: "session.create", clientId: "  client-a  " })),
			).toBeUndefined()
		})

		it("allows its own identity", () => {
			const identity = new ConnectionIdentity("conn-1")
			identity.bind("client-a")
			expect(
				identity.authorizeCommand(command({ command: "session.create", clientId: "client-a" })),
			).toBeUndefined()
			expect(identity.authorizeStream({ kind: "stream.subscribe", clientId: "client-a" })).toBe(
				"client-a",
			)
		})
	})

	describe("on release", () => {
		it("drops the binding rather than keeping the identity", () => {
			// A released connection must re-register. If the binding survived, a
			// recycled or torn-down connection would keep acting as the old client.
			const identity = new ConnectionIdentity("conn-1")
			identity.bind("client-a")
			identity.release()
			expect(identity.clientId).toBeUndefined()
			expect(
				denialCode(identity.authorizeCommand(command({ command: "session.create", clientId: "client-a" }))),
			).toBe(HUB_UNREGISTERED_CLIENT_ERROR)
		})
	})
})
