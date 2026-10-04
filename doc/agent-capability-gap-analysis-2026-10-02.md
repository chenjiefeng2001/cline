# Cline 与主流 Agent 实现能力对比报告（2026-10）

> 生成时间：2026-10-02
> 对比基线：`main` @ `739f21ebf4`（含 webview 前端刷新缺陷修复 + gRPC 订阅生命周期修复，未提交）
> 分析范围：`sdk/packages/agents`（agent loop）、`sdk/packages/core`（ClineCore 能力面）、
> `sdk/packages/shared`（公共类型）、`sdk/packages/llms`（provider 层）、
> `apps/vscode/src/sdk`（IDE 宿主）、`apps/cli`（CLI 宿主）
> 对标对象：Claude Code（Anthropic）、OpenAI Codex CLI、Google Antigravity CLI（前 Gemini CLI）、
> Claude Agent SDK、Codex Agents SDK，以及 MCP / A2A / OTel 公开规范
> 证据分级：**[实测]** = 本仓代码读出，带 `file:line` 可复核；**[文档]** = 竞品官方文档/官方博客；
> **[拆解]** = 第三方对闭源产品的逆向分析（可信度中等）；**[存疑]** = 二手来源互相矛盾，未采信
> 前序报告：`doc/agent-capability-gap-analysis-2026-09-24.md`、`doc/architecture-gap-analysis-vs-mainstream-agents-2026-08.md`

---

## ⚡ 落地状态更新（同日追加）

> 本节记录分析结论**之后的实际改动**。§1–§4 是改动前的分析快照，其中若干「零引用」
> 「未接线」的判断**已被本节推翻**，阅读时请以本节为准。逐条对应见 §5.1。

| 原报告条目 | 状态 | 落地方式 |
|---|---|---|
| #1 并行工具执行 | **已落地** | 双宿主默认 `maxParallelToolCalls = 6`；`1` 可退回串行 |
| #2 工具安全契约 | **部分落地** | 契约落在**定义级**（`concurrency: "safe" \| "exclusive"`，默认 exclusive），**非参数级** |
| #4 CLI 迭代/预算上限 | **已落地** | `--max-iterations` / `--max-budget-usd`，默认 50 / $5 |
| #5 重试分类下沉 | **已落地** | 分类与退避下沉至 `@cline/llms`，VS Code 与 CLI 共用 |
| #7 `PreCompact` 事件 | **已落地** | 自动压缩 + 两处手动压缩路径均发射 |

**#2 的偏差需要明确**：`isConcurrencySafe(input)` 的**按参数判定**未实现。当前是按
**工具定义**判定 —— 只有 `read_files` / `search_codebase` 声明 `concurrency: "safe"`。
这比按参数判定更保守（同一工具的不同入参不会分开判定），因此**不存在 §3.1 警告的写冲突
风险**，但也意味着「同一工具、部分入参可并发」这种优化暂时拿不到。

---

## 0. 方法与可信度声明

1. **竞品侧数据不是实测。** Claude Code 闭源，Codex / Antigravity 本次未安装，全部结论来自官方文档
   与第三方逆向拆解。凡涉及内部实现细节（如并行执行的分批算法）均标 `[拆解]`，建议自行安装对照。
2. **两个前提性的产品身份变更（2026）**：
   - **Gemini CLI → Antigravity CLI**（Google 自 2026-06-18 起停止对个人用户服务）
   - **Amazon Q Developer CLI → Kiro CLI**（AWS，前者转入仅安全修复）
   半年后本矩阵的「竞品」命名可能再次变化。
3. **本报告比的是实现能力，不是任务成功率。** 两者高度相关但不等价 —— 尤其本报告 §3.1 指出的
   「已实现但未接线」项，其实际体验影响小于矩阵字面差异。
4. **矩阵中的图例是「能力可达性」，不是「默认行为」。** 多个格子属于「有实现但默认关闭」，
   §3 与 §4 专门处理这一类。

---

## 1. 核心结论

> **Cline 的能力广度已超过头部玩家，但「可达性」与「执行层打磨」落后。**
>
> 能力矩阵上有 7 项领先或独有；其中至少 4 项默认关闭或 UI 不暴露。
> 同时在头部玩家打磨最狠的**执行层**上明显落后，且这部分差距是**架构级**的，不是调参能补的。

