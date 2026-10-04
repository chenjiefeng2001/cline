# Cline 能力差距复核报告（2026-10-03）

> 生成时间：2026-10-03
> 基线：`main` @ `739f21ebf4` + 本轮未提交改动（65 文件）
> 前序报告：`doc/agent-capability-gap-analysis-2026-10-02.md`（下称「前序报告」）

## 0. 本报告的定位与证据分级

前序报告是一次**能力快照**。此后落地了一批改动，快照的若干结论已失效。本报告
**只做一件事**：逐条复核前序报告的每个结论，标注它今天还成不成立，并给出新的差距
清单。

- **[实测]** = 本轮重新读出代码确认，带 `file:line`
- **[沿用]** = 前序报告结论，本轮未复核
- **[竞品]** = 竞品官方文档或第三方逆向拆解，非实测

**本报告不重做竞品分析**。竞品侧的判断沿用前序报告 §0.1 的免责声明：Claude Code
闭源，Codex / Antigravity 本次未安装。

---

## 1. 核心结论

**前序报告的最大判断依然成立**：Cline 的能力广度超过头部玩家，短板在「可达性」
与「执行层打磨」。

但本轮暴露了一个前序报告**没有识别到的系统性缺陷**，它比任何单个功能缺口都重要：

> **仓库里存在大量「注释和 state 描述了一套行为，实际接线不完整」的条目。**
> 典型形态是：值被 `CoreSessionConfig` 读取、`state-keys.ts` 有注释说明用户该
> 怎么配，但**没有任何写入通道**——既不在 `package.json` 里声明，也不在设置
> 对话框里，甚至不在 `UpdateSettingsRequest` proto 消息里。

本轮实测发现 **16 项行为设置处于这种状态**，其中包括：

| 类型 | 设置 | 为什么严重 |
|---|---|---|
| 安全边界 | `fileBoundaryEnabled`、`fileBoundaryAdditionalRoots` | 文件工具的工作区边界只能靠手改 state 文件 |
| 费用边界 | `runBudgetMaxTotalCost` | 唯一能阻止单次运行烧掉大量费用的开关不可配 |
| 数据外发 | `webSearchEnabled` | 一个会把模型 query 发给第三方的开关，无法从 UI 关闭 |

这不是「功能没做」，是**做了一半而用户不知道**。前序报告 §3 逐条分析能力有无，
没有反向审计「已声明的东西是否真的可配」，因此漏掉了这一整类。

**该类问题本轮已全部修复**（见 §3），并加了一条 drift guard 测试防止复发。

---

## 2. 前序报告 §5 路线图的逐项复核

### 2.1 第一梯队

| # | 事项 | 前序报告判断 | 本轮实测状态 |
|---|---|---|---|
| 1 | 并行工具执行 | 已实现但零引用 | ✅ **已落地**，双宿主默认 6 |
| 2 | 工具安全契约 | 需参数级 `isConcurrencySafe(input)` | 🟡 **部分**：定义级已落地，参数级未做 |
| 3 | `read_files` / `run_commands` 接 `emitUpdate` | 通路已通，零调用 | ✅ **已落地**（SDK + 宿主 + UI 全链路，§5.3） |
| 4 | CLI 迭代 / 预算上限 | 缺两字段 | ✅ **已落地**（CLI 与 VS Code 双侧） |
| 5 | provider 重试分类下沉 | CLI 零自动重试 | ✅ **已落地**（下沉至 `@cline/llms`） |
| 6 | MCP resources/prompts 接入 | 数据已在手，差接线 | ✅ **已落地**（3 个工具 + 聚合接口，§6.1） |
| 7 | 发射 `PreCompact` 事件 | 模板已写好 | ✅ **已落地**（含两处手动压缩路径） |

**5 项落地、1 项部分、0 项未动。**（#3 原为「部分」，本轮补齐宿主与 UI 后转为落地；
#6 于 2026-10-04 补齐，见 §6.1。）

### 2.2 第二、三梯队

