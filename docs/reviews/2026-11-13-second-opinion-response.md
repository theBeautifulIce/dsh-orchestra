# 《第二次意见》逐条处置对照

- 原意见：[`2026-11-13-second-opinion.md`](./2026-11-13-second-opinion.md)（2026-11-13 外部架构评审，原《第二次意见.md》）
- 处置时间：2026-11-14
- 口径：只写代码里真实存在的状态。没做的写清楚划到哪一批，不写成「已完成」。

## 一、第一批：S2 收口前必须完成的六项

| # | 意见 | 处置 | 落点与证据 |
| --- | --- | --- | --- |
| 1 | 在最新 HEAD 重新派发 S1、S2 独立审计 | 执行中 | 候选提交后派第四轮独立审计（S1 + G2），报告须内嵌结构化裁决块 |
| 2 | 修复并验证 14 条 G1 预签态失败 | 已落 | `tests/gate/gate-check.spec.ts` 引入 `PRE_SIGNED` 与 `expectRejected()`：预签态断言「必须被拒」，门重签后自动恢复指名。实测全量 36 files / 511 passed \| 1 skipped |
| 3 | 结构化审计结果替代单纯自然语言裁决 | 已落 | `src/core/audit-verdict.ts`（AUDIT_VERDICT_SCHEMA、parseAuditVerdict、validateAuditVerdict、verdictProblems）；`scripts/gate-check.ts` 以裁决块为放行权威，词法解析降为第二道防线；`tests/unit/audit-verdict.spec.ts` |
| 4 | 工具执行重复调用的唯一性 | 已落 | 迁移 006 `006_tool_executions_tool_seq.sql`：`tool_executions` 主键 `node_run_id+attempt+tool_seq`，`execution_id NOT NULL UNIQUE`；`src/executor/run-node.ts` 每次执行给 tool_seq 与 execution_id 并绑进 tool_started/tool_finished 事件；`src/service/commands/apply-report.ts` 按 execution_id 核对痕迹行与事件 |
| 5 | WorkflowCatalog 深拷贝与不可变快照 | 已落 | `src/core/freeze.ts` 的 `deepFreeze`；`src/service/workflows.ts:140` 冻结后进目录、`get()` 返深拷贝、`src/service/workflows.ts:69` 先落库再进内存；测试 `tests/integration/workflows.spec.ts:87`（改原始对象）、`:103`（改 get() 返回值）、`:114`（落库失败不留残影） |
| 6 | HTTP 输入 Schema 与时间参数边界 | 已落 | `src/service/schemas.ts`（Zod + `LIMITS`：租约 TTL 与续租间隔、工具超时、节点数、必留哈希数、attempt 范围、长度上限）；`src/service/server.ts` 九条路由统一 `parseBody`；`tests/contract/routes.spec.ts` |

第 1 项与第 2 项的完成条件是同一条：审计 pass → 重签 G1/G2 → 两门 `gate-check` exit 0 → 全量测试全绿。
在这三件事落齐之前，代码侧的完成度不写成「已放行」。

## 二、P1 逐条

### Agent Bridge 没有真正接入生产执行路径 —— 未做，划到 S3 第二批

现状：桥的 Buffer 层语义（断号重取、幂等、重连同一 fromSeq）有测试覆盖（`tests/unit/bridge-buffer.spec.ts`、`tests/unit/bridge.spec.ts`），
但生产执行路径 `runNode` 仍由宿主侧执行器驱动，Bridge 的 spawn/subscribe/send/state/fetchPage/dispose 全生命周期没有接进生产。

理由：意见原文把它列在第二批（S3 核心执行能力），并明确「桥事件确认必须晚于账本持久化」「dispose 必须晚于所有事件确认」。
这两条是同一条生命周期上的约束，分批接会接出半截状态机，所以整批留到 S3，届时的验收条件一并写进 S3 计划。

### WorkflowCatalog 的不可变性还不彻底 —— 已做

问题 A（内存引用可被外部修改）与问题 B（先写内存再写数据库）都已收口，见上表第 5 项；意见点名的三条测试已补齐。

### 同一个工具不能在一次节点执行中重复执行 —— 已做

见上表第 4 项。补充两点：
- 同名工具跑两次会拿到不同的 tool_seq 与 execution_id，不撞主键（`tests/integration/runtime.spec.ts`）。
- 第二次执行没有 tool_finished 留痕时，收口判 `evidence_unverifiable`，不许拿第一次的成功痕迹顶替（`tests/integration/apply-report.spec.ts`）。

### HTTP 入参校验和执行并发控制还不够严格 —— 已做

- 入参：见上表第 6 项。
- 并发：新增 `src/service/execution-scheduler.ts`（默认并发 3、人工名额 1，接 `orchestra.config.json` 的 `concurrency` / `human_slots`）；`src/service/dispatcher.ts` 有调度器时按节点占名额，没有则按 seq 串行。
- 写队列只管短写：`/v1/runs/dispatch` 与 `/v1/node-runs/run` 两个长任务路由不再排队等写队列名额（`src/service/server.ts`），避免续租被排队饿死导致租约过期。
- 写队列本身改成真 FIFO（`src/service/write-queue.ts` 的 tail 链）。

