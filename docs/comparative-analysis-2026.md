# Comparative Analysis: Cline SDK vs. Mainstream Coding Agents (Late 2026)

## Cline SDK Architecture Snapshot

**Layered stack:** `@cline/shared` → `@cline/llms` → `@cline/agents` → `@cline/core` → Host Apps

- **Agent loop (`@cline/agents/AgentRuntime`)**: Stateless `while` loop calling `model.stream()` per turn, assembling tool-call deltas into `AgentToolCallPart`, executing tools sequentially or parallel (`toolExecution: "parallel"`). Tool approval gated via `requestToolApproval()` callback and `ToolPolicy` (`enabled`, `autoApprove`). Hooks fire at `beforeRun/afterRun/beforeModel/afterModel/beforeTool/afterTool/onEvent`.
- **ClineCore (`@cline/core`)**: Stateful orchestrator over `RuntimeHost` (local/hub/remote). SQLite persistence (`~/.cline/data/sessions/sessions.db`), compaction artifacts (`session-compaction.json`), checkpoint/restore via `checkpoint-diff` + `checkpoint-restore`, and a `prepare` bootstrap hook.
- **Multi-agent**: Sub-agents (`start_subagent`, `message_subagent`, `handoff_to_agent`, `submit_and_exit`) + peer-to-peer **teams** (`team_spawn_teammate`, `team_delegate_task`, `team_check_status`, `team_get_result`) with task board, mailbox, and mission log persisted to `~/.cline/data/teams/`.
- **Streaming**: `AgentRuntimeEvent` types (`assistant-text-delta`, `assistant-reasoning-delta`, `tool-call-delta`, `usage`, `finish`, `tool-started`, `tool-finished`, `run-started`, `run-finished`, `turn-started`, `turn-finished`).
- **Telemetry**: OpenTelemetry spans on every run/tool call; `captureSdkError`, `captureAgentUnexpectedReasoningTokens`.
- **Security**: `ToolPolicy` per-tool and wildcard (`"*"`), `beforeTool` hooks for runtime veto, `toolSource.executionMode === "provider"` blocking, `requestToolApproval` callback for interactive approval.
- **Extensibility**: `AgentPlugin` (setup → return tools + hooks), config watcher system (`.cline/` dirs for rules/skills/workflows/agents/hooks/plugins/MCP), `LocalRuntimeBuilder` composition seam.

## Implementation Summaries

