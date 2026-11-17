# S3 独立审计报告 · G3 第 22 轮

门：G3
候选提交：4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f
审计日期：2026-11-17
审计方式：独立只读审计；未签门、未改生产代码、未改测试与证据、未改门记录；临时探针只放 `tmp/r22-probe`，交付前删除

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 22,
  "candidate_commit": "4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 5,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": [
    "G3-01",
    "G3-02",
    "G3-03",
    "G3-04",
    "G3-05",
    "G3-06",
    "G3-07",
    "G3-08",
    "G3-09",
    "G3-10",
    "G3-11",
    "G-01",
    "G-02",
    "G-04",
    "G-06",
    "G-12",
    "G-16",
    "G3-12",
    "G3-13",
    "G3-14"
  ],
  "failed_items": [],
  "notes": "r21 三条问题逐条闭合并实测复现：P2-5(a) 非成功终态前置走 failQueuedNode/RESOLUTION_NOT_AVAILABLE 结算后置（探针 S1），P2-5(b) effectiveStatus 按 attempt DESC 读有效行、M-60 换行后放行后置（探针 S2），P2-6 typecheck 归零（tsc --noEmit exit 0，G3 full-suite.md 的 typecheck 口径与候选重新对齐），P3-1 结算结果进 dispatch outcomes（探针 S1/S5）。20 项必过全过：全量 78 files / 1023 passed、1 skipped，build 345.32 kB 与证据 29/29 字节复现。新记 P2-7：BLOCKED_TERMINAL 把非终态 indeterminate_side_effect 误列为不可达前置，后置在裁决窗口内被提前结算，前置经 M-60 重试成功后 run 仍收出负向终态（探针 S3/S4 对照），属候选引入的行为回归，建议 G4 签发前修（与 r21 对 P2-5 同门槛）；P3-2 为新用例场景二断言偏弱。r20 遗留 P2-1…P2-4 相应文件零改动，维持。"
}
```
<!-- audit-verdict:end -->

## 1. 本轮审计基准

| 项 | 值 |
| --- | --- |
| 主线与本地 HEAD | 审计开始时 HEAD = `4ecff7a`（即候选）；复核期间 HEAD 前进至 `f686657`（`4384b6e`、`d9ce139`、`f686657` 三笔只改 `docs/audits/` 与 `docs/gates/G4.md`，均在门排除范围）。候选范围内文件在候选提交之后零改动，本报告只绑定 `4ecff7a` |
| 本轮候选 | `4ecff7a5ff94d10862da24e75f6ab69c0bd4a22f` |
| 上一轮报告 | `docs/audits/S3-independent-audit-round21.md`（r21，候选 `4e751de`） |
| diff 范围 | `4e751de..4ecff7a`，10 个文件、+755/−28：`src/service/dispatcher.ts`（生产）、`tests/gate/gate-check.spec.ts`、`tests/integration/workflow-g4.spec.ts`、`docs/gates/G4.md`、`docs/gates/evidence/G4/full-suite.md`、四份审计报告、`docs/superpowers/plans/2026-11-17-product-roadmap.md` |
| 本轮重点 | 逐条验证 r21 的 P2-5(a)(b)、P2-6、P3-1 是否闭合；回归 dispatcher 改动对 G3 的 wait/子流程/补偿/收口/调度次序有无新影响 |
| 与 G3 面相关的生产改动 | 仅 `src/service/dispatcher.ts`（readinessOf 重构：`effectiveStatus` 有效行判定、`failedPreds` 结算档；`settled` 进 outcomes）。`wait.ts`、`recovery.ts`、`sweep.ts`、`run-close.ts`、`ledger.ts`、`compensation.ts`、`apply-report.ts`、`cancel.ts`、`nodes.ts`、`state-machine.ts` 本轮 diff 零改动 |
| 必读文档 | `审计要求.md`、`scripts/gate-check.ts` 的 `GATE_SPECS.G3`、`src/core/state-machine.ts`、`docs/audits/S3-independent-audit-round21.md`、`docs/audits/S4-independent-audit-round2.md` |
| 未能确认的范围 | 无（仓库、测试、构建与证据复现环境均可用） |
| 工作区观测 | 审计全程未使用 `git add/commit/checkout/stash`；同工作树另有他人在途改动（`docs/audits/S2-independent-audit-round71.md`），未触碰 |

上一轮问题状态（逐条核对，不默认维持）：

| 编号 | 状态 | 依据 |
| --- | --- | --- |
| P2-5(a) 前置非成功终态后置滞留 | 已修复并验证 | `dispatcher.ts:107-108`（`BLOCKED_TERMINAL`）、`:178-183`（`failedPreds` 档走 `failQueuedNode`/`RESOLUTION_NOT_AVAILABLE`）；探针 S1：b 收 `failed`、留 `dispatch.failed`、run 收口 |
| P2-5(b) M-60 换行后 `.get()` 读旧行 | 已修复并验证 | `dispatcher.ts:117-122`（`effectiveStatus` 按 `attempt DESC, seq DESC` 取有效行）；`apply-report.ts:259-268`（M-60 换行 `attempt+1`）；探针 S2：换行 done 后 b 被放行执行（执行桩 done、无结算事件） |
| P2-6 typecheck 11 处 | 已修复并验证 | `tests/gate/gate-check.spec.ts:1736` 起非空收窄（`const G4 = GATE_SPECS.G4!`）；`tsc --noEmit` 退出 0；`docs/gates/evidence/G3/full-suite.md` 的「typecheck exit 0」陈述与候选实测重新对齐（r21 给出的收口选项之一达成） |
| P3-1 failQueuedNode 返回值丢弃 | 已修复并验证 | `dispatcher.ts:174-183`（`settled.push(outcomeForSettlement(...))`）、`:196`（`return [...settled, ...outcomes]`）；探针 S1/S5：结算行带 `settlement:'applied'` 与错误码进 outcomes |
| P2-1…P2-4（r20 遗留） | 仍在 | `ledger.ts`、`sweep.ts`、`run-close.ts`、`wait.ts`、`recovery.ts` 在 `4e751de..4ecff7a` 内逐字未动，行为维持 r20/r21 记录 |

## 2. 本轮修改质量（三条修复逐条复核 × 回归面）

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| P2-5(a) 非成功终态结算档 | 已闭合，但集合过界见 P2-7 | `failedPreds` 档把后置收成 `failed`（M-48、`dispatch.failed` 事件、`RESOLUTION_NOT_AVAILABLE`），run 可收口（探针 S1）。但 `BLOCKED_TERMINAL`（`dispatcher.ts:108`）把非终态 `indeterminate_side_effect` 一并列入，属修复过界，见 P2-7 |
| P2-5(b) 有效行判定 | 已闭合 | `effectiveStatus` 按 `attempt DESC, seq DESC` 取最大 attempt 行（`attempt` 列是 INTEGER，`001_init.sql:49`），与 M-60 换行语义（`apply-report.ts:265` `attempt+1`）对齐；探针 S2 确认放行 |
| P2-6 typecheck | 已闭合 | `GATE_SPECS.G4!` 非空断言消除 11 处 TS18048/TS2532；`tsc --noEmit` 退出 0、零诊断；`full-suite.md` 重测数字（78 files、1023 passed、345.32 kB / gzip 82.85 kB）与本轮实测逐项一致 |
| P3-1 结算进 outcomes | 已闭合 | 两处防御档（missing/failed preds）都经 `outcomeForSettlement` 落进返回数组，调用方可直接观察结算结果与 `retryDirective` |
| 新用例（`workflow-g4.spec.ts:541-601`） | 覆盖目标达成，一处断言偏弱见 P3-2 | 场景一锁了结算、事件码与 run 收口；场景二只断言 `not.toBe('queued')`，区分不了「放行执行」与「被前置结算」 |
| 调度公平性 | 符合预期，无需修改 | 结算在 `seq ASC` 循环内就地完成，不插队；就绪节点仍按序派发；`seq ASC` 次序未变 |
| wait / 子流程 / 补偿 / 收口 | 符合预期，无需修改 | 相应文件零改动；`wait.spec.ts`、`subworkflow.spec.ts`、`compensation.spec.ts`、`sweep.spec.ts`、`control-dispatch.spec.ts` 实跑绿（十件套 179 例） |
| 无 edges 旧定义派发 | 符合预期，无需修改 | `preds` 为空时全量派发，与 r21 探针 E 口径一致（十件套与全量回归绿） |

## 3. 必过项与不变量的针对性核对

| 不变量 | 核对方式 | 结论 |
| --- | --- | --- |
| §4.1 状态机闭合 | 迁移表零改动；结算走 `applyTransition` CAS（M-48，`from:['queued']`）；`g3-faults`、`state-machine`、`transition-rules` 实跑绿 | 符合 |
| §4.2 代次不混 | dispatcher 改动只读 `status`，不触 `action_generation`/`rearm_generation`；`node-runs` 实跑绿 | 符合 |
| §4.3 时钟与检查点 | `recovery.ts`、`half-state` 相关零改动；`half-state`、`recovery-uncertain`、`recovery-action-checkpoint` 实跑绿。不确定态的清除路径（M-50/M-52/M-60）存在且未被破坏；不确定态与依赖闸的处置缝隙记 P2-7 | 符合（缝隙记 P2-7） |
| §4.5 终态枚举 | `TERMINAL_STATUSES`（`state-machine.ts:18-26`）与 `closeRun`（`run-close.ts:41`）零改动；但 dispatcher 新增的 `BLOCKED_TERMINAL` 是第二处「失败终态」枚举，含非终态与 run 级词表死条目，与单一定义口径不齐，修复建议见 P2-7 | 符合（口径瑕疵记 P2-7） |
| §4.6 断链隔离 | 三处链闸零改动；`chain-guard-entries`、`chain-guard-execution` 实跑绿 | 符合 |
| §4.7 不可逆副作用 | `cancel.ts`、`compensation.ts` 零改动；`compensation.spec.ts` 实跑绿 | 符合 |
| §4.8 对外副作用边界 | `PATCH_COLUMNS` 与恢复接口零改动 | 符合 |

## 4. 探针实测（`tmp/r22-probe`，交付前删除）

五组场景共 11 项观察，全部与预测一致（`node --experimental-strip-types tmp/r22-probe/probe.ts`）：

| 探针 | 场景 | 实测 | 判定 |
| --- | --- | --- | --- |
| S1 | a 收 `failed`，dispatch 后置 | b 收 `failed`、`dispatch.failed`/`RESOLUTION_NOT_AVAILABLE`、run 收口（`failed_with_unverified`，与 raw 置位行的副作用策略默认值有关）；outcomes 含 b 的结算行 | P2-5(a)、P3-1 闭合 |
| S2 | a 经 M-60 换行（旧行 `superseded`、新行 attempt=2 done） | b 被放行走执行桩：outcome `done`、无错误码、无结算事件 | P2-5(b) 闭合 |
| S3 | a 落 `indeterminate_side_effect`（非终态、可经 M-60 重试到 done），dispatch 后置 | b 被提前结算 `failed`/`RESOLUTION_NOT_AVAILABLE`；a 非终态时 run 不收口（结算无助于收口）；M-60 换行 done 后 run 仍收口 `failed_with_unverified` | 见 P2-7（过度结算、业务结果误报） |
| S4 | 对照：a 落 `startup_unknown`（同为可裁决非终态） | b 留 `queued` 等待 | 与 S3 对照出两态处置不一致，佐证 P2-7 是过界而非设计 |
| S5 | 删掉前置行（缺前置防御面） | b 结算 `SCHEMA_VERSION_UNSUPPORTED`，outcomes 含结算行 | P3-1 缺前置档闭合 |

## 5. 可延期问题

| 编号 | 等级 | 位置 | 说明 |
| --- | --- | --- | --- |
| P2-1 | P2 | `src/infra/db/ledger.ts:98`、`src/service/sweep.ts:88-90`、`src/service/commands/run-close.ts:56` | r20 遗留：整链缺失检不出。本轮零改动，维持 |
| P2-2 | P2 | `src/service/commands/recovery.ts:54-63` | r20 遗留：`timing_out_grace` 确认后 `fence_state` 仍 armed。本轮零改动，维持 |
| P2-3 | P2 | `src/service/commands/wait.ts:125-171`、`:289-301` | r20 遗留：断链节点的 wait 让同 run 整笔事件投递回滚。本轮零改动，维持 |
| P2-4 | P2 | `src/service/commands/recovery.ts:64-75` | r20 遗留：断链与不确定标记并存时唯一清除入口被链闸挡住。本轮零改动，维持 |
| P2-7 | P2 | `src/service/dispatcher.ts:108`（`BLOCKED_TERMINAL` 含 `indeterminate_side_effect`）、`:124-139`（归入 `failedPreds` 档） | 本轮新发现，候选引入的行为回归。`indeterminate_side_effect` 是非终态（`state-machine.ts:15`），可经 M-52/M-60 裁决，M-60 换 attempt 后可到 `done`（`apply-report.ts:242-268`）。它被列为「失败前置」后，后置 queued 节点在裁决窗口内的任意一次 `dispatchRun`（生产主入口 `src/index.ts:263-287`）被结算 `failed`，且 `failed` 除 M-55 降级外无重跑出口——前置重试成功后 run 仍收口失败、账本理由「前置节点未成功完成」与事实不符（探针 S3）。对照面：兄弟态 `startup_unknown` 后置正确等待（探针 S4），两态处置不一致；r21 及以前对非成功非终态一律等待，本档是修复 P2-5(a) 时过界引入。定级 P2 依据：触发面窄（不确定态窗口 × edges 拓扑）；失败方向保守（不放行后置、不误报成功，无假成功、无副作用外溢）；有兜底（`cancelRun`、整体重跑）；与 S2 r70 P2-3、S3 r21 P2-5 同缝定级一致。修复建议：`BLOCKED_TERMINAL` 从 `TERMINAL_STATUSES` 派生（非成功终态六个：`failed`、`timeout`、`abandoned_unverified`、`failed_with_unverified`、`orphaned`、`superseded`），顺带清掉 run 级词表死条目（`cancelled`、`succeeded` 系混入 node 级判定）；补用例「a 落 `indeterminate_side_effect` → dispatch → b 仍 queued；裁决换行 done → b 放行」。G4 签发前应修，否则建议阻断 G4（与 r21 对 P2-5 同门槛） |

| 编号 | 等级 | 位置 | 说明 |
| --- | --- | --- | --- |
| P3-2 | P3 | `tests/integration/workflow-g4.spec.ts:592`（`expect(b2.status).not.toBe('queued')`） | 测试缺口：该断言区分不了「放行执行」与「被前置结算」（两者都不是 queued），对 P2-5(b) 的回归防护偏弱——若 `effectiveStatus` 回退而 `failedPreds` 档仍在，用例仍绿。本人探针用执行桩（outcome `done`、无 `RESOLUTION_NOT_AVAILABLE`）区分。建议补断言 outcomes 无 `RESOLUTION_NOT_AVAILABLE` 或 b 经执行桩 `done`。降低了 P2-5(b) 修复的长期回归防护强度，不影响当前生产行为正确性 |

## 6. 测试与质量证据（本人实际执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npx tsc --noEmit`（`pnpm typecheck` 同义） | 0 | 零诊断（r21 的 11 处已消除） |
| `npx vitest run`（全量，无并发负载） | 0 | 78 files，1023 passed、1 skipped |
| `npx vitest run`（全量，与其它重负载命令并发 ×2） | 1 | 1024 例中 1022 passed、1 skipped，另有 1 例时序抖动：`runtime.spec.ts` B06 子进程用例两次并发跑各一次（CPU 争用下起动/写 marker 时序；单跑该文件 25/25 绿、无并发全量绿；候选 diff 未触及该路径，属既有用例的负载敏感性，非本轮回归，用例内注释亦自述此抖动史） |
| `npx vitest run`（G3 十件套） | 0 | 10 files，179 passed（g3-faults、state-machine、sweep、subworkflow、wait、parallel、compensation、apply-report、control-dispatch、workflow-g4） |
| `npx vitest run`（证据面九件） | 0 | 9 files，122 passed（migration-cases、node-runs、half-state、approval、policy-branch、transition-rules、chain-guard-entries、chain-guard-execution、recovery-uncertain） |
| `npx vitest run`（起运行与批准人） | 0 | 2 files，15 passed（`tests/unit/start-run.spec.ts`、`tests/unit/approver.spec.ts`） |
| `npx tsdown`（`pnpm build` 同义） | 0 | ESM `lib/index.js` 345.32 kB、gzip 82.85 kB、`index.d.ts` 26.10 kB（与 `full-suite.md` 一致） |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 29 份，重跑两遍与 HEAD 字节一致（含 G3/G4 注入摘要） |
| 自写探针（`tmp/r22-probe`，5 组 11 项，交付前删除） | 0 | 见 §4 |

