import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const createContextCompactionPrepareTurn = vi.fn()
const createSessionCompactionState = vi.fn((input: unknown) => ({ version: 1, input }))
const createPreCompactHookEmitter = vi.fn()
const createPostCompactHookEmitter = vi.fn()
vi.mock("@cline/core", () => ({
	createContextCompactionPrepareTurn: (...args: unknown[]) => createContextCompactionPrepareTurn(...args),
	createSessionCompactionState: (input: unknown) => createSessionCompactionState(input),
	createPreCompactHookEmitter: (...args: unknown[]) => createPreCompactHookEmitter(...args),
	createPostCompactHookEmitter: (...args: unknown[]) => createPostCompactHookEmitter(...args),
}))

vi.mock("@/shared/services/Logger", () => ({
	Logger: { debug: vi.fn(), error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))

let compactSessionMessages: typeof import("./sdk-compaction").compactSessionMessages

const baseConfig = {
	providerConfig: { providerId: "anthropic", modelId: "claude" },
	providerId: "anthropic",
	modelId: "claude",
	knownModels: { claude: { id: "claude", maxInputTokens: 200_000 } },
	compaction: undefined,
	logger: undefined,
	telemetry: undefined,
} as unknown as Parameters<typeof compactSessionMessages>[0]["config"]

describe("compactSessionMessages", () => {
	beforeAll(async () => {
		;({ compactSessionMessages } = await import("./sdk-compaction"))
	})

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("wires a pre_compact emitter, so manual compaction fires user hooks", async () => {
		// Auto compaction gets this from the runtime bootstrap; manual compaction
		// builds its own prepareTurn, so without this the hook silently never fires
		// for a user who pressed "compact" themselves.
		const onPreCompact = vi.fn()
		createPreCompactHookEmitter.mockReturnValueOnce(onPreCompact)

		await compactSessionMessages({
			config: baseConfig,
			sessionId: "s1",
			messages: [{ role: "user", content: "long" }],
			cwd: "/tmp/workspace",
		})

		expect(createPreCompactHookEmitter).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/workspace",
				workspacePath: "/tmp/workspace",
				rootSessionId: "s1",
			}),
		)
		expect(createContextCompactionPrepareTurn).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ onPreCompact }),
		)
	})

	it("wires a post_compact emitter, so manual compaction reports its outcome", async () => {
		// Same reason as the pre-compact emitter above: a manual compaction builds its
		// own prepareTurn here, so without this the outcome hook would silently never
		// fire for a user who pressed "compact" themselves.
		const onPostCompact = vi.fn()
		createPostCompactHookEmitter.mockReturnValueOnce(onPostCompact)

		await compactSessionMessages({
			config: baseConfig,
			sessionId: "s1",
			messages: [{ role: "user", content: "long" }],
			cwd: "/tmp/workspace",
		})

		expect(createPostCompactHookEmitter).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/tmp/workspace",
				workspacePath: "/tmp/workspace",
				rootSessionId: "s1",
			}),
		)
		expect(createContextCompactionPrepareTurn).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ onPostCompact }),
		)
	})

	it("returns compacted=false without invoking the SDK when there are no messages", async () => {
		const result = await compactSessionMessages({ config: baseConfig, sessionId: "s1", messages: [], cwd: "/tmp/workspace" })

		expect(result).toEqual({ compacted: false, messages: [] })
		expect(createContextCompactionPrepareTurn).not.toHaveBeenCalled()
	})

	it("builds a manual-mode prepareTurn and force-enables compaction", async () => {
		const compact = vi
			.fn()
			.mockResolvedValue({ messages: [{ role: "user", content: "summary" }], systemPrompt: "rewritten system" })
		createContextCompactionPrepareTurn.mockReturnValueOnce(compact)

		const messages = [
			{ role: "user" as const, content: "1" },
			{ role: "assistant" as const, content: "2" },
		]
		const result = await compactSessionMessages({ config: baseConfig, sessionId: "s1", messages, cwd: "/tmp/workspace" })

		// Manual mode + enabled compaction + telemetry keying.
		expect(createContextCompactionPrepareTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				modelId: "claude",
				compaction: expect.objectContaining({ enabled: true }),
				sessionId: "s1",
			}),
			expect.objectContaining({ mode: "manual" }),
		)
		expect(compact).toHaveBeenCalledOnce()
		expect(createSessionCompactionState).toHaveBeenCalledWith({
			sourceMessages: messages,
			compactedMessages: [{ role: "user", content: "summary" }],
			conversationId: "s1",
			systemPrompt: "rewritten system",
		})
		expect(result).toEqual({
			compacted: true,
			messages: [{ role: "user", content: "summary" }],
			compactionState: { version: 1, input: expect.anything() },
		})
	})

	it("preserves context-only model limits for the shared resolver", async () => {
		const compact = vi.fn().mockResolvedValue({ messages: [{ role: "user", content: "summary" }] })
		createContextCompactionPrepareTurn.mockReturnValueOnce(compact)
		const contextOnlyConfig = {
			...baseConfig,
			knownModels: { claude: { id: "claude", contextWindow: 400_000 } },
		} as unknown as Parameters<typeof compactSessionMessages>[0]["config"]

		await compactSessionMessages({
			config: contextOnlyConfig,
			sessionId: "s-context-only",
			messages: [{ role: "user", content: "long context" }],
			cwd: "/tmp/workspace",
		})

		expect(compact).toHaveBeenCalledWith(
			expect.objectContaining({
				model: expect.objectContaining({
					info: { id: "claude", contextWindow: 400_000 },
				}),
			}),
		)
	})

	it("returns compacted=false when prepareTurn is unavailable", async () => {
		createContextCompactionPrepareTurn.mockReturnValueOnce(undefined)

		const messages = [{ role: "user" as const, content: "1" }]
		const result = await compactSessionMessages({ config: baseConfig, sessionId: "s1", messages, cwd: "/tmp/workspace" })

		expect(result).toEqual({ compacted: false, messages })
	})

	it("returns compacted=false when the strategy declines (returns undefined)", async () => {
		const compact = vi.fn().mockResolvedValue(undefined)
		createContextCompactionPrepareTurn.mockReturnValueOnce(compact)

		const messages = [{ role: "user" as const, content: "1" }]
		const result = await compactSessionMessages({ config: baseConfig, sessionId: "s1", messages, cwd: "/tmp/workspace" })

		expect(result).toEqual({ compacted: false, messages })
	})
})
