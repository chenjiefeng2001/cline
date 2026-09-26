# Cline Agent 能力差距分析（2026-09）

> 分析日期：2026-09-24  
> 当前基线：`main` @ `258a9a1ca`  
> 分析范围：`sdk/packages/agents`、`sdk/packages/shared`、`sdk/packages/llms`、`sdk/packages/core` 及相关 Hub/A2A/CI 实现  
> 对照对象：OpenAI Agents SDK、LangGraph、Google ADK、Microsoft Agent Framework、Claude Agent SDK、CrewAI、AG2，以及 MCP/A2A/OTel 生产基线  
> 方法：当前源码静态审计 + 官方文档核验；未执行真实 provider、网络部署或攻击性 E2E

---

## 1. 与既有报告的关系

本文是以下两份文档的当前状态增量版：

- `doc/architecture-gap-analysis-vs-mainstream-agents-2026-08.md`
- `doc/remediation-log-2026-08-26.md`

旧报告中的 OTel、Memory、Middleware、Sandbox、Effect Ledger、Teams Patterns、A2A 等差距已经历 Phase 5–21 的多轮实现，不能继续按“完全缺失”描述。

但整改日志中的“building block 已落地”也不等于“默认产品链路已闭环”。本文以当前生产调用点为准，将能力分为：

1. **已关闭**：默认运行路径已经使用，并通过当前代码与测试验证。
2. **部分关闭**：模块、接口或 opt-in 路径存在，但默认产品语义、持久化或安全保证不足。
3. **仍缺失**：当前生产路径不存在有效实现。

---

## 2. 执行摘要

当前 Cline 已经具备一个功能相当丰富的 Agent 平台骨架：

- 轻量 AgentRuntime：模型流、工具循环、Hooks、事件、审批回调、usage、OTel span。
- Core：会话持久化、Plan/Act、内置工具、Plugins、MCP、Subagents、Teams、Cron、Hub、A2A HTTP/SSE。
- 平台 building blocks：Memory、Middleware、Sandbox、Effect Ledger、A2A v1、Teams patterns。
- 工程体系：SDK/应用测试、extended-tests CI、构建和类型门禁。

本轮已关闭 P0-1 tracing 父子关系、P0-2 A2A 首消息/SSE 时序、P0-3 工具执行契约、P0-4 的 durable execution 核心链路和 durable approval store，以及 run 级 token/cost budget 治理。当前主要未关闭差距为：

1. **通用可恢复 RunState 与审批后的自动进程 continuation 未闭环**：approval request/decision 已持久化并支持重连重发，显式单工具 resume、顺序与并行多工具 turn 的受控重放 MVP 已完成（turn 级 batch cursor + agent identity 校验 + 执行模式保持），delegated/team turn 的记录侧已身份正确并 fail closed，但 delegated/team 的可恢复 resume 与复杂配置的自动恢复仍未闭环。
2. **Middleware、Memory、Sandbox 仍未全部默认接线**：idempotency middleware 已进入标准 runtime；approval/retry/redaction、Memory 和 Sandbox 仍有 opt-in 或未接线部分（budget 已由 runtime 内建，见 6.4）。
3. **Hub 远程安全**：connection principal、分层 session ACL（read/write/own）、userFiles workspace containment（含符号链接逃逸）、凭据三处收口脱敏已关闭；仍缺 admin 角色与 owner 主动提升 observer 的协作通道、TLS/mTLS、OAuth scope、tenant identity，以及 A2A task-scoped credential。
4. **持续评测**：两层已建立。PR 确定性门禁（离线、无 secret、baseline 钉住 case 集合，删 case 即红）+ nightly model eval（live provider、3 trials 产 pass@3、不 gate PR、不设阈值）。仍缺 dataset regression threshold 与 release gate，需 CI 资源与 `CLINE_API_KEY`。
5. **成本治理只到 run 级**：budget 未跨轮次累计、未跨 delegated agent 池化，context 压缩仍由宿主实现。

代码强制保证与待决策保证的完整清单见 6.7。

因此，当前实现适合作为可信本机单用户 Agent 的高级基础；若目标是生产级远程、多租户或强副作用 Agent，仍需优先补齐执行语义、安全边界和持续评测。

---

## 3. 当前能力分层

| 能力域 | 当前状态 | 判定 | 关键证据 |
|---|---|---|---|
| 基础 Agent loop | 完整 | 已关闭 | `sdk/packages/agents/src/agent-runtime.ts:617` |
| Tool calling | validation/timeout/retry/worker pool 完整 | 已关闭 | `sdk/packages/agents/src/agent-runtime.ts:1214` |
| Hooks/Events | 基础完整 | 部分关闭 | `sdk/packages/agents/src/agent-runtime.ts:505`、`:817` |
| Provider 抽象 | Gateway 较丰富 | 部分关闭 | `sdk/packages/agents/src/agent-runtime.ts:55` |
| Tool schema enforcement | Zod 自动、raw schema 显式 validator | 已关闭 | `sdk/packages/shared/src/tools/create.ts:81` |
| Tool timeout/retry contract | 每次尝试强制 timeout；显式 opt-in retry | 已关闭 | `sdk/packages/agents/src/agent-runtime.ts:1572` |
| Context projection | 已有 callback | 部分关闭 | `sdk/packages/agents/src/agent-runtime.ts:1112` |
| Context/token/cost budget | runtime 级 `AgentRunBudget`（input/output/total tokens + cost，pre-request stop gate，`budget_exhausted` 终态 + 结构化 status notice，已进入 durable recovery state） | 已关闭（run 级；session 池化与 context 压缩仍缺） | `sdk/packages/agents/src/agent-runtime.ts`、`sdk/packages/shared/src/agents/types.ts` |
| OTel instrumentation | span 存在 | 部分关闭 | `sdk/packages/agents/src/agent-runtime.ts:579`、`:1368` |
| OTel parent-child tree | 已建立并有 exporter 测试 | 已关闭 | `sdk/packages/core/src/services/telemetry/agent-trace-tree.test.ts` |
| Session persistence | Core 已有 | 已关闭（Core） | `sdk/packages/core/src/session/services/persistence-service.ts` |
| Durable execution | 原子 ledger + lease/in-doubt + 默认工具/restore 接线 | 部分关闭（执行核心已关闭） | `sdk/packages/core/src/runtime/ledger/` |
| Durable HITL | SQLite request/decision/expiry + principal + attach replay + explicit single-tool/sequential-batch resume + turn-level batch cursor + agent identity + conservative daemon startup scan | 部分关闭（delegated/team 与通用 RunState 未闭环） | `sdk/packages/core/src/runtime/approval/`、`sdk/packages/core/src/runtime/continuation/`、`sdk/packages/core/src/hub/server/handlers/approval-handlers.ts` |
| Memory | SQLite + recall tool 存在 | 部分关闭 | `sdk/packages/core/src/memory/` |
| Middleware | idempotency 已默认接线；其他策略仍 opt-in | 部分关闭 | `sdk/packages/core/src/middleware/` |
| Sandbox | Seatbelt/bubblewrap adapter 存在 | 部分关闭 | `sdk/packages/core/src/runtime/sandbox/` |
| Effect ledger | SQLite v2 + middleware + restore 已接线 | 已关闭（执行核心） | `sdk/packages/core/src/runtime/ledger/` |
| Teams patterns | handoff/evaluator helper 存在 | 部分关闭 | `sdk/packages/core/src/session/patterns.ts:147` |
| A2A | v1 HTTP/SSE + 真实首消息/订阅时序 | 核心时序已关闭 | `sdk/packages/core/src/hub/a2a/` |
| Hub | Local baseline + server-issued connection principal + 分层 session ACL | 部分关闭（secret/remote file boundary 缺） | `sdk/packages/core/src/hub/server/hub-websocket-server.ts`、`sdk/packages/core/src/hub/server/browser-websocket.ts`、`sdk/packages/core/src/hub/server/handlers/session-access.ts` |
| Eval | 离线确定性 PR 门禁已接线（case + baseline 钉住契约）；model eval 仍手动 | 部分关闭（PR 层已关闭） | `sdk/packages/core/src/eval/`、`.github/workflows/sdk-test.yml` |

