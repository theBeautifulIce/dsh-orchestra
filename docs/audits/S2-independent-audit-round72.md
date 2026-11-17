# S2 独立审计报告 · G2 第 72 轮

门：G2
候选提交：32517a5287df6221d3f9024efa4adc074efea8d3

审计日期：2026-11-17
审计方式：独立只读审计；未签门、未改生产代码/测试/证据/门记录；临时探针只放 `tmp/r72/`，交付前已删

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 72,
  "candidate_commit": "32517a5287df6221d3f9024efa4adc074efea8d3",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 1,
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
  "notes": "delta 快审：本轮代码改动仅 dispatcher.ts 的 BLOCKED_TERMINAL 改由 TERMINAL_STATUSES 派生（S3 r22 P2-7 修复）与 workflow-g4.spec.ts 新增场景三/断言收紧，G2 核心面十文件（apply-report/lease/cancel/recovery/run-close/nodes/node-state/clock-recovery/ledger/state-machine）零改动。派生结果实跑为六个非成功终态（failed、timeout、abandoned_unverified、failed_with_unverified、orphaned、superseded），与 S3 r22 修复建议逐字一致；indeterminate_side_effect 退出结算档回归等待档（裁决窗口内不再误结算后置），cancelled 死条目清除（node 级无此状态：状态机词表无、cancel.ts 经 applyTransition 只写 superseded，迁移里 cancelled 仅属 wait_registrations.state）。场景三锁住 P2-7（不确定前置 → b 保持 queued、run 保持 running；M-60 换行 done → b 放行），场景二断言补 error_code 判据区分放行与结算（r71 P3-4 关闭）。无 edges 的 G2 单节点路径 preds 恒空、readinessOf 恒 ready，行为与上轮逐字相同，20 项必过沿用全过。实跑：typecheck exit 0；全量 78 files / 1023 passed / 1 skipped；G2 回归面 7 files / 118 passed、第二回归面 7 files / 112 passed、workflow-g4 14 passed、gate-check 187 passed / 1 skipped；证据复现 29/29 两遍字节一致。P2×1 为 r69 遗留 hang_reason 存量标记（维持）。P3：目录 edges 无绑定哈希比对（维持）；终态词表多处维护（维持但收窄：dispatcher 失败终态档已单点派生，SUCCESS_STATUS 仍手写、run-close/clock-recovery/subworkflow 各有手写清单）；非拓扑序级联需逐轮派发（维持）。gate-check 快照：G1–G3 按预期待重签；G4 重签链待 G1–G3 重签闭合。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：**pass**

P0 = 0，P1 = 0，P2 = 1；必过项 20/20。

## 2. 审计基准

| 项 | 值 |
| --- | --- |
| 主线 HEAD / 本轮候选 / 本报告绑定提交 | 三者一致，均为 `32517a5287df6221d3f9024efa4adc074efea8d3`；本人改动只有本报告（`tmp/r72/` 自检脚本交付前已删） |
| 审计方式 | delta 快审：`git diff 4ecff7a..32517a5` 共 8 个文件，其中生产代码 1 个（`src/service/dispatcher.ts`）、测试 1 个（`tests/integration/workflow-g4.spec.ts`）、审计/门文档 6 个（`docs/audits` ×5、`docs/gates/G4.md`，均在候选排除范围） |
| delta 实质内容 | dispatcher 的 `BLOCKED_TERMINAL` 从硬编码八态改为 `TERMINAL_STATUSES` 过滤派生（S3 r22 P2-7 修复）；`SUCCESS_STATUS`/`BLOCKED_TERMINAL` 标注 `ReadonlySet<string>`；workflow-g4 用例新增场景三（不确定前置等待与裁决换行放行）并给场景二补 `error_code` 判据 |
| G2 核心文件零改动 | `apply-report.ts`、`lease.ts`、`cancel.ts`、`recovery.ts`、`run-close.ts`、`nodes.ts`、`node-state.ts`、`clock-recovery.ts`、`ledger.ts`、`state-machine.ts` 均不在 diff 名单内（`state-machine.ts` 仅被 dispatcher 新增 import，本体零改动） |
| 上一轮 | `docs/audits/S2-independent-audit-round71.md`（候选 `4ecff7a`，pass，P2×1、P3×4） |
| 必读文档 | `审计要求.md`（§5/§6/§7）、`scripts/gate-check.ts` 的 `GATE_SPECS.G2`、`src/core/audit-verdict.ts`、`src/core/state-machine.ts`、`src/service/dispatcher.ts`、`src/service/commands/cancel.ts`、`tests/integration/workflow-g4.spec.ts`、`docs/audits/S3-independent-audit-round22.md`（P2-7 原始判定与修复建议） |
| 未能确认的范围 | 无 |