**最高杠杆的三件事：**

| 序 | 事项 | 一句话理由 |
|---|---|---|
| 1 | 打开并行工具执行 | runtime 已完整实现 worker pool，宿主零引用 |
| 2 | 工具输出改流式 | `emitUpdate` 通路已通，零调用方 |
| 3 | 重新评估默认开关策略 | 有 18 个团队工具但 IDE 默认关，现状两头不讨好 |

---

## 2. 能力矩阵

图例：`●` 完整 · `◐` 部分/有条件 · `○` 缺失 · `—` 不适用

### 2.1 执行层（最落后的部分）

| 能力 | Cline | Claude Code | Codex CLI | Antigravity | 说明 |
|---|:--:|:--:|:--:|:--:|---|
| 单轮多工具并行 | **○** | **●** | ● | ● | 本仓已实现但宿主未接线，见 §3.1 |
| 按输入判定并发安全 | ○ | **●** | ● | ● | Claude 解析 Bash 子命令逐个判只读 `[拆解]` |
| 推测执行（生成中即开跑） | ○ | **●** | ◐ | ○ | Claude `StreamingToolExecutor` `[拆解]` |
| 并发上限可配 | ◐ | **●** | ● | ● | 本仓仅一个裸数字 |
| 工具输出流式 | **○** | ● | ● | ● | 见 §3.2 |
| 工具失败级联取消 | ○ | ● | ◐ | ○ | 仅 Claude 有明确语义 |
| 迭代上限 | ● | ◐ | ◐ | ◐ | VS Code 50，**CLI 无上限** |
| 花费预算上限 | ◐ | ● | ○ | ○ | VS Code $5，**CLI 无** |
| 无进展检测 | **●** | ◐ | ○ | ○ | 同工具同输出 3 次即停，本仓独有 |
| 停止原因粒度 | **●** | ◐ | ◐ | ◐ | 本仓 6 种，见 §3.5 |

### 2.2 上下文管理

| 能力 | Cline | Claude Code | Codex | Antigravity |
|---|:--:|:--:|:--:|:--:|
| 自动压缩 | **●** 90% 触发 / 70% 目标 | ● | ● | ● |
| 压缩策略可选 | **●** basic / agentic | ◐ | ◐ | ◐ |
| 手动压缩 | ● `/compact` | ● | ● | ● `/compress` |
| 压缩状态持久化 | **●** 独立 sidecar | ◐ | ◐ | ◐ |
| 上下文用量可观测 | ● | ◐ `/cost` | ● `/status` | ● `/stats` |

**本项不落后，压缩侧略优。**

### 2.3 多智能体

| 能力 | Cline | Claude Code | Codex | Antigravity |
|---|:--:|:--:|:--:|:--:|
| 子 agent 派生 | ● | ● | ● | ● |
| 后台子 agent | **○** | **●** 默认后台 | ◐ | ◐ |
| 子 agent 上下文隔离 | ● | ● | ● | ● |
| 子 agent 工具白名单 | ● | ● `.claude/agents/` | ● | ● |
| 每子 agent 独立 worktree | **○** | **●** | ● worktree/task | ◐ 实验性 |
| 并发子 agent 上限 | **○** | ● 20 | ◐ | ◐ |
| 嵌套深度限制 | **○**（可无限递归） | ● 3 层 | ◐ | ◐ |
| 团队协调（共享任务表 + 互发消息） | **●** 18 个团队工具 | ● 实验性·默认关 | ◐ | ○ |
| 团队默认开启 | **○** IDE 关闭 / CLI 开启 | ○ | — | — |
| 后台独立会话 | **●** hub daemon | ● agent view | ◐ | ◐ |
| 动态工作流（多 agent 交叉验证） | ○ | ● | ○ | ○ |

**矛盾最尖锐的一张表**：本仓团队工具面比 Claude 更全（任务分派、信箱、outcome 分片评审、finalize），
但 IDE 侧默认关闭。

### 2.4 沙箱与权限

