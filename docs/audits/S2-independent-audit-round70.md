# S2 独立审计报告 · G2 第 70 轮

门：G2
候选提交：4e751de6cf8fb681e7b7c4f40061400cabab0408

审计日期：2026-11-17
审计方式：独立只读审计；未签门、未改生产代码/测试/证据/门记录；临时探针只放 `tmp/r70/`，交付前已删

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 70,
  "candidate_commit": "4e751de6cf8fb681e7b7c4f40061400cabab0408",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 3,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": [
    "G2-01",
    "G2-02",
    "G2-03",
    "G2-04",
    "G2-05",
    "G2-06",
    "G2-07",
    "G-03",
    "G-04",
    "G-05",
    "G-07",
    "G2-08",
    "G2-09",
    "G2-10",
    "G2-11",
    "G2-12",
    "G2-13",
    "G2-14",
    "G2-15",
    "G2-16"
  ],
  "failed_items": [],
  "notes": "S4 的 workflow 写命令/runIdempotentCommand/createRun 依赖闭包与预留任务/dispatcher readinessOf 三条共享路径逐条回归核查：报告幂等仍走 report_registry 与 start_run_operations 两条既有通道，inbox 新通道分表分键无交叉；无 edges 的定义派发行为与上轮逐字相同，G2 单节点闭环无回归。r68/r69 的链闸与等待登记修复维持有效。P2×3：r69 遗留 hang_reason 存量行不确定标记（维持）；pnpm typecheck 在候选上 11 处 TS 报错（tests/gate/gate-check.spec.ts 的 G4 注册用例，0519401 引入，生产 src 零错误、build/1022 用例全绿，G4 full-suite.md 声称 typecheck exit 0 与实测不一致）；dispatcher 依赖闸对前置非成功终态不收后置节点致多节点 edges run 滞留 running（探针复现，cancelRun 可收口，G2 单节点路径不受影响）。20 项必过项证据 29/29 字节复现。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：**pass**

P0 = 0，P1 = 0，P2 = 3；必过项 20/20。

## 2. 审计基准

| 项 | 值 |
| --- | --- |
| 主线 HEAD / 本轮候选 / 本报告绑定提交 | `4e751de6cf8fb681e7b7c4f40061400cabab0408`（审计期间 HEAD 不再前进；本人改动只有本报告，`tmp/r70/` 探针交付前已删；同工作树另有其他审计员在途的 `docs/audits/S4-independent-audit-round1.md` 与 `docs/gates/G4.md` 改动，未触碰） |
| 审计范围 | `git diff fd2173bb..4e751de6`：39 个文件，4257 插入 / 97 删除；S4 全部工作（workflow 定义与两层校验、迁移 027/028、四写命令与发布事务、runIdempotentCommand、预留任务、依赖闭包、dispatcher 依赖闸、HTTP 六入口、G4 证据与注册） |
| G2 共享路径生产改动 | `src/service/commands/idempotency.ts`（新增 102 行）、`src/service/runs.ts`（+101/-7，依赖闭包/预留绑定/task_local 闸）、`src/service/dispatcher.ts`（+51，readinessOf/missingPreds 防御面）、`src/service/commands/start-run.ts`（+3，taskId 透传）、`src/service/commands/subworkflow.ts`（+3，assertWorkflowUsable）、`src/index.ts`、`src/service/server.ts`、`src/service/schemas.ts` |
| G2 核心文件零改动 | `apply-report.ts`、`lease.ts`、`cancel.ts`、`recovery.ts`、`run-close.ts`、`nodes.ts`、`node-state.ts`、`clock-recovery.ts`、`ledger.ts`、`state-machine.ts` 均不在 diff 名单内 |
| 上一轮 | `docs/audits/S2-independent-audit-round69.md`（候选 `fd2173bb`，P2×1：hang_reason 存量行不确定标记） |
| 必读文档 | `审计要求.md`（§1/§4/§5/§6/附录 A）、`scripts/gate-check.ts` 的 `GATE_SPECS.G2`、`src/core/audit-verdict.ts`、`docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md`（§3.7/3.8 幂等与定义） |
| 未能确认的范围 | 无 |

## 3. 上一轮问题复核（逐条，不默认已修复）

