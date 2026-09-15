/**
 * Approval middleware — the manual node on the chain [roadmap P1-4].
 *
 * Demotes approval from a special case in the executor to an ordinary
 * chain node: when the tool policy requires approval (`autoApprove: false`)
 * the middleware asks the host and returns a structured denial instead of
 * executing a rejected call. Approval-free calls pass through untouched.
 */

import type { ToolApprovalRequest, ToolApprovalResult } from "@cline/shared";
import { isToolDenial, type ToolDenial } from "./budget-middleware";
import type { ToolMiddleware, ToolMiddlewareContext } from "./tool-middleware";

export const TOOL_DENIED_REASON = "tool call denied by approver";

export interface ApprovalMiddlewareOptions {
	/** Host-facing approval callback (RuntimeCapabilities.requestToolApproval). */
	requestApproval: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	/** Build the host-facing approval request from the chain context. */
	buildRequest: (context: ToolMiddlewareContext) => ToolApprovalRequest;
}

export function createApprovalMiddleware(
	options: ApprovalMiddlewareOptions,
): ToolMiddleware {
	return {
		name: "approval",
		async wrap(execute, context) {
			if (context.policy?.autoApprove !== false) {
				return execute();
			}
			const verdict = await options.requestApproval(
				options.buildRequest(context),
			);
			if (verdict.approved) {
				return execute();
			}
			return {
				denied: true,
				reason: verdict.reason ?? TOOL_DENIED_REASON,
			} satisfies ToolDenial;
		},
	};
}

export { isToolDenial };