| 能力 | Cline | Claude Code | Codex | Antigravity |
|---|:--:|:--:|:--:|:--:|
| OS 级内核沙箱 | ◐ 平台相关 | ○ | **●** Seatbelt/Landlock+seccomp | ● Seatbelt |
| 容器沙箱 | ◐ `SubprocessSandbox` | ○ | ● | ● Docker/Podman/gVisor/LXC/Windows |
| 默认开启 | ◐ | ○ | **●** | ○ |
| 文件边界 | **●** realpath | ● | ● | ● |
| 网络限制 | **○** | ◐ | ● 默认关 | ◐ |
| 细粒度权限规则 | ◐ 工具级 | **●** `Bash(npm test*)` 式 | ● | ● |
| 持久化审批（跨进程） | **●** SQLite + 租约 | ◐ | ◐ | ◐ |
| 崩溃后续跑 | **●** `DurableRunContinuation` | ◐ | ◐ | ◐ |

**「持久化审批 + 崩溃续跑」领先；「默认安全」显著落后 Codex。**

### 2.5 扩展性

| 能力 | Cline | Claude Code | Codex | Antigravity |
|---|:--:|:--:|:--:|:--:|
| MCP client | ● | ● | ● | ● |
| MCP server 模式 | ○ | ○ | **●** | ○ |
| **MCP resources** | **○** | ● | ◐ | ● |
| **MCP prompts** | **○** | ● | ◐ | ● |
| MCP 热增删工具 | **○** 需重启会话 | ◐ | ◐ | ◐ |
| Hooks 事件类型 | 10 种 | ● | ● | ● |
| **PreCompact 事件** | **○** 声明未发射 | — | — | — |
| Hook 可阻断运行 | **◐** 仅 VS Code | ● | ● | ● |
| Skills | ● | ● | ● | ● |
| Plugins / 市场 | **●** | ● | ● | ● |
| ACP（编辑器集成） | ● | — | — | ● |

### 2.6 自动化与连接

| 能力 | Cline | Claude Code | Codex | Antigravity |
|---|:--:|:--:|:--:|:--:|
| 本地定时任务 | **●** cron + `maxParallel` + 隔离 | ◐ | ○ | ○ |
| **云端定时（Routines）** | ○ | **●** 无竞争 | ○ | ○ |
| 聊天平台桥接 | **●** Telegram/Slack/gChat/WhatsApp/Linear | ○ | ○ | ○ |
| Webhook 触发 | **●** | ○ | ○ | ○ |
| 后台守护进程 | **●** hub | ○ 本地 | ◐ Cloud | ○ |

> **聊天桥接一行需特别说明**：调研显示**所有主流 agent 均不原生支持**，社区全部依赖第三方桥接项目。
> 本仓是唯一把 5 个平台连接器做进产品本身的。属真实差异化，不应被「对齐主流」的错误叙事抹掉。

---

## 3. 差距详析（按优先级）

### 3.1 【最高杠杆】并行工具执行：已实现但未接线

**【实测】** runtime 完整实现了 worker-pool 并行执行：

- `sdk/packages/agents/src/agent-runtime.ts:1961-2001` —— worker pool，由 `config.maxParallelToolCalls` 界定
- `sdk/packages/core/src/runtime/config/agent-runtime-config-builder.ts:185-194` —— 模式完全由单一开关推导：
  `"parallel"` iff `maxParallelToolCalls >= 2`
- 默认值 `agent-runtime.ts:597`：`toolExecution: resolved.toolExecution ?? "sequential"`
- 落库持久化 `runtime/continuation/run-state.ts:124-125`

**但**：`maxParallelToolCalls` 在 `apps/` 下**零引用**。所有出厂配置均为串行。

> **⚠️ 此结论已于同日推翻** —— 双宿主现均已接线（默认 6）。详见 §5.1 与文首「落地状态更新」。
> 下文保留为改动前快照。

与 Claude Code 的差距不止开关：

| 维度 | Claude Code `[拆解]` | Cline |
|---|---|---|
| 分批策略 | `partitionToolCalls()` 贪心保序，串行工具打断并 | 全批一起，**无安全分类** |
| 安全判定 | `isConcurrencySafe(parsedInput)` **按参数**判定 | **无** |
| 并发上限 | 默认 10，env 可调 | 一个裸数字 |
| 推测执行 | 流式解析到即开跑 | 无 |
| 失败级联 | 仅 Bash 失败级联取消兄弟 | 无 |

