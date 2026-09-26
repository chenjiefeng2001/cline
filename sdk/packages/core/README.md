# [experimental] @cline/core

`@cline/core` is the stateful orchestration layer of the Cline SDK. It
connects the agent runtime, provider settings, storage, default tools, and
session lifecycle into a host-ready runtime.

## What You Get

- session lifecycle and orchestration primitives
- provider settings and account services
- default runtime tools and MCP integration
- storage-backed session and team state helpers
- host-facing Node helpers through `@cline/core`

## Installation

```bash
npm install @cline/core
```

## Entry Points

- `@cline/core`: core contracts, shared utilities, and Node/server helpers for building hosts and runtimes

## Typical Usage

Most host apps should start with `@cline/core`.

```ts
import { ClineCore } from "@cline/core";

const cline = await ClineCore.create({});

const result = await cline.start({
	config: {
		providerId: "anthropic",
		modelId: "claude-sonnet-4-6",
		apiKey: process.env.ANTHROPIC_API_KEY ?? "",
		cwd: process.cwd(),
		mode: "act",
		enableTools: true,
		enableSpawnAgent: false,
		enableAgentTeams: false,
		systemPrompt: "You are a concise assistant.",
	},
	prompt: "Summarize this project.",
	interactive: false,
});

console.log(result.result?.text);
await cline.dispose();
```

## Session Bootstrap

`ClineCore.create(...)` also accepts `prepare(input)`.

Use it when a host needs to prepare workspace-scoped runtime state before each
session starts, then apply watcher/extensions/telemetry inputs through
explicit `localRuntime` bootstrap fields without widening the shared host
contract.

## Main APIs

### Runtime and Sessions

Use `@cline/core` for host-facing runtime assembly:

- `ClineCore.create(...)`
- `createRuntimeHost(...)`
- `LocalRuntimeHost`
- `HubRuntimeHost` and `RemoteRuntimeHost`
- `DefaultRuntimeBuilder`

`ClineCore` is the app-facing session API. The lower-level `RuntimeHost`
boundary uses runtime-primitive names such as `startSession` and `runTurn` so
transport adapters stay distinct from product methods like `start` and `send`.
Service-style operations such as pending prompt edits, accumulated usage lookup,
and active-session model switching are exposed through `ClineCore` when the
selected transport supports them rather than being part of the minimal host
primitive vocabulary.

### Default Tools

`@cline/core` owns the built-in host tools and executors:

- `createBuiltinTools(...)`
- `createDefaultTools(...)`
- `createDefaultExecutors(...)`

### Storage and Settings

The package also exports storage and settings helpers such as:

- `ProviderSettingsManager`
- `CoreSettingsService` and `createCoreSettingsService`
- MCP settings helpers such as `setMcpServerDisabled`
- `SqliteTeamStore`
- SQLite-backed local session stores and artifacts through `@cline/core`

### Durable Tool Effects

`LocalRuntimeHost` records tool attempts in a SQLite Effect Ledger before
execution. Claims are atomic and leased; succeeded calls replay on recovery,
expired or uncertain calls remain `in_doubt`, and only explicitly retry-safe
failures can be attempted again. The ledger wraps the final per-turn tool set,
including extension, sub-agent, and teammate tools. Checkpoint restore imports
source effects before the restored prompt is allowed to run.

The advanced `EffectLedger`, `SqliteEffectLedger`, key derivation, middleware,
and recovery helpers are exported from `@cline/core`.

### Durable Tool Approvals

`LocalRuntimeHost` and hub-backed sessions share a
`DurableToolApprovalCoordinator` backed by SQLite `approvals.db`. Requests are
deduplicated by durable run/tool identity, retain their input and policy, bind
an approval principal, and transition atomically to approved, denied, expired,
or cancelled. Pending requests are replayed to the assigned client when a
session attaches. `DurableToolApprovalCoordinator`,
`SqliteDurableToolApprovalStore`, and the approval record types are exported
from `@cline/core`.

