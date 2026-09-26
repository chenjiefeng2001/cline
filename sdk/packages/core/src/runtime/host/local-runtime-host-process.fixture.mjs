import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const mode = process.argv[2];
const root = process.env.CLINE_TEST_ROOT;
const sessionId = process.env.CLINE_TEST_SESSION_ID;
const a2a = process.env.CLINE_TEST_A2A === "1";
const recoveryOwner = "a2a-process-recovery-owner";
const runtimeConfigExtensions = ["rules", "workflows"];
const runtimeSkills = ["review"];
const sourceDigest = (
	process.env.CLINE_TEST_SOURCE_DRIFT === "1" ? "b" : "a"
).repeat(64);
if (!root || !sessionId || (mode !== "seed" && mode !== "recover")) {
	throw new Error("Invalid process recovery fixture arguments");
}

const coreEntry = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../dist/index.js",
);
const core = await import(pathToFileURL(coreEntry).href);
const { CoreSessionService, LocalRuntimeHost, SqliteSessionStore } = core;

const toolCallId = "call-process-1";
const assistantMessageId = "assistant-process-1";
const runId = "run-process-1";
const approvalId = "approval-process-1";
const toolName = "read_files";
const toolInput = { path: "README.md" };

function initialMessages() {
	return [
		{ role: "user", content: [{ type: "text", text: "read it" }] },
		{
			role: "assistant",
			id: assistantMessageId,
			content: [
				{
					type: "tool_use",
					id: assistantMessageId,
					call_id: toolCallId,
					name: toolName,
					input: toolInput,
				},
			],
		},
	];
}

function result(messages, finishReason = "completed") {
	return {
		text: "recovered",
		usage: { inputTokens: 1, outputTokens: 1, totalCost: 0 },
		messages,
		toolCalls: [],
		iterations: 2,
		finishReason,
		model: { id: "mock-model", provider: "mock-provider" },
		startedAt: new Date("2026-09-25T00:00:00.000Z"),
		endedAt: new Date("2026-09-25T00:00:01.000Z"),
		durationMs: 1,
	};
}

function makeConfig() {
	return {
		providerId: "mock-provider",
		modelId: "mock-model",
		cwd: root,
		workspaceRoot: root,
		systemPrompt: "process recovery test",
		mode: "act",
		enableTools: true,
		enableSpawnAgent: false,
		enableAgentTeams: false,
		skills: runtimeSkills,
		sessionId,
	};
}

function createHost() {
	const store = new SqliteSessionStore();
	store.init();
	const sessionService = new CoreSessionService(store);
	let capturedConfig;
	let currentMessages = [];
	let resumedInput;
	let capturedRuntimeInput;
	const triggerSeedApproval = async () => {
		const approval = await capturedConfig.requestToolApproval({
			approvalId,
			sessionId,
			agentId: "agent-process-1",
			conversationId: "conversation-process-1",
			runId,
			iteration: 1,
			toolCallIndex: 0,
			assistantMessageId,
			toolCallId,
			toolName,
			input: toolInput,
			policy: { autoApprove: false },
		});
		if (!approval?.approved) {
			throw new Error("Seed approval was not granted");
		}
		process.exit(17);
	};
	const agent = {
		run: triggerSeedApproval,
		continue: triggerSeedApproval,
		resumePendingToolCall: async (input) => {
			resumedInput = input;
			currentMessages = [
				...currentMessages,
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId,
							toolName,
							output: "recovered",
						},
					],
				},
			];
			return result(currentMessages);
		},
		getMessages: () => currentMessages,
		getAgentId: () => "agent-process-1",
		getConversationId: () => "conversation-process-1",
		abort: () => {},
		subscribeEvents: () => () => {},
		canStartRun: () => true,
		shutdown: async () => {},
	};
	const host = new LocalRuntimeHost({
		sessionService,
		runtimeBuilder: {
			build: async (input) => {
				capturedRuntimeInput = input;
				return {
					tools: [],
					shutdown: async () => {},
					getServerRuntimeSourceReference: () => ({
						version: 1,
						algorithm: "sha256",
						digest: sourceDigest,
					}),
				};
			},
		},
		createAgent: (config) => {
			capturedConfig = config;
			currentMessages = [...(config.initialMessages ?? [])];
			return agent;
		},
		capabilities: {
			requestToolApproval: async () => ({ approved: true }),
		},
		...(a2a ? { recoveryOwner } : {}),
	});
	return {
		host,
		store,
		getResumedInput: () => resumedInput,
		getRuntimeInput: () => capturedRuntimeInput,
	};
}

async function seed() {
	const { host } = createHost();
	await host.startSession({
		config: makeConfig(),
		source: a2a ? "a2a" : "cli",
		...(a2a ? { recoveryOwner } : {}),
		interactive: false,
		localRuntime: {
			configExtensions: runtimeConfigExtensions,
		},
		prompt: "continue",
		initialMessages: initialMessages(),
	});
}

async function recover() {
	const { host, store, getResumedInput, getRuntimeInput } = createHost();
	const report = await host.recoverPendingRunContinuations({
		background: true,
		maxCandidates: 1,
	});
	const deadline = Date.now() + 30_000;
	while (
		report.scheduled > report.resumed + report.failed &&
		Date.now() < deadline
	) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	await host.dispose();
	store.close();
	const runtimeInput = getRuntimeInput();
	process.stdout.write(
		`${JSON.stringify({
			report,
			resumedInput: getResumedInput(),
			runtimeInput: runtimeInput
				? {
						configExtensions: runtimeInput.configExtensions,
						skills: runtimeInput.config.skills,
					}
				: undefined,
		})}\n`,
	);
}

try {
	if (mode === "seed") {
		await seed();
	} else {
		await recover();
	}
} catch (error) {
	process.stderr.write(
		`${error instanceof Error ? error.stack : String(error)}\n`,
	);
	process.exit(1);
}
