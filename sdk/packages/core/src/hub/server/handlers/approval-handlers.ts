import type {
	HubCommandEnvelope,
	HubReplyEnvelope,
	ToolApprovalRequest,
} from "@cline/shared";
import { createSessionId } from "@cline/shared";
import type { DurableToolApprovalRecord } from "../../../runtime/approval/durable-tool-approval";
import {
	errorReply,
	extractSessionId,
	type HubTransportContext,
	okReply,
} from "./context";

function parsePolicy(
	value: string,
	fallback: ToolApprovalRequest["policy"],
): ToolApprovalRequest["policy"] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as ToolApprovalRequest["policy"];
		}
	} catch {}
	return fallback;
}

function legacyRequestToolApproval(
	ctx: HubTransportContext,
	request: ToolApprovalRequest,
): Promise<{ approved: boolean; reason?: string }> {
	const approvalId = request.approvalId ?? createSessionId("approval_");
	return new Promise((resolve) => {
		ctx.pendingApprovals.set(approvalId, {
			sessionId: request.sessionId,
			resolve,
		});
		ctx.publish(
			ctx.buildEvent(
				"approval.requested",
				{
					approvalId,
					sessionId: request.sessionId,
					agentId: request.agentId,
					conversationId: request.conversationId,
					runId: request.runId,
					assistantMessageId: request.assistantMessageId,
					iteration: request.iteration,
					toolCallIndex: request.toolCallIndex,
					toolCallId: request.toolCallId,
					toolName: request.toolName,
					inputJson: JSON.stringify(request.input ?? null),
					policy: request.policy,
				},
				request.sessionId,
			),
		);
	});
}

export async function requestToolApproval(
	ctx: HubTransportContext,
	request: ToolApprovalRequest,
): Promise<{ approved: boolean; reason?: string }> {
	const state = ctx.sessionState.get(request.sessionId);
	if (state?.interactive === false) {
		return {
			approved: false,
			reason:
				"Tool approval requires an interactive session, but this session is non-interactive.",
		};
	}
	const coordinator = ctx.approvalCoordinator;
	if (!coordinator) {
		return legacyRequestToolApproval(ctx, request);
	}
	const requestedByClientId = state?.createdByClientId?.trim() || undefined;
	const targetClientId =
		requestedByClientId ?? [...(state?.participants.keys() ?? [])][0];
	const deliveryReady = coordinator.beginRequestDelivery(request.sessionId);
	let record: DurableToolApprovalRecord;
	try {
		const created = await coordinator.createRequest(request, {
			requestedByClientId,
			targetClientId,
		});
		record = created.record;
		if (requestedByClientId && !record.requestedByClientId) {
			record = await coordinator.bindPrincipal(
				record.approvalId,
				requestedByClientId,
				targetClientId,
			);
		}
		const terminal = coordinator.toToolApprovalResult(record);
		if (terminal) {
			return terminal;
		}
		ctx.publish(
			ctx.buildEvent(
				"approval.requested",
				{
					approvalId: record.approvalId,
					continuationKey: `approval:${record.approvalId}`,
					sessionId: record.sessionId,
					agentId: record.agentId,
					conversationId: record.conversationId,
					runId: record.runId,
					assistantMessageId: request.assistantMessageId,
					iteration: record.iteration,
					toolCallIndex: record.toolCallIndex,
					toolCallId: record.toolCallId,
					toolName: record.toolName,
					inputJson: record.inputJson,
					policy: parsePolicy(record.policyJson, request.policy),
					requestedByClientId: record.requestedByClientId,
					targetClientId: record.targetClientId,
					expiresAt: record.expiresAt,
				},
				record.sessionId,
			),
		);
	} finally {
		deliveryReady();
	}
	return coordinator.waitForDecision(record, request.signal);
}

export function resolvePendingApproval(
	ctx: HubTransportContext,
	approvalId: string,
	result: { approved: boolean; reason?: string },
): { sessionId: string } | undefined {
	const pending = ctx.pendingApprovals.get(approvalId);
	if (!pending) {
		return undefined;
	}
	ctx.pendingApprovals.delete(approvalId);
	pending.resolve(result);
	return { sessionId: pending.sessionId };
}

export async function cancelPendingApprovals(
	ctx: HubTransportContext,
	filter: (approval: { approvalId: string; sessionId: string }) => boolean,
	reason: string,
): Promise<number> {
	const coordinator = ctx.approvalCoordinator;
	if (coordinator) {
		const records = await coordinator.listPending();
		let cancelled = 0;
		for (const record of records) {
			if (
				!filter({ approvalId: record.approvalId, sessionId: record.sessionId })
			) {
				continue;
			}
			const result = await coordinator.cancel(record.approvalId, reason);
			if (result?.status !== "cancelled") {
				continue;
			}
			ctx.publish(
				ctx.buildEvent(
					"approval.resolved",
					{
						approvalId: record.approvalId,
						approved: false,
						cancelled: true,
						reason,
					},
					record.sessionId,
				),
			);
			cancelled += 1;
		}
		return cancelled;
	}
	let cancelled = 0;
	for (const [approvalId, pending] of [...ctx.pendingApprovals.entries()]) {
		if (!filter({ approvalId, sessionId: pending.sessionId })) {
			continue;
		}
		ctx.pendingApprovals.delete(approvalId);
		pending.resolve({ approved: false, reason });
		ctx.publish(
			ctx.buildEvent(
				"approval.resolved",
				{ approvalId, approved: false, cancelled: true, reason },
				pending.sessionId,
			),
		);
		cancelled += 1;
	}
	return cancelled;
}