---

## 4. 已关闭或基本关闭的旧差距

## 4.1 Extended tests 已进入 CI

SDK PR CI 已增加 extended-tests job，覆盖 webview、desktop、multi-agent、rollout 和 examples：

- `.github/workflows/sdk-test.yml:114`

这关闭了测试套件未被默认门禁执行的旧问题，但不代表 Agent eval 已进入 CI。

## 4.2 VS Code turn 级连接稳定性

当前已有 transient error 分类、指数退避、time-to-headers 和流失活检测：

- `apps/vscode/src/sdk/sdk-session-lifecycle.ts:20`
- `apps/vscode/src/shared/net.ts:109`

这是宿主连接稳定性，不代表 AgentRuntime tool-level retry。

## 4.3 关键 SDK building blocks 已存在

以下能力已有代码和单元测试，不能再描述为完全缺失：

- OTel agent/tool/llm/hub span。
- Episodic/semantic Memory 与 SQLite store。
- `recall_memory` 工具。
- Retry/Budget/Redaction/Approval middleware。
- Seatbelt/bubblewrap sandbox adapter。
- Effect Ledger、idempotency middleware、recovery helper。
- Handoff/Evaluator patterns。
- A2A v1 JSON-RPC、HTTP、SSE 和 Agent Card。

问题在于默认生产调用点、恢复语义和安全边界尚未闭合。

---

## 5. P0 差距与推进优先级

## P0-1：修复 Agent tracing 父子上下文

### 现状

当前三个主要 span 都使用 `startSpan()`：

- `agent.run`：`sdk/packages/agents/src/agent-runtime.ts:579`
- `agent.tool`：`sdk/packages/agents/src/agent-runtime.ts:1368`
- `llm.request`：`sdk/packages/llms/src/providers/ai-sdk.ts:1158`

但代码没有通过 `context.with(trace.setSpan(...))` 激活新 span。`startSpan()` 会读取创建时的 active context，却不会自动将新 span 设置为 active context。

因此在无外部 context 时，三个 span 可能成为三个独立 root trace；在有外部 `TRACEPARENT` 时，它们可能只是共享 parent 的 siblings。旧整改日志中“agent/tool 子 span”的结论未被当前源码实现证实。

### 目标树

普通 tool-call turn 应为：

```text
external context
└── agent.run
    ├── llm.request
    └── agent.tool
```

嵌套 Agent 场景应为：

```text
agent.run
└── agent.tool
    └── nested agent.run
        └── nested llm.request
```

### 验收标准

1. 外部 active span 的 traceId 被保留。
2. `agent.run.parentSpanId` 指向外部 span。
3. `llm.request.parentSpanId === agent.run.spanId`。
4. `agent.tool.parentSpanId === agent.run.spanId`。
5. 工具内部启动嵌套 Agent 时，nested `agent.run` 继承 tool context。
6. 未注册 TracerProvider 时运行行为不变。

### 状态

**已完成（2026-09-24）。**

- `AgentRuntime.execute()` 使用 `context.with(trace.setSpan(...))` 激活 `agent.run`。
- `executePreparedTool()` 同样激活 `agent.tool`，嵌套 Agent 可继承工具上下文。
- `llm.request` 显式使用当前 active context 作为 parent。
- 新增 exporter-backed 集成测试，验证外部 parent、run/tool sibling 和 nested run 关系。
- 新增真实 OpenAI-compatible SSE 测试，验证 `llm.request` 继承 active span。

---

## P0-2：修复 A2A 真实执行链路

### 修复前现状一：新任务首条消息未可靠启动 run

`A2AServer.sendMessage()` 对新任务只执行 `session.create`，prompt 仅放入 metadata：

- `sdk/packages/core/src/hub/a2a/a2a-server.ts:161`

真实 `session.create` handler 没有用该 prompt 启动 Agent run：

- `sdk/packages/core/src/hub/server/handlers/session-handlers.ts:274`

### 修复前现状二：SSE 订阅时序错误

现有任务的 `session.send_input` 会等待整个 run 完成。A2A 当前先完整执行 `sendMessage()`，再建立事件订阅：

- `sdk/packages/core/src/hub/a2a/a2a-server.ts:269`
- `sdk/packages/core/src/hub/server/handlers/run-handlers.ts:201`

修复前真实 Hub 路径可能错过 `run.started`、delta、tool、approval 和 terminal event；旧测试只覆盖了 run 完成后再手工发布事件的 stub 场景。

### 其他缺口

- `GetTask` 读取真实 `session.get` 不返回的 `pendingApproval`。
- A2A 无审批 continuation RPC。
- Task history/artifacts 不完整。
- Push notifications 尚未实现。
- 标准 detached daemon 默认不启用 A2A。

### 状态

**首消息与流式时序已完成（2026-09-24）。**

- `A2AServer.prepareMessage()` 将新任务拆为 `session.create` 与后续 `run.start`，prompt 不再写入 session metadata。
- `SendStreamingMessage` 仅在 dispatch 阶段准备 task；HTTP 建立 SSE 后，stream marker 先注册 session listener、发送初始 Task，再启动 run。
- `streamTask()` 在发送初始 Task 前完成订阅，并缓存订阅窗口内的事件，避免首个状态更新抢在初始快照之前。
- detached daemon 将自身 `cwd` 作为 trusted `defaultSessionConfig`，外部 A2A metadata 不能选择 workspace。
- JSON-RPC/HTTP 回归验证严格顺序为 `session.create → subscribe → run.start`，run 内同步发布的 start/delta/terminal 事件全部可见。
- A2A `GetTask` 与 `approval.requested` SSE 状态现在携带不含工具输入的审批描述；`SendMessage` 接受唯一的 `Part.data` `cline.approval.decision`，经 `approval.respond` 唤醒 live waiter，并保持重复决策幂等。

仍待后续处理：跨进程/重启后的 A2A continuation、Task history/artifacts、push notifications，以及跨进程事件 replay。

---

## P0-3：落实 AgentTool 执行契约

### 修复前问题

公共工具类型声明：

- `timeoutMs`：`sdk/packages/shared/src/agent.ts:179`
- `retryable`：`sdk/packages/shared/src/agent.ts:180`
- `maxRetries`：`sdk/packages/shared/src/agent.ts:181`

`createTool()` 默认写入 30 秒、可重试、3 次：

- `sdk/packages/shared/src/tools/create.ts:125`