全部 **8 项无变化**（[实测]逐一确认）：

| # | 事项 | 复核方式 | 结论 |
|---|---|---|---|
| 8 | 子 agent 后台化 / 并发上限 / 嵌套深度 | 搜 `maxDepth` / `depthLimit` 于 core 非测试代码 | 无实现 |
| 9 | per-subagent git worktree 隔离 | 搜 `worktree` | 仅 checkpoint / session-versioning 使用，**无 per-subagent 隔离** |
| 10 | 工具失败级联取消 | 搜 `cancelSibling` / `cascade` / `sibling` 于 `agent-runtime.ts` | 无实现 |
| 11 | MCP 会话热增删工具 | 搜 `restartRequired` / `requiresRestart` | 无实现 |
| 12 | 推测执行 | 搜 `speculat` 于 `agent-runtime.ts` | 无实现 |
| 13 | teams / hub 默认策略 | — | 未动（且本轮**已让 `agentTeamsEnabled` 可配**，见 §3.2） |
| 14 | 云端定时执行 | — | 未动 |
| 15 | 网络沙箱 | 搜 `networkSandbox` / `egress` | 仅 `types/config.ts:54` 一处类型声明，无实现 |

---

## 3. 本轮新增的落地项（前序报告未覆盖）

### 3.1 能力项

| 项 | 内容 | 位置 |
|---|---|---|
| 流式认证失败不再被吞 | 401 在消息入 transcript **前**抛出，让既有 `runWithAuthRetry` 接管刷新重试 | `sdk/packages/agents/src/agent-runtime.ts:1222` |
| ACP 路径重试 | ACP `prompt()` 接入重试，且接受 `AbortSignal`（cancel 后不再空等退避） | `apps/cli/src/acp/acpAgent.ts:230` |
| 手动压缩的 `pre_compact` | VS Code 与 CLI 的手动 `/compact` 此前**完全不发射**该事件 | `sdk-compaction.ts`、`interactive/compaction.ts` |

### 3.2 可配置性（本报告第 1 节的核心问题）

修复前 → 修复后的三通道覆盖：

| 通道 | 修复前 | 修复后 |
|---|---|---|
| `package.json` 声明 | 17 项 | **32 项** |
| `SETTINGS_SCHEMA_MAP` 映射 | 17 项 | **32 项** |
| 设置对话框 | 6 项（行为类） | **16 项** |
| `UpdateSettingsRequest` proto | 缺 14 字段 | 已补（48–61） |

防复发措施：

- **`vscode-settings-bridge.test.ts`** 新增 drift guard：读 `package.json`，断言每个
  声明的 key 都有映射。这正是本次缺陷的成因机制。
- **`updateSettings.test.ts`**（新建，10 测试）覆盖写入侧，含 `0` 与非法值的处理。

### 3.3 宿主健壮性（本轮定位并修复）

| 问题 | 根因 | 位置 |
|---|---|---|
| `apps/cli` 测试永久挂起 | `openSync(目录, "a")` 在 Windows 上**成功**，目录被当成日志文件传给 pino，sonic-boom 流永不关闭，事件循环排不空 | `apps/cli/src/logging/adapter.ts` |
| 文件提及在 Windows 完全失效 | 正则只认 `/ ~/ ./ ../`，**不认盘符**，`@C:\path` 不被识别 | `apps/cli/src/runtime/prompt.ts` |
| `bin/cline` 无法执行脚本 | Windows 无 shebang 支持，`CreateProcess` 亦不能直接跑 `.cmd` | `apps/cli/bin/cline` |

---

## 4. 仍未闭合的差距（按严重度重排）

前序报告按「杠杆」排序。本轮发现严重度与杠杆并不一致——**安全与费用边界类问题
的杠杆低但严重度高**，应优先于架构级投入。

### P0 — 安全 / 费用 / 数据外发