The single-tool MVP continuation journal is available through
`DurableRunContinuationCoordinator` and `SqliteRunContinuationStore`. It stores
a versioned local recovery snapshot without API keys, provider credentials,
raw callbacks, or client capability payloads. The snapshot may retain only
bounded rules/skills/workflows selectors, a skills allowlist, and an aggregate
SHA-256 source reference; source contents, paths, and plugins remain outside
automatic recovery. Each turn and continuation also acquires a detached,
deeply frozen in-memory source snapshot so rule, skill, and workflow content
cannot change during an active run. The persisted snapshot remains hash-only:
resume reloads current sources, compares the reference, and fails closed on
drift. The continuation store also persists a strict versioned `RunState`
resume manifest with bounded config/transcript fingerprints and selectors; it
excludes raw input, transcript bodies, source content, secrets, callbacks, and
process objects. Its resume cursor is a versioned union: `tool_call` for a single
pending step and `tool_call_batch` for a whole assistant turn, recorded as an
ordered, duplicate-free step list with contiguous call ordinals. A serializable
`agent` block records the agent identity (`agentId`, plus `parentAgentId` and
`rootRunId` for delegated runs) so resume can prove it rebuilt the same agent;
a continuation that names a parent agent is refused until the agent chain itself
is rebuildable.
Explicit resume prefers `RunState` and falls back to the
legacy snapshot, rejecting identity, step-identity, agent-identity, and transcript
drift. The detached daemon performs a
bounded startup scan for decided, stale, root, sequential, server-owned
built-in-tool continuations before schedules start. A host can also call
`LocalRuntimeHost.resumePendingRun` or send the Hub `session.resume` command
with the original runtime start configuration. Resume requires a matching
persisted assistant tool call, prepared input, approval identity, and sequential
server-owned tool; other cases fail closed. The snapshot and `RunState` record
the session's real tool-execution mode, and the host forwards
`maxParallelToolCalls` into the agent config, so a replayed session keeps the
recorded mode. A one-call turn replays identically in either mode and stays
recoverable; a persisted assistant message with more
than one tool call is recorded as `parallel_or_ambiguous`; it is resumed only when
every tool call in that turn has a decided continuation record, in which case the
host stores the turn-level batch cursor, the scan groups the records by assistant
turn, and replay goes through
`LocalRuntimeHost.resumePendingRunBatch` / `AgentRuntime.resumePendingToolBatch`
in the recorded execution mode.
A batch resume requires the recorded cursor to cover exactly the replayed
continuations in persisted order and to match the persisted assistant turn, and
replaying a single call of a multi-tool turn is refused before the lease is
claimed.
The Hub `session.resume` command accepts `continuationKeys` for the same batch
operation.
Each tool call also carries a stable `stepId`
(`step:<runId>:<iteration>:<callIndex>`) through the tool context, approval
request, middleware, telemetry, and the Effect Ledger, so a specific step can be
reconciled after a restart. Incomplete tool-call groups, multi-agent
continuation, and uncertain `executing` records remain manual; the latter
require explicit `reclaimExecuting: true`. A2A cross-process recovery is enabled
only for a stable server recovery owner, trusted daemon workspace, and
server-owned snapshot; A2A exposes only a redacted pending-approval descriptor
and accepts one structured `cline.approval.decision` data part for live
`approval.respond` continuation. A process-level e2e fixture verifies both root
and A2A seed/recover child processes; it uses a deterministic fake leaf agent
and does not yet claim external tool-side-effect idempotency. A post-restart
approval decision triggers a bounded per-session recovery scan through the
Hub approval boundary.

## Related Packages

- `@cline/agents`: stateless agent loop and tool primitives
- `@cline/llms`: provider/model configuration and handlers

## More Examples

- Repo examples: [examples](https://github.com/cline/sdk/tree/main/examples), [apps/examples](https://github.com/cline/sdk/tree/main/apps/examples)
- Workspace overview: [README.md](https://github.com/cline/cline/blob/main/README.md)
- API and architecture references: [DOC.md](https://github.com/cline/cline/blob/main/DOC.md), [ARCHITECTURE.md](https://github.com/cline/cline/blob/main/ARCHITECTURE.md)
