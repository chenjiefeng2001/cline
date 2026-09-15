# Cline SDK 架构 vs 主流 Agent 软件 · 差距分析报告

> 分析日期：2026-08-26 · 分支 `scan-remediation/2026-08-26` @ `f63469aba`
> 方法：外部主流架构调研（2026 年公开文档/工程博客/论文）+ 本仓库代码取证（本 session 各提交与扫描报告 doc/scan/00–07）
> 证据标注：[S]=doc/scan 扫描报告 · [C]=本仓库代码取证（文件/行为）· [W]=外部资料（文末附录）

---

## 1. 执行摘要

1. **总体判断**：本仓库的"一核多宿主 + hub 会话总线"是一个**被低估的差异化资产**（同类产品中罕见地把多客户端会话总线做成一等公民并带协议版本协商），但在 **durable execution、长期记忆、标准协议输出（A2A/AG-UI）、执行隔离层级、guardrails 形式化** 五个维度上落后于 2026 年主流水位。
2. **最大单点差距是 durable execution 语义**：我们的 checkpoint/restore 是"会话状态快照"，不是"断点续跑"。行业已有公开研究（[W]ACRFence）证明这类 checkpoint-restore 存在工具副作用重放攻击，且 LangGraph/Claude Code/Cursor 同样未解决——这是我们用较小代价实现差异化领先的少数机会窗口。
3. **记忆是最大的功能空白**：按 CoALA 四分类衡量，本仓库只有工作记忆（上下文窗）+ 项目规则文件， episodic/semantic/procedural 三类长期记忆均缺失。2026 年这已是"原型 → 产品"的分水岭（[W]多篇综述）。
4. **协议面是单向的**：MCP client（含 stdio/HTTP/OAuth）已达标 [C]，但 hub/WebSocket 事件词汇表是私有协议——既不输出 A2A Agent Card，也不提供 AG-UI 标准化前端流，等于放弃了互操作红利。
5. **执行隔离是"审批当沙箱"**：一方工具面为终端/文件编辑器类（未见 browser/computer-use 一方实现），命令直接落在宿主 shell。2026 共识是微 VM 为不可信代码基线、进程级沙箱为交互式本地基线（Claude Code 1.3 已默认进程沙箱）。
6. **内部债务放大一切差距**：R2（core 13 万行=SDK 64%，vscode 32 万行单体）+ R3（四套测试框架）使任何对齐动作的单位成本高于对手；本轮新增的 win32 spawn 缺口系列（R9）也是该债的利息。
7. **建议主轴**：不打全面追赶战。以"hub 总线 + RuntimeHost 多模式"为支点，优先补 **tracing 对齐（P0，几周级）→ 记忆适配层（P1）→ 沙箱层级选项（P1）→ A2A 输出（P2）→ exactly-once 工具副作用账本（P2，差异化反超点）**。

---

## 2. 参照系：2026 主流 Agent 架构速览

