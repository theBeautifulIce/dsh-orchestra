# S5 后续接手工作包

> 用途：把剩余 S5 工作拆成低上下文、可验证、可独立提交的小任务，供后续接手智能体逐项执行。
> 基线：`269f62d32ec12a0bd67567e9f944d32ad629fa89`（2026-11-17）。
> 权威关系：领域规则以 `GLOSSARY.md`、规格和 ADR 为准；S5 范围/验收以 [S5 实施计划](2026-11-12-dsh-orchestra-s5-panel-memory.md) 为准；产品先后顺序以 [产品路线](2026-11-17-product-roadmap.md) 为准；本文只负责把尚未完成项排成接手队列。

## 1. 接手者先读与执行规则

开始前按顺序阅读：

1. 仓库根目录 `AGENTS.md`、`审计要求.md`、`GLOSSARY.md`。
2. 本文 §2 当前状态和 §3 工作包队列。
3. S5 实施计划中与本次工作包对应的完整章节，不要只按本文件摘要猜字段或状态。
4. 相关规格章节与 `docs/adr/0001-ledger-single-writer-node-sqlite.md`。
5. 代码结构查询使用 `codebase-memory` skill。当前索引基线为上述 SHA；索引 coverage 已提示 migration 031 解析不可用，SQL 必须直接读源文件。索引结果显示 metadata_changed 或 missing 时，也必须读当前源码后再下结论。

执行纪律：

- 一次只做一个工作包；完成后 typecheck、该包定向测试、`git diff --check`，汇报后再取下一个包。
- 不因测试环境不熟悉而删弱断言；先读相邻测试和 fixtures。不能安全补测试时，写清具体阻塞点并继续无依赖文档工作。
- 所有 DB 写入经过 service command 与账本事务；不从面板直接访问 SQLite，不在读路径写数据。
- 事件与业务状态分离。SSE/bridge ACK 不能替代业务决定、接收或核验状态。
- 未观测事实不能推断成成功、失败、证据充分或已结算。所有不确定副作用保持 indeterminate，先核对账本再恢复。
- 不开放普通 Agent 的直接记忆写工具；唯一写入口只能是受治理的 `memory.apply_governed`。
- 不启动 S6 能力、release、R1/R2、多工作区或通用 Agent 聊天；不提前签 G5。
- 每个可审阅切片单独提交并推送；提交后更新 `handoff.md` 中的 SHA、状态、测试结果和唯一下一步。

### 每个工作包的交付格式

接手智能体完成工作包时，必须在回复和 `handoff.md` 记下：

```text
工作包：S5-X
改动：<用户可理解的一句话>
新增/修改文件：<清单>
验证：<原样命令 + 通过/失败 + 数字>
未完成/风险：<没有则写“无”；不得把未验证写成通过>
提交：<完整 SHA>
下一工作包：<编号>
```

## 2. 当前状态快照

