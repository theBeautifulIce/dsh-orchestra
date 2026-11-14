# S3 独立审计 · 第 9 轮（df2fc08）

**verdict：fail（源码行为层）**。P0 0 项、P1 1 项、P2 7 项；必过项 20/20；failed_items：P1-1。

候选 `df2fc08`（`fix(service): guard cancelled runs and count self-cancelled children as failures`，main，父 `af3970b`）。审计在 detached 临时 worktree `C:\Users\ASUS\AppData\Local\Temp\dsh-orchestra-audit-r9` 完成，主工作树源码未改；审计结束后临时 worktree 已删除。报告只新增本文件。

## 结论

第 8 轮遗留的 7 项 P2 仍在，候选新增的取消语义在 G3 五场景和父/子 run 收口上成立：wait 唤醒与超时、run 级取消 waiting、取消子流程、失败子流程映射、补偿 settle 均复跑通过；子 run 自取消时父节点落 `failed`，父 run 未被收成 `succeeded`。

但本轮新增探针发现一条 run 级取消的活性缺陷：节点停在 `blocked_pre` 时取消 run，审批卡仍可被批准，节点回到 `queued`；dispatcher 因 `runs.cancel_requested_at` 非空直接 `skipped`，sweep 只收口全节点终态的 run，节点没有自动出口，run 一直停在 `running`；只有人工再对节点发一次节点级取消，才有机会收口。该路径不落在 20 条必过项内，但按门禁 `P0/P1=0` 的口径阻断重签。**P1-1 修复并复验前，重签条件尚未满足。**

## 实测命令与退出码

全部在审计 worktree 执行（`npm_config_verify_deps_before_run=false`）。