**真正缺失的是「按输入判安全」这一层工具契约，不是开关。** 直接打开开关会让写类工具
（`editor` / `apply_patch` / `run_commands`）在同一批次并发，存在真实的写冲突与 cwd 竞态风险。

> 补充：即使开启并行，**准备阶段（校验 + 审批）仍强制串行**
> （`agent-runtime.ts:1910-1929`，审批逐个询问）。此点与 Claude Code 一致，不计入差距。

### 3.2 【最高杠杆】工具输出无任何流式

**【实测】** 通路存在但零调用方：

- `AgentToolContext.emitUpdate` 已定义 —— `sdk/packages/shared/src/agent.ts:203`
- runtime 已转发为 `tool-updated` 事件 —— `agent-runtime.ts:2418-2426`
- **唯一调用方是 hub-client 贡献代码** —— `core/src/hub/server/hub-client-contributions.ts:493-495`
- 所有内置工具与宿主工具**均不调用**
- VS Code 的 `run_commands` 更是显式缓冲到结束 ——
  `apps/vscode/src/sdk/vscode-run-commands-tool.ts:181-182` 有注释明述

对长任务这是明显的体验差距：竞品边跑边出结果，本仓结束后一次性倒出。

### 3.3 MCP resources 与 prompts 完全缺失

**【实测】** `sdk/packages/**/src` 下 `resources/list`、`resources/read`、`prompts/list`、
`prompts/get` **零命中**。

讽刺的是 **VS Code 侧已取到**：
- resources —— `apps/vscode/src/services/mcp/McpHub.ts:852, 1424`
- prompts —— `McpHub.ts:895, 1451`

但 `createVscodeExtraTools` 只调 `createMcpTools`
（`apps/vscode/src/sdk/vscode-runtime-builder.ts:132-152`）—— **取了从不传给 agent**。
属纯粹的临门一脚。

另：stdio client 在 `initialize` 时宣告空能力 —— `extensions/mcp/client.ts:177` `capabilities: {}`。

### 3.4 CLI 缺迭代上限与预算上限

**【实测】** VS Code 具备（50 轮 / $5，`apps/vscode/src/sdk/cline-session-factory.ts:855, 860`），
**CLI 完全没有** —— `apps/cli/src/main.ts:1076-1132` 无 `maxIterations`、无 `budget`。
仅 schedule wizard 暴露了 `maxIterations`（`apps/cli/src/wizards/schedule/index.ts:155-221`）。

无上限的 agent loop 在 CI 中运行存在失控风险。

### 3.5 停止原因粒度：优于竞品

**【实测】** 6 种终止状态：

| status | 位置 |
|---|---|
| `completed` | `agent-runtime.ts:1255`, `:1301` |
| `max_iterations` | `agent-runtime.ts:1321-1325` |
| `budget_exhausted` | `agent-runtime.ts:1857-1879`（4 个预算维度） |
| `no_progress` | `agent-runtime.ts:1818-1839`（阈值 3，`:319`） |
| `aborted` | `agent-runtime.ts:1330-1331` |
| `failed` | `agent-runtime.ts:1331` |

`no_progress` 与多维 `budget_exhausted` 竞品普遍没有。**本项领先。**

### 3.6 子 agent：功能有，形态落后

**【实测】** `spawn_agent`（`extensions/tools/team/spawn-agent-tool.ts:122`）为**同步**阻塞。
递归允许 —— `extensions/tools/team/delegated-agent.ts:158-171` 以 preset 重建子 agent 工具集
（`runtime/host/local/spawn-tool.ts:133-147`），无深度上限。

**【拆解】** Claude Code 侧：子 agent 默认后台，有 20 并发上限、200 次/会话上限、
3 层嵌套硬限制（到限则从工具集移除 Agent 工具而非报错）、以及 forked subagent
（继承父 agent 完整上下文）。

差距汇总：

| 项 | Cline |
|---|---|
| 后台子 agent | ✗ 同步阻塞 |
| 并发上限 | ✗ 无 |
| 嵌套深度限制 | ✗ 可无限递归 |
| forked 模式 | ✗ 无 |
| per-subagent worktree | ✗ 无 |
| 配置化 agent 格式 | YAML（`configured-agent-config.ts`）vs 竞品 markdown+frontmatter |

### 3.7 Hub / cron 强能力，但缺「云端」

