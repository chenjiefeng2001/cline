import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A resolved write is not proof that all of it landed, so the editor verifies by
// reading the file back. To exercise the failure path we need a write that
// resolves but lands short, which cannot be provoked through the real
// filesystem, so `node:fs/promises` is mocked with a switch. Everything else is
// the genuine implementation, so the passing case exercises real writes.
const fsMock = vi.hoisted(() => ({ shortWrite: false }));

vi.mock("node:fs/promises", async () => {
	const actual =
		await vi.importActual<typeof import("node:fs/promises")>(
			"node:fs/promises",
		);
	return {
		...actual,
		default: actual,
		writeFile: async (
			target: Parameters<typeof actual.writeFile>[0],
			data: Parameters<typeof actual.writeFile>[1],
			options?: Parameters<typeof actual.writeFile>[2],
		) => {
			if (fsMock.shortWrite) {
				// Land a strict prefix of the requested content and still resolve.
				const text = typeof data === "string" ? data : String(data);
				return actual.writeFile(
					target,
					text.slice(0, Math.floor(text.length / 2)),
					options,
				);
			}
			return actual.writeFile(target, data, options);
		},
	};
});

const { mkdir, mkdtemp, readFile, rm } = await import("node:fs/promises");
const { createEditorExecutor } = await import("./editor");

const context = {
	agentId: "agent-1",
	conversationId: "conv-1",
	iteration: 1,
};

describe("editor write verification", () => {
	beforeEach(() => {
		fsMock.shortWrite = false;
	});

	it("fails loudly when a write resolves but lands short", async () => {
		// "write_to_file truncates content when used as fallback, especially for
		// large files" - cline/cline#4384. The old code reported success regardless,
		// so the model carried on from a file that was quietly missing half of it.
		const dir = await mkdtemp(
			path.join(require("node:os").tmpdir(), "editor-trunc-"),
		);
		const filePath = path.join(dir, "big.txt");
		fsMock.shortWrite = true;

		try {
			const editor = createEditorExecutor();
			await expect(
				editor(
					{ path: filePath, new_text: "x".repeat(4096) },
					dir,
					context as never,
				),
			).rejects.toThrow(/did not complete/i);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("still succeeds and reports success when the full content lands", async () => {
		const dir = await mkdtemp(
			path.join(require("node:os").tmpdir(), "editor-ok-"),
		);
		const filePath = path.join(dir, "ok.txt");
		const content = "complete content\nline two\nline three\n";

		try {
			const editor = createEditorExecutor();
			const result = await editor(
				{ path: filePath, new_text: content },
				dir,
				context as never,
			);
			expect(await readFile(filePath, "utf-8")).toBe(content);
			expect(result).toMatch(/created successfully/i);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("verifies multi-byte content without treating encoding as truncation", async () => {
		const dir = await mkdtemp(
			path.join(require("node:os").tmpdir(), "editor-mb-"),
		);
		const filePath = path.join(dir, "unicode.txt");
		const content = '// 日本語のコメント\nconst emoji = "🚀";\n';

		try {
			await mkdir(dir, { recursive: true });
			const editor = createEditorExecutor();
			const result = await editor(
				{ path: filePath, new_text: content },
				dir,
				context as never,
			);
			expect(await readFile(filePath, "utf-8")).toBe(content);
			expect(result).toMatch(/created successfully/i);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