但 AgentRuntime 只执行一次 `tool.execute()`，不读取这些字段。Core 内置工具有自己的 `withTimeout()`，与公共字段并非同一语义。

不能简单默认启用 retry：`createTool()` 当前默认 `retryable=true`，若工具没有幂等键或 effect ledger，自动重试可能重复提交、发布或删除。

### Schema enforcement

当前仅做 JSON 解析和 JSON-looking string 归一化，不验证 required/type/enum/range/pattern。仓库有 Zod helper，但没有可直接用于任意 raw JSON Schema 的通用 validator。

建议扩展 `AgentTool` contract，保留可选输入 validator；Zod 工具在 factory 内校验，第三方 raw JSON Schema 工具通过显式 validator 或 middleware 校验。

### 并行一致性

并行工具使用无界 `Promise.all()`。普通 executor throw 会转为 `isError`，但 `afterTool`、listener 或 `onEvent` 抛错会导致 fail-fast；其他工具继续执行，runtime 可能提前返回失败且遗漏 tool result。

建议：

### 状态

**已完成（2026-09-24）。**

- `AgentTool.validateInput` 成为可选运行时契约；`createTool()` 对 Zod schema 自动生成 validator，raw JSON Schema 可显式提供 validator。
- `timeoutMs` 现在约束每次真实工具尝试，并向工具传递 tool-scoped `AbortSignal`；超时转为模型可见的结构化 tool error。
- `retryable`/`maxRetries` 现在由 runtime 执行，带有可配置初始退避、最大次数和最大延迟；`createTool()` 默认关闭重试，避免未知副作用工具被自动重复执行。
- preparation、hook、listener 或 event 异常会生成对应 tool result；并行批次等待全部调用 settle，并支持 `maxParallelToolCalls` worker pool。
- terminal tool 的成功结果在同批全部工具 settle 后才结束 run，保证每个 tool-call 都有对应 tool-result。

---

## P0-4：Durable execution 与 durable HITL

### Effect Ledger 状态

**Durable execution 核心已完成（2026-09-24）；durable HITL 仍待实现。**

已完成：

- SQLite schema v2 使用 `BEGIN IMMEDIATE` 原子 claim，并加入 owner、lease token、lease expiry、attempt 和 fencing completion。
- 新增 `in_doubt`；pending lease 过期、未知 throw、默认结构化失败和 restore 时的 pending effect 都不会自动重执行。
- 只有显式 `retryable` 工具才可把已证明无副作用的 throw 记为 `failed`；结构化 `success:false`、`isError:true` 和混合失败数组不会记为 succeeded。
- durable key 使用 session、checkpoint-stable run id、iteration、tool、model response 内 call ordinal 和 input hash；不包含 provider tool-call id。restore 后的模型可重新分配 call id，后续 turn 也不会与旧 run 冲突；旧 key 由 middleware 兼容迁移。
- `LocalRuntimeHost` 默认构造并关闭 host-owned SQLite ledger；`SessionRuntimeOrchestrator` 在每 turn 最终工具合并后包装工具，不修改 config 原工具。
- wrapper 已传播到 configured sub-agent、`spawn_agent` 和 team teammate；detached daemon 的 hub session 与 schedule 共用同一 `LocalRuntimeHost`。
- `SessionVersioningService` 在 workspace mutation 和 restored prompt 之前执行 ledger preparation；restore 只导入 checkpoint run 的 succeeded、pending/in-doubt effect，明确 failed effect 才允许重新执行；pre-run-id 数据使用确定性 legacy scope。
- Local 与 Hub restore 共用 execution-host 路径；活动 source session 拒绝 restore；目标 session id 在 client contribution/approval/capability 绑定前确定。
- 覆盖原子并发、lease expiry、fencing、v1 migration、legacy key、structured failure、显式 retry、root/team wrapper、restore 顺序和 replay 集成测试。

当前边界：

- key 依赖恢复后的模型保持相同 iteration、call ordinal 和业务输入；若模型路径发生排序或语义漂移，无法证明是同一逻辑 effect，需要工具/应用提供更稳定的 domain idempotency key。
- durable ledger 防止框架已知路径的重复副作用，但不替代外部 API 自身的 idempotency key。
- sub-agent 已共享 wrapper，且每次 agent run 使用独立 run id；尚未建立可跨 restore 的稳定 agent path，极低概率的跨 agent namespace 冲突仍需后续 durable agent identity 收敛。

### Durable HITL 当前状态

**Approval persistence、单工具 continuation MVP、严格可序列化 RunState v1、保守 daemon startup recovery、turn 级 batch cursor、并行 turn 受控重放与 delegated agent chain 的一致记录/fail-closed 已完成（2026-09-26）；delegated/team 的可恢复 resume 与复杂 A2A RunState 仍待实现。**

已完成：

