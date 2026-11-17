# S3 独立审计报告 · G3 第 23 轮（delta 快审）

门：G3
候选提交：32517a5287df6221d3f9024efa4adc074efea8d3
审计日期：2026-11-17
审计方式：独立只读审计；未签门、未改生产代码、未改测试与证据、未改门记录；临时探针只放 `tmp/r23-probe`，交付前删除

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 23,
  "candidate_commit": "32517a5287df6221d3f9024efa4adc074efea8d3",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
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
  "notes": "r22 两条问题逐条闭合并实测复现。P2-7：BLOCKED_TERMINAL 改由 TERMINAL_STATUSES 派生（非成功终态六个：failed/timeout/abandoned_unverified/failed_with_unverified/orphaned/superseded），探针 S1 裁决窗口 b 留 queued、run 仍 running、执行桩未被叫到，S2 M-60 换行 done 后 b 放行执行（outcome done、无 RESOLUTION_NOT_AVAILABLE），S3 十二个非终态逐一等待、S4 六个非成功终态逐一结算、S5 成功前置放行；与旧行为的可达差集仅 indeterminate_side_effect（cancelled 属 node 级死条目，生产无写入点，grep 证实），无过修。P3-2：场景二补事件 error_code 断言，探针 T1/T2 实证该断言在放行侧为真、结算侧为假，能区分放行与结算。20 项必过全过：全量 78 files / 1023 passed、1 skipped，typecheck 0，build 345.22 kB，证据 29/29 字节复现。新记 P3-3（场景三收尾断言与 P3-2 同型偏弱，核心回归已被该场景中段断言锁住）与 P3-4（G4 证据 build 尺寸陈述 345.32 kB 需在签发时随新候选重测刷新，check-evidence-repro 不覆盖该散文数字）。r20 遗留 P2-1…P2-4 相应文件零改动，维持。"
}
```
<!-- audit-verdict:end -->

## 1. 本轮审计基准

| 项 | 值 |
| --- | --- |
| 主线与本地 HEAD | 审计全程 HEAD = `32517a5`（即候选），工作区干净（`tmp/` 在 .gitignore，仅本人探针）；同机有他人在途会话，未触碰 |
| 本轮候选 | `32517a5287df6221d3f9024efa4adc074efea8d3` |
| 上一轮报告 | `docs/audits/S3-independent-audit-round22.md`（r22，候选 `4ecff7a`） |
| diff 范围 | `4ecff7a..32517a5` 共 8 个文件：生产/测试仅 `src/service/dispatcher.ts`、`tests/integration/workflow-g4.spec.ts`；另有 `docs/audits/`（S3 r22 报告入库、S1 r70、S2 r71、S4 r1/r2）与 `docs/gates/G4.md`，均在门排除范围 |
| 本轮重点 | delta 快审：逐条验证 r22 的 P2-7、P3-2 是否闭合；回归 dispatcher 改动对 G3 的 wait/子流程/补偿/收口/调度次序有无新影响 |
| 与 G3 面相关的生产改动 | 仅 `dispatcher.ts` 两处常量：`BLOCKED_TERMINAL` 改为 `TERMINAL_STATUSES.filter(s => !SUCCESS_STATUS.has(s))` 派生（`dispatcher.ts:110`），补 `TERMINAL_STATUSES` 导入；`SUCCESS_STATUS` 成员不变。`wait.ts`、`recovery.ts`、`sweep.ts`、`run-close.ts`、`ledger.ts`、`compensation.ts`、`apply-report.ts`、`cancel.ts`、`nodes.ts`、`state-machine.ts` 本轮 diff 零改动 |
| 必读文档 | `审计要求.md`、`scripts/gate-check.ts` 的 `GATE_SPECS.G3`、`src/core/state-machine.ts`、`docs/audits/S3-independent-audit-round22.md` |
| 未能确认的范围 | 无（仓库、测试、构建与证据复现环境均可用） |
| 工作区观测 | 审计全程未使用 `git add/commit/checkout/stash`；临时探针只写 `tmp/r23-probe`，交付前删除 |

上一轮问题状态（逐条核对，不默认维持）：

| 编号 | 状态 | 依据 |
| --- | --- | --- |
| P2-7 `BLOCKED_TERMINAL` 误含 `indeterminate_side_effect` | 已修复并验证 | `dispatcher.ts:108-110` 派生式定义；探针 S1（裁决窗口 b 留 queued、run 仍 running、无结算事件）、S2（M-60 换行 done 后 b 放行执行）、S3/S4/S5（十二非终态全等、六非成功终态全结算、成功放行）；回归用例场景三（`workflow-g4.spec.ts:593-612`）锁住窗口与放行 |
| P3-2 场景二断言区分不了放行与结算 | 已修复并验证 | `workflow-g4.spec.ts:614-621` 补「末事件 error_code 不是 RESOLUTION_NOT_AVAILABLE」断言；探针 T1（放行侧断言为真）/T2（结算侧断言为假）实证分辨力 |
| P2-1…P2-4（r20 遗留） | 仍在 | `ledger.ts`、`sweep.ts`、`run-close.ts`、`wait.ts`、`recovery.ts` 在本轮 diff 内逐字未动，行为维持 r20/r21/r22 记录 |

## 2. 本轮修改质量（两条修复逐条复核 × 回归面）

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| P2-7 `BLOCKED_TERMINAL` 派生化 | 已闭合 | 集合 = `TERMINAL_STATUSES`（`state-machine.ts:18-26`）减 `SUCCESS_STATUS` = 六个非成功终态，探针 S4-0 枚举比对逐字一致；`indeterminate_side_effect`（`state-machine.ts:15` 非终态）回到等待档，裁决窗口内后置不再被结算（S1），M-52/M-60 裁决换行后照常放行（S2）。与旧行为的可达差集仅此一态：旧集里的 `cancelled` 是 node 级死条目（生产代码无 `node_runs.status='cancelled'` 写入点，grep 全仓证实；状态机 20 态无此项），六个其余成员逐一仍结算（S4），无过修、无欠修 |
| P3-2 场景二断言收紧 | 已闭合 | 新断言读 b 末事件 `payload.error_code`，放行路径实测为 `EVIDENCE_SOURCE_UNAVAILABLE`（或执行桩 `done` 无结算码）、结算路径为 `RESOLUTION_NOT_AVAILABLE`，断言表达式对前者为真、对后者为假（探针 T1/T2），区分目标达成 |
| 新场景三（`workflow-g4.spec.ts:593-612`） | 覆盖目标达成，收尾断言偏弱见 P3-3 | 中段断言把 P2-7 的核心语义锁死：裁决窗口 b 留 `queued` 且 run 留 `running`；换行后的放行由场景二的新断言兜底分辨 |
| 调度公平性 | 符合预期，无需修改 | `dispatchRun` 的 `seq ASC` 循环、结算就地完成不插队、`rows` 同批派发等逻辑零改动 |
| wait / 子流程 / 补偿 / 收口 | 符合预期，无需修改 | 相应文件零改动；十件套实跑绿（179 例，含 wait、subworkflow、compensation、sweep、control-dispatch、workflow-g4） |
| 无 edges 旧定义派发 | 符合预期，无需修改 | `preds` 为空时全量派发路径零改动（十件套与全量回归绿） |

## 3. 必过项与不变量的针对性核对

| 不变量 | 核对方式 | 结论 |
| --- | --- | --- |
| §4.1 状态机闭合 | 迁移表零改动；结算仍走 `applyTransition` CAS（M-48，`from:['queued']`，`dispatcher.ts:310-320`）；`g3-faults`、`state-machine`、`transition-rules` 实跑绿 | 符合 |
| §4.2 代次不混 | dispatcher 改动只读 `status`，不触 `action_generation`/`rearm_generation`；`node-runs` 实跑绿 | 符合 |
| §4.3 时钟与检查点 | `recovery.ts`、`half-state` 相关零改动；`half-state`、`recovery-uncertain`、`recovery-action-checkpoint` 实跑绿。不确定态清除路径（M-50/M-52/M-60）与依赖闸的处置缝隙由 P2-7 闭合消除：裁决窗口后置等待、换行后放行（S1/S2） | 符合 |
| §4.5 终态枚举 | `TERMINAL_STATUSES` 与 `closeRun`（`run-close.ts:41`）零改动；`BLOCKED_TERMINAL` 不再是第二处独立词表，从状态机终态表派生，r22 记的「两处枚举口径不齐」随修复消除 | 符合 |
| §4.6 断链隔离 | 三处链闸零改动；`chain-guard-entries`、`chain-guard-execution` 实跑绿 | 符合 |
| §4.7 不可逆副作用 | `cancel.ts`、`compensation.ts` 零改动；`compensation.spec.ts` 实跑绿 | 符合 |
| §4.8 对外副作用边界 | `PATCH_COLUMNS` 与恢复接口零改动 | 符合 |

## 4. 探针实测（`tmp/r23-probe`，交付前删除）

两组共 34 项观察，全部与预测一致（`node --experimental-strip-types tmp/r23-probe/probe.ts`）：

| 探针 | 场景 | 实测 | 判定 |
| --- | --- | --- | --- |
| S1 | a 落 `indeterminate_side_effect`，dispatch 后置 | b 留 `queued`、零事件、执行桩未被叫到、run 留 `running` | P2-7 窗口语义闭合 |
| S2 | 接 S1：M-60 换行（旧行 `superseded`、新行 attempt=2 done） | b 被放行：执行桩跑到、outcome `done`、无 `RESOLUTION_NOT_AVAILABLE` | P2-7 放行语义闭合 |
| S3 | 枚举 12 个非终态逐一作前置 | 全部等待：b 留 `queued`、零事件、桩未叫到（含 `startup_unknown`、`indeterminate_side_effect`） | 非终态处置一致，无第二处过界 |
| S4 | 枚举派生的 6 个非成功终态逐一作前置 | 全部结算：b `failed`、`dispatch.failed`/`RESOLUTION_NOT_AVAILABLE`、outcome `settlement:'applied'`、桩未叫到；S4-0 派生集与预期六态逐字一致 | 无过修到无限等 |
| S5 | a `done` | b 放行执行桩、outcome `done` | 成功路径不受影响 |
| T1 | 放行侧（无执行器装配口径，与新用例一致） | 末事件码 `EVIDENCE_SOURCE_UNAVAILABLE`；新断言表达式实算为真 | P3-2 断言放行侧成立 |
| T2 | 结算侧（前置 `failed`） | 末事件码 `RESOLUTION_NOT_AVAILABLE`；新断言表达式实算为假 | P3-2 断言能区分两侧 |
| T3 | 收尾断言分辨力观察 | 放行侧与结算侧的 b 状态同为 `failed`，`not.toBe('queued')` 对两者都为真 | 记 P3-3（分辨依赖事件码断言，场景二已补、场景三收尾未补） |

## 5. 可延期问题

| 编号 | 等级 | 位置 | 说明 |
| --- | --- | --- | --- |
| P2-1 | P2 | `src/infra/db/ledger.ts:98`、`src/service/sweep.ts:88-90`、`src/service/commands/run-close.ts:56` | r20 遗留：整链缺失检不出。本轮零改动，维持 |
| P2-2 | P2 | `src/service/commands/recovery.ts:54-63` | r20 遗留：`timing_out_grace` 确认后 `fence_state` 仍 armed。本轮零改动，维持 |
| P2-3 | P2 | `src/service/commands/wait.ts:125-171`、`:289-301` | r20 遗留：断链节点的 wait 让同 run 整笔事件投递回滚。本轮零改动，维持 |
| P2-4 | P2 | `src/service/commands/recovery.ts:64-75` | r20 遗留：断链与不确定标记并存时唯一清除入口被链闸挡住。本轮零改动，维持 |

| 编号 | 等级 | 位置 | 说明 |
| --- | --- | --- | --- |
| P3-3 | P3 | `tests/integration/workflow-g4.spec.ts:612`（场景三收尾 `expect(b3.status).not.toBe('queued')`） | 测试缺口（与 P3-2 同型）：放行侧（本测试口径下收 `EVIDENCE_SOURCE_UNAVAILABLE` 的 `failed`）与被前置结算（`RESOLUTION_NOT_AVAILABLE` 的 `failed`）都满足该断言，探针 T3 实测两者状态同为 `failed`。风险有限：P2-7 的核心回归（`BLOCKED_TERMINAL` 再度过界）已被场景三中段断言（b 留 `queued` + run 留 `running`）锁死，`effectiveStatus` 回退已被场景二的新事件码断言锁死；建议后续给场景三收尾补同款事件码断言。不影响当前生产行为正确性 |
| P3-4 | P3 | `docs/gates/evidence/G4/full-suite.md:5`（build 尺寸陈述） | 证据刷新账：该行记录 345.32 kB / gzip 82.85 kB（`4ecff7a` 时点实测），本候选实测 345.22 kB / gzip 82.84 kB（`dispatcher.ts` 集合派生化缩小字节，方向与改动一致）；`check-evidence-repro` 的 29/29 字节复现不覆盖该散文数字。G4 门未签，签发时随新候选重测刷新即可，不构成阻断 |

## 6. 测试与质量证据（本人实际执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck`（`tsc --noEmit`） | 0 | 零诊断 |
| `npx vitest run`（全量） | 0 | 78 files，1023 passed、1 skipped |
| `npx vitest run`（G3 十件套，含 workflow-g4） | 0 | 10 files，179 passed（g3-faults、state-machine、sweep、subworkflow、wait、parallel、compensation、apply-report、control-dispatch、workflow-g4） |
| `npx vitest run`（证据面九件） | 0 | 9 files，122 passed（migration-cases、node-runs、half-state、approval、policy-branch、transition-rules、chain-guard-entries、chain-guard-execution、recovery-uncertain） |
| `npx vitest run`（起运行与批准人） | 0 | 2 files，15 passed（`tests/unit/start-run.spec.ts`、`tests/unit/approver.spec.ts`） |
| `npx tsdown`（`pnpm build` 同义） | 0 | ESM `lib/index.js` 345.22 kB、gzip 82.84 kB、`index.d.ts` 26.10 kB（与 G4 证据陈述的尺寸差异见 P3-4） |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 29 份，重跑两遍与 HEAD 字节一致（含 G3/G4 注入摘要） |
| 自写探针（`tmp/r23-probe`，34 项，交付前删除） | 0 | 见 §4 |

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

