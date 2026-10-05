# Cline 实现矩阵分析报告（2026-10-05）

> 基线：`main` @ `60e5adf1e`
> 前序：`agent-capability-matrix-2026-10-03.md`（基线 `739f21ebf`，本文的对照基准）
> 本轮范围：Cline 侧逐条代码实测复核 + 竞品侧证据升级

## 0. 与前份报告的关系

10-03 报告的自评局限有两条：竞品侧全部非实测、部分结论未反向验证。本轮针对这两条做改进：

| 维度 | 10-03 | 本文 |
|---|---|---|
| Cline 侧证据 | `[实测]` 带 `file:line` | 维持，并新增 12 项此前未实测的条目 |
| 竞品侧证据 | `[竞品]` 官方文档 + 第三方逆向 | 升级为 **`[竞品-官方]`** 官方文档原文；仅 hook 事件总数保留 `[竞品-逆向]` |
| 错误纠正 | — | **纠正 5 处**，见 §1 |

**证据分级**：**`[实测]`** 读代码确认 · **`[竞品-官方]`** 竞品官方文档原文 · **`[竞品-逆向]`** 第三方逆向拆解（可信度中等）· **`[沿用]`** 前序结论本轮未复核

---

## 1. 对 10-03 报告的纠正（重要）

本轮实测推翻前序 5 处结论。**其中 2 处是往更差的方向修正。**

### 1.1 OS 级沙箱：不是「仅 CLI 启用」，而是**没有任何宿主启用** ⚠️ 更差

10-03 §5.2 记为「仅 CLI 通过 `CLINE_SANDBOX=1` / `--data-dir` 启用」。**这是错的。**

`CLINE_SANDBOX` / `--data-dir` 是**数据目录隔离**，不是 OS 沙箱 —— `apps/cli/src/utils/helpers.ts:548-569` 只重定位 `~/.cline` 状态目录。CLI 自己的 flag 帮助文本也写明：`--data-dir` = "Use isolated local state at this directory path"（`apps/cli/src/commands/program.ts:84-85`）。

真实情况：

- `ProcessSandboxRuntime` 已实现并 fail-closed 导出（`sdk/packages/core/src/runtime/sandbox/process-sandbox-runtime.ts:47`、`:78-83`）✅
- **全仓除 `sdk/packages/core` 自身 barrel 导出与测试外，零代码引用** `[实测]`
- 唯一执行路径是 `createSandboxShellExecutor({ sandbox })`（`sandbox-shell-executor.ts:29`），**没有任何宿主调用它**
- `sandbox` 字段在 `CoreSessionConfig`、`SessionExecutionConfig`、`AgentConfig` 中**均不存在** —— 宿主连开启的入口都没有
- `config.sandbox` 在 CLI 里只用于两件与沙箱无关的事：绕过 hub（`run-agent.ts:175`）、与 `run-zen` 冲突报错（`run-zen.ts:33-35`）

**结论：一个 fail-closed 的安全机制已写好，却完全没有接线。** 这比 10-03 记的「部分可用」更值得优先处理。

### 1.2 子 agent 后台化：不是「○ 缺失」，而是「● 已有，但仅限 teammate」⚠️ 更好

10-03 §1.2 记为「子 agent 后台化 ○」。实测：

- `spawn_agent` 确实前台阻塞：`spawn-agent-tool.ts:164` `const result = await subAgent.run(input.task)`，入参 schema 无 async 开关（`:30-35`）
- **但 teammate 路径有完整的异步模式**：`team_run_task` 的 `runMode: "async"` 立即返回 `runId`（`team-tools.ts:496-519`），底层 `void this.executeQueuedRun(run)`（`multi-agent.ts:1140`）真 fire-and-forget，配 `maxConcurrentRuns`（`:563`）与 `team_await_runs`
- 另有 SDK 示例插件 `sdk/examples/plugins/agents-squad/index.ts:559`