**【实测】** 本仓具备完整本地自动化：cron（`schedules` 表含 `max_iterations` /
`timeout_seconds` / `max_parallel` —— `sdk/packages/shared/src/db/sqlite-db.ts:224-249`）、
webhook、事件触发、hub 守护进程、5 个聊天平台连接器（`apps/cli` 的 `connect` 子命令）。

**【文档】** Claude Code Routines 为**云端**定时 —— 笔记本不开也能跑。

该差距是**架构性**的：本仓 cron 依赖本机在线。对齐需做云端执行，属产品形态而非工程量问题。

### 3.8 Hook 覆盖有洞

**【实测】**

- `PreCompact` **声明但从不发射** —— `extensions/hooks/hook-file-config.ts:41` 映射到 `undefined`。
  而 VS Code 甚至已提供模板 —— `apps/vscode/src/core/hooks/templates.ts:414-463`
- VS Code 仅接 10 种中的 6 种 —— `apps/vscode/src/sdk/hooks-adapter.ts:11-12` 注释明列
  TaskResume / TaskError / SessionShutdown / PreCompact / Notification 未接
- CLI hook **全部非阻塞** —— `apps/cli/src/utils/hooks.ts:243, 282, 329` 均 `return undefined`
- `createSubprocessHooks` 从 barrel 导出但**零调用点**（死代码）—— `core/src/index.ts:381`

### 3.9 遗留 stub 清单

**【实测】** 全仓 `"STUB:"` 字面量仅两处（`apps/vscode/src/sdk/SdkController.ts:159-161`）。

| 项 | 位置 | 影响 |
|---|---|---|
| `cancelBackgroundCommand()` 空实现 | `SdkController.ts:1341-1343`, `:1896-1899` | 后台命令取消无效 |
| `readOpenRouterModels()` 恒返回 undefined | `SdkController.ts:159-161` | OpenRouter 走 SDK catalog（设计如此，但日志噪音） |
| `TaskProxyTerminalManager` no-op | `apps/vscode/src/sdk/task-proxy.ts:133-142`, `:191-196` | 安全无害 |
| `handleOcaAuthCallback` stub | `apps/vscode/src/sdk/auth-service.ts:907-911` | 仅接口兼容 |
| Hub `settings.get` / `settings.patch` | `core/src/hub/server/hub-server-transport.ts:575-585` | 返回 `not_implemented` |
| budget / approval / retry middleware **零消费者** | barrel 导出；默认链仅 `[idempotency, redaction]`（`local-runtime-host.ts:1163-1168`） | ⚠️ **本条判断已于 2026-10-03 撤回** —— `approval` / `retry` 的功能已由 runtime 内建路径覆盖（`agent-runtime.ts:2235` / `:2562`），接线会导致重复审批与三重重试；`budget` 确属缺失但属产品决策。详见 `doc/agent-capability-gap-review-2026-10-03.md` §4.1 |
| 核心层无 provider 重试分类 | 仅 VS Code 有 —— `apps/vscode/src/sdk/sdk-session-lifecycle.ts:53-72` | ✅ **已于 2026-10-03 修复**：下沉至 `@cline/llms`，CLI/ACP 共用 |

最后一条直接对应实际体验：CLI 遇到 `ECONNRESET` 不会重试。

### 3.10 权限模型默认值需注意

**【实测】** SDK 默认是**自动批准** —— 未在 `toolPolicies` 中列名的工具一律放行
（`sdk/packages/core/src/runtime/.../sdk-tool-policies.ts:5-11` 有显式文档）。
判定单点：`agent-runtime.ts:2121-2141`（合并顺序 `*` → 按工具名 → hook 覆盖）。
无「工具内在必需审批」标志，审批完全由宿主策略决定。

VS Code 侧强制对 read/edit/command/browser 及全部 MCP 工具置 `autoApprove: false`
（`apps/vscode/src/sdk/sdk-tool-policies.ts:13-40`）—— 即 **SDK 默认宽松，IDE 默认严格**。
任何新接入 SDK 的宿主都需要显式收紧，这是易被忽略的集成陷阱。

---

## 4. Cline 的真实优势（不应被埋没）