| 区域 | 当前状态 | 不要误判为完成 |
| --- | --- | --- |
| S1–S4 | 已收尾，G1–G4 已签署 | 不重新打开已签门范围，除非新改动触及不变量 |
| S5 查询/面板 | 查询和若干屏已接真实 API；S5-B 已补 54 条读模型/SSE/面板回归用例；S5-D 草稿编辑器与拖拽画布已交（`d1400b2` + `0c8ee22`）；S5-J 设置屏、宿主入口与双视口视觉检查已交（`22358c0`）；WP-A 面板侧八项已交（`fa191be`） | 六屏占位假数据未逐屏清零；命令回执流闭环与真实 HTTP 端到端仍缺；`additionalScreens` 注入路径未覆盖 |
| 命令回执 | POST 结果不明时会查回执；回执查询网络错误也已统一为 `OPERATION_OUTCOME_UNKNOWN` | 页面上的命令仍需逐个确认成功、拒绝、重试和未知结果 UI |
| 副作用核实 | 结算写入口已上线（`adbaec4`：`src/service/commands/effects.ts` 唯一受控写入口 + 附录 §10 的 27 条用例）；`EFFECT_RESOLUTION_CONFLICT(409)` 已加码并补进规格 §17.1 | 弱证据判据仍来自请求自带 `evidence_source` 声明（DB 内无弱证据标记），审计须记为未解决风险；`memory-runtime.ts` 5 处 patch 不写 `stop_evidence`，与 `run-close.ts` 未验证口径冲突 |
| 记忆 | migration 030、固定图、注册表、canonical 校验与直接写工具禁令已有；固定图声明源（`1faf38b`）、评估纯逻辑层（`5580ab3`）、运行时骨架与命名统一（`e8c3b39`）、审批卡与批准落库（`e6f1d08`）、三端口与固定图推进（`1065b8b`）、批次只读投影（`375806a`）已有 | 三端口真实处理器已实现但未接生产主链（`src/index.ts` 无 memory 装配）；批准字段不等于 apply 闭环；`GET /v1/memory/batches` 路由未接线 |
| 测试 | 全量 Vitest 109 文件 / 1335 通过 / 2 跳过（最近一笔代码提交 `375806a`）；`node scripts/check-test-layout.mjs` exit 0；`node scripts/visual-check.mjs` exit 0 | 2 跳过（perf-budget 的 Q-27、gate-check 的 1 条） | `pnpm build` 已补跑 exit 0；没有 S5 CI 与 G5 证据 |
| 门状态 | G5 尚未交付；门闸规格 `GATE_SPECS.G5`（73 项）、门记录模板生成器、证据生成器、73 项就绪矩阵已就位 | 不创建 PASS 门记录，不沿用 S1–S4 测试数字 | 73 份证据须在候选 SHA 冻结前产出并提交；G-11 注入用例不存在 |

## 3. 工作包队列

依赖按顺序执行；某个工作包发现前置规格不一致时先停该包并修订文档，不得用临时猜测绕过。

### S5-A：冻结副作用核实/结算写入契约（规格先行）

**状态：** 完成（155b37a9f82c69ee6876c473a1b82f095ea401e0）。产物：`docs/superpowers/specs/2026-11-17-s5-effect-resolution-addendum.md`（三条路径判定矩阵、状态相容矩阵、事务步骤、错误优先级、27 条故障案例与测试名）。本包未添加任何核实写入口。

**目标：** 决定何种证据或人工决定可以使 `unverified_resolutions` 从未结算变为已结算，并写清楚同一事务里的验证步骤。暂不实现 HTTP/UI 写入口。

**先读：** S5 计划 Task 3，规格 §4.5.5、§8.2、§9 与 Q-32；`src/service/queries/evidence.ts`、`src/service/commands/decisions.ts`、migration 029/031。

**负责文件：** 先改 S5 计划/规格对应章节；只有当现有架构决策已无法表达、且确需作出新架构决定时才新增 ADR。不要改已应用的 migration 029；新 DDL 用连续编号。

**必须明确：**

1. evidence basis 要求同 node_run、当前 attempt、`tool_executions.finished_at`、匹配 `tool_finished` 事件及有效事件链；服务写事务用密钥验证链，不假设 SQL trigger 能验证哈希。
2. decision basis 允许的 `kind`、最终状态、`closed_reason`/resolution、与副作用结论之间的映射。仅 `status='resolved'` 不代表其结论证明副作用发生。
3. verified-none 必须与 `side_effect_verified_none=1` 和完全相同 stop evidence 一致。
4. 核实命令的 operation_id 幂等、CAS、事件记录、失败回滚、权限、错误优先级和读模型可见性。
5. 哪些输入属于人工声明，不能伪装为系统证据。

**验收：** 短规格包含状态转换表、可接受/拒绝矩阵、事务步骤、故障案例和对应测试名；用户或架构维护者能根据文档唯一实现。该包结束仍不得添加核实写入口。

