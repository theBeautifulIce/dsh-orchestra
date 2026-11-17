# S4 独立审计 · 第 2 轮（4ecff7a）

门：G4
候选提交：4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f

结论：pass（14 项必过全过，失败项为空，无 run）。

上一轮（`docs/audits/S4-independent-audit-round1.md`，绑定 4e751de）提出的两个 P1 与一个 P2 逐项复验：P1-1、P1-2 均已修复并验证，P2-1 的门记录补正还差两处（见第五节，均在候选范围外、按「先拦后签」的保守口径由检查器把关，不阻断本阶段收口）。规范第八节九条通用退出条件逐条核对成立。**可靠性收敛阶段通过，可以进入下一阶段开发。**

## 一、审计基准

| 项 | 值 |
| --- | --- |
| 上一轮报告 | `docs/audits/S4-independent-audit-round1.md`（round1，绑定 4e751de，裁决 fail，P0 0 / P1 2 / P2 1） |
| 本轮候选提交 | `4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f`（`fix(s4): settle successors of failed/replaced predecessors; unbreak typecheck`，父 4e751de） |
| 本轮变化 | `4e751de..4ecff7a` 一个修复批：`src/service/dispatcher.ts`（前置有效行判定与结算）、`tests/gate/gate-check.spec.ts`（类型收窄）、`tests/integration/workflow-g4.spec.ts`（回归用例）、`docs/gates/G4.md` 与 `docs/gates/evidence/G4/full-suite.md`（记录与证据数字）；其后 HEAD 仅 docs/audits 报告入库（排除路径） |
| 检查范围 | 修复批逐行复核 + G4 全部 14 项必过面回归 + 上一轮两个 P1 的探针复跑 |
| 使用文档 | `审计要求.md`、round1 报告、`docs/gates/G4.md`、`docs/gates/evidence/G4/G-10.md` 与 `full-suite.md`、`src/core/audit-verdict.ts` |
| 未能确认的范围 | 同上一轮：SQLite 写锁等待与 busy 行为（G4-08 的语义限定不变，门记录措辞已如实限定） |

## 二、上一轮问题复验

| 上一轮编号 | 状态 | 复验依据 |
| --- | --- | --- |
| P1-1 | 已修复并验证 | `pnpm typecheck` 退出 0（11 处 TS 报错已全部消除，`tests/gate/gate-check.spec.ts` 用非空收窄后访问）；`full-suite.md` 四项结果与实测逐项一致：78 files、1023 passed、1 skipped、345.32 kB / gzip 82.85 kB、29/29 |
| P1-2 | 已修复并验证 | `src/service/dispatcher.ts` 增加前置有效行判定（`ORDER BY attempt DESC`）与非成功终态结算档（后置按 `dispatch.failed` 结算并回传 outcomes）；新增回归用例两场景 + 审计双探针独立复跑：前置异常面后置被结算、run 一次派发即收口；换 attempt 双行面后置正常放行 |
| P2-1 | 部分修复，残留见第五节 | artifact 的 G4-06 证据列已补 `ev-g4-14`；evidence-index 块仍为 14 条（正文证据表 15 行），且 G4.md:13 段落措辞仍让正文结论判定与 artifact 不一致 |

## 三、实测命令与退出码

全部在候选工作树实跑（工作树干净，与候选提交一致）。

| 命令 | 退出码 | 实测结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 78 files，1023 passed、1 skipped（1024） |
| `pnpm build` | 0 | ESM `lib/index.js` 345.32 kB / gzip 82.85 kB、`lib/index.d.ts` 26.10 kB；CJS `lib/client.js` 0.29 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：29 份，每份重跑两遍都与 HEAD 字节一致（含 G3/G4 注入摘要） |
| `pnpm vitest run`（workflow-doc-save / workflow-doc-publish / operation-id / workflow-commands / workflow-g4 / workflow-routes / gate-check 七个文件） | 0 | 7 files，251 passed、1 skipped |
| `node --no-warnings scripts/gate-check.ts docs/gates/G4.md` | 1 | 门记录侧两点待补正（第五节）：正文结论判定与 artifact 不一致被点名；evidence-index 差一条会在该项补正后被点名 |
| 审计探针 ×2（tmp，用后即删） | 0 | P1-2 行为闭合：前置异常面后置落终态、run 收口为终态；换行面后置不再滞 queued |