`node --experimental-strip-types` 实跑 `src/core/audit-verdict.ts` 与 `scripts/gate-check.ts` 的四个函数（对本报告全文，ctx：G3 / 23 / 20 项规格清单）：

| 函数 | 结果 |
| --- | --- |
| `parseAuditVerdict` | 解析出唯一裁决块，字段齐全 |
| `verdictProblems` | 返回空数组 |
| `auditConclusionOf` | 得 `pass` |
| `proseVerdictClashes` | 返回空数组 |

## 9. 阶段性结论

结论：pass

依据：r22 两条问题（P2-7、P3-2）逐条读码与探针复现确认闭合——`BLOCKED_TERMINAL` 派生自状态机后，裁决窗口后置等待、换行后放行，行为差集仅 `indeterminate_side_effect` 一态且无过修（34 项探针观察全中）；场景二断言经 T1/T2 实证可区分放行与结算。dispatcher 改动沿 wait/子流程/补偿/收口/调度次序逐条回归零改动，十件套 179 例、全量 1023 例、typecheck、build 与证据 29/29 字节复现均绿，20 项必过全过。新记 P3-3（场景三收尾断言偏弱）与 P3-4（G4 证据 build 尺寸待签发时刷新），均不阻断。r20 遗留 P2-1…P2-4 零改动维持。**可靠性收敛阶段通过，可以进入下一阶段开发。**