### S5-B：读模型、事件流与面板测试基座

**状态：** 完成（`0f77074` 测试基座；`51c9cce` 修既有陈旧用例）。新增 8 个测试文件、54 条用例：结算前后 `unverified_count`/attention、evidence strong 可读性与三种坏因、workflow 活跃任务计数去重、SSE 幂等/序号缺口重同步/断线降级、第二页 reload 重置、四屏各 5 态、服务端 nextSeq 连续性与 resync 帧。未覆盖：记忆屏/设置屏五态（组件尚不存在）、SSE 真实 HTTP 端到端、视觉与双视口（留给 S5-I/S5-J）、additionalScreens 注入路径。

**目标：** 让当前已有的读模型/SSE/React 行为有回归保护，覆盖审计提出的真实数据一致性风险。

**负责文件：** `tests/integration/queries.spec.ts` 或按查询域拆分的新 integration specs；新增 `tests/client/` 或仓库现有测试分类下的 API/SSE/panel specs。生产改动只限测试暴露的缺陷。

**第一批验收场景：**

- task summary：结算后 `unverified_count=0`，attention 不再因同一事项显示 unverified。
- evidence：没有 tool_finished、事件链损坏、记录字段不匹配均不能得到 strong；完整匹配证据可读取。
- workflow：根 Run 与子 Run 活跃时均正确计数，每个 task 对单一 workflow 只计一次。
- SSE：重复事件幂等、序号缺口触发完整重同步、断线后的 stale/polling 与恢复状态有断言。
- 任务/流程页：位于第二页时收到 reload，旧行不残留、不重复，查询从第一页开始。
- 每屏至少覆盖 loading、empty、error、unknown/stale 以及真实数据状态。

**不在本包：** 不为测试而重写面板架构；不声称仅有单测就完成 G5 实时验收。可视布局/两个视口检查留给 S5-I。

### S5-C：完成决策与待核实页面/命令（依赖 S5-A）

**状态：** 部分完成。结算写入口已交（`adbaec4`：`src/service/commands/effects.ts` 唯一受控写入口 + 附录 §10 的 27 条用例 + `EFFECT_RESOLUTION_CONFLICT(409)`，规格 §17.1 已补行）；面板侧已交（`0c8ee22`：`src/client/api/decision-commands.ts` 只暴露 acknowledge / resolve、UUIDv7 operation_id、模糊三码只查回执不重发；`tests/client/decision-panel.spec.tsx` 13 例）。**余项：** 裁决投影四列（`priority` / `priority_reason` / `expiry_effect` / `expiry_effect_reason`）服务端无人写值（迁移 033 已加列，`src/service/commands/decisions.ts` 的 `openDecision` INSERT 不写）；`POST /v1/decisions/acknowledge` 路由不存在 → 客户端 acknowledge 会 404；`src/service/queries/decisions.ts` 仍把 priority / allowed_resolutions 等写死 null 并列入 `projection_missing`。

**权威任务：** S5 实施计划 Task 3、Task 9。开始前核对查询投影可用字段；缺失的业务事实必须补 schema/查询，不能 UI 猜值。

**负责文件：** 以计划 Task 3/9 文件表为准；原则上限于 `src/service/queries/`、`src/service/commands/`、`src/client/api/`、`src/client/panel/decision-inbox.tsx`、待核实详情组件及对应 tests/migrations。

**依赖与验收：** 先完成 S5-A；列表/详情能追溯到同一 run/node/decision/evidence；命令有 permission、revision/CAS、receipt 与未知结果 UI；已核实记录只有在合法同事务结算后消失；页面不能将人证当系统证据。

### S5-D：完成工作流管理屏（Task 10）

