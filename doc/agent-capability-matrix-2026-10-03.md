# Cline 实现矩阵分析报告（2026-10-03）

> 生成时间：2026-10-03
> 基线：`main` @ `739f21ebf4` + 本轮未提交改动
> 关联：`agent-capability-gap-analysis-2026-10-02.md`（首份快照）、`agent-capability-gap-review-2026-10-03.md`（逐条复核）

## 0. 本报告与前两份的关系

| 报告 | 性质 | 局限 |
|---|---|---|
| `…-2026-10-02.md` | 能力快照 | 单次分析，未反向验证 |
| `…-2026-10-03.md`（复核） | 逐条复核 + 撤回错误结论 | 聚焦复核，未重做矩阵 |
| **本文** | **重建矩阵 + 标注可达性** | 竞品侧非实测 |

**证据分级**：
- **[实测]** 本轮读出代码确认，带 `file:line`
- **[沿用]** 前序报告结论，本轮未复核
- **[竞品]** 竞品官方文档 / 第三方逆向拆解 —— **非实测**

> ⚠️ 竞品侧沿用 `…-2026-10-02.md` §0.1 的免责声明：Claude Code 闭源，Codex /
> Antigravity 本次未安装。凡涉及竞品内部实现（分批算法、推测执行细节）均为
> **[竞品]** 级，可信度中等。

---

## 1. 实现矩阵总览

图例：**●** 已实现且可达 · **◐** 部分/保守实现 · **○** 缺失 · **?** 无法判定

### 1.1 工具层

| 能力 | Cline | Claude Code | Codex CLI | 说明 |
|---|---|---|---|---|
| 文件读取 | ● `read_files` | ● | ● | 支持行范围分页 [实测] |
| 代码搜索 | ● `search_codebase` | ● | ● | 多 query 并行 |
| **文件名 glob** | ● `glob` | ● | ◐ | 2026-10-04 补齐，复用工作区文件索引 |
| Shell | ● `run_commands` | ● | ● | |
| 网页抓取 | ● `fetch_web_content` | ● | ● | |
| 补丁应用 | ● `apply_patch` | ● | ● | |
| 文件编辑 | ● `editor` | ● | ● | |
| 提问 | ● `ask_question` | ● | ● | |
| **Web 搜索** | ● `fetch_web_content` + 独立 provider | ● | ◐ | 本轮才可配置 [实测] |
| MCP tools | ● | ● | ● | |
| **MCP resources** | ● `list_mcp_resources` + `read_mcp_resource` | ● | ◐ | 2026-10-04 补齐，`McpHub.listAllResources()` |
| **MCP prompts** | ● `list_mcp_prompts`（仅列举） | ● | ◐ | 2026-10-04 补齐；执行属产品决策，未做 |
| 并行工具执行 | ● | ● | ● | VS Code / CLI 默认 6；**ACP 与 desktop-app 未设置 → 串行** |
| 并发安全契约 | ◐ 定义级 | ◐ 参数级 | ? | 见 §3.1 |
| 工具输出流式 | ● 本轮落地 | ● | ◐ | 见 §5.3（复核报告） |
| 工具失败级联取消 | ○ | ● 仅 Bash | ○ | |
| 推测执行 | ○ | ● | ? | 执行层最大缺口 |

**工具总数**：Cline 内置 **10 个**（`ALL_DEFAULT_TOOL_NAMES`，实测，2026-10-04 新增 `glob`）
+ **18 个 `team_*`**（`team-tools.ts`，实测，确认为 18）
+ **3 个 MCP 目录工具**（`list_mcp_resources`/`read_mcp_resource`/`list_mcp_prompts`，
由宿主经 `createVscodeExtraTools` 注入，不计入 SDK 内置清单）。

### 1.2 多智能体

| 能力 | Cline | Claude Code | 说明 |
|---|---|---|---|
| 子 agent 委派 | ● `spawn_agent` | ● | |
| **子 agent 后台化** | ○ | ● | `spawn-agent-tool.ts:164` 是 `await subAgent.run()`，**前台阻塞** |
| 嵌套深度限制 | ○ | ● | 无 `maxDepth` 概念 |
| 并发上限 | ● `maxConcurrentRuns` | ● | `multi-agent.ts:563`，默认 2 [实测] |
| 团队工具集 | ● 18 个 | ◐ | Cline 在此**广度反超** |
| per-subagent worktree | ○ | ● | |
| **agent 间协议调用** | ○ | ● | `a2a/` 是 **session 传输层**，非 agent 间工具调用（见 §3.2） |

