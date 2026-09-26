import { createHash } from "node:crypto";
import { join } from "node:path";
import { normalizeWorkspacePath } from "../../services/workspace/workspace-manifest";
import {
	type HubOwnerContext,
	resolveClineDataDir,
	resolveHubOwnerContext,
} from ".";

const DEFAULT_SHARED_HUB_OWNER_LABEL = "shared:cline";
const HUB_DISCOVERY_ENV = "CLINE_HUB_DISCOVERY_PATH";
const PRODUCTION_HUB_OWNER_ID = "hub-production";

export function resolveWorkspaceHubOwnerContext(
	workspaceRoot: string,
): HubOwnerContext {
	const normalized = normalizeWorkspacePath(workspaceRoot.trim());
	return resolveHubOwnerContext(
		`workspace:${normalized || workspaceRoot.trim()}`,
	);
}

export function resolveSharedHubOwnerContext(
	label = DEFAULT_SHARED_HUB_OWNER_LABEL,
): HubOwnerContext {
	return resolveHubOwnerContext(label);
}

export function resolveProductionHubOwnerContext(): HubOwnerContext {
	return {
		ownerId: PRODUCTION_HUB_OWNER_ID,
		discoveryPath:
			process.env[HUB_DISCOVERY_ENV]?.trim() ||
			join(resolveClineDataDir(), "locks", "hub", "production.json"),
	};
}

export function resolveA2AClientId(
	owner: HubOwnerContext,
	workspaceRoot: string,
): string {
	const normalizedWorkspace = normalizeWorkspacePath(workspaceRoot.trim());
	const basis = [
		"cline.a2a.principal.v1",
		owner.ownerId,
		owner.discoveryPath,
		resolveClineDataDir(),
		normalizedWorkspace || workspaceRoot.trim(),
	].join("\0");
	return `a2a_${createHash("sha256").update(basis).digest("hex").slice(0, 32)}`;
}