| 编号 | 复核位置（本人读到） | 结论 | 验证方式 |
| --- | --- | --- | --- |
| r68 P1-1 / r69 已修：断链推进与断链收口 | `src/infra/db/ledger.ts` 的 `assertChainIntact` 与 `nodes.ts`/`node-state.ts`/`run-close.ts` 三处链闸本候选零改动，代码原样 | 维持已修复并验证 | 全量用例含 `chain-guard-entries`/`chain-guard-execution` 全绿 |
| r69 P2-1：带 `hang_reason` 的存量行打标后确认接口回 `STALE_GENERATION`，标记留存 | `src/service/clock-recovery.ts:95-98`、`:110-122`、`src/service/commands/recovery.ts:52-75`、`src/service/commands/nodes.ts:210` 本候选全部零改动 | 未处理，维持 P2（本轮第 6 节 P2-1） | 代码阅读 + diff 名单核对 |
| r69 P2-2：确认接口留下 active 等待登记 | `src/service/commands/recovery.ts:50-51`（`cancelWait` 与迁移同笔）零改动 | 维持已修复并验证 | `recovery-uncertain` 用例在全量绿 |
| r69 P3-1/P3-2：终态词表多处手写、台账计数笔误 | `state-machine.ts:18-26`、`run-close.ts:41`、`clock-recovery.ts:96` 仍各自维护 | 仍为 P3，不阻断 | 代码阅读 |

## 4. 本批修改质量：G2 共享路径逐条回归核查

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `runIdempotentCommand`（`idempotency.ts:44-102`）与 `inbox` 通道 | 符合预期，无需修改 | 与 G2 报告幂等完全分表分键：`applyReport` 判重走 `report_registry` + `report_id` 事件计数（`apply-report.ts:68-110`），本候选零改动；`startRun` 幂等仍走 `start_run_operations` + `replay()`（`start-run.ts:71-89`），互不交叉。`inbox.operation_id` 有 UNIQUE 约束（`001_init.sql:92`），重复 INSERT 不可能；回执/业务同笔事务，业务抛错整笔回滚不占 operation；`OPERATION_EXPIRED` 先于冲突判定（`idempotency.ts:60-67`），过期回执不误报冲突。G2-02/G2-11 无回归 |
| `createRun` 依赖闭包（`runs.ts:101-131`） | 符合预期 | 只在传 `nodeIds` 且定义带 `edges` 时生效，缺前置在建 run 前拒并列出缺谁；无 `edges` 的旧定义 `def.edges ?? []` 为空，闭包检查恒通过，G2 建 run 路径逐字相同。检查在 `withTx` 之前，抛错时不占 `start_run_operations`，同 operation 重试可正常建 run |
| `createRun` 预留任务绑定（`runs.ts:132-173`） | 符合预期 | 只在显式传 `taskId` 时走「预留消费」CAS 分支（`status='reserved' AND current_run_id IS NULL`，`changes!==1` 即 `STALE_GENERATION`），旧路径仍走原样 INSERT tasks；预留预读在事务外但 CAS 在事务内，双开绑定只有一个赢家 |
| `createRun` 的 task_local 根入口闸与 `assertWorkflowUsable`（`runs.ts:151-157`） | 符合预期 | task_local 在根入口直接 `FORBIDDEN`（注释与实现一致：客户端自报 task id 不是授权凭据）；reusable 工作流 `assertWorkflowUsable` 是 no-op，G2 旧建 run 路径不受影响。子流程侧 `subworkflow.ts:328` 以父 run 的 task_id 过归属闸，口径一致 |
| `dispatcher` readinessOf/missingPreds（`dispatcher.ts:102-155`） | 无 G2 回归；有一个 S4 面 P2（第 6 节 P2-3） | 无 `edges` 或目录查不到版本时 `preds` 为空，全量派发与旧行为逐字相同；trigger 边在 `toRunDef` 被裁掉（`workflows.ts:119-124`），不会等不存在的节点。missingPreds 防御面把「前置行缺失」收成 `failed` + `dispatch.failed` 事件，测试在 `workflow-g4.spec.ts:491-537` 锁了事件类型。前置失败终态的滞留缺口见 P2-3 |
| `start-run.ts`/`schemas.ts`/`server.ts`/`index.ts` | 符合预期 | `task_id` 全部可选透传，旧请求字节不变；新路由只增不改；`startRunSchema` 加可选字段不破坏既有校验 |
| 迁移 027/028 | 符合预期 | 只动 `workflows`/`workflow_versions`/`workflow_drafts`；版本不可变触发器对既有写路径无影响（`src` 内对 `workflow_versions` 只有 INSERT，无 UPDATE/DELETE/REPLACE） |

## 5. 必须阻断的问题

本轮未发现新的 P0/P1 阻断问题。

## 6. 可延期问题