| 参照物 | 定位 | 核心抽象 | 与本仓库最相关的启示 |
|---|---|---|---|
| Claude Agent SDK / Claude Code | "可复用的 agent runtime"，Code 只是宿主之一 [W] | agent loop + sessions(continue/resume/fork) + hooks(含 PreCompact) + subagents + skills + 权限求值序 | runtime 与产品表面分离的完成度；compaction 作为一等事件 |
| Anthropic Managed Agents | 托管运行时（$0.08/session-hour） | 沙箱+状态持久化+权限+错误恢复打包成 hosted session [W] | "self-hosted SDK ↔ hosted runtime"两轨战略的对照物 |
| OpenAI Agents SDK / Codex CLI | 轻量多智能体原语集 | handoffs、guardrails(in/out/tool)、sessions(SQLite/SQLAlchemy/Redis/加密)、默认开启 tracing、Sandbox agents(Filesystem/Shell/Memory/Skills/Compaction 能力声明)、HITL 审批恢复 [W] | 原语正交性与"默认可观测" |
| LangGraph 1.0 (+Deep Agents/LangSmith) | 编排运行时 | 图状态机 + **durable execution**（Postgres checkpointer 断点续跑）+ interrupts(HITL) + 长短期记忆 store [W] | checkpoint ≠ durable execution 的分野；治理作为图节点 |
| Microsoft Agent Framework 1.0 | AutoGen+Semantic Kernel 合并版（2026-04 GA，另发 Go 实现） | **确定性 workflow graph** 取代对话式路由 + **middleware 管道**（重试/预算/PII/审计）+ checkpoint/pause-resume + MCP/A2A/AG-UI 全支持 [W] | 中间件管道是 guardrails 的工业化形态 |
| OpenHands V1 (Software Agent SDK) | 开源编码 agent 产品化样板 | app server / agent-server 分离且**agent-server 位于沙箱内**；EventStream + event store(callbacks/webhooks)；Docker/K8s/Modal 运行时（cap-drop ALL）；skills/microagents [W] | 危险执行推到边界之后；事件存储的产品化（搜索/回调/webhook） |
| Letta (MemGPT) / Mem0 / Zep(Graphiti) | 记忆专精层 | OS 式三级分页（Letta，git-backed memory blocks）/ 托管低延迟检索（Mem0 p50≈0.15s）/ 时序知识图谱（Zep，LongMemEval 63.8 vs 49.0）[W] | 记忆是独立基础设施层，不是功能开关 |
| 协议栈 MCP / A2A / AG-UI | 互操作三支柱 | MCP=agent→tool（LF/AAIF 治理，Streamable HTTP，注册表签名）；A2A=agent→agent（SSE 流式+异步 webhook，100+ 企业）；AG-UI=agent→用户界面（Bedrock AgentCore 已支持）[W] | 私有协议词汇表的机会成本正在变大 |
| 沙箱共识 | 安全基线 | 进程级（Seatbelt/bubblewrap，Claude Code 1.3 默认）→ gVisor/容器 → **Firecracker microVM（不可信代码 2026 基线）** → 全 VM 合规层 [W] | 隔离层级是产品能力矩阵，不是部署细节 |

---

## 3. 本仓库架构现状画像（先立后破）

### 3.1 已验证的资产 [C][S]

| 资产 | 证据 |
|---|---|
| 单向分层 `shared→llms→agents→core`，六包职责纯度清晰 | [S]01；agents 包 ~3.9k 行完成完整循环 |
| 一核多宿主：CLI/VS Code/desktop/hub/examples 复用同一 workspace | [S]00；本 session 类型门禁覆盖 15 包 |
| **hub 会话总线**：WebSocket server + discovery 文件 + 协议版本三元组协商（current/min/max）+ 四类客户端（session/UI/runtime/schedule）+ capability.requested 反向调用 | [C]`sdk/packages/core/src/hub/*`，本 session RPC 链路集成测试取证 |
| RuntimeHost 四模式：local/hub/**remote**/auto（`createRuntimeHost`） | [C]`runtime/host/host.ts` |
| 会话持久化：JSONL full-read+tail-window（V18/V19 加固）、manifest store、git-backed checkpoint + SessionVersioningService 恢复流程 | [C]`session-messages-jsonl.ts`(648 行+测试)、`session-versioning-service.ts` |
| **Compaction 显式预算模型**：triggerTokens/targetTokens/overheadTokens/thresholdRatio + summarizer + preserveRecentTokens，阈值可配置(V21)，状态持久化到 hub（server-side compaction state 端点） | [C]`CoreCompactionBudget`、`session-compaction.ts` |
| 提示词缓存感知：system prompt prefix 稳定性专项（V16 task2） | [C]提交记录 |
| 审批与策略：per-tool toolPolicies(autoApprove/enabled)、interactive 门控、approval.respond 协议 | [C]`approval-handlers.ts` |
| 子智能体与团队：enableSpawnAgent/enableAgentTeams、血统字段（parentSessionId/parentAgentId/isSubagent/agentId/conversationId）、team progress projection、mission log 节流 | [C]`types/sessions.ts`、`team/` 工具目录 |
| 定时任务：cron service + schedule specs/executions + detached hub daemon | [C]`cron/`、`hub-daemon.ts` |
| 遥测：OpenTelemetry Provider + PostHog 特性开关 + captureSdkError | [C]`services/telemetry` |
| 评测基建：evals 场景化 runner + harbor 指标契约（P2-1 修复后 TS5/tsx）+ 手动冒烟 CI(R1) | [C]`evals/`、`.github/workflows/cline-evals-smoke.yml` |
| 发布工程：rollout A/B 灰度 + manifest 校验 + 崩溃自愈回滚 | [S]04 |

