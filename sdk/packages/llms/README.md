# [experimental] @cline/llms

`@cline/llms` is the model and provider layer for the Cline SDK. It gives
you typed provider settings, model catalogs, shared gateway contracts, and
AI SDK-backed handler creation for supported LLM backends.

## What You Get

- `@cline/llms/runtime` for declarative config and runtime registry creation
- `@cline/llms/providers` for handler creation and provider settings/types
- `@cline/llms/models` for model catalogs and query helpers
- `@cline/llms` root exports for the gateway registry and shared llm contracts

## Installation

```bash
npm install @cline/llms zod
```

## Quick Start

```ts
import { createHandler } from "@cline/llms";

const handler = createHandler({
	providerId: "anthropic",
	apiKey: process.env.ANTHROPIC_API_KEY ?? "",
	modelId: "claude-sonnet-4-6",
});

for await (const chunk of handler.createMessage("You are a concise assistant.", [
	{ role: "user", content: [{ type: "text", text: "Say hello." }] },
])) {
	console.log(chunk);
}
```

## Main APIs

### Runtime

Use `createLlmsRuntime(...)` when you want a small registry around:

- configured providers and their default models
- builtin provider discovery via `getBuiltInProviders()`
- custom provider registration via `registerBuiltinProvider(...)`
- handler creation for builtin or custom providers

Preferred import:

```ts
import { createLlmsRuntime, defineLlmsConfig } from "@cline/llms/runtime";
```

### Providers

Use `@cline/llms/providers` for:

- `createHandler(...)` and `createHandlerAsync(...)`
- `ProviderSettings` and `ProviderSettingsSchema`
- `ProviderConfig`
- `Message` and `ApiStreamChunk`

Built-in providers are routed through the internal gateway registry and backed by
AI SDK provider implementations. Shared gateway contracts are exported from both
`@cline/llms` and `@cline/shared`.

### Models

Use `@cline/llms/models` when you need generated provider/model metadata for
selection UIs, defaults, or validation.

For generated catalog field semantics and token-limit behavior, see
[`src/catalog/README.md`](./src/catalog/README.md).

## Entry Points

- `@cline/llms`: runtime-focused convenience entrypoint
- `@cline/llms/node`: explicit Node/runtime entrypoint
- `@cline/llms/browser`: browser-safe bundle
- `@cline/llms/runtime`: focused runtime entrypoint
- `@cline/llms/models`: model catalog/query entrypoint
- `@cline/llms/providers`: provider handler/settings entrypoint

## Transient Error Classification

A provider failure is a fact about the provider and the transport, so the
classification lives here rather than in each host:

```typescript
import {
  isTransientProviderError,
  computeRetryDelayMs,
  DEFAULT_PROVIDER_RETRY_POLICY,
} from "@cline/llms"
```

`isTransientProviderError(error)` is true for the failures a later attempt can
plausibly fix — 502/503/504, 429, overloaded responses, and dropped TLS or
connection resets. `401` is **not** transient: the credential is wrong, and
retrying only spends the caller's tokens to arrive at the same failure. An
aborted request is not transient either.

`computeRetryDelayMs(attempt, policy)` returns the backoff for an attempt, and
`DEFAULT_PROVIDER_RETRY_POLICY` is the shared shape. Hosts own their own loop —
the CLI's `withTransientRetry` is one — so each can decide what to do about
cancellation.

## Client Identity Headers

Two upstreams receive a description of the calling client: Cline's own billing
gateway (`cline`, `cline-pass`) and OpenAI's Codex backend (`openai-codex`).

| Header | Sent to | Value |
|--------|---------|-------|
| `User-Agent` | both | `Cline/<client version>`, or a bare `Cline` when the version is unknown |
| `X-CLIENT-TYPE` | Cline gateway | `cline-vscode`, `cline-cli`, `cline-acp`, `cline-hub`, … |
| `X-CLIENT-VERSION`, `X-PLATFORM`, `X-PLATFORM-VERSION`, `X-CORE-VERSION` | Cline gateway | the host's real values |
| `X-Task-ID` | Cline gateway | the session id |
| `originator` | Codex | `cline` |
| `ChatGPT-Account-Id` | Codex | derived from the access token |