> **修正前序报告**：称"无并发上限"已过时 —— `maxConcurrentRuns` 存在（实测）。

### 1.3 上下文与记忆

| 能力 | Cline | Claude Code | 说明 |
|---|---|---|---|
| 自动压缩 | ● 三策略 | ● | |
| 压缩阈值可配 | ● 本轮 | ◐ | |
| PreCompact hook | ● 本轮 | ● | 含两处手动压缩路径 |
| 跨会话记忆 | ◐ 本轮可配 | ● | 4 个开关，写路径默认关 |
| 语义缓存 | ? | ● | 未核实 |
| **7M+ token 会话稳定性** | **?** | ● | 本轮日志出现 7,425,637 input tokens 的会话（复核报告 §1） |

### 1.4 执行控制与护栏

| 能力 | Cline | Claude Code | 说明 |
|---|---|---|---|
| 迭代上限 | ● 三宿主均有（VS Code 0=无限制；CLI/ACP 默认 50） | ● | ACP 已于 2026-10-04 补齐（§7.4） |
| 费用上限 | ● 三宿主均有（VS Code 0=无上限；CLI/ACP 默认 $5） | ● | 同上；`0` 语义仅 VS Code 存在 |
| 并发工具上限 | ● VS Code / CLI；**ACP 仍为串行回落** | ● | 按决策**不**在护栏轮次内改动 |
| 连续失误上限 | ● | ● | |
| 审批 | ● | ● | |
| YOLO 模式 | ● | ● | |
| **工具调用数上限** | ○ | ◐ | 唯一未覆盖的轴（见 §4.1） |
| 幂等 middleware | ● | ? | 已接线 |
| 脱敏 middleware | ● | ? | 已接线 |
| **预算/审批/重试 middleware** | ◐ 已被取代 | — | 见复核报告 §4.1 |

### 1.5 可观测性

| 能力 | Cline | Claude Code | 说明 |
|---|---|---|---|
| OpenTelemetry | ● | ● | |
| 工具幂等账本 | ● | ? | |
| 敏感信息脱敏 | ● | ? | |
| 成本追踪 | ● | ● | |
| **流式审计 hook** | ● | ● | 10 个事件 |
| 断点续跑 | ● | ● | |

### 1.6 宿主与集成

| 能力 | Cline | Claude Code | 说明 |
|---|---|---|---|
| IDE 扩展 | ● | ● | |
| 独立 CLI | ● | ● | |
| ACP（编辑器协议） | ● | ◐ | `program.ts:76` |
| 常驻守护进程 | ● hub daemon | ● | |
| 多端会话 | ● | ● | |
| **Web / 浏览器端** | ○ | ◐ | |

---

## 2. Hook 事件覆盖

实测 `HookEventNameSchema` 共 **10 个**（`sdk/packages/shared/src/hooks/events.ts`）：

```
agent_start    agent_resume    agent_abort    agent_end    agent_error
tool_call      tool_result     prompt_submit  pre_compact  session_shutdown
```

**评估**：覆盖面与 Claude Code 的 hook 体系基本对齐（Claude Code 同样以
PreToolUse/PostToolUse/SessionStart/SessionEnd 为主轴 [竞品]）。Cline 的
`agent_*` 四事件提供了更细的 agent 生命周期粒度。

**唯一缺口**：无 `pre_compact` 之外的压缩后事件（`post_compact`），压缩结果无法被 hook 观察。

---

## 3. 需要澄清的三处误解

前序报告与我在复核过程中都曾误判，此处记录以免复发。

### 3.1 并发安全是"定义级"而非"参数级"，但这是**保守而非缺陷**

Cline 的 `concurrency: "safe" | "exclusive"` 按**工具定义**判定（默认 exclusive，
仅 `read_files`/`search_codebase`/`glob` 声明 safe）。Claude Code 的
`isConcurrencySafe(parsedInput)` 按**入参**判定。

**但这不是能力差距**：按定义判定更保守——同一工具的不同入参不会分开判定，因此
不存在"同一工具一半并发一半串行"的风险状态。代价只是拿不到部分优化。

**建议**：明确记录为「有意为之的保守取舍」，而非「未完成」。

### 3.2 A2A 是传输层，不是 agent 间调用