| # | 事项 | 现状 | 证据 |
|---|---|---|---|
| ~~A~~ | ~~三个 middleware 未接入链路~~ | ❌ **本轮撤回:非缺陷**。详见 §4.1 | — |
| B | `fileBoundaryEnabled` 默认值语义 | 本轮才可配。默认 `true`，但注释警告「关闭后 agent 可触达任意路径」——需确认默认值与用户预期一致 | `state-keys.ts:339` |
| C | `webSearchEnabled` 外发 | 本轮才可配。关闭状态下的 query 外发路径需确认无旁路 | `McpHub` / `sdk-compaction` 无关联 |

B、C 需要的是**确认与验证**，不是实现。

### 4.1 撤回：三个未接入的 middleware 不是缺陷

本报告初稿把「`budget` / `approval` / `retry` middleware 文件存在但未接入
`chain`」列为 P0 首位，并称「改动极小、性价比最高」。**该判断错误，已撤回。**

复核后发现三者性质不同：

| middleware | 性质 | 证据 |
|---|---|---|
| `approval` | **已被取代**。runtime 在准备阶段已是唯一审批入口 | `agent-runtime.ts:2235` |
| `retry` | **已被取代**。runtime 已有按工具重试 | `agent-runtime.ts:2562`、`MAX_TOOL_RETRIES = 10`（`:391`） |
| `budget` | **确实缺失**，但缺的是产品决策不是实现 | 全仓无 `maxToolCalls` 实现 |

照初稿建议接线会引入三个真实回归：

1. **重复审批** —— `wrap` 与 runtime 判断同一个 `policy.autoApprove === false`，
   用户会被问两次同一调用。
2. **三重重试** —— 叠加后单次调用最多 `(1 + tool.maxRetries) × (1 + 2)` 次
   尝试（默认可达 33 次），且 middleware 默认 `retryOn` 重试**所有**失败，
   包括 runtime 正确拒绝重试的永久性失败（参数错误、文件不存在）。
3. **凭空新增静默上限** —— `maxToolCalls` 需要用户认可的默认值。凭空设置等于替
   用户截断运行。更矛盾的是：本会话刚把迭代上限改为默认无限制
   （`maxIterationsSetting: 0`），若此时加上限工具调用数的阈值，会限错轴。

**根因是前序报告和我初稿的同类错误**：只看到「文件存在但未接入」，没有核对
功能是否已由别处覆盖。三者更可能是 `[roadmap P1-4]` 时期的备选设计，后来被
runtime 更完整的内建实现取代。

已在三个文件与 `middleware/index.ts` 顶部标注原因（superseded / 需产品决策），
避免后续再次被误判为待办。**删除与否留作独立决策**——它们有导出、有文档、有测试。

### P1 — 执行层

| # | 事项 | 现状 |
|---|---|---|
| D | #2 参数级并发安全判定 | 当前按**工具定义**判定。同一工具不同入参不分开判定，因此更保守（无写冲突风险），但拿不到「部分入参可并发」的收益 |
| E | #3 工具输出流式 | ✅ **本轮落地**：`read_files` 每文件进度、`run_commands` 输出行（含节流与尾部 flush）均可渲染 |
| F | #6 MCP resources/prompts | ✅ **2026-10-04 落地**：新增 `list_mcp_resources`/`read_mcp_resource`/`list_mcp_prompts`，并补 `McpHub.listAllResources()`/`listAllPrompts()` 跨 server 聚合（§6.1）。prompt **执行**仍未暴露，属产品决策 |
| G | #2 层级推测执行 | 未实现。这是执行层最大的一块 |

### P2 — 架构 / 产品决策

第二、三梯队 8 项全部未动，见 §2.2。

---

## 5. 本轮的判断与建议

### 5.1 应当改变的工作方式

前序报告和我前几轮的做法都是「**按功能清单逐条实现**」。本轮暴露的问题说明这个
方式有系统性盲区：

> 实现了功能 ≠ 用户能用上。

