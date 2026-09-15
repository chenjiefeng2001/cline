export { resolveCoreDistinctId } from "./distinct-id";
export {
	remoteSpanContextFromTraceparent,
	runWithTraceparentFromEnv,
	traceparentFromEnv,
} from "./trace-env";
export type {
	ITelemetryAdapter,
	TelemetryArray,
	TelemetryMetadata,
	TelemetryObject,
	TelemetryPrimitive,
	TelemetryProperties,
	TelemetryValue,
} from "./ITelemetryAdapter";
export {
	OpenTelemetryAdapter,
	type OpenTelemetryAdapterOptions,
} from "./OpenTelemetryAdapter";
export {
	type ConfiguredTelemetryHandle,
	type CreateOpenTelemetryTelemetryServiceOptions,
	createConfiguredTelemetryHandle,
	createConfiguredTelemetryService,
	createOpenTelemetryTelemetryService,
	OpenTelemetryProvider,
	type OpenTelemetryProviderOptions,
} from "./OpenTelemetryProvider";