### Claude Code (Anthropic)
- **Loop**: Single-turn tool-use loop with permission checks between each tool call. Model returns `tool_use` blocks; Claude Code validates, applies permission rules, then executes.
- **Permissions**: Tiered modes (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`). Rule syntax `Tool(param:value)` with wildcards, deny/ask/allow precedence, compound command splitting, wrapper stripping (`timeout`, `nice`, `xargs`), bash read-only commands.
- **Memory**: CLAUDE.md files (managed/user/project/local) + `.claude/rules/` path-scoped rules + auto memory (`MEMORY.md` + topic files, 200-line/25KB limit).
- **Hooks**: 25+ lifecycle events (`PreToolUse`, `PostToolUse`, `PermissionRequest`, `SubagentStart`, `TeammateIdle`, `PreCompact`, `PostCompact`, etc.). Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent`. Matcher patterns with `if` conditions (`Bash(rm *)`). Async and HTTP hooks supported.
- **Multi-agent**: Subagents (background, named, with own context + auto memory) and **agent teams** (experimental, shared task list, mailbox JSON at `~/.claude/teams/{team}/inboxes/`, task claiming with file locking).
- **Persistence**: `~/.claude/sessions/`, `/resume` and `/rewind` for history, `cleanupPeriodDays` retention.
- **Sandboxing**: Network sandbox proxy with domain allowlist/denylist, filesystem sandboxing, worktree isolation.
- **Extensibility**: Plugins (MCP servers, skills, commands, subagent definitions), `AGENTS.md` import/export, `/import` to migrate from other agents.

### OpenAI Codex CLI
- **Loop**: Tool-use loop with permission mode selection. Subagent workflows with parallel agents, each with own model/reasoning.
- **Permissions**: **Permission profiles** (`:read-only`, `:workspace`, `:danger-full-access`, custom). Filesystem rules with `read`/`write`/`deny` per path, glob patterns, path precedence (deny > write > read). Network rules with domain allowlist/denylist, Unix socket allowlists, proxy configuration. Sandboxing on native Windows, WSL, macOS, Linux.
- **Memory**: AGENTS.md, memories, computer history.
- **Hooks**: Hook system for automation (documented separately).
- **Multi-agent**: **Subagent workflows** with custom agents (TOML config: `name`, `description`, `developer_instructions`, `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`). Built-in agents (`default`, `worker`, `explorer`). `/agent` command to switch threads. `agents.max_concurrent_threads_per_session`. Inherits sandbox policy from parent.
- **Persistence**: Local chat history, `codex resume`, `codex cloud` for cloud sessions.
- **Sandboxing**: `codex sandbox`, `windows-sandbox`, network sandbox proxy, filesystem permission profiles with `:workspace_roots`.
- **Extensibility**: Plugins (1751 available), MCP servers, skills, `AGENTS.md`.

### OpenCode
- **Loop**: Tool-use loop with TUI streaming. Plan mode / Build mode toggle.
- **Permissions**: `permissions` and `policies` config (less granular than Claude/Codex).
- **Memory**: AGENTS.md, rules, references.
- **Hooks**: Not prominently documented; limited lifecycle hooks.
- **Multi-agent**: No explicit subagent/team system in documentation. `/share` for conversation sharing.
- **Persistence**: Local conversation history.
- **Sandboxing**: Basic permissions model.
- **Extensibility**: SDK, plugins, server, MCP servers, LSP servers, custom tools, ACP support.

### LangGraph (LangChain)
- **Architecture**: **Graph-based state machine**. Nodes are agents/tools, edges are conditional transitions.
- **State management**: Checkpointer pattern (PostgreSQL/SQLite) for persisting graph state at every node. Time-travel debugging via `get_state` at any checkpoint.
- **Persistence**: Checkpointer abstraction, `MemorySaver`, `SqliteSaver`, `PostgresSaver`. State snapshots at every step.
- **Multi-agent**: Supervisor pattern, nested graphs, sequential/handoff patterns, `ToolNode` for function calling.
- **Human-in-the-loop**: `interrupt_before/after` nodes, `Command` tool for resumption, approval workflows via `wait_for_user`.
- **Streaming**: `stream()` with event modes (`values`, `updates`, `messages`, `debug`), SSE support.
- **Observability**: LangSmith tracing, OpenTelemetry.
- **Security**: RBAC via LangGraph Platform.

### AutoGen (Microsoft)
- **Architecture**: **Event-driven multi-agent framework**. `Core` layer (event-driven runtime), `AgentChat` layer (conversational agents).
- **Conversation patterns**: `ConsecutiveGroupChat`, `RoundRobinGroupChat`, `HierarchicalGroupChat`, pairwise conversations.
- **Tool use**: `FunctionClient` for function calling, `McpWorkbench` for MCP servers, `DockerCommandLineCodeExecutor` for sandboxed code execution.
- **Persistence**: Conversation history in agent state, `AssistantAgent` state management.
- **Multi-agent**: `AssistantAgent`, `UserProxyAgent`, `ConsecutiveGroupChat`, `RoundRobinGroupChat`.
- **Human-in-the-loop**: `human_in_the_loop` tasks, `reply_received` for approval, `terminate` on human input.
- **Extensibility**: Custom agents, tools, extensions via `autogen-ext`.
- **Observability**: OpenTelemetry, LangSmith integration.
- **Security**: Docker sandboxing via `DockerCommandLineCodeExecutor`.

## Comparative Gap Analysis

| Feature | Cline SDK | Claude Code | Codex CLI | OpenCode | LangGraph | AutoGen |
|---|---|---|---|---|---|---|
| **Core loop pattern** | Stateless while-loop + ClineCore stateful orchestration | Tool-use loop + permission gate | Tool-use loop + subagent delegation | Tool-use loop | Graph-based state machine | Event-driven multi-agent |
| **Tool approval** | `ToolPolicy` + `requestToolApproval` callback | Tiered modes + rule syntax `Tool(param:value)` | Permission profiles + filesystem/network rules | Basic permissions | N/A (graph-based) | N/A (conversational) |
| **Context management** | Compaction artifact + checkpoint/restore | CLAUDE.md + auto memory + rules + compaction hooks | AGENTS.md + memories + computer history | AGENTS.md + rules | State graph + checkpointer | Agent state management |
| **Session persistence** | SQLite + file-based messages | `~/.claude/sessions/` + resume | Local chat + `codex resume` | Local history | Checkpointer (Postgres/SQLite) | Conversation history |
| **Multi-agent** | Sub-agents + teams (task board, mailbox) | Subagents + agent teams (shared task list, mailbox) | Subagent workflows + custom agents | None | Supervisor/nested graphs | Group chat patterns |
| **Streaming** | Full `AgentRuntimeEvent` types | text/reasoning/tool deltas | Terminal streaming | TUI streaming | `stream()` event modes | Event-driven |
| **Hooks** | 7 hook points (beforeRun/afterRun/beforeModel/afterModel/beforeTool/afterTool/onEvent) | 25+ lifecycle events + 5 handler types + matchers | Hook system | Limited | Interrupt nodes | `reply_received` HITL |
| **Extensibility** | `AgentPlugin` + config watchers + MCP | Plugins + MCP + skills + subagent defs | Plugins (1751) + MCP + skills + custom agents | SDK + plugins + MCP | Custom nodes/tools/checkpointers | Custom agents + extensions |
| **Observability** | OpenTelemetry spans | Telemetry + debug logs | Usage insights | Basic | LangSmith + OpenTelemetry | OpenTelemetry + LangSmith |
| **Security/Sandboxing** | Tool policies + provider sandbox | Sandbox proxy + filesystem + worktree | Permission profiles + sandbox + network | Basic | RBAC (Platform) | Docker sandbox |
| **HITL** | `requestToolApproval` callback | Plan mode + permission prompts | Permission prompts | Basic | Interrupt nodes | `human_in_the_loop` |

## Cline SDK Gap Analysis

### Features Already On Par

| Feature | Details |
|---|---|
| **Stateless agent loop** | Matches Claude Code, Codex, OpenCode. `AgentRuntime` loop with tool-call streaming, parallel/sequential execution, completion tools. |
| **Streaming event system** | `AgentRuntimeEvent` types (`text-delta`, `reasoning-delta`, `tool-call-delta`, `usage`, `finish`, `tool-started`, `tool-finished`) are comparable to Claude Code's streaming and Codex's terminal output. |
| **Tool approval mechanism** | `ToolPolicy` with `enabled`/`autoApprove` flags and `requestToolApproval` callback is functionally equivalent to Codex's permission modes and Claude Code's permission prompts. |
| **Plugin system** | `AgentPlugin` with `setup()` returning tools and hooks matches Codex plugin architecture and Claude Code plugin system. |
| **Session persistence** | SQLite-backed sessions with message history, compaction artifacts, and checkpoint/restore are on par with Claude Code's session storage and Codex's chat persistence. |
| **OpenTelemetry** | Spans on every `agent.run` and `agent.tool`, telemetry capture via `ITelemetryService`, comparable to LangSmith and AutoGen observability. |
| **Config discovery** | `.cline/` watcher system for rules/skills/workflows/agents/hooks/plugins/MCP is functionally equivalent to Claude Code's settings discovery and Codex's `AGENTS.md` + config files. |

### Features Behind

| Feature | What's Missing | Concrete Gap |
|---|---|---|
| **Permission rule syntax** | Claude Code's `Tool(param:value)` granular matching, wildcard patterns (`Bash(git *)`), compound command parsing, wrapper stripping, read-only command detection. | Cline has `ToolPolicy.enabled`/`autoApprove` boolean flags only. No parameter-level matching, no tool-name globbing beyond `"*"`, no command-text analysis. |
| **Hook lifecycle depth** | Claude Code has 25+ distinct lifecycle events (`PreCompact`, `PostCompact`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`, `WorktreeRemove`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, etc.) vs. Cline's 7 dispatch points and 10 named events. | Compaction hooks now exist (`pre_compact`, fired for automatic and manual compaction). Still missing: `PostCompact`, subagent lifecycle hooks, model-switch hooks, elicitation hooks, config-change hooks, file-watch hooks. |
| **Hook handler types** | Claude Code supports `command`, `http`, `mcp_tool`, `prompt`, `agent` handler types with `if` matchers and async/parallel execution. | Cline hooks are TypeScript callbacks only. No HTTP hook endpoints, no MCP tool hooks, no prompt-based evaluation hooks, no agent-based hooks. |
| **Sandboxing** | Codex's permission profiles with filesystem `read`/`write`/`deny` per path, network domain allowlists, Unix socket allowlists, proxy configuration. Claude Code's sandbox proxy with domain restrictions and worktree isolation. | Cline's sandboxing is limited to `toolSource.executionMode === "provider"` blocking and `beforeTool` hook veto. No filesystem path-level sandbox, no network domain restrictions, no sandbox proxy. |
| **Memory system** | Claude Code's auto memory (`MEMORY.md` + topic files, 200-line/25KB limit, per-project directories) + CLAUDE.md hierarchy + `.claude/rules/` path-scoped rules. | Cline has `memory/` package (`recall-tool.ts`, `sqlite-memory-store.ts`) but lacks auto-memory accumulation, path-scoped rules, and the CLAUDE.md hierarchy. |
| **Subagent model configuration** | Codex's custom agents with per-agent `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers` configuration via TOML files. | Cline's `start_subagent` tool doesn't expose per-subagent model/reasoning/sandbox configuration. All subagents inherit parent config. |
| **Plan mode** | Claude Code's `plan` permission mode (read-only exploration, no edits until plan approved) and auto mode classifier. | Cline lacks a dedicated plan mode with classifier-based auto-approval or read-only exploration mode. |
| **Team persistence across sessions** | Claude Code's team task list persists across sessions (`~/.claude/tasks/{team}/`), teammate mailboxes survive session end. | Cline teams persist to `~/.cline/data/teams/` but resume behavior has known limitations. Teammate discovery and task claiming need hardening. |
| **Hook `if` conditions** | Claude Code's `if` field with permission-rule syntax (`Bash(rm *)`, `Edit(*.ts)`) for conditional hook execution. | Cline's hooks fire on every matching event without conditional filtering. No `if` matcher support. |
| **Permission mode switching mid-session** | Claude Code's `/permissions` command, `/model`, `/effort`, `/mode` runtime switching. Codex's `/permissions`, `/model`, `/mode`. | Cline's `updateSessionModel` and `updateSessionConnection` exist but lack runtime permission mode changes and effort-level controls. |

### Features Ahead

| Feature | Cline Advantage |
|---|---|
| **Hub-backed multi-process runtime** | `RuntimeHost` abstraction with `LocalRuntimeHost`, `HubRuntimeHost`, `RemoteRuntimeHost` + detached hub daemon + WebSocket server + A2A HTTP mount. No equivalent in Claude Code, Codex, or OpenCode. |
| **Peer-to-peer teams with task board** | Cline's team system with `task-board.json`, `mailbox.json`, `mission-log.json`, task claiming with file locking, and `team_spawn_teammate`/`team_delegate_task`/`team_check_status`/`team_get_result` tool surface. Claude Code's teams are experimental and lack the same tool-level integration. |
| **File-based automation** | `CronService` with YAML spec parsing, `cron.db`, reconciler, watcher, materializer, event ingress, reports. `events/*.event.md` specs. No equivalent in other implementations. |
| **Checkpoin-based diff/restore** | `checkpoint-diff.ts` and `checkpoint-restore.ts` with `git diff` comparison, hash validation of canonical prefix, compaction artifact validation. More granular than Claude Code's `/rewind` or Codex's `codex resume`. |
| **Usage aggregation** | `getAccumulatedUsage()` returns both `usage` (root) and `aggregateUsage` (root + teammates/subagents) buckets. More granular than Codex's or Claude Code's usage reporting. |
| **Telemetry integration** | OpenTelemetry spans on every run/tool call + `ITelemetryService` abstraction + distinct ID resolution + `captureAgentUnexpectedReasoningTokens`. More structured than other implementations' basic telemetry. |
| **Remote-config managed runtime** | `@cline/shared/remote-config` with `RemoteConfigBundle`, managed instruction materialization, blob upload metadata. No equivalent in other implementations. |
| **A2A HTTP mount** | Opt-in Agent-to-Agent HTTP surface with JSON-RPC commands and SSE task streaming over hub transport. No equivalent. |
| **Plugin sandboxing** | `extensions/plugin/` with sandboxing for sandboxed plugins, event bridge via `ctx.automation.ingestEvent()`. More structured than Claude Code's plugin sandboxing. |

## Prioritized Recommendations for Cline SDK

### Priority 1 (High Impact, Short Effort)

**1. Add `beforeTool` `if` conditions** — Allow hooks to specify conditional matchers (`toolName`, `toolName(param:value)`) so they only fire for matching tool calls, matching Claude Code's hook `if` field pattern. *Impact*: Massive for enterprise users who need `PreToolUse` hooks only for destructive commands. *Effort*: Moderate — add `if` field to hook config, parse with permission-rule syntax, evaluate against `toolName` + `toolCall.input`.

**2. Add parameter-level tool permission rules** — Extend `ToolPolicy` beyond `enabled`/`autoApprove` boolean flags to support `Tool(param:value)` matching and wildcard tool names (`"Bash(git *)"`). *Impact*: Enterprise security teams demand granular tool permission controls. *Effort*: Low — extend `ToolPolicy` type, add rule evaluation in `prepareToolExecution`.

**3. Add plan mode** — A `plan` permission mode where the agent can read files and run read-only commands but cannot edit, with a classifier-based auto-approval path. *Impact*: Matches Claude Code's plan mode and user expectations for complex tasks. *Effort*: Moderate — add `permissionMode: "plan"` config, enforce read-only tool policies in `beforeTool` hooks.

### Priority 2 (High Impact, Medium Effort)

**4. Expand hook lifecycle events** — `PreCompact` exists (fired for automatic and manual compaction). Still to add: `PostCompact`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `ConfigChange`, `FileChanged`, `PreModelSwitch`, `PostModelSwitch` events to the hook engine. *Impact*: Enterprise users need lifecycle automation (e.g., auto-format on edit, notify on teammate idle). *Effort*: High — requires emitting new event types from `AgentRuntime` and `ClineCore`, updating hook registration to support matchers.

**5. Add HTTP and MCP tool hook handlers** — Support `type: "http"` and `type: "mcp_tool"` hook handlers alongside `command`, plus `prompt` and `agent` types. *Impact*: Matches Claude Code's 5 hook handler types and enables enterprise integrations. *Effort*: High — new handler execution engine, HTTP endpoint dispatch, MCP tool call bridge.

**6. Add sandbox proxy with network domain rules** — Implement a sandbox proxy that enforces network domain allowlists/denylists per session, with Unix socket allowlists. *Impact*: Security/compliance requirements for enterprise deployments. *Effort*: High — proxy server, domain policy evaluation, integration with `ToolPolicy`.

### Priority 3 (Medium Impact, Medium Effort)

**7. Auto-memory system** — Implement `MEMORY.md` index with topic files, per-project memory directories, 200-line/25KB read limits, and `user`/`feedback`/`project`/`reference` memory types. *Impact*: Matches Claude Code's auto memory and significantly improves multi-session experience. *Effort*: Medium — memory store, index management, read/write limits, session integration.

**8. Per-subagent model and reasoning configuration** — Extend `start_subagent` to accept `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers` parameters. Store custom agent definitions in `.cline/agents/` TOML files. *Impact*: Matches Codex's custom agent architecture and enables specialized subagents. *Effort*: Medium — agent definition format, spawn-time parameter passing, per-agent config merging.

**9. Add path-scoped rules** — Implement `.cline/rules/` directory with `paths` frontmatter for conditional rule loading (e.g., `src/api/**/*.ts` only loads when editing those files). *Impact*: Matches Claude Code's rules system and reduces context window consumption. *Effort*: Low — YAML frontmatter parsing, path matching, lazy loading.

### Priority 4 (Medium Impact, High Effort)

**10. Full hook handler types (HTTP, prompt, agent)** — Beyond HTTP hooks, add `prompt` (single-turn Claude evaluation for hook decisions) and `agent` (spawn subagent to verify conditions before hook decision) handler types. *Impact*: Enterprise-grade hook automation. *Effort*: High — LLM-based hook evaluation, subagent invocation, decision aggregation.

**11. Runtime permission mode switching** — Support `/permissions`, `/model`, `/effort` commands mid-session to change permission mode, model, and reasoning effort without restarting. *Impact*: User experience parity with Claude Code and Codex. *Effort*: Medium — command parsing, runtime config updates, `updateSessionConnection` integration.

## Summary Verdict

**Cline is ahead** in: Hub-backed multi-process architecture, peer-to-peer teams with task board, file-based automation, checkpoint-based diff/restore, usage aggregation, OpenTelemetry integration, remote-config managed runtime, and A2A HTTP mount.

**Cline is on par** in: Stateless agent loop, streaming events, tool approval, plugin system, session persistence, config discovery, OpenTelemetry, and core extensibility.

**Cline is behind** in: Permission rule syntax granularity, hook lifecycle depth, hook handler types, sandboxing sophistication, memory/auto-memory system, subagent model configuration, plan mode, and runtime permission switching.

The most impactful next steps are **adding `if` conditions to hooks** (Priority 1), **parameter-level permission rules** (Priority 1), and **expanding hook lifecycle events** (Priority 2) — these close the largest gaps with enterprise users while leveraging Cline's existing architecture strengths.