**状态：** 部分完成。已落：流程列表新建入口、草稿编辑器（JSON 文本框编辑 + 保存/发布走命令回执）、检查面板按节点/连线分组、发布确认四件事、`src/client/api/workflow-commands.ts`（四条写命令 + 结果不明只查回执）、`app.tsx` 接线（`d1400b2`）；**拖拽画布已交**（`0c8ee22`：`src/client/panel/workflow-canvas-nodes.tsx` 纯逻辑层 + `src/client/panel/workflow-canvas-view.tsx` 视图 + `workflow-editor.tsx` 以抽屉 JSON 为唯一真源 + `tests/client/workflow-canvas.spec.tsx` 10 例）。**余项：** 画布拖动/连线只有鼠标路径、无键盘可达性；命令与编辑器尚无真实 HTTP 端到端证据；视觉/双视口走查已由 S5-J 交（见下）。

**权威任务：** S5 实施计划 Task 4、Task 10。

**负责文件：** `src/service/commands/workflows.ts` 现有命令、相关 API route/client、workflow editor/list components、schema validators 和 tests；文件范围以 Task 4/10 原文为准。

**验收：** 编辑只改 draft；结构校验结果与计划质量意见分开；保存/发布经 command receipt；已发布版本不可变；任务运行绑定固定 workflow version；并发修订冲突可见；不创建自然语言 planner（属于 M1）。

### S5-E：记忆入口、权限闸与幂等启动（Task 11–12）

**状态：** 完成（`266ca72`）。直接 Agent 写工具继续被拒绝。已落：事务内建运行入口（`insertRunInTx` / `insertNodeRunsInTx`）、`memory_start_run`（request_key + operation_id 幂等、`MEMORY_RUN_ACTIVE` 冲突、`MEMORY_SOURCE_RUN_NOT_SETTLED` 前置）、迁移 032（未终结批次部分唯一索引 + 源运行收口触发器）、三面写工具闸。**余项：** 路由 `POST /memory/runs/start` 未接线；task_session 面闸未接模板加载；记忆节点 `node_type` 命名与拓扑序待 S5-F 统一。

**权威任务：** S5 实施计划 Task 11/12；启动事务必须检查 `src/service/runs.ts:createRun()` 与 `src/infra/db/tx.ts`。

**顺序：**

1. 补 workflow / executor / task-session 的直接记忆写权限负例与 migration 030 数据约束测试。
2. 从 `createRun()` 抽取事务内创建入口，保证与记忆 batch、节点、`memory_run_requests` 映射同事务提交；不要先创建 Run 再独立写幂等表。
3. 实现 `memory_start_run`：source Run 只接受 `succeeded`；同 `(source_run_id, request_key)` 返回同一结果；同源新 key 遇到活跃记忆 Run 返回 `MEMORY_RUN_ACTIVE`；校验后的同目标重复保存为 skipped。

**验收：** 注入事务中途失败后无半成品；并发重复请求只创建一个 memory Run/batch；重复请求返回相同 ID/receipt；权限三条路径均能拒直接写工具。

### S5-F：固定记忆图运行时与三端口接线（Task 11 尚缺部分）

**状态：** 部分完成。S5-Fa 已交（`1faf38b`）：固定图声明源 src/core/memory-graph-schema.ts（9 节点、显式拓扑序、装载即 fail-closed 校验，错误码全部复用既有码）。S5-Fb 已交（`e8c3b39`）：端口能力表收敛到 src/core/memory-graph.ts 单一来源、记忆 node_type 统一到 kind 六值并取 memoryGraphOrder() 拓扑序、专用记忆运行路径 src/service/commands/memory-run.ts、task_session 面写工具闸接生产路径 resolveTaskSessionToolPolicy。**三端口与固定图推进已交**（`1065b8b`：`src/service/commands/memory-ports.ts` 的 evaluate / applyGoverned / inspect 三端口 + `src/service/commands/memory-runtime.ts` 的 `advanceMemoryRuntime` 固定图九节点推进 + `tests/integration/memory-runtime.spec.ts` 17 例）。**余项：** 记忆运行时 5 处 patch（`memory-runtime.ts:509/561/816/938/1021`）写 `side_effect_policy` + `side_effect_verified_none` 但不写 `stop_evidence`，与 `run-close.ts:68-71` 的未验证判定式冲突 → 驳回/过期路径 run 终态会误报 `failed_with_unverified`，须改为「先 M-41 迁移、再用 `resolveEffect(basis=verified_none, stopEvidence=no_tool_started:<node_run_id>:<attempt>)` 同事务落结算行」；固定图推进未接生产主链（`src/index.ts` 无任何 memory 装配）；记忆运行缺终态收口；`POST /memory/runs/start` 路由仍未接线。

