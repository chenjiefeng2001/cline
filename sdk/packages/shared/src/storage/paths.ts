import type { Dirent } from "node:fs";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PluginManifest } from "..";

/**
 * True when `childPath` resolves to `parentPath` itself or to something inside
 * it. Purely lexical: it defeats `..` traversal and absolute-path escapes, but
 * NOT symlinks. Anything reading from disk must resolve the real path of both
 * sides first — see `resolveContainedPath`.
 */
export function isPathWithin(parentPath: string, childPath: string): boolean {
	const relativePath = relative(resolve(parentPath), resolve(childPath));
	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !isAbsolute(relativePath))
	);
}

/**
 * Thrown when a caller-supplied path resolves outside the root it was confined
 * to. Distinct from an fs error so callers can treat a policy rejection
 * differently from a missing file.
 */
export class PathEscapesRootError extends Error {
	constructor(
		readonly candidate: string,
		readonly root: string,
	) {
		super(`Path escapes the allowed root: ${candidate} is outside ${root}`);
		this.name = "PathEscapesRootError";
	}
}

/**
 * Resolve `candidate` and require it to stay inside `root` after symlinks are
 * followed. This is the containment check for anything a caller outside the
 * process supplies: a lexical check alone still lets a symlink inside the
 * workspace point at `/etc/shadow`.
 *
 * `realpath` is applied to the root too, so a workspace that is itself reached
 * through a symlink compares correctly.
 */
export async function resolveContainedPath(
	root: string,
	candidate: string,
	options: { mustExist?: boolean } = {},
): Promise<string> {
	const { realpath } = await import("node:fs/promises");
	const realRoot = await realpath(resolve(root));
	const resolved = resolve(realRoot, candidate);
	let realCandidate: string;
	try {
		realCandidate = await realpath(resolved);
	} catch (error) {
		if (options.mustExist) {
			throw error;
		}
		// The target does not exist yet. Its nearest existing ancestor still has
		// to be inside the root, otherwise a create-through-traversal would slip
		// through the gap between the lexical check and the write.
		const parent = dirname(resolved);
		if (parent === resolved) {
			throw error;
		}
		const realParent = await realpath(parent);
		realCandidate = resolve(realParent, relative(parent, resolved));
	}
	if (!isPathWithin(realRoot, realCandidate)) {
		throw new PathEscapesRootError(candidate, root);
	}
	return realCandidate;
}

const DEPRECATED_CONFIG_DIR = ".clinerules";
const CLINE_CONFIG_DIR = ".cline";
const LEGACY_AGENT_SKILLS_CONFIG_DIR = ".agents";

export const AGENT_CONFIG_DIRECTORY_NAME = "agents";
export const HOOKS_CONFIG_DIRECTORY_NAME = "hooks";
export const SKILLS_CONFIG_DIRECTORY_NAME = "skills";
export const RULES_CONFIG_DIRECTORY_NAME = "rules";
export const WORKFLOWS_CONFIG_DIRECTORY_NAME = "workflows";
export const PLUGINS_DIRECTORY_NAME = "plugins";
export const AGENTS_RULES_FILE_NAME = "AGENTS.md";

export const CLINE_MCP_SETTINGS_FILE_NAME = "cline_mcp_settings.json";
export const CLINE_CONNECTOR_SETTINGS_FILE_NAME = "settings.json";

function resolveDefaultHomeDir(): string {
	const envHome = process?.env?.HOME?.trim();
	if (envHome && envHome !== "~") {
		return envHome;
	}
	const envUserProfile = process?.env?.USERPROFILE?.trim();
	if (envUserProfile) {
		return envUserProfile;
	}
	const envHomeDrive = process?.env?.HOMEDRIVE?.trim();
	const envHomePath = process?.env?.HOMEPATH?.trim();
	if (envHomeDrive && envHomePath) {
		return `${envHomeDrive}${envHomePath}`;
	}
	const osHomeDir = homedir().trim();
	if (osHomeDir && osHomeDir !== "~") {
		return osHomeDir;
	}
	return "~";
}

