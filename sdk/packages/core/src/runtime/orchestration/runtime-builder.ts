import type {
	AgentTool,
	BasicLogger,
	RuntimeConfigExtensionKind,
	TeamTeammateSpec,
} from "@cline/shared";
import { hasRuntimeConfigExtension } from "@cline/shared";
import { nanoid } from "nanoid";
import {
	createUserInstructionConfigService,
	type UserInstructionConfigType,
	type UserInstructionSourceReader,
	type UserInstructionSourceSnapshot,
} from "../../extensions/config";
import {
	createDefaultMcpServerClientFactory,
	createMcpTools,
	hasMcpSettingsFile,
	InMemoryMcpManager,
	registerMcpServersFromSettingsFile,
	resolveDefaultMcpSettingsPath,
} from "../../extensions/mcp";
import { join } from "node:path";
import { resolveClineDataDir } from "@cline/shared/storage";
import { SqliteMemoryStore } from "../../memory/stores/sqlite-memory-store";
import { createWebSearchExecutor } from "../../extensions/tools/executors/web-search";
import { createMemoryRecallTool } from "../../memory/recall-tool";
import { createMemoryRememberTool } from "../../memory/remember-tool";
import type { FileBoundary } from "../../extensions/tools/executors/file-boundary";
import {
	createBuiltinTools,
	DEFAULT_MODEL_TOOL_ROUTING_RULES,
	resolveToolPresetName,
	resolveToolRoutingConfig,	type SkillsExecutorWithMetadata,
	type ToolExecutors,
	ToolPresets,
	type ToolRoutingRule,
} from "../../extensions/tools";
import {
	AgentTeamsRuntime,
	bootstrapAgentTeams,
	createDelegatedAgentConfigProvider,
	type TeamEvent,
} from "../../extensions/tools/team";
import type { ConfiguredAgentConfig } from "../../extensions/tools/team/configured-agent-config";
import { loadConfiguredAgentConfigs } from "../../extensions/tools/team/configured-agent-config";
import { createConfiguredAgentTools } from "../../extensions/tools/team/configured-agent-tool";
import {
	filterDisabledTools,
	resolveDisabledToolNames,
} from "../../services/global-settings";
import { createLocalTeamStore } from "../../services/storage/team-store";
import { ProcessSandboxRuntime } from "../sandbox/process-sandbox-runtime";
import { createSandboxShellExecutor } from "../sandbox/sandbox-shell-executor";
import type {
	CoreAgentMode,
	CoreSandboxConfig,
	CoreSessionConfig,
} from "../../types/config";
import type {
	RuntimeBuilder,
	RuntimeBuilderInput,
	BuiltRuntime as RuntimeEnvironment,
} from "./session-runtime";
import { SubAgentRunRegistry } from "./subagent-run-registry";

function hasConfigExtension(
	extensions: ReadonlyArray<RuntimeConfigExtensionKind> | undefined,
	kind: RuntimeConfigExtensionKind,
): boolean {
	return hasRuntimeConfigExtension(extensions, kind);
}

const SERVER_RUNTIME_SOURCE_TYPES: Partial<
	Record<RuntimeConfigExtensionKind, UserInstructionConfigType>
> = {
	rules: "rule",
	skills: "skill",
	workflows: "workflow",
};

function resolveServerRuntimeSourceTypes(
	extensions: ReadonlyArray<RuntimeConfigExtensionKind> | undefined,
): UserInstructionConfigType[] | undefined {
	if (!extensions || extensions.includes("plugins")) {
		return undefined;
	}
	const types = extensions
		.map((extension) => SERVER_RUNTIME_SOURCE_TYPES[extension])
		.filter((type): type is UserInstructionConfigType => Boolean(type));
	return [...new Set(types)];
}

function isToolEnabledByPolicies(
	toolName: string,
	toolPolicies: CoreSessionConfig["toolPolicies"],
): boolean {
	const globalPolicy = toolPolicies?.["*"] ?? {};
	const toolPolicy = toolPolicies?.[toolName] ?? {};
	return (
		{
			...globalPolicy,
			...toolPolicy,
		}.enabled !== false
	);
}

function filterToolsByPolicies(
	tools: AgentTool[],
	toolPolicies: CoreSessionConfig["toolPolicies"],
): AgentTool[] {
	return tools.filter((tool) =>
		isToolEnabledByPolicies(tool.name, toolPolicies),
	);
}

function filterAvailableTools(
	tools: AgentTool[],
	toolPolicies: CoreSessionConfig["toolPolicies"],
): AgentTool[] {
	return filterDisabledTools(filterToolsByPolicies(tools, toolPolicies));
}

