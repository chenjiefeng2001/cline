# Cline 与主流 Agent 工具级对比（2026-10-03）

> 生成时间：2026-10-03
> 基线：`main` @ `739f21ebf4` + 本轮未提交改动
> 关联：`…-matrix-2026-10-03.md`（能力矩阵）、`…-review-2026-10-03.md`（复核）

## 0. 数据来源与可信度

| 对象 | 来源 | 可信度 |
|---|---|---|
| **Cline** | 本仓源码实测 | **高** —— 带 `file:line`，可复核 |
| Claude Code | `code.claude.com/docs/en/tools-reference`（官方文档）+ 第三方镜像 | **中高** —— 官方文档，但闭源无法验证行为 |
| Codex CLI | `github.com/openai/codex` 源码模块 + issue #4443 | **高** —— 开源，模块名可查 |
| Gemini CLI | `github.com/google-gemini/gemini-cli/docs/reference/tools.md` | **高** —— 开源 |

> ⚠️ 竞品**工具名与参数**可信（文档/源码级），但**运行时行为**（是否并行、是否流式、
> 失败如何处理）多为文档描述或社区观察，未实测。

---

## 1. 工具总数对比

| Agent | 工具总数 | 专用文件工具 | 专用搜索工具 | Shell | 委派 | 任务管理 |
|---|---|---|---|---|---|---|
| **Cline** | **10 内置 + 18 team_** | 4（read_files/editor/glob 等） | 2（search_codebase/glob） | 1（run_commands） | 1（spawn_agent） | ○ |
| Claude Code | ~35 | 4（含 NotebookEdit） | 3（Glob/Grep/LSP） | 3（Bash/PowerShell/Monitor） | 1（Agent） | 6+ |
| Codex CLI | **4** | 0（无独立 read/write/edit） | 0 | 1（shell 兼一切） | 0 | 1（update_plan） |
| Gemini CLI | ~20 | 4 | 2 | 1 | 0 | 7（tracker_*） |

**关键结论**：Cline 的工具总数处于中位，但**结构与主流差异显著**——
Claude Code 走「细粒度专用工具」，Codex 走「极简 + shell 兜底」，
Cline 与 Gemini CLI 更接近「中等粒度」。

---

## 2. 逐能力映射

图例：**●** 有 · **◐** 部分/间接 · **○** 无

### 2.1 文件操作

| 能力 | Cline | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| 读单文件 | ● `read_files` | ● `Read` | ◐ 经 shell | ● `read_file` |
| 批量读 | ● 同工具多路径 | ◐ 多次调用 | ◐ | ● `read_many_files` |
| 行范围读 | ● `start_line/end_line` | ● | ◐ | ● |
| 读图片 | ● | ● | ● `view_image` | ● |
| 读 PDF | ○ | ● | ◐ | ● |
| 读 Notebook | ○ | ● `NotebookEdit` | ○ | ○ |
| 写文件 | ● `editor` | ● `Write` | ◐ 经 shell | ● `write_file` |
| 定向编辑 | ● `editor` | ● `Edit` | ● `apply_patch` | ● `replace` |
| **列目录** | ◐（`glob` 近似） | ◐（Glob 近似） | ◐ | ● `list_directory` |
| **文件名 glob** | **● `glob`** | ● `Glob` | ○（社区诉求） | ● `glob` |

> **2026-10-04 已补齐**：`glob` 已作为内置工具落地
> （`sdk/packages/core/src/extensions/tools/executors/glob.ts`），
> 复用 `search_codebase` 的工作区文件索引，因此可见性规则一致、
> 无需额外目录遍历，且不存在越出工作区的可能（结果恒为工作区相对路径）。
> `*`/`?` 不跨目录段、`**` 跨目录、`[a-z]` 字符类；
> 无 `/` 的模式按任意深度的文件名匹配。单次最多 200 条、输出上限 24k 字符（中间截断）。

### 2.2 搜索与代码理解

