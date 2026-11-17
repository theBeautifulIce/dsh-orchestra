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
| S5 查询/面板 | 查询和若干屏已接真实 API；任务和流程 SSE 刷新已重置分页；S5-B 已补 54 条读模型/SSE/面板回归用例 | 其余屏、宿主挂载、视觉与双视口检查、查询投影仍需按原计划验收 |
| 命令回执 | POST 结果不明时会查回执；回执查询网络错误也已统一为 `OPERATION_OUTCOME_UNKNOWN` | 页面上的命令仍需逐个确认成功、拒绝、重试和未知结果 UI |
| 副作用核实 | 结算契约已冻结（S5-A 附录 `docs/superpowers/specs/2026-11-17-s5-effect-resolution-addendum.md`）；migration 031 增加关系/终态 guard | 契约不是实现：无核实写命令上线；031 仍不验证 node_run 事件链 |
| 记忆 | migration 030、固定图、注册表、canonical 校验与直接写工具禁令已有 | 注册表不是运行时端口；图常量不是可执行工作流；批准字段不等于 apply 闭环 |
| 测试 | S5-B 后全量 Vitest 88 文件 / 1086 通过 | 1 skipped，typecheck 通过 | 未跑 build 与 G5 门；没有 S5 CI 或 G5 证据 |
| 门状态 | G5 尚未交付 | 不创建 PASS 门记录，不沿用 S1–S4 测试数字 |

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

**状态：** Task 9 部分实现；列表已接真数据，详情字段和写操作闭环未完成。

**权威任务：** S5 实施计划 Task 3、Task 9。开始前核对查询投影可用字段；缺失的业务事实必须补 schema/查询，不能 UI 猜值。

**负责文件：** 以计划 Task 3/9 文件表为准；原则上限于 `src/service/queries/`、`src/service/commands/`、`src/client/api/`、`src/client/panel/decision-inbox.tsx`、待核实详情组件及对应 tests/migrations。

**依赖与验收：** 先完成 S5-A；列表/详情能追溯到同一 run/node/decision/evidence；命令有 permission、revision/CAS、receipt 与未知结果 UI；已核实记录只有在合法同事务结算后消失；页面不能将人证当系统证据。

### S5-D：完成工作流管理屏（Task 10）

**状态：** Task 10 部分实现；只读列表/检查页已有，草稿保存/发布与面板命令未完成。

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

**状态：** 尚未开始。当前固定图是静态定义，`MemoryBridgeRegistry` 是注册表；两者都不表示 AgentLifecycle 已能执行记忆图。

**目标：** 将固定图节点装载、分支/审批路由、端口调用和终态收口接入现有执行主链，且仍使用 node_run/attempt、租约、事件、恢复与执行器权限边界。

**先读：** S5 Task 11、`src/core/memory-graph.ts`、MemoryBridgeRegistry 定义、`src/app/agent-lifecycle/run-node.ts`、dispatcher、`src/service/runs.ts` 与 runtime workflow node types。

**负责文件：** memory graph loader/runtime adapter、memory bridge port handlers、executor/session 权限路径、对应 integration tests；尽量不更改通用 workflow 状态机。如果必须新增节点类型或状态，先修订规格并补迁移/兼容规则。

**验收：** 固定图按唯一声明顺序执行；非法边/未知端口 fail closed；memory.evaluate / inspect / apply 的身份和参数不能由 Agent 自由构造；端口调用可恢复、幂等且有可追溯事件；普通 workflow 与现有执行回归不变；直接 `memory_write` / `memory_update` 仍被拒绝。

**停止条件：** 若需把 memory graph 注入任意 workflow，或需要普通 Agent 拥有记忆写权限，停止并回到设计评审，不以临时 special case 绕过。

### S5-G：评估、审批和结果落账（Task 13）

**状态：** 尚未开始。依赖 S5-E 的持久批次和 S5-F 的可运行固定图/端口契约。

**权威任务：** S5 实施计划 Task 13 与规格 §9.5–9.6。

**负责文件：** `src/core/memory-eval.ts`、`src/service/commands/memory.ts`、相关 fixed-graph/port adapter、`tests/memory-eval.spec.ts`。

**验收重点：** 评估端口只评估不写；返回 schema 严格校验；超时/不可用/截断/非法输出有规定终态；每次重评估保留 attempt；只有 ready 产生一个审批卡；审批 24 小时过期不自动批准；拒绝和过期不调用 apply。

