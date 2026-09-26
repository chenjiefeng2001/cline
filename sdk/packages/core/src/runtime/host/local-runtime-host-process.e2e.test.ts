import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSqliteDb } from "@cline/shared/db";
import { describe, expect, it } from "vitest";

const fixturePath = fileURLToPath(
	new URL("./local-runtime-host-process.fixture.mjs", import.meta.url),
);
const coreEntry = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../dist/index.js",
);

function runFixture(
	mode: "seed" | "recover",
	root: string,
	sessionId: string,
	a2a = false,
	sourceDrift = false,
) {
	const env = {
		...process.env,
		HOME: root,
		USERPROFILE: root,
		CLINE_DIR: join(root, ".cline"),
		CLINE_DATA_DIR: join(root, "data"),
		CLINE_DB_DATA_DIR: join(root, "data", "db"),
		CLINE_SESSION_DATA_DIR: join(root, "data", "sessions"),
		CLINE_TEAM_DATA_DIR: join(root, "data", "teams"),
		CLINE_HUB_DISCOVERY_PATH: join(root, "data", "locks", "hub"),
		CLINE_TEST_ROOT: root,
		CLINE_TEST_SESSION_ID: sessionId,
		CLINE_TEST_A2A: a2a ? "1" : "0",
		CLINE_TEST_SOURCE_DRIFT: sourceDrift ? "1" : "0",
	};
	return spawnSync(process.execPath, [fixturePath, mode], {
		cwd: root,
		env,
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 2 * 1024 * 1024,
	});
}

describe("LocalRuntimeHost process recovery", () => {
	it.each([
		{ name: "root", a2a: false, sourceDrift: false },
		{ name: "A2A", a2a: true, sourceDrift: false },
		{ name: "A2A source drift", a2a: true, sourceDrift: true },
	])("recovers a decided $name continuation after an abrupt process exit", async ({
		a2a,
		sourceDrift,
	}) => {
		expect(existsSync(coreEntry)).toBe(true);
		const root = mkdtempSync(join(tmpdir(), "cline-process-recovery-"));
		const sessionId = "session-process-recovery";
		try {
			const seed = runFixture("seed", root, sessionId, a2a, false);
			expect(seed.error).toBeUndefined();
			expect(seed.signal).toBeNull();
			expect(seed.status).toBe(17);
			const continuationDb = loadSqliteDb(
				join(root, "data", "db", "continuations.db"),
			);
			try {
				const row = continuationDb
					.prepare(
						"SELECT run_state_json FROM run_continuations WHERE session_id = ?",
					)
					.get(sessionId) as { run_state_json: string | null } | undefined;
				expect(row?.run_state_json).toContain('"cline.run-state"');
				expect(row?.run_state_json).not.toContain("README.md");
			} finally {
				continuationDb.close?.();
			}

			const recover = runFixture("recover", root, sessionId, a2a, sourceDrift);
			expect(recover.error).toBeUndefined();
			expect(recover.signal).toBeNull();
			expect(recover.status).toBe(0);
			const outputLine = recover.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.reverse()
				.find((line) => line.startsWith('{"report"'));
			expect(outputLine).toBeTruthy();
			const output = JSON.parse(outputLine as string) as {
				report: Record<string, unknown>;
				resumedInput: Record<string, unknown>;
				runtimeInput?: {
					configExtensions?: string[];
					skills?: string[];
				};
			};
			if (sourceDrift) {
				expect(output.report).toMatchObject({
					scanned: 1,
					eligible: 1,
					scheduled: 1,
					resumed: 0,
					skipped: 0,
					failed: 1,
					truncated: false,
				});
				expect(output.resumedInput).toBeUndefined();
			} else {
				expect(output.report).toMatchObject({
					scanned: 1,
					eligible: 1,
					scheduled: 1,
					resumed: 1,
					skipped: 0,
					failed: 0,
					truncated: false,
				});
				expect(output.resumedInput).toMatchObject({
					runId: "run-process-1",
					iteration: 1,
					assistantMessageId: "assistant-process-1",
					toolCallId: "call-process-1",
					toolName: "read_files",
					preparedInput: { path: "README.md" },
					approval: { approved: true },
				});
			}
			expect(output.runtimeInput).toMatchObject({
				configExtensions: ["rules", "workflows"],
				skills: ["review"],
			});
		} finally {
			rmSync(root, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		}
	}, 120_000);
});