| 能力 | Cline | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| 内容正则搜索 | ● `search_codebase` | ● `Grep` | ◐ 经 shell | ● `grep_search` |
| 多查询并行 | ● 数组入参 | ● | ◐ | ◐ |
| 包含/排除模式 | ○ | ◐ | ◐ | ● `include_pattern`/`exclude_pattern` |
| 结果模式（仅文件名/计数） | ◐ 中间截断 | ● 3 种 | ◐ | ● `names_only`/`max_matches_per_file` |
| **LSP 代码智能** | **○** ← 最大缺口 | ● `LSP` | ○ | ○ |
| gitignore 感知 | ● | ● | ◐ | ● `respect_git_ignore` |

> **实测**：全仓无 `languageServer` / `gotoDefinition` / `findReferences` 实现。
> `LSP` 是 Claude Code 独有的能力（跳转定义、找引用、类型错误），
> **三家主流中只有 Claude Code 有**，Cline 缺失。

### 2.3 Shell 与长任务

| 能力 | Cline | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| 执行命令 | ● `run_commands` | ● `Bash` | ● `shell` | ● `run_shell_command` |
| 多命令一次调用 | ● 数组入参 | ◐ | ◐ | ◐ |
| **后台执行** | ◐ 宿主 TerminalManager | ● `Monitor` | ◐ | ● `is_background` |
| **输出流式回传** | ● VS Code / hub / desktop-app（**CLI 不消费 `emitUpdate`**） | ● | ○ | ◐ |
| 原生 PowerShell | ● Windows 走 pwsh | ● `PowerShell` | ◐ | ○ |

> Claude Code 的 `Monitor`（v2.1.98+）定义为「后台运行命令**并把每一行输出喂回**」。
> 这正是 Cline 为 `run_commands` 补齐的能力 —— 差距已消除，但**宿主覆盖不齐**：
> `apps/cli/src` 对 `emitUpdate` / `content_update` 零引用，CLI 仍是整段返回。

### 2.4 网络

| 能力 | Cline | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| 网页抓取 | ● `fetch_web_content` | ● `WebFetch` | ○ | ● `web_fetch` |
| 联网搜索 | ● 可配 provider | ● `WebSearch` | ○ | ● `google_web_search` |
| **抓取内网地址防护** | ? | ? | ? | ● 文档明示警告 |

> Gemini CLI 官方文档明示 `web_fetch` 可访问 localhost/内网并附安全警告。
> Cline 的 `fetch_web_content` 是否有同等防护**未核实**，标 `?`。

### 2.5 委派与编排

| 能力 | Cline | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| 子 agent | ● `spawn_agent` | ● `Agent` | ○ | ○ |
| **子 agent 后台化** | ○ `await run()` 前台阻塞 | ● | ○ | ○ |
| 嵌套深度限制 | ○ | ● | ○ | ○ |
| 并发上限 | ● `maxConcurrentRuns` | ● | ○ | ○ |
| 团队协作 | ● **18 个 team_\*** | ◐ | ○ | ○ |
| 动态工作流编排 | ○ | ● `Workflow` | ○ | ○ |
| **延迟工具加载** | ○ | ● `ToolSearch` | ◐ `tool_search` | ○ |

> **`ToolSearch` 是值得注意的设计**：Claude Code 与 Codex 都在做「工具太多导致
> 上下文膨胀 → 按需检索加载」。Cline 有 28 个内置工具 + 18 个 team 工具，
> 且**无任何延迟加载机制**，全部工具描述常驻上下文。
> 这是 token 效率上的结构性劣势，也是 2026-10-04 之后优先级最高的待办：
> 本轮新增的 `glob` 与 3 个 MCP 目录工具会略微增加该成本，
> 但也提供了现成的试验对象（按 server / 按用途分组检索）。

### 2.6 计划与任务管理

| 能力 | Cline | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| 计划模式 | ● | ● `EnterPlanMode`/`ExitPlanMode` | ● `update_plan` | ● |
| 任务清单 | ○ | ● 6 个（Task* + TodoWrite） | ◐ | ● 7 个 `tracker_*` |
| **定时任务** | ● core/cron 完整实现 | ● `CronCreate/List/Delete` | ○ | ○ |