## 3. 上一轮问题复核（逐条，不默认已修复）

| 编号 | 复核位置（本人读到） | 结论 | 验证方式 |
| --- | --- | --- | --- |
| r71 P2-1（r69 遗留）：带 `hang_reason` 的存量行打标后确认接口回 `STALE_GENERATION`，标记留存 | `src/service/clock-recovery.ts`、`src/service/commands/recovery.ts`、`src/service/commands/nodes.ts` 本候选全部零改动 | 未处理，维持 P2（本轮第 6 节 P2-1） | diff 名单核对 |
| r71 P3-1：目录 edges 无绑定哈希比对 | `src/service/dispatcher.ts:151-163` 仍取目录当前定义，本候选只动 `:107-110` 词表两行 | 维持 P3（第 6 节 P3-1） | 代码阅读 |
| r71 P3-3：终态/成功词表多处手写 | 本批把 `BLOCKED_TERMINAL` 改为从 `TERMINAL_STATUSES` 单点派生，dispatcher 的失败终态档退出手写清单；`SUCCESS_STATUS`（`dispatcher.ts:107`）仍手写，`run-close.ts:8`、`clock-recovery.ts:96`、`subworkflow.ts:503-516` 的清单仍在 | 收窄但维持 P3（第 6 节 P3-3） | 代码阅读 + 派生结果实跑 |
| r71 P3-4：场景二断言偏松（放行与结算不可区分） | `tests/integration/workflow-g4.spec.ts:614-621` 已补 `error_code !== 'RESOLUTION_NOT_AVAILABLE'` 判据，结算路径（`dispatch.failed` 事件带该码）会被抓住 | 已修复并验证 | 代码阅读 + workflow-g4 单跑 14 passed |
| r71 P3-5：非拓扑序声明的多跳级联需逐轮派发 | `dispatcher.ts:143-198` 的逐轮派发模型未动 | 维持 P3（第 6 节 P3-2） | diff 名单核对 |

## 4. 本批修改质量：BLOCKED_TERMINAL 派生与 G2 回归逐条核查

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `BLOCKED_TERMINAL` 派生（`dispatcher.ts:108-110`） | 符合预期，无需修改 | 实跑派生结果为六个非成功终态：`failed`、`timeout`、`abandoned_unverified`、`failed_with_unverified`、`orphaned`、`superseded`，与 S3 r22 P2-7 修复建议（「非成功终态六个」）逐字一致。较旧八态集合移除两项：`indeterminate_side_effect`（`state-machine.ts:15` 非终态，可经 M-50/M-52/M-60 裁决走到 done，回归等待档是本修复目标）与 `cancelled`（run 级死条目：状态机节点词表无此态，`cancel.ts` 经 `applyTransition` 只写 `superseded`/`timing_out`，迁移里 `cancelled` 仅属 `wait_registrations.state`，node 级生产写路径不可达） |
| 裁决窗口行为 | 符合预期 | `indeterminate_side_effect` 前置现归 `waitingPreds` 档（`dispatcher.ts:135`），后置保持 `queued`、run 保持 `running`，裁决换行（旧行 superseded、新行 attempt+1 done）后 `effectiveStatus`（`dispatcher.ts:119-124`，`ORDER BY attempt DESC`）读到 done 放行。场景三逐断言锁住这条链（`workflow-g4.spec.ts:593-612`），全量实跑绿 |
| 与兄弟非终态的处置一致性 | 符合预期 | `startup_unknown`、`blocked_pre/post`、`timing_out` 等非终态与 `indeterminate_side_effect` 同归等待档，S3 r22 探针 S3/S4 指出的两态不一致已消除 |
| 场景二断言收紧（`workflow-g4.spec.ts:614-621`） | 符合预期 | `b` 不许停 `queued` 且末事件 `error_code` 不得是 `RESOLUTION_NOT_AVAILABLE`：被 `failedPreds` 结算必落 `dispatch.failed` + `RESOLUTION_NOT_AVAILABLE`（`dispatcher.ts:180-184`），被放行则走执行路径落 `EVIDENCE_SOURCE_UNAVAILABLE`（`dispatcher.ts:253-259`，测试未装执行器），两档由此可区分，r71 P3-4 关闭 |
| G2 单节点闭环回归 | 无回归 | 无 `edges` 或目录查不到版本时 `preds` 为空（`dispatcher.ts:148-165`），`readinessOf` 对空前置恒返回 ready，派发行为与上轮逐字相同；`settled` 恒空。G2 核心文件零改动（第 2 节）。实跑面：全量 78 files / 1023 passed / 1 skipped（与 r71 同数：场景三并入既有用例内，用例数不增）；G2 回归面 7 files / 118 passed；第二回归面 7 files / 112 passed；证据复现 29/29 |
| 迁移、HTTP、幂等、报告、租约、取消、恢复、收口通道 | 本候选零改动 | diff 只有 dispatcher 词表两行与 G4 测试；`applyReport`/租约/取消/恢复/收口路径未触碰 |