| 优势 | 证据 |
|---|---|
| **聊天平台原生桥接**（5 平台） | 竞品全部依赖第三方桥接项目 |
| **持久化审批 + 崩溃续跑** | `DurableRunContinuation` + SQLite 租约（`local-runtime-host.ts:1171-1355`）；竞品多为会话内记忆 |
| **checkpoint 机制最优雅** | `git stash create` → `refs/cline/checkpoints/<sessionId>/<n>` 私有 ref，**不进用户 `git stash list` 且 GC 安全**（`extensions/hooks/checkpoint-hooks.ts:222-243`） |
| **停止原因粒度** | 6 种，含 `no_progress` 与多维 `budget_exhausted` |
| **Provider 广度 44 个** | `sdk/packages/llms/src/providers/ids.ts:8-67`，含 `claude-code` / `opencode` / `openai-codex-cli` |
| **Agent Teams 工具面更全** | 18 个工具，含 outcome 分片评审与 finalize |
| **多宿主统一内核** | VS Code / CLI / JetBrains / 独立端 同一 runtime；竞品多为单端 |
| **本地自动化栈** | cron + webhook + 守护进程；竞品基本只有 Claude Routines（且为云端） |
| **SDK 公开面** | 1122 行 barrel，`@cline/sdk` 可编程构建自有 agent |

---

## 5. 建议路线图

### 5.1 第一梯队落地明细（#1 / #4 / #5 / #7）

以下为实际改动的 `file:line`，均可复核。

#### #1 并行工具执行（含 #2 的定义级安全契约）

| 改动 | 位置 |
|---|---|
| 工具契约新增 `concurrency?: "safe" \| "exclusive"`，**默认 `exclusive`** | `sdk/packages/shared/src/agent.ts:184` |
| `createTool()` 透传并默认 exclusive | `sdk/packages/shared/src/tools/create.ts` |
| 仅 `read_files` / `search_codebase` 声明 `safe` | `sdk/packages/core/src/extensions/tools/definitions.ts` |
| 按安全性贪心保序分批；串行工具独占一批 | `sdk/packages/agents/src/agent-runtime.ts:2022-2033`（`partitionByConcurrency`） |
| worker pool 受 `maxParallelToolCalls` 约束，结果按下标保序 | `agent-runtime.ts:2046-2081` |
| VS Code 默认 6，可设 `1` 退回串行 | `apps/vscode/src/shared/storage/state-keys.ts`、`cline-session-factory.ts:1036` |
| CLI 新增 `--max-parallel-tool-calls`，默认 6 | `apps/cli/src/commands/program.ts:71-74`、`main.ts:1129` |

模式仍由既有单开关推导：`maxParallelToolCalls >= 2` → `"parallel"`
（`agent-runtime-config-builder.ts:188-195`），故 `1` 即完整退回旧的串行行为。

**已知取舍**：准备阶段（校验 + 审批）仍强制串行，与 Claude Code 一致；`start()` 承载的
首个 prompt 未加重试，避免重试重复创建 session。

#### #4 CLI 迭代 / 预算上限

`--max-iterations`（默认 50）、`--max-budget-usd`（默认 $5）在
`apps/cli/src/main.ts:1123-1129` 落进 session config；非法值经
`invalidMax*` 字段上报而非静默回落默认值（`program.ts:190-220`）。两者在 runtime 中
本就是**结束原因**（`max_iterations` / `budget_exhausted`）而非崩溃。

#### #5 provider 重试分类下沉

- 单一分类与退避定义：`sdk/packages/llms/src/providers/transient-errors.ts`
  （覆盖 `ECONNRESET` / TLS / 429 / 502-504 / overload，**abort 一律不重试**）
- VS Code 改为复用：`apps/vscode/src/sdk/sdk-session-lifecycle.ts`
- CLI 薄封装 `apps/cli/src/utils/retry.ts`，已接入 `run-agent.ts:340`、
  `interactive/session-runtime.ts:551`、`acp/acpAgent.ts:230`
- ACP 额外接受 `AbortSignal`：用户 cancel 后不再空等退避

#### #7 `PreCompact` 事件

- `PreCompact` → `pre_compact` 映射：`sdk/packages/core/src/hooks/hook-file-config.ts`
- schema 放宽为 SDK 实际可提供的字段：`sdk/packages/shared/src/hooks/events.ts:120`
- emitter：`sdk/packages/core/src/hooks/hook-file-hooks.ts:1270`（**永不 reject**）
- 自动压缩接线：`services/local-runtime-bootstrap.ts:350` → `runtime/host/local-runtime-host.ts:2490`
- 手动压缩接线（改动前**完全缺失**）：`apps/vscode/src/sdk/sdk-compaction.ts`、
  `apps/cli/src/runtime/interactive/compaction.ts`