建议后续每完成一项「已存在但未接线」的能力，把**三个通道**一起验：
`CoreSessionConfig` 读取 → `UpdateSettingsRequest` 可写 → `ExtensionState` 可读
→ UI 可改。只做第一步就会产生本次这类「看起来做了」的死配置。

**反向盲区同样存在，本报告初稿自己踩了**（§4.1）：看到「文件存在但未接入」就
判定为缺陷，没有先核对功能是否已由别处覆盖。判断「未接线」之前应先确认两件事：

1. 该能力是否已由其他路径实现？（approval / retry 都属于此类）
2. 若确实缺失，缺的是实现还是产品决策？（budget 属于此类）

缺产品决策时，正确做法是标注并上交，而不是自行设定一个默认值。

### 5.3 新发现：`emitUpdate` 通路在宿主末端是断的

前序报告 §3.2 判定 #3 为「通路已通，只差调用方」。**该判断不完整。**

本轮给 `read_files` 与 `run_commands` 接上 `emitUpdate` 后，沿链路追到末端：

```
context.emitUpdate                              (工具内)
  → agent-runtime.ts:2525  → tool-updated       (runtime 转发，通)
  → runtime-event-adapter.ts:233 → content_update (事件翻译，通)
  → message-translator.ts:1177 → break           ← 宿主丢弃，断)
```

`message-translator.ts` 的原注释是：

> For all other tools, content_update is ignored — the content_start message
> with partial=true is sufficient until content_end finalizes it.

这个理由**对「结果即输出」的工具成立**，但不适用于 `emitUpdate` 的用途。partial 的
`say: "tool"` 只承载工具名与入参，`content_end` 才给出结果；而 `read_files` 的
每文件进度、`run_commands` 的输出行**都不是结果本身**。丢掉它们，用户在一条运行数
分钟的构建命令期间看不到任何输出，与卡死无法区分。

**因此「补调用方」不等于「功能可用」。** 本轮的三条观察：

1. **前序报告与我此前的复核都只验证了 SDK 内部链路的连续性**，没有检查宿主与 UI
   消费端。这与我在 §1 批评的「没有反向审计」是同一类错误的另一个方向——只顺着
   链路看「有没有断点」，没看「末端有没有人接」。
2. **hub 路径是通的**（`hub-runtime-host.ts:261` 将 `emitUpdate` 接到 progress 回调），
   所以该能力并非完全无效，只是对 VS Code 主路径无效。
3. **本轮 SDK 侧改动是安全可留存的**：`run_commands` 的返回缓冲未被触碰，
   `execute` 仍返回完整输出，因此是纯增量。但它对 VS Code 界面**无可见效果**。

已在三处标注真实可达性，避免下一个读者重复走一遍：`definitions.ts`（read_files 进度）、
`vscode-run-commands-tool.ts`（输出流）、`message-translator.ts`（丢弃点）。

**待做**：在 `message-translator.ts` 为 `read_files.progress` / `command_output`
生成 partial 消息，并让 webview 渲染增量内容。这不是润色，是该功能缺失的另一半。

**已于本轮补齐**：`content_update` 现在对这两类更新生成 partial 消息 ——
`run_commands` 走 `say: "command"`（复用 `content_start` 的形状，含
`COMMAND_OUTPUT_STRING`），`read_files` 走 `say: "tool"` 并把摘要放进
`content`。两者都是 webview **已在渲染**的通道（`ChatRow.tsx:207` 的
`isCommandExecuting` 判定、`ToolUseRow` 的 `readFile` 分支），因此无需新增组件。
每个 `toolCallId` 持有稳定 ts，使连续更新 upsert 到同一行而非堆叠
（`messageReducer.ts`：同 epoch 按 ts upsert）。

### 5.2 下一步优先级建议

1. ~~**#6 MCP resources/prompts**~~ —— ✅ 2026-10-04 完成，见 §6.1。
2. **延迟工具加载**（ToolSearch 式）—— 当前最高优先级的结构性差距；
   新增 `glob` 与 3 个 MCP 目录工具后常驻描述成本进一步上升。