let HOME_DIR = resolveDefaultHomeDir();
let HOME_DIR_SET_EXPLICITLY = false;

export function setHomeDir(dir: string) {
	const trimmed = dir.trim();
	if (!trimmed) {
		return;
	}
	HOME_DIR = trimmed;
	HOME_DIR_SET_EXPLICITLY = true;
}

export function setHomeDirIfUnset(dir: string) {
	if (HOME_DIR_SET_EXPLICITLY) {
		return;
	}
	const trimmed = dir.trim();
	if (!trimmed) {
		return;
	}
	HOME_DIR = trimmed;
}

let CLINE_DIR: string | undefined;
let CLINE_DIR_SET_EXPLICITLY = false;

export function setClineDir(dir: string): void {
	const trimmed = dir.trim();
	if (!trimmed) {
		return;
	}
	CLINE_DIR = trimmed;
	CLINE_DIR_SET_EXPLICITLY = true;
}

export function setClineDirIfUnset(dir: string): void {
	if (CLINE_DIR_SET_EXPLICITLY) {
		return;
	}
	const trimmed = dir.trim();
	if (!trimmed) {
		return;
	}
	CLINE_DIR = trimmed;
}

export function resolveClineDir(): string {
	if (CLINE_DIR) {
		return CLINE_DIR;
	}
	const envDir = process.env.CLINE_DIR?.trim();
	if (envDir) {
		return envDir;
	}
	return join(HOME_DIR, ".cline");
}

export function resolveDocumentsClineDirectoryPath(): string {
	return join(HOME_DIR, "Documents", "Cline");
}

type DocumentsExtensionName =
	| "Agents"
	| "Hooks"
	| "Rules"
	| "Workflows"
	| "Plugins";

export function resolveDocumentsExtensionPath(
	name: DocumentsExtensionName,
): string {
	return join(resolveDocumentsClineDirectoryPath(), name);
}

/**
 * Bare mode: ignore every user-level configuration source [S12].
 *
 * The goal is reproducibility. With it on, the agent's behaviour depends only on
 * the repository, because none of the per-user customisation that normally feeds
 * it is discovered: agents, skills, rules, workflows, plugins, hooks and MCP
 * servers.
 *
 * Workspace-level sources are kept, since those are the ones a checkout already
 * carries and therefore the ones a reproducible run should still honour.
 * User state that is not configuration -- sessions, provider settings, auth --
 * is deliberately untouched, so a bare run still persists and can be resumed;
 * discarding it would make "run it twice" impossible rather than reproducible.
 *
 * Implemented as a single filter here rather than as a variant of each resolver,
 * because these paths are consumed from several packages and a flag that had to
 * be threaded through every call site would inevitably be missed by one of them.
 *
 * Off by default; set from the environment so it applies before any config is
 * read, and exposed as a setter for hosts that decide programmatically.
 */
let BARE_MODE = process.env.CLINE_BARE === "1";

export function isBareMode(): boolean {
	return BARE_MODE;
}

export function setBareMode(enabled: boolean): void {
	BARE_MODE = enabled;
}

/**
 * Drops the user-level (home directory) entries from a config search path list.
 *
 * Applied at the end of every user-level resolver, so a source added later
 * cannot leak past this by being resolved somewhere else.
 *
 * `workspacePath` is exempt, and that exemption is load-bearing rather than
 * convenient: a checkout inside the home directory is an ordinary setup, and
 * treating `~/projects/app` as "user-level" would strip the repository's own
 * rules, skills and hooks -- silently, and exactly in the mode whose purpose is
 * to depend only on the repository.
 */
export function filterUserLevelPaths(
	paths: readonly string[],
	workspacePath?: string,
): string[] {
	if (!BARE_MODE) {
		return dedupePaths(paths);
	}
	const workspaceRoot = workspacePath ? safeResolve(workspacePath) : undefined;
	return dedupePaths(
		paths.filter((candidate) => {
			if (workspaceRoot && isUnder(candidate, workspaceRoot)) {
				return true;
			}
			return !isUnderHomeDir(candidate);
		}),
	);
}