> 修正一处报告认知：hook payload 走 **stdin**，并非 `CLINE_HOOK_PAYLOAD_FILE` 环境变量；
> 且 `runAsyncHookCommands` 是 fire-and-forget（`hook-file-hooks.ts:716-737`，`detached: true`）。
> 断言 hook 真正执行必须轮询产物，不能在 `emit()` 返回后直接读文件。

#### 验证结果

| 套件 | 结果 |
|---|---|
| `@cline/shared` / `ui` / `agents` / `llms` / `cline-hub` | 240 / 12 / 72 / 448 / 98 全通过 |
| `@cline/core` | 1879 + 5 通过 |
| `apps/vscode` vitest | 83 文件 / 990 通过 |
| `webview-ui` | 52 文件 / 457 通过 |
| `bun run build:sdk`、`cd sdk && bun run types`、根 `bun run lint` | 全部通过 |

**遗留（与本次改动无关，已实证）**：`apps/cli` 的 vitest 在 Windows 上单跑会挂起。已用
`git stash` 在干净 HEAD 上复现，确认为预先存在；分片运行可绕开。另有 2 处 Windows 专属
失败（`update.test.ts` 路径分隔符、`bin-wrapper.test.ts` shell 退出码），均在未改动的文件中。

### 第一梯队（高杠杆、低成本）

| # | 事项 | 依据 | 预估 | 状态 |
|---|---|---|---|---|
| 1 | 打开并行工具执行 | `maxParallelToolCalls` 零引用，runtime 已就绪 | 天级 | ✅ 已落地 |
| 2 | 工具契约加 `isConcurrencySafe(input)` | 对齐按参数判定；**#1 的前置安全条件** | 周级 | 🟡 部分（定义级，非参数级） |
| 3 | `read_files` / `run_commands` 接 `emitUpdate` | 通路已通，只差调用 | 周级 | ⬜ 未做 |
| 4 | CLI 补 `maxIterations` + `budget` | `apps/cli/src/main.ts:1076-1132` 补两字段 | 天级 | ✅ 已落地 |
| 5 | provider 重试分类下沉到 core | 从 `sdk-session-lifecycle.ts:53-72` 下沉，CLI 复用 | 周级 | ✅ 已落地（落至 `@cline/llms`） |
| 6 | VS Code `McpHub` 已取的 resources/prompts 接入 agent | 数据已在手，只差接线 | 周级 | ⬜ 未做 |
| 7 | 发射 `PreCompact` 事件 | 模板已写好（`core/hooks/templates.ts:414`） | 天级 | ✅ 已落地 |

### 第二梯队（架构级）

| # | 事项 | 说明 |
|---|---|---|
| 8 | 子 agent 后台化 + 并发上限 + 嵌套深度限制 | 对齐 Claude 运行形态 |
| 9 | per-subagent git worktree 隔离 | 团队并发编辑的硬需求 |
| 10 | 工具失败级联取消语义 | 仅对写类工具级联 |
| 11 | MCP 会话热增删工具 | 现必须重启会话（`SdkController.ts:722-725`） |
| 12 | 推测执行（流式解析到即开跑） | 执行层最大的一块 |

### 第三梯队（产品决策）

| # | 事项 | 说明 |
|---|---|---|
| 13 | teams / hub 默认策略重新评估 | 有 18 个团队工具但 IDE 默认关 —— 要么默认开、要么收敛，现状两头不讨好 |
| 14 | 云端定时执行 | 对标 Routines，架构级投入 |
| 15 | 网络沙箱 | 现仅有文件边界，无网络限制 |

---

## 6. 本报告的局限

1. 竞品数据非实测，见 §0.1。
2. 竞品产品身份在变，见 §0.2。
3. 未做基准测试。本报告比实现能力，不比任务成功率。
4. 矩阵图例为能力可达性，非默认行为，见 §0.4。

---

*生成于 2026-10-02。§3 中所有 `[实测]` 结论可按 `file:line` 直接复核。*
