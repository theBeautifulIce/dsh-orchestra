# S4 独立审计 · 第 3 轮（32517a5）

门：G4
候选提交：32517a5287df6221d3f9024efa4adc074efea8d3

结论：pass（14 项必过全过，失败项为空）。

本轮为 delta 快审：候选只动 `src/service/dispatcher.ts`、`tests/integration/workflow-g4.spec.ts` 与一份候选外审计记录（S3 r22）。S3 r22 的 P2-7（`BLOCKED_TERMINAL` 把可裁决恢复的 `indeterminate_side_effect` 误当成收口前置，在裁决窗口提前结算后置）已按其修复建议落地并经独立探针复验；P3-2 的场景二断言已收紧；S4 r2 的 P2-1 两处门记录补正已在前序提交落库、gate-check 不再点名。本轮新记 P2 一项（ev-g4-13 的 build 行数字随候选漂移，签门前刷新，见第五节）。规范第八节九条通用退出条件逐条核对成立。**可靠性收敛阶段通过，可以进入下一阶段开发。**

## 一、审计基准

| 项 | 值 |
| --- | --- |
| 上一轮报告 | `docs/audits/S4-independent-audit-round2.md`（round2，绑定 4ecff7a，裁决 pass，P0 0 / P1 0 / P2 1） |
| 本轮候选提交 | `32517a5287df6221d3f9024efa4adc074efea8d3`（`fix(s4): derive blocked-pred terminal set from the state machine`，父 a94a6ef） |
| 本轮变化 | 候选提交一个修复批：`src/service/dispatcher.ts`（`BLOCKED_TERMINAL` 从 `TERMINAL_STATUSES` 派生）、`tests/integration/workflow-g4.spec.ts`（场景三回归用例 + 场景二断言收紧）、`docs/audits/S3-independent-audit-round22.md`（候选外报告入库）；`docs/gates/G4.md` 的两处补正（evidence-index 含 ev-g4-14、正文措辞中性化）已在前序提交 d9ce139、f686657 落库 |
| 检查范围 | delta 逐行复核 + P2-7 修复语义独立探针 + G4 全部 14 项必过面回归 + r2 P2-1 复验 + ev-g4-13 证据数字对账 |
| 使用文档 | `审计要求.md`、round2 报告、`docs/audits/S3-independent-audit-round22.md`、`docs/gates/G4.md`、`docs/gates/evidence/G4/full-suite.md`、`src/core/state-machine.ts`、`src/core/audit-verdict.ts` |
| 未能确认的范围 | 同前两轮：SQLite 写锁等待与 busy 行为（G4-08 的语义限定不变，门记录措辞已如实限定） |

## 二、delta 复验

| 复验项 | 状态 | 依据 |
| --- | --- | --- |
| S3 r22 P2-7 | 已修复并验证 | `src/service/dispatcher.ts:107-110`：`BLOCKED_TERMINAL` 改为 `TERMINAL_STATUSES` 去掉 `SUCCESS_STATUS` 派生（非成功终态恰六个：failed、timeout、abandoned_unverified、failed_with_unverified、orphaned、superseded），与状态机单一定义对齐（规范第八节 5），run 级词表死条目不再混入 node 级判定；`readinessOf`（:126-141）把 `indeterminate_side_effect`、`startup_unknown` 等非终态归入等待档，裁决窗口内后置不再被结算 |
| S3 r22 P2-7 回归用例 | 已补 | `tests/integration/workflow-g4.spec.ts:593-612` 场景三：前置落 `indeterminate_side_effect` 时后置滞留 `queued`、run 不收口；M-60 裁决换行（旧行 superseded、新行 attempt=2 done）后后置放行 |
| S3 r22 P3-2 | 已收紧 | `tests/integration/workflow-g4.spec.ts:614-621` 场景二补事件判别断言：后置的最后事件不得带 `RESOLUTION_NOT_AVAILABLE`（区分「放行执行」与「被前置结算」） |
| r2 P2-1 ① | 已修复 | `docs/gates/G4.md:63`、`:116`、`:264` 证据表与 evidence-index 块都含 ev-g4-14；gate-check 不再点名证据表差异 |
| r2 P2-1 ② | 已修复 | `docs/gates/G4.md:13` 段落措辞中性化（「一个成功、另一个按业务冲突结算」），正文判定与 artifact 结论同向；gate-check 不再点名正文结论比对 |

