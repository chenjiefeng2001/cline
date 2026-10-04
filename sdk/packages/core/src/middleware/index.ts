/**
 * Tool middleware barrel.
 *
 * The chain itself is in active use — `local-runtime-host.ts:1166` wires
 * `idempotency` + `redaction`. The other three exports are not wired, and the
 * reasons differ, which is why they are annotated individually:
 *
 * - `createApprovalMiddleware` — **superseded**; the runtime gates approval in
 *   its preparation phase (`agent-runtime.ts:2235`), so wiring it double-prompts.
 * - `createRetryMiddleware` — **superseded**; the runtime already retries per
 *   tool (`agent-runtime.ts:2562`), so wiring it multiplies attempts.
 * - `createBudgetMiddleware` — genuinely absent from the runtime, but enabling
 *   it is a product decision (a new user-facing ceiling), not a bug fix.
 *
 * Read the module docblock before adding any of the three to a chain.
 */
export { createApprovalMiddleware } from "./approval-middleware";
export {
	BUDGET_EXCEEDED_REASON,
	type BudgetExceededDenial,
	createBudgetMiddleware,
	isBudgetExceededDenial,
	isToolDenial,
	type ToolDenial,
} from "./budget-middleware";
export {
	createRedactionMiddleware,
	DEFAULT_REDACTION_PATTERNS,
	DEFAULT_REDACTION_REPLACEMENT,
	type RedactionMiddlewareOptions,
} from "./redaction-middleware";
export {
	createRetryMiddleware,
	type RetryMiddlewareOptions,
} from "./retry-middleware";
export {
	composeToolMiddleware,
	type ToolMiddleware,
	type ToolMiddlewareChain,
	type ToolMiddlewareContext,
} from "./tool-middleware";
