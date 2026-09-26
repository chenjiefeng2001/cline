import { AgentRuntimeAbortError } from "@cline/agents";
import { initVcr, resolveClineBuildEnv } from "@cline/shared";
import { LocalRuntimeHost } from "../../runtime/host/local-runtime-host";
import { SqliteSessionStore } from "../../services/storage/sqlite-session-store";
import { CoreSessionService } from "../../session/services/session-service";
import { createLocalHubScheduleRuntimeHandlers } from "../daemon/runtime-handlers";
import { resolveHubEndpointOptions } from "../discovery/defaults";
import {
	resolveA2AClientId,
	resolveProductionHubOwnerContext,
	resolveSharedHubOwnerContext,
} from "../discovery/workspace";
import { startHubWebSocketServer } from "../server";
import { createHubDaemonTelemetry } from "./telemetry";

initVcr(process.env.CLINE_VCR);

function parseArgs(argv: string[]): {
	cwd: string;
	host?: string;
	port?: number;
	pathname?: string;
	a2a?: boolean;
} {
	let cwd = process.cwd();
	let host: string | undefined;
	let port: number | undefined;
	let pathname: string | undefined;
	let a2a: boolean | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const value = argv[index + 1];
		if (arg === "--cwd" && value) {
			cwd = value;
			index += 1;
			continue;
		}
		if (arg === "--host" && value) {
			host = value;
			index += 1;
			continue;
		}
		if (arg === "--port" && value) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				port = parsed;
			}
			index += 1;
			continue;
		}
		if (arg === "--pathname" && value) {
			pathname = value;
			index += 1;
			continue;
		}
		if (arg === "--a2a") {
			a2a = true;
		}
	}

	return { cwd, host, port, pathname, a2a };
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	process.chdir(options.cwd);

	const endpoint = resolveHubEndpointOptions({
		host: options.host,
		port: options.port,
		pathname: options.pathname,
	});

	const daemonTelemetry = createHubDaemonTelemetry();
	const owner =
		resolveClineBuildEnv() === "production"
			? resolveProductionHubOwnerContext()
			: resolveSharedHubOwnerContext();
	const a2aClientId =
		options.a2a === true ? resolveA2AClientId(owner, options.cwd) : undefined;
	const sessionHost = new LocalRuntimeHost({
		sessionService: new CoreSessionService(new SqliteSessionStore()),
		telemetry: daemonTelemetry.telemetry,
		recoveryOwner: a2aClientId,
	});

	let server: Awaited<ReturnType<typeof startHubWebSocketServer>>;
	try {
		server = await startHubWebSocketServer({
			host: endpoint.host,
			port: endpoint.port,
			pathname: endpoint.pathname,
			owner,
			telemetry: daemonTelemetry.telemetry,
			sessionHost,
			startupRecovery: () =>
				sessionHost.recoverPendingRunContinuations({ background: true }),
			runtimeHandlers: createLocalHubScheduleRuntimeHandlers({
				telemetry: daemonTelemetry.telemetry,
				sessionHost,
			}),
			cronOptions: { workspaceRoot: options.cwd },
			a2a:
				options.a2a === true
					? {
							enabled: true,
							clientId: a2aClientId,
							recoveryOwner: a2aClientId,
							defaultSessionConfig: { cwd: options.cwd },
						}
					: undefined,
		});
	} catch (error) {
		// Flush before the top-level catch exits so failed daemon starts are
		// still visible in telemetry instead of dying silently.
		await sessionHost.dispose("hub_server_start_failed").catch(() => undefined);
		await daemonTelemetry.dispose().catch(() => undefined);
		throw error;
	}

	const shutdown = async (): Promise<void> => {
		await server.close();
		await daemonTelemetry.dispose().catch(() => undefined);
		process.exit(0);
	};

	let fatalShutdownStarted = false;
	const shutdownFatal = (label: string, error: unknown): void => {
		if (fatalShutdownStarted) {
			return;
		}
		fatalShutdownStarted = true;
		const message =
			error instanceof Error ? error.stack || error.message : String(error);
		process.stderr.write(`[hub-daemon] ${label}: ${message}\n`);
		void server
			.close()
			.catch((closeError) => {
				const closeMessage =
					closeError instanceof Error
						? closeError.stack || closeError.message
						: String(closeError);
				process.stderr.write(
					`[hub-daemon] shutdown after ${label} failed: ${closeMessage}\n`,
				);
			})
			.finally(() => {
				void daemonTelemetry
					.dispose()
					.catch(() => undefined)
					.finally(() => {
						process.exit(1);
					});
			});
	};

	process.on("SIGINT", () => {
		void shutdown();
	});
	process.on("SIGTERM", () => {
		void shutdown();
	});
	process.on("uncaughtException", (error) => {
		shutdownFatal("uncaughtException", error);
	});
	process.on("unhandledRejection", (reason) => {
		if (reason instanceof AgentRuntimeAbortError) {
			process.stderr.write(
				`[hub-daemon] ignored agent runtime abort rejection: ${reason.message}\n`,
			);
			return;
		}
		shutdownFatal("unhandledRejection", reason);
	});

	await new Promise<void>(() => {
		// keep daemon process alive
	});
}

void main().catch((error) => {
	const message =
		error instanceof Error ? error.stack || error.message : String(error);
	process.stderr.write(`[hub-daemon] fatal: ${message}\n`);
	process.exit(1);
});