`hub/a2a/` 提供 `a2a-http.ts` / `a2a-jsonrpc.ts` / `a2a-sse.ts` / `a2a-server.ts`，
容易被误读为"已实现 agent 间通信"。实测其用途：`local-runtime-host.ts:438` 把
`source === "a2a"` 用作 **session 来源标记**（影响 recovery 准入判断）。

**结论**：Cline 有 A2A 传输协议，**没有** agent 通过该协议互相调用的工具面。

### 3.3 并发上限已存在

前序报告 §3.6 称子 agent "无并发上限"。实测 `multi-agent.ts:563` 有
`maxConcurrentRuns`（默认 2）。该结论已过时。

---

## 4. 差距排序（按严重度，非杠杆）

### P0 — 安全 / 费用 / 数据外发

| # | 事项 | 状态 |
|---|---|---|
| A | 三个 middleware 未接入 | ✅ **已撤回**：非缺陷（复核报告 §4.1） |
| B | `fileBoundaryEnabled` 默认语义 | ⚠️ **待确认**：默认 `true`，但注释警告关闭后可触达任意路径 |
| C | `webSearchEnabled` 外发旁路 | ⚠️ **待审计**：关闭状态下的 query 外发路径需确认 |

B、C 需要的是**确认与审计**，不是实现。

### P1 — 执行层

| # | 事项 | 严重度 | 工作量 |
|---|---|---|---|
| D | 子 agent 后台化 | 中（长任务体验） | 大（架构级） |
| E | 嵌套深度限制 | 中（失控风险） | 小 |
| F | **MCP resources/prompts** | 中（生态兼容） | **小**（数据已在手） |
| G | 工具调用数上限 | 中 | 小（需产品决策） |
| H | 推测执行 | 中 | 大 |

### P2 — 产品决策

| # | 事项 |
|---|---|
| I | teams 默认策略（18 工具 vs 默认关，两头不讨好） |
| J | 云端定时执行 |
| K | 网络沙箱（仅有文件边界，无网络限制） |

---

## 5. 核心判断

### 5.1 Cline 的真实优势

1. **工具面广度在团队维度反超**：18 个 `team_*` 工具（任务、邮件、任务日志、
   outcome 评审）比 Claude Code 的团队能力更细。
2. **可配置性已追平**：本轮补齐 16 项行为设置的三通道后，护栏（迭代/费用/并发/
   边界）均可配置。**这一项此前反而是落后于主流的**。
3. **协议层完整**：ACP + A2A + hub daemon + OTel，集成面比单一形态竞品更宽。
4. **Hook 粒度细**：`agent_*` 四事件提供 agent 生命周期观测。

### 5.2 真实短板

1. **执行层打磨**：推测执行、子 agent 后台化、工具失败级联 —— 三项均缺。
2. **MCP 生态已用满**（2026-10-04 更新）：tools 完整，resources/prompts 已暴露为
   3 个工具；剩余差距只在 prompt 的**执行**语义，属产品决策。
   ⚠️ **宿主限定**：这三个工具仅存在于 `apps/vscode`（宿主侧的 `McpHub`）。
   SDK 层 MCP（`core/src/extensions/mcp/`）**只有 tools 能力**，
   `client.ts` 的 `capabilities` 为空，因此 CLI / hub / desktop-app / ACP
   即使接了 MCP server 也拿不到 resources/prompts。
3. **超长会话稳定性存疑**：本轮日志出现 742 万 input token 的会话，且伴随多次
   401（复核报告 §4 已定位为认证错误被文本吞掉的缺陷，已修复）。
4. **网络沙箱缺失**：文件边界已实现并本轮可配，但无网络层限制。
5. **OS 级沙箱已实现但接线不全**（2026-10-04 新增记录）：
   `core/src/runtime/sandbox/process-sandbox-runtime.ts`（Seatbelt/bubblewrap，
   workspace-write，fail-closed）已实现并从 `core/src/index.ts` 导出，
   但仅 CLI 通过 `CLINE_SANDBOX=1` / `--data-dir` 启用；
   **ACP 硬编码 `sandbox: false` 且无任何开启途径**，VS Code 完全未引用。
   报告此前记为「沙箱 ◐ 仅文件边界」，低估了现状。

### 5.3 方法论教训（本轮最重要产出）

本轮连续三次踩同一类错误的变体：

