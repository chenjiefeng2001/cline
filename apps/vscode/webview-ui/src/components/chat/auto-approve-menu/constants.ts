import { ActionMetadata } from "./types"

export const ACTION_METADATA: ActionMetadata[] = [
	{
		id: "readFiles",
		label: "Read files",
		shortName: "Read",
		icon: "codicon-search",
	},
	{
		id: "editFiles",
		label: "Edit files",
		shortName: "Edit",
		icon: "codicon-edit",
	},
	{
		id: "executeSafeCommands",
		label: "Run safe commands",
		shortName: "Commands",
		icon: "codicon-terminal",
		description:
			"Skips approval for read-only commands only. Anything that writes, deletes, chains, pipes or runs another program still asks.",
	},
	{
		id: "useBrowser",
		label: "Fetch web content",
		shortName: "Web Fetch",
		icon: "codicon-globe",
	},
	{
		id: "useMcp",
		label: "Use MCP servers",
		shortName: "MCP",
		icon: "codicon-server",
	},
]