**限定**：异步路径是 lead-only。`spawn_agent` 子 agent 的工具集只有内置工具 + 嵌套 `spawn_agent`，**不含 team 工具**（`sdk/packages/core/src/runtime/host/local/spawn-tool.ts:133-147`）。

### 1.3 工具裁剪：不是「不可按模式裁剪」，而是「静态裁剪已有，动态懒加载没有」⚠️ 更好

- 静态裁剪**已存在**：5 个 preset（`presets.ts:20-119`）、按模型/供应商路由（`model-tool-routing.ts:62-77`）、宿主 allowlist（`runtime.ts:229-254`）
- 动态按需加载**确实没有**：每次请求都全量发送工具 schema（`agent-runtime.ts:1429-1433`）；搜 `tool_search|ToolSearch|lazy_tool|progressive` 全仓无命中
- 但**扩展点已预留**：`beforeModel` 钩子可返回 `tools` 覆盖本次请求（`agent-runtime.ts:1464-1466`），目前无内置消费者

### 1.4 `webSearchEnabled` 关闭态外发：**该设置本身无旁路** ✅ P0 结案

10-03 §4 列为 P0「待审计」。实测结论分两层：

- **搜索工具本身闸门完整**：`runtime-builder.ts:295-297` 在 `!webSearch?.enabled` 时直接返回空数组，无任何绕过路径
- **但「关掉 web search ⇒ 查询不出机器」这句话不成立**：`fetch_web_content` 默认开启且 URL 由模型撰写（`presets.ts:30`、`web-fetch.ts:142`）、`run_commands` 默认开启且 bash 执行器**完全没有 boundary**（`bash.ts` 零 `boundary` 引用）、MCP 工具不受此设置约束

**这是设置语义与实际外发面的差异，不是漏洞** —— 但文档措辞应避免暗示「关闭即无外发」。

### 1.5 `fileBoundaryEnabled`：**P0 结案** ✅

默认 `true`（`state-keys.ts:339`），警告文案在 `package.json:456` 与 `FeatureSettingsSection.tsx:392`（"Turning this off lets the agent reach any path on disk"）。设计合理，无需改动。

---

## 2. 实现矩阵

图例：**●** 已实现且可达 · **◐** 部分/保守 · **○** 缺失 · **?** 未核实

### 2.1 工具层

| 能力 | Cline | Claude Code | Codex | 说明 |
|---|---|---|---|---|
| 文件读取 / 搜索 / shell / 抓取 / 补丁 / 编辑 / 提问 | ● | ● | ● | |
| **文件名 glob** | ● `glob` | ● | ◐ | 10-04 补齐 `[实测]` |
| **LSP 代码智能** | **○** | **●** `LSP` | **?** | **本轮新发现**：跳转定义/查引用/类型错误，`[竞品-官方]` |
| **延迟工具加载** | **○** | **●** `ToolSearch` + MCP Tool Search | ◐ | **最高优先级结构性差距** `[竞品-官方]` |
| **后台命令 + 逐行回流** | **◐** | **●** `Monitor`（含 WebSocket 事件） | **?** | Cline 有 `content_update` 机制但**仅 VS Code 消费** |
| MCP tools | ● | ● | ● | |
| MCP resources | ● 3 工具 | ● `ListMcpResourcesTool` | ◐ | 宿主限定，见 §5 |
| MCP prompts | ● 仅列举 | ● | ◐ | 执行语义属产品决策，未做 |
| MCP 连接就绪等待 | ○ | ● `WaitForMcpServers` | ◐ | `[竞品-官方]` |
| Web 搜索 | ● | ● | ● `--search` | Cline 可配 provider；Claude 单会话 200 次上限 |
| 工具失败级联取消 | ○ | ● 仅 Bash | ? | |
| 推测执行 | ○ | ● | ? | |

