import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createGlobExecutor, globToRegExp, resolveGlobScope } from "./glob";
import { MAX_GLOB_OUTPUT_CHARS } from "./output-limits";

const ctx: AgentToolContext = {
	agentId: "agent-1",
	conversationId: "conv-1",
	iteration: 1,
};

/**
 * Build a throwaway workspace. The glob executor reads the shared file index, so
 * these tests exercise the real ignore-aware index rather than a stub: that is
 * the behaviour glob promises (same visibility rules as search_codebase) and a
 * mock would only restate the implementation.
 */
async function makeWorkspace(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agents-glob-"));
	for (const [relative, contents] of Object.entries(files)) {
		const target = path.join(root, relative);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, contents, "utf-8");
	}
	return root;
}

async function withWorkspace(
	files: Record<string, string>,
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await makeWorkspace(files);
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("globToRegExp", () => {
	it("keeps * and ? inside one path segment", () => {
		const matcher = globToRegExp("src/*.ts");
		expect(matcher.test("src/a.ts")).toBe(true);
		expect(matcher.test("src/nested/a.ts")).toBe(false);
		expect(matcher.test("src/ab.ts")).toBe(true);
		expect(matcher.test("src/a.tsx")).toBe(false);
		expect(matcher.test("src/a.js")).toBe(false);

		const single = globToRegExp("a?c.ts");
		expect(single.test("abc.ts")).toBe(true);
		expect(single.test("ac.ts")).toBe(false);
	});

	it("lets ** cross directories and match zero segments", () => {
		const matcher = globToRegExp("**/*.ts");
		// `**/` must match zero directories, otherwise `**/*.ts` would not find
		// root-level files and the tool would silently under-report.
		expect(matcher.test("a.ts")).toBe(true);
		expect(matcher.test("src/a.ts")).toBe(true);
		expect(matcher.test("src/deep/nested/a.ts")).toBe(true);
		expect(matcher.test("src/deep/nested/a.js")).toBe(false);
	});

	it("treats a trailing ** as matching everything below", () => {
		const matcher = globToRegExp("src/**");
		expect(matcher.test("src/a.ts")).toBe(true);
		expect(matcher.test("src/deep/a.ts")).toBe(true);
		expect(matcher.test("lib/a.ts")).toBe(false);
	});

	it("supports character classes and negation", () => {
		expect(globToRegExp("test[0-9].ts").test("test3.ts")).toBe(true);
		expect(globToRegExp("test[0-9].ts").test("testa.ts")).toBe(false);
		expect(globToRegExp("test[!0-9].ts").test("testa.ts")).toBe(true);
		expect(globToRegExp("test[!0-9].ts").test("test3.ts")).toBe(false);
	});

	it("treats an unterminated character class as a literal", () => {
		// Swallowing the remainder into a broken class would make the whole
		// pattern match nothing with no explanation.
		const matcher = globToRegExp("a[bc.ts");
		expect(matcher.test("a[bc.ts")).toBe(true);
	});

	it("normalizes backslashes and a leading ./", () => {
		expect(globToRegExp(".\\src\\*.ts").test("src/a.ts")).toBe(true);
	});
});

describe("resolveGlobScope", () => {
	it("passes through an absent or empty scope", () => {
		const cwd = path.resolve(path.sep, "workspace", "repo");
		expect(resolveGlobScope(cwd, undefined)).toEqual({ root: cwd });
		expect(resolveGlobScope(cwd, ".")).toEqual({ root: cwd });
		expect(resolveGlobScope(cwd, "  ")).toEqual({ root: cwd });
	});

	it("resolves a subdirectory inside the workspace", () => {
		const cwd = path.resolve(path.sep, "workspace", "repo");
		expect(resolveGlobScope(cwd, "src/tools")).toEqual({
			root: path.join(cwd, "src", "tools"),
		});
	});

	it("refuses to leave the workspace root", () => {
		// Returning nothing here would read as "no matches" and send the model
		// hunting for the wrong reason; the refusal has to be explicit.
		const cwd = path.resolve(path.sep, "workspace", "repo");
		const result = resolveGlobScope(cwd, "..");

		expect("error" in result).toBe(true);
		expect("error" in result && result.error).toContain("outside the workspace root");
	});
});

describe("createGlobExecutor", () => {
	it("matches a bare filename at any depth", async () => {
		await withWorkspace(
			{
				"a.spec.ts": "",
				"src/b.spec.ts": "",
				"src/deep/c.spec.ts": "",
				"src/d.ts": "",
			},
			async (root) => {
				const glob = createGlobExecutor();
				const result = await glob("*.spec.ts", root, ctx);

				expect(result).toContain("a.spec.ts");
				expect(result).toContain("src/b.spec.ts");
				expect(result).toContain("src/deep/c.spec.ts");
				expect(result).not.toContain("src/d.ts");
			},
		);
	});

	it("anchors a pattern containing a separator to the workspace-relative path", async () => {
		await withWorkspace(
			{
				"src/index.ts": "",
				"src/deep/index.ts": "",
				"lib/index.ts": "",
			},
			async (root) => {
				const glob = createGlobExecutor();
				const result = await glob("src/**/index.ts", root, ctx);

				expect(result).toContain("src/index.ts");
				expect(result).toContain("src/deep/index.ts");
				expect(result).not.toContain("lib/index.ts");
			},
		);
	});

	it("scopes to a subdirectory and still reports workspace-relative paths", async () => {
		await withWorkspace(
			{
				"pkg/a/index.ts": "",
				"pkg/b/index.ts": "",
				"other/index.ts": "",
			},
			async (root) => {
				const glob = createGlobExecutor();
				const result = await glob("**/index.ts", root, { ...ctx, globPath: "pkg/b" });

				expect(result).toContain("pkg/b/index.ts");
				expect(result).not.toContain("pkg/a/index.ts");
			},
		);
	});

	it("refuses a path outside the workspace", async () => {
		await withWorkspace({ "a.ts": "" }, async (root) => {
			const glob = createGlobExecutor();
			await expect(
				glob("*.ts", root, { ...ctx, globPath: path.join("..", "..") }),
			).rejects.toThrow(/outside the workspace root/);
		});
	});

	it("reports when nothing matched", async () => {
		await withWorkspace({ "a.ts": "" }, async (root) => {
			const glob = createGlobExecutor();
			const result = await glob("*.rs", root, ctx);

			expect(result).toContain("No files matched pattern: *.rs");
		});
	});

	it("caps the result count and tells the model how to narrow", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 12; i++) {
			files[`file-${i}.ts`] = "";
		}
		await withWorkspace(files, async (root) => {
			const glob = createGlobExecutor({ maxResults: 5 });
			const result = await glob("*.ts", root, ctx);

			expect(result).toContain("Showing first 5 matches");
			expect(result).toContain("Narrow the pattern");
			// 5 shown + the header/hint lines, not all 12.
			expect(result.split("\n").length).toBeLessThan(12);
		});
	});

	it(
		"middle-truncates oversized output with recovery guidance",
		async () => {
			// Long directory names rather than thousands of files: the goal is to
			// exceed the character cap cheaply, not to stress the indexer.
			const files: Record<string, string> = {};
			for (let i = 0; i < 700; i++) {
				files[`packages/some-deeper-directory-name-${i % 20}/nested/another-long-directory-name/file-with-a-longish-name-${i}.ts`] = "";
			}
			await withWorkspace(files, async (root) => {
				const glob = createGlobExecutor({ maxResults: 100_000 });
				const result = await glob("**/*.ts", root, ctx);

				expect(result).toContain("glob output truncated");
				expect(result).toContain("Narrow the pattern or add a path");
				expect(result.length).toBeLessThanOrEqual(MAX_GLOB_OUTPUT_CHARS + 200);
			});
		},
		60_000,
	);

	it("excludes VCS metadata, which both indexer paths agree on", async () => {
		await withWorkspace(
			{
				".git/objects/cfg": "",
				"kept/visible.ts": "",
			},
			async (root) => {
				const glob = createGlobExecutor();
				const result = await glob("**/*", root, ctx);

				expect(result).toContain("kept/visible.ts");
				expect(result).not.toContain("cfg");
			},
		);
	});

	it("does not start work when the run is already aborted", async () => {
		await withWorkspace({ "a.ts": "" }, async (root) => {
			const controller = new AbortController();
			controller.abort();
			const glob = createGlobExecutor();

			await expect(glob("*.ts", root, { ...ctx, signal: controller.signal })).rejects.toThrow(
				/aborted/,
			);
		});
	});

	it("returns sorted paths so repeated calls are stable", async () => {
		await withWorkspace(
			{ "b.ts": "", "a.ts": "", "c/a.ts": "" },
			async (root) => {
				const glob = createGlobExecutor();
				const result = await glob("*.ts", root, ctx);
				const paths = result
					.split("\n")
					.slice(2)
					.map((line) => line.trim())
					.filter(Boolean);

				expect(paths).toEqual([...paths].sort());
			},
		);
	});
});