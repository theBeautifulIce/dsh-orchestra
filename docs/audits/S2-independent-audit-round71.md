# S2 独立审计报告 · G2 第 71 轮

门：G2
候选提交：4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f

审计日期：2026-11-17
审计方式：独立只读审计；未签门、未改生产代码/测试/证据/门记录；临时探针只放 `tmp/r71/`，交付前已删

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 71,
  "candidate_commit": "4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f",
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
  "notes": "r70 遗留 P2-2（typecheck 11 处）与 P2-3（前置非成功终态后置滞留 queued）已修复并实跑验证：typecheck exit 0；readinessOf 增 failedPreds 档、按有效行（ORDER BY attempt DESC）判定，后置经 failQueuedNode 结算（error_code=RESOLUTION_NOT_AVAILABLE）且结算行进 dispatch outcomes，run 同轮收口；M-60 换行场景经独立探针确认走放行路径（收口错误码 EVIDENCE_SOURCE_UNAVAILABLE，非结算档）。G2 单节点闭环无回归：无 edges 路径 preds 为空、行为与上轮逐字相同，G2 核心文件零改动；全量 78 files / 1023 passed / 1 skipped、证据复现 29/29 两遍字节一致。P2×1 为 r69 遗留 hang_reason 存量标记（维持）。P3：目录 edges 无绑定哈希比对（维持）；终态词表多处维护（维持，本批 dispatcher 又增一处）；新用例场景二断言弱（放行与结算不可区分，探针已补判）；非拓扑序声明的多跳级联需逐轮派发收齐（与既有逐轮派发模型一致）。gate-check 快照：G1–G3 按预期待重签，G4 正文与 artifact 结论不一致属 S4 门记录问题，已在回包转 S4。"
}
```
<!-- audit-verdict:end -->

## 1. 裁决

结论：**pass**

P0 = 0，P1 = 0，P2 = 1；必过项 20/20。

## 2. 审计基准

| 项 | 值 |
| --- | --- |
| 主线 HEAD / 本轮候选 / 本报告绑定提交 | `4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f`（审计期间 HEAD 不再前进；本人改动只有本报告，`tmp/r71/` 探针交付前已删；同工作树另有其他审计员在途的 `docs/audits/S4-independent-audit-round1.md` 改动，未触碰） |
| 审计范围 | `git diff 4e751de..4ecff7a`：10 个文件；S4 修复批次（dispatcher 前置失败结算与有效行判定、gate-check 的 G4 非空断言、G4 新回归用例、四份审计报告落盘、full-suite 数字重测、G4.md 证据映射） |
| G2 共享路径生产改动 | 仅 `src/service/dispatcher.ts`（+43：`effectiveStatus` 有效行读取、`readinessOf` 的 failedPreds 档、`dispatchRun` 结算分支与 outcomes 收集、`[...settled, ...outcomes]` 返回） |
| G2 核心文件零改动 | `apply-report.ts`、`lease.ts`、`cancel.ts`、`recovery.ts`、`run-close.ts`、`nodes.ts`、`node-state.ts`、`clock-recovery.ts`、`ledger.ts`、`state-machine.ts` 均不在 diff 名单内 |
| 上一轮 | `docs/audits/S2-independent-audit-round70.md`（候选 `4e751de`，P2×3：hang_reason 存量标记、typecheck 11 处、dispatcher 前置失败滞留） |
| 必读文档 | `审计要求.md`（§1/§4/§5/§6/附录 A）、`scripts/gate-check.ts` 的 `GATE_SPECS.G2`、`src/core/audit-verdict.ts`、`src/service/dispatcher.ts`、`tests/integration/workflow-g4.spec.ts` |
| 未能确认的范围 | 无 |

## 3. 上一轮问题复核（逐条，不默认已修复）

| 编号 | 复核位置（本人读到） | 结论 | 验证方式 |
| --- | --- | --- | --- |
| r69 P2-1 / r70 P2-1：带 `hang_reason` 的存量行打标后确认接口回 `STALE_GENERATION`，标记留存 | `src/service/clock-recovery.ts:95-98`、`:110-122`、`src/service/commands/recovery.ts:52-75`、`src/service/commands/nodes.ts:210` 本候选全部零改动 | 未处理，维持 P2（本轮第 6 节 P2-1） | 代码阅读 + diff 名单核对 |
| r70 P2-2：`pnpm typecheck` 11 处 TS18048/TS2532（`tests/gate/gate-check.spec.ts` 的 G4 注册用例） | 候选把 `GATE_SPECS.G4` 收窄为 `const G4 = GATE_SPECS.G4!` 后逐处点属性（`tests/gate/gate-check.spec.ts:1736-1763`） | 已修复并验证 | `pnpm typecheck` 实跑 exit 0（干净取退出码）；`tests/gate/gate-check.spec.ts` 单跑 187 passed / 1 skipped |
| r70 P2-3：前置非成功终态后置永滞 `queued`，run 滞留 `running` | `src/service/dispatcher.ts:106-139`（`BLOCKED_TERMINAL` + `effectiveStatus` + `readinessOf`）、`:172-183`（结算分支）、`:194-196`（收口与 outcomes 返回） | 已修复并验证 | 代码阅读 + 新用例（`tests/integration/workflow-g4.spec.ts:540-601`）+ 本人探针两例（第 8 节） |
| r70 P3-2：`failQueuedNode` 返回值被丢弃，收口结果不进 outcomes | `dispatcher.ts:174-182` 现经 `outcomeForSettlement` 收集进 `settled`，`dispatcher.ts:196` 返回 `[...settled, ...outcomes]` | 已修复并验证 | 探针一的 `DISPATCH_OUTCOMES` 里能看到结算行及其 `settlement: applied` |
| r70 P3-1 / P3-3：目录 edges 无绑定哈希比对、终态词表多处手写 | `dispatcher.ts:151-163` 仍取目录当前定义；终态词表在 `state-machine.ts:18-26`、`run-close.ts:41`、`clock-recovery.ts:96` 之外，本批 `dispatcher.ts:106-108` 又新增 `SUCCESS_STATUS`/`BLOCKED_TERMINAL` 两处 | 仍为 P3，不阻断（第 6 节 P3-1/P3-3） | 代码阅读 |

## 4. 本批修改质量：dispatcher 修复与 G2 回归逐条核查

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `readinessOf` 三档判定（`dispatcher.ts:124-139`） | 符合预期，无需修改 | 缺行→`missingPreds`（配置错误，保持防御面）；`BLOCKED_TERMINAL` 八态（failed/failed_with_unverified/timeout/cancelled/superseded/orphaned/abandoned_unverified/indeterminate_side_effect）→`failedPreds`；其余未完成态→`waitingPreds`。优先级 missing > failed > waiting，与 r70 防御面语义兼容：缺行仍按配置错误收，不与失败传播混判 |
| `effectiveStatus` 有效行判定（`dispatcher.ts:117-122`） | 符合预期 | `ORDER BY attempt DESC, seq DESC LIMIT 1`，M-60 重试换行（旧行 superseded、新行 attempt+1）后读新行。探针一证实：旧行 superseded、新行 done 时后置走放行路径（收口错误码 `EVIDENCE_SOURCE_UNAVAILABLE`，即执行器没装配的派发路径），而不是 `RESOLUTION_NOT_AVAILABLE` 结算档——两档在用例里都落 `failed`，只有错误码能区分，探针判据可靠 |
| `dispatchRun` 结算分支与 outcomes（`dispatcher.ts:165-196`） | 符合预期 | `failedPreds` 与 `missingPreds` 都经 `failQueuedNode`（`dispatcher.ts:299-331`，M-48 落 `dispatch.failed` 事件）收成 `failed`，`outcomeForSettlement` 翻译进返回值；末尾 `closeRun` 在后置进入终态后同轮收口 run（新用例断言 run 不停 `running`）。`RESOLUTION_NOT_AVAILABLE` 是既有错误码（`src/core/errors.ts:21`），事件载荷 `error_code` 与 outcome 一致 |
| 新回归用例（`tests/integration/workflow-g4.spec.ts:540-601`） | 覆盖目标达成，一处断言偏松（第 6 节 P3-4） | 场景一锁了：前置 `failed`→后置 `failed`、事件 `dispatch.failed` 带 `RESOLUTION_NOT_AVAILABLE`、run 离开 `running`；场景二锁了换行后后置不停 `queued`，但断言区分不了「放行」与「结算」，M-60 档由本人探针补判（第 8 节） |
| G2 单节点闭环回归 | 无回归 | 无 `edges` 或目录查不到版本时 `preds` 为空（`dispatcher.ts:145-163`），`readinessOf` 对空前置恒返回 ready，全量派发与上轮逐字相同；`settled` 恒空，返回值等价于旧 `outcomes`。G2 核心文件零改动（第 2 节）。实跑面：全量 78 files / 1023 passed / 1 skipped（较 r70 的 1022 增 1，即 G4 新用例）；报告/租约/取消/恢复/收口子集 7 files / 118 passed；第二回归面 7 files / 112 passed；证据复现 29/29 |
| `tests/gate/gate-check.spec.ts` 非空断言 | 符合预期，无需修改 | 仅测试侧收窄类型（`GATE_SPECS.G4!`），零行为变化；生产 `src/` 零类型改动。full-suite.md 数字重测（1022→1023）与本人实测一致，r70 指出的「typecheck exit 0 与实测不符」已对齐 |
| 迁移、HTTP、幂等通道 | 本候选零改动 | diff 只有 dispatcher 生产代码；`applyReport`/租约/取消/恢复路径未触碰 |

## 5. 必须阻断的问题

本轮未发现新的 P0/P1 阻断问题。

## 6. 可延期问题

| 编号 | 位置 | 说明 | 影响与建议 |
| --- | --- | --- | --- |
| P2-1（r69 遗留） | `src/service/clock-recovery.ts:95-98`、`:110-122`；`src/service/commands/recovery.ts:52-75`；`src/service/commands/nodes.ts:210` | 带 `hang_reason` 的存量行仍会进 action 通道被打上 `recovery_uncertain`，唯一清除入口 `resolveRecoveryUncertain` 因 `applyTransition` 的 `hang_reason IS NULL` 闸门回 `STALE_GENERATION`，标记留存；本候选未触碰相关文件 | 触发面限于升级前存量行与保留 `fence_state='armed'` 的终态行；节点压在裁决链上，业务处置仍走既有裁决。维持 r69/r70 建议：reanchor 四个 SELECT 补 `hang_reason IS NULL` 与终态排除，并提供只清标记的运维出口 |
| P3-1（r70 维持） | `src/service/dispatcher.ts:151-163` | readiness 闸取目录当前定义的 edges，不做 run 绑定哈希比对（哈希闸在 `resolveControlConfig` 里只管控制节点） | 生产已发布版本不可变（027 触发器）且 `adopt` 验哈希，实际风险仅测试形态；S4 收口时顺手对齐 |
| P3-3（r70 维持并扩展） | `state-machine.ts:18-26`、`run-close.ts:41`、`clock-recovery.ts:96`，本批新增 `dispatcher.ts:106-108` | 终态/成功词表仍多处各自维护，本批又新增 `SUCCESS_STATUS` 与 `BLOCKED_TERMINAL` 两处手写集合 | 可读性改进：词表分叉时行为会静默分叉，建议单点定义常量后引用；按既有 P3 清单安排 |
| P3-4（本轮新，测试缺口） | `tests/integration/workflow-g4.spec.ts:598-600` | 场景二只断言 `b2.status` 不是 `queued`：放行后无执行器收成 `failed` 与被 `failedPreds` 结算成 `failed` 都满足断言，M-60 有效行档的回归抓不住 | 实际降低的质量保障：`effectiveStatus` 将来回退成「读第一行」时用例仍绿，换行放行缺口会静默复现。建议断言改为校验后置收口事件的 `error_code` 为 `EVIDENCE_SOURCE_UNAVAILABLE`（或装配执行器断言 `done`），本轮由本人探针补判（第 8 节） |
| P3-5（本轮新，健壮性） | `src/service/dispatcher.ts:141-196`（`ORDER BY seq ASC` 逐行判定） | 节点声明顺序非拓扑时（如节点序 c,b,a 而链是 a→b→c），前置结算与后置判定同轮按 seq 逆序进行，末位后置要等下一轮 `dispatchRun` 才被结算（探针二：一轮收 b 留 c，二轮收 c 且 run 收口） | 与既有逐轮派发模型一致（成功路径的后置本来也是下一轮放行），run 不会永滞；仅当宿主只派发一次且不再触发时滞留面比拓扑序宽。建议 S4 收口时补一条拓扑序校验或结算后自唤醒，成本低 |

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

`must_pass_ids` 与 `scripts/gate-check.ts` 的 `GATE_SPECS.G2.items` 逐项一致（20 项，无重复、无规格外项）。证据 29/29 两遍字节复现；r70 结论沿用，本批 G2 共享路径改动经第 4 节逐条回归核查无影响。

## 8. 实测命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0（干净取退出码；r70 的 11 处 TS 报错已消） |
| `npx vitest run` | 78 files，1023 passed / 1 skipped（22.79s；较 r70 增 1 例即 G4 新用例） |
| `npx vitest run tests/integration/{apply-report,lease,cancel,recovery-uncertain,recovery-action-checkpoint,control-dispatch,run-close}.spec.ts` | 7 files，118 passed（G2 报告/租约/取消/恢复/收口回归面） |
| `npx vitest run tests/integration/{cancel,control-dispatch,clock-recovery,sweep,subworkflow,g2,recovery-unit-migration}.spec.ts` | 7 files，112 passed（与 r69/r70 同口径回归面） |
| `npx vitest run tests/integration/workflow-g4.spec.ts` | 1 file，14 passed（含前置失败收口与换行放行两个新场景） |
| `npx vitest run tests/gate/gate-check.spec.ts` | 1 file，187 passed / 1 skipped（G4 注册用例收窄后全绿） |
| `node --no-warnings scripts/check-evidence-repro.ts` | 证据复现成立：29 份，每份重跑两遍都与 HEAD 字节一致 |
| 本人探针 `npx vitest run --root tmp/r71` | 2 例全过。探针一：M-60 换行（旧行 superseded、新行 attempt=2 done）后后置走放行路径，收口错误码 `EVIDENCE_SOURCE_UNAVAILABLE`（非 `RESOLUTION_NOT_AVAILABLE` 结算档），结算行出现在 dispatch outcomes；探针二：非拓扑序声明的 a→b→c 链，a 落 `failed` 后一轮收 b、二轮收 c，run 收口（第 6 节 P3-5） |
| `node --no-warnings scripts/gate-check.ts` | G1/G2/G3 按预期待重签（证据文件 `docs/gates/evidence/G1/G-14.md` 在各自门记录候选之后改过）；G4 报「门记录正文结论与 GateArtifact 不符：正文=fail，artifact=pass」，属 S4 门记录问题（已在回包转 S4） |

## 9. 退出条件与阶段性判定

| 退出条件 | 状态 |
| --- | --- |
| 无未解决 P0 | 满足 |
| 无未解决且阻碍下一阶段的 P1 | 满足 |
| 本轮修改已完成针对性审查 | 满足（第 3、4 节逐条：r70 两个 P2 修复核验、dispatcher 改动与 G2 回归面全查） |
| 关键业务路径有测试与验证证据 | 满足（78 files / 1023 例 + 29 份证据复现 + 2 条独立探针 + 重点回归面 118/112 例） |
| 核心数据、状态转换、外部副作用符合不变量 | 满足（报告幂等、租约、CAS、检查点、终态枚举、断链闸均未被本批改动触碰或经逐条核查无回归） |
| 重要异常路径有失败处理与恢复策略 | 满足（前置失败终态同轮结算后置并收口 run；滞留面收窄到 P3-5 的逐轮派发模型） |
| 未解决的 P2/P3 已记录并有影响说明 | 满足（第 6 节 P2×1、P3×4） |
| 无未解释的测试、构建或兼容问题 | 满足（全量与子集全绿；typecheck 已恢复 exit 0） |
| 已形成可复现、可追溯的版本基准 | 满足（候选即 HEAD） |

可靠性收敛阶段通过，可以进入下一阶段开发。

## 10. 下一步建议

1. 本报告提交后按 G1→G2→G3 重签门记录（gate-check 显示证据文件在旧候选之后改过，属预期待重签）；G4 门记录「正文=fail / artifact=pass」的结论不一致请 S4 收口时对齐；
2. 建议结束 S2/G2 的全面收敛审计轮次，转入正常功能开发；S4 面只剩 P3 级收尾（P3-4 断言收紧、P3-5 拓扑序或自唤醒、P3-1/P3-3 顺手对齐），不单开 S2 轮次；
3. 升级部署时按 r69/r70 建议给 hang_reason 存量标记留一条只清标记的运维出口（P2-1），并抽查 `recovery_unit_fixes` 的 `unclassified_kept` 行。

## 11. 裁决块自检

用 `src/core/audit-verdict.ts` 的 `parseAuditVerdict` / `verdictProblems` 与 `scripts/gate-check.ts` 的 `auditConclusionOf` / `proseVerdictClashes`（`node --experimental-strip-types` 实跑）对本报告全文自检：

| 检查 | 结果 |
| --- | --- |
| `parseAuditVerdict` | 解析成功，13 字段全部通过 `validateAuditVerdict` |
| `verdictProblems`（对 `GATE_SPECS.G2.items`，round 71，绑定候选） | 空列表 |
| `auditConclusionOf` | `pass`（与裁决块一致，正文结论行唯一） |
| `proseVerdictClashes` | 空列表 |
