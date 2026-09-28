/**
 * MCP protocol revisions this client can actually speak, newest first.
 *
 * These live in their own module because the client and its tests both need them,
 * and because the negotiation policy is a decision worth being able to read and
 * assert on without going through a spawned process.
 *
 * The advertised revision is the first entry. A server is free to answer with an
 * older one and that answer is authoritative, so the list is a floor as well as a
 * ceiling: `tools/list` and `tools/call` - the only two calls made - kept their
 * shapes across every revision listed here.
 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = [
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
] as const;

/** The revision this client asks for. */
export function advertisedMcpProtocolVersion(): string {
	return SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
}

/** Whether a server's answer is one this client can proceed with. */
export function isSupportedMcpProtocolVersion(version: string | undefined): boolean {
	return version === undefined || SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(version);
}