## 7. 二十项必过项

| 必过项 | 证据 | 判定 |
| --- | --- | --- |
| G3-01 / G3-02 | ev-g3-01 / ev-g3-02；`migration-cases`、`node-runs`、`transition-rules` 实跑 | pass |
| G3-03 / G3-04 / G3-05 | ev-g3-03 / ev-g3-04 / ev-g3-05；`half-state`、`approval`、`policy-branch` 实跑 | pass |
| G3-06 / G3-07 | ev-g3-06 / ev-g3-07；`parallel`、`wait` 实跑 | pass |
| G3-08 / G3-09 | ev-g3-08 / ev-g3-09；`subworkflow`、`compensation` 实跑 | pass |
| G3-10 / G3-11 | ev-g3-10 / ev-g3-11；`apply-report`、`sweep` 实跑 | pass |
| G-01 / G-02 / G-04 | 六条注入里的三条；`check-evidence-repro` 29/29 字节复现 | pass |
| G-06 / G-12 / G-16 | 六条注入里的另外三条；`check-evidence-repro` 29/29 字节复现 | pass |
| G3-12 / G3-13 | ev-g3-12 / ev-g3-13；`start-run`、`approver` 实跑 15 例 | pass |
| G3-14 | ev-g3-14；全量 78 files（1023 passed、1 skipped）、typecheck 归零与 build 实测绿 | pass |