Two rules the implementation holds to:

- **Never invent a version.** There is no `unknown` placeholder and no pinned
  fallback. A self-reported version that is obviously not a version reads as a
  spoofed client to an upstream that classifies callers, which defeats the point
  of reporting one. When the host genuinely does not know, the version header is
  omitted and `User-Agent` is a bare `Cline`.
- **The client version wins over the environment.** `userAgentVersion` comes from
  `process.env.npm_package_version`, which is only set when the process was
  launched through a package-manager script. Running the `cline` bin directly
  leaves it unset, so it is a last resort, never the primary source.

### Overriding the identity for a deployment

An operator pointing a build at a self-hosted gateway may need a different
product identity. Five headers can be replaced through the environment:

```bash
export CLINE_CLIENT_USER_AGENT="SelfHosted/2.0"
export CLINE_CLIENT_TYPE="self-hosted"
export CLINE_CLIENT_TITLE="Self Hosted"
export CLINE_CLIENT_REFERER="https://llm.internal"
export CLINE_CODEX_ORIGINATOR="my-gateway"
```

Read them with `resolveClientIdentityOverridesFromEnv()` and pass the result as
`identityOverrides`. The channel is deliberately narrow:

- only those five headers are replaceable, matched case-insensitively;
- a header this layer does not send is never **injected**, only replaced;
- headers that identify the authenticated caller rather than the client —
  `ChatGPT-Account-Id`, `session_id`, `X-Task-ID`, `X-CORE-VERSION` — are not
  overridable, so a config file cannot misattribute traffic.

Anything sent through the stored/config/session header layers still loses to the
derived values, as it always has; this is the supported way to change identity.

## Related Packages

- `@cline/agents`: agent loop and tool execution
- `@cline/core`: stateful runtime assembly and provider settings storage

## More Examples