**目标：** 将固定图节点装载、分支/审批路由、端口调用和终态收口接入现有执行主链，且仍使用 node_run/attempt、租约、事件、恢复与执行器权限边界。

**先读：** S5 Task 11、`src/core/memory-graph.ts`、`src/core/memory-graph-schema.ts`（已落地的固定图声明源）、MemoryBridgeRegistry 定义（src/executor/tools.ts）、`src/executor/run-node.ts`、dispatcher、`src/service/runs.ts` 与 runtime workflow node types。

**负责文件：** memory graph loader/runtime adapter、memory bridge port handlers、executor/session 权限路径、对应 integration tests；尽量不更改通用 workflow 状态机。如果必须新增节点类型或状态，先修订规格并补迁移/兼容规则。

**验收：** 固定图按唯一声明顺序执行；非法边/未知端口 fail closed；memory.evaluate / inspect / apply 的身份和参数不能由 Agent 自由构造；端口调用可恢复、幂等且有可追溯事件；普通 workflow 与现有执行回归不变；直接 `memory_write` / `memory_update` 仍被拒绝。

**停止条件：** 若需把 memory graph 注入任意 workflow，或需要普通 Agent 拥有记忆写权限，停止并回到设计评审，不以临时 special case 绕过。

### S5-G：评估、审批和结果落账（Task 13）

**状态：** 部分完成。S5-Ga 已交（`5580ab3`）：评估端口纯逻辑层 src/core/memory-eval.ts（只评估不写、schema 严格校验、超时/不可用/截断/非法输出终态）。S5-Gb 已交（`e6f1d08`）：审批卡与批准落库（`src/service/commands/memory-approval.ts` + `tests/integration/memory-approval.spec.ts` 15 例；批准时同一事务写 `memory_items.approved_content_hash` + `status=approved`/`skipped`，再把批次 UPDATE 成 approved 并回写 `approved_proposal_hash` / `approved_item_hashes_json` / `decided_at` / `decision_id`；写入顺序反了触发器报 `MEMORY_APPLY_BINDING_INVALID`）。**余项：** `mem_apply` 的前置批准复用 `mem_confirm` 的 `audit_result`（同一 decision_id、不新建第二张卡）已在 memory-runtime 记 `pre_execution.reused`，但审批 24 小时过期与拒绝后不调用 apply 的整链断言仍缺；评估出口接固定图推进的口径受上面 WP-C 缺陷影响。

**权威任务：** S5 实施计划 Task 13 与规格 §9.5–9.6。

**负责文件：** `src/core/memory-eval.ts`、`src/service/commands/memory.ts`、相关 fixed-graph/port adapter、`tests/unit/memory-eval.spec.ts`。

**验收重点：** 评估端口只评估不写；返回 schema 严格校验；超时/不可用/截断/非法输出有规定终态；每次重评估保留 attempt；只有 ready 产生一个审批卡；审批 24 小时过期不自动批准；拒绝和过期不调用 apply。

### S5-H：受控记忆写入与不确定状态对账（Task 14；高风险包）