- `DurableToolApprovalCoordinator` 与 SQLite `approvals.db` 持久化 request、input/policy、durable key、target/requested-by principal、expiry、status、decision reason 和 decided-by。
- LocalRuntimeHost 与 HubServerTransport 共享同一 coordinator；审批响应按 session 与 client principal 校验，决策使用原子 compare-and-set。
- pending 请求在 session attach 时重发给目标 client；abort、run timeout、session delete 和 expiry 会写入终态并唤醒活动 waiter，clean shutdown 则释放 waiter 并保留 pending journal。
- 新增 `continuations.db` journal：记录 assistant-message boundary、prepared input/hash、approval id、phase、owner lease 和 redacted versioned recovery snapshot；snapshot 额外保存 bounded rules/skills/workflows selectors 与 skills allowlist，但不保存 source contents；`LocalRuntimeHost.resumePendingRun` 与 Hub `session.resume` 支持单 root、单审批工具的显式恢复。
- 新增严格 versioned `RunState` v1：continuations schema v3 持久化安全 resume cursor、transcript/config fingerprint 与 bounded reconstruction selectors；不保存 raw input、transcript body、source content、secret、callback 或 process object。显式 resume 优先 RunState，legacy snapshot 仍兼容，identity/transcript drift fail closed。
- Detached daemon 在 schedules/listener 发布前执行 bounded startup scan，仅恢复 stale root、decided、sequential、server-owned built-in tool；A2A 仅在 snapshot 携带稳定 server recovery owner、受信 daemon workspace 且无 team/sub-agent/client contribution 时进入同一保守路径；parallel、missing snapshot 和 uncertain executing record 均保持人工路径。
- Recovery eligibility 现与 runtime 实际可恢复能力对齐：persisted assistant message 含多于一个 tool call 时记为 `parallel_or_ambiguous`；当该 turn 的每个 tool call 都有已决策 continuation 记录时，startup scan 会按 session/run/iteration/assistant message 分组、校验 call ordinal 连续，再经 `LocalRuntimeHost.resumePendingRunBatch` → `AgentRuntime.resumePendingToolBatch` 以持久化顺序重放整个 turn（上限 16）；分组不完整仍保持人工路径。
- Snapshot 与 `RunState` 现记录会话真实 tool execution 模式（由 `maxParallelToolCalls` 派生），不再一律写死 `sequential`；单工具 turn 标为 `eligible`（两种模式重放等价），多工具 turn 需要 turn 级完整证明。
- 每个 tool call 现在带稳定 `stepId`（`step:<runId>:<iteration>:<callIndex>`），贯穿 tool context、approval request、middleware、telemetry 与 Effect Ledger（effect ledger schema v4 新增 `step_id`），使重启后可定位并对账具体 step；`RunState` v1 的 tool_call resume cursor 也持久化该 `stepId`，resume 时校验其与 continuation record 身份一致，防止指向其他 step。
- `RunState` v1 的 resume cursor 扩展为版本化联合类型：`tool_call` 描述单个 pending step，`tool_call_batch` 以有序、无重复、call ordinal 连续的 `steps` 描述整个 assistant turn。host 在 turn 全部 tool call 都已有 durable record 后，把 turn 级 cursor 写到该 turn 最后一条 continuation；turn 未完整时保持 per-step cursor。
- `RunState` 新增可序列化 `agent` 块（`agentId`，delegated run 另含 `parentAgentId`/`rootRunId`，由 `SessionRuntime` 新增的 identity accessor 提供），resume 必须重建同一 agent 身份，否则 fail closed；single-step resume 一个多工具 turn 也会被拒绝。
- Batch resume 现在要求记录的 cursor 恰好覆盖被重放的 continuations（数量、顺序、toolCallId、approvalId、input hash 全部一致），并与 persisted assistant turn 逐项对账（同一 message、相同 tool call 数量、相同顺序）；legacy per-step batch 与单步 resume 也走同一 transcript 形状校验，因此“只重放多工具 turn 的其中一步”会在 claim lease 之前被拒绝。
- 并行 turn 现在受控可恢复：cursor 对 sequential 与 parallel 会话都生成；`buildRecoverySnapshot` 不再把「配置为并行」本身当作不可恢复原因（单工具 turn 两种模式重放等价，标为 `eligible`）；多工具 turn 仍标 `parallel_or_ambiguous`，需要 turn 级完整证明。同时修复 `LocalRuntimeHost` 构建 agent config 时丢弃 `maxParallelToolCalls` 的问题——此前并行模式在 host 路径上根本到不了 runtime，恢复出的并行会话会静默降级为顺序执行。
- 覆盖持久化重开、并发单赢家、过期、abort、错误 client、attach replay、continuation lease/fencing、AgentRuntime resume 与 Hub boundary 测试。
- Delegated/team turn 的 continuation 记录现在身份正确并明确 fail closed（2026-09-26）：`ToolApprovalRequest` 与 `AgentToolContext` 新增可选 `parentAgentId`/`rootRunId`，`AgentConfig`/`AgentRuntimeConfig` 新增 `rootRunId`，`SessionRuntime` 用独立的 `chainRootRunId` 承载链根 run（此前 `getRootRunId()` 恒为 `undefined`），`spawn_agent` 与 configured agent tool 从 tool context 继承链根。continuation record（schema v4 新增 `agent_chain_json`）记录请求方 agent 的 chain，record 的 `agentId`/`conversationId` 取自请求而非 host 的 lead agent；store 校验 chain 的 `agentId` 与 record 一致，且与 `RunState.agent` 的 parent/root 不得漂移。
- 修复 delegated 记录的真实缺陷：此前 host 用 lead agent 的 transcript/system prompt 构造 snapshot，却把子 agent 的 `agentId` 写进 `resume.agentId`，而 record 用 lead 的 `agentId`，产生自相矛盾的恢复状态（只能靠 identity mismatch 偶然 fail closed，且 `requires agent chain recovery` 守卫在真实链路上是死代码）。现在 delegated 请求不写 recovery snapshot/runState，也不持久化 session messages——host 只能看到 lead 的 transcript，任何基于它的恢复状态都会重放错误的 turn——只记录 chain；`assertContinuationResumable` 与 startup scan 显式以 `requires agent chain recovery` 拒绝。

当前边界：

- clean shutdown 会释放活动 waiter 并保留 pending 记录；异常进程终止留下的 pending 记录也可在下次 attach 时恢复并重发。
- Detached A2A sessions use a stable principal derived from the hub owner, data namespace, and trusted workspace; it is persisted only as a server-owned snapshot provenance marker. A random per-process client ID cannot reclaim an approval bound to the previous process. This principal is daemon-scoped, not task-scoped authorization; the existing bearer boundary remains required。
- Daemon startup recovery 只处理带 versioned redacted snapshot 的保守 root/built-in 子集，以及满足稳定 owner/受信 workspace 条件的 A2A root 子集；RunState v1 已提供安全的 resume cursor/config manifest，并在显式恢复时优先于 legacy snapshot；每个 turn/continuation 现在会获取 detached、deeply frozen 的内存 source snapshot，active run 不会观察到中途 source mutation；serverRuntime source selectors 与 aggregate SHA-256 reference 仍只持久化 hash/reference，跨进程恢复在 resume 前重新加载并校验，source content 持久化、复杂配置重建和复杂审批后自动恢复仍未闭环。
- turn 级 batch cursor 只在 server-owned built-in tool 的 root turn 上生成（sequential 与 parallel 都会）；parallel 多工具 turn 仍需 turn 级完整证明才可重放，且重放保持并行语义。
- 并行重放当前只覆盖 root turn；并行 turn 中“部分工具已执行、其余未执行”的场景依赖 Effect Ledger 的 succeeded/in-doubt 语义，尚未用真实外部副作用的多进程测试验证。
- `agent` 块现在由 durable `agentChain` 交叉校验，但仍未驱动 delegated/team run 的自动恢复：带 `parentAgentId` 的 continuation 会被显式 resume 与 startup scan 拒绝（`requires agent chain recovery`），sub-agent 与 team 仍走人工路径。真正的阻塞点是子 agent 的 transcript 在审批时刻没有任何 durable 落点——`TeamChildSessionManager` 只在 `handleSubAgentEnd` 写子会话，审批中途不写，因此 delegated resume 需要先把子 conversation（含审批边界）在审批时持久化，再重建父 agent 链与子 agent 工具集。
- 链根 run id 现在可稳定传播，但 depth ≥ 2 的 delegated 链只携带 root run 与直接 parent，中间层 agent 仍不可重建；`getRootRunId()` 语义已从「首个 run id」改为「链根 run id」，依赖旧语义的调用点需重新确认。
- 当前进程级 e2e 使用确定性的 fake leaf agent 验证 root 与 A2A seed/recover 子进程边界；外部工具副作用幂等仍未验证。
- `executing` continuation 默认拒绝自动 reclaim，只有显式 `reclaimExecuting: true` 才能进入人工恢复路径。
- A2A 已能将 approval 映射为 input-required，并通过结构化 `approval.respond` 唤醒 live continuation；保守的跨进程/重启恢复已闭环，复杂 A2A RunState 仍未闭环。
- 若审批决定发生在 daemon 重启之后，Hub approval boundary 会触发一次 bounded、session-scoped 恢复 scan，并继续复用 continuation lease/fencing。

### 下一步

1. 让 delegated turn 真正可恢复：把子 agent 的 conversation（含审批边界 assistant message）在审批时刻持久化到子会话，重建父 agent 链与子 agent 工具集，并让 resume 以 `agentChain` 校验链完整性；跨进程 source content 持久化仍不在当前范围内。
2. 扩展 A2A approval continuation 到复杂 server-owned RunState、非 root/多 agent 之外的受控配置与重复响应恢复。
3. 为 depth ≥ 2 的多 agent 路径补齐中间层 agent identity 的持久化与对账（当前只记录 root run 与直接 parent）。
4. 扩展真实多进程 crash/restart 测试到工具副作用与重复执行幂等验证，包含并行 turn 的部分执行场景。