**工具清单口径澄清** `[实测]`：`BASE_TOOL_CATALOG` 10 个条目、`ALL_DEFAULT_TOOL_NAMES` 10 个名字（`editor`/`apply_patch` 共用一个目录条目，`runtime.ts:198-206`）；默认 act 模式实际暴露 ≈ 8 内置 + `spawn_agent` + **18 个 `team_*`** + skills/memory/MCP。

### 2.2 多智能体

| 能力 | Cline | Claude Code | Codex | 说明 |
|---|---|---|---|---|
| 子 agent 委派 | ● | ● | ● | |
| **后台子 agent** | **◐** 仅 teammate | ● **默认后台** | ● | 见 §1.2 |
| **嵌套深度限制** | **○** | **● 3 层** | **● 默认 1** | **本轮确证，见下** |
| 并发上限 | ● `maxConcurrentRuns` 默认 2 | ● | ● `max_threads` 默认 **6** | Cline 默认值低于 Codex |
| **per-agent worktree 隔离** | **○** | **●** `isolation: worktree` / `-w` | ◐ 按 agent 配 sandbox | |
| **跨会话消息** | **○** | **●** `SendMessage` | ● `/agent` 切线程 | Cline 的 A2A 是传输层，非 agent 间调用 |
| 团队工具集 | ● **18 个** | ◐ 实验性 | ◐ | Cline 在此广度反超 |
| 子 agent 沙箱继承 | ● 同步更新连接 | ● | ● 含父回合实时覆盖 | |
| **CSV 批量扇出** | ○ | ◐ `/batch` skill | ● `spawn_agents_on_csv` | |

**嵌套深度是本轮最明确的差距** `[实测 vs 竞品-官方]`：Cline `spawn_agent` 的工具集**递归包含自身**（`spawn-tool.ts:141-145`），且全仓搜 `maxDepth|depthLimit|nesting|subAgentDepth` **零命中**（仅命中目录遍历深度、对象递归深度等无关项）。默认开启（`presets.ts:36`）。对照：Codex `agents.max_depth` **默认 1**，文档明确警告"Raising this value can turn broad delegation instructions into repeated fan-out"；Claude Code 允许 3 层且到限后收回 `Agent` 工具。

现有的 `team-tools.ts:234` `allowSpawn: false` 是**角色**限制（teammate 不可再生 teammate），非深度限制。

### 2.3 上下文与记忆

| 能力 | Cline | Claude Code | Codex | 说明 |
|---|---|---|---|---|
| 自动压缩 + 阈值可配 | ● | ● | ● | |
| 压缩钩子 | ◐ 仅 `pre_compact` | ● **`PostCompact`** | ? | **见 §3** |
| 跨会话记忆 | ◐ 写路径默认关 | ● | ◐ | |
| **超长会话稳定性** | **?** | ● | ? | Cline 侧曾观测 742 万 input token 会话，未复现 |

### 2.4 执行控制与安全（差距最集中的区域）

| 能力 | Cline | Claude Code | Codex | 说明 |
|---|---|---|---|---|
| 迭代上限 | ● 三宿主 | ● | ● | ACP 已于 10-04 补齐 |
| 费用上限 | ● 三宿主 | ● | ● | |
| 连续失误上限 | ● | ● | ● | |
| **工具调用数上限** | **○** | ◐ | ◐ | 见下 |
| **嵌套深度上限** | **○** | ● | ● | |
| 文件边界 | ● 默认开 | ● 沙箱内 | ● `workspace-write` | |
| **OS 级文件沙箱** | **◐ 已实现未接线** | ● | ● Seatbelt/bwrap/Win | **见 §1.1** |
| **网络隔离** | **○** | ● OS 级 | ● **destination 规则 + `network_proxy`** | **双重缺失** |
| 细粒度审批 | ◐ 按工具 | ● 7 种模式，deny-first | ● `granular{5 类}` | |
| **AI 审批复核** | **○** | ● Auto Mode 分类器 | ● **auto_review 复核 agent** | Cline 只有 mistake tracker |
| 拒绝熔断 | ○ | — | ● 3 连拒 / 50 内 10 次 | |
| 权限规则表达式 | ○ 布尔策略 | ● `Bash(npm run *)` 等 | ● 前缀规则 | |