## 5. 必须阻断的问题

本轮未发现新的 P0/P1 阻断问题。

## 6. 可延期问题

| 编号 | 位置 | 说明 | 影响与建议 |
| --- | --- | --- | --- |
| P2-1（r69 遗留） | `src/service/clock-recovery.ts:95-98`、`:110-122`；`src/service/commands/recovery.ts:52-75`；`src/service/commands/nodes.ts:210` | 带 `hang_reason` 的存量行仍会进 action 通道被打上 `recovery_uncertain`，唯一清除入口 `resolveRecoveryUncertain` 因 `applyTransition` 的 `hang_reason IS NULL` 闸门回 `STALE_GENERATION`，标记留存；本候选未触碰相关文件 | 触发面限于升级前存量行与保留 `fence_state='armed'` 的终态行；节点压在裁决链上，业务处置仍走既有裁决。维持 r69–r71 建议：reanchor 四个 SELECT 补 `hang_reason IS NULL` 与终态排除，并提供只清标记的运维出口 |
| P3-1（r70 维持） | `src/service/dispatcher.ts:151-163` | readiness 闸取目录当前定义的 edges，不做 run 绑定哈希比对 | 生产已发布版本不可变（027 触发器）且 `adopt` 验哈希，实际风险仅测试形态；S4 收口时顺手对齐 |
| P3-2（r71 P3-5 维持，编号对齐问题清单） | `src/service/dispatcher.ts:143-198` | 节点声明顺序非拓扑时，前置结算与后置判定同轮按 seq 逆序进行，末位后置要等下一轮 `dispatchRun` 才被结算 | 与既有逐轮派发模型一致，run 不会永滞；建议 S4 收口时补拓扑序校验或结算后自唤醒 |
| P3-3（r70 起维持并收窄） | `dispatcher.ts:107`（`SUCCESS_STATUS` 仍手写）、`run-close.ts:8`、`clock-recovery.ts:96`、`subworkflow.ts:503-516` | 终态/成功词表仍多处各自维护；本批 `BLOCKED_TERMINAL` 已改为单点派生，dispatcher 失败终态档退出手写清单，但 `SUCCESS_STATUS` 含 run 级死条目（`succeeded` 系混入 node 级判定，行为惰性、不可达状态不影响判定）且其余三处清单未动 | 可读性改进：词表分叉时行为会静默分叉，建议 `SUCCESS_STATUS` 同样从状态机派生（node 级成功即 `done`），其余清单改为引用单点常量 |

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

`must_pass_ids` 与 `scripts/gate-check.ts` 的 `GATE_SPECS.G2.items` 逐项一致（20 项，无重复、无规格外项）。证据 29/29 两遍字节复现；r71 结论沿用，本批 delta 只动依赖闸词表与 G4 测试，无 edges 的 G2 单节点路径行为不变（第 4 节），G2 核心面零改动（第 2 节）。