### node_run_events 没有数据库级别的只追加保护 —— 已做

- 迁移 007 加触发器：直接 UPDATE / DELETE 被数据库挡下（`tests/integration/ledger-integrity.spec.ts:51/:57`）。
- `verifyLedger` 遍历所有 node_run，比对链头记录的条数、链尾 seq、链尾 hash：尾部删除、整链删除、中间篡改、缺链、链头缺失都能报出（`tests/integration/ledger-integrity.spec.ts:131`-:186`）。
- 迁移 007 的触发器会让「造篡改数据」的用例写不进去，所以这类用例要先显式 `DROP TRIGGER` 再造，造完再跑校验。

## 三、第三节的分层建议与现状对照

| 建议分层 | 现状 | 落点 |
| --- | --- | --- |
| Core Brain / Workflow Engine | 已有：工作流规则、依赖与判定条件 | `src/service/workflows.ts`、`src/service/dispatcher.ts` |
| Scheduler | 已有（并发与人工名额）；DAG 依赖调度待 S3 | `src/service/execution-scheduler.ts` |
| Decision Engine | 未做，随 Decision / Inbox 一起留到 S4 | — |
| Execution Runtime | 已有：租约、状态机、取消、扫尾 | `src/service/queries/`、`cancel`、`sweep` |
| Agent Bridge | Buffer 与账本语义已测，生产接线待 S3 | `src/executor/bridge.ts` |
| Tool Runtime | 已有：授权决策与只读执行器同一份决策，deny 优先 | `src/executor/tools.ts` |
| Evidence Store | 已有：工具执行回执独立成表，与 Ledger 分开 | `tool_executions` 表；事件按 execution_id 引用 |
| SQLite Ledger | 已有：唯一权威事实，面板与观察者从账本派生投影读取 | `src/infra/db/ledger.ts` |

「Evidence Store 与 Ledger 不混为一体」这一条已经按分离实现：回执行回执落 `tool_executions`，状态迁移落 `node_run_events`，事件里带 execution_id 引用回执，两边不重复存同一份事实。

## 四、第四批路线的处置

- 第一批（六项）：全部落地，第 1 项与第 2 项随第四轮审计与重签收口。
- 第二批（S3）：Scheduler 并发限制已落；Bridge 接入 runNode、事件 ACK 与断号重取、Agent 启动失败与取消全生命周期、DAG 依赖调度、Run 级状态聚合待 S3。
- 第三批（S4–S6）：workflow_id + version 复合身份、Decision / Inbox、Compensation、多节点压测、长时间服务恢复、UI 待后续。

## 五、第五节十个故障注入场景的覆盖现状

| 场景 | 现状 | 落点 |
| --- | --- | --- |
| Agent 创建后服务崩溃 | 部分 | 租约过期判定与扫尾重入已覆盖（`clock.spec.ts`、`sweep.spec.ts`）；Agent 生命周期重启判定随 S3 Bridge 接入一起补 |
| 工具执行中取消 | 已覆盖 | `tests/integration/g2.spec.ts`「G-05 工具执行中取消只立一次围栏」、`cancel.spec.ts` |
| tool.start 已收到但 tool.result 丢失 | 部分 | Buffer 层断号重取与幂等已覆盖（`tests/unit/bridge-buffer.spec.ts`）；生产 ACK 与重取随 S3 补 |
| 工具执行两次且其中一次失败 | 已覆盖 | `tests/integration/apply-report.spec.ts`「同名工具两次执行：绑到没有 tool_finished 留痕的那一次 → evidence_unverifiable」 |
| 两个相同工具在一个节点中执行 | 已覆盖 | `tests/integration/runtime.spec.ts`「同名工具跑两次：两次都留痕、tool_seq 为 1 与 2」；迁移 006 主键保证不冲突 |
| 心跳时数据库不可用 | 未覆盖 | 待补：心跳落库失败时租约丢失必须被记进账本（列入 S3 故障注入批次） |
| WorkflowCatalog 写库失败 | 已覆盖 | `tests/integration/workflows.spec.ts:114`「落库失败时目录不留这一份定义」 |
| 事件链尾部被删除 | 已覆盖 | `tests/integration/ledger-integrity.spec.ts:131`（尾部删除）、`:145`（整链删除）、`:156`（中间篡改） |
| 两个进程争夺同一个数据库 | 已覆盖 | `tests/integration/db-open.spec.ts`「第二把锁拿不到，释放后能再拿」＋ epoch fencing |
| 多个 Run 同时提交 | 已覆盖 | `tests/contract/write-queue.spec.ts`、`tests/unit/execution-scheduler.spec.ts` |

## 六、本轮同时补的工程约定

- `docs/agents/testing-conventions.md`：测试分层、命名、断言口径、预签态写法、故障注入与提交前自检。
- `tests/README.md`：测试目录地图与常用命令。
- `scripts/check-test-layout.mjs`：测试目录布局检查（原先有语法错，已修）。