---

## P0-5：Hub 远程与多客户端安全

本地单用户基线已有 loopback 默认绑定、随机 token、owner-only discovery file 和 timing-safe token comparison。

**Connection principal 已关闭（2026-09-26）**：websocket upgrade 认证的是连接，但每个 command envelope 自带 `clientId` 且全链路按它鉴权。现在每条被接受的 socket 在 upgrade 时获得不可猜测的 `connectionId`，`BrowserWebSocketHubAdapter` 把它绑定到首个成功注册的 client identity：此后未注册连接只能发 `client.register`（`hub_unregistered_client`），冒用其他 identity 被拒（`hub_client_id_mismatch`），省略 `clientId` 的命令由服务端回填已绑定 identity，`stream.subscribe`/`unsubscribe` 同样受限。`connectionId` 以服务端所有权 provenance 记录在 client record 上（`metadata.connectionId`，不可被客户端伪造），`client.register` 因此拒绝把活跃 identity 交给第二条连接（`hub_client_id_taken`）；原连接已消失的 identity 可被重连回收，避免异常断开永久锁死。进程内调用（A2A mount、测试）不提供 connection id，保持受信。

**新发现的高危缺口（已按分层 ACL 关闭，2026-09-26）**：session ACL 几乎不存在。`createdByClientId` 与 `participants` 早已建模，但此前只有 `session.compaction.get` / `session.compaction.update` 两个 handler 真正校验 owner；以下 session 级命令**没有任何 owner/participant 校验**，任何已注册 client 均可调用：

- 破坏性：`session.delete`（可删除他人 session）、`session.resume`、`session.update`、`session.update_connection`、`session.compaction.*`、`session.update_pending_prompt`、`session.remove_pending_prompt`
- 运行控制：`run.start` / `session.send_input`、`run.abort`、`session.restore`、`session.hook`
- 读取：`session.get`、`session.messages`、`session.pending_prompts`、`session.attach`

现在授权收敛为 `hub/server/handlers/session-access.ts` 的单一命令表，在 `dispatchCommand` 分发前统一校验，handler 不再各自为政（compaction 的重复检查已删除）。分层语义：`own` = 仅 owner（破坏性、长期存活、或把 session 重新指向别的 workspace/provider 的命令）；`write` = owner 或 `participant`（驱动执行）；`read` = 任何有身份的 client（保留跨端观察）。两条关键不变量：

- **attach 永不授权**：`session.attach` 只把调用者登记为 `observer`，因此无法靠 attach 提权到 write，也不会顺带拿到 capability ownership；ownership 只能由 `session.create` 产生。（实现时我曾尝试「attach 认领无主 session」以覆盖 daemon 重启后 owner 丢失，但既有测试 `does not grant compaction sidecar ownership from session attach` 证明这是刻意设计的不变量，已回退。）
- **ownership 只存在于内存 live state**：session metadata 客户端可写，持久化的 owner 声明可被重放，因此 ownership 只在 `ctx.sessionState`。daemon 重启导致 state 丢失的 session 没有可证明的 owner：读保持开放、写被拒，客户端需通过 `session.create` 重新确立权限。

无 `clientId` 的 envelope 视为进程内调用（A2A mount、内部 handler）；远端连接无法走到该分支，因为 connection principal 拒绝未注册命令并为转发帧回填已绑定 identity。

**Remote userFiles containment 与凭据统一脱敏已关闭（2026-09-26）**：

- `userFiles` 来自客户端，此前 `loadUserFileContent` 直接 `readFile(path)`，等于把 daemon 可读的任意路径（包括 `/etc/shadow`、SSH 私钥）注入模型上下文。现在 containment 落在**读的那一层**，由 host 用 session `workspaceRoot` 注入 loader；检查对两侧都做 `realpath`，因此同时挡住 `..` 穿越、外部绝对路径，以及**工作区内指向外部的符号链接**（仅做词法检查挡不住这一种），经符号链接到达的工作区根也能正确比较。拒绝以 `UserFileOutsideWorkspaceError` 与「文件不存在」区分，并降级为单个文件的 `Error fetching content` 块而不是让整轮失败；不提供 root 的调用方保留原有不受限行为。
- 凭据脱敏改为在**广播收口处**执行，而不是逐个字段审计（逐字段审计正是泄漏反复出现的原因）：`HubServerTransport.publish`（所有事件 payload）、session record 投影（metadata 与 system prompt）、client registry 投影（`client.list` 的 metadata）。双重机制：credential 语义的 key 整体遮蔽（不依赖识别密钥形状），自由文本再扫描 `Bearer …`、`key=value` 与已知厂商密钥形状。只脱敏投影，不改持久化内容也不改 provider 请求，因此不可能弄坏调用；class 实例直接丢弃而非枚举，深度与数组长度有界，事件寻址字段（事件名、id、sessionId）不属于数据故原样透传。`isCredentialKey` 刻意放过 `tokenBudget` / `secretCount` / `maxTokens` 这类形近键。

仍缺少：

- Server-issued connection principal。**（已完成）**
- Session owner/participant/observer/admin 统一 ACL。**（已完成 read/write/own 三档；`admin` 角色与 owner 主动把 observer 提升为 participant 的通道尚未实现——当前 attach 只会授予 observer，跨 client 协作写仍不可达）**
- TLS/mTLS、OAuth scope、tenant identity。
- A2A task-scoped credential。
- Remote userFiles 的 workspace containment。**（已完成）**
- Credential projection 的统一脱敏。**（已完成事件/session record/client registry 三处收口；尚未覆盖 A2A SSE 之外的 `session.messages` 正文与 `capability.request` payload 的端到端 secret 扫描测试）**

此项目前是 Hub/Remote/Connector 公开部署的阻断项，但不等同于本地嵌入模式全部不可用。

---

## 6. P1 能力差距

## 6.1 Middleware 默认接线

`wrapToolsWithMiddleware()` 已在 `SessionRuntimeOrchestrator` 的最终工具集合处接入，当前默认链包含 Effect Ledger idempotency middleware，并传播到 sub-agent/team。

剩余缺口：approval/retry/budget/redaction 仍未全部进入默认链；wrapper 还没有把 `toolPolicies` 投影为 middleware policy，middleware denial 也未统一映射为 `AgentToolResult.isError`。

## 6.2 Memory 默认产品语义

已有 episodic/semantic SQLite store 和 `recall_memory`，但没有默认 store 注入、agent-facing write/consolidation、procedural memory、vector 或托管后端。

长期记忆仍是 building block，不是默认产品能力。

## 6.3 Sandbox 默认隔离

已有 Seatbelt/bubblewrap 和 fail-closed adapter，但默认 built-in tools 仍使用 stock executor。Windows 没有进程沙箱；Docker/E2B 尚无 adapter；file/editor/MCP 子进程不在当前 shell sandbox 范围内。

## 6.4 Context 与成本治理