const CONFIGURED_AGENT_TOOL_NAME_ALIASES: Record<string, string> = {
	apply_diff: "editor",
	attempt_completion: "submit_and_exit",
	bash: "run_commands",
	execute_command: "run_commands",
	list_code_definition_names: "search_codebase",
	list_files: "run_commands",
	read_file: "read_files",
	replace_in_file: "editor",
	search_files: "search_codebase",
	use_skill: "skills",
	write_to_file: "editor",
};

function resolveConfiguredAgentToolName(toolName: string): string {
	const normalized = toolName.trim().toLowerCase();
	return CONFIGURED_AGENT_TOOL_NAME_ALIASES[normalized] ?? normalized;
}

function filterToolsForConfiguredAgent(
	tools: AgentTool[],
	agent: ConfiguredAgentConfig,
): AgentTool[] {
	if (agent.tools === undefined) {
		return tools;
	}

	const allowedToolNames = new Set(
		agent.tools.map(resolveConfiguredAgentToolName),
	);
	if (agent.skills !== undefined) {
		allowedToolNames.add("skills");
	}
	return tools.filter((tool) => allowedToolNames.has(tool.name));
}

export function createTeamName(): string {
	return `team-${nanoid(5)}`;
}

function createBuiltinToolsList(
	cwd: string,
	providerId: string,
	mode: CoreAgentMode,
	modelId: string,
	toolRoutingRules: ToolRoutingRule[] | undefined,
	toolPolicies: CoreSessionConfig["toolPolicies"],
	skillsExecutor?: SkillsExecutorWithMetadata,
	executorOverrides?: Partial<ToolExecutors>,
	fileBoundary?: FileBoundary,
	sandbox?: CoreSandboxConfig,
): AgentTool[] {
	const preset = ToolPresets[resolveToolPresetName({ mode })];
	const toolRoutingConfig = resolveToolRoutingConfig(
		providerId,
		modelId,
		mode,
		toolRoutingRules ?? DEFAULT_MODEL_TOOL_ROUTING_RULES,
	);
	// The sandbox replaces the shell executor wholesale rather than adding an
	// option to it: the isolation has to wrap the process, which is the only
	// layer that also covers what the command spawns. Applied last so it wins
	// over any host-supplied bash override — a host that asked for sandboxing
	// must not silently get an unsandboxed shell back from an override.
	const sandboxExecutor = sandbox?.enabled
		? createSandboxShellExecutor({
				sandbox: new ProcessSandboxRuntime({
					workspaceRoot: sandbox.workspaceRoot ?? cwd,
					networkAccess: sandbox.networkAccess,
					backend: sandbox.backend,
				}),
			})
		: undefined;

	return filterAvailableTools(
		createBuiltinTools({
			cwd,
			...preset,
			enableSkills: !!skillsExecutor,
			...toolRoutingConfig,
			// The boundary belongs on the executors rather than the tool definitions:
			// the tools are what the model sees, the executors are what touch the disk.
			// Omitted when the host did not configure one, which leaves the historical
			// unrestricted behaviour untouched.
			//
			// applyPatch is here for the same reason, and its absence was a hole: with
			// read and write bounded but patch unbounded, the boundary was bypassable by
			// asking for the other file tool. Anything that writes to a path the model
			// supplies has to be in this list or the guarantee is decorative.
			...(fileBoundary
				? {
						executorOptions: {
							fileRead: { boundary: fileBoundary },
							editor: { boundary: fileBoundary },
							applyPatch: { boundary: fileBoundary },
						},
					}
				: {}),
			executors: {
				...(skillsExecutor
					? {
							skills: skillsExecutor,
						}
					: {}),
				...(executorOverrides ?? {}),
				...(sandboxExecutor ? { bash: sandboxExecutor } : {}),
			},
		}),
		toolPolicies,
	);
}

/**
 * Resolve the session's file-tool boundary from config.
 *
 * Returns undefined when the host did not opt in, or when it opted out explicitly -
 * "unset" and "disabled" both mean unconstrained, which keeps the historical
 * behaviour reachable from configuration rather than requiring a code change.
 */
export function resolveFileBoundary(
	// cwd is taken as its own argument rather than picked, because CoreSessionConfig
	// declares it required and every caller here already has it to hand.
	config: Pick<CoreSessionConfig, "fileBoundary" | "workspaceRoot">,
	cwd: string,
): FileBoundary | undefined {
	const boundary = config.fileBoundary;
	if (!boundary || boundary.enabled === false) {
		return undefined;
	}
	const derived = config.workspaceRoot ?? cwd;
	if (!derived) {
		return undefined;
	}
	return {
		root: boundary.roots?.[0] ?? derived,
		additionalRoots: [...(boundary.roots?.slice(1) ?? []), ...(boundary.additionalRoots ?? [])],
	};
}