**工具调用数上限** `[实测]`：Cline 的预算 schema **主动拒绝**该字段 —— `AGENT_RUN_BUDGET_KEYS` 只含 token/cost（`sdk/packages/shared/src/agents/types.ts:602-607`），`maxCalls` 会抛错（`:635-638`），并有回归测试固化（`agent-runtime.test.ts:2807-2813`）。存在一个**已实现但刻意未接线**的 `maxToolCalls` middleware（`budget-middleware.ts:62-64`），其文件头注释明说这是唯一能力确实不存在的 middleware、启用需要产品决策。

### 2.5 可观测性

| 能力 | Cline | Claude Code | 说明 |
|---|---|---|---|
| OpenTelemetry | ● | ● | |
| 流式审计 hook | ● **10 事件** | ● **27 事件** | **见 §3** |
| 工具幂等账本 / 脱敏 | ● | ? | |
| 成本追踪 / 断点续跑 | ● | ● | |

### 2.6 宿主与集成

| 能力 | Cline | Claude Code | Codex | 说明 |
|---|---|---|---|---|
| IDE 扩展 / 独立 CLI | ● | ● | ● | |
| ACP 协议 | ● | ◐ | — | Cline 独有 |
| 常驻守护进程 | ● hub daemon | ● | ● cloud | |
| **可复现裸模式** | **○** | ● `--bare` | ◐ `exec` + profile | `--bare` 跳过全部自动发现，CI 一致性 |
| 云端定时执行 | ○ | ● routines | ● cloud | |
| Web / 浏览器端 | ○ | ◐ | ● | |

---

## 3. 本轮新增发现（10-03 未覆盖）

### 3.1 Hook 事件面：10 vs 27

Cline 实测 10 个（`sdk/packages/shared/src/hooks/events.ts:58-69`）：`agent_start` `agent_resume` `agent_abort` `agent_end` `agent_error` `tool_call` `tool_result` `prompt_submit` `pre_compact` `session_shutdown`。

**`post_compact` 确认缺失** `[实测]`：全仓搜 `post_compact|PostCompact` 零命中。压缩结果只能通过 runtime status notice（`compaction.ts:482-495`）与遥测观察，hook 无法消费。

Claude Code 侧为 **27 个事件** `[竞品-逆向]`，含 `PostCompact`、`SubagentStart`/`Stop`、`TeammateIdle`、`TaskCreated`/`Completed`、`CwdChanged`、`FileChanged`、`WorktreeCreate`/`Remove`、`InstructionsLoaded`、`ConfigChange`、`PermissionRequest`/`Denied`、`PostToolUseFailure` 等。hook 执行类型也更多：shell / LLM prompt / HTTP / **agentic verifier** / callback `[竞品-官方]`。

> 注意：该 27 为逆向来源，可信度中等。但 `PostCompact` 的存在可由官方 glossary 独立佐证。

### 3.2 顺带发现的死代码

`sdk/packages/shared/src/agents/types.ts:1025` 声明 `maxParallelToolCalls: z.number().int().positive().default(8)`，但其所属 `AgentConfigSchema`（`:1008`）**全仓从未被引用** —— 该 default 8 从未生效。

---

## 4. 差距排序

### P0 — 安全（当前唯一有「已实现却完全没接线」的能力）

| # | 事项 | 状态 |
|---|---|---|
| **S1** | **OS 沙箱接线** —— 实现已完成、fail-closed、已导出，但零宿主调用；且宿主无 `sandbox` 配置字段 | **新增最高优先** |
| **S2** | **网络隔离** —— Claude Code 有 OS 级、Codex 有 destination 规则 + `network_proxy`；Cline 无任何网络层限制 | 需设计 |
| S3 | 嵌套深度上限 | 小；竞品默认 1（Codex）/ 3（Claude Code） |