**状态**　Q-54 三条对账与恢复分支已完成。宿主接口 `createMemoryRuntime` 绑定受控写入和停止后对账。G-11 使用独立的 SQLite 写入库和真实 SIGKILL 复现全写入、原子回滚与部分写入，证据见 `docs/gates/evidence/G5/G-11.md`。仍需把实际记忆插件适配到宿主入口并逐项补齐生产写入幂等冲突、面板恢复入口和最终 G5 证据。

**权威任务：** S5 实施计划 Task 14、规格 §9.7 与 G-06/G-11/G-12。

**负责文件：** `src/service/commands/memory.ts`、`src/service/queries/memory.ts`、`memory.apply_governed` adapter、迁移（如确有需要，编号 032 起）、`tests/integration/memory-apply.spec.ts`。

**强制执行顺序：** 先全量验证批准快照和绑定，再原子写整批；不确定结果保持 applying/indeterminate 并 inspect；绝不可因 tool.result 丢失而重放整批。批准后改正文、元数据、插入/删除行、hash 不一致、部分写入进程退出均需故障测试。每次恢复依照 inspect 逐条状态，不能猜测。

**验收：** Task 14 的每条错误优先级、幂等、完整/零条/部分写入恢复用例均通过；工具端点只有 `decision_id` 入参；无普通 Agent 记忆写工具。

### S5-I：记忆面板与审批卡（Task 15）

**状态：** 部分完成。已落：`src/client/panel/memory-panel.tsx`（十二句状态文案 + 四问 + 只读 GET + 开发者视图开关，`0c8ee22`）、审批卡视图在 `src/client/panel/decision-inbox.tsx`（`kind=audit_result` 走专用卡，跳过通用「接手」与通用 resolution 按钮，`0c8ee22`）、`src/client/api/types.ts` 的 MemoryBatchView 字段全集、批次只读投影 `src/service/queries/memory-batches.ts`（`375806a`，8 例）。**余项：** `GET /v1/memory/batches` 路由未接线（`src/service/server.ts` 无此路由）→ 面板拿不到真实批次；服务端开卡不把 `allowed_resolutions` 写进 payload → indeterminate 的「放弃这次写入」按钮恒禁用（`src/core/memory-eval.ts:334` 按规格 9.6 恒为空数组是对的，缺的是 `verify_human` 卡的 payload）；记忆批次部分写入的对账证据（G5-MEMORY-RECONCILE）未产出。

**负责文件：** `src/client/panel/memory-panel.tsx`、`src/client/panel/decision-inbox.tsx`、API resources/types、`tests/panel-memory.spec.ts`。

**验收：** 12 条状态文案逐字符合规格；只展示查询返回的事实；developer details 默认折叠；indeterminate 只允许规格指定的人工接管动作；没有 batch/evaluation 查询 API 时不得用组件内假数据填充。

### S5-J：其余面板收口、宿主接入和 G5 前视觉/实时检查

**状态：** 部分完成。已落：设置屏 `src/client/panel/settings-screen.tsx`（六行真实状态，取不到显示「未知」）、宿主入口 `src/client/panel-host.tsx`（`createPanelHost` 装配 ApiClient + `createConnectedEventStream` + PanelApp）、无头视觉检查 `scripts/visual-check.mjs`（实测 1366×900 与 1600×1000，scrollWidth == clientWidth）、`tests/client/panel-visual.spec.tsx`（`22358c0`）；WP-A 面板侧八项 Q-02/05/06/07/19/20/22/23 有真实断言（`fa191be`，含 `scripts/check-panel-no-sqlite.mjs` 静态扫描）。**余项：** 六屏每屏占位假数据未逐屏清零；命令回执流闭环与真实 HTTP 端到端仍缺；`additionalScreens` 注入路径未覆盖；对比度只静态实算（规格 `:2171` 写 axe-core，仓内无 playwright/puppeteer，已记为口径差）。

**权威任务：** S5 实施计划 Task 5–10、Task 17；先检查 `PanelAppProps`、插件入口和宿主 capabilities。