## 8. 实测命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0（干净取退出码） |
| `npx vitest run` | 78 files，1023 passed / 1 skipped（15.39s；与 r71 同数，场景三并入既有用例） |
| `npx vitest run tests/integration/{apply-report,lease,cancel,recovery-uncertain,recovery-action-checkpoint,control-dispatch,run-close}.spec.ts` | 7 files，118 passed（G2 报告/租约/取消/恢复/收口回归面） |
| `npx vitest run tests/integration/{cancel,control-dispatch,clock-recovery,sweep,subworkflow,g2,recovery-unit-migration}.spec.ts` | 7 files，112 passed（与 r69–r71 同口径回归面） |
| `npx vitest run tests/integration/workflow-g4.spec.ts` | 1 file，14 passed（含场景三：不确定前置等待与裁决换行放行） |
| `npx vitest run tests/gate/gate-check.spec.ts` | 1 file，187 passed / 1 skipped |
| `node --no-warnings scripts/check-evidence-repro.ts` | 证据复现成立：29 份，每份重跑两遍都与 HEAD 字节一致（含 G3/G4 注入摘要） |
| `node --experimental-strip-types` 实跑派生式 | 派生得六个非成功终态，与 S3 r22 修复建议的清单逐字一致（清单见第 4 节） |
| 四函数自检（第 11 节，`node --experimental-strip-types` 实跑） | `parseAuditVerdict` 解析成功；`verdictProblems` 空列表；`auditConclusionOf` 为裁决一致值；`proseVerdictClashes` 空列表 |
| `node --no-warnings scripts/gate-check.ts` | 未跑（快审沿用 r71 快照）：G1–G3 按预期待重签（证据文件在各自门记录候选之后改过）；G4 重签链待 G1–G3 重签闭合 |

## 9. 退出条件与阶段性判定

| 退出条件 | 状态 |
| --- | --- |
| 无未解决 P0 | 满足 |
| 无未解决且阻碍下一阶段的 P1 | 满足 |
| 本轮修改已完成针对性审查 | 满足（第 3、4 节逐条：r71 五项遗留复核、派生式与两处用例改动全查） |
| 关键业务路径有测试与验证证据 | 满足（78 files / 1023 例 + 29 份证据复现 + 重点回归面 118/112/14 例） |
| 核心数据、状态转换、外部副作用符合不变量 | 满足（报告幂等、租约、CAS、检查点、终态枚举、断链闸均未被本批改动触碰；派生式与状态机终态表同源） |
| 重要异常路径有失败处理与恢复策略 | 满足（非终态前置等待裁决、非成功终态前置同轮结算后置并收口 run） |
| 未解决的 P2/P3 已记录并有影响说明 | 满足（第 6 节 P2×1、P3×3） |
| 无未解释的测试、构建或兼容问题 | 满足（全量与子集全绿；typecheck exit 0） |
| 已形成可复现、可追溯的版本基准 | 满足（候选即 HEAD） |

可靠性收敛阶段通过，可以进入下一阶段开发。

## 10. 下一步建议

1. 本报告定稿入库后按 G1→G2→G3→G4 顺序重签门记录（G1–G3 的证据文件在旧候选之后改过，属预期待重签；G4 重签链随 G1–G3 重签闭合）；
2. 建议结束 S2/G2 的全面收敛审计轮次，转入正常功能开发；S4 面只剩 P3 级收尾（P3-1 哈希对齐、P3-2 拓扑序或自唤醒、P3-3 词表单点化），不单开 S2 轮次；
3. 升级部署时按 r69–r71 建议给 hang_reason 存量标记留一条只清标记的运维出口（P2-1），并抽查 `recovery_unit_fixes` 的 `unclassified_kept` 行。

## 11. 裁决块自检

用 `src/core/audit-verdict.ts` 的 `parseAuditVerdict` / `verdictProblems` 与 `scripts/gate-check.ts` 的 `auditConclusionOf` / `proseVerdictClashes`（`node --experimental-strip-types` 实跑）对本报告全文自检：

| 检查 | 结果 |
| --- | --- |
| `parseAuditVerdict` | 解析成功，13 字段全部通过 `validateAuditVerdict` |
| `verdictProblems`（对 `GATE_SPECS.G2.items`，round 72，绑定候选） | 空列表 |
| `auditConclusionOf` | `pass`（与裁决块一致，正文结论行唯一） |
| `proseVerdictClashes` | 空列表 |