/** Whether `candidate` is `root` itself or inside it. */
function isUnder(candidate: string, root: string): boolean {
	const resolved = safeResolve(candidate);
	// An unresolvable candidate cannot be shown to be inside root, so it is not
	// exempted here; the caller's fallback keeps it.
	return resolved !== undefined && (resolved === root || resolved.startsWith(`${root}${sep}`));
}

/**
 * Whether a path lives under the user's home directory.
 *
 * Compared on resolved absolute paths so `~/...`-style aliases and trailing
 * separators cannot slip a user-level source through the filter.
 */
function isUnderHomeDir(candidate: string): boolean {
	if (!candidate) {
		return false;
	}
	const resolved = safeResolve(candidate);
	if (!resolved) {
		// Unresolvable paths are kept: dropping a path we cannot classify would
		// silently remove configuration the caller expected.
		return false;
	}
	const home = safeResolve(HOME_DIR);
	if (!home) {
		return false;
	}
	return resolved === home || resolved.startsWith(`${home}${sep}`);
}

function safeResolve(candidate: string): string | undefined {
	try {
		return resolve(candidate);
	} catch {
		return undefined;
	}
}

export function resolveClineDataDir(): string {
	const explicitDir = process.env.CLINE_DATA_DIR?.trim();
	if (explicitDir) {
		return explicitDir;
	}
	return join(resolveClineDir(), "data");
}

export function resolveSessionDataDir(): string {
	const explicitDir = process.env.CLINE_SESSION_DATA_DIR?.trim();
	if (explicitDir) {
		return explicitDir;
	}
	return join(resolveClineDataDir(), "sessions");
}

export function resolveTeamDataDir(): string {
	const explicitDir = process.env.CLINE_TEAM_DATA_DIR?.trim();
	if (explicitDir) {
		return explicitDir;
	}
	return join(resolveClineDataDir(), "teams");
}

export function resolveConnectorDataDir(): string {
	const explicitDir = process.env.CLINE_CONNECTOR_DATA_DIR?.trim();
	if (explicitDir) {
		return explicitDir;
	}
	return join(resolveClineDataDir(), "connectors");
}

export function resolveConnectorSettingsPath(): string {
	const explicitPath = process.env.CLINE_CONNECTOR_SETTINGS_PATH?.trim();
	if (explicitPath) {
		return explicitPath;
	}
	return join(resolveConnectorDataDir(), CLINE_CONNECTOR_SETTINGS_FILE_NAME);
}

export function resolveDbDataDir(): string {
	const explicitDir = process.env.CLINE_DB_DATA_DIR?.trim();
	if (explicitDir) {
		return explicitDir;
	}
	return join(resolveClineDataDir(), "db");
}

/**
 * Path to the dedicated cron/automation database.
 * Lives alongside `sessions.db` but is a separate file so cron lifecycle,
 * retention, and query patterns stay decoupled from session storage.
 */
export function resolveCronDbPath(): string {
	const explicitPath = process.env.CLINE_CRON_DB_PATH?.trim();
	if (explicitPath) {
		return explicitPath;
	}
	return join(resolveDbDataDir(), "cron.db");
}

export type CronSpecsScope = "global" | "workspace";

export interface ResolveCronSpecsDirOptions {
	/**
	 * Explicit specs directory. Useful for tests and for future hosts that want
	 * to provide their own merged/global/workspace cron source root.
	 */
	cronSpecsDir?: string;
	/** Defaults to `global`, i.e. `~/.cline/cron`. */
	scope?: CronSpecsScope;
	/** Required when `scope` is `workspace`. */
	workspaceRoot?: string;
}

/**
 * Global file-based cron spec authoring directory:
 *   `~/.cline/cron/`
 */
export function resolveGlobalCronSpecsDir(): string {
	return join(resolveClineDir(), "cron");
}

/**
 * Workspace file-based cron spec authoring directory reserved for future
 * workspace-scoped automation support:
 *   `${workspaceRoot}/.cline/cron/`
 */
export function resolveWorkspaceCronSpecsDir(workspaceRoot: string): string {
	return join(workspaceRoot, ".cline", "cron");
}