| 轮次 | 错误 | 根因 |
|---|---|---|
| 1 | 16 项设置"已接线但不可配" | 只验证 `CoreSessionConfig` 读取，未验证**写入通道** |
| 2 | 三个 middleware"未接入"判为缺陷 | 只看**文件存在/引用**，未核对**功能是否已被别处实现** |
| 3 | `emitUpdate`"已实现" | 只验证 **SDK 内部链路连续**，未检查**宿主/UI 消费端** |
| 4 | 新增 `glob` 只登记 `ALL_DEFAULT_TOOL_NAMES` | 漏了 `core/src/extensions/tools/runtime.ts` 的**权威工具目录**，导致该工具无法被关闭、allowlist 直接抛错、ACP/headless 静默消失 |

**统一教训**：验证一个能力"可用"，必须走完**从定义到用户可见的完整链路**，
且在链路的**两端**各验一次：

```
定义/契约 → 运行时接线 → 事件转发 → 宿主消费 → UI 渲染 → 用户可见
   ↑                                                    ↑
  只查这端不够                                  只查这端也不够
```

第 4 次补充了一条**清单式教训**：新增内置工具时，`ALL_DEFAULT_TOOL_NAMES`
与 `runtime.ts` 的 `BASE_TOOL_CATALOG` / `TOOL_NAME_TO_FLAG` 必须同步，
后者驱动 `cline config tools`、`/config` 开关、allowlist 校验与 ACP/headless 工具名派生。
漏改的后果是**静默**的，因此 `runtime.test.ts` 现有一条断言
「每个默认工具名都必须能在目录中找到（或被显式归类为 routing 别名 / opt-in 排除）」，
把这条清单固化为测试。

### 5.4 各宿主对齐现状（2026-10-04 新增）

同一份能力在不同宿主并不等价，下表为实测：

| 能力 | VS Code | CLI | ACP | hub / cline-hub | desktop-app |
|---|---|---|---|---|---|
| `glob` | ● | ● | ●（已登记 kind） | ● | ● |
| MCP resources/prompts | ● | ○（SDK MCP 仅 tools） | ○ | ○ | ○ |
| 工具输出流式 | ● | **○（CLI 不消费 `emitUpdate`）** | ○ | ● | ● |
| 迭代/预算护栏 | ● | ● | **●（2026-10-04 补齐）** | — | 仅 `maxIterations` |
| 并行工具默认 | 6 | 6 | 串行回落（有意保留） | — | 未设置 |
| OS 级沙箱 | 未引用 | 可选（env/flag） | **硬编码关闭且不可开启** | 未引用 | 未引用 |

---

## 6. 建议的实施顺序

1. ~~**#F MCP resources/prompts**~~ —— ✅ 2026-10-04 完成（3 个工具 + 跨 server 聚合）。
2. ~~**文件名 glob**~~ —— ✅ 2026-10-04 完成（`executors/glob.ts`）。
3. **延迟工具加载** —— 当前最高优先级的结构性差距；新增的 `glob` 与 MCP 目录工具
   略微推高常驻描述成本，可作为分组检索的试验对象。
4. **#E 嵌套深度限制** —— 小工作量，防失控。
5. **#B/#C 审计** —— 确认默认值与旁路，非实现工作。
6. **#I teams 默认策略** —— 产品决策，建议明确取舍而非维持现状。
7. **#D/#H** —— 架构级投入，需专项排期。
8. **#G 工具调用数上限** —— 需先定默认值，且须与迭代上限取向一致
   （当前迭代默认无限制，若加工具数上限会限错轴）。

---

## 7. 本报告的局限

1. **竞品侧全部为非实测**。矩阵中 Claude Code / Codex CLI 列的可信度等同于
   `…-2026-10-02.md`，建议自行安装对照。
2. **未做基准测试**。本报告比的是实现能力与可达性，不比任务成功率。
3. **语义缓存（1.3）标 `?`**：本轮未核实 Cline 是否有 provider 侧提示缓存，
   不排除存在但未接线的同类问题（参见 §5.3 教训）。
4. **7M token 会话稳定性标 `?`**：仅观察到该会话存在，未复现。
5. 竞品产品身份仍在变动（Gemini CLI → Antigravity CLI、Q Developer → Kiro CLI），
   半年后命名可能再次变化。

---

*生成于 2026-10-03。§1、§2、§3 中所有 `[实测]` 结论可按 `file:line` 直接复核。*