# S3 独立审计 · 第 10 轮（837b0c6）

门：G3
候选提交：837b0c6bcf9382f54b0d9abce07cabeadf430cd0

**verdict：pass**。P0 0 项、P1 0 项、P2 10 项；必过项 20/20；failed_items：空。

候选 `837b0c6bcf9382f54b0d9abce07cabeadf430cd0`（`fix(service): cancel queued irreversible and blocked_pre nodes`，main，父 `df2fc08`，已推 origin/main）。审计在 detached 临时 worktree `C:\Users\ASUS\AppData\Local\Temp\orch-audit-s3-r10` 完成，主工作树源码未改，本报告为新增文件；审计结束后临时 worktree 已删除。

## 结论

上轮 `df2fc08` 的 P1-1 已修复。`propagateRunCancellation` 现在先把 run 的 `cancel_requested_at` 写入，再对 `blocked_pre` 节点关闭其活跃裁决卡并把节点转 `failed`，随后由 `cancelRun` 在同一事务内调用 `closeRun`；不再依赖 dispatcher 空转或后续人工补一次节点级取消。真实 HTTP 入口的取消后批准、批准后取消、20 轮并发竞争三种顺序都收口为 `cancelled`，没有出现父 run 被误收成 `succeeded` 或停在 `running`。

G3 五场景与附加取消语义复验成立：wait 唤醒/超时、run 级取消 waiting、取消子流程、失败子流程映射、补偿 settle 均通过；queued/leased 不可逆节点取消清租约并自动收口。20 条必过项全部有本轮实测或测试依据；full-suite 证据的 856 passed / 1 skipped 与代码产物尺寸同实测一致。

剩余 10 项均为 P2：门记录仍是预签态、G3 证据未纳入字节复现、取消关裁决卡的审计语义、终态 run 取消仍写取消列、租约清空的测试/边界覆盖、wait 桥接边界、无 executor 时控制节点被挡、节点级取消 waiting 后 run 仍 succeeded、G-16 证据偏弱。按本轮口径 P2 不阻断。**可以重签 G3**；重签时按既有流程更新 `audit_round`、报告路径、四个 artifact 哈希与 20 条 evidence sha 即可。

## 实测命令与退出码

全部在审计 worktree 执行（`npm_config_verify_deps_before_run=false`）。