### 3.2 结论

这不是一个落后的系统——它是一个**编排/分发侧相当成熟、而"agent 内环"（记忆/隔离/可观测/互操作）尚未对齐 2026 水位**的系统。差距集中在后者。

---

## 4. 差距矩阵

评级：🟢 领先/持平 · 🟡 部分具备 · 🔴 缺失或显著落后

| # | 维度 | 本仓库 | Claude Agent SDK | OpenAI Agents SDK | LangGraph/MAF | OpenHands |
|---|---|---|---|---|---|---|
| 1 | 核心循环抽象 | 🟡 while-loop + RuntimeHost | 🟡 loop+sessions | 🟢 Runner+handoffs | 🟢 图/durable | 🟡 event-stream loop |
| 2 | 断点语义 | 🟡 checkpoint 快照（无续跑保证） | 🟡 resume/fork | 🟢 sessions+run-state | 🟢 durable execution | 🟡 事件重放 |
| 3 | 上下文工程 | 🟢 compaction 预算模型+缓存前缀 | 🟢 compaction 事件+context editing | 🟢 Compaction 能力声明 | 🟡 store+trimmer | 🟡 skills 注入 |
| 4 | 长期记忆 | 🔴 仅项目规则文件 | 🔴~🟡 memory tool | 🟢 Memory 能力+Sessions | 🟢 store/LangMem | 🔴 |
| 5 | 多智能体 | 🟡 teams/spawn 私有协议 | 🟢 subagents+harness 范式 | 🟢 handoffs/as-tool | 🟢 supervisor/graph | 🟡 delegation |
| 6 | 工具协议 | 🟡 MCP client(stdio/HTTP/OAuth) | 🟢 MCP 全面 | 🟢 MCP+hosted tools | 🟢 MCP+A2A+AG-UI | 🟢 MCP router |
| 7 | 执行隔离 | 🔴 宿主直执行+人审 | 🟢 进程沙箱默认(+托管微VM) | 🟢 Sandbox agents(本地/Docker) | 🟡 视宿主 | 🟢 Docker/K8s 默认 |
| 8 | Guardrails | 🟡 白名单+人工审批 | 🟡 权限求值序+hooks | 🟢 in/out/tool 三类原语 | 🟢 middleware 管道 | 🟡 |
| 9 | 可观测/评测 | 🟡 OTel+自建 evals（未闭环） | 🟢 tracing 产品化 | 🟢 默认 tracing span 树 | 🟢 LangSmith 闭环 | 🟢 event store+回调 |
| 10 | 浏览器/计算机操作 | 🔴 一方工具面未见（可经 MCP 补） | 🟢 computer use/预览验证 | 🟢 Computer 原语 | 🟡 | 🟢 Playwright 内置 |

> 注：矩阵为方向性定位，逐项证据见 §5；"🔴"表示在本 session 代码取证与扫描中未发现对应实现，不排除经 MCP/扩展间接获得。

---

## 5. 关键差距深析（Top 8）

### D1 · durable execution 缺位 —— checkpoint ≠ 断点续跑

- **现状 [C]**：checkpoint 保存 ref/runCount（git stash/commit），restore 走 SessionVersioningService 重建会话。但恢复后从"消息历史"继续，工具副作用（已发的请求、已建的资源）不在恢复语义内；无 step 级持久化、崩溃后自动续跑。
- **主流 [W]**：LangGraph 把"durable execution"列为核心卖点（每步持久化、失败自动从精确位置恢复）；OpenAI Agents SDK 的 run-state+session 可跨进程重启接续；MAF 有 pause/resume。同时 ACRFence 论文指出：包括 LangGraph/Claude Code/Cursor/ADK 在内，**没有任何框架在工具边界强制 exactly-once**——恢复时工具可能二次生效。
- **差距本质**：我们把"可回退"做成了产品功能（好！），但没把它升级成执行语义（每步 state 持久化 + 副作用账本）。
- **机会**：这是全场唯一"大家都没做好"的点。hub 总线天然记录全部命令信封（requestId/sessionId 都在）——补一个**工具副作用账本（idempotency-key + effect ledger）**即可同时获得：安全恢复（防重放）、审计、以及对外讲出的差异化故事。代价：中（hub 已有全部钩子点）。

