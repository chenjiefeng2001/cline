# Hub/Webview 事件词汇表 v1 冻结 + →A2A/AG-UI 映射草案

> 日期：2026-08-26 · 对应：`doc/architecture-gap-analysis-vs-mainstream-agents-2026-08.md` 路线图 **P0-3**（差距 D3：协议面单向——只进不出）
> 性质：**纯文档**，零代码变更。目的是冻结 v1 词汇表防漂移，并为 P2（hub 暴露 A2A server / AG-UI 适配评估）铺路。
> 事实来源：词汇表取自代码（路径见 §6 锚点）；→A2A/AG-UI 映射为**方向性草案**，外部协议细节（事件名/方法名/状态机）在 P2 实现前必须对照当期官方规范重新核验（附录见差距分析报告 §8）。

---

## 1. 执行摘要

1. **冻结范围（v1）**：hub 命令词汇表 70 个（`HubCommandName`）、hub 事件词汇表 48 个（`HubEventName`）、webview protobus 服务面 16 个 proto 文件。三者均为私有协议词汇，v1 起**只增不改**。
2. **映射草案结论**：hub 会话总线与 A2A 的 Task 生命周期**天然同构**（session/run/approval ↔ task/working/input-required），是 P2 最小成本接入点；AG-UI 侧 hub 事件流已覆盖其核心事件集的约 70%（RUN/TEXT/TOOL/STATE 四类），缺口在 HITL 审批（AG-UI 无原生事件，需 CUSTOM 约定）与 STATE_DELTA 细粒度增量。
3. **漂移规则**：新增命令/事件允许（配合 `MAX_CLIENT_HUB_PROTOCOL_VERSION` 递增保持向后兼容），但**必须同时在 §3/§4 映射表登记拟对应的 A2A/AG-UI 条目**；重命名、删除、语义变更一律要求 v2。

---

## 2. 词汇表冻结范围（v1）

### 2.1 Hub 命令词汇表（`HubCommandName`，70 个）

| 族 | 命令 |
|---|---|
| client | `client.register` `client.update` `client.unregister` `client.list` |
| account / prompts / catalog | `cline.account.get_current` `prompt_commands.list` `prompt_commands.execute` `mention_files.search` `catalog.list` |
| session（19） | `session.list` `session.create` `session.attach` `session.detach` `session.get` `session.messages` `session.restore` `session.delete` `session.update` `session.update_connection` `session.compaction.get` `session.compaction.update` `session.pending_prompts` `session.update_pending_prompt` `session.remove_pending_prompt` `session.fork` `session.hook` `session.send_input` |
| run（2） | `run.start` `run.abort` |
| approval（2） | `approval.request` `approval.respond` |
| capability（3） | `capability.request` `capability.progress` `capability.respond` |
| peer（5） | `peer.register` `peer.list_sessions` `peer.attach_session` `peer.detach_session` `peer.proxy_command` |
| schedule（12） | `schedule.create` `schedule.list` `schedule.get` `schedule.update` `schedule.delete` `schedule.enable` `schedule.disable` `schedule.trigger` `schedule.list_executions` `schedule.stats` `schedule.active` `schedule.upcoming` |
| settings（4） | `settings.list` `settings.get` `settings.patch` `settings.toggle` |
| connector（3） | `connector.channels` `connector.configure` `connector.delete_config` |
| cron（4） | `cron.event.ingest` `cron.event.list` `cron.event.get` |
| ui（2） | `ui.notify` `ui.show_window` |

### 2.2 Hub 事件词汇表（`HubEventName`，48 个）

| 类别 | 事件 |
|---|---|
| hub 生命周期 | `hub.client.registered` `hub.client.disconnected` `hub.client.updated` |
| session | `session.created` `session.updated` `session.attached` `session.detached` `session.forked` `session.pending_prompts` `session.pending_prompt_submitted` `session.notice` |
| run | `run.started` `run.heartbeat` `run.aborted` `run.completed` `run.failed` |
| iteration | `iteration.started` `iteration.finished` |
| 流式内容 | `assistant.delta` `assistant.finished` `reasoning.delta` `reasoning.finished` |
| agent / 用量 | `agent.done` `usage.updated` |
| 工具 | `tool.started` `tool.updated` `tool.finished` |
| 审批 | `approval.requested` `approval.resolved` |
| capability（反向调用） | `capability.requested` `capability.resolved` |
| 多智能体 | `team.progress` `artifact.created` `diff.created` `spoke.started` `spoke.failed` `spoke.stopped` |
| peer | `peer.registered` `peer.session_attached` `peer.session_detached` |
| schedule | `schedule.created` `schedule.updated` `schedule.deleted` `schedule.triggered` `schedule.execution_completed` `schedule.execution_failed` |
| 设置 | `settings.changed` |
| ui | `ui.notify` `ui.show_window` |

### 2.3 Webview protobus 服务面（16 个 proto 文件）

`account` `browser` `checkpoints` `commands` `file` `hooks` `marketplace` `mcp` `models` `oca_account` `remote_config` `slash` `state` `task` `ui` `web` `worktree`（`proto/cline/*.proto`；gRPC 式 service/method 面 + state 快照推送）。

> 注：protobus 是 webview-ui ↔ 扩展宿主协议，与 hub 协议是**两套独立词汇**。P0-3 将两者一并冻结，但 AG-UI 适配层（若做）应挂接 hub 事件流而非 protobus——hub 是多客户端总线，protobus 是单宿主表面。

---

## 3. →A2A 映射草案（P2 依据，方向性）

A2A 核心对象：Agent Card（能力/技能声明）、Task（生命周期状态机）、Message（user/agent + parts）。hub 与之的对应关系：