| 编号 | 位置 | 说明 | 影响与建议 |
| --- | --- | --- | --- |
| P2-1（r69 遗留） | `src/service/clock-recovery.ts:95-98`、`:110-122`；`src/service/commands/recovery.ts:52-75`；`src/service/commands/nodes.ts:210` | 带 `hang_reason` 的存量行仍会进 action 通道被打上 `recovery_uncertain`，唯一清除入口 `resolveRecoveryUncertain` 因 `applyTransition` 的 `hang_reason IS NULL` 闸门回 `STALE_GENERATION`，标记留存；本候选未触碰相关文件 | 触发面限于升级前存量行与保留 `fence_state='armed'` 的终态行；节点压在裁决链上，业务处置仍走既有裁决。维持 r69 建议：reanchor 四个 SELECT 补 `hang_reason IS NULL` 与终态排除，并提供只清标记的运维出口 |
| P2-2（本轮新） | `tests/gate/gate-check.spec.ts:1737-1759`（提交 `0519401` 引入） | `pnpm typecheck`（`tsc --noEmit`）在候选上 exit 2，11 处 TS18048/TS2532：`GATE_SPECS.G4` 在 `noUncheckedIndexedAccess`（`tsconfig.json`）下为 `GateSpec \| undefined`，G4 注册用例直接点属性 | 生产 `src/` 零类型错误；`pnpm build` exit 0（ESM `lib/index.js` 344.38 kB / gzip 82.64 kB，`lib/index.d.ts` 26.10 kB）；vitest 78 files / 1022 passed / 1 skipped；证据复现 29/29。运行时无影响，但 `pnpm check` 三步自检在第一步就断，且 `docs/gates/evidence/G4/full-suite.md` 声称「typecheck exit 0」与实测不符（属 G4-13 证据，已在回包转 S4）。定 P2 依据：§5 的 P1 五类影响均不成立，构建与用例全绿，有明确一行修法。建议签门前修复并复跑 `pnpm check` |
| P2-3（本轮新，S4 edges 面） | `src/service/dispatcher.ts:106-118`（`readinessOf`）、`:151-154`（防御面只接 `missingPreds`）；`src/service/commands/run-close.ts:42` | 定义带 `edges` 时前置进入失败终态（`failed`/`timeout` 等）后，后置节点永远走 `waitingPreds` 分支：不派发、不收失败；`closeRun` 要求全部节点终态才收口，run 滞留 `running`；`failQueuedNode` 防御面只覆盖「前置行缺失」，不覆盖「前置失败」 | 本人探针复现：`a→b` 链，a 被收成 `failed` 后第二轮 dispatchRun 返回空、b 停 `queued`、run 停 `running`；`cancelRun` 兜底后 b 进 `superseded`、run 进终态。触发面仅 S4 新增 edges 拓扑的多节点 run（G2 单节点路径 `def.edges ?? []` 为空，行为与上轮逐字相同）；取消可收口，故记 P2。建议：readinessOf 区分「前置失败终态」，把后置收成 `failed`/`superseded` 或在 run 层触发取消传播，并补一条前置失败的收口用例 |
| P3-1 | `src/service/dispatcher.ts:131-143` | readiness 闸取的是目录当前定义的 edges，不做 run 绑定哈希比对（哈希闸在 `resolveControlConfig` 之后才执行） | 生产已发布版本不可变（027 触发器）且 `adopt` 验哈希，实际风险仅 `load()` 覆盖同版本目录的测试形态；记 P3 供 S4 收口时顺手对齐 |
| P3-2 | `src/service/dispatcher.ts:151-154` | missingPreds 分支里 `failQueuedNode` 的返回值被丢弃，节点收成 `failed` 但不进 `DispatchOutcome[]`，调用方只能查账本；与其他 `failQueuedNode` 出口的回执口径不一致 | 可观测性小缺口，事件已落账本；建议下批补一条 outcome |
| P3-3 | `state-machine.ts:18-26`、`run-close.ts:41`、`clock-recovery.ts:96` | 终态词表仍三处各自维护（r69 P3-2 延续） | 可读性改进，按既有 P3 清单安排 |

## 7. 必过项核对（20 项）

| 必过项 | 证据 | 判定 |
| --- | --- | --- |
| G2-01 | ev-g2-01、全量用例复现 | 通过 |
| G2-02 | ev-g2-02、全量用例复现 | 通过 |
| G2-03 | ev-g2-03、全量用例复现 | 通过 |
| G2-04 | ev-g2-04、全量用例复现 | 通过 |
| G2-05 | ev-g2-05、ev-g2-10、全量用例复现 | 通过 |
| G2-06 | ev-g2-06、全量用例复现 | 通过 |
| G2-07 | ev-g2-07、全量用例复现 | 通过 |
| G-03 | ev-g2-g03、全量用例复现 | 通过 |
| G-04 | ev-g2-g04、全量用例复现 | 通过 |
| G-05 | ev-g2-g05、全量用例复现 | 通过 |
| G-07 | ev-g2-g07、ev-g2-09、全量用例复现 | 通过 |
| G2-08 | ev-g2-08、全量用例复现 | 通过 |
| G2-09 | ev-g2-09、全量用例复现 | 通过 |
| G2-10 | ev-g2-10、全量用例复现 | 通过 |
| G2-11 | ev-g2-11、全量用例复现 | 通过 |
| G2-12 | ev-g2-12、全量用例复现 | 通过 |
| G2-13 | ev-g2-13、全量用例复现 | 通过 |
| G2-14 | ev-g2-14、全量用例复现 | 通过 |
| G2-15 | ev-g2-15、全量用例复现 | 通过 |
| G2-16 | ev-g2-16、全量用例复现 | 通过 |