### D2 · 长期记忆缺失 —— 只有"工作记忆"

- **现状 [C]**：跨会话连续性依赖 `.clinerules`/rules/workflows 等项目文件 + JSONL 历史（可读回但无检索/提炼机制）；无语义检索、无事实冲突消解、无时间性。
- **主流 [W]**：CoALA 四分类已成通用词汇；Letta（agent 自管分页 + git 版本化记忆块）、Mem0（托管、p50 0.148s）、Zep Graphiti（时序 KG，LongMemEval 63.8% vs Mem0 49%）三哲学并存；趋势是"consolidation layer"按类型路由。
- **差距本质**：缺的不是某个功能而是**一层抽象**（memory 接口 + 至少一个后端）。
- **建议**：P1 先做适配器（Mem0/Zep/Letta 任一 + 本地 sqlite 向量兜底），接口按 CoALA 分型设计；禁止把记忆塞进 system prompt 的反模式写进 ARCHITECTURE.md。编码场景的最小可行切片：**项目级 episodic（决策/踩坑记录）+ semantic（代码库事实卡）**，检索走 agentic search 优先、向量兜底。

### D3 · 协议面单向 —— 只进不出

- **现状 [C]**：MCP client 完整（stdio/HTTP/OAuth/管理器）；hub 事件词汇表（run.started/run.completed/session.created/approval.requested…）与 webview-protocol 为私有协议；未发现 A2A/AG-UI 相关实现。
- **主流 [W]**：MCP 进入 Linux Foundation AAIF 治理、注册表将带签名信任分级；A2A 被 Salesforce/ServiceNow/ADK 生产采用且补齐 SSE 流式+异步 webhook；AG-UI 被 AWS Bedrock AgentCore 支持，CopilotKit/LangGraph/CrewAI/Pydantic AI 皆有集成。三者互补：tool/agent/UI 各占一层，" serious agent 通常三者都要"。
- **差距本质**：我们的 hub 已经是"agent-to-agent 总线的形"，但说的是方言——别人听不懂，我们也听不懂别人。
- **建议**：P2 把 hub 暴露为 A2A server（Agent Card = 会话/发送/中止能力映射，天然契合）；webview-protocol 到 AG-UI 事件做一层映射适配评估。P0 阶段仅需冻结私有词汇表并出映射表，防止进一步漂移。

### D4 · 执行隔离层级不足 —— 审批当沙箱

- **现状 [C]**：一方工具面为终端命令/文件编辑/team 类；命令经 executors 直接落宿主 shell；安全靠 toolPolicies+人工审批；未见一方 browser/computer-use（需 MCP 补足）。另有本 session 发现的 win32 spawn 系列缺陷（R9：npm/.cmd EFTYPE 两处已修）暴露宿主耦合的维护成本。
- **主流 [W]**：Claude Code 1.3 默认进程级沙箱（Seatbelt/bubblewrap）；Codex CLI 三档（默认 workspace-write）；OpenHands 默认 Docker（cap-drop ALL/no-new-privileges）且 agent-server 在沙箱内；不可信代码的 2026 基线是 Firecracker microVM（E2B/Vercel 已产品化）。
- **差距本质**：缺一个**隔离层接口**（RuntimeHost 已是好底座——local/hub/remote 之外再加 sandboxed-local 即可），而不是重写执行器。
- **建议**：P1 分两步：① 进程沙箱档（macOS Seatbelt/bubblewrap，对齐 Claude Code 本地默认）；② 定义 SandboxRuntime 适配器接口（E2B/Docker 后端），remote 模式天然兼容云端沙箱。

### D5 · 多智能体编排语义偏私有

