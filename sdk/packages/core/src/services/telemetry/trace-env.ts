import {
	context,
	ROOT_CONTEXT,
	type SpanContext,
	trace,
	TraceFlags,
} from "@opentelemetry/api";

/**
 * W3C Trace Context support for cross-process trace correlation.
 *
 * Evaluation runners and CI jobs spawn the CLI as a subprocess. To anchor a
 * run's span tree (`agent.run` / `agent.tool` / `hub.command`) to the caller's
 * trace, the runner generates a W3C traceparent, passes it via the
 * `TRACEPARENT` environment variable, and the host extracts it as the parent
 * context before starting any spans. This is the standard cross-process
 * propagation mechanism (the hub's `hub.request_id` remains the in-process
 * causal correlation carrier).
 */

const TRACEPARENT_ENV = "TRACEPARENT";

const TRACEPARENT_PATTERN =
	/^([0-9a-fA-F]{2})-([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-([0-9a-fA-F]{2})$/;

/**
 * Reads the W3C traceparent from the environment. Returns `undefined` when
 * `TRACEPARENT` is unset or empty.
 */
export function traceparentFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const value = env[TRACEPARENT_ENV]?.trim();
	return value ? value : undefined;
}

/**
 * Parses a W3C traceparent (`00-<trace-id>-<span-id>-<flags>`) into a remote
 * {@link SpanContext}. Returns `undefined` for malformed or all-zero
 * identifiers so callers fall back to starting root spans.
 */
export function remoteSpanContextFromTraceparent(
	traceparent: string,
): SpanContext | undefined {
	const match = TRACEPARENT_PATTERN.exec(traceparent.trim());
	if (!match) {
		return undefined;
	}
	const [, version, traceId, spanId, flags] = match;
	if (
		version === "ff" ||
		traceId === "00000000000000000000000000000000" ||
		spanId === "0000000000000000"
	) {
		return undefined;
	}
	return {
		traceId,
		spanId,
		traceFlags: flags === "01" ? TraceFlags.SAMPLED : TraceFlags.NONE,
		isRemote: true,
	};
}

/**
 * Runs `fn` under the context extracted from the `TRACEPARENT` environment
 * variable when it is set and valid; otherwise runs `fn` unchanged. No-op
 * unless a TracerProvider is registered — spans created inside `fn` only
 * attach to the extracted trace when a provider (OpenTelemetryProvider or
 * Langfuse) made the trace pipeline active.
 */
export async function runWithTraceparentFromEnv<T>(
	fn: () => Promise<T>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
	const traceparent = traceparentFromEnv(env);
	const spanContext = traceparent
		? remoteSpanContextFromTraceparent(traceparent)
		: undefined;
	if (!spanContext) {
		return fn();
	}
	return context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), fn);
}
