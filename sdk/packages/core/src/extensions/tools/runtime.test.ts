import { describe, expect, it } from "vitest";
import { ALL_DEFAULT_TOOL_NAMES } from "./constants";
import {
	getCoreBuiltinToolCatalog,
	getCoreDefaultEnabledToolIds,
	getCoreHeadlessToolNames,
	resolveCoreSelectedToolIds,
} from "./runtime";

describe("builtin tool catalog", () => {
	it("includes spawn and teams entries", () => {
		const catalog = getCoreBuiltinToolCatalog({ mode: "act" });
		expect(catalog.some((entry) => entry.id === "spawn_agent")).toBe(true);
		expect(catalog.some((entry) => entry.id === "teams")).toBe(true);
	});

	it("marks teams enabled by default in act mode", () => {
		const catalog = getCoreBuiltinToolCatalog({ mode: "act" });
		expect(catalog.find((entry) => entry.id === "teams")?.defaultEnabled).toBe(
			true,
		);
		expect(
			catalog.find((entry) => entry.id === "spawn_agent")?.defaultEnabled,
		).toBe(true);
	});

	it("marks teams and spawn disabled by default in yolo mode", () => {
		const catalog = getCoreBuiltinToolCatalog({ mode: "yolo" });
		expect(catalog.find((entry) => entry.id === "teams")?.defaultEnabled).toBe(
			false,
		);
		expect(
			catalog.find((entry) => entry.id === "spawn_agent")?.defaultEnabled,
		).toBe(false);
	});

	it("expands grouped headless tool names for selected entries", () => {
		const names = getCoreHeadlessToolNames(new Set(["teams", "read_files"]), {
			mode: "act",
		});
		expect(names).toContain("read_files");
		expect(names).toContain("team_status");
		expect(names).toContain("team_run_task");
	});

	it("uses a single editor catalog entry and maps to apply_patch when routed", () => {
		const actCatalog = getCoreBuiltinToolCatalog({ mode: "act" });
		expect(actCatalog.some((entry) => entry.id === "apply_patch")).toBe(false);
		expect(
			actCatalog.find((entry) => entry.id === "editor")?.headlessToolNames,
		).toEqual(["editor"]);

		const gptCatalog = getCoreBuiltinToolCatalog({
			mode: "act",
			modelId: "openai/gpt-5.4",
			providerId: "openai",
		});
		expect(
			gptCatalog.find((entry) => entry.id === "editor")?.headlessToolNames,
		).toEqual(["apply_patch"]);
		expect(gptCatalog.some((entry) => entry.id === "submit_and_exit")).toBe(
			false,
		);
	});

	it("resolves default selected ids from the catalog", () => {
		const selected = resolveCoreSelectedToolIds({
			enabled: true,
			availabilityContext: { mode: "act" },
		});
		expect(selected.has("teams")).toBe(true);
		expect(selected.has("spawn_agent")).toBe(true);
		expect(getCoreDefaultEnabledToolIds({ mode: "act" })).toContain("teams");
	});

	/**
	 * Every default tool must be reachable through this catalog. A tool missing
	 * here does not fail loudly: it becomes absent from `cline config tools` and
	 * the `/config` toggles (so it cannot be switched off), `allowlist: ["glob"]`
	 * throws `Unknown tool`, and ACP/headless sessions silently lose it, because
	 * their tool names are derived from this list. Adding a tool to
	 * ALL_DEFAULT_TOOL_NAMES is therefore not sufficient on its own.
	 *
	 * Two categories are legitimately absent, and they must stay explicit so a
	 * future tool cannot join them by accident:
	 * - routing aliases: `apply_patch` is served by the single `editor` entry,
	 *   whose `headlessToolNames` switches with the model routing rules;
	 * - opt-in tools: `submit_and_exit` is off in every preset and has no catalog
	 *   entry, so `cline config tools` cannot turn it on.
	 */
	const CATALOG_ROUTING_ALIASES: Record<string, string> = { apply_patch: "editor" };
	const CATALOG_OPT_IN_EXCLUSIONS = new Set(["submit_and_exit"]);

	it("registers every default tool name so none is unreachable", () => {
		const registered = new Set(
			getCoreBuiltinToolCatalog({ mode: "act" }).flatMap((entry) => [
				entry.id,
				...entry.headlessToolNames,
			]),
		);

		for (const toolName of ALL_DEFAULT_TOOL_NAMES) {
			if (CATALOG_OPT_IN_EXCLUSIONS.has(toolName)) {
				expect(
					registered.has(toolName),
					`${toolName} is on the opt-in exclusion list but is now in the catalog`,
				).toBe(false);
				continue;
			}
			const alias = CATALOG_ROUTING_ALIASES[toolName];
			expect(
				registered.has(toolName) || (alias !== undefined && registered.has(alias)),
				`${toolName} is missing from the builtin tool catalog and is neither a routing ` +
					`alias (${Object.keys(CATALOG_ROUTING_ALIASES).join(", ")}) nor an explicit ` +
					"opt-in exclusion",
			).toBe(true);
		}
	});

	it("enables glob by default and keeps it toggleable", () => {
		const catalog = getCoreBuiltinToolCatalog({ mode: "act" });
		const globEntry = catalog.find((entry) => entry.id === "glob");

		expect(globEntry).toBeDefined();
		expect(globEntry?.defaultEnabled).toBe(true);
		expect(globEntry?.headlessToolNames).toEqual(["glob"]);

		// Disabled-by-user filtering resolves through the same flag lookup that
		// missed before glob was mapped, so an unmapped entry would report
		// defaultEnabled=false everywhere instead of being switchable.
		const disabled = getCoreBuiltinToolCatalog({
			mode: "act",
			disabledToolIds: new Set(["glob"]),
		});
		expect(disabled.find((entry) => entry.id === "glob")?.defaultEnabled).toBe(
			false,
		);
		expect(
			getCoreDefaultEnabledToolIds({
				mode: "act",
				disabledToolIds: new Set(["glob"]),
			}),
		).not.toContain("glob");
	});

	it("accepts glob in an explicit allowlist", () => {
		const selected = resolveCoreSelectedToolIds({
			enabled: true,
			allowlist: ["glob"],
			availabilityContext: { mode: "act" },
		});
		expect([...selected]).toEqual(["glob"]);
	});

	it("exposes glob to headless sessions", () => {
		expect(
			getCoreHeadlessToolNames(new Set(["glob"]), { mode: "act" }),
		).toContain("glob");
	});

	it("keeps glob disabled in yolo mode where discovery tools are off", () => {
		const catalog = getCoreBuiltinToolCatalog({ mode: "yolo" });
		expect(catalog.find((entry) => entry.id === "glob")?.defaultEnabled).toBe(
			false,
		);
	});
});