/**
 * Directory containing file-based cron spec authoring.
 *
 * Default: global `~/.cline/cron/`.
 * One-off: `*.md`
 * Recurring: `*.cron.md`
 * Event-driven: `events/*.event.md`
 *
 * A string argument is retained as a deprecated compatibility shorthand for
 * workspace scope. New code should pass `{ scope: "workspace", workspaceRoot }`
 * or use `resolveWorkspaceCronSpecsDir(workspaceRoot)` directly.
 */
export function resolveCronSpecsDir(workspaceRoot: string): string;
export function resolveCronSpecsDir(
	options?: ResolveCronSpecsDirOptions,
): string;
export function resolveCronSpecsDir(
	input?: string | ResolveCronSpecsDirOptions,
): string {
	if (typeof input === "string") {
		return resolveWorkspaceCronSpecsDir(input);
	}
	if (input?.cronSpecsDir?.trim()) {
		return input.cronSpecsDir.trim();
	}
	if (input?.scope === "workspace") {
		const workspaceRoot = input.workspaceRoot?.trim();
		if (!workspaceRoot) {
			throw new Error("workspaceRoot is required for workspace cron scope");
		}
		return resolveWorkspaceCronSpecsDir(workspaceRoot);
	}
	return resolveGlobalCronSpecsDir();
}

/** Directory where per-run markdown reports are written. */
export function resolveCronReportsDir(workspaceRoot: string): string;
export function resolveCronReportsDir(
	options?: ResolveCronSpecsDirOptions,
): string;
export function resolveCronReportsDir(
	input?: string | ResolveCronSpecsDirOptions,
): string {
	return join(
		resolveCronSpecsDir(input as ResolveCronSpecsDirOptions),
		"reports",
	);
}

/** Directory where event-spec files live inside the cron specs dir. */
export function resolveCronEventsDir(workspaceRoot: string): string;
export function resolveCronEventsDir(
	options?: ResolveCronSpecsDirOptions,
): string;
export function resolveCronEventsDir(
	input?: string | ResolveCronSpecsDirOptions,
): string {
	return join(
		resolveCronSpecsDir(input as ResolveCronSpecsDirOptions),
		"events",
	);
}

export function resolveProviderSettingsPath(): string {
	const explicitPath = process.env.CLINE_PROVIDER_SETTINGS_PATH?.trim();
	if (explicitPath) {
		return explicitPath;
	}
	return join(resolveClineDataDir(), "settings", "providers.json");
}

export function resolveGlobalSettingsPath(): string {
	const explicitPath = process.env.CLINE_GLOBAL_SETTINGS_PATH?.trim();
	if (explicitPath) {
		return explicitPath;
	}
	return join(resolveClineDataDir(), "settings", "global-settings.json");
}

export function resolveMcpSettingsPath(): string {
	const explicitPath = process.env.CLINE_MCP_SETTINGS_PATH?.trim();
	if (explicitPath) {
		return explicitPath;
	}
	return join(resolveClineDataDir(), "settings", CLINE_MCP_SETTINGS_FILE_NAME);
}

function dedupePaths(paths: ReadonlyArray<string>): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const candidate of paths) {
		if (!candidate || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		deduped.push(candidate);
	}
	return deduped;
}

function getWorkspaceSkillDirectories(workspacePath?: string): string[] {
	if (!workspacePath) {
		return [];
	}
	return [
		DEPRECATED_CONFIG_DIR,
		CLINE_CONFIG_DIR,
		LEGACY_AGENT_SKILLS_CONFIG_DIR,
	].map((dir) => join(workspacePath, dir, SKILLS_CONFIG_DIRECTORY_NAME));
}

export function resolveAgentsConfigDirPath(): string {
	return join(resolveClineDir(), AGENT_CONFIG_DIRECTORY_NAME);
}

export function resolveAgentConfigSearchPaths(
	workspacePath?: string,
): string[] {
	return filterUserLevelPaths([
		workspacePath
			? join(workspacePath, CLINE_CONFIG_DIR, AGENT_CONFIG_DIRECTORY_NAME)
			: "",
		resolveAgentsConfigDirPath(),
	], workspacePath);
}

