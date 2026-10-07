import { describe, expect, it } from "vitest";
import type { AgentTool, AgentToolDefinition } from "@cline/shared";
import {
	DEFAULT_DEFERRED_TOOL_PATTERNS,
	createToolSearchLoader,
	selectDeferredToolNames,
	TOOL_SEARCH_TOOL_NAME,
} from "./tool-search-loader";

function stubTool(
	name: string,
	description = `${name} description`,
	extra: Partial<AgentToolDefinition> = {},
): AgentTool<any, any> {
	return {
		name,
		description,
		inputSchema: { type: "object", properties: {} },
		execute: async () => ({ ok: name }),
		...extra,
	} as AgentTool<any, any>;
}

const definitions = (tools: AgentToolDefinition[]) => tools.map((t) => t.name);

describe("selectDeferredToolNames", () => {
	it("defers team tools by default", () => {
		const names = selectDeferredToolNames(
			[stubTool("read_files"), stubTool("team_spawn_teammate"), stubTool("team_run_task")],
			{},
		);
		expect(names).toEqual(["team_spawn_teammate", "team_run_task"]);
		expect(DEFAULT_DEFERRED_TOOL_PATTERNS).toEqual(["team_*"]);
	});

	it("returns nothing when disabled or absent", () => {
		const tools = [stubTool("team_run_task")];
		expect(selectDeferredToolNames(tools, { enabled: false })).toEqual([]);
		expect(selectDeferredToolNames(tools, undefined)).toEqual([]);
	});

	it("never defers the only way to complete the run", () => {
		// Hiding `submit_and_exit` would strand the model with no way to finish.
		const names = selectDeferredToolNames(
			[
				stubTool("team_run_task"),
				stubTool("submit_and_exit", "finish", { lifecycle: { completesRun: true } }),
			],
			{},
		);
		expect(names).toEqual(["team_run_task"]);
	});

	it("supports explicit names and wildcards", () => {
		const tools = [stubTool("team_run_task"), stubTool("mcp_thing"), stubTool("read_files")];
		expect(selectDeferredToolNames(tools, { defer: ["mcp_*"] })).toEqual(["mcp_thing"]);
		expect(selectDeferredToolNames(tools, { defer: ["read_files"] })).toEqual([
			"read_files",
		]);
	});
});

describe("createToolSearchLoader", () => {
	const teamTools = [
		stubTool("team_spawn_teammate", "Spawn a teammate with a rolePrompt"),
		stubTool("team_run_task", "Assign a task to a teammate and run it"),
		stubTool("team_send_message", "Send a message to a teammate"),
	];
	const eager = stubTool("read_files", "Read files from disk");

	function setup(deferredTools = teamTools, loaded = new Set<string>()) {
		const loader = createToolSearchLoader({ deferredTools, loaded });
		return {
			loaded,
			loader,
			visible: () =>
				loader.beforeModel({
					request: { tools: [eager, ...deferredTools] as AgentToolDefinition[] },
				}).tools,
		};
	}

	it("hides deferred tools but keeps everything else", () => {
		const { visible } = setup();
		expect(definitions(visible())).toEqual(["read_files"]);
	});

	it("reveals matches and they stay visible afterwards", async () => {
		const { loader, visible, loaded } = setup();
		const result = await loader.tool.execute({ query: "spawn a teammate" }, {} as never);

		// A description-only match ("...to a teammate") is legitimate to reveal,
		// but the name match must rank first.
		expect(result.revealed[0]).toBe("team_spawn_teammate");
		expect(loaded.has("team_spawn_teammate")).toBe(true);
		expect(definitions(visible())).toContain("team_spawn_teammate");
	});

	it("keeps a tool that shares no term with the query hidden", async () => {
		const unrelated = stubTool(
			"team_compact_history",
			"Compact the conversation transcript",
		);
		const { loader, visible } = setup([...teamTools, unrelated]);
		await loader.tool.execute({ query: "spawn a teammate" }, {} as never);
		expect(definitions(visible())).not.toContain("team_compact_history");
	});

	it("ranks a name match above a description-only match", async () => {
		const { loader } = setup();
		// "run task" appears in team_run_task's name and in another tool's
		// description; the name match must win so the obvious tool surfaces first.
		const result = await loader.tool.execute({ query: "run task" }, {} as never);
		expect(result.revealed[0]).toBe("team_run_task");
	});

	it("reports no match rather than revealing everything", async () => {
		const { loader, loaded } = setup();
		const result = await loader.tool.execute({ query: "zzzz-nothing" }, {} as never);
		expect(result.revealed).toEqual([]);
		expect(loaded.size).toBe(0);
	});

	it("honours maxResults", async () => {
		const loader = createToolSearchLoader({
			deferredTools: teamTools,
			loaded: new Set<string>(),
			maxResults: 1,
		});
		const result = await loader.tool.execute({ query: "team" }, {} as never);
		expect(result.revealed).toHaveLength(1);
	});

	it("keeps revealed tools across runs via the shared loaded set", async () => {
		const loaded = new Set<string>();
		// First run reveals one tool; a later run reuses the same set, which is
		// what stops the model re-searching every turn of a session.
		const first = setup(teamTools, loaded);
		await first.loader.tool.execute({ query: "spawn teammate" }, {} as never);

		const second = setup(teamTools, loaded);
		expect(definitions(second.visible())).toContain("team_spawn_teammate");
	});

	it("advertises unloaded tools in its own description so they are discoverable", () => {
		const { loader } = setup();
		expect(loader.tool.description).toContain("team_run_task");
		expect(loader.tool.description).toContain("team_spawn_teammate");
		// The point of the feature is withholding schemas, so the description must
		// carry names and summaries only.
		expect(loader.tool.description).not.toContain("inputSchema");
		expect(loader.tool.description).not.toContain("properties");
	});

	it("does not mutate the caller's tool array", () => {
		const { loader } = setup();
		const before = teamTools.map((t) => t.name);
		loader.beforeModel({
			request: { tools: [eager, ...teamTools] as AgentToolDefinition[] },
		});
		expect(teamTools.map((t) => t.name)).toEqual(before);
	});
});