function isSkillsToolEnabledForSession(input: {
	cwd: string;
	providerId: string;
	mode: CoreAgentMode;
	modelId: string;
	toolRoutingRules?: ToolRoutingRule[];
	toolPolicies?: CoreSessionConfig["toolPolicies"];
	toolExecutors?: Partial<ToolExecutors>;
}): boolean {
	return createBuiltinToolsList(
		input.cwd,
		input.providerId,
		input.mode,
		input.modelId,
		input.toolRoutingRules,
		input.toolPolicies,
		SKILLS_PROBE_EXECUTOR,
		input.toolExecutors,
	).some((tool) => tool.name === "skills");
}

const SKILLS_PROBE_EXECUTOR = (async () => "") as SkillsExecutorWithMetadata;

/**
 * Build the memory tools for a session, if memory is enabled for it.
 *
 * Three independent switches, because the two write paths have very different
 * risk profiles and a single toggle cannot express that:
 *
 * - `memory.enabled` is the master. Off, no store is opened and no tool is exposed.
 * - `memory.recallEnabled` exposes `recall_memory`, which only reads. It is on by
 *   default because a read of a store that is empty is harmless.
 * - `memory.writeEnabled` exposes `remember`, which lets the model persist records
 *   that outlive the conversation. It is off by default: that is data retention
 *   outside the transcript, and it should be something the user turned on rather
 *   than something they inherited.
 * - `memory.autoCaptureEnabled` turns on the automatic write path.
 *
 * With no write path enabled the store can never be populated, so the recall tool
 * would be advertised to the model while being incapable of returning anything.
 * Rather than show an empty tool, recall is withheld too - a capability that cannot
 * succeed is worse than an absent one, because the model will plan around it.
 */
/**
 * Live web search, exposed only when the host opts in.
 *
 * Unlike the memory layer this has no "not configured" state worth hiding: with no
 * credential the executor reports exactly which environment variable or setting to
 * set, which is more useful to the model than a tool that refuses to exist. So the
 * only gate is the host's explicit opt-in, and the default is off because a search
 * sends the model's query text to a third party - a different kind of egress than
 * reading a file, and the user's call rather than ours.
 */
function buildWebSearchTools(config: CoreSessionConfig): AgentTool<unknown, unknown>[] {
	const webSearch = config.webSearch;
	if (!webSearch?.enabled) {
		return [];
	}
	const search = createWebSearchExecutor({
		...(webSearch.provider === undefined ? {} : { provider: webSearch.provider }),
		...(webSearch.apiKey === undefined ? {} : { apiKey: webSearch.apiKey }),
		...(webSearch.maxResults === undefined ? {} : { maxResults: webSearch.maxResults }),
	});
	return [
		{
			name: "web_search",
			description:
				"Search the public web and return ranked results with title, url and snippet. " +
				"Use for facts that may have changed since training, or that you cannot verify locally. " +
				"Prefer reading a specific file or running a command when the answer is in the workspace.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "The search query." },
				},
				required: ["query"],
			},
			execute: async (input: unknown, context) => {
				const { query } = (input ?? {}) as { query?: unknown }
				return search(typeof query === "string" ? query : "", context)
			},
		} as AgentTool<unknown, unknown>,
	]
}

async function buildMemoryTools(config: CoreSessionConfig): Promise<AgentTool<unknown, unknown>[]> {
	const memory = config.memory;
	if (!memory?.enabled) {
		return [];
	}
	if (!memory.writeEnabled && !memory.autoCaptureEnabled) {
		// Nothing can write, so nothing can be recalled. Return empty rather than
		// exposing a permanently empty read.
		return [];
	}
	const dbPath = memory.dbPath ?? join(resolveClineDataDir(), "memory.db");
	const store = new SqliteMemoryStore({ dbPath });
	await store.init();
	const tools: AgentTool<unknown, unknown>[] = [];
	if (memory.recallEnabled !== false) {
		tools.push(createMemoryRecallTool({ store, workspacePath: config.workspaceRoot ?? config.cwd }) as AgentTool<unknown, unknown>);
	}
	if (memory.writeEnabled) {
		tools.push(createMemoryRememberTool({ store, workspacePath: config.workspaceRoot ?? config.cwd }) as AgentTool<unknown, unknown>);
	}
	return tools;
}