修复语义独立探针（tmp，24 项断言全过、用后即删）：M-51 同行裁决（`indeterminate_side_effect` 直接改 `done`）与 M-60 换行裁决两条路径加 `startup_unknown` 对照面——不确定窗口内后置滞留 `queued`、无 `RESOLUTION_NOT_AVAILABLE` 结算事件、run 保持 running；裁决后后置放行进入执行路径（缺执行器落 `EVIDENCE_SOURCE_UNAVAILABLE` 档，与前置结算码可区分，证实走的是放行而非结算）；六个非成功终态逐一做前置时后置全部仍按 `RESOLUTION_NOT_AVAILABLE` 结算收口，派生集合无漏项。

## 三、实测命令与退出码

全部在候选工作树实跑（候选文件零改动、与候选提交一致；docs/audits 排除路径下有并行队友的新报告文件，不影响任何检查）。

| 命令 | 退出码 | 实测结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `npx vitest run`（全量） | 0 | 78 files，1023 passed、1 skipped（1024） |
| `npx vitest run`（G4 七件套：workflow-doc-save / workflow-doc-publish / operation-id / workflow-commands / workflow-g4 / workflow-routes / gate-check） | 0 | 7 files，251 passed、1 skipped |
| `pnpm build` | 0 | ESM `lib/index.js` 345.22 kB / gzip 82.84 kB、`lib/index.d.ts` 26.10 kB；CJS `lib/client.js` 0.29 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：29 份，每份重跑两遍都与 HEAD 字节一致（含 G3/G4 注入摘要） |
| `node --no-warnings scripts/gate-check.ts docs/gates/G4.md` | 1 | 只点名一项：`previous_artifact_hash` 哈希占位待 sign-gate 签门时填——属预期状态，不计问题 |
| 审计探针 ×1（tmp，用后即删） | 0 | P2-7 行为闭合：不确定窗口等待、两条裁决路径放行、六个终态面结算，24 项断言全过 |

## 四、必过项 14 项

r2 结论沿用；delta 触及的证据文件（workflow-g4.spec.ts）用例全绿，逐项复跑确认。

| 编号 | 结果 | 依据 |
| --- | --- | --- |
| G4-01 | pass | 命令路径 404、草稿分流与 based_on_version 断言用例全绿 |
| G4-02 | pass | 已消费草稿优先 DRAFT_NOT_OPEN、内容未变 changed=false 用例全绿 |
| G4-03 | pass | workflow-doc-save.spec 保存层拒绝码用例全绿 |
| G4-04 | pass | workflow-doc-publish.spec 子流程 pin、深度、环校验用例全绿 |
| G4-05 | pass | 在途 run 固定旧版本与版本行不可变断言全绿 |
| G4-06 | pass | task_local 预留→归属→绑定起 run 闭环、根入口限定、HTTP 不接受自报 owner 用例全绿 |
| G4-07 | pass | 发布事务同笔与整笔回滚、回执重放用例全绿 |
| G4-08 | pass | 双 worker 真并发抢一张草稿恰一成功的用例全绿 |
| G4-09 | pass | 发布新版本时旧 run 固定 v1、新 run 用 v2 断言全绿 |
| G4-10 | pass | 保存层结构性校验与发布层图语义校验（错误带 path）用例全绿 |
| G4-11 | pass | 版本不可变与 run 固定两条一起断言全绿 |
| G4-12 | pass | HTTP 六入口与 UUIDv7 幂等协议契约用例全绿 |
| G4-13 | pass | typecheck 退出 0；78 files、1023 passed、1 skipped；build 退出 0（345.22 kB / gzip 82.84 kB、26.10 kB）；证据复现 29/29。四项全绿达标；ev-g4-13 的 build 行数字与本轮实测有差，见 P2-1 |
| G-10 | pass | 注入摘要两遍字节一致、repro-sha256 核过；在途 run 记 v1、新 run 记 v2，发布不影响在途 run |

## 五、P2（不阻断，签门前补正）