3. **确认 B / C 两项语义**（§4 P0）。需要的是确认默认值与旁路审计，不是实现。
4. **#2 参数级判定**（P1-D）。当前实现是保守安全的，**不是紧急项**——
   建议明确记录为「有意为之的保守取舍」而非「未完成」，避免后续反复。
5. **工具调用上限**（§4.1）。若要加，需先确定 `maxToolCalls` 设置项与默认值，
   并与迭代上限的取向保持一致。属于产品决策。
6. **#12 推测执行**。执行层最大的一块，需架构级投入。

### 5.3 验证状态

| 套件 | 结果 |
|---|---|
| `@cline/shared` / `ui` / `agents` / `llms` / `cline-hub` | 240 / 12 / 74 / 448 / 98 全通过 |
| `@cline/core` | 1914 + 5 通过（新增 glob executor/工具/目录登记测试） |
| `apps/vscode` vitest | 86 文件 / 1036 通过（新增 factory 预算 0 语义 3 条） |
| `webview-ui` | 52 文件 / 465 通过 |
| `apps/cli` | 115 文件 / 892 通过 / 8 跳过（挂起问题已修，单次运行可完成） |
| `build:sdk`、`bun run types`、根 `bun run lint` | 全通过 |

---

## 6. 本报告的局限

1. 竞品侧结论沿用前序报告，**本次未重新核对**竞品产品文档。
2. 本轮聚焦「前序报告结论是否仍成立」与「本轮改动引入了什么」，**未重新做全量
   能力矩阵**。矩阵部分请以 `agent-capability-gap-analysis-2026-10-02.md` 为准。
3. §2 的「无实现」结论基于**关键词搜索**。若实现使用了不同命名，可能漏判；
   关键项已尽量辅以文件存在性检查。
4. 未做基准测试。本报告比的是实现能力与可配置性，不比任务成功率。

---

## 7. 补记：MCP resources/prompts 与 glob 的落地（2026-10-04）

### 7.1 落地内容

| 能力 | 实现位置 | 关键设计取舍 |
|---|---|---|
| MCP 跨 server 聚合 | `McpHub.listAllResources()` / `listAllPrompts()` | 单 server 缺失/禁用/超时返回空，不影响其他 server 的清单 |
| `list_mcp_resources` / `read_mcp_resource` / `list_mcp_prompts` | `apps/vscode/src/sdk/mcp-resource-tools.ts` | 拆成 3 个而非 1 个带判别参数的工具；资源正文上限 100k 字符（头尾保留） |
| `glob` | `sdk/packages/core/src/extensions/tools/executors/glob.ts` | 复用 `search_codebase` 的工作区文件索引，可见性一致且天然无法越出工作区 |

三处**刻意的「不做」**，理由比功能本身更重要：

1. **不暴露 prompt 执行**。`getPrompt` 返回 message 列表，把它拼进 transcript
   与「工具调用」是两种语义；列举无歧义，执行有歧义，属产品决策。
2. **不引入 glob 专用依赖**。索引已存在且被 search 复用，新增一次目录遍历
   或新依赖都不划算。
3. **不承诺 gitignore 级忽略**。索引有两条实现路径（ripgrep / 目录遍历），
   排除规则不同，工具描述只承诺两条路径都成立的 `.git` 排除。

### 7.2 又一次踩中同一类错误（第 4 次变体）

新增工具时漏掉了**宿主治理层**的两处接线，若不核对，用户会得到一个
「关掉了却仍在运行」的工具：

| 遗漏 | 后果 | 修复 |
|---|---|---|
| 不在 `buildToolPolicies` 的 read 集合内 | SDK 默认「未列出即自动批准」，用户关掉 `readFiles` 后 `glob` 仍静默读盘 | 归入 read 集合并跟 `readFiles` 开关；MCP 三工具归入 `useMcp` 开关 |
| 不在 `ToolUseRow` 的渲染分支内 | 该工具在聊天里**渲染为空白**（default 分支是 `InvisibleSpacer`） | 新增 4 个渲染分支，并在 translator 侧补 `describeToolUse` 映射 |