## 8. 自检

`node --experimental-strip-types` 实跑 `src/core/audit-verdict.ts` 与 `scripts/gate-check.ts` 的四个函数：

| 函数 | 结果 |
| --- | --- |
| `parseAuditVerdict` | 解析出唯一裁决块，字段齐全 |
| `verdictProblems` | 返回空数组 |
| `auditConclusionOf` | 得 `pass` |
| `proseVerdictClashes` | 返回空数组 |

## 9. 阶段性结论

结论：pass

依据：r21 三条问题（P2-5 两面、P2-6、P3-1）逐条读码与探针复现确认闭合，typecheck 归零后 G3 证据口径重新对齐；dispatcher 改动沿 wait/子流程/补偿/收口/调度次序逐条回归，无 edges 路径行为不变，20 项必过全过，全量 1023 例、build 与证据 29/29 字节复现均绿。新记 P2-7（`BLOCKED_TERMINAL` 误列 `indeterminate_side_effect`，后置在裁决窗口被提前结算，前置经 M-60 重试成功后 run 仍收出负向终态，探针 S3/S4 复现）与 P3-2（新用例场景二断言偏弱）；P2-7 属候选引入的行为回归，按 r21 对 P2-5 的同级门槛建议 G4 签发前修复。r20 遗留 P2-1…P2-4 零改动维持。**可靠性收敛阶段通过，可以进入下一阶段开发。**