`must_pass_ids` 与 `scripts/gate-check.ts` 的 `GATE_SPECS.G2.items` 逐项一致（20 项，无重复、无规格外项）。

## 8. 实测命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 2：11 处 TS18048/TS2532，全部在 `tests/gate/gate-check.spec.ts:1737-1759`（见 P2-2）；`src/` 零错误 |
| `npx vitest run` | 78 files，1022 passed / 1 skipped（12.60s） |
| `npx vitest run tests/integration/{apply-report,lease,cancel,recovery-uncertain,recovery-action-checkpoint,control-dispatch,run-close}.spec.ts` | 7 files，118 passed（G2 报告/租约/取消/恢复/收口回归面） |
| `npx vitest run tests/integration/{cancel,control-dispatch,clock-recovery,sweep,subworkflow,g2,recovery-unit-migration}.spec.ts` | 7 files，112 passed（与 r69 同口径回归面） |
| `npx vitest run tests/unit` | 20 files，179 passed |
| `node --no-warnings scripts/check-evidence-repro.ts` | 证据复现成立：29 份，每份重跑两遍都与 HEAD 字节一致（含 G3/G4 注入摘要） |
| `pnpm build` | 完成；ESM `lib/index.js` 344.38 kB / gzip 82.64 kB，`lib/index.d.ts` 26.10 kB |
| 本人探针 `npx vitest run --root tmp/r70` | 1 例全过：前置节点落入非成功终态后 b 滞留 `queued`、run 滞留 `running`；`cancelRun` 后 b `superseded`、run 进终态（P2-3 复现与兜底确认） |
| `node --no-warnings scripts/gate-check.ts` | G1/G2/G3 按预期待重签（「候选提交之后，候选文件又被改过」）；G4 报「必过项 G4-06 的证据与固定映射不一致：ev-g4-06 != ev-g4-06,ev-g4-14」，属 S4 门记录问题（已在回包转 S4） |

## 9. 退出条件与阶段性判定

| 退出条件 | 状态 |
| --- | --- |
| 无未解决 P0 | 满足 |
| 无未解决且阻碍下一阶段的 P1 | 满足 |
| 本轮修改已完成针对性审查 | 满足（第 3、4 节逐条：三条 G2 共享路径全部核对） |
| 关键业务路径有测试与验证证据 | 满足（78 files / 1022 例 + 29 份证据复现 + 1 条独立探针 + 重点回归面 118/112 例） |
| 核心数据、状态转换、外部副作用符合不变量 | 满足（报告幂等、租约、CAS、检查点、终态枚举、断链闸均未被本批改动触碰或经逐条核查无回归） |
| 重要异常路径有失败处理与恢复策略 | 满足（不确定态可查可确认；edges 滞留有取消兜底，缺口已记 P2-3） |
| 未解决的 P2/P3 已记录并有影响说明 | 满足（第 6 节 P2×3、P3×3） |
| 无未解释的测试、构建或兼容问题 | 满足（typecheck 报错已定位到行并解释成因与影响面，见 P2-2；build/用例全绿） |
| 已形成可复现、可追溯的版本基准 | 满足（候选即 HEAD） |

可靠性收敛阶段通过，可以进入下一阶段开发。

## 10. 下一步建议

1. 本报告提交后按 G1→G2→G3 重签门记录；签门前顺手修掉 P2-2（`GATE_SPECS.G4` 非空断言或显式收窄类型）并复跑 `pnpm check`，不单开轮次；
2. S4 收口时处理 P2-3（依赖闸对前置非成功终态的处置缺口）与 G4 门记录 G4-06 证据映射不一致；
3. 升级部署时按 r69 建议抽查 `recovery_unit_fixes` 的 `unclassified_kept` 行，并给 hang_reason 存量标记留一条清理出口（P2-1）。

## 11. 裁决块自检

用 `src/core/audit-verdict.ts` 的 `parseAuditVerdict` / `verdictProblems` 与 `scripts/gate-check.ts` 的 `auditConclusionOf` / `proseVerdictClashes`（`node --experimental-strip-types` 实跑）对本报告全文自检：

| 检查 | 结果 |
| --- | --- |
| `parseAuditVerdict` | 解析成功，13 字段全部通过 `validateAuditVerdict` |
| `verdictProblems`（对 `GATE_SPECS.G2.items`，round 70，绑定候选） | 空列表 |
| `auditConclusionOf` | `pass`（与裁决块一致，正文结论行唯一） |
| `proseVerdictClashes` | 空列表 |