### P1 — 执行层与上下文成本

| # | 事项 | 工作量 |
|---|---|---|
| **S4** | **延迟工具加载（ToolSearch）** —— 竞品两强均有；Cline 扩展点已预留（`beforeModel` 可覆盖 `tools`） | 中 |
| **S5** | **`spawn_agent` 后台化** —— teammate 已有 async，`spawn_agent` 无 | 小（可复用既有机制） |
| S6 | LSP 工具 | 中 |
| S7 | `post_compact` 钩子 | 小 |
| S8 | 工具调用数上限 | 小（需产品决策） |
| S9 | AI 审批复核（对齐 auto_review / Auto Mode） | 大 |

### P2 — 产品决策

- **S10** teams 默认策略（18 工具默认关，两头不讨好）
- **S11** worktree 隔离
- **S12** 可复现裸模式（`--bare` 等价）

---

## 5. 各宿主对齐现状（更新）

| 能力 | VS Code | CLI | ACP | hub | desktop-app |
|---|---|---|---|---|---|
| `glob` | ● | ● | ● | ● | ● |
| MCP resources/prompts | ● | ○ | ○ | ○ | ○ |
| **工具输出流式** | ● | **○** | ○ | ● | ● |
| **OS 沙箱** | **未接线** | **未接线** | **未接线** | **未接线** | **未接线** |
| 并行工具 | 6 | 6 | 串行（有意） | — | 串行回落 |
| 子 agent 后台 | 仅 teammate | 仅 teammate | 仅 teammate | 仅 teammate | 仅 teammate |
| 护栏 | ● | ● | ● | — | 仅 `maxIterations` |

新增说明：

- **CLI 不消费 `content_update`** `[实测]`：CLI 事件 switch 只有 `iteration_start|iteration_end|content_start|content_end|done|error|notice|usage`（`apps/cli/src/utils/events.ts:104-210`、`tui/hooks/use-agent-events.ts:125`），工具输出仅在 `content_end` 落地。文档 `docs/sdk/reference/events.mdx:28` 已如实标注。
- **desktop-app 走显式 allowlist，遗漏并发字段** `[实测]`：`apps/examples/desktop-app/sidecar/chat-session.ts:209-241` 的 `buildCoreSessionConfig` 不含 `maxParallelToolCalls`，且无 passthrough，故回落串行。注意 `commands.ts:446` 的 `maxParallel` 是定时例程并发，**不是**工具并发。
- **ACP 串行是有意决策**，代码里有显式注释（`acpAgent.ts:551-554`："ACP's serial execution is its own semantics, decided separately"）。
- **ACP 连开启沙箱的入口都没有**：`setSessionConfigOption` 只接受 `provider|model|mode`；且 ACP 在 `main.ts:894-898` 提前 return，`--data-dir` / `CLINE_SANDBOX` 根本走不到沙箱逻辑。

---

## 6. 本报告的局限

1. **竞品侧仍非实测**：已升级为官方文档原文，但未安装运行。`[竞品-逆向]` 仅用于 Claude Code 的 27 个 hook 事件数。
2. **Codex 侧多处信息自相矛盾**：同一份官方文档中 `agents.max_threads` 与 `agents.max_concurrent_threads_per_session`、`agents.enabled` 的存在性不一致，疑为版本迭代残留，未能判定当前生效值。
3. **未做基准测试**：比的是实现能力与可达性，不是任务成功率。
4. **超长会话稳定性仍标 `?`**：仅观测到 742 万 token 会话存在，未复现。
5. **Cline 侧新增条目均为静态代码实测**，未做端到端行为验证（例如沙箱若接线后是否真生效）。

---

*生成于 2026-10-05，基线 `60e5adf1e`。§1、§2、§3、§5 中所有 `[实测]` 结论可按 `file:line` 直接复核。*