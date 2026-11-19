# S5 跨节点反馈与返工独立审查

候选提交：925e2e5b95bacdd04a652c84697351c6380c7496

上一轮为 [S5 P1 修复轮](S5-p1-fix-round-2026-11-19.md)。本次对照的主线是 `bd15daaeafbd3ab6f707ebe375314e7ccd3dfad5`。范围涵盖同一 Run 的反馈、版本绑定、定向返工、重新验收、主脑局部规划、调度恢复和面板。完整的请求协议、迁移 047–055 及 R01–R20 用例见[设计与证据](../design/rework-orchestration.md)。

## 独立结论

**有条件通过。** 审计员核对了冻结的候选源码和真实命令路径，在 2026-11-19 18:54:12（Asia/Shanghai）对该提交运行 15 个测试文件，94 项全部通过。独立审查记录 P0 为 0，P1 为 0，保留 1 项既有 P2。建议结束本批返工功能的收敛审计。G5 全项不在本轮范围。

| 上轮项目 | 本候选复核结果 |
| --- | --- |
| P1-01 固定版本派发、P1-02 记忆租约 | 已修复并验证。见 `task-plan-dispatch-after-disable`、`memory-lease-renewal` |
| P1-03a 任务专属流程的可信根入口 | 已修复并验证。见 `task-local-root` |
| P1-03b 无可复用候选时自动生成任务专属流程 | 已实现。独立审计读到生成、测试、发布与计划事务，仍缺少候选重排、确认重放和伪造归属的完整自动化证据。保留为 P2 |
| P1-04 任务与当前根运行、P1-05 交付验收、P1-06 触发就绪态 | 已修复并验证。见 `task-run-binding`、`run-acceptance`、`task-trigger-execution-readiness` |

审计员核验了授权身份、规格 HMAC、固定流程、工具注册、原输入、重启 epoch 和幂等回执。M-66 需要持久化授权与版本比较。新尝试保留原 done 和原证据链，按消费快照隔离旧输入，重新验收使用精确产物与本轮证据。拒绝终止走现有取消协议。手动运行的工具授权失效后，仅对应尝试产生持久化诊断，其他分支仍能继续。同一故障多次扫描只登记一次，恢复有效授权后可显式派发。校验覆盖相关的状态机、代次、断链、权限、证据与副作用边界。时钟预算算法未发生变更。结构索引报告元数据变化，审计依据同时包含当前源码读取。

独立实测覆盖 `tests/integration` 下七个返工套件（coordinator、runtime、manual-dispatch、process-restart、planning、inspection、extra-steps），上表对应的六个历史回归套件和 `tests/client` 下的 rework-panel、runtime-topology。运行命令为 `pnpm vitest run <上述文件> --reporter=dot`。下表的全量、类型、构建、原生 DSH 和视觉检查由实施方实测。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| 全量 Vitest | 135 文件，1473 项通过，1 项跳过。需要可连接 localhost 的环境 |
| 类型与构建 | `pnpm typecheck`、`pnpm build` 通过 |
| 实际 DSH 子会话 | 六次独立执行，六条模型使用记录。原运行 `run_01a1f36e9f17777f94cce60f7a508793` 完成 Agent 反馈与人工退回两次循环，终态 succeeded |
| 测量结果 | 本机进程测量 1 MiB 数据 SHA-256 耗时 1.0327 ms。A2 保留 A1 样本值，B2 生成分析，C2 将同一采样时间和耗时写入第三章。模型响应使用回环 fixture |
| R14 中断 | 授权事务提交后强制终止真实 Node 写进程，另一进程在新 epoch 重放。回执字节和唯一后继不变，旧版字节、消费围栏、哈希链与 SQLite 完整性检查通过 |
| 面板视觉 | 1600×1000 和 1366×900 两个视口通过项目视觉脚本，无横向溢出或运行时错误 |
| 历史门检查 | 干净候选执行 `pnpm gate` 返回 1，G1–G4 均报告 `codebasemap.md` 已在原审计候选 `32517a5` 之后变更。该变更早于本批，历史记录保留，G5 未签 |