**补充 §5.3 的验证清单**：新增工具时，接线清单应显式包含

```
定义/契约 → executor → 工具注册 → presets/routing → 宿主批准策略 → 宿主渲染映射 → UI 渲染分支 → 用户可见
                    ↑                        ↑                        ↑
              漏=工具静默消失         漏=绕过用户开关            漏=界面空白
```

CLI 侧同样要改两处：`SAFE_AUTO_APPROVE_TOOL_NAMES`（`glob` 与 `search_codebase` 同列）
与 `formatToolInput`（批准弹窗里要能看到模式），两者均已补测试。

### 7.3 对齐性审计发现的问题（2026-10-04 续）

补齐上述两项后做了一轮跨宿主对齐审计，发现 **1 个严重缺陷 + 1 个真实缺陷 + 5 处表述错误**。

**严重：`glob` 漏登记权威工具目录。**
`core/src/extensions/tools/runtime.ts` 的 `BASE_TOOL_CATALOG` 是内置工具唯一的
权威清单，被 4 处消费。漏登记的后果全是**静默**的：

| 后果 | 位置 |
|---|---|
| `cline config tools` 与 `/config` 开关里**看不到 glob**，因此无法关闭它 | `apps/cli/src/commands/config.ts:372`、`apps/cli/src/tui/interactive-config.ts:494` |
| `allowlist: ["glob"]` 直接抛 `Unknown tool "glob"` | `runtime.ts:246-252` |
| ACP / headless 会话里 glob **静默不存在**（工具名由该目录派生） | `runtime.ts:256-269` |
| 目录里查不到 flag 映射 ⇒ `defaultEnabled` 恒为 false | `runtime.ts:190-191` |

已修（4 处：catalog 条目、`TOOL_NAME_TO_FLAG`、`ResolvedToolFlags`、ACP `TOOL_KIND_MAP`），
并新增一条**清单式回归测试**：「每个 `ALL_DEFAULT_TOOL_NAMES` 都必须能在目录中找到，
否则必须被显式归类为 routing 别名（`apply_patch`→`editor`）或 opt-in 排除（`submit_and_exit`）」。
把"新增工具要同步哪几张表"从口头约定变成测试。

**真实缺陷：VS Code 费用上限的 `0` 语义与文案矛盾。**
`package.json` 与设置 UI 都写「0 = 无上限」，但
`cline-session-factory.ts` 用 `readBoundedNumber(value, 5)` 读取，
`0` 落到 `n > 0` 之外 → 回退 **$5**。用户设 0 得到的是 $5 上限。
SDK 侧 `maxTotalCost` 的 schema 是 `z.number().positive().finite().optional()`，
0 不可表达，"无上限"只能靠**省略该字段**。已改为与 `maxIterationsSetting` 同构的处理：
显式 `0` → 不下发 `budget`；畸形值（NaN/负数/Infinity）→ 仍回退 5。
补 3 条测试分别锁定「0 = 无上限」「畸形值仍保留护栏」「配置值原样生效」。

**5 处表述错误**（已改报告，不改代码）：

| # | 原表述 | 实际 |
|---|---|---|
| 1 | 仅 `read_files`/`search_codebase` 声明 safe | `glob` 也是 safe，共 3 个 |
| 2 | 「双宿主默认 6」 | VS Code / CLI 为 6；**ACP 未设置 → 串行回落**；desktop-app 未设置 |
| 3 | hub 路径 emitUpdate 已验证 | `hub-runtime-host.ts:261` 只代理 **client-contributed 工具**，不覆盖 `read_files`/`run_commands` |
| 4 | MCP resources/prompts 标 `●` | 需加宿主限定：**仅 apps/vscode**；SDK 层 MCP 只有 tools |
| 5 | 矩阵「费用上限 0=无限制」 | 当时为**假**（即上述缺陷），现已修复 |