| A2A 概念 | hub 对应（v1 词汇） | 备注 |
|---|---|---|
| Agent Card 声明 | `session.list` + `prompt_commands.list` + `catalog.list` + capability 面 | 能力矩阵：streaming=true（hub 有 SSE 式流式）、pushNotifications=true（`ui.notify` 广播 + connector channels） |
| `message/send` | `session.create` + `run.start` / `session.send_input` | A2A 单次发送 ≈ hub 建会话+起跑 或 已附着会话追加输入 |
| `message/stream`（SSE） | `stream.subscribe` + `assistant.delta` / `reasoning.delta` / `tool.*` | 事件流直映射 |
| Task 状态 `submitted`/`working` | `run.started` + `run.heartbeat` | |
| Task 状态 `input-required` | `approval.requested`（`approval.request`/`approval.respond`） | **天然契合**：HITL 审批即 A2A 的 input-required |
| Task 状态 `completed` / `failed` / `canceled` | `run.completed` / `run.failed` / `run.aborted` | |
| Artifacts | `artifact.created` / `diff.created` / `session.messages` | |
| `tasks/get` / `tasks/cancel` | `session.get` + `run.abort` | |
| Push notification 配置 | `connector.configure` / `ui.notify` | |

**P2 最小接入点**：hub 已记录全部命令信封（requestId/sessionId），一个 A2A 传输适配器（Agent Card 端点 + `message/send`→`session.create`+`run.start`、`tasks/cancel`→`run.abort`、Task 状态投影自 run.* 事件）即可让 hub 成为 A2A server。

---

## 4. →AG-UI 映射草案（P2 评估，方向性）

AG-UI 核心事件集：生命周期（RUN_*）、文本消息（TEXT_MESSAGE_*）、工具调用（TOOL_CALL_*）、状态（STATE_*/MESSAGES_SNAPSHOT）、CUSTOM。hub 事件流的覆盖度：

| AG-UI 事件 | hub 对应（v1 词汇） | 覆盖 |
|---|---|---|
| RUN_STARTED / RUN_FINISHED / RUN_ERROR | `run.started` / `run.completed` / `run.failed` | ✅ 直接映射 |
| STEP_STARTED / STEP_FINISHED | `iteration.started` / `iteration.finished` | ✅ 直接映射 |
| TEXT_MESSAGE_START / CONTENT / END | `assistant.delta`（首 delta→START，chunk→CONTENT）/ `assistant.finished`（→END） | ✅ 需轻量状态机（首 delta 判定 START） |
| TOOL_CALL_START / ARGS / END / RESULT | `tool.started`（input→ARGS）/ `tool.updated`（增量→ARGS）/ `tool.finished`（output→RESULT） | ✅ 直接映射 |
| STATE_SNAPSHOT / MESSAGES_SNAPSHOT | `session_snapshot`（CoreSessionSnapshot）/ `session.messages` | ✅ |
| STATE_DELTA（细粒度增量） | `session.updated`（粗粒度） | ⚠️ 缺口：无 JSON-Patch 式增量，P2 需评估 |
| HITL 审批（无原生事件） | `approval.requested` / `approval.resolved` | ⚠️ 缺口：映射为 CUSTOM 事件（约定 `cline.approval.*`）或上抛 A2A input-required |
| CUSTOM | `session.notice` / `usage.updated` / `team.progress` / `spoke.*` / `schedule.*` / `ui.*` | ✅ 无标准对应物的私有事件统一走 CUSTOM |

**结论**：hub 事件流已覆盖 AG-UI 核心事件集约 70%；适配层成本主要在 TEXT_MESSAGE 的 START/END 推导与审批的 CUSTOM 约定。protobus 服务面（state/task 服务 + 流式响应）已天然服务前端用例，AG-UI 适配评估应基于 hub 事件流做，而非 protobus。

---

## 5. 漂移规则（自 v1 起生效）

1. **只增不改**：`HubCommandName` / `HubEventName` / protobus 服务方法允许**追加**；重命名、删除、语义变更（同名字段含义变化）一律要求 hub 协议版本升 v2。
2. **版本协商兜底**：hub 已有三元组协商（`CURRENT`/`MIN`/`MAX_CLIENT_HUB_PROTOCOL_VERSION`，client.register 时握手），追加词汇配合 MAX 递增即可向后兼容。
3. **新增必须同步登记映射**：每新增一个命令/事件，必须同时在 §3/§4 表格登记拟对应的 A2A/AG-UI 条目（或明确标注"无对应物→CUSTOM"），防止未映射词汇继续漂移。
4. **P2 实现前置核验**：本文件的 A2A/AG-UI 列为方向性草案；P2 动工前须对照当期官方规范逐条核验（差距分析报告 §8 附录为起点）。

---

## 6. 事实来源锚点（代码即规范）

| 词汇 | 源码位置 |
|---|---|
| Hub 命令表（70） | `sdk/packages/shared/src/hub.ts` → `HubCommandName` |
| Hub 事件表（48） | `sdk/packages/shared/src/hub.ts` → `HubEventName` |
| 协议版本三元组 | `sdk/packages/shared/src/hub.ts` → `HubProtocolVersion` / `CURRENT_HUB_PROTOCOL_VERSION` 等 |
| 事件信封 | `sdk/packages/shared/src/hub.ts` → `HubCommandEnvelope` / `HubEventEnvelope` |
| AgentEvent（runtime 层） | `sdk/packages/shared/src/agents/types.ts` |
| CoreSessionEvent（core 层） | `sdk/packages/core/src/types/events.ts` |
| Webview protobus | `apps/vscode/proto/cline/*.proto`（16 服务） |
