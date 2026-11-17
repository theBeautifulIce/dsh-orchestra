# S3 独立审计报告 · G3 第 21 轮

门：G3
候选提交：4e751de6cf8fb681e7b7c4f40061400cabab0408
审计日期：2026-11-17
审计方式：独立只读审计；未签门、未改生产代码、未改测试与证据、未改门记录；临时探针只放 `tmp/`，交付前删除

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 21,
  "candidate_commit": "4e751de6cf8fb681e7b7c4f40061400cabab0408",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 6,
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
  "notes": "S4 共享路径对 G3 面逐条交叉回归：无 edges 定义的派发行为不变，20 项必过全过。r20 四条 P2 相应文件本轮零改动，维持原状。新增 P2-5（readinessOf 前置判定缺口，与 S2 r70 P2-3 同根因，G4 签发前必修）与 P2-6（typecheck 11 处 TS 诊断，G4 注册用例引入）。探针 10 组场景、证据 29/29 字节复现、全量 1022 passed、build 绿。"
}
```
<!-- audit-verdict:end -->

## 1. 本轮审计基准

| 项 | 值 |
| --- | --- |
| 主线与本地 HEAD | 审计开始时 HEAD = `4e751de`；复核期间 HEAD 未前进。本报告只绑定 `4e751de` |
| 本轮候选 | `4e751de6cf8fb681e7b7c4f40061400cabab0408` |
| 上一轮报告 | `docs/audits/S3-independent-audit-round20.md`（r20，候选 `fd2173b`） |
| diff 范围 | `fd2173b..4e751de`，39 个文件、+4257/−97，主体为 S4 流程定义与版本批次 |
| 本轮重点 | 交叉回归：S4 对 dispatcher、runs.ts、subworkflow、idempotency 的改动是否波及 G3 的等待、收口、子流程、补偿与调度 |
| 与 G3 面相关的生产改动 | `src/service/dispatcher.ts`（+51，依赖放行与缺前置防御面）、`src/service/runs.ts`（+101/−7，nodeIds 依赖闭包、预留任务绑定、task_local 闸）、`src/service/commands/subworkflow.ts`（+3，归属闸）、`src/service/commands/start-run.ts`（+3，taskId 透传）、`src/service/commands/idempotency.ts`（新增）、`src/index.ts`（装配层） |
| G3 零改动文件 | `wait.ts`、`recovery.ts`、`sweep.ts`、`run-close.ts`、`ledger.ts`、`compensation.ts`、`apply-report.ts`、`cancel.ts` 在本轮 diff 内逐字未动 |
| 必读文档 | `审计要求.md`、`scripts/gate-check.ts` 的 `GATE_SPECS.G3`、`src/core/state-machine.ts`、`GLOSSARY.md`、`docs/requirements.md`、`docs/design-notes.md` |
| 未能确认的范围 | 无（仓库、测试、构建与证据复现环境均可用） |
| 工作区观测 | 审计全程未使用 `git add/commit/checkout/stash`；同工作树另有他人在途改动（`docs/gates/G4.md`、`docs/audits/S4-independent-audit-round1.md`），未触碰 |

上一轮问题状态（逐条核对，不默认维持）：

| 编号 | 状态 | 依据 |
| --- | --- | --- |
| P2-1 整链缺失检不出 | 仍在 | `ledger.ts`、`sweep.ts:88-90`、`run-close.ts:56` 本轮 diff 零改动，行为维持 r20 记录 |
| P2-2 fence_state 残留 | 仍在 | `recovery.ts:54-63` 本轮 diff 零改动 |
| P2-3 断链 wait 按 run 回滚 | 仍在 | `wait.ts:125-171`、`:289-301` 本轮 diff 零改动 |
| P2-4 断链与不确定标记并存时清不掉 | 仍在 | `recovery.ts:64-75` 本轮 diff 零改动 |

## 2. 本轮修改质量（S4 共享路径 × G3 面）

| 改动 | 判断 | 说明 |
| --- | --- | --- |
| `dispatcher.ts` 依赖放行（`readinessOf`/`missingPreds`） | 有一处缺口，见 P2-5 | 无 edges 的定义 `preds` 为空，全量派发与旧行为一致（探针 E、178 例实跑）；trigger 边在 `runtimeProjection` 裁掉，不会等不存在的节点。缺前置防御面把后置收成 `failed` 并留 `dispatch.failed` 事件，run 正常收口（探针 D，两个 G4 用例复核通过）。前置判定的两处缺口合并记 P2-5 |
| `runs.ts` nodeIds 依赖闭包 | 符合预期，无需修改 | 沿边走 wanted 集的传递闭包，缺前置在建 run 前以 `PAYLOAD_SCHEMA_INVALID` 拒绝并列出缺谁（探针 F，G4 用例 `workflow-g4.spec.ts:444` 复核通过） |
| `runs.ts` 预留任务绑定 | 符合预期，无需修改 | 带 `taskId` 时对 `tasks` 做 CAS（`status='reserved'` 且 `current_run_id IS NULL`），一次消费；不带 `taskId` 走原 INSERT 路径，G3-12 口径不变 |
| `subworkflow.ts` 归属闸（`assertWorkflowUsable`） | 符合预期，无需修改 | reusable 无操作；task_local 按父 run 的 `task_id` 做归属比对，不匹配即拒。pin 版本、深度与环检测、父取消向子 run 传播的逻辑未动，`subworkflow.spec.ts` 实跑绿 |
| `idempotency.ts`（`runIdempotentCommand`） | 符合预期，无需修改 | 只服务 workflow 四命令与 `reserveTask`；起运行的 operation_id 幂等仍走 `start_run_operations`（`start-run.spec.ts` 实跑绿），两条通道分表分键 |
| 调度公平性 | 符合预期，无需修改 | `seq ASC` 次序未变；依赖闸只把未就绪节点留在原地，就绪节点仍按序派发；缺前置节点逐个就地收口，不插队 |
| 补偿与等待路径 | 符合预期，无需修改 | `compensation.ts`、`wait.ts`、`run-close.ts` 本轮零改动，`compensation.spec.ts`、`wait.spec.ts` 实跑绿 |

## 3. 必过项与不变量的针对性核对

| 不变量 | 核对方式 | 结论 |
| --- | --- | --- |
| §4.1 状态机闭合 | 迁移表本轮未改；`g3-faults`、`state-machine`、`transition-rules` 实跑绿 | 符合 |
| §4.2 代次不混 | dispatcher 改动不触代次判定；`node-runs`、`chain-guard` 实跑绿 | 符合 |
| §4.3 时钟与检查点 | `half-state`、`recovery-action-checkpoint` 所在批次实跑绿；`recovery.ts` 未动 | 符合 |
| §4.5 终态枚举 | `TERMINAL_STATUSES` 未动；`closeRun` 未动 | 符合 |
| §4.6 断链隔离 | 三处链闸未动；`chain-guard-entries`、`chain-guard-execution`、`sweep` 实跑绿 | 符合 |
| §4.7 不可逆副作用 | `cancel.ts`、`compensation.ts` 未动；`compensation.spec.ts` 实跑绿 | 符合 |
| §4.8 对外副作用边界 | `PATCH_COLUMNS` 与恢复接口未动 | 符合 |

## 4. 探针实测（`tmp/r21-probe`，交付前已删）

| 探针 | 场景 | 实测 | 判定 |
| --- | --- | --- | --- |
| S1 | a 在途（started），b 等待 | b 本轮零派发、停在 queued | 符合预期 |
| S2 | a 落 done | b 进入本轮派发 | 符合预期 |
| S3 | a、b 均 done（纯副作用口径） | run 收 `succeeded` | 符合预期 |
| A2 | `t→a` 的 trigger 边 | a 无前置直接放行，不等 trigger 行 | 符合预期 |
| B | 前置收 `failed` 终态 | 后置停在 queued，run 停在 running（复核 S2 r70 P2-3） | 见 P2-5 |
| C/G | 前置经 M-60 换 attempt（旧行 `superseded`、新行 done） | `.get()` 读到旧行，后置永滞 queued、run 无法收口 | 见 P2-5 |
| D | 删掉前置行（缺前置防御面） | 后置收 `failed`、留 `dispatch.failed`、run 收口 | 符合预期 |
| E | 无 edges 旧定义（`catalog.load` 老口径） | 一轮全派 2 个节点 | 符合预期 |
| F | `nodeIds:['b']` 缺前置 | 建 run 前拒 `PAYLOAD_SCHEMA_INVALID` | 符合预期 |
| 全量 | `npx vitest run` | 78 files，1022 passed、1 skipped | 符合预期 |

## 5. 可延期问题

| 编号 | 等级 | 位置 | 说明 |
| --- | --- | --- | --- |
| P2-1 | P2 | `src/infra/db/ledger.ts:98`、`src/service/sweep.ts:88-90`、`src/service/commands/run-close.ts:56` | r20 遗留：整链缺失检不出，链被整条删或尾截断时链体自洽，三处闸门都放行。本轮零改动，维持 |
| P2-2 | P2 | `src/service/commands/recovery.ts:54-63` | r20 遗留：`timing_out_grace` 确认后 `fence_state` 仍 armed。本轮零改动，维持 |
| P2-3 | P2 | `src/service/commands/wait.ts:125-171`、`:289-301` | r20 遗留：断链节点的 wait 让同 run 整笔事件投递回滚。本轮零改动，维持 |
| P2-4 | P2 | `src/service/commands/recovery.ts:64-75` | r20 遗留：断链与不确定标记并存时唯一清除入口被链闸挡住。本轮零改动，维持 |
| P2-5 | P2 | `src/service/dispatcher.ts:108-118`（单行读取在 `:112`） | 本轮新发现（含 S2 r70 P2-3 同根因一面）。`readinessOf` 对前置只做单行读取且只认成功词表，两个面：(a) 前置处于非成功终态（如 `failed`、`timeout`）时后置只跳过、不处置，多节点 edges run 滞在 running（探针 B，与 S2 r70 P2-3 同源，仍开）；(b) 前置经 M-60 换 attempt 后（旧行 `superseded`、新行 done）`.get()` 读到旧行，后置永滞 queued、run 无法收口（探针 C/G）。触发面为 S4 edges 拓扑多节点 run，无 edges 路径行为不变；`cancelRun` 兜底。修复：前置按有效行判定（`replacement_node_run_id IS NULL` 或最大 attempt），并对非成功终态前置给出处置（后置收 `failed`/`superseded`），补两条用例。G4 签发前必修；若届时未修，建议阻断 G4 |
| P2-6 | P2 | `tests/gate/gate-check.spec.ts:1737-1759`（0519401 引入） | `pnpm typecheck` 退出码 2，11 处 TS18048/TS2532（`GATE_SPECS.G4.*` 在 `noUncheckedIndexedAccess` 下可空）；生产 `src/` 零诊断、1022 例与 build 全绿。与 S1 r69 P2-1、S2 r70 P2-2 同源。另注：`docs/gates/evidence/G3/full-suite.md` 的验证协议含 `pnpm typecheck` 且记「typecheck exit 0」，该陈述针对其基线运行；候选上同一命令退出码为 2，证据口径与实测不齐。G3 重签前须收口本条：修掉 11 处 TS 报错（判空或非空断言，一行级），或重跑并更新该证据的 typecheck 行 |

| 编号 | 等级 | 位置 | 说明 |
| --- | --- | --- | --- |
| P3-1 | P3 | `src/service/dispatcher.ts:153` | 缺前置防御面把 `failQueuedNode` 的返回值就地丢弃，`dispatchRun` 的 outcomes 不含该节点的收口结果，调用方只能从库与事件侧观察。一行接上 `outcomeForSettlement` 即可 |

## 6. 测试与质量证据（本人实际执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 2 | 11 处 TS 诊断，全部在 `tests/gate/gate-check.spec.ts`（见 P2-6） |
| `npx vitest run`（G3 十件套） | 0 | 10 files，178 passed（g3-faults、state-machine、sweep、subworkflow、wait、parallel、compensation、apply-report、control-dispatch、workflow-g4） |
| `npx vitest run`（证据面九件） | 0 | 9 files，122 passed（migration-cases、node-runs、half-state、approval、policy-branch、transition-rules、chain-guard-entries、chain-guard-execution、recovery-uncertain） |
| `npx vitest run`（起运行与批准人） | 0 | 2 files，15 passed（`start-run.spec.ts`、`approver.spec.ts`） |
| `npx vitest run`（全量） | 0 | 78 files，1022 passed、1 skipped |
| `pnpm build` | 0 | ESM `lib/index.js` 344.38 kB、`index.d.ts` 26.10 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 29 份，重跑两遍与 HEAD 字节一致（含 G3/G4 注入摘要） |
| 自写探针（`tmp/r21-probe`，10 组，交付前删除） | 0 | 见 §4 |

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
| G3-12 / G3-13 | ev-g3-12 / ev-g3-13；`start-run.spec.ts`、`approver.spec.ts` 实跑 15 例 | pass |
| G3-14 | ev-g3-14；全量 78 files（1022 passed、1 skipped）与 `pnpm build` 实测绿；typecheck 口径见 P2-6 | pass |

## 8. 自检

`node --experimental-strip-types` 实跑 `src/core/audit-verdict.ts` 与 `scripts/gate-check.ts` 的四个函数：

| 函数 | 结果 |
| --- | --- |
| `parseAuditVerdict` | 解析出唯一裁决块，字段齐全 |
| `verdictProblems` | 返回空数组 |
| `auditConclusionOf` | 得 `pass` |
| `proseVerdictClashes` | 返回空数组 |

四函数实跑结果：`verdictProblems` 与 `proseVerdictClashes` 的 problems 均为空数组，`parseAuditVerdict` 解析出唯一裁决块，`auditConclusionOf` 得 pass 且与裁决块一致。

## 9. 阶段性结论

结论：pass

依据：S4 对 dispatcher、`runs.ts`、`subworkflow`、idempotency 的改动逐条沿 G3 真实路径核过，无 edges 的派发与收口行为与上轮一致，子流程 pin 与传播、补偿收口、调度次序均未受波及；20 项必过全过，全量 1022 例、build 与证据 29/29 字节复现均绿。r20 四条 P2 相应文件零改动、维持原状，另记 P2-5（前置判定缺口，G4 签发前必修）与 P2-6（typecheck 口径，重签 G3 前收口）。**可靠性收敛阶段通过，可以进入下一阶段开发。**
