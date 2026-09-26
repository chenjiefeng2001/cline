import { describe, expect, it } from "vitest";
import {
	MAX_RECOVERY_SYSTEM_PROMPT_LENGTH,
	parseRunRecoverySnapshot,
	RUN_RECOVERY_SNAPSHOT_KIND,
	RUN_RECOVERY_SNAPSHOT_VERSION,
	type RunRecoverySnapshot,
	serializeRunRecoverySnapshot,
} from "./recovery-snapshot";

function snapshot(
	overrides: Partial<RunRecoverySnapshot> = {},
): RunRecoverySnapshot {
	return {
		kind: RUN_RECOVERY_SNAPSHOT_KIND,
		version: RUN_RECOVERY_SNAPSHOT_VERSION,
		capturedAt: "2026-09-25T00:00:00.000Z",
		sessionId: "session-1",
		source: "cli",
		interactive: false,
		toolName: "read_files",
		toolOrigin: "core-builtin",
		clientContributionsPresent: false,
		run: {
			runId: "run-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			iteration: 1,
			toolCallIndex: 0,
			assistantMessageId: "assistant-1",
			toolCallId: "call-1",
			approvalId: "approval-1",
		},
		preparedInputHash: "input-hash",
		transcript: {
			messageCount: 2,
			lastMessageId: "assistant-1",
			transcriptHash: "transcript-hash",
			systemPromptHash: "system-hash",
		},
		config: {
			providerId: "provider-1",
			modelId: "model-1",
			cwd: "/workspace",
			workspaceRoot: "/workspace",
			systemPrompt: "system prompt",
			mode: "act",
			enableTools: true,
			enableSpawnAgent: false,
			enableAgentTeams: false,
			toolExecution: "sequential",
		},
		eligibility: {
			autoRecover: true,
			reason: "eligible",
		},
		...overrides,
	};
}

describe("run recovery snapshot", () => {
	it("round-trips a versioned snapshot", () => {
		const value = snapshot();
		const serialized = serializeRunRecoverySnapshot(value);
		expect(parseRunRecoverySnapshot(serialized)).toEqual(value);
	});

	it("round-trips bounded server runtime source selectors", () => {
		const value = snapshot({
			serverRuntime: {
				configExtensions: ["rules", "skills", "workflows"],
				skills: ["review", "commit"],
				sourceReference: {
					version: 1,
					algorithm: "sha256",
					digest: "a".repeat(64),
				},
			},
		});
		expect(
			parseRunRecoverySnapshot(serializeRunRecoverySnapshot(value)),
		).toEqual(value);
	});

	it("round-trips a parallel tool execution snapshot", () => {
		const value = snapshot({
			config: { ...snapshot().config, toolExecution: "parallel" },
		});
		expect(
			parseRunRecoverySnapshot(serializeRunRecoverySnapshot(value)),
		).toEqual(value);
	});

	it("rejects an unknown tool execution mode", () => {
		expect(() =>
			parseRunRecoverySnapshot(
				JSON.stringify({
					...snapshot(),
					config: { ...snapshot().config, toolExecution: "concurrent" },
				}),
			),
		).toThrow("toolExecution");
	});

	it("rejects plugins, unknown fields, and malformed skill allowlists", () => {
		for (const serverRuntime of [
			{ configExtensions: ["plugins"] },
			{ configExtensions: ["rules"], callback: "secret" },
			{ configExtensions: ["rules"], skills: [""] },
			{ configExtensions: ["rules"], skills: [42] },
			{
				configExtensions: ["rules"],
				sourceReference: {
					version: 2,
					algorithm: "sha256",
					digest: "a".repeat(64),
				},
			},
			{
				configExtensions: ["rules"],
				sourceReference: {
					version: 1,
					algorithm: "sha256",
					digest: "A".repeat(64),
				},
			},
			{
				configExtensions: ["rules"],
				sourceReference: {
					version: 1,
					algorithm: "sha256",
					digest: "a".repeat(64),
					filePath: "/secret/path",
				},
			},
		]) {
			expect(() =>
				parseRunRecoverySnapshot(
					JSON.stringify({ ...snapshot(), serverRuntime }),
				),
			).toThrow("serverRuntime");
		}
	});

	it("does not serialize credentials or raw runtime callbacks", () => {
		const value = snapshot({
			config: {
				...snapshot().config,
				providerId: "provider-1",
				systemPrompt: "system prompt",
			},
		});
		const serialized = serializeRunRecoverySnapshot(value);
		expect(serialized).not.toContain("apiKey");
		expect(serialized).not.toContain("authorization");
		expect(serialized).not.toContain("headers");
		expect(serialized).not.toContain("providerConfig");
		expect(serialized).not.toContain("execute");
	});

	it("rejects malformed versions, eligibility, and oversized prompts", () => {
		expect(() =>
			parseRunRecoverySnapshot(JSON.stringify({ ...snapshot(), version: 2 })),
		).toThrow("Unsupported");
		expect(() =>
			parseRunRecoverySnapshot(
				JSON.stringify({
					...snapshot(),
					eligibility: { autoRecover: true, reason: "custom_tool" },
				}),
			),
		).toThrow("inconsistent");
		expect(() =>
			parseRunRecoverySnapshot(
				JSON.stringify(
					snapshot({
						config: {
							...snapshot().config,
							systemPrompt: "x".repeat(MAX_RECOVERY_SYSTEM_PROMPT_LENGTH + 1),
						},
					}),
				),
			),
		).toThrow("systemPrompt");
	});
});