- **现状 [C]**：teams/spawn/血统字段齐全，team progress projection 甚至做了投影节流——工程完成度不低；但协作语义（谁让渡控制权、结构化产物如何交接、评估者独立性）没有形式化。
- **主流 [W]**：OpenAI 的 handoffs/as-tool 是已被广泛复制的最小原语；Anthropic 的 Planner→Generator→Evaluator（结构化 artifact 交接、独立评估上下文防自评通胀）成为长任务公认范式。
- **差距本质**：我们有通信管道，缺**编排模式库**。
- **建议**：P1 在 teams 之上发布两个官方 pattern：handoff（会话所有权转移——hub 的 session.attach/detach 已具备底层）与 evaluator（独立会话评审 + 结构化 critique schema）。成本低于自创第三种范式。

### D6 · 可观测性双轨制，评测未闭环

- **现状 [C]**：OTel provider + PostHog 并存；日志为 hub 文本行；evals 有 runner/指标契约但与线上 trace 无关联回路。
- **主流 [W]**：OpenAI Agents SDK tracing 默认开启（span 树：root run→agent→tool）；LangSmith 提供 trace→数据集→回归评测的闭环；Claude SDK 生产指南把 tracing 列为核心四机制之一。
- **差距本质**：遥测埋点是"运营视角"（用量/错误），缺"执行视角"（一次 run 的因果树）。
- **建议**：P0（最高 ROI）：以 OTel span 规范统一 agent/tool/hub 三层 span（hub 信封里 requestId 已是现成 trace-id 载体），evals runner 输出关联 traceId——评测回归即可锚定到具体执行树。

### D7 · Guardrails 未形式化为原语/管道

- **现状 [C]**：toolPolicies 白名单 + 人工审批 + hooks 文件（bash/AgentExtension 双轨）。
- **主流 [W]**：OpenAI 三类 guardrail（input/output/tool，tripwire 语义）；MAF middleware 管道（重试/预算/PII 脱敏/审计注入，横切关注点零侵入）。
- **差距本质**：策略散落在审批与配置里，缺少统一的"调用前后拦截链"抽象。hooks 已有 70% 雏形。
- **建议**：P1 把 beforeTool/afterTool/hooks 升格为有序 middleware 链，内置 retry/budget/redaction 三个官方中间件；审批降级为链上一个人工节点。

### D8 · 内核体量与公共 API 面（R2 的外部视角）

- **现状 [S][C]**：core ≈13 万行（SDK 64%），barrel 导出 975 行；apps/vscode 32 万行手写单体。
- **主流**：Claude Agent SDK 刻意"给 loop、registry、subagent 原语然后退场"；OpenAI 强调 lightweight primitives；smolagents 极简路线亦存活——**"runtime 最小内核 + 能力外挂"已是共同哲学**。
- **建议**：不做大爆炸重构（与 R2 路线图一致）；但新增能力一律走 extensions/plugins 面（现有 configExtensions/clientContributions 机制可承载），并把 barrel 按 `@cline/core/hub` 模式继续细分收敛。

---

## 6. 不应被差距叙事掩盖的优势

1. **hub 会话总线**：多客户端（IDE/CLI/runtime/UI）同场协作 + 协议版本协商 + 反向 capability 调用——在参照系中没有直接对应物；它是未来 A2A/托管化的最佳地基。
2. **RuntimeHost 四模式**：`remote` 模式的存在意味着"Managed Agents 式"两轨（自托管 SDK ↔ 托管运行时）我们只差运营层，不差架构层。
3. **compaction 预算显式建模**：比多数框架的黑盒压缩更可解释、可调参、可持久化——值得写成对外技术叙事。
4. **git-native checkpoint 的产品化**（versioning service、restore 流程、VSIX 标记验证文化）。
5. **发布工程**：灰度 + manifest 一致性 + 崩溃自愈，属于编码 agent 赛道的稀缺能力。
6. **工程过程纪律**：可单独 revert 的小提交 + 修复日志追溯（本分支 23 个提交即为示范）——大型重构的安全网。

---

## 7. 行动路线图（ROI 排序，衔接既有 R2/R3/R9）