## 候选变更文件

以下清单由 `git diff --name-only bd15daaeafbd3ab6f707ebe375314e7ccd3dfad5..925e2e5b95bacdd04a652c84697351c6380c7496` 生成。候选之后的审计归档和交接说明另行提交。

<details>
<summary>展开 69 个文件</summary>

- `docs/design/rework-orchestration.md`
- `handoff.md`
- `scripts/dsh-rework-probe.mjs`
- `src/client/api/resources.ts`
- `src/client/api/rework.ts`
- `src/client/index.tsx`
- `src/client/panel-host.tsx`
- `src/client/panel/app.tsx`
- `src/client/panel/decision-inbox.tsx`
- `src/client/panel/rework-panel.tsx`
- `src/client/panel/runtime-topology.ts`
- `src/client/panel/task-detail-screen.tsx`
- `src/client/panel/task-flow-view.tsx`
- `src/client/panel/task-run-steps.tsx`
- `src/client/panel/tasks-screen.tsx`
- `src/client/panel/workflow-canvas-view.tsx`
- `src/core/state-machine.ts`
- `src/core/workflow-def.ts`
- `src/executor/dsh-host.ts`
- `src/executor/run-node.ts`
- `src/index.ts`
- `src/infra/sqlite/migrations/047_rework.sql`
- `src/infra/sqlite/migrations/048_rework_inputs.sql`
- `src/infra/sqlite/migrations/049_rework_delivery_review.sql`
- `src/infra/sqlite/migrations/050_rework_plan_edges.sql`
- `src/infra/sqlite/migrations/051_rework_inspections.sql`
- `src/infra/sqlite/migrations/052_rework_extra_steps.sql`
- `src/infra/sqlite/migrations/053_rework_execution_briefs.sql`
- `src/infra/sqlite/migrations/054_rework_dispatch_specs.sql`
- `src/infra/sqlite/migrations/055_rework_dispatch_blocks.sql`
- `src/service/artifact-store.ts`
- `src/service/commands/apply-report.ts`
- `src/service/commands/cancel.ts`
- `src/service/commands/lease.ts`
- `src/service/commands/node-state.ts`
- `src/service/commands/nodes.ts`
- `src/service/commands/run-acceptance.ts`
- `src/service/commands/run-close.ts`
- `src/service/commands/subworkflow.ts`
- `src/service/commands/workflows.ts`
- `src/service/delivery-review.ts`
- `src/service/dispatcher.ts`
- `src/service/dsh-rework.ts`
- `src/service/rework-coordinator.ts`
- `src/service/rework-dispatch-specs.ts`
- `src/service/rework-edges.ts`
- `src/service/rework-execution.ts`
- `src/service/rework-extra-steps.ts`
- `src/service/rework-inspection.ts`
- `src/service/rework-planning.ts`
- `src/service/rework-runtime.ts`
- `src/service/runs.ts`
- `src/service/server.ts`
- `src/service/task-trigger-dispatch.ts`
- `src/service/workflows.ts`
- `tests/client/rework-panel.spec.tsx`
- `tests/client/runtime-topology.spec.tsx`
- `tests/fixtures/rework-process-child.ts`
- `tests/integration/migration-cases.spec.ts`
- `tests/integration/rework-coordinator.spec.ts`
- `tests/integration/rework-extra-steps.spec.ts`
- `tests/integration/rework-inspection.spec.ts`
- `tests/integration/rework-manual-dispatch.spec.ts`
- `tests/integration/rework-planning.spec.ts`
- `tests/integration/rework-process-restart.spec.ts`
- `tests/integration/rework-runtime.spec.ts`
- `tests/integration/transition-rules.spec.ts`
- `tests/unit/execution-scheduler.spec.ts`
- `tests/unit/workflow-def.spec.ts`

</details>