**验收：** SSE 在正式宿主入口创建并传入；连接状态/游标缺口/轮询降级可观察；六屏每屏无占位假数据；命令回执流闭环；屏幕窄/宽视口无横向溢出、字号和对比度符合 S5 门槛；Task 17 的自治档位/批准人显示遵守权限可见性。

### S5-K：G5 独立预检与签门（最后执行）

**状态：** 尚未开始。基础设施已就位：`scripts/gate-check.ts` 的 `GATE_SPECS.G5`（73 项 items + 6 条 invariants + 73 项 evidenceMap/evidenceFiles）与 `src/core/gate-artifact.ts`（`f346bda`）、门记录模板生成器 `scripts/gen-g5-record.ts`（`e61fba1`）、证据生成器 `scripts/gen-g5-evidence.ts`（`8c0aea0`，只对「状态=proved 且证明用例非空」的行真跑命令）、73 项就绪矩阵 `docs/reviews/S5-g5-item-map.md`（`378c30e`，proved 27 / partial 37 / gap 12）。**阻断条件仍在：** 主矩阵回填 WP-A 八项、G-11 注入、73 份证据落库、冻结候选 SHA、build 全量、审计报告。

**权威任务：** S5 实施计划 Task 16、`审计要求.md`、现有 `docs/gates/` 规则。

**阻断条件：** 任一必过项缺少复现证据；全量测试/build 未在候选 SHA 运行；G-06/G-11/G-12 任一没有注入脚本、前后账本片段和恢复对账查询；记忆写入安全故障用例不全；面板实时或视觉验收未完成。满足阻断条件时报告缺口，不创建 PASS 门文件。

**提交纪律：** 先冻结候选 SHA，运行全量 `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm gate --gate G5` 与要求的证据复现；由独立审计按 `审计要求.md` 评审该 SHA。审计 PASS 后再写/签 G5，不修改候选代码；如需修复，生成新候选并重跑受影响证据。

## 4. 下一位智能体领取的唯一第一项

S5-A（`155b37a`）、S5-B（`0f77074` + `51c9cce`）、S5-E（`266ca72`）、S5-Fa（`1faf38b`）、S5-Ga（`5580ab3`）、S5-Fb（`e8c3b39`）已完成；S5-C、S5-D、S5-F、S5-G、S5-H、S5-I、S5-J、S5-K 均为部分完成（各段「状态」列已逐包写明已交提交与余项）。

**唯一下一项：WP-B 服务端读模型十一项**（Q-01、Q-03、Q-04、Q-08、Q-09、Q-24、Q-30、Q-31、Q-33、Q-34、Q-36）——这些项的服务端实现大多已存在，只缺用例断言与少数投影补齐，逐项定位见 `docs/reviews/S5-g5-item-map.md` 的对应行与「缺口与建议」列。

其后队列（按依赖顺序）：WP-C 记忆运行时结算口径修复（`memory-runtime.ts` 5 处 patch 缺 `stop_evidence`）→ WP-D 裁决投影四列 + `POST /v1/decisions/acknowledge` → WP-E 生产接线（`GET /v1/memory/batches` 路由、`src/index.ts` 三端口装配 + `POST /memory/runs/start` + 终态收口）→ 主矩阵回填 WP-A 八项 → G-11 注入用例 → 73 份证据落库（须在候选 SHA 冻结前）→ 冻结候选 SHA + 独立审计 round1 → 签 G5 门。

结算写入口已实现（`adbaec4`），后续任何改动必须逐条对照 S5-A 附录的判定矩阵，不得按 `status=resolved` 放行；G5 签门前不得创建 PASS 门文件。

## 5. 完成状态更新模板

每完成一个包，将对应标题下的 `状态` 更新为 `完成（<commit SHA>）` 或 `部分完成（<明确余项>）`，并在 `handoff.md` 顶部追加当前状态。不得删除失败测试、未决规则或历史验证范围。