export async function replayPendingApprovals(
	ctx: HubTransportContext,
	sessionId: string,
	clientId: string,
): Promise<void> {
	const coordinator = ctx.approvalCoordinator;
	if (!coordinator) {
		return;
	}
	const records = await coordinator.listPending(sessionId);
	for (const record of records) {
		if (record.targetClientId && record.targetClientId !== clientId) {
			continue;
		}
		ctx.publish(
			ctx.buildEvent(
				"approval.requested",
				{
					approvalId: record.approvalId,
					continuationKey: `approval:${record.approvalId}`,
					sessionId: record.sessionId,
					agentId: record.agentId,
					conversationId: record.conversationId,
					runId: record.runId,
					iteration: record.iteration,
					toolCallIndex: record.toolCallIndex,
					toolCallId: record.toolCallId,
					toolName: record.toolName,
					inputJson: record.inputJson,
					policy: parsePolicy(record.policyJson, {}),
					requestedByClientId: record.requestedByClientId,
					targetClientId: record.targetClientId,
					expiresAt: record.expiresAt,
				},
				sessionId,
			),
		);
	}
}

export async function handleApprovalRespond(
	ctx: HubTransportContext,
	envelope: HubCommandEnvelope,
): Promise<HubReplyEnvelope> {
	const approvalId =
		typeof envelope.payload?.approvalId === "string"
			? envelope.payload.approvalId.trim()
			: "";
	const reason =
		typeof envelope.payload?.reason === "string"
			? envelope.payload.reason
			: envelope.payload?.payload &&
					typeof envelope.payload.payload === "object" &&
					!Array.isArray(envelope.payload.payload) &&
					typeof (envelope.payload.payload as Record<string, unknown>)
						.reason === "string"
				? ((envelope.payload.payload as Record<string, unknown>)
						.reason as string)
				: undefined;
	const approved = envelope.payload?.approved === true;
	const coordinator = ctx.approvalCoordinator;
	if (!coordinator) {
		const resolved = resolvePendingApproval(ctx, approvalId, {
			approved,
			reason,
		});
		if (!resolved) {
			return errorReply(
				envelope,
				"approval_not_found",
				`Unknown approval: ${approvalId}`,
			);
		}
		ctx.publish(
			ctx.buildEvent(
				"approval.resolved",
				{ approvalId, approved, reason },
				resolved.sessionId,
			),
		);
		return okReply(envelope, { approvalId, approved });
	}
	const record = await coordinator.get(approvalId);
	if (!record) {
		return errorReply(
			envelope,
			"approval_not_found",
			`Unknown approval: ${approvalId}`,
		);
	}
	const sessionId = extractSessionId(envelope);
	if (!sessionId || sessionId !== record.sessionId) {
		return errorReply(
			envelope,
			"approval_wrong_session",
			`Approval ${approvalId} does not belong to session ${sessionId || "(missing)"}`,
		);
	}
	const clientId = envelope.clientId?.trim();
	if (!clientId) {
		return errorReply(
			envelope,
			"approval_unauthorized",
			"Approval responses require an authenticated client id",
		);
	}
	const authorizedClientId =
		record.targetClientId ?? record.requestedByClientId;
	if (!authorizedClientId) {
		return errorReply(
			envelope,
			"approval_unauthorized",
			`Approval ${approvalId} has no assigned client principal`,
		);
	}
	if (authorizedClientId !== clientId) {
		return errorReply(
			envelope,
			"approval_wrong_client",
			`Approval ${approvalId} is assigned to client ${authorizedClientId}`,
		);
	}
	const decision = await coordinator.respond(
		approvalId,
		{ approved, reason },
		clientId,
		sessionId,
	);
	if (decision.outcome === "conflict") {
		return errorReply(
			envelope,
			"approval_already_resolved",
			`Approval ${approvalId} is already ${decision.record.status}`,
		);
	}
	ctx.publish(
		ctx.buildEvent(
			"approval.resolved",
			{
				approvalId,
				approved: decision.record.status === "approved",
				reason: decision.record.reason,
				status: decision.record.status,
			},
			record.sessionId,
		),
	);
	const recoveryHost = ctx.sessionHost as typeof ctx.sessionHost & {
		recoverPendingRunContinuations?: (options: {
			background?: boolean;
			maxCandidates?: number;
			sessionId?: string;
		}) => Promise<unknown>;
	};
	if (recoveryHost.recoverPendingRunContinuations) {
		void recoveryHost
			.recoverPendingRunContinuations({
				background: true,
				maxCandidates: 1,
				sessionId: record.sessionId,
			})
			.catch(() => undefined);
	}
	return okReply(envelope, {
		approvalId,
		approved: decision.record.status === "approved",
		status: decision.record.status,
	});
}