### S5-H：受控记忆写入与不确定状态对账（Task 14；高风险包）

**状态：** 尚未开始。依赖 S5-G 的审批与批准快照；必须作为独立高风险切片，不得与固定图运行时或评估实现合并。

**权威任务：** S5 实施计划 Task 14、规格 §9.7 与 G-06/G-11/G-12。

**负责文件：** `src/service/commands/memory.ts`、`src/service/queries/memory.ts`、`memory.apply_governed` adapter、迁移（如确有需要，编号 032 起）、`tests/memory-apply.spec.ts`。

**强制执行顺序：** 先全量验证批准快照和绑定，再原子写整批；不确定结果保持 applying/indeterminate 并 inspect；绝不可因 tool.result 丢失而重放整批。批准后改正文、元数据、插入/删除行、hash 不一致、部分写入进程退出均需故障测试。每次恢复依照 inspect 逐条状态，不能猜测。

**验收：** Task 14 的每条错误优先级、幂等、完整/零条/部分写入恢复用例均通过；工具端点只有 `decision_id` 入参；无普通 Agent 记忆写工具。

### S5-I：记忆面板与审批卡（Task 15）

**状态：** 尚未开始。依赖 S5-G/S5-H 的查询/API 契约稳定。

**负责文件：** `src/client/panel/memory-panel.tsx`、`src/client/panel/decision-inbox.tsx`、API resources/types、`tests/panel-memory.spec.ts`。

**验收：** 12 条状态文案逐字符合规格；只展示查询返回的事实；developer details 默认折叠；indeterminate 只允许规格指定的人工接管动作；没有 batch/evaluation 查询 API 时不得用组件内假数据填充。

### S5-J：其余面板收口、宿主接入和 G5 前视觉/实时检查

**状态：** Task 7–10 与 17 部分缺口；宿主 `createEventStream` 仍是可选接入点；无全量 S5 前端/实时证据。

**权威任务：** S5 实施计划 Task 5–10、Task 17；先检查 `PanelAppProps`、插件入口和宿主 capabilities。

**验收：** SSE 在正式宿主入口创建并传入；连接状态/游标缺口/轮询降级可观察；六屏每屏无占位假数据；命令回执流闭环；屏幕窄/宽视口无横向溢出、字号和对比度符合 S5 门槛；Task 17 的自治档位/批准人显示遵守权限可见性。

### S5-K：G5 独立预检与签门（最后执行）

**状态：** 尚未开始。

**权威任务：** S5 实施计划 Task 16、`审计要求.md`、现有 `docs/gates/` 规则。

**阻断条件：** 任一必过项缺少复现证据；全量测试/build 未在候选 SHA 运行；G-06/G-11/G-12 任一没有注入脚本、前后账本片段和恢复对账查询；记忆写入安全故障用例不全；面板实时或视觉验收未完成。满足阻断条件时报告缺口，不创建 PASS 门文件。

**提交纪律：** 先冻结候选 SHA，运行全量 `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm gate --gate G5` 与要求的证据复现；由独立审计按 `审计要求.md` 评审该 SHA。审计 PASS 后再写/签 G5，不修改候选代码；如需修复，生成新候选并重跑受影响证据。

## 4. 下一位智能体领取的唯一第一项

S5-A 已完成（155b37a9f82c69ee6876c473a1b82f095ea401e0），S5-B 已完成（`0f77074` + `51c9cce`），S5-E 已完成（`266ca72`）。本轮并行推进 S5-C（决策与待核实页面/命令，依赖 S5-A 契约）与 S5-D（工作流管理屏 Task 10），并已切出 S5-Fa（固定记忆图声明表）与 S5-Ga（评估端口纯逻辑层）两个纯新增切片；其后下一包是 **S5-F**（记忆固定图运行时）与 **S5-G**（评估与审批卡），再后是 **S5-H**（受控写入 apply / inspect / 对账）、S5-I/S5-J（面板与视觉）、S5-K（独立测试审计）。结算写入口仍属 S5-C，实现必须逐条对照 S5-A 附录的判定矩阵，不得按 `status='resolved'` 放行。

## 5. 完成状态更新模板

每完成一个包，将对应标题下的 `状态` 更新为 `完成（<commit SHA>）` 或 `部分完成（<明确余项>）`，并在 `handoff.md` 顶部追加当前状态。不得删除失败测试、未决规则或历史验证范围。