Run 级成本治理已关闭（2026-09-26）：`AgentRuntimeConfig.budget`/`AgentConfig.budget`/`SessionPromptConfig.budget` 提供 input/output/total token 与 cost 上限，runtime 在每次模型请求前做 stop gate，达到上限的 run 先完成当前 turn（保证每个 tool call 都有 tool result）再以 `budget_exhausted` 受控结束，并发出结构化 status notice；上限在构造时严格校验（0/负数/非有限/未知字段直接失败，避免静默退化为无上限），`budget_exhausted` 不参与 team auto-continue，budget 也写入 durable recovery state 使重放保持同一条 guardrail。

仍缺少：

- **Budget 是 per-run 而非 per-session**：一次 session 的多轮 run 各自拥有完整预算；没有跨轮次的累计，也没有 session/cron 级的持久化上限。
- **子 Agent/MCP 预算未池化**：delegated agent 各自继承不到父级预算，也没有共享计数器；把同一份上限下发给 N 个子 Agent 等于把预算放大 N 倍。
- **Context 压缩仍由宿主实现**：`prepareTurn` 是唯一入口，runtime 本身不做截断/摘要。
- 缺少 tool output trimming、历史 retention 与 context window 预留策略。

## 6.5 Multi-agent 治理

Teams、spawn、handoff/evaluator helper 已存在，但没有默认 orchestration pattern，也没有统一强制子 Agent 继承父级权限、预算、租户、trace 和 cancellation context。

## 6.6 自动评测

**PR 确定性门禁已建立（2026-09-26）**。model-based smoke test 需要真实 provider，因此无法 gate PR：慢、fork 没有 secret、每次结果还会漂。缺的那一层是**离线确定性**的行为门禁，现已补上：

- `sdk/packages/core/src/eval/agent-conformance.ts` 是 case 注册表，每个 case 用 scripted model 断言一条行为保证，并标注所属边界（`runtime-contract` / `spend-governance` / `tool-contract` / `hub-authorization` / `file-boundary` / `projection-boundary`），便于审计时按边界归类。
- `conformance-baseline.json` 用 `id + boundary + guarantee` 钉住契约。**删掉或改名一个 case 会让门禁变红**——这正是回归门禁唯一不能有的失败模式（悄悄删测试让 CI 变绿）。扩大契约必须显式改这个文件。
- 门禁无 flake：不联网、不用 secret、没有时钟敏感断言，所以红了就信，不必重跑。
- 已接线为 `sdk-test.yml` 的 `agent-conformance` job（PR + push，`needs: quality-checks`），本地用 `bun run test:conformance`。因为同级包通过 `dist/` 解析，job 会先 `build:sdk`。
- 已用「故意删掉一个 case」验证过门禁真的会红（`pins every registered case and nothing else` + 同步性检查双失败），随后恢复。

当前 case：tool-result 完整性（单工具与并行批次）、稳定 stepId、budget 达上限后不再发下一次模型请求且当前 turn 的 tool result 仍在、无 budget 时不误伤、delegated agent 上报 parent/rootRunId、lead agent 不上报 chain。

**nightly model eval 层已建立（2026-09-26）**。契约与 PR 门禁刻意相反：

| | PR 门禁 | nightly model eval |
|---|---|---|
| 触发 | 每个 PR | `schedule`（03:17 UTC）+ 手动 |
| 模型 | 无（scripted） | 真实 provider |
| secret | 不需要 | `CLINE_API_KEY` |
| 度量 | 行为不变量 | 行为质量、pass@k |
| 是否 gate PR | **是** | **否** |

- 新增 `.github/workflows/cline-evals-nightly.yml`：以 3 trials 跑 live provider，使 pass@3 成为真实数字；`concurrency` 串行化，避免长跑与下一次重叠而使趋势不可比。
- **刻意不由 `pull_request` 触发，也不是 required check**，因此 provider 波动不可能让 PR 变 flaky。
- **scenario 失败按数据记录，不按构建失败处理**：run 为 `continue-on-error`，报告始终写入 job summary 并作为 artifact 上传（保留 90 天），job 报 warning。
- **本层刻意不设 pass-rate 阈值**。「什么算回归、在什么 pass@k 上算回归」属于待决策的 release gate 口径；每晚产出可比数据正是为了让那个决策以后有依据。
- 仍会硬失败的是「跑不起来」：canonical 仓库缺 `CLINE_API_KEY` 直接 `::error::`，否则一个已经无法认证的 nightly 看起来和健康的一样。fork 拿不到 secret 时用 notice 跳过，而不是每晚永久变红。
- 手动运行入口保留：`cline-evals-smoke.yml`（仅 dispatch）与 nightly 的 `workflow_dispatch`。

仍缺少：

- **dataset regression 与 baseline threshold**：需要 nightly 先积累一段稳定的 pass@k 历史。
- **production trace sampling → release gate 闭环**。

---

## 6.7 审计口径：代码保证 vs 待决策保证

为避免「已实现」与「已决定」混为一谈，本文的完成状态按下面两类记录：

**A. 代码强制保证（已实现且有负向测试）**——不依赖任何产品决策，删掉即测试变红：

- connection principal：未注册连接、冒用 identity、跨连接抢占 identity、订阅冒用均被拒；重连可回收；provenance 不可被客户端伪造。
- 分层 session ACL：read/write/own 单表前置校验；observer 只读；attach 不可提权；live state 丢失后写被拒、读仍开放。
- userFiles workspace containment：`..`、外部绝对路径、工作区内符号链接逃逸均被拒；仅脱敏投影不改持久化。
- 凭据三处收口脱敏：事件 payload、session record、client registry。
- run budget：pre-request stop gate + 非法上限构造期失败 + 排除 team auto-continue。
- durable HITL：delegated turn 身份正确且 fail closed。

**B. 待决策/待基础设施保证（明确未实现，不做假设）**：

- `admin` 角色、owner 主动把 observer 提升为 participant 的通道——因此 `write` 档目前只有创建者可达。
- TLS/mTLS、OAuth scope、tenant identity、A2A task-scoped credential。
- 跨进程 delegated resume（阻塞点：审批时刻子 conversation 无 durable 落点）。
- budget 的 session 级累计与子 Agent 预算池化（当前 per-run；把同一上限下发给 N 个子 Agent 等于放大 N 倍）。
- Sandbox 默认隔离、MCP 协议版本对齐。
- eval 的 dataset regression threshold 与 release gate 口径（PR 门禁与 nightly 层已就位）。

---

## 7. 协议状态

## MCP

当前 Core MCP client 固定协议版本：

- `sdk/packages/core/src/extensions/mcp/client.ts:41`：`2024-11-05`

截至 2026-09，官方最新正式规范为 `2026-07-28`。需要逐步补齐：

- OAuth 2.1 hardening。
- Elicitation。
- Progress/cancellation。
- Tasks。
- Version negotiation 与 extension 降级。

## A2A

A2A v1 方法、Agent Card、HTTP/SSE 代码已存在，但真实执行链路和默认启用仍有断点。当前应标记为“协议适配器存在，生产链路未完全闭环”，而不是“已完成”。

## AG-UI

当前没有正式 AG-UI adapter。Hub/WebSocket 私有事件词汇表已冻结，但 UI 互操作尚未实现。

---

## 8. 测试成熟度

当前 AgentRuntime 有 61 个测试，核心正向 loop 覆盖较好。明显缺口包括：