| 编号 | 问题 | 位置 | 复现与影响 |
| --- | --- | --- | --- |
| P2-1 | ev-g4-13（`full-suite.md`）的 build 行数字停在上一轮实测（ESM 345.32 kB / gzip 82.85 kB），候选的 `dispatcher.ts` 改动后本轮实测为 345.22 kB / 82.84 kB（`lib/index.d.ts` 26.10 kB 与其余各行不变）；`sign-gate` 只按 HEAD 字节给证据文件取哈希、`gate-check` 也不重跑 build，这行会被原样签进正式门记录 | `docs/gates/evidence/G4/full-suite.md:5`、`:12`；`scripts/sign-gate.ts`（证据哈希口径） | 实测 `pnpm build` 与记录逐项对照：typecheck 退出 0、78 files / 1023 passed / 1 skipped、证据复现 29/29 三行与记录一致，build 行一行有差（-0.10 kB，与删除的字面量集合体量吻合）。影响：签名后的证据文件带一个已过时的构建数字，全量门运行记录的「逐项一致」承诺被削弱；无行为面影响（构建退出 0、产物可生成）。修复建议：签门前重跑 `pnpm typecheck`、`pnpm test`、`pnpm build`、`node --no-warnings scripts/check-evidence-repro.ts` 四条并更新 `full-suite.md` 的 build 行数字（或注明数字为该时点快照），随后按 sign-gate 流程出哈希 |

## 六、测试强度备注（P3，不阻断）

1. 场景三的收尾断言只锁「后置不滞 queued」（`workflow-g4.spec.ts:611-612`），没有像场景二那样补事件判别；当前语义下前置已 done、结算档不可达，断言不会漏放行与结算的混淆，但长期回归防护弱于场景二，建议后续同样补 `event.error_code` 判别。本轮探针已独立区分（放行走 `EVIDENCE_SOURCE_UNAVAILABLE` 执行档）。
2. r2 的口径备注沿用：派发前被结算的节点按保守的 compensable 未核实计入收口，run 的收口终态会带未核实标记，业务事实仍完整写进 `run.terminal` 事件，属既有保守口径，本轮不改。

## 七、结构性裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G4",
  "audit_round": 3,
  "candidate_commit": "32517a5287df6221d3f9024efa4adc074efea8d3",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 1,
  "must_pass_total": 14,
  "must_pass_passed": 14,
  "must_pass_ids": ["G4-01", "G4-02", "G4-03", "G4-04", "G4-05", "G4-06", "G4-07", "G4-08", "G4-09", "G4-10", "G4-11", "G4-12", "G4-13", "G-10"],
  "failed_items": [],
  "notes": "delta 快审：S3 r22 P2-7 已修复（BLOCKED_TERMINAL 从状态机终态表派生）并经独立探针复验两条裁决路径与六个终态面，P3-2 断言已收紧；r2 P2-1 两处门记录补正已落库。新记 P2-1：ev-g4-13 的 build 行数字随候选漂移，签门前刷新。可靠性收敛阶段通过，可以进入下一阶段开发。"
}
```
<!-- audit-verdict:end -->

## 八、落盘前自检

用 `src/core/audit-verdict.ts` 与 `scripts/gate-check.ts` 的四个函数对本报告文本独立复核（探针已随 tmp 清理）：

| 检查 | 输出 |
| --- | --- |
| `parseAuditVerdict` | 返回 `{verdict}`，无 error；schema、轮次、40 位候选、计数合法，must_pass_ids 恰好覆盖 GATE_SPECS.G4.items 14 项、无重复、无规格外项 |
| `proseVerdictClashes`（verdict=pass，14 项，auditRound=3） | 返回空：结论行唯一且与裁决同向，必过项与表格无否决表述，无溢出列、无隐藏判定 |
| `auditConclusionOf` | 返回 `pass`，与裁决一致 |
| `verdictProblems` | 返回空：门/轮次/候选对账、必过项覆盖与总数、去重、裁决块清单等全部满足 |

## 九、下一步建议

1. 签门前刷新 `full-suite.md` 的 build 行数字（P2-1），并把 G4.md artifact 的 `audit_report` 指向本报告、`audit_round` 置 3，按 `sign-gate` 出哈希（`previous_artifact_hash` 占位由签门流程填）。
2. `gate-check` 全绿过门后，正式结束 S1–S4 收敛审计，转入 S5 面板与记忆开发。
3. （可选）按 P3 备注给场景三收尾补事件判别断言。
