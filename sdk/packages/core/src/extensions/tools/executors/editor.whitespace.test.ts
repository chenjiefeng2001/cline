import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createEditorExecutor } from "./editor";

const context = {
	agentId: "agent-1",
	conversationId: "conv-1",
	iteration: 1,
};

async function withFile(
	content: string,
	run: (filePath: string, dir: string) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "editor-ws-"));
	const filePath = path.join(dir, "example.ts");
	await fs.writeFile(filePath, content, "utf-8");
	try {
		await run(filePath, dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("editor trailing-whitespace tolerant matching", () => {
	it("matches when the file has trailing spaces the model did not send", async () => {
		// A formatter strips or adds trailing whitespace between the model's read and
		// its edit, so the exact old_text no longer occurs. Reported as cline/cline#4384
		// ("Auto-formatting in VSCode breaks diff matching by changing whitespace").
		await withFile(
			["const a = 1;   ", "const b = 2;"].join("\n"),
			async (filePath, dir) => {
				const editor = createEditorExecutor();
				const result = await editor(
					{
						path: filePath,
						old_text: "const a = 1;\nconst b = 2;",
						new_text: "const a = 10;\nconst b = 20;",
					},
					dir,
					context as never,
				);
				expect(result).toMatch(/^Edited /);
				await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
					"const a = 10;\nconst b = 20;",
				);
			},
		);
	});

	it("still refuses when the whitespace-tolerant match is ambiguous", async () => {
		// Two regions match once trailing whitespace is ignored, and neither matches
		// exactly. Picking either would edit code the model never asked about, so the
		// fallback has to refuse rather than guess.
		const original = [
			"const a = 1;   ",
			"const b = 2;  ",
			"",
			"const a = 1; ",
			"const b = 2;",
		].join("\n");
		await withFile(original, async (filePath, dir) => {
			const editor = createEditorExecutor();
			await expect(
				editor(
					{
						path: filePath,
						old_text: "const a = 1;\nconst b = 2;",
						new_text: "x",
					},
					dir,
					context as never,
				),
			).rejects.toThrow(/ambiguous/i);
			// Refusing must leave the file alone.
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(original);
		});
	});

	it("keeps reporting a genuine miss as not found", async () => {
		await withFile("const a = 1;\n", async (filePath, dir) => {
			const editor = createEditorExecutor();
			await expect(
				editor(
					{ path: filePath, old_text: "totally absent", new_text: "x" },
					dir,
					context as never,
				),
			).rejects.toThrow(/text not found/i);
		});
	});

	it("leaves an exact unique match untouched by the fallback", async () => {
		await withFile("const a = 1;\nconst b = 2;\n", async (filePath, dir) => {
			const editor = createEditorExecutor();
			const result = await editor(
				{
					path: filePath,
					old_text: "const a = 1;",
					new_text: "const a = 99;",
				},
				dir,
				context as never,
			);
			expect(result).toMatch(/^Edited /);
			await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(
				"const a = 99;\nconst b = 2;\n",
			);
		});
	});
});