| 命令 | 退出码 | 实测结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm test` | 0 | 61 files，856 passed \| 1 skipped（857），10.64s |
| `pnpm build` | 0 | ESM `lib/index.js` 251.67 kB / gzip 60.19 kB；`lib/index.d.ts` 18.07 kB；CJS `lib/client.js` 0.29 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致（仅 G1/G2） |
| `node scripts/gate-check.ts docs/gates/G3.md` | 1 | `审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 4876a98892db4661…` |
| `pnpm vitest run wait/subworkflow/cancel/compensation/sweep/g3-faults/migration-cases` | 0 | 7 files，150 passed |
| `node --experimental-strip-types --no-warnings tmp/probe-r10.mjs` | 0 | 7 个场景全部按预期返回；T6/T7 为缺陷观察项，见 P2-4/P2-6 |

`gate-check` 的 exit 1 是预签态：`docs/gates/G3.md:71-74` 四个 GateArtifact 哈希全 0，`:111-113` 仍是 `audit_round=3`、报告指 round3、`audit_report_sha256` 全 0，`:119` 起 20 条 evidence sha 全 0。按本轮指令只记 P2，不作为 P0/P1。`full-suite.md` 已记 856 passed \| 1 skipped、251.67/60.19/18.07 kB，与实测一致（G3-14）。

## 上轮 P1 的独立复验

生产装配 `openServiceOrchestra` + `startServer`，夹具直接落 `runs`/`node_runs`/`decisions`，全部经 HTTP 入口调用，不直接调命令函数。

| 场景 | 实测 | 结果 |
| --- | --- | --- |
| T1 取消先到，随后批准 | `POST /v1/runs/cancel` 200；`POST /v1/decisions/resolve` 409 `DECISION_REVISION_CONFLICT`（details.revision=1）；final `run=cancelled`、`node=failed`、`decision=resolved/expired_final revision=2` | pass |
| T2 批准先到，随后取消 | 批准 200，`beforeCancel.node=queued`；取消 200；final `run=cancelled`、`node=superseded`、`decision=resolved/approved` | pass |
| T3 20 轮并发批准/取消 | `Promise.allSettled` 同时发 cancel 与 resolve；20 轮全部 `run=cancelled`、节点终态，批准均 409；`succeeded=[]`、`queued/blocked_pre=[]` | pass |
| T4 queued 不可逆 + 租约 | cancel 200；`node=superseded`；`lease_id=null`、`lease_expires_at=null`；`run=cancelled` | pass |
| T5 leased 不可逆 + 租约 | 同 T4；`node=superseded`、租约清空、`run=cancelled` | pass |
| T6 已 succeeded run 再取消 | cancel 200；`status` 仍 `succeeded`，但 `cancel_requested_at`/`cancel_result` 被写入 | 观察，P2-4 |
| T7 blocked_pre 带租约、无裁决卡 | cancel 200；`node=failed`、`run=cancelled`，但 `lease_id` 仍为 `lease_r10c` | 观察，P2-6 |

竞争窗口的代码依据：

- 取消事务先写 `runs.cancel_requested_at`（`src/service/commands/subworkflow.ts:473`），关闭裁决卡时把 `revision` 加一（`:494-497`），再把节点转 `failed`（`:505`）。
- 批准入口的 CAS 是 `WHERE revision=? AND status IN active`（`src/service/commands/decisions.ts:189-193`）。取消提交后，带旧 revision 的批准必然 CAS 未命中，返回 409，不会再把节点放回 `queued`。
- 批准先提交时，同一事务已把节点放回 `queued`；取消看到 `queued` 走 `cancel_before_dispatch` 分支，节点转 `superseded`（`src/service/commands/cancel.ts:47-68`），`closeRun` 按 `cancel_requested_at` 落 `cancelled`（`src/service/commands/run-close.ts:57`）。
- dispatcher 的 `cancel_requested_at` 二次检查仍在（`src/service/dispatcher.ts:80-84`），作为最后一道围栏；本轮 T1-T5 均未依赖它来收口。

T3 的说明：本夹具的 HTTP 写队列让 20 轮里取消都先落，因此 T3 主要证明“取消先到”的批量稳定性；反向顺序由 T2 的顺序执行单独覆盖，两种顺序都没有 succeeded 或卡住。

## G3 五场景复验

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 1. wait 唤醒后同操作收口；wait 超时由维护扫描收口 | pass | `tests/integration/wait.spec.ts:44`（唤醒后 node done、run succeeded、租约释放）；`:136`（单调锚点超时）；`:181`（维护扫描自己收 wait 超时）；`tests/integration/sweep.spec.ts:76`（全终态后 sweep 收 run，不靠空 dispatch） |
| 2. run 级取消 waiting：撤销登记，迟到事件只落 inbox | pass | `tests/integration/cancel.spec.ts:212`（登记 cancelled、node superseded、迟到事件 woken=0、inbox=1）；`src/service/commands/cancel.ts:81-111`；本轮 R10-W 探针走生产 `propagateRunCancellation` + `closeRun`：cancel 后 run `cancelled`、node `superseded`、登记 `cancelled`，迟到事件 `woken=0`、inbox=1；T1/T2 证明 run 级取消立即收口 |
| 3. 取消子流程：父节点收口，父/子 run 落 cancelled | pass | `tests/integration/subworkflow.spec.ts:232`（取消的子运行→父节点 superseded、父 run cancelled）；同文件 17 条全绿；`src/service/commands/subworkflow.ts:538-549` 递归取消子 run；`src/index.ts:194-205` 传播后立即 `closeRun` |
| 4. 失败子流程映射：父节点 failed，父 run failed | pass | `tests/integration/subworkflow.spec.ts:204`（失败子运行→父节点 failed、父 run 不冒充成功）；`:218`（子运行自取消、父未取消时父节点 failed，M-64），不会误收 succeeded |
| 5. 补偿 settle 收口 | pass | `tests/integration/compensation.spec.ts:80`、`:92`、`:103`；settle applied/failed 后 node/run 按 `failed_with_unverified` 或终态收口，扫描不依赖空 dispatch |

附加取消语义：

- **queued/leased 不可逆节点**：T4/T5 预置非空租约后取消，均 `superseded`、租约清空、run `cancelled`；对应 `src/service/commands/cancel.ts:47-68`。
- **blocked_pre 取消**：T1 关闭裁决卡、节点 `failed`、run `cancelled`；对应 `src/service/commands/subworkflow.ts:489-512`。
- **dispatcher 二次检查**：预置 `runs.cancel_requested_at` 的 queued 节点仍会被 `skipped/run_cancelled`，不会误派发；`src/service/dispatcher.ts:80-84`。
- **M-64/M-65 可达**：`src/core/state-machine.ts:165-168` 有 `waiting→failed control-failed` 与 `waiting→superseded control-cancelled`，`:269-276` 迁移清单含 M-61…M-65；`tests/integration/migration-cases.spec.ts:26` 的 68 条用例通过。

## 必过项 20/20

| 编号 | 结果 | 依据 |
| --- | --- | --- |
| G3-01 | pass | `migration-cases.spec.ts` 68 条（M-01…M-65）；G3.md 四处已改 M-01…M-65 |
| G3-02 | pass | `node-runs.spec.ts`、`transition-rules.spec.ts`、`transition-guard.spec.ts` 全绿 |
| G3-03 | pass | `clock.spec.ts`、`half-state.spec.ts` 全绿 |
| G3-04 | pass | `approval.spec.ts`、`nodes.spec.ts` 相关用例全绿 |
| G3-05 | pass | `policy-branch.spec.ts` 全绿 |
| G3-06 | pass | `parallel.spec.ts` 全绿 |
| G3-07 | pass | `wait.spec.ts` 9 条；唤醒/超时/事件早到/重复唤醒均覆盖 |
| G3-08 | pass | `subworkflow.spec.ts` 17 条；成功/失败/取消/自取消映射均覆盖 |
| G3-09 | pass | `compensation.spec.ts` 9 条 |
| G3-10 | pass | `decisions.spec.ts`、`apply-report.spec.ts` 全绿 |
| G3-11 | pass | `sweep.spec.ts` 20 条；全终态自收、子 run 推进父节点、wait 超时均覆盖 |
| G-01 | pass | `g3-faults.spec.ts` 注入全绿；`check-evidence-repro` 覆盖（G1 6 例之一） |
| G-02 | pass | 同上 |
| G-04 | pass | 同上 |
| G-06 | pass | 注入全绿；证据字节复现未覆盖，见 P2-2 |
| G-12 | pass | 注入全绿；证据字节复现未覆盖，见 P2-2 |
| G-16 | pass | 注入与取消传播行为通过；证据自述偏弱，见 P2-10 |
| G3-12 | pass | `workflow-identity.spec.ts`、`confirm-start.spec.ts` 全绿 |
| G3-13 | pass | `approval.spec.ts` 三档批准人用例全绿 |
| G3-14 | pass | `pnpm test` 856 passed / 1 skipped；`pnpm build` 251.67/60.19/18.07 与 full-suite 一致 |

## P2

| 编号 | 问题 | 位置 | 复现与影响 |
| --- | --- | --- | --- |
| P2-1 | G3 门仍是预签态：`audit_round=3`、报告指 round3、四个 artifact 哈希与 20 条 evidence sha 全 0；gate-check 以审计报告 sha 不符 exit 1。这是“审计后待重签”状态，不阻断，但必须重签时更新 | `docs/gates/G3.md:71-74`、`:111-113`、`:119-138` | `node scripts/gate-check.ts docs/gates/G3.md`；exit 1，记录值 `0000…`，实际报告哈希 `4876a98892db4661…` |
| P2-2 | G3 注入证据与 full-suite 均未纳入 `check-evidence-repro`；脚本只覆盖 G1 6 例 + G2 19 例共 25 份。G-06/G-12/G-16 被 fault-inject 归到 G1 目录，产出原始账本 dump，与 G3 叙事证据不同字节 | `scripts/check-evidence-repro.ts:12-15`；`scripts/fault-inject.ts:1510`；`docs/gates/evidence/G3/*.md` | `node --no-warnings scripts/check-evidence-repro.ts` 只报 25 份；G3 三份注入证据不在守卫内 |
| P2-3 | 取消关闭审批卡用裸 UPDATE：未追加 `decision.resolved` 事件、未记录 `resolved_by`，且把取消原因记成 `expired_final`；审计上分不清“取消关的卡”和“真正过期” | `src/service/commands/subworkflow.ts:494-497` | T1：`dec.status=resolved`、`closed_reason=expired_final`、`revision=2`，`decision.resolved` 事件缺失 |
| P2-4 | 已终态 run 再取消仍返回 200，并写入 `cancel_requested_at`/`cancel_result`，但 `status` 保持 `succeeded`；取消请求被记成事实，终态不可变性与“取消被接受”语义不一致 | `src/service/commands/subworkflow.ts:473-475`（无终态守卫）；`src/index.ts:194-204`（cancelRun 不查 run 终态） | T6：cancel 200；final `{status:"succeeded", cancel_requested_at:"2026-11-14T15:30:00.000Z", cancel_result:"interrupted"}` |
| P2-5 | 新增 queued 不可逆取消用例没有预置非空租约，套件不验证“清租约”这条承诺；租约清空只有本轮 T4/T5 探针覆盖 | `tests/integration/subworkflow.spec.ts:263-280` | 用例只断言 superseded 与 closeRun；删掉清租约语句套件仍会绿 |
| P2-6 | `blocked_pre` 取消的 patch 不清 `lease_id`/`lease_expires_at`；生产路径 `run-node` 在宿主明确报错（4xx） 时会把 `dispatched` 节点直接 `transitionNode` 到 `blocked_pre`（只带 verifyHuman、无 decisionId），该路径可能带着租约进入 blocked_pre，取消后 failed 节点仍残留租约 | `src/service/commands/subworkflow.ts:505`（patch 不含 lease）；`src/executor/run-node.ts:221-229`；`src/service/commands/node-state.ts:38-143`（transitionNode 不清租约） | T7：预置 `blocked_pre + lease_r10c + 无卡`，cancel 200 后 `node=failed`、`run=cancelled`，`lease_id` 仍 `lease_r10c` |
| P2-7 | `BRIDGE_BOUND` 含 `waiting`，与规格 §4.4 executor-bound 六态口径不一致；`BRIDGE_SILENCE_MS=10min` 硬编码，不读 `execution.lease_ttl_ms` | `src/service/commands/runtime.ts:63-64` | 代码核对；沿用第 9 轮口径，候选未触及 |
| P2-8 | `dispatch` 未装 executor 时一律 `EVIDENCE_SOURCE_UNAVAILABLE`，control-only 的 wait/subworkflow 也被挡；`serveOrchestra` 只跑 sweep，控制节点没有正常 dispatch 出口 | `src/index.ts:208-209`、`:221` | 代码核对；沿用第 9 轮口径 |
| P2-9 | 节点级 `/v1/node-runs/cancel` 取消 waiting 节点后，节点/等待登记正确收口，但 sweep 后 run 收为 `succeeded`；run 级取消才写 `runs.cancel_requested_at`。若门记录把“节点级取消”也视作 run 取消，此项应升 P1 | `src/service/commands/cancel.ts:81-111`；`src/service/commands/run-close.ts:57-61` | 沿用第 9 轮 S2b：`reason=control_node_cancelled`、node superseded、run succeeded；本轮 cancel 17 条测试未改变该口径 |
| P2-10 | G-16 证据只断言 `cancelledNodes`/`skippedIrreversible`/`timing_out`，不验“子 run 收敛后再判”与父/子 run 终态；代码与注入已收敛，证据仍偏弱 | `docs/gates/evidence/G3/G-16.md:3-4`、`:13` | `pnpm vitest run tests/integration/g3-faults.spec.ts -t G-16` 对照证据文件；沿用第 9 轮口径 |

## 结构性裁决

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 10,
  "candidate_commit": "837b0c6bcf9382f54b0d9abce07cabeadf430cd0",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 10,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": ["G3-01", "G3-02", "G3-03", "G3-04", "G3-05", "G3-06", "G3-07", "G3-08", "G3-09", "G3-10", "G3-11", "G-01", "G-02", "G-04", "G-06", "G-12", "G-16", "G3-12", "G3-13", "G3-14"],
  "failed_items": [],
  "notes": "上轮 P1-1 已修复并经真实 HTTP 复验：取消后批准 409，批准后取消 superseded/cancelled，20 轮并发无 succeeded 或卡住。G3 五场景与 queued/leased 不可逆取消均通过。剩余 10 项 P2 不阻断，可以重签 G3。"
}
```
<!-- audit-verdict:end -->

## 重签前待办（P2，不阻断）

1. **P2-1**：重签时更新 `docs/gates/G3.md` 的 `audit_round=10`、报告路径、四个 artifact 哈希与 20 条 evidence sha；签前跑 `gate-check` 应变 exit 0。
2. **P2-2**：把 G3 的 G-06/G-12/G-16 与 full-suite 纳入字节复现，或在门记录中明确人工证据的复核方式。
3. **P2-3/P2-4**：取消关裁决卡时写 `decision.resolved` 事件与 `resolved_by`，原因改用取消类枚举；终态 run 的取消请求改为显式 409，不再写取消列。
4. **P2-5/P2-6**：补“queued 不可逆 + 非空租约”套件用例；`blocked_pre→failed` 的取消 patch 一并清租约，并覆盖 spawn 被拒路径。
5. **P2-7/P2-8/P2-9/P2-10**：沿用第 9 轮待办，按门记录口径逐项收敛或明确豁免。