- Workspace overview: [README.md](https://github.com/cline/cline/blob/main/README.md)
- API and architecture references: [DOC.md](https://github.com/cline/cline/blob/main/DOC.md), [ARCHITECTURE.md](https://github.com/cline/cline/blob/main/ARCHITECTURE.md)

## Live Provider Smoke Test

Use this for API-key-backed provider validation against real endpoints.

1. Ensure provider keys are present in your environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `CLINE_API_KEY`, etc.).
2. Use the sample config at `packages/llms/src/tests/live-providers.example.json` as the providers list.
3. Run:

```bash
LLMS_LIVE_TESTS=1 \
LLMS_LIVE_PROVIDERS_PATH=/absolute/path/to/packages/llms/src/tests/live-providers.example.json \
bun -F @cline/llms run test:live
```

Reasoning-focused live run (same command, different flags):

```bash
LLMS_LIVE_REASONING_TESTS=1 \
LLMS_LIVE_REASONING_PROVIDERS_PATH=/absolute/path/to/packages/llms/src/tests/live-providers.reasoning.example.json \
bun -F @cline/llms run test:live
```

Tool-use-focused live run (same command, different flags):

```bash
LLMS_LIVE_TOOL_TESTS=1 \
LLMS_LIVE_TOOL_PROVIDERS_PATH=/absolute/path/to/packages/llms/src/tests/live-providers.tools.example.json \
bun -F @cline/llms run test:live
```

Optional:

- `LLMS_LIVE_PROVIDER_TIMEOUT_MS=120000` to increase per-provider timeout.
- `LLMS_LIVE_PROVIDER_RETRIES=2` to retry transient upstream/provider failures per provider (total attempts = retries + 1). This is a knob on this test harness only, not on runtime behaviour.
- `LLMS_LIVE_PROVIDER_CONCURRENCY=3` to run multiple provider entries in parallel. Defaults to `3`; lower it if you need stricter provider rate-limit behavior.
- Point `LLMS_LIVE_PROVIDERS_PATH` to a custom file if you want a narrower provider set.
- Point `LLMS_LIVE_REASONING_PROVIDERS_PATH` to a custom file for reasoning-enabled suites.
- Point `LLMS_LIVE_TOOL_PROVIDERS_PATH` to a custom file for tool-use suites.
- Use `apiKeyEnv`, `baseUrlEnv`, and `headersEnv` in a provider entry when a live config needs secrets without writing them to JSON.
- When recording provider cassettes for committed replay tests, set `CLINE_VCR=record` and `CLINE_VCR_INCLUDE_REQUEST_BODY=1` so playback also verifies the sanitized request body contract.

OpenAI Codex subscription live runs use the saved OAuth credentials from `~/.cline/data/settings/providers.json` after `cline auth --provider openai-codex`. Point the plain or reasoning suite at `packages/llms/src/tests/live-providers.openai-codex.example.json` or `packages/llms/src/tests/live-providers.openai-codex.reasoning.example.json`.

Per-provider live assertions are configured in the JSON via `expectations`:

- `requireUsage`: fail if no `usage` chunk is emitted (defaults to `true`; set to `false` to opt out).
- `requireCacheReadTokens`: fail unless `cacheReadTokens > 0` (auto-runs at least 2 attempts with a long cache probe prompt if no prompt override is provided).
- `minCacheReadTokens`: stricter cache floor check.
- `requireReasoningChunk`: fail unless at least one reasoning chunk is emitted.
- `requireNoReasoningChunk`: fail if any reasoning chunk is emitted.
- `minInputTokens` / `minOutputTokens`: enforce lower bounds.
- `requireToolCall`: fail unless at least one `tool_calls` chunk is emitted.

In reasoning suites, set `requireReasoningSignal: true` to require either a reasoning chunk or provider-reported hidden reasoning tokens (provider-dependent; can be flaky on some endpoints).
To check that disabling reasoning actually suppresses reasoning output across models, use `packages/llms/src/tests/live-providers.reasoning-disabled.example.json`; it covers direct and routed provider paths across `cline`, `openai`, `openrouter`, `anthropic`, `gemini`, `vercel-ai-gateway`, `zai`, and `deepseek` where model support exists, with `reasoning.enabled: false` and the strongest available no-reasoning expectation for each provider.

Common live failure classes:

- `Overloaded`: provider/model capacity issue or transient upstream saturation.
- `Insufficient Balance`: the provider account needs funds.
- `Model Not Exist`: the model id is not available for that provider/account.
- assertion failures such as `expected no reasoning chunks`: likely real SDK/provider-option behavior regressions.

### Adding A Model To Live Tests

Add a new entry under the `providers` object in either config file:

- Cache/smoke suite: `packages/llms/src/tests/live-providers.example.json`
- Reasoning suite: `packages/llms/src/tests/live-providers.reasoning.example.json`
- Reasoning-disabled suite (asserts no reasoning chunks when reasoning is off): `packages/llms/src/tests/live-providers.reasoning-disabled.example.json`
- Tool-use suite: `packages/llms/src/tests/live-providers.tools.example.json`

Minimal smoke/cache entry:

```json
"my-openai-model": {
  "settings": {
    "provider": "openai",
    "model": "gpt-5.4"
  },
  "expectations": {
    "requireUsage": true
  }
}
```

Cache-asserted entry (auto-enforces multi-run cache probe):

```json
"my-cache-model": {
  "settings": {
    "provider": "openai",
    "model": "gpt-5.4"
  },
  "expectations": {
    "requireUsage": true,
    "requireCacheReadTokens": true
  }
}
```

Reasoning entry:

```json
"my-reasoning-model": {
  "settings": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "reasoning": {
      "effort": "high"
    }
  },
  "expectations": {
    "requireUsage": true,
    "requireReasoningChunk": true
  }
}
```

Tool-use entry:

```json
"my-tools-model": {
  "settings": {
    "provider": "openai",
    "model": "gpt-5.4"
  },
  "expectations": {
    "requireUsage": true,
    "requireToolCall": true
  }
}
```