export function resolveHooksConfigSearchPaths(
	workspacePath?: string,
): string[] {
	const hooks = [
		resolveDocumentsExtensionPath("Hooks"),
		join(resolveClineDir(), HOOKS_CONFIG_DIRECTORY_NAME),
	];
	if (workspacePath) {
		hooks.push(
			join(workspacePath, DEPRECATED_CONFIG_DIR, HOOKS_CONFIG_DIRECTORY_NAME),
			join(workspacePath, CLINE_CONFIG_DIR, HOOKS_CONFIG_DIRECTORY_NAME),
		);
	}
	return filterUserLevelPaths(hooks, workspacePath);
}

export function resolveSkillsConfigSearchPaths(
	workspacePath?: string,
): string[] {
	return filterUserLevelPaths([
		...getWorkspaceSkillDirectories(workspacePath),
		join(resolveClineDir(), SKILLS_CONFIG_DIRECTORY_NAME),
		join(
			HOME_DIR,
			LEGACY_AGENT_SKILLS_CONFIG_DIR,
			SKILLS_CONFIG_DIRECTORY_NAME,
		),
	], workspacePath);
}

export function resolveGlobalAgentsRulesPath(): string {
	return join(HOME_DIR, LEGACY_AGENT_SKILLS_CONFIG_DIR, AGENTS_RULES_FILE_NAME);
}

export function resolveRulesConfigSearchPaths(
	workspacePath?: string,
): string[] {
	const wsPaths = workspacePath
		? [
				join(workspacePath, DEPRECATED_CONFIG_DIR),
				join(workspacePath, CLINE_CONFIG_DIR, RULES_CONFIG_DIRECTORY_NAME),
			]
		: [];
	const workspaceAgentsFile = workspacePath
		? [join(workspacePath, AGENTS_RULES_FILE_NAME)]
		: [];
	return filterUserLevelPaths([
		...workspaceAgentsFile,
		...wsPaths,
		resolveGlobalAgentsRulesPath(),
		join(resolveClineDir(), RULES_CONFIG_DIRECTORY_NAME),
		resolveDocumentsExtensionPath("Rules"),
	], workspacePath);
}

export function resolveWorkflowsConfigSearchPaths(
	workspacePath?: string,
): string[] {
	return filterUserLevelPaths([
		workspacePath
			? join(workspacePath, ".clinerules", WORKFLOWS_CONFIG_DIRECTORY_NAME)
			: "",
		resolveDocumentsExtensionPath("Workflows"),
		join(resolveClineDir(), WORKFLOWS_CONFIG_DIRECTORY_NAME),
		workspacePath
			? join(workspacePath, ".cline", WORKFLOWS_CONFIG_DIRECTORY_NAME)
			: "",
	], workspacePath);
}

export function resolvePluginConfigSearchPaths(
	workspacePath?: string,
): string[] {
	return filterUserLevelPaths([
		workspacePath ? join(workspacePath, ".cline", PLUGINS_DIRECTORY_NAME) : "",
		join(resolveClineDir(), PLUGINS_DIRECTORY_NAME),
		resolveDocumentsExtensionPath("Plugins"),
	], workspacePath);
}

const PLUGIN_MODULE_EXTENSIONS = new Set([".js", ".ts"]);
const PLUGIN_PACKAGE_JSON_FILE_NAME = "package.json";
const PLUGIN_DIRECTORY_INDEX_CANDIDATES = ["index.ts", "index.js"];

interface PluginPackageManifest {
	plugins?: PluginManifest[];
}

export function isPluginModulePath(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot === -1) {
		return false;
	}
	return PLUGIN_MODULE_EXTENSIONS.has(path.slice(dot));
}

function readPluginPackageManifest(
	packageJsonPath: string,
): PluginPackageManifest | null {
	try {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			cline?: PluginPackageManifest;
		};
		if (!packageJson.cline || typeof packageJson.cline !== "object") {
			return null;
		}
		return packageJson.cline;
	} catch {
		return null;
	}
}

