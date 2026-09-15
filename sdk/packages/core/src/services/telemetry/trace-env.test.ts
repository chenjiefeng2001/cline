import { describe, expect, it } from "vitest";
import { createOpenTelemetryTelemetryService } from "./OpenTelemetryProvider";
import {
	remoteSpanContextFromTraceparent,
	runWithTraceparentFromEnv,
	traceparentFromEnv,
} from "./trace-env";

const VALID_TRACEPARENT =
	"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

const metadata = {
	extension_version: "1.2.3",
	cline_type: "cli",
	platform: "terminal",
	platform_version: process.version,
	os_type: process.platform,
	os_version: "unknown",
};

describe("trace-env", () => {
	it("parses valid traceparents into remote span contexts", () => {
		const spanContext = remoteSpanContextFromTraceparent(VALID_TRACEPARENT);
		expect(spanContext).toEqual({
			traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			spanId: "00f067aa0ba902b7",
			traceFlags: 1,
			isRemote: true,
		});
	});

	it("rejects malformed and all-zero traceparents", () => {
		expect(
			remoteSpanContextFromTraceparent("not-a-traceparent"),
		).toBeUndefined();
		expect(remoteSpanContextFromTraceparent("00-ff-f-01")).toBeUndefined();
		expect(
			remoteSpanContextFromTraceparent(
				"ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			),
		).toBeUndefined();
		expect(
			remoteSpanContextFromTraceparent(
				"00-00000000000000000000000000000000-00f067aa0ba902b7-01",
			),
		).toBeUndefined();
		expect(
			remoteSpanContextFromTraceparent(
				"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
			),
		).toBeUndefined();
	});

	it("reads TRACEPARENT from the environment", () => {
		expect(traceparentFromEnv({ TRACEPARENT: VALID_TRACEPARENT })).toBe(
			VALID_TRACEPARENT,
		);
		expect(traceparentFromEnv({})).toBeUndefined();
		expect(traceparentFromEnv({ TRACEPARENT: "   " })).toBeUndefined();
	});

	it("propagates the extracted trace to spans inside fn", async () => {
		const { provider } = createOpenTelemetryTelemetryService({
			metadata,
			enabled: true,
			tracesExporter: "console",
			logsExporter: "console",
			metricsExporter: "console",
			serviceName: "cline-trace-env-test",
		});
		try {
			const tracer = provider.getTracer("trace-env-test");
			await runWithTraceparentFromEnv(
				async () => {
					const span = tracer.startSpan("verify.propagation");
					expect(span.spanContext().traceId).toBe(
						"4bf92f3577b34da6a3ce929d0e0e4736",
					);
					span.end();
				},
				{ TRACEPARENT: VALID_TRACEPARENT },
			);
		} finally {
			await provider.dispose();
		}
	});

	it("runs fn unchanged when TRACEPARENT is absent", async () => {
		const result = await runWithTraceparentFromEnv(async () => "ok", {});
		expect(result).toBe("ok");
	});
});
