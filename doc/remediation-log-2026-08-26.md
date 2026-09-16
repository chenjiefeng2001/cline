# 修复实施日志（Remediation Log）· 2026-08-26

> 依据：`doc/scan/00–07` 全库扫描报告（2026-08-26）
> 分支：`scan-remediation/2026-08-26`（基于 main @ `90b31f389`）
> 原则：每项修复独立成 commit、消息内标注风险编号 [R#]、可单独 `git revert`；本文件是全部变更的追溯清单。

## 1. 提交清单与回退方式

| # | Commit | 风险项 | 类型 | 内容 | 单独回退命令 |
|---|---|---|---|---|---|
| 1 | `a8d4e781c` | R5 | chore | WIP 检查点：SdkController currentTaskItem 合成回退、ChatView task 派生修复（分页回弹根因）、vscodeignore 排除调试产物、v21 报告补记 | `git revert a8d4e781c` |
| 2 | `1c114e83a` | R6 | docs | evals README/ARCHITECTURE 场景计数 5→8 并列举 06–08 用途；新增 `doc/v17-v21-index.md` 提交追溯索引（显式标注 V19 无提交缺口、V20=`f1c2068ac`） | `git revert 1c114e83a` |
| 3 | `ce735956e` | R6 | chore | 删除已跟踪但零引用的调试残留 `tmp-msg-handler.ts`（461 行）；ToolUseRow.vsix 本就 gitignore，保持本地 | `git revert ce735956e` |
| 4 | `86c343e51` | R1 | ci | 新增 `.github/workflows/cline-evals-smoke.yml`：手动 dispatch 冒烟回归（模型/场景/次数可参数化，CLINE_API_KEY 密钥守卫，结果 artifact 上传）；evals README CI 章节同步登记 | `git revert 86c343e51` |
| 5 | `d58e9f019` + `f1823d391` | R8 | test | multi-agent 示例：`server.listen` 加 `import.meta.main` 守卫（导入不再绑端口）、导出 AGENT_ROLES/createAgentConfig、新增 bun:test 3 用例、package.json 增加 test/typecheck 脚本 | 分别 revert 两个 sha |
| 6 | `06925d0b8` | R4 | docs | CLI DEVELOPMENT.md 增加 OpenTUI/Zig 安装失败排查节（症状识别、恢复步骤、SDK-only 逃生通道） | `git revert 06925d0b8` |
| 7 | （本提交） | 全部 | docs | 本日志 + scan 索引指针更新 | `git revert <sha>` |

## 2. 验证记录

| 验证项 | 命令 | 结果 |
|---|---|---|
| multi-agent 测试 | `bun test`（apps/examples/multi-agent） | ✅ 3 pass / 0 fail |
| multi-agent 类型 | `tsc --noEmit` | ✅ exit 0 |
| Biome 检查 | `bun biome check apps/examples/multi-agent/src/` | ✅ 无错误 |
| 提交钩子 | husky(gitleaks) × 7 次提交 | ✅ no leaks found |
| 全库类型检查 | `bun run types` | 见下方"最终验证" |

**未验证/需线上验证项**：
- `cline-evals-smoke.yml` 仅做了语法与契约核对（运行器 env 变量名、`which cline` 平台限制→限定 ubuntu），未实际触发 dispatch（需仓库配置 `CLINE_API_KEY` secret）。建议首次手动触发一次小规模验证（trials=1，scenario=01-create-file）。

## 3. 遗留项路线图（本次刻意不做，防止不可控大改）

| 项 | 为何推迟 | 建议路径 |
|---|---|---|
| R2 复杂度集中（core 13 万行 / vscode 32 万行） | 架构级重构，无法以可回退的小提交安全完成 | 沿 `.clinerules/sdk-migration.md` 既定迁移推进；每季度用 knip/depcruise 度量耦合面；vscode-rollout 灰度达 100% 后退役 legacy bundle |
| R3 测试框架四套并存 | 迁移 225+ 测试文件影响面过大 | 以 Vitest 为主轴，按 app 分期：先 webview-ui(48) → vscode src Mocha(177) → 收编 Bun test；Playwright/tui-test 因领域特殊性保留 |
| R7 evals 技术栈陈旧（TS4.9+ts-node） | 升级将重写 evals/package-lock.json，churn 大且需完整冒烟回归护航 | 与 R1 工作流首跑合并为独立 PR：升级 typescript@5.x、ts-node→tsx、对齐根工作区脚本 |
| R8 其余示例（examples/vscode 等） | 现有 98 文件仅 1 测试，补测应聚焦 RPC 链路 | 为 StartRuntimeSession/SendRuntimeSession/AbortRuntimeSession 增加集成测试后再扩展 |
| V19 缺口核实 | 需要历史仓库考古（可能 squash 于 V18 提交） | 在 v17a 第八节补充指向实际 diff 的链接或"未落地"结论（见 `doc/v17-v21-index.md` §2） |

## 4. 回退策略总览

- **单项回退**：上表逐条 `git revert <sha>`——各 commit 无交叉文件依赖（唯一交叠是 evals/README.md 被 commit 2 与 4 先后修改，若需回退 commit 2 请连同 4 一并 revert 或手工保留 CI 段落）。
- **整体回退**：`git checkout main && git branch -D scan-remediation/2026-08-26`（未合并前零影响）。
- **合并后回退**：按 commit 逐个 revert，或 `git revert --mainline 1 -m 1 <merge-sha>` 整体撤销。

---

# 第二阶段（同日续）：架构稳定前提下的深化修复

> 约束：不做任何跨模块结构改动；每步均有验证门；R2/R3 仍按路线图推迟。

## Phase-2 提交清单

| # | Commit | 风险项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P2-1 | `31493f765` | R7 | build | **evals 工具链现代化**：裁剪 4 个零使用依赖（better-sqlite3 原生模块/tiktoken/chalk/commander）+ ts-node → 仅留 dotenv；TS ^4.9.4→^5.9.3、@types/node→^25.3.5、加 tsx devDep；锁文件重生成（净 -277 行）；替换断链 tsconfig（根目录无 tsconfig.json，旧 extends 形同虚设）为独立配置（ES2022+bundler）；顺带修复暴露的 harbor 指标命名契约断裂（camelCase→snake_case 适配器，smoke-runner 输出格式不变）；工作流同步（analysis npm ci + tsc 门 + 本地 tsx） | `tsc --noEmit` exit 0；runner 于 tsx 下完整加载至 CLI 守卫早退；js-yaml 解析 workflow exit 0 |
| P2-2 | （本提交） | R6 | docs | V19 缺口结案：逐文件 `--follow` 取证证实 V19 加固 squash 进 V18 提交 `5a6862d5a`（session-messages-jsonl.ts 648 行仅存于该提交，含 VSIX 标记 subarray）；v17-v21-index 对应行更新 | git log --all --follow 取证记录 |

## Phase-2 关键发现

1. **evals/tsconfig.json 此前 extends 不存在的根 tsconfig**——所有历史类型检查对该目录实际无效。本次独立配置后首次获得真实类型门禁，并立即捕获 harbor 的指标契约 bug（若未修，未来 analysis JSON 报告的 metrics 字段将静默错位）。
2. **V19 结案**消除了"存在丢失工作"的担忧——是标签缺失而非代码缺失。
3. better-sqlite3 从 evals 依赖树移除后，CI 安装不再触发原生编译，冒烟工作流的失败面显著缩小。

## Phase-2 后剩余项（不变）

- R2/R3/R8-examples-vscode：维持第一阶段路线图。
- 冒烟工作流首跑仍待仓库 secret `CLINE_API_KEY` 配置后人工触发。

## 最终验证（P2-2 之后补记）

| 验证项 | 命令 | 结果 |
|---|---|---|
| 全库类型检查 | `bun run types`（= `bun --parallel -F '*' typecheck`） | ✅ 15 个包的 typecheck 任务全部通过（core/cli/vscode/rollout/sdk/shared/llms/agents/ui/code/hub/menubar/plugin/examples×2），exit 0 |

至此 §2 验证表中悬置引用的"最终验证"闭合：两阶段全部提交在最终代码状态下均通过类型门禁。

---

# 第三阶段（同日再续）：R8 收官与新发现 R9

> 约束不变：小提交、可单独回退、每步验证门。本轮以"测试安全网"为主线推进 R8 路线图项，过程中发现并登记新风险 R9。

## Phase-3 提交清单

| # | Commit | 风险项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P3-1 | `c23aa38e4` | R8 | test | **examples/vscode RPC 链路端到端测试**：进程内启动真实 hub WebSocket server（临时 discovery 文件 + 端口 0）+ 桩 RuntimeHost，覆盖扩展实际依赖的 `ClineCore backendMode=hub` 全链路——HubSessionClient startRuntimeSession→`session.create` / sendRuntimeSession→`session.send_input` / abortRuntimeSession→`run.abort` + getSession 与广播事件观测（session.created/run.started/run.completed）；HubRuntimeHost startSession/runTurn/abort 含 manifest 断言。新增 vitest.config.ts 与 test 脚本 | vitest 3/3 ×2；tsc exit 0 |
| P3-2 | `180eab591` | R9 | fix | **MCP stdio spawn win32 引号缺陷**：shell:true 下 Node 不加引号拼接命令，含空格的可执行路径（如 `C:\Program Files\nodejs\node.exe`）被 cmd 截断导致 MCP server 无法启动。仅对含空白片段加引号 | runtime-builder MCP 集成用例于 Windows 由红转绿；core 全量单测 1395 pass/0 fail |
| P3-3 | `4b398b139` | R9 | test | legacy bash 回退与 AgentExtension 两用例依赖 POSIX shell，win32 永远失败；`it.skipIf(win32)` 平台门控 | 同上（1395 pass / 7 skip / 0 fail） |
| P3-4 | `52d21f38f` | R9 | build | 重型套件预算放宽：core/llms/cli vitest 配置 testTimeout/hookTimeout→30s（基线取证：原始聚合集在并行下即产生 5s 假超时；cli main.test 在九套件并行下连自设的 15s 也超出） | 多轮全量运行零超时级失败 |
| P3-5 | `0bbb36e50` | R8+R9 | test | **desktop-app 测试收编**：16 个 vitest 文件此前无通用 test 脚本、从未被任何门禁执行且已腐烂（sidecar 能力两用例必败：单测内冷加载整个 @cline/core 图超出默认 5s）。动态导入提升至 beforeAll + 单文件预算 60s + 补 `test` 脚本 | `bun run test` ×2 → 16 files/59 tests 全绿 |
| P3-6 | （本提交） | R6/R9 | docs | 本节 | — |

## Phase-3 关键发现（新登记 R9）

1. **根聚合脚本 `bun run test` 三重缺陷（维持原样未动，留作路线图）**：
   - `--parallel` 同时冷启动 9 套件互相饿死——基线取证显示**原始集合本身就红**（llms gateway 5s 假超时随机出现），非本轮引入；
   - sdk 包的 `test` 脚本含 e2e 变体（core 为 `test:unit && test:e2e`），聚合器语义不可控；
   - 覆盖缺口：webview-ui(48 文件/376 测试)、desktop-app(16)、examples/vscode(3)、multi-agent、rollout 均不在聚合范围。
   - 建议路径：聚合器重构为 unit-only 过滤 + 受控并行度/分组串行，先纳入已验证全绿的 webview-ui。
2. **Windows 平台缺口两处**：MCP spawn 引号 bug 已修（P3-2）；legacy bash hooks 产品层无 win32 支持待产品决策（P3-3 仅门控测试）。
3. **未被门禁执行的套件必然腐烂**：desktop-app 即实例（P3-5）；webview-ui 独立运行仅 ~37s 且全绿，是聚合器重构时最安全的首批收编对象。

## Phase-3 后剩余项

- R2/R3 大迁移路线图不变（webview-ui 实际已是 Vitest，R3 真正碎片在 apps/vscode/src 的 Mocha24/bun66/Vitest82 三套并存，影响面大仍推迟）。
- R8-examples-vscode **本轮收官**（98 文件从 1 个测试增至覆盖核心 RPC 链路的 3 个集成用例）。
- 新增路线图：根聚合器重构（见上）、legacy bash hooks 的 win32 产品策略、冒烟工作流首跑仍待 secret。

## Phase-3 验证记录汇总

| 验证项 | 结果 |
|---|---|
| examples/vscode `bun run test` | ✅ 3/3 ×2 次 |
| desktop-app `bun run test` | ✅ 59/59 ×2 次 + 并行大跑 1 次 |
| core `test:unit` 全量（含 MCP 修复后） | ✅ 1395 pass / 7 平台跳过 / 0 fail（41.7s） |
| llms/cli/webview-ui/hub 等（并行大跑） | ✅ 无超时类失败残留 |
| biome lint（全部改动文件） | ✅ 无新增告警（输出均为 apps/cli 存量 warning） |
| gitleaks 提交钩子 | ✅ 全部通过 |

---

# 第四阶段：聚合器取证与增量收编

> 前置发现改变了第三阶段的路线图判断：`.github/workflows/sdk-test.yml` 在 ubuntu 上执行的就是根 `bun run test`（Windows 矩阵仅跑 sdk glob）——该脚本是 **CI 载体**，不能按原计划直接重构。

## Phase-4 提交清单

| # | Commit | 风险项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P4-1 | `1c3a21b8f` | R9 | build | 新增 `test:extended` 确定性入口（显式 `&&` 串行链）：webview-ui → desktop-app → multi-agent → rollout → examples/vscode；desktop-app vitest 预算对齐 P3-4。默认 `test` 一字未动 | `test:extended` 端到端全绿 ×2（合计 477 用例）；desktop-app 单独 59/59 |
| P4-2 | （本提交） | R6/R9 | docs | 本节 | — |

## Phase-4 取证结论（R9 扩充）

1. **CI 载体约束**：根 `test` 被 sdk-test.yml 消费 → 覆盖缺口改用增量入口解决，CI 语义零变更。
2. **bun 多过滤器仍有并发重叠**：`bun -F a -F b ... test` 不加 `--parallel` 也非严格串行——五套件并发下 desktop-app 冷导入可超 60s hook 预算（同代码单独运行仅 18s）。显式 `&&` 链是唯一构造性串行方案。
3. **cli 测试套件存在 Windows 平台债（登记，未修）**：`/tmp/cline-worktree` POSIX 路径、plugin.test npm 安装 5 例失败、doctor 进程枚举失败，且队列中存在未定位的硬挂起点（二分定位到 doctor 之后）。复现：`cd apps/cli && bun run test:unit`。这些是 POSIx 导向的存量用例，需按 P3-3 模式逐个平台门控或产品适配。
4. **本机负载数据**：同一提交状态下各套件耗时随整机负载波动可达 2-5 倍（webview-ui 37s→175s），并行聚合在本机永远不可靠；**单独运行是本机上唯一可信的门禁信号**，所有已提交修复均以单独运行验证。

## Phase-4 后剩余项

- cli Windows 平台债清单化与门控（P4 取证 #3）。
- 默认 `test` 的覆盖缺口维持现状（CI ubuntu 上语义不变）；若维护者愿意，可将 `test:extended` 并入 sdk-test.yml 或独立 workflow。
- R2/R3 大迁移、bash hooks win32 产品策略、冒烟工作流首跑：不变。

## Phase-4 续：cli 平台债首批清偿

| # | Commit | 风险项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P4-3 | `3835bcf59` | R9 | fix | **插件包管理器 spawn win32 修复**（与 MCP 同族缺陷）：runCommand 无 shell 直接 spawn `"npm"`，Windows 解析到 .cmd 批处理启动器报 spawn EFTYPE——此前所有 Windows 用户安装插件必败。win32 路由 cmd.exe + windowsHide，仅对含空白片段加引号 | plugin.test 卸载用例由 EFTYPE 红转绿；core plugin-install/uninstall 套件 9 pass/2 skip；tsc/biome 干净 |
| P4-4 | `cb3591d0e` | R9 | test | doctor --fix 用例门控（产品在 win32 显式短路返回空枚举，属既定契约）；plugin 四个 `/bin/sh` fake-npm 夹具用例门控（含参数解析+建目录、中途改写翻转退出码两种形态，cmd.exe 无法执行） | 两文件 34 pass / 5 skip（win32） |

**新增路线图**：fake-npm 夹具跨平台化（.cmd 包装 + .cjs 行为体，恢复 Windows 安装流覆盖）；doctor 的 win32 进程枚举产品实现（tasklist/PowerShell Get-Process）。

---

# 第五阶段：P0-1 tracing 收敛 + P0-3 词汇表冻结

> 依据：`doc/architecture-gap-analysis-vs-mainstream-agents-2026-08.md` 路线图。约束不变：小提交、可单独回退、每步验证门。本轮全部为**纯增量**（spans 无 provider 时为 no-op，不改现有行为）。

## Phase-5 提交清单

| # | Commit | 项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P5-1 | `50bc20ee1` | P0-1 | feat | **hub 层 OTel span**：NodeHubClient.executeCommand 包裹 `hub.command` span（command/session_id/url/request_id/timeout_ms 属性，reply 信封错误→ERROR 状态）；HubServerTransport.handleCommand 包裹 `hub.dispatch` span，经 `hub.request_id` 与客户端侧关联 | core typecheck 干净；hub 套件 22 文件/170 用例；core 全量 1395 pass/0 fail |
| P5-2 | `5c669ef83` | P0-1 | feat | **agent/tool 层 OTel span**（@cline/agents）：execute→`agent.run` span（agent.id/session_id/parent_agent_id/model_id/provider_id，failed→记录异常+ERROR）；executePreparedTool→`agent.tool` span（tool.name/call_id/iteration，isError→ERROR+错误文本）。主体移至 executeLoop/runPreparedTool 私有助手，行为不变；@opentelemetry/api 加入依赖（bundle-only，全局注册表兼容） | agents typecheck 干净；47 用例；build 产出含 span |
| P5-3 | `8da4fbab6` | P0-1 | feat | **W3C traceparent 环境提取助手**（core telemetry trace-env.ts）：traceparentFromEnv/remoteSpanContextFromTraceparent/runWithTraceparentFromEnv——从 TRACEPARENT 环境变量解析远端 SpanContext 并在其下运行回调，跨进程调用方（eval runner/CI）可把宿主 span 树锚定到自己的 trace；无 TRACEPARENT 或畸形时原样执行 | trace-env 5/5；telemetry 7 文件/68 用例；core 全量 1400 pass/0 fail |
| P5-4 | `d4f017814` | P0-1 | feat | **CLI 无头运行支持 TRACEPARENT**：run-agent 将 sessionManager.start/send 包裹在 runWithTraceparentFromEnv 中，CLI 运行的 agent.run/agent.tool span 挂接到调用方 trace（无 provider 时 no-op）；测试 mock 补直传 | run-agent 17/17；main.test 71/71；cli typecheck 干净 |
| P5-5 | `6fa846d8d` | P0-1 | feat | **evals↔traceId 闭环**：smoke runner 每个 trial 生成 W3C traceparent（crypto 随机 trace-id/span-id）经 TRACEPARENT 传给 cline CLI 子进程，ClineResult/TrialResult 行携带 trace id——评测回归可锚定到确切执行树 | evals tsc --noEmit 干净 |
| P5-6 | `1909e83e6` | P0-3 | docs | **架构差距分析报告 + hub/webview 词汇表 v1 冻结**：差距矩阵（D1–D8）与 ROI 排序路线图；v1 冻结 hub 命令（70）/事件（48）词汇表与 webview protobus 服务面（16），附方向性 →A2A（Agent Card/Task 生命周期）与 →AG-UI（RUN/TEXT/TOOL/STATE）映射草案、漂移规则（v1 只增不改、重命名/删除要求 v2、新增必须同步登记映射）与代码锚点 | 纯文档，零代码变更 |
| P5-7 | （本提交） | R6 | docs | 本节 | — |

## Phase-5 取证结论

1. **span 树形态**：agent 层 span（agent.run 根 + agent.tool 子）+ hub 层 span（hub.command/hub.dispatch 经 hub.request_id 关联）+ 跨进程 W3C traceparent 传播——三层 OTel 对齐完成，为 P0-1 收官。LLM 请求层 span（llms providers）未做，留作后续增量（P0-1 剩余可选）。
2. **mock 同步教训**：向 `@cline/core` barrel 新增导出时，所有 vi.mock 该 barrel 的测试工厂需同步补齐（run-agent.test.ts 即例），否则运行时 undefined 导致静默失败——新增导出后应 grep `vi.mock("@cline/core"` 逐个检查。
3. **context 传播依赖 provider**：runWithTraceparentFromEnv 的跨 await 传播依赖 NodeTracerProvider.register() 注册的 AsyncLocalStorage context manager；无 provider 时退化为直接执行，spans 仍为根 span——与既有行为一致。

## Phase-5 后剩余项

- P0 路线图三项全部收官（P0-1 tracing、P0-2 win32 spawn 收敛、P0-3 词汇表冻结）。
- 可选增量：llms providers 请求层 span；`test:extended` 并入 CI；A2A/AG-UI 映射在 P2 动工前对照当期规范逐条核验。
- 既定路线不变：P1-1 Memory 抽象层 → P1-2 沙箱两档 → P1-3 teams pattern → P1-4 middleware 链 → P2-1 A2A server → P2-2 工具副作用账本。

---

# 第六阶段：P1-3 teams 官方 pattern 收官

> 依据：架构差距分析路线图 P1-3（D5：teams 编排语义碎片化）。约束不变：小提交、可单独回退、每步验证门。本轮为**纯增量**（新模式发布在 hub session bus 之上，零内核改动）。

## Phase-6 提交清单

| # | Commit | 项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P6-1 | `3d042dc3e` | P1-3 | feat | **teams 官方 pattern**（core `session/patterns.ts`）：①handoff——会话所有权转移（当前 owner `session.detach` → 目标 owner `session.attach`，顺序 await 防 attach 竞速 detach），替换各集成私有编排语义；②evaluator——独立评审会话 + 结构化 critique schema（verdict/score/strengths/weaknesses/risks/suggestions/summary），评审会话只接收被评审 artifact（不带产出会话上下文），阻断自我评估膨胀渗入结论；parseAgentCritique 接受直接对象/原始 JSON 串/首个 ```json 围栏块，fallback 扫描 tool_result content 块；两助手均为传输解耦的结构化形状（`NodeHubClient` / `ClineCore.start` / 测试桩皆满足），导出至 core barrel 与 session 子路径 | core test:unit 1414 pass / 7 平台跳过 / 0 fail；patterns 套件 14/14；tsc 干净；biome 干净 |
| P6-2 | （本提交） | R6 | docs | 本节 | — |

## Phase-6 取证结论

1. **结构化形状 vs `Pick` 全量类型的取舍**：evaluator 的 `start` 回调若用 `Pick<StartSessionResult, "sessionId" \| "result">`，`result` 仍是完整 `AgentResult`（usage/messages/toolCalls 等 10+ 必填字段），测试桩 `{ text }` 无法满足。改为镜像 `StartSessionResult` 信封的 `EvaluatorSessionOutcome`（`result?: { text?; messages? }` 结构化子集）——完整 `AgentResult` 结构上天然满足，最小桩亦满足，`ClineCore.start(...)` 零适配直通。
2. **拍平信封是错误方向**：曾把 outcome 拍平为顶层 `{ sessionId, text, messages }`，导致 `StartSessionResult`（text 嵌在 `result` 下）不再结构兼容、doc 声明失真；两个嵌套桩用例由绿转红后回退。教训：**结构化类型的锚点是上游真实返回形状（信封），不是内部消费字段**。
3. **tool_result 载荷字段取证**：`@cline/shared` 的 `ToolResultContent` 载荷字段是 `content`（string 或 content-block 数组），不是 `output`——初版 fallback 读错字段，已修正并补 tool_result 恢复/忽略两用例。
4. **biome organizeImports 顺带收敛**：core barrel 新增导出块触发 import/export 排序检查，biome 安全修复把 patterns 块移到排序位（trace-env 之后），无行为影响。

## Phase-6 后剩余项

- P1-3 收官。P1 剩余：P1-1 Memory 抽象层 → P1-2 沙箱两档 → P1-4 middleware 链。
- 之后 P2：P2-1 A2A server（依赖 P0-3，已收官）→ P2-2 工具副作用账本。
- 可选增量不变：llms providers 请求层 span；`test:extended` 并入 CI；A2A/AG-UI 映射动工前逐条核验。

---

# 第七阶段：P1-1 Memory 抽象层首批切片

> 依据：架构差距分析路线图 P1-1（D2：长期记忆缺失，只有工作记忆）。约束不变：小提交、可单独回退、每步验证门。本轮为**纯增量**（新 memory 模块，零既有行为变更）。

## Phase-7 提交清单

| # | Commit | 项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P7-1 | `7a36d8a15` | P1-1 | feat | **Memory 抽象层 + 首个适配器**（core `memory/`）：①models——CoALA 分型收窄到编码切片：episodic（决策/踩坑记录，append-only）+ semantic（代码库事实卡，按 subject 键控）+ procedural（保留给后续切片）；②`MemoryStore` 接口（init/append/get/query）——托管型后端（Mem0/Zep/Letta）成为未来 drop-in；③sqlite 适配器完全跟随 `SqliteTeamStore` 既有模式（WAL、busy_timeout、单行 schema-version 表、`@cline/shared/db` loadSqliteDb）；**semantic 冲突消解在 append 事务内完成**——同 subject 新事实取代既有 active 事实（时间性 trail 经 `supersededById` 保留），读者永远看不到同一 subject 的两条 active 事实；④结构化/关键词查询（kind/subtype/subject/workspace/session/tags/activeOnly/keyword/limit）供 agentic search 调用，向量召回留作后续增量 | core test:unit 1420 pass / 7 平台跳过 / 0 fail；memory 套件 6/6；tsc 干净；biome 干净 |
| P7-2 | （本提交） | R6 | docs | 本节 | — |

## Phase-7 取证结论

1. **参数化查询漏传 params（测试先行价值）**：适配器 `query()` 构造好 `params` 后调用 `selectRows(sql)` 时**漏传第二参**——无过滤查询（默认参数 `[]`）恰好工作、kind 过滤静默返回空。定位手段：独立 node:sqlite 复现（参数查询正常）→ 适配器内埋点打印 `params` 到达 selectRows 时已是 `[]`。教训：**默认参数路径全绿的测试不能证明参数化路径正确**，过滤矩阵用例（本批 5 个维度）是必须的。
2. **Windows 句柄债**：sqlite 连接保持 `.db/.wal/.shm` 打开，`rmSync` 清理临时目录报 EPERM——适配器暴露 `close()`（SqliteDb 已有可选 close，wrapNodeDb 已转发），测试 afterEach 先 close 再 rm；顺手补 WAL 持久性跨实例用例。
3. **落位复用**：`@cline/shared/db`（busy retry/WAL/sqlite 实验告警抑制）与 `resolveDbDataDir` 直接承载 memory.db，一行基建代码未新增；项目级作用域走 nullable `workspace_path` 列，与全局单库并存。

## Phase-7 后剩余项

- P1-1 后续切片：procedural 记录形状；检索接入 agentic search 调用方；向量兜底；Mem0/Zep 托管适配器（按需）。
- P1 路线不变：P1-2 沙箱两档 → P1-4 middleware 链；之后 P2-1 A2A server → P2-2 工具副作用账本。
- 可选增量不变：llms providers 请求层 span；`test:extended` 并入 CI；A2A/AG-UI 映射动工前逐条核验。

---

# 第八阶段：P1-2 沙箱两档首批切片（隔离层接口 + 进程沙箱档）

> 依据：架构差距分析路线图 P1-2（D4：执行隔离层级不足，审批当沙箱）。约束不变：小提交、可单独回退、每步验证门。本轮为**纯增量**（新 runtime/sandbox 模块，零既有行为变更——执行器未接线，接口先行）。

## Phase-8 提交清单

| # | Commit | 项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P8-1 | `781225d80` | P1-2 | feat | **隔离层接口 + 进程沙箱档**（core `runtime/sandbox/`）：①`sandbox-command`——纯函数进程沙箱命令构造：macOS Seatbelt workspace-write profile（default allow + file-write 收敛到 workspace root）与 Linux bubblewrap（ro-bind 根 + workspace bind、/dev + /proc、die-with-parent）；win32 返回 undefined → 调用方 fail-closed，绝不静默降级；②`detectProcessSandbox`——平台 + PATH 检测，platform/pathEnv 覆盖参数使全平台可测；③`SandboxRuntime` 适配器接口（isAvailable/exec + 类型化 `SandboxUnavailableError`，fail-closed 契约）——Docker/E2B 后端成为未来 drop-in，remote 模式天然兼容云沙箱；④`ProcessSandboxRuntime` 首个适配器——路由到检测到的绝对二进制、capped stdout/stderr 捕获 + 超时 SIGKILL、exec 为 async（契约违例以 rejection 浮出）；导出至 runtime 子路径与 core barrel | core test:unit 1432 pass / 7 平台跳过 / 0 fail；sandbox 套件 12/12（全平台，测试无需真实沙箱执行）；tsc 干净；biome 干净 |
| P8-2 | （本提交） | R6 | docs | 本节 | — |

## Phase-8 取证结论

1. **测试全平台零平台债**：命令构造是纯函数 + platform/pathEnv 覆盖参数，12 个用例在 win32 CI 上全部可跑（与 P3-3 的 POSIX-only 债形成对照）——**接口先行的切片天然可测**，接线执行器时才需要真实沙箱环境。
2. **同步 throw vs rejection**：适配器 `exec` 初版为同步方法，不可用时同步 throw——`rejects.toThrow` 捕不到（throw 发生在 Promise 构造之前）。改为 async 后按接口契约以 rejection 浮出。教训：**声明返回 Promise 的方法，前置校验失败也应 async 化**，否则 await 消费方拿到的是同步异常，契约分裂。
3. **fail-closed 是契约不是实现细节**：`buildProcessSandboxCommand` 在 win32 返回 undefined、检测不可用抛类型化错误——绝不静默降级到无沙箱执行；调用方（后续接线 toolPolicies 时）显式决定降级还是审批。

## Phase-8 后剩余项

- P1-2 后续：SandboxRuntime 接线 toolPolicies/执行器（真实沙箱环境验证）；Docker/E2B 后端适配器。
- P1 路线不变：P1-4 middleware 链；之后 P2-1 A2A server → P2-2 工具副作用账本。
- 可选增量不变：llms providers 请求层 span；`test:extended` 并入 CI；A2A/AG-UI 映射动工前逐条核验。

---

# 第九阶段：P1-4 middleware 链首批切片 —— P1 路线收官

> 依据：架构差距分析路线图 P1-4（D7：Guardrails 未形式化为原语/管道）。约束不变：小提交、可单独回退、每步验证门。本轮为**纯增量**（新 middleware 模块，零既有行为变更——hooks/审批流未接线，链与官方中间件先行）。至此 **P1 路线四项全部落地**（P1-1 Memory / P1-2 沙箱 / P1-3 teams pattern / P1-4 middleware）。

## Phase-9 提交清单

| # | Commit | 项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P9-1 | `56870d1f7` | P1-4 | feat | **工具中间件链 + 官方中间件**（core `middleware/`）：①`tool-middleware`——洋葱式有序链（先注册 = 最外层），重复注册抛错（排序错误不再静默）；②**retry**——瞬时失败重试 + 指数退避，retryOn 谓词可插拔、sleep 可注入（测试零真实等待）；③**budget**——链实例级调用预算，超支返回结构化 `BudgetExceededDenial` 而非执行，`reset()` 跨 run 清零；④**redaction**——scrub 字符串结果与纯对象字符串字段中的机密/PII（email、Bearer、sk-/ghp_/AKIA key 形状），类实例（Buffer/Date）原样透传；⑤**approval**——链上人工节点：`autoApprove: false` 时按调用接线宿主 `requestToolApproval`，被拒调用返回结构化 `ToolDenial` 而非执行；导出至 core barrel | core test:unit 1447 pass / 7 平台跳过 / 0 fail；middleware 套件 15/15；tsc 干净；biome 干净 |
| P9-2 | （本提交） | R6 | docs | 本节 | — |

## Phase-9 取证结论

1. **同目录导入路径惯性错误**：四个内置中间件从 `../tool-middleware` 导入链抽象（同目录应为 `./tool-middleware`）——P1-3 的同类错误第二次出现；规律：**新目录下首个文件确定相对层级后，后续文件逐个核对**。
2. **scrub 不得下钻类实例**：redaction 初版对一切对象走 `Object.entries` 重建——Buffer 被展开成 `{0:111,...}` 索引对象而销毁。修复：仅重建纯对象（`getPrototypeOf === Object.prototype/null`）与数组，类实例透传。教训：**深遍历转换必须区分 plain object 与类实例**。
3. **denial 分型**：`ToolDenial` 基类型（denied+reason）与 `BudgetExceededDenial`（+limit/spent 记账上下文）分立——approval 拒绝没有预算上下文，`satisfies` 单类型会把两节点强行对齐。类型化守卫 `isToolDenial`/`isBudgetExceededDenial` 各自收窄。
4. **预算语义为拒绝而非异常**：budget 超支返回结构化 denial（正常流），retry 失败抛错（异常流）——横切关注点的失败形态各自对齐消费方语义，不统一成 throw。

## Phase-9 后剩余项

- **P1 全线收官**（P1-1/P1-2/P1-3/P1-4 均有首批切片落地）；后续切片按需：middleware 接线 agent runtime（替换 beforeTool/afterTool 散点）、P1-1 检索接 agentic search、P1-2 接线 toolPolicies、P1-3 hub 命令注册 attach/detach 对外暴露。
- P2 路线：P2-1 A2A server（依赖 P0-3，已收官）→ P2-2 工具副作用账本。
- 可选增量不变：llms providers 请求层 span；`test:extended` 并入 CI；A2A/AG-UI 映射动工前逐条核验。

---

# 第十阶段：P2-1 A2A server 首批切片

> 依据：架构差距分析路线图 P2-1（D3：协议面单向——只进不出），依赖 P0-3 词汇表冻结（已收官）。约束不变：小提交、可单独回退、每步验证门。本轮为**纯增量**（新 hub/a2a 模块，零既有行为变更——HTTP/SSE 接线留后续切片）。

## Phase-10 提交清单

| # | Commit | 项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P10-1 | `4c462b0b0` | P2-1 | feat | **A2A server 适配层**（core `hub/a2a/`，按 P0-3 冻结映射 §3）：①`a2a-types`——A2A 核心对象（Agent Card/Task 生命周期/Agent Skill）；②`a2a-mapping`——纯投影：hub session status → A2A task state（**pending approval 即 input-required，HITL 天然契合**；终态胜过 approval）、session 记录 → Task、Agent Card 构造（hub 派生能力 streaming=true/pushNotifications=true）；③`a2a-server`——结构化 hub 客户端之上的请求处理器：`message/send` → `session.create`（新任务）/`session.send_input`（既有任务）；`tasks/get` → `session.get`（含 pending-approval 检测）；`tasks/cancel` → `run.abort`；`tasks/list` → `session.list`；传输解耦（HTTP/SSE 接线后续切片，测试全桩）；导出经 hub 子路径与 core barrel 级联 | core test:unit 1459 pass / 7 平台跳过 / 0 fail；a2a 套件 12/12；hub 套件 182 pass；tsc 干净；biome 干净 |
| P10-2 | （本提交） | R6 | docs | 本节 | — |

## Phase-10 取证结论

1. **冻结映射即设计图**：P0-3 冻结文档 §3 的方向性映射（message/send ≈ session.create+run.start / session.send_input；Task input-required ≈ approval.requested）直接可执行——**词汇表冻结的投资在 P2 动工时回收**，零漂移核验成本。
2. **结构化投影 vs `Partial<SessionRecord>`**：mapper 输入若用 `Partial<SessionRecord>`，`source/status` 字段类型仍锁死为窄联合（SessionSource/SessionStatus），hub 宽载荷投影不兼容；改为 `A2ASessionProjectionInput`（status/source 均放宽为 string）——`SessionRecord` 结构上天然满足。与 P1-3 evaluator 的取舍同构：**结构化类型的锚点是消费字段，不是上游记录全量**。
3. **终态胜过 approval**：状态机映射中 pending approval 只覆盖非终态（completed/failed/canceled 不回退 input-required）——审批挂起但会话已终止的边界语义显式化。

## Phase-10 后剩余项

- P2-1 后续切片：HTTP/SSE 接线（JSON-RPC over HTTP + SSE，挂载 hub server）；Agent Card 从 hub 能力面动态生成（skills 取 catalog.list）；pushNotifications 接 ui.notify 通道。
- P2 路线不变：P2-2 工具副作用账本 + idempotency-key（恢复期 replay-or-fork 语义，**差异化反超点**）。
- P1 后续切片按需：middleware 接线 agent runtime、P1-1 检索接 agentic search、P1-2 接线 toolPolicies。

---

# 第十一阶段：P2-2 工具副作用账本 —— P2 路线收官

> 依据：架构差距分析路线图 P2-2（D1：durable execution 缺位——checkpoint ≠ 断点续跑）。差距分析定位的**全场唯一"大家都没做好"的差异化反超点**（ACRFence：包括 LangGraph/Claude Code/Cursor/ADK 在内，没有任何框架在工具边界强制 exactly-once）。约束不变：小提交、可单独回退、每步验证门。本轮为**纯增量**（新 runtime/ledger 模块，零既有行为变更——执行器接线留后续切片）。至此 **P2 路线两项全部落地**（P2-1 A2A server / P2-2 副作用账本）。

## Phase-11 提交清单

| # | Commit | 项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P11-1 | `749d86cad` | P2-2 | feat | **工具副作用账本 + idempotency-key**（core `runtime/ledger/`）：①`effect-ledger`——每个工具调用一条幂等键记录；`claim` 原子认领：succeeded 调用**重放**记录结果（恢复期绝不二次生效），failed 调用**分叉**进正常执行（无记录副作用，重试安全）；②`idempotency-key`——确定性派生（sessionId+iteration+tool+toolCallId+稳定输入哈希，sorted-key JSON、数组保序），恢复期重派生同键即命中重放路径；③sqlite 适配器完全跟随 store 模式（WAL/busy_timeout/schema-version 表），幂等键即主键——读者永远看不到同一逻辑调用的两条记录；④`idempotency-middleware`——工具边界 exactly-once 执行点，接入 P1-4 中间件链零侵入执行器；无 session 身份时显式不记账执行（fork without ledger）；导出至 core barrel | core test:unit 1473 pass / 7 平台跳过 / 0 fail（×2；1 例为既有 hooks 套件并行负载 flake，单独运行 2/2 全绿，按 Phase-4 门禁策略采信单独运行信号）；ledger 套件 14/14；tsc 干净；biome 干净 |
| P11-2 | （本提交） | R6 | docs | 本节 | — |

## Phase-11 取证结论

1. **replay-or-fork 语义分型**：succeeded → 重放（防重放/二次生效）；failed → 分叉重试（失败调用无副作用或副作用未知，重试安全）——exactly-once 的边界在"成功调用的副作用"，不是一切调用。
2. **幂等键派生是恢复语义的核心**：键含 sessionId+iteration+toolCallId+输入哈希——确定性派生使恢复期无需额外传递状态即可命中重放路径；输入哈希 sorted-key JSON（对象键序无关、数组保序），循环引用降级为 "unserializable" 不抛错。
3. **测试断言写错一例**：重试语义用例用单一计数器断言两次执行——第二个 executor 不递增计数器导致假红；改为执行轨迹断言（`["first","second"]`）。教训：**跨调用断言用轨迹/调用记录，不用共享可变计数器**。
4. **并行 flake 边界**：全量并行下既有 hooks 套件出现 1 例 flake（`hook-file-hooks` shutdown 分派），单独运行 2/2 全绿——与 Phase-3/4 记录的并行饿死问题一致（本机负载数据：并行聚合不可靠，单独运行是唯一可信门禁信号），非本轮引入。

## Phase-11 后剩余项

- **P0/P1/P2 路线全部收官**。后续切片按需：
  - P2-2 接线：agent runtime 工具边界挂账本（hub 总线信封已有 requestId/sessionId 钩子点）；恢复期 replay-or-fork 接入 SessionVersioningService。
  - P2-1 接线：A2A HTTP/SSE server 挂载；Agent Card 动态生成（skills 取 catalog.list）。
  - P1 接线：middleware 接 agent runtime、P1-1 检索接 agentic search、P1-2 接 toolPolicies。
  - 可选增量：llms providers 请求层 span；`test:extended` 并入 CI；A2A/AG-UI 映射动工前逐条核验。

---

# 第十二阶段：middleware 链接线 agent 工具面（P1-4+P2-2 wiring）

> 约束不变：小提交、可单独回退、每步验证门。本轮为 **opt-in 接线**（host 按需包装工具集，未包装工具保持原行为——默认零行为变更）。

## Phase-12 提交清单

| # | Commit | 项 | 类型 | 内容 | 验证 |
|---|---|---|---|---|---|
| P12-1 | `7c04ae173` | P1-4+P2-2 接线 | feat | **工具中间件链接线**（core `middleware/wrap-tools.ts`）：`wrapToolsWithMiddleware(tools, { chain, sessionId })` 返回新工具对象（identity 字段保留、原对象不变、链边界类型擦除透传），其 `execute` 以中间件链环绕原执行器。**接线点选择**：agents 包不能依赖 core（成环），故接线在工具集——host 构建 runtime 前包装工具集；完整洋葱语义（retry 可表达）且 P1-4 四中间件与 P2-2 幂等账本同链复用；opt-in 默认关闭。连带修正：`ToolMiddlewareContext.toolCallId` 放宽为可选（AgentToolContext 本就可选）、链边界类型修正（executor unknown→Promise.resolve、tool.execute 边界转换） | core test:unit 1480 pass / 7 平台跳过 / 0 fail；middleware+ledger 套件 36/36；tsc 干净；biome 干净 |
| P12-2 | （本提交） | R6 | docs | 本节 | — |

## Phase-12 取证结论

1. **接线点 = 工具集，不是 runtime 内部**：洋葱式链需要 executor 可达；agents→core 单向依赖使 runtime 内接线必须新增反向依赖（成环）。包装工具集（`wrapToolsWithMiddleware`）在 core 导出、host 按需应用——零侵入、opt-in、可单测。
2. **泛型边界两处类型擦除**：链是 unknown 类型边界——`tool.execute` 需边界转换（TInput 未解析时 unknown 不可赋值）、executor 返回值需 `Promise.resolve` 包装（`=> unknown` 不满足 `=> Promise<unknown>`）。教训：**泛型工具类型与 unknown 链的接缝处，双侧都要显式边界转换**。
3. **hook bag 无法表达完整洋葱**：beforeTool/afterTool 两相钩子可表达 approval/budget/redaction，但 retry 的"环绕执行"无法在钩子里表达——工具包装是唯一能保留全部四个中间件语义的接线点。

## Phase-12 后剩余项

- 接线后续按需：P1-2 沙箱接 toolPolicies（SandboxRuntime 挂 run_commands 执行器）；P1-1 检索接 agentic search 调用方；P2-1 A2A HTTP/SSE server 挂载；P2-2 恢复期 replay-or-fork 接 SessionVersioningService。
- 可选增量：llms providers 请求层 span；`test:extended` 并入 CI；A2A/AG-UI 映射动工前逐条核验。