> **Cline 在定时任务上反超**：实测 `sdk/packages/core/src/cron/` 有
> events / reports / runner / schedule / service / specs 六个子模块 + 完整测试，
> 覆盖面不窄于 Claude Code 的 `Cron*` 三工具。

### 2.7 MCP 生态

| 能力 | Cline | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| MCP tools | ● | ● | ● | ● |
| **MCP resources** | **●**（仅 VS Code 宿主）`list_mcp_resources` + `read_mcp_resource` | ● `ListMcpResourcesTool` + `ReadMcpResourceTool` | ◐ | ◐ |
| **MCP prompts** | **●**（仅 VS Code 宿主，仅列举） | ● | ◐ | ◐ |

> ⚠️ **宿主限定（重要）**：SDK 层 MCP（`core/src/extensions/mcp/`）**只有 tools 能力**，
> `client.ts` 声明的 `capabilities` 为空。resources/prompts 能力只存在于宿主侧的
> `apps/vscode/.../McpHub.ts`，因此 CLI / hub / desktop-app / ACP 即使连接了
> MCP server 也**拿不到** resources/prompts。跨宿主对齐需要把该能力下沉到 SDK MCP 层。

> **2026-10-04 已补齐**：原缺口是「`McpHub.ts:852/895` 已能取到
> resources/prompts，但无 agent 工具暴露」，是唯一一个「数据已到手、只差接线」
> 的缺口。现补 `McpHub.listAllResources()` / `listAllPrompts()` 跨 server 聚合接口
> （单 server 故障返回空而不影响其他 server 的清单），并新增 3 个工具
> （`apps/vscode/src/sdk/mcp-resource-tools.ts`）：`list_mcp_resources`、
> `read_mcp_resource`、`list_mcp_prompts`，经 `createVscodeExtraTools` 注入。
> 资源正文上限 100k 字符（头尾保留 + 截断提示）；读取失败返回原因而非抛错，
> 让模型改试其它 URI 而不是中断整轮。
>
> 刻意**未**暴露 prompt 执行：`getPrompt` 返回 message 列表，
> 把它拼进 transcript 与「工具调用」是两种不同语义，属产品决策；
> 列举无歧义，执行有歧义。

### 2.8 环境隔离

| 能力 | Cline | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| git worktree 隔离 | ◐ 任务级 | ● `EnterWorktree`/`ExitWorktree` | ◐ | ○ |
| per-subagent worktree | ○ | ● | ○ | ○ |
| 沙箱 | ◐ 文件边界 | ◐ | ● 强 | ◐ |

---

## 3. Cline 相对各家的净差距

### 3.1 落后于 Claude Code

| 缺口 | 严重度 | 工作量 | 说明 |
|---|---|---|---|
| ~~**文件名 glob**~~ | — | — | **2026-10-04 已落地**：`executors/glob.ts`，复用工作区索引 |
| **LSP 代码智能** | **高** | 大 | 唯一只有 Claude Code 有的能力，需接 language server |
| **延迟工具加载** | 中 | 中 | 28 个内置 + team 工具全量常驻，token 效率劣势 |
| 列目录 | 中低 | 极小 | 可由 glob 部分覆盖 |
| Notebook / PDF 读 | 低中 | 中 | 取决于目标用户是否需要 |
| 子 agent 后台化 | 中 | 大 | 架构级 |
| ~~MCP resources/prompts~~ | — | — | **2026-10-04 已落地**：3 个工具 + 跨 server 聚合接口 |

### 3.2 落后于 Gemini CLI

| 缺口 | 严重度 | 工作量 |
|---|---|---|
| 任务清单（7 个 `tracker_*`） | 中 | 中 |
| 搜索的包含/排除与结果模式 | 中低 | 小 |

### 3.3 领先之处

| 能力 | 说明 |
|---|---|
| **团队协作工具集（18 个）** | Claude Code 仅有 `Agent` + `Workflow`，无细粒度任务/邮件/outcome 评审 |
| **定时任务子系统** | `core/cron/` 六模块 + 完整测试 |
| **幂等 + 脱敏 middleware** | 已接入工具链，Claude Code 无等价物 |
| **协议面（ACP + A2A + hub daemon）** | 三种集成协议并存 |
| **产物发布（Artifact 类似）** | ○ —— **不领先**，此项 Cline 缺失 |