**另发现 4 项报告此前未记录的差距**：

1. **ACP 路径零护栏**：`acpAgent.ts:530-564` 既无 `maxIterations` 也无 `budget`
   → 迭代无上限、花费无上限；并发回落串行。
2. **OS 级沙箱已实现但接线不全**：`process-sandbox-runtime.ts`（Seatbelt/bubblewrap，
   fail-closed）已导出，CLI 可用 `CLINE_SANDBOX=1` 启用，
   而 **ACP 硬编码 `sandbox: false` 且无开启途径**，VS Code 未引用。
   报告原记「沙箱 ◐ 仅文件边界」，低估现状。
3. **CLI 完全不消费流式输出**：`apps/cli/src` 对 `emitUpdate`/`content_update` 零引用。
4. `submit_and_exit` 不在工具目录中，因此 `cline config tools` 无法开启它（既有行为，
   非本轮引入）。

### 7.4 ACP 护栏补齐（2026-10-04，已批准范围）

**问题性质**：不是"为了对齐竞品"，而是**运行时安全/可靠性缺口** —— 同一个 agent 在终端有
50 轮 / $5 上界，在 IDE（ACP）内可以无限迭代、无限累积费用。

**做法**：抽出单一来源 `apps/cli/src/runtime/run-guards.ts`，两个宿主共用：

| 宿主 | 之前 | 之后 |
|---|---|---|
| CLI (`main.ts`) | 内联字面量 `50` / `5` | `...resolveRunGuards(guardOverridesFromArgs(args))` |
| ACP (`acp/acpAgent.ts`) | **完全未设置** | `...resolveRunGuards(readRunGuardEnv())` |

- 默认值 `CLI_DEFAULT_MAX_ITERATIONS = 50`、`CLI_DEFAULT_MAX_TOTAL_COST_USD = 5`，
  与扩展一致；不新增机制，复用 runtime 既有的 `max_iterations` / `budget_exhausted`。
- 显式配置优先：CLI 走既有 flag；**ACP 无 flag 解析器**，故沿用该文件已有的
  `CLINE_*` env 模式，新增 `CLINE_MAX_ITERATIONS` / `CLINE_MAX_BUDGET_USD`
  （已写入 `--max-iterations` / `--max-budget-usd` 的 help 文案）。
- 畸形值（0/负数/NaN/Infinity/空串）一律回退默认值而非丢弃：拼错环境变量
  绝不等于"没有上限"。CLI 侧**不提供** `0 = 无上限`（flag 本身拒绝 0，
  且没有像扩展那样有 UI 承诺 0 取消上限）。
- **未改动 ACP 并发**：它的串行回落是独立语义，按决策不在本轮扩大范围。

**顺带修掉的终止语义缺陷**：`mapFinishReason` 未处理 `budget_exhausted`，
落入 `default` → `end_turn`，即**把被预算截停的运行报告为正常完成**。
ACP 的 `StopReason` 无 spend 对应值，现映射到 `max_tokens`（协议中"达到配置上限"的语义，
与既有 `max_iterations` → `max_turn_requests` 的先例一致），精确数字仍由 runtime 的
`status-notice`（"Run budget exhausted: …"）送达客户端，信息不丢失。
该函数此前是私有的，已导出以便测试。

**契约测试**（`apps/cli/src/runtime/run-guards.test.ts`，12 条 + `acp/finish-reason.test.ts` 5 条）：
除了解析规则（默认/覆盖/畸形/边界/不产生 SDK 会拒绝的值），还包含两条**漂移守卫**：
断言 `main.ts` 与 `acpAgent.ts` 都走 `resolveRunGuards`、都不再内联数字常量、
且不存在会覆盖展开块的同名字面属性 —— 只测解析器的测试在有人把字面量重新内联后
仍会通过，而这正是要防的回归。

---

*生成于 2026-10-03，§7 补记于 2026-10-04。§2、§4 中所有 `[实测]` 结论可按 `file:line` 直接复核。*