- 真实 provider streaming contract。
- 浏览器构建与运行。
- 同实例并发 run。
- Hook/listener/telemetry 对非工具事件的故障隔离。
- Durable HITL 的复杂/通用 RunState、serverRuntime source content 持久化、真实多进程工具副作用与重复执行恢复。
- Hub client identity/session ACL。
- Prompt injection、secret exfiltration、path traversal。
- 自动 eval regression gate。

---

## 9. 分阶段路线图

## Phase A：低风险可观测性修复（已完成）

1. 修复 `agent.run` 和 `agent.tool` active context。
2. 增加 exporter-backed trace tree 集成测试。
3. 验证外部 traceparent、llm.request 和 tool span 父子关系。
4. 保持模型、工具、消息历史行为不变。

## Phase B：工具可靠性基础（已完成）

1. 明确 timeout/retry 的公共语义。
2. 禁止无幂等保障的默认自动重试。
3. 增加 tool validator contract。
4. 修复并行工具 fail-fast、并发上限和 tool-result 完整性。
5. 明确 terminal tool 在完整批次 settle 后结束 run。

## Phase C：Durable execution（执行核心已完成）

1. 原子 ledger claim + lease + fencing。
2. 工具集合默认包装并传播到 sub-agent/team。
3. SessionVersioningService recovery 接线。
4. Durable approval + 显式单工具 resume MVP + 保守 daemon startup recovery + bounded serverRuntime source policy + 内存 immutable per-run source snapshot + 严格 RunState v1（tool_call/tool_call_batch 联合 cursor、turn 级 batch cursor、可序列化 agent 块）+ 并行 turn 受控重放与 host 侧执行模式透传 + delegated agent chain 的稳定身份传播与一致记录/fail closed（delegated/team 可恢复 resume 待办）。
5. 真实多进程 crash/restart 基础已覆盖；继续验证外部工具副作用与重复执行。

## Phase D：A2A 真实链路（首消息与时序已完成）

1. 首条消息启动 run。
2. 先订阅后执行或事件 replay。
3. Approval continuation（live structured decision 与保守跨进程恢复已完成；复杂 RunState 待办）。
4. Task history/artifacts。
5. 默认 daemon 暴露策略与 task-scoped auth。

## Phase E：生产安全与评测

1. Hub principal/RBAC/session ACL。
2. Secret projection 脱敏。
3. Remote file/network containment。
4. Docker/E2B sandbox。
5. dataset regression threshold / release gate 口径（PR + nightly 两层已就位）。

---

## 10. 当前推进记录

| 优先级 | 项目 | 状态 | 验收门 |
|---|---|---|---|
| P0-1 | Agent tracing active context | 已完成 | run/tool/nested/llm trace tree 测试通过 |
| P0-2 | A2A 首消息/SSE/审批入口 | 已完成（核心时序与 live approval ingress） | create→subscribe→run、结构化 approval decision/status projection 测试通过 |
| P0-3 | Tool timeout/retry/schema/parallel | 已完成 | validation/timeout/retry/worker-pool/terminal-batch 测试通过 |
| P0-4 | Ledger/restore/durable HITL | 进行中（execution、approval persistence、单工具 resume MVP、保守 root/A2A startup recovery、bounded serverRuntime source policy/reference、内存 immutable per-run source snapshot、严格 RunState v1（tool_call/tool_call_batch 联合 cursor + 可序列化 agent 块）、并行 turn 受控重放（含 host 侧 `maxParallelToolCalls` 透传修复）、真实 seed/recover 子进程测试与 delegated agent chain 身份传播/一致记录/fail closed 完成，delegated/team 可恢复 resume 与复杂 A2A RunState 待办） | continuation snapshot/lease、RunState codec/store、AgentRuntime resume、Hub session.resume、daemon scan、source reference/drift、mid-run source freeze、turn 级 batch cursor 构建与 transcript/agent drift 拒绝、并行 eligibility/cursor/重放与单步拒绝、root/A2A process-level e2e、agent chain 传播（tool context/approval request/delegated config）与 delegated 记录/拒绝测试已通过；仍需 delegated/team resume、复杂 A2A、外部副作用验证 |
| P0-5 | Hub ACL/secret/file boundary | 进行中（connection principal + 分层 session ACL + userFiles containment + 凭据三处收口脱敏已完成；admin/协作提升、TLS/mTLS、tenant identity 待办） | connection principal：spoof / 未注册 / 订阅冒用 / identity 抢占 / 重连回收 / provenance 不可伪造测试通过；session ACL：命令表分类与四种角色授权矩阵、attach 不可提权、state 丢失后写被拒读仍开放测试通过；file boundary：9 项 containment（含符号链接逃逸）+ host 注入验证通过；redaction：13 项单测 + 3 处收口集成验证通过 |
| P1-4 | Context/成本治理 | run 级 budget 已完成；session 累计、子 Agent 池化与 context 压缩待办 | budget stop gate/终态/notice、非法 budget 拒绝、RunState budget round-trip、team auto-continue 排除测试通过 |

验证记录：