> ⚠️ 修正：Artifact 一项 Cline 亦缺失，不列入领先。

---

## 4. 建议优先级（结合工作量）

| 序 | 事项 | 依据 | 工作量 | 状态 |
|---|---|---|---|---|
| 1 | ~~**MCP resources/prompts**~~ | 数据已在手（`McpHub.ts:852/895`），Claude Code 有两个专用工具可对标 | 极小 | ✅ 2026-10-04 完成（**仅 VS Code 宿主**，跨宿主见序 3b） |
| 2 | **`glob` 文件名搜索** | 三家主流中两家有；Cline 缺导致模型只能退回 shell | 小 | ✅ 2026-10-04 完成 |
| 3 | **延迟工具加载** | 工具描述全量常驻上下文；Claude Code / Codex 都在做 | 中 | ⏳ 未开始 |
| 3b | **MCP resources/prompts 跨宿主对齐** | 能力目前只在 VS Code 宿主；下沉到 SDK 需先定 resource/prompt 的生命周期、ownership、缓存刷新与权限边界，并决定 ACP/CLI/hub 是否应获得同等能力 —— 属**协议与产品决策**，不是补两个 API | 大 | ⏸ 已记录为架构项，暂缓 |
| 4 | **LSP 代码智能** | 能力密度最高的单项差距 | 大 | ⏳ 未开始 |
| 5 | 任务清单工具 | 对标 Gemini `tracker_*` | 中 | ⏳ 未开始 |
| 6 | 子 agent 后台化 / worktree | 架构级，需专项排期 | 大 | ⏳ 未开始 |

> 1、2 两项落地时各自暴露了一处**治理层缺口**，一并修掉：
> 新工具若不进入宿主的自动批准映射，SDK 会因其「未列出即自动批准」默认值而
> 静默执行 —— 用户关掉「读取文件」后 `glob` 仍会读盘。
> 现 `glob` 归入 readFiles 开关，MCP 三个工具归入 useMcp 开关（VS Code），
> CLI 侧 `glob` 与 `search_codebase` 同列安全自动批准，MCP 工具仍需显式批准。
> 教训：**新增工具的接线清单里必须包含批准策略与 UI 渲染，二者都不是可选步骤。**

---

## 5. 一条方法论观察

做这份对比时，最容易出错的地方是**把「工具有名」当成「能力等价」**。

三个具体例子：

| 表面看 | 实际 |
|---|---|
| Cline 有 `run_commands` ≈ Claude Code `Bash` | 但 Claude Code 另有 `Monitor` 做后台+流式，Cline 本轮才补上 |
| Cline 有 cron ≈ Claude Code `Cron*` | 方向相反 —— cron 是 Cline **领先**项 |
| Cline 有 `search_codebase` ≈ Claude Code `Grep` | 但 Cline 无 `include_pattern`/`names_only`（`Glob` 已于 2026-10-04 补齐） |

因此本文所有对照都按「**能力维度**」而非「工具名」组织，并在每一行标注
该能力的**真实差距**，而不是简单打勾。

---

## 6. 局限

1. **竞品运行时行为未实测**。工具清单与参数可信（文档/源码级），
   但"是否并行""失败如何处理""是否流式"多为文档描述。
2. **版本漂移**。Claude Code 工具集在 2026 年内多次变更（如 `TodoWrite`
   在 v2.1.142 被 `Task*` 取代、`TaskOutput` 在 v2.1.278 移除），
   本表为撰写时点快照。
3. **Cline 侧为实测，但抽样有限**：仅核对了工具清单、输入 schema、
   关键实现路径，未做运行时行为验证。
4. 未做基准测试 —— 本报告比工具面与能力维度，不比任务成功率。

---

*生成于 2026-10-03。Cline 侧结论均可按 `file:line` 复核；竞品侧请以 §0 所列官方
文档与源码为准。*