function getManifestPluginEntries(
	manifest: PluginPackageManifest | null,
): string[] {
	const entries = manifest?.plugins;
	if (!Array.isArray(entries)) {
		return [];
	}
	return entries.flatMap((entry) => entry.paths ?? []);
}

export function resolvePluginModuleEntries(
	directoryPath: string,
): string[] | null {
	const root = resolve(directoryPath);
	if (!existsSync(root) || !statSync(root).isDirectory()) {
		return null;
	}

	const packageJsonPath = join(root, PLUGIN_PACKAGE_JSON_FILE_NAME);
	if (existsSync(packageJsonPath)) {
		const manifest = readPluginPackageManifest(packageJsonPath);
		const entries = getManifestPluginEntries(manifest)
			.map((entry) => resolve(root, entry))
			.filter(
				(entryPath) =>
					existsSync(entryPath) &&
					statSync(entryPath).isFile() &&
					isPluginModulePath(entryPath),
			);
		if (entries.length > 0) {
			return entries;
		}
	}

	for (const candidate of PLUGIN_DIRECTORY_INDEX_CANDIDATES) {
		const entryPath = join(root, candidate);
		if (existsSync(entryPath) && statSync(entryPath).isFile()) {
			return [entryPath];
		}
	}

	return null;
}

export function discoverPluginModulePaths(directoryPath: string): string[] {
	const root = resolve(directoryPath);
	if (!existsSync(root)) {
		return [];
	}
	const discovered: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const candidate = join(current, entry.name);
			if (entry.isDirectory()) {
				const packageJsonPath = join(candidate, PLUGIN_PACKAGE_JSON_FILE_NAME);
				if (existsSync(packageJsonPath)) {
					const manifest = readPluginPackageManifest(packageJsonPath);
					const entries = getManifestPluginEntries(manifest)
						.map((e) => resolve(candidate, e))
						.filter(
							(entryPath) =>
								existsSync(entryPath) &&
								statSync(entryPath).isFile() &&
								isPluginModulePath(entryPath),
						);
					if (entries.length > 0) {
						discovered.push(...entries);
						continue;
					}
				}
				stack.push(candidate);
				continue;
			}
			if (entry.name.startsWith(".")) {
				continue;
			}
			if (entry.isFile() && isPluginModulePath(candidate)) {
				discovered.push(candidate);
			}
		}
	}
	return discovered.sort((a, b) => a.localeCompare(b));
}

export function resolveConfiguredPluginModulePaths(
	pluginPaths: ReadonlyArray<string>,
	cwd: string,
): string[] {
	const resolvedPaths: string[] = [];
	for (const pluginPath of pluginPaths) {
		const trimmed = pluginPath.trim();
		if (!trimmed) {
			continue;
		}
		const absolutePath = resolve(cwd, trimmed);
		if (!existsSync(absolutePath)) {
			throw new Error(`Plugin path does not exist: ${absolutePath}`);
		}
		const stats = statSync(absolutePath);
		if (stats.isDirectory()) {
			const entries = resolvePluginModuleEntries(absolutePath);
			if (entries) {
				resolvedPaths.push(...entries);
				continue;
			}
			resolvedPaths.push(...discoverPluginModulePaths(absolutePath));
			continue;
		}
		if (!isPluginModulePath(absolutePath)) {
			throw new Error(
				`Plugin file must use a supported extension (${[...PLUGIN_MODULE_EXTENSIONS].join(", ")}): ${absolutePath}`,
			);
		}
		resolvedPaths.push(absolutePath);
	}
	return resolvedPaths;
}

export function ensureParentDir(filePath: string): void {
	const parent = dirname(filePath);
	if (!existsSync(parent)) {
		mkdirSync(parent, { recursive: true });
	}
}

export function ensureFileExists(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	appendFileSync(filePath, "");
}

export function ensureHookLogDir(filePath?: string): string {
	if (filePath?.trim()) {
		ensureParentDir(filePath);
		return dirname(filePath);
	}
	const dir = join(resolveClineDataDir(), "logs");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}