async function loadConfiguredMcpTools(logger?: BasicLogger): Promise<{	tools: AgentTool[];
	shutdown?: () => Promise<void>;
}> {
	const settingsPath = resolveDefaultMcpSettingsPath();
	if (!hasMcpSettingsFile({ filePath: settingsPath })) {
		return { tools: [] };
	}

	const manager = new InMemoryMcpManager({
		clientFactory: createDefaultMcpServerClientFactory({
			settingsPath,
		}),
	});

	let registrations: Awaited<
		ReturnType<typeof registerMcpServersFromSettingsFile>
	>;
	try {
		registrations = await registerMcpServersFromSettingsFile(manager, {
			filePath: settingsPath,
		});
	} catch (error) {
		await manager.dispose().catch(() => {});
		const message = error instanceof Error ? error.message : String(error);
		logger?.log(
			`[mcp] Failed to load MCP settings, skipping MCP tools: ${message}`,
		);
		return { tools: [] };
	}

	const enabled = registrations.filter((r) => r.disabled !== true);
	const results = await Promise.allSettled(
		enabled.map((r) =>
			createMcpTools({ serverName: r.name, provider: manager }),
		),
	);
	const tools: AgentTool<unknown, unknown>[] = [];
	for (const [i, result] of results.entries()) {
		if (result.status === "fulfilled") {
			tools.push(...result.value);
		} else {
			const message =
				result.reason instanceof Error
					? result.reason.message
					: String(result.reason);
			logger?.log(
				`[mcp] Failed to load tools from MCP server "${enabled[i].name}", skipping: ${message}`,
			);
		}
	}

	return {
		tools,
		shutdown: async () => {
			await manager.dispose();
		},
	};
}

function shutdownTeamRuntime(
	teamRuntime: AgentTeamsRuntime | undefined,
	reason: string,
): void {
	if (!teamRuntime) {
		return;
	}
	for (const teammateId of teamRuntime.getTeammateIds()) {
		try {
			teamRuntime.shutdownTeammate(teammateId, reason);
		} catch {
			// Best-effort shutdown for all teammates.
		}
	}
}

function isRuntimeLifecycleShutdownReason(reason: string | undefined): boolean {
	if (reason === undefined) {
		return true;
	}
	switch (reason) {
		case "session_stop":
		case "session_complete":
		case "session_error":
		case "session_manager_dispose":
		case "cli_run_shutdown":
		case "cli_interactive_shutdown":
		case "cli_interactive_startup_cancelled":
		case "provider_change":
		case "acp_shutdown":
		case "hub_server_stop":
		case "vscode_webview_dispose":
			return true;
		default:
			return false;
	}
}

function normalizeConfig(
	config: CoreSessionConfig,
): Required<
	Pick<
		CoreSessionConfig,
		| "mode"
		| "enableTools"
		| "enableSpawnAgent"
		| "enableAgentTeams"
		| "disableMcpSettingsTools"
		| "yolo"
		| "missionLogIntervalSteps"
		| "missionLogIntervalMs"
		| "sessionId"
	>
> {
	const preset = ToolPresets[resolveToolPresetName({ mode: config.mode })];
	return {
		sessionId: config.sessionId || "",
		mode:
			config.mode === "plan" ? "plan" : config.mode === "yolo" ? "yolo" : "act",
		enableTools: config.enableTools !== false,
		enableSpawnAgent:
			config.enableSpawnAgent ?? preset.enableSpawnAgent ?? true,
		enableAgentTeams:
			config.enableAgentTeams ?? preset.enableAgentTeams ?? true,
		disableMcpSettingsTools: config.disableMcpSettingsTools === true,
		yolo: config.yolo === true,
		missionLogIntervalSteps:
			typeof config.missionLogIntervalSteps === "number" &&
			Number.isFinite(config.missionLogIntervalSteps)
				? config.missionLogIntervalSteps
				: 3,
		missionLogIntervalMs:
			typeof config.missionLogIntervalMs === "number" &&
			Number.isFinite(config.missionLogIntervalMs)
				? config.missionLogIntervalMs
				: 120000,
	};
}

export class DefaultRuntimeBuilder implements RuntimeBuilder {
	private readonly teamRuntimeEntries = new Map<
		string,
		{
			runtime?: AgentTeamsRuntime;
			/**
			 * Backgrounded sub-agent runs, one per session key. Held here rather than
			 * on the built runtime so a result outlives the run that produced it,
			 * which is the whole point of backgrounding.
			 */
			subAgentRuns?: SubAgentRunRegistry;
			delegatedAgentConfigProvider: ReturnType<
				typeof createDelegatedAgentConfigProvider
			>;
		}
	>();