## 四、必过项 14 项

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
| G4-13 | pass | typecheck 退出 0；78 files、1023 passed、1 skipped；build 345.32 kB / gzip 82.85 kB、26.10 kB；证据复现 29/29——与 full-suite.md 逐项一致 |
| G-10 | pass | 注入摘要两遍字节一致、repro-sha256 核过；在途 run 记 v1、新 run 记 v2，发布不影响在途 run |

## 五、P2（不阻断，签门前补正）

| 编号 | 问题 | 位置 | 复现与影响 |
| --- | --- | --- | --- |
| P2-1 | G4.md 门记录两处待补正：①artifact 的 G4-06 证据列已补 `ev-g4-14`，evidence-index 块仍为 14 条（正文证据表 15 行，两处不同源，checkBodyEvidenceTable 会点名）；②G4.md:13 段落的场景描述措辞让 bodyConclusionOf 的正文判定被读成否定，与 artifact 的结论不一致 | `docs/gates/G4.md:112-117`、`:195-267`、`:13`；`scripts/gate-check.ts:2715-2718`（正文结论比对）、`:576-599`（证据表比对）；`scripts/sign-gate.ts:81`（签门前自检同口径） | 实测 `node --no-warnings scripts/gate-check.ts docs/gates/G4.md` 退出 1，报「门记录正文结论与 GateArtifact 不符」；②属上一轮被更早的一项比对先拦住的既有措辞问题，本轮浮出 |

影响：G4 门记录按现状不能完成签门与过门（sign-gate 与 gate-check 同口径先拦后签），不一致不会被带进正式门记录；两条都在候选范围外，属门记录补正，不阻断 S4 阶段收口。修复建议：①evidence-index 块补 `ev-g4-14` 条目（文件 `tests/integration/workflow-commands.spec.ts`，签门时哈希由 sign-gate 填）；②G4.md:13 段落措辞改中性（避开正文判定的否定词口径，例如把场景对照改写成「一个成功、另一个按业务冲突结算」一类描述）；签门时同步把 `audit_report` 指向本报告、`audit_round` 置 2，再走 `sign-gate`。

## 六、测试强度备注（P3，不阻断）

本轮新增回归用例的第二场景只断言后置节点不滞 queued，未钉死它的具体终态与事件类型，建议后续收紧。另一条口径备注：派发前被结算的节点按保守的 compensable 未核实计入收口，run 的收口终态会带未核实标记（业务事实仍完整写进 `run.terminal` 事件的 outcome 与节点清单），属既有保守口径，本轮不改。

## 七、结构性裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G4",
  "audit_round": 2,
  "candidate_commit": "4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 1,
  "must_pass_total": 14,
  "must_pass_passed": 14,
  "must_pass_ids": ["G4-01", "G4-02", "G4-03", "G4-04", "G4-05", "G4-06", "G4-07", "G4-08", "G4-09", "G4-10", "G4-11", "G4-12", "G4-13", "G-10"],
  "failed_items": [],
  "notes": "上一轮 P1-1、P1-2 复验闭合，G4-13 证据面四项与实测逐项一致；P2-1 为门记录两处待补正（候选范围外，签门前处理）；P3 备注见正文。可靠性收敛阶段通过，可以进入下一阶段开发。"
}
```
<!-- audit-verdict:end -->

## 八、落盘前自检

用 `src/core/audit-verdict.ts` 与 `scripts/gate-check.ts` 的四个函数对本报告文本独立复核（探针已随 tmp 清理）：

| 检查 | 输出 |
| --- | --- |
| `parseAuditVerdict` | 返回 `{verdict}`，无 error；schema、轮次、40 位候选、计数合法，must_pass_ids 恰好覆盖 GATE_SPECS.G4.items 14 项、无重复、无规格外项 |
| `proseVerdictClashes`（verdict=pass，14 项，auditRound=2） | 返回空：结论行唯一且与裁决同向，必过项与表格无否决表述，无溢出列、无隐藏判定 |
| `auditConclusionOf` | 返回 `pass`，与裁决一致 |
| `verdictProblems` | 返回空：门/轮次/候选对账、必过项覆盖与总数、去重、裁决块清单等全部满足 |

## 九、下一步建议

1. 补正 G4.md 两处（evidence-index 补 `ev-g4-14` 条目、G4.md:13 措辞中性化），签门时把 `audit_report` 指向本报告、`audit_round` 置 2，按 `sign-gate` 出哈希。
2. `gate-check` 全绿过门后，正式结束 S1–S4 收敛审计，转入 S5 面板与记忆开发。
3. （可选）按 P3 备注收紧新增回归用例的终态断言。