- `@cline/shared`：240/240 通过。
- `@cline/agents`：61/61 通过。
- `@cline/llms`：415 通过、4 跳过。
- P0-4 ledger/runtime/restore 聚焦套件：178/178 通过。
- Durable approval/continuation/recovery/local/Hub 聚焦套件：119/119 通过；snapshot/store reopen、startup ordering、stale-root preflight、stable owner 和 shutdown tracking 均覆盖。
- A2A JSON-RPC/SSE/server 与 Hub boundary 聚焦套件：120/120 通过；结构化审批 decision、轮询/SSE 脱敏描述、workspace containment 和 `approval.respond` 路由均覆盖。
- Durable/RunState/source/A2A 聚焦套件：238/238 通过、2 跳过；strict RunState codec、v2→v3 migration、state drift rejection、state-first resume、legacy fallback、source snapshot freeze、source drift 与 A2A boundary 均覆盖。
- RunState codec/store/host 子聚焦套件：22/22 通过；process DB sentinel 已验证 state_json 不含工具输入路径。
- Turn 级 batch cursor 轮次（2026-09-26）：continuation/approval/host 聚焦套件 156/156 通过；host+orchestration 聚焦套件 285/285 通过；Hub 聚焦套件 273/273 通过。覆盖 batch codec 联合类型（重复/非连续/超限/未知字段）、agent 块校验、per-step→turn 级 cursor 升级、batch 覆盖与 transcript/agent drift 拒绝、single-step 拒绝、startup scan 对漂移 turn 的 skip。
- 并行 turn 受控重放轮次（2026-09-26）：host+continuation 聚焦套件 152/152、host+continuation+hub 426/426 通过；core 全量 1689 通过、7 跳过（仅既有 `hook-file-hooks` shebang 用例在并发下 30 秒超时，隔离重跑通过）。新增覆盖：并行单工具 turn 的 `eligible` eligibility 与模式保留、并行多工具 turn 经真实审批路径生成 turn 级 cursor、并行单工具 resume 成功并保留 `maxParallelToolCalls`、并行多工具 batch 重放、多工具 turn 单步 resume 在 claim lease 前被拒、delegated agent block 的 fail-closed。
- Core 全量：1693 通过、7 跳过；仅既有 `hook-file-hooks` shebang 用例在并发下触发 30 秒超时，隔离重跑 12/12 通过。本轮 batch cursor 与 RunState 聚焦测试均通过。
- Delegated agent chain 轮次（2026-09-26）：team/continuation/runtime 聚焦套件 451/451 通过；`@cline/shared` 240/240、`@cline/agents` 65/65 通过；core 全量 1695 通过、7 跳过（同一既有 `hook-file-hooks` shebang 并发超时，隔离重跑 12/12 通过）；core e2e 5/5 通过。新增覆盖：tool context 与 approval request 携带 `parentAgentId`/`rootRunId`（lead agent 时省略）、`chainRootRunId` 与首个 run id 分离、spawn/configured agent 从 tool context 继承链根、continuations schema v3→v4 migration 与 `agent_chain_json` round-trip、chain 与 record/RunState 的 identity drift 拒绝、delegated 请求只记录 chain 且不写 snapshot/runState、不持久化 session messages、delegated continuation 被显式 resume 与 startup scan 拒绝。
- Run 级 budget 轮次（2026-09-26）：`@cline/shared` 240/240、`@cline/agents` 69/69 通过；core 全量 1703 通过、7 跳过（同一既有 `hook-file-hooks` shebang 并发超时，隔离重跑 12/12 通过）；core e2e 5/5 通过；`bun run types` 通过。新增覆盖：达到 token 上限后不再发起下一次模型请求且当前 turn 的 tool result 仍然完整、`status-notice` 带 limit/cap/used、token cap 之上限内继续运行、cost cap 独立于 token cap 生效、非法 budget（0/负数/NaN/未知字段）在构造时失败、RunState budget round-trip 与畸形 budget 拒绝、`budget_exhausted` 映射到 legacy finish reason 且不参与 team auto-continue、config builder 透传 budget。
- Hub connection principal 轮次（2026-09-26）：hub 聚焦套件 286/286 通过；core 全量 1716 通过、7 跳过（同一既有 shebang 并发超时）；core e2e 5/5 通过；`bun run types` 通过；browser-websocket 与 client-handlers 定向 Biome 通过。新增覆盖：未注册连接发任意命令被拒、注册后冒用其他 clientId 被拒、省略 clientId 时由服务端回填已绑定 identity、以他人身份订阅被拒、以绑定身份订阅成功且 close 时自动 unregister、unregister 后需重新注册、两条活跃连接抢占同一 clientId 被拒、重连回收已断开连接的 identity、客户端无法覆盖服务端所有权 provenance、进程内注册保持受信。既有两条 websocket 超时用例已按「先注册再发命令」的新契约更新。
- Hub session ACL 轮次（2026-09-26）：hub 聚焦套件 301/301 通过（新增 session-access 15 例）；core 全量 1731 通过、7 跳过（同一既有 shebang 并发超时，隔离重跑 12/12 通过）；core e2e 5/5 通过；`@cline/shared` 240/240、`@cline/agents` 69/69 通过；`bun run types` 与 `sdk/packages/core/src/hub/server` 定向 Biome 通过。新增覆盖：role 解析（creator/participant/observer/stranger/无 state）、命令表三档分类、非 session 命令不参与鉴权、owner 全通过、observer 任何写/删被拒但读通过、participant 可驱动 run 但不可重配/删除/恢复、未 attach 的 client 被拒且错误信息区分「未 attach」与「角色不足」、live state 丢失后写被拒读仍开放、无 clientId 视为进程内调用、无 sessionId 时交由 handler 报错、attach 无法提权。既有 boundary 用例按新前置条件补上 `ownSession(...)` 以继续测试各自原本的行为；compaction 的重复 owner 检查已删除，收敛到单一命令表。
- Hub file/credential 边界轮次（2026-09-26）：core 全量 1759 通过、0 跳过、0 失败（本轮既有 shebang 并发超时也未复现）；core e2e 5/5；`@cline/shared` 240/240、`@cline/agents` 69/69；`bun run types` 通过；`sdk/packages/core/src/hub/server` 与 `src/runtime/host/local` 定向 Biome 通过；boundary 40/40。新增覆盖：userFiles 允许工作区内相对/绝对路径、拒绝 `..` 穿越、拒绝外部绝对路径、拒绝「工作区内符号链接指向外部」、拒绝穿越后回到绝对段、缺失文件保持普通读失败而非策略拒绝、工作区内目录/二进制仍被拒、无 root 时保留原行为、经符号链接到达的工作区根两侧都正确、host 注入的 loader 确实拒绝外部路径；脱敏侧覆盖 key 识别与形近键豁免、`Bearer`/`key=value`/厂商密钥形状遮蔽、嵌套结构与数组内脱敏、自由文本内嵌密钥、标量与 null 保留、class 实例丢弃、深度与数组长度有界，以及三处收口的集成验证（publish 事件 payload、`client.list` metadata、`session.get` 的 metadata 与 system prompt）与非凭据字段原样透传。
- Core e2e：5/5 通过（含 root/A2A 真实 seed/recover 与 A2A source-drift 子进程）。
- `bun run types` 通过。
- 本轮相关文件定向 Biome 与 `git diff --check` 通过。
- 仓库级 `bun run check` 仍被 30 个既有 Biome 格式/导入问题阻断；本轮涉及文件已定向整理，未批量改动无关文件。

---

## 11. 参考资料

- OpenAI Agents SDK HITL：<https://openai.github.io/openai-agents-python/human_in_the_loop/>
- LangGraph persistence：<https://docs.langchain.com/oss/python/langgraph/persistence>
- Google ADK resume：<https://adk.dev/runtime/resume/index.md>
- Microsoft Agent Framework checkpoints：<https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints>
- Claude Agent SDK overview：<https://code.claude.com/docs/en/agent-sdk/overview>
- A2A v1.0：<https://a2a-protocol.org/v1.0.0>
- MCP 2026-07-28：<https://modelcontextprotocol.io/specification/2026-07-28>
- OpenTelemetry GenAI semantic conventions：<https://github.com/open-telemetry/semantic-conventions-genai>

---

## 12. 结论

Cline 当前不是“功能少”，而是“已有大量 building block，但默认生产链路和执行保证不足”。

最合理的推进原则是：

1. Tracing 已真实可信。
2. 工具执行契约和 durable execution 核心已关闭。
3. Durable approval persistence 与 root turn 的可恢复 RunState（含顺序/并行多工具 turn 的 batch cursor 与执行模式保持）已完成；delegated/team 的记录侧已身份正确并 fail closed，下一步是可恢复 resume。
4. A2A 核心首消息/订阅时序与 live approval ingress 已关闭，后续补跨进程 approval continuation。
5. Run 级 token/cost budget 已进入 runtime 默认契约；下一步是 session 累计与子 Agent 预算池化、context 压缩。
6. Hub 的 connection principal、分层 session ACL、userFiles containment、凭据三处收口脱敏已由代码强制；剩余项（admin/协作提升、TLS/mTLS、tenant identity、A2A task-scoped credential）属产品/基础设施决策，已在 6.7 单列而非按假设实现。
7. 最后补齐自动评测的 dataset regression threshold 与 release gate 两层（nightly 与 PR 门禁已就位）。

每一步均应保持小提交、可独立回退，并以负向测试和集成测试作为完成标准。