	async build(input: RuntimeBuilderInput): Promise<RuntimeEnvironment> {
		const {
			config,
			hooks,
			extensions,
			logger,
			telemetry,
			createSpawnTool,
			onTeamRestored,
			userInstructionService: sharedUserInstructionService,
			configExtensions,
			toolExecutors,
			wrapTools,
		} = input;
		const onTeamEvent = input.onTeamEvent ?? (() => {});
		const normalized = normalizeConfig(config);
		const workspaceConfigRoot = config.workspaceRoot ?? config.cwd;
		// Resolved once and shared by the lead agent, configured subagents and the
		// team lead, so every agent in a session is bounded identically. Undefined
		// when the host did not configure one, which leaves the tools unrestricted.
		const fileBoundary = resolveFileBoundary(config, config.cwd);
		const effectiveToolPolicies = input.toolPolicies ?? config.toolPolicies;
		const globallyDisabledToolNames = resolveDisabledToolNames();
		const tools: AgentTool<unknown, unknown>[] = [];
		const effectiveTeamName = config.teamName?.trim() || createTeamName();
		const teamStoreKey = config.sessionId?.trim() || effectiveTeamName;
		const configuredAgents = normalized.enableSpawnAgent
			? loadConfiguredAgentConfigs({
					workspaceRoot: workspaceConfigRoot,
				})
			: { configs: [], errors: [] };
		const configuredAgentsNeedSkills = configuredAgents.configs.some(
			(agent) => agent.skills !== undefined,
		);
		const rulesEnabled = hasConfigExtension(configExtensions, "rules");
		const rootSkillsEnabled = hasConfigExtension(configExtensions, "skills");
		const needsSkillsConfigService =
			rootSkillsEnabled || configuredAgentsNeedSkills;
		const workflowsEnabled = hasConfigExtension(configExtensions, "workflows");
		const pluginsEnabled = hasConfigExtension(configExtensions, "plugins");
		const userInstructionsEnabled =
			rulesEnabled || rootSkillsEnabled || workflowsEnabled;
		let teamToolsRegistered = false;
		const userInstructionServiceProvided = Boolean(
			sharedUserInstructionService,
		);
		let userInstructionService = sharedUserInstructionService;
		let userInstructionServiceStarted = false;
		let mcpShutdown: (() => Promise<void>) | undefined;

		for (const error of configuredAgents.errors) {
			(logger ?? config.logger)?.log?.(
				`[agents] Failed to load agent config at ${error.path}: ${error.error.message}`,
			);
		}

		if (
			!userInstructionService &&
			(userInstructionsEnabled || configuredAgentsNeedSkills)
		) {
			userInstructionService = createUserInstructionConfigService({
				skills: needsSkillsConfigService
					? {
							workspacePath: workspaceConfigRoot,
							includePluginSkills: pluginsEnabled,
							pluginSkillDirectories: pluginsEnabled
								? input.pluginSkillDirectories
								: undefined,
							pluginPaths: config.pluginPaths,
							cwd: config.cwd,
						}
					: { workspacePath: workspaceConfigRoot },
				rules: { workspacePath: config.cwd },
				workflows: { workspacePath: config.cwd },
			});
		}

		if (userInstructionService) {
			try {
				await userInstructionService.start();
				userInstructionServiceStarted = true;
			} catch {}
		}
		const serverRuntimeSourceTypes =
			resolveServerRuntimeSourceTypes(configExtensions);
		const runtimeSourceTypes: UserInstructionConfigType[] = [
			...new Set<UserInstructionConfigType>([
				...(serverRuntimeSourceTypes ??
					(["rule", "skill", "workflow"] as UserInstructionConfigType[])),
				...(configuredAgentsNeedSkills
					? (["skill"] as UserInstructionConfigType[])
					: []),
			]),
		];
		let activeRuntimeSourceSnapshot: UserInstructionSourceSnapshot | undefined;
		let activeRecoverySourceSnapshot: UserInstructionSourceSnapshot | undefined;
		let sourceLeaseCount = 0;
		const captureRuntimeSource = (): void => {
			if (
				!userInstructionServiceStarted ||
				!userInstructionService?.captureSourceSnapshot
			) {
				return;
			}
			activeRuntimeSourceSnapshot =
				userInstructionService.captureSourceSnapshot(runtimeSourceTypes);
			activeRecoverySourceSnapshot = serverRuntimeSourceTypes
				? userInstructionService.captureSourceSnapshot(serverRuntimeSourceTypes)
				: undefined;
		};
		captureRuntimeSource();
		const liveSourceReader: UserInstructionSourceReader = {
			getSnapshot: (type) =>
				new Map(
					(userInstructionService?.listRecords(type) ?? []).map((record) => [
						record.id,
						{
							type,
							id: record.id,
							contentHash: record.contentHash,
							item: record.item,
						},
					]),
				),
		};
		const runtimeSourceReader: UserInstructionSourceReader = {
			getSnapshot: (type) =>
				(activeRuntimeSourceSnapshot ?? liveSourceReader).getSnapshot(type),
		};
		const acquireUserInstructionRun = (): (() => void) | undefined => {
			if (
				!userInstructionServiceStarted ||
				!userInstructionService?.captureSourceSnapshot ||
				runtimeSourceTypes.length === 0
			) {
				return undefined;
			}
			if (sourceLeaseCount === 0) {
				captureRuntimeSource();
				if (!activeRuntimeSourceSnapshot) {
					throw new Error("User instruction source snapshot is unavailable");
				}
			}
			sourceLeaseCount += 1;
			let released = false;
			return () => {
				if (released) {
					return;
				}
				released = true;
				sourceLeaseCount = Math.max(0, sourceLeaseCount - 1);
				if (sourceLeaseCount === 0) {
					activeRuntimeSourceSnapshot = undefined;
					activeRecoverySourceSnapshot = undefined;
				}
			};
		};
		const getServerRuntimeSourceReference =
			!userInstructionServiceProvided &&
			serverRuntimeSourceTypes &&
			userInstructionServiceStarted
				? () =>
						activeRecoverySourceSnapshot?.reference ??
						userInstructionService?.getSourceReference?.(
							serverRuntimeSourceTypes,
						)
				: undefined;

		const registerSkillsTool =
			normalized.enableTools &&
			rootSkillsEnabled &&
			Boolean(userInstructionService) &&
			userInstructionService?.hasConfiguredSkills(config.skills) === true &&
			isSkillsToolEnabledForSession({
				cwd: config.cwd,
				providerId: config.providerId,
				mode: normalized.mode,
				modelId: config.modelId,
				toolRoutingRules: config.toolRoutingRules,
				toolPolicies: effectiveToolPolicies,
				toolExecutors,
			});

		const userInstructionPlugin =
			userInstructionService && userInstructionsEnabled
				? userInstructionService.createExtension(
						{
							includeRules: rulesEnabled,
							includeSkills: rootSkillsEnabled,
							includeWorkflows: workflowsEnabled,
							registerSkillsTool,
							allowedSkillNames: config.skills,
						},
						runtimeSourceReader,
					)
				: undefined;
		const runtimeExtensions = userInstructionPlugin
			? [...(extensions ?? config.extensions ?? []), userInstructionPlugin]
			: (extensions ?? config.extensions);

		if (normalized.enableTools) {
			tools.push(
				...createBuiltinToolsList(
					config.cwd,
					config.providerId,
					normalized.mode,
					config.modelId,
					config.toolRoutingRules,
					effectiveToolPolicies,
					undefined,
					toolExecutors,
					fileBoundary,
					config.sandbox,
				),
			);
			if (!normalized.disableMcpSettingsTools) {
				const mcpRuntime = await loadConfiguredMcpTools(config.logger);
				tools.push(...mcpRuntime.tools);
				mcpShutdown = mcpRuntime.shutdown;
			}

			const memoryTools = await buildMemoryTools(config);
			if (memoryTools.length > 0) {
				tools.push(...memoryTools);
			}

			const searchTools = buildWebSearchTools(config);
			if (searchTools.length > 0) {
				tools.push(...searchTools);
			}
		}

		let teamRuntime: AgentTeamsRuntime | undefined;
		const teamStore = normalized.enableAgentTeams
			? createLocalTeamStore()
			: undefined;
		const restoredTeam = teamStore?.loadRuntime(teamStoreKey);
		const restoredTeamState = restoredTeam?.state;
		const restoredTeammateSpecs = restoredTeam?.teammates ?? [];
		const teammateSpecs = new Map(
			restoredTeammateSpecs.map((spec) => [spec.agentId, spec] as const),
		);
		const registryKey = config.sessionId || effectiveTeamName;
		let leadAgentInstance:
			| {
					addTools: (tools: AgentTool[]) => void;
			  }
			| undefined;
		let pendingLeadTeamTools: AgentTool[] = [];
		let restoredStateHydratedIntoRuntime = false;
		const delegatedAgentConfigProvider = createDelegatedAgentConfigProvider({
			sessionId: config.sessionId,
			providerId: config.providerId,
			modelId: config.modelId,
			cwd: config.cwd,
			apiKey: config.apiKey ?? "",
			baseUrl: config.baseUrl,
			headers: config.headers,
			providerConfig: config.providerConfig,
			knownModels: config.knownModels,
			thinking: config.thinking,
			reasoningEffort: config.reasoningEffort,
			thinkingBudgetTokens: config.thinkingBudgetTokens,
			maxTokensPerTurn: config.maxTokensPerTurn,
			temperature: config.temperature,
			maxIterations: config.maxIterations,
			// Forwarded from the session's execution guards. Distinct from
			// `maxIterations`, which counts model round-trips: one turn can issue many
			// tool calls, so the iteration cap says nothing about them.
			maxToolCalls: config.execution?.maxToolCalls,
			hooks,
			extensions: runtimeExtensions,
			logger: logger ?? config.logger,
			telemetry: input.telemetry ?? config.telemetry,
			workspaceMetadata: config.workspaceMetadata,
		});
		if (normalized.enableSpawnAgent) {
			if (configuredAgents.configs.length > 0) {
				tools.push(
					...filterAvailableTools(
						createConfiguredAgentTools({
							configProvider: delegatedAgentConfigProvider,
							agents: configuredAgents.configs,
							createSubAgentTools: (agent) =>
								normalized.enableTools
									? filterToolsForConfiguredAgent(
											createBuiltinToolsList(
												config.cwd,
												agent.providerId ?? config.providerId,
												normalized.mode,
												agent.modelId ?? config.modelId,
												config.toolRoutingRules,
												effectiveToolPolicies,
												agent.skills !== undefined &&
													userInstructionService?.createSkillsExecutor
													? userInstructionService.createSkillsExecutor(
															agent.skills,
															runtimeSourceReader,
														)
													: undefined,
												toolExecutors,
												fileBoundary,
												config.sandbox,
											),
											agent,
										)
									: [],
							hookErrorMode: config.hookErrorMode,
							toolPolicies: effectiveToolPolicies,
							requestToolApproval: input.requestToolApproval,
							onSubAgentEvent: input.onSubAgentEvent,
							onSubAgentStart: input.onSubAgentStart,
							onSubAgentEnd: input.onSubAgentEnd,
							wrapTools,
						}),
						effectiveToolPolicies,
					),
				);
			}
		}
if (!this.teamRuntimeEntries.has(registryKey)) {
			this.teamRuntimeEntries.set(registryKey, {
				delegatedAgentConfigProvider,
			});
		}

		const sessionEntry = this.teamRuntimeEntries.get(registryKey) as {
			runtime?: AgentTeamsRuntime;
			subAgentRuns?: SubAgentRunRegistry;
			delegatedAgentConfigProvider: ReturnType<
				typeof createDelegatedAgentConfigProvider
			>;
		};
		// Created once per session key, not per run, so a result stays readable
		// after the run that produced it has finished. Deliberately independent of
		// `enableAgentTeams`: backgrounding is a sub-agent feature, and gating it
		// on teams would hide it from every session with teams off.
		sessionEntry.subAgentRuns ??= new SubAgentRunRegistry();
		this.teamRuntimeEntries.set(registryKey, sessionEntry);
		const subAgentRuns = sessionEntry.subAgentRuns;

		const ensureTeamRuntime = (): AgentTeamsRuntime | undefined => {
			if (!normalized.enableAgentTeams) {
				return undefined;
			}

			const registryEntry = sessionEntry;
			teamRuntime = registryEntry.runtime;

			if (!teamRuntime) {
				teamRuntime = new AgentTeamsRuntime({
					teamName: effectiveTeamName,
					leadAgentId: config.sessionId || "lead",
					missionLogIntervalSteps: normalized.missionLogIntervalSteps,
					missionLogIntervalMs: normalized.missionLogIntervalMs,
					wrapTools,
					onTeamEvent: (event: TeamEvent) => {
						onTeamEvent(event);
						if (teamRuntime && teamStore) {
							if (
								event.type === "teammate_spawned" &&
								event.teammate?.rolePrompt
							) {
								const spec: TeamTeammateSpec = {
									agentId: event.agentId,
									rolePrompt: event.teammate.rolePrompt,
									modelId: event.teammate.modelId,
									maxIterations: event.teammate.maxIterations,
								};
								teammateSpecs.set(spec.agentId, spec);
							}
							if (
								event.type === "teammate_shutdown" &&
								!isRuntimeLifecycleShutdownReason(event.reason)
							) {
								teammateSpecs.delete(event.agentId);
							}
							teamStore.handleTeamEvent(teamStoreKey, event);
							teamStore.persistRuntime(
								teamStoreKey,
								teamRuntime.exportState(),
								Array.from(teammateSpecs.values()),
							);
						}
					},
				});
				if (restoredTeamState) {
					teamRuntime.hydrateState(restoredTeamState);
					restoredStateHydratedIntoRuntime = true;
				}
				registryEntry.runtime = teamRuntime;
			}

			if (!teamToolsRegistered) {
				if (!teamRuntime) {
					return undefined;
				}
				teamToolsRegistered = true;

				const teamBootstrap = bootstrapAgentTeams({
					runtime: teamRuntime,
					leadAgentId: config.sessionId || "lead",
					restoredFromPersistence: Boolean(restoredTeamState),
					restoredTeammates: restoredTeammateSpecs,
					includeLeadSpawnTool: true,
					includeLeadManagementTools: true,
					onLeadToolsUnlocked: (teamTools) => {
						pendingLeadTeamTools = teamTools;
						leadAgentInstance?.addTools(teamTools);
					},
					createBaseTools: normalized.enableTools
						? () =>
								createBuiltinToolsList(
									config.cwd,
									config.providerId,
									normalized.mode,
									config.modelId,
									config.toolRoutingRules,
									effectiveToolPolicies,
									undefined,
									toolExecutors,
									fileBoundary,
									config.sandbox,
								)
						: undefined,
					teammateConfigProvider: delegatedAgentConfigProvider,
					wrapTools,
				});

				if (restoredStateHydratedIntoRuntime) {
					teamRuntime.recoverActiveRuns("runtime_recovered");
				}

				if (teamBootstrap.restoredFromPersistence) {
					onTeamRestored?.();
				}
				tools.push(...teamBootstrap.tools);
			}

			return teamRuntime;
		};

		if (normalized.enableSpawnAgent && createSpawnTool) {
			// The registry reaches the tool here, which is what makes
			// `background: true` readable instead of fire-and-forget.
			const spawnTool = createSpawnTool(subAgentRuns);
			tools.push({
				...spawnTool,
				execute: async (spawnInput, context) => {
					ensureTeamRuntime();
					return spawnTool.execute(spawnInput, context);
				},
			});
		}

		if (normalized.enableAgentTeams) {
			ensureTeamRuntime();
		}

		const finalTools = filterAvailableTools(tools, effectiveToolPolicies);
		const requiresCompletionTool = finalTools.some(
			(tool) =>
				tool.name === "submit_and_exit" &&
				tool.lifecycle?.completesRun === true,
		);
		const teamCompletionGuard = normalized.enableAgentTeams
			? (): string | undefined => {
					const rt = this.teamRuntimeEntries.get(registryKey)?.runtime;
					if (!rt) return undefined;
					const tasks = rt.listTasks();
					const hasInProgress = tasks.some(
						(t) => t.status === "in_progress" || t.status === "pending",
					);
					const runs = rt.listRuns({});
					const hasActiveRuns = runs.some(
						(r) => r.status === "running" || r.status === "queued",
					);
					if (hasInProgress || hasActiveRuns) {
						const pending = tasks
							.filter(
								(t) => t.status === "in_progress" || t.status === "pending",
							)
							.map((t) => `${t.id} (${t.status}): ${t.title}`)
							.join(", ");
						const activeRunSummary = runs
							.filter((r) => r.status === "running" || r.status === "queued")
							.map((r) => `${r.id} (${r.status})`)
							.join(", ");
						const parts = [];
						if (pending) parts.push(`Unfinished tasks: ${pending}`);
						if (activeRunSummary)
							parts.push(`Active runs: ${activeRunSummary}`);
						return `[SYSTEM] You still have team obligations. ${parts.join(". ")}. Use team_run_task to delegate work, or team_task with action=complete to mark tasks done, or team_await_runs to wait for active runs. Do NOT stop until all tasks are completed.`;
					}
					return undefined;
				}
			: undefined;
		const completionPolicy = requiresCompletionTool
			? {
					requireCompletionTool: true,
					...(teamCompletionGuard
						? { completionGuard: teamCompletionGuard }
						: {}),
				}
			: teamCompletionGuard
				? { completionGuard: teamCompletionGuard }
				: undefined;

		return {
			tools: finalTools,
			logger: logger ?? config.logger,
			telemetry: telemetry ?? config.telemetry,
			teamRuntime,
			teamRestoredFromPersistence: Boolean(restoredTeamState),
			// Exposed so the host can drain, prune or report outstanding runs at
			// session teardown.
			subAgentRuns,
			delegatedAgentConfigProvider:
				this.teamRuntimeEntries.get(registryKey)
					?.delegatedAgentConfigProvider ?? delegatedAgentConfigProvider,
			extensions: runtimeExtensions,
			completionPolicy,
			...(getServerRuntimeSourceReference
				? { getServerRuntimeSourceReference }
				: {}),
			...(userInstructionServiceStarted &&
			userInstructionService?.captureSourceSnapshot &&
			runtimeSourceTypes.length > 0
				? { acquireUserInstructionRun }
				: {}),
			registerLeadAgent: (agent) => {
				leadAgentInstance = agent;
				if (pendingLeadTeamTools.length > 0) {
					agent.addTools(
						filterDisabledTools(pendingLeadTeamTools, [
							...globallyDisabledToolNames,
						]),
					);
				}
			},
			shutdown: async (reason: string) => {
				shutdownTeamRuntime(teamRuntime, reason);
				this.teamRuntimeEntries.delete(registryKey);
				await mcpShutdown?.();
				if (!userInstructionServiceProvided) {
					userInstructionService?.stop();
				}
			},
		};
	}
}
