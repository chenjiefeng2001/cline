/**
 * Approval middleware — the manual node on the chain [roadmap P1-4].
 *
 * **Superseded — do not add this to the tool chain.**
 *
 * Approval is already enforced in the runtime's preparation phase, which is the
 * single place a call can be gated before it runs
 * (`agent-runtime.ts:2235`, `policy.autoApprove === false` →
 * `requestToolApproval`). That path is deliberately serial and happens *before*
 * batching, so a rejected call never reaches an executor and never consumes a
 * concurrency slot.
 *
 * Registering this middleware as well would ask the host twice for the same call:
 * `wrap` re-tests `context.policy?.autoApprove !== false`, which is the same
 * condition the runtime already resolved. The user gets a duplicate prompt per
 * tool call, and a rejected call would be denied twice with two different
 * reasons depending on which layer won.
 *
 * Kept because it is exported, documented, and covered by tests, and because the
 * middleware framework itself is in active use (`idempotency` + `redaction` are
 * wired in `local-runtime-host.ts:1166`). Deleting it is a separate decision.
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