| 优先级 | 动作 | 对应差距 | 规模估计 | 备注 |
|---|---|---|---|---|
| **P0-1** | OTel span 树统一（agent/tool/hub 三层，requestId 作 trace 关联）+ evals↔traceId 闭环 | D6 | 数周 | 纯增量，不动现有行为 |
| **P0-2** | win32 spawn 收敛：抽公共 shell-spawn 助手，替换 MCP/plugin 两处复制粘贴（R9 系列） | D4 附带 | 数天 | 防 R9 类缺陷再发 |
| **P0-3** | 冻结 hub/webview 事件词汇表 v1 并产出 →A2A/AG-UI 映射草案（只写文档） | D3 | 数天 | 防漂移，为 P2 铺路 |
| **P1-1** | Memory 抽象层 + 首个适配器（建议 Zep 或 Mem0；本地 sqlite 兜底）；编码场景切片：episodic 决策记录 + 代码库事实卡 | D2 | 4–6 周 | 接口按 CoALA 分型 |
| **P1-2** | 沙箱两档：进程沙箱（Seatbelt/bubblewrap）+ SandboxRuntime 适配器接口（Docker/E2B） | D4 | 4–8 周 | remote 模式天然承接云沙箱 |
| **P1-3** | teams 官方 pattern：handoff（基于 attach/detach）+ evaluator（独立会话+critique schema） | D5 | 2–3 周 | 纯上层，无内核改动 |
| **P1-4** | hooks→middleware 链升格，内置 retry/budget/redaction | D7 | 2–4 周 | 审批成为链上节点 |
| **P2-1** | hub 暴露 A2A server（Agent Card 映射 start/send/abort/stream） | D3 | 3–4 周 | 依赖 P0-3 |
| **P2-2** | 工具副作用账本 + idempotency-key（恢复期 replay-or-fork 语义） | D1 | 4–6 周 | **差异化反超点**，引用 ACRFence 叙事 |
| **持续** | R2（沿 sdk-migration 迁移+barrel 收敛）/ R3（Vitest 主轴）/ R9（spawn 债清偿） | D8 及工程健康 | 既定路线 | 见修复日志 |

---

## 8. 附录：主要参考资料

**Claude 侧**
- Agent SDK hooks（PreCompact/SubagentStop 等）：code.claude.com/docs/en/agent-sdk/hooks
- Subagents：code.claude.com/docs/en/agent-sdk/subagents
- Context editing / compaction：platform.claude.com/docs/en/build-with-claude/context-editing
- Production guide（loop/sessions/permissions/tracing）：inference.net/content/claude-agent-sdk-production-guide
- Managed Agents 与三 agent harness：zylos.ai/research/2026-04-20-claude-agent-sdk-managed-agents-architecture

**OpenAI 侧**
- Agents SDK 文档（Guardrails/Sessions/Tracing/Sandbox/Memory/Computer）：openai.github.io/openai-agents-python
- developers.openai.com/api/docs/guides/agents

**编排框架**
- LangGraph overview / durable execution：docs.langchain.com/oss/python/langgraph/overview；github.com/langchain-ai/langgraph
- MAF：learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen；microsoft/agent-framework

**编码 agent 产品**
- OpenHands runtime/event/skills 架构：docs.openhands.dev/openhands/usage/architecture/runtime；martianlee.github.io/posts/2026-05-17-openhands-architecture
- Devin 综述：techunfoldedai.com/devin-ai

**记忆**
- 四家对比与 LongMemEval：agentmarketcap.ai/blog/2026/04/08/agent-long-term-memory-architecture-letta-memgpt-langmem-zep；baeseokjae.github.io/posts/agent-memory-architecture-guide-2026

**协议栈**
- MCP/A2A/ACP 收敛：zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence
- AG-UI 与 MCP/A2A 关系：docs.ag-ui.com/agentic-protocols
- 标准地图：gravity.fast/blog/ai-agent-interoperability-standards-2026

**沙箱**
- 八方案对比：amux.io/guides/ai-agent-sandboxing
- 五层隔离与 Claude Code 1.3/Codex 默认档：digitalapplied.com/blog/ai-agent-sandboxing-isolation-patterns-2026

**Checkpoint 语义研究**
- ACRFence: Preventing Semantic Rollback Attacks in Agent Checkpoint-Restore（arXiv:2603.20625）