| 命令 | 退出码 | 实测结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm test` | 0 | 61 files，854 passed \| 1 skipped（855），10.32s |
| `pnpm build` | 0 | ESM `lib/index.js` 250.77 kB / gzip 60.04 kB；`lib/index.d.ts` 18.07 kB；CJS `lib/client.js` 0.29 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致（仅 G1/G2） |
| `node scripts/gate-check.ts docs/gates/G3.md` | 1 | `审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 4876a98892db4661…` |
| `pnpm vitest run`（wait/subworkflow/cancel/compensation/g3-faults/migration-cases） | 0 | 6 files，128 passed |

`gate-check` 的 exit 1 是预签态：`docs/gates/G3.md:71-74` 四个 GateArtifact 哈希全 0，`:111-113` 仍是 `audit_round=3`、报告指 round3、`audit_report_sha256` 全 0，`:119` 起 20 条 evidence sha 全 0。full-suite 证据记 854 passed \| 1 skipped、250.77/60.04/18.07，与实测一致（G3-14）。

## G3 五场景复验

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 1. wait 唤醒后同操作收口；wait 超时由维护扫描收口 | pass | S1a：dispatch 200 / event 200 / woken 1 / node done / run succeeded；S1b：`wait_timed_out=1` / node timeout / run failed / `runs_closed=[]`。`tests/integration/wait.spec.ts:44`、`:181`、`:212` |
| 2. run 级取消 waiting：撤销登记，迟到事件只落 inbox | pass | S2：cancel 200 / 登记 cancelled / node superseded / run cancelled / 迟到事件 200 / woken 0 / inbox 1。`wait.spec.ts:212`、`cancel.spec.ts:114` |
| 3. 取消子流程：父节点收口，父/子 run 落 cancelled | pass | S3：取消后 `{node superseded, run running, child running}`；子 run 收口后 `{node superseded, run cancelled, child cancelled, subworkflow.finished=0}`。`subworkflow.spec.ts:232`、`:249` |
| 4. 失败子流程映射：父节点 failed，父 run failed | pass | S4：子 wait 超时→child failed→父节点 failed→父 run failed。`subworkflow.spec.ts:204` |
| 5. 补偿 settle 收口 | pass | S5a：settle applied 后 run running→`failed_with_unverified`；S5b：node+run 均 `failed_with_unverified`。`compensation.spec.ts:76`、`:99` |

新增取消语义的附加复验：

- **queued/leased 不可逆节点**：S6 预置非空租约后分别取消，均 HTTP 200、`next_status=superseded`、`lease_id`/`lease_expires_at` 清空、`cancel_before_dispatch` 事件 1。对应 `tests/integration/cancel.spec.ts:31`。
- **dispatcher 二次检查**：S7 预置 `runs.cancel_requested_at` + queued 节点，dispatch 返回 `skipped/run_cancelled`，agent 调用 0，节点保持 queued。对应 `src/service/dispatcher.ts:80-85`。
- **子 run 自取消、父未取消**：S3b 子 run cancelled，父节点 failed，父 run failed（二次 sweep 仍 failed），事件 `parent_status=failed`，未收成 succeeded。对应 `tests/integration/subworkflow.spec.ts:218`。
- **M-64/M-65 可达**：`src/core/state-machine.ts:167-168` 有 `waiting→failed control-failed` 与 `waiting→superseded control-cancelled`，`:276` 迁移清单含 M-61…M-65；`tests/integration/migration-cases.spec.ts:26` 的 68 条用例通过。

## P1

| 编号 | 问题 | 位置 | 复现 |
| --- | --- | --- | --- |
| P1-1 | run 级取消发生在节点 `blocked_pre` 时，审批仍可批准并把节点放回 `queued`；dispatcher 因取消位非空直接 skipped，sweep 只收口全节点终态的 run，节点没有自动出口，run 长时间停在 `running`；只有人工再发一次节点级取消才有机会收口。取消返回 200，审批也返回 200，使用者看不到失败。 | `src/service/commands/subworkflow.ts:482`（传播状态集不含 `blocked_pre`）；`src/service/commands/nodes.ts:361`（批准回 queued）；`src/service/dispatcher.ts:83-84`（skipped，不推进节点）；`src/service/commands/run-close.ts:39`（要求全节点终态）；`src/service/sweep.ts:350`（只扫 running run，无 queued 清道夫）；`src/index.ts:159`（批准后 resume 的装配点）；`src/service/commands/decisions.ts:155`（resolveDecision 未看 run 取消位） | 见下方 S8b：生产 HTTP `/v1/runs/cancel` → `/v1/decisions/resolve` → `/v1/runs/dispatch` → `sweepNow`，终点 `{node:"queued", run:"running"}` |

影响：取消本应让 run 收口；该路径让 run 停在 `running` 且节点停在 `queued`，没有待决审批卡可再推进，也没有扫尾路径能清掉。触发条件不算苛刻：run 在前置审批期间被取消，随后同一张审批卡被批准（另一名批准人、旧页面、批量操作都可能发生）。

修复建议：`propagateRunCancellation` 把尚未执行的 `blocked_pre` 一并作废（与 queued/leased 同理，动作尚未发生），或在 `resumeFromBlockedPre`/`resolveDecision` 发现 `runs.cancel_requested_at` 非空时按取消收口并关闭阻塞卡；无论走哪条，都要保证取消后 run 能到终态。修后补一条用例：blocked_pre → 取消 run → 批准 → run cancelled，节点 superseded。

对照 `af3970b`：同一夹具在父提交上 dispatch 会执行节点，因 fake agent 没有步骤落到 `blocked_post`，run 同样停在 running；差别是父提交还留着一张可裁决的卡，候选的 `skipped` 路径把最后出口也去掉了。该对照不影响 P1-1 的结论，只说明取消与前置审批的交互此前就缺少收口用例。

S8b 复现片段（放在 worktree 的 `tmp/`，用生产 service 与 HTTP 入口）：

```js
const r = await newRun('wf_agent', 'blocked cancel e2e'); const runId = r.json.data.run_id
const n = row('SELECT node_run_id, attempt FROM node_runs WHERE run_id=?', runId)
withTx(db, (tx) => {
  tx.run("UPDATE node_runs SET status='blocked_pre', blocked_decision_id='dec_s8b', lease_id=NULL, lease_expires_at=NULL WHERE node_run_id=?", [n.node_run_id])
  tx.run("INSERT INTO decisions (decision_id, run_id, node_run_id, kind, status, revision, payload_json, approver, created_at) VALUES ('dec_s8b', ?, ?, 'pre_execution', 'pending', 1, '{}', 'human', ?)", [runId, n.node_run_id, NOW])
})
const c = await post('/v1/runs/cancel', { runId, cancelResult: 'interrupted', graceMs: 5000 })
const a = await post('/v1/decisions/resolve', { decisionId: 'dec_s8b', revision: 1, resolution: 'approved', actor: { kind: 'human', id: 'u1' } })
const d = await post('/v1/runs/dispatch', { runId, nodes: { a: { tools: [] } } })
sweepNow(service.orchestra.runtime, realNow())
// 实测：c=200, a=200, afterCancel={node:"blocked_pre",run:"running"},
// afterApprove={node:"queued",run:"running"}, d={status:"skipped",reason:"run_cancelled"},
// final={node:"queued",run:"running"}
```

## P2

| 编号 | 问题 | 位置 | 复现 |
| --- | --- | --- | --- |
| P2-1 | G3.md 正文、G3-01 表格与 I1 仍写 `M-01…M-62`，实际迁移表已 65 条（M-63/64/65）；full-suite 已写 M-01…M-65，门记录与证据口径不一致 | `docs/gates/G3.md:11`、`:21`、`:55`、`:144`；`src/core/state-machine.ts:165-168`、`:269-276` | `rg -n "M-01…M-62\|M-01 到 M-62" docs/gates/G3.md` |
| P2-2 | G3 注入证据未进 `check-evidence-repro`；G-06/G-12/G-16 被 fault-inject 归到 G1，产出原始账本 dump，与 G3 叙事证据不同字节；full-suite 是人工记录，均不在 25 份字节复现内 | `scripts/check-evidence-repro.ts:12-15`；`scripts/fault-inject.ts:1510`；`docs/gates/evidence/G3/*.md` | `node --no-warnings scripts/check-evidence-repro.ts` 输出 25 份，无 G3；`node --experimental-strip-types --no-warnings scripts/fault-inject.ts --case G-16 --out tmp/g3-repro` 写 `tmp/g3-repro/G1/G-16.md` |
| P2-3 | G3.md 仍预签：`audit_round=3`、报告指 round3、五个 GateArtifact 哈希全 0、20 条 evidence sha 全 0；gate-check 以审计报告 sha 不符 exit 1 | `docs/gates/G3.md:71-74`、`:111-113`、`:119-138` | `node scripts/gate-check.ts docs/gates/G3.md`；exit 1 |
| P2-4 | `BRIDGE_BOUND` 含 `waiting`，规格 §4.4 executor-bound 只列六态；`BRIDGE_SILENCE_MS=10min` 硬编码，不读 `execution.lease_ttl_ms` | `src/service/commands/runtime.ts:63-64` | `rg -n "BRIDGE_BOUND\|BRIDGE_SILENCE_MS" src/service/commands/runtime.ts` |
| P2-5 | G-16 证据只断言 `cancelledNodes`/`skippedIrreversible`/`timing_out`，不验“子 run 收敛后再判”与父/子 run 终态；代码已收敛，证据仍弱 | `docs/gates/evidence/G3/G-16.md:3-4`、`:13` | `pnpm vitest run tests/integration/g3-faults.spec.ts -t G-16`；对照证据文件 |
| P2-6 | `dispatch` 未装 executor 时一律 `EVIDENCE_SOURCE_UNAVAILABLE`，control-only 的 wait/subworkflow 也被挡；`serveOrchestra` 只跑 sweep | `src/index.ts:208-209`、`:221` | `rg -n "if \(!opts.executor\)" src/index.ts` |
| P2-7 | 节点级 `/v1/node-runs/cancel` 取消 waiting 节点后，节点/登记正确收口，但 run 在 sweep 后收为 `succeeded`；run 级取消才写 `runs.cancel_requested_at`，`closeRun` 只按该列落 `cancelled`。若门记录把“取消 waiting 节点”也定义为 run 取消，此项应升 P1；本轮场景 2 按 run 级验收通过 | `src/service/commands/cancel.ts:78-108`；`src/service/commands/run-close.ts:57-61` | 附录 S2b：`reason=control_node_cancelled`、node superseded、run succeeded |

## 必过项 20/20

| 编号 | 结果 | 依据 |
| --- | --- | --- |
| G3-01 | pass | `migration-cases.spec.ts` 68 条（M-01…M-65）；正文仍写 M-62，见 P2-1 |
| G3-02 | pass | `node-runs.spec.ts`、`transition-rules.spec.ts`、`transition-guard.spec.ts` 全绿 |
| G3-03 | pass | `clock.spec.ts`、`half-state.spec.ts` 全绿 |
| G3-04 | pass | `approval.spec.ts`、`nodes.spec` 相关用例全绿 |
| G3-05 | pass | `policy-branch.spec.ts` 全绿 |
| G3-06 | pass | `parallel.spec.ts` 全绿 |
| G3-07 | pass | `wait.spec.ts` 9 条 + S1a/S1b |
| G3-08 | pass | `subworkflow.spec.ts` 15 条 + S3/S4/S3b |
| G3-09 | pass | `compensation.spec.ts` 9 条 + S5a/S5b |
| G3-10 | pass | `decisions.spec.ts`、`apply-report.spec.ts` 全绿 |
| G3-11 | pass | `sweep.spec.ts`、`runtime.spec.ts` 全绿 |
| G-01 | pass | `g3-faults.spec.ts` 注入全绿；`check-evidence-repro` 覆盖 |
| G-02 | pass | 同上 |
| G-04 | pass | 同上 |
| G-06 | pass | 同上 |
| G-12 | pass | 同上 |
| G-16 | pass | 注入与 S3 行为通过；证据弱见 P2-5 |
| G3-12 | pass | `workflow-identity.spec.ts`、`confirm-start.spec.ts` 全绿 |
| G3-13 | pass | `approval.spec.ts` 三档批准人用例全绿 |
| G3-14 | pass | `pnpm test` 854 passed / 1 skipped；`pnpm build` 250.77/60.04/18.07 与 full-suite 一致 |

## 结构性裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 9,
  "candidate_commit": "df2fc088fc3a2ac66095668bf5f4dcbb5e2fa8a3",
  "conclusion": "fail",
  "p0": 0,
  "p1": 1,
  "p2": 7,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": ["G3-01", "G3-02", "G3-03", "G3-04", "G3-05", "G3-06", "G3-07", "G3-08", "G3-09", "G3-10", "G3-11", "G-01", "G-02", "G-04", "G-06", "G-12", "G-16", "G3-12", "G3-13", "G3-14"],
  "failed_items": ["P1-1"],
  "notes": "五场景与父/子 run 收口通过；新取消语义发现 blocked_pre 取消后批准导致 run 停在 running 的活性缺陷。P1-1 修复并复验前，重签条件尚未满足。另 7 项 P2 见正文。"
}
```
<!-- audit-verdict:end -->

## 重签前待办

1. 修 P1-1：取消时把 `blocked_pre` 一并收口，或批准入口识别 run 取消位并按取消收口；补 blocked_pre → 取消 → 批准 的回归用例。
2. P2-1：G3.md 四处 `M-01…M-62` 改成 M-01…M-65。
3. P2-3：重签时更新 `audit_round=9`、报告路径、四个 artifact 哈希、20 条 evidence sha。
4. P2-2/P2-5：G3 证据纳入字节复现，或明确人工证据的核对方式。
