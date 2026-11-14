# S2 独立审计 · 第 58 轮（837b0c6）

门：G2
候选提交：837b0c6bcf9382f54b0d9abce07cabeadf430cd0

**结论：通过。P0 0 项、P1 0 项、P2 6 项；必过项 20/20；failed_items 为空。**

本轮在 detached 临时 worktree `C:\Users\ASUS\AppData\Local\Temp\orch-audit-s2-r58` 完成，关闭时该 worktree 与临时探针均已删除；主工作树只新增本报告，源码未动。审计针对 `837b0c6`（main，父 `df2fc08`，工作树干净，已推 origin/main）。

上一轮 round57 对 `df2fc08` 的两条 P1 是本轮重点：run 级取消跳过 queued irreversible，导致 run 卡在 `running`；子 run 自取消时父节点 `superseded`、父 run 仍可能 `succeeded`。两条都用真实账本与真实命令验证，结论如下：

- queued / leased irreversible 在 run 级取消时已走 `applyCancel` 的作废分支：节点 `superseded`、租约清空、attempt 不变、run 落 `cancelled`；dispatcher 在取消后不再执行它。
- 子 run 自取消且父未取消：父节点 `failed`、父 run `failed`；父已取消：父节点 `superseded`、父 run `cancelled`。

## 实测命令与退出码

全部在 `837b0c6` 的临时 worktree 内执行，worktree 自带 `pnpm install --offline --frozen-lockfile`（exit 0）。

| 命令 | 退出码 | 实测结果 |
| --- | --- | --- |
| `pnpm run typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm run test` | 0 | 61 files，856 passed \| 1 skipped（857），10.16s |
| `pnpm run build` | 0 | ESM `lib/index.js` 251.67 kB / gzip 60.19 kB；`lib/index.d.ts` 18.07 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致 |
| `node scripts/gate-check.ts docs/gates/G2.md` | 1 | 预签态：`审计报告 sha256 与记录不符`，`b386173930739945… != 3e0753072f37a86e…` |
| `npx vitest run`（G2 必过核心 6 文件） | 0 | 6 files，150 passed |
| `npx vitest run`（G2-16 桥闭环 6 文件） | 0 | 6 files，73 passed |
| `npx vitest run`（工具唯一身份 / 桥三游标 4 文件） | 0 | 4 files，91 passed |
| 本轮独立探针（3 文件，13 条） | 0 | 13 passed |

`gate-check` 的 exit 1 是重签前状态，不是产品行为失败：G2 记录仍指第 51 轮、旧 candidate_hash 与旧报告；重签时更新 artifact 与报告哈希后应恢复 exit 0。P0/P1 为 0，因此本报告明确：**可以重签 G2**。

## 独立探针（不只读测试）

探针文件曾放在 worktree 的 `tests/audit-r58/`，最终 13 条全过，运行后已删除，worktree 回到 clean。探针直接使用生产函数 `propagateRunCancellation`、`closeRun`、`dispatchRun`、`startSubworkflowNode`、`finishSubworkflowChild`、`resumeFromBlockedPre`、`resolveDecision`，并通过 `openServiceOrchestra().commands.cancelRun` 走了一次生产装配入口。

| 场景 | 实测结果 |
| --- | --- |
| run 级取消 + queued irreversible | `cancelledNodes` 含 `nr-irr`，`skippedIrreversible` 不含它；节点 `superseded`、`lease_id`/`lease_expires_at` 为 null、attempt 1；run `cancelled`；`cancel_before_dispatch` 恰好 1 条 |
| run 级取消 + leased irreversible（attempt 2，lease-1） | 节点 `superseded`、租约清空、attempt 2、`cancel_result=interrupted`；run `cancelled` |
| 取消后 dispatch | `dispatchRun` 返回 `[]`，`executeNode` 调用 0 次 |
| 取消位已置但节点仍 queued（模拟 dispatcher 竞态窗口） | outcome `[{node_run_id:'nr-irr',status:'skipped',reason:'run_cancelled'}]`，`executeNode` 0 次 |
| blocked_pre + pending 卡 | 节点 `failed`、`blocked_decision_id`/`resume_state` 清空；决定卡 `resolved`/`expired_final`/revision 2；run `cancelled`；随后 `resumeFromBlockedPre` 抛 `/不在 blocked_pre/`，旧 revision `resolveDecision` 抛 `/CAS 未命中/` |
| blocked_pre + blocked_for_human 卡 | 卡同样 `resolved`/`expired_final`；节点 `failed`；run `cancelled` |
| 子 run 自取消、父未取消 | 子 run `cancelled`；父节点 `failed`；父 run `failed`（不是 succeeded） |
| 子 run 自取消、父已取消 | 父节点 `superseded`；父 run `cancelled` |
| in-flight irreversible（started） | `skippedIrreversible=['nr-ip']`；`closeRun` 返回 null、run 仍 running；节点完成后 `closeRun` 收 `cancelled` |
| waiting + pure 节点 | 节点 `superseded`；run `cancelled` |
| 父取消 + 子仍 running | 父节点 `superseded`，父 `closeRun` 返回 null（子 run 未收口）；子节点 `timing_out`、子 run running；子节点完成后子 run 收 `cancelled`，父 run 待下一轮 sweep 收口 |
| blocked_post + pending verify_human 卡 | 取消输出为空，节点仍 `blocked_post`，run 仍 running（卡片保留，详见 P2-4） |
| 生产入口 `commands.cancelRun` + queued irreversible | run `cancelled`；节点 `superseded`、租约 null；`cancelledNodes=['nr-irr']`、`skippedIrreversible=[]` |

关键代码位置：

- `src/service/commands/subworkflow.ts:489-513`：`blocked_pre` 先关闭决定卡，再把节点迁 `failed`，事件 `cancel_blocked_pre`。
- `src/service/commands/subworkflow.ts:517-522`：只有 `dispatched/started/waiting/verifying` 的 irreversible 才进入 `skippedIrreversible`。
- `src/service/commands/subworkflow.ts:523-532`：queued/leased irreversible 落到 `applyCancel`。
- `src/service/commands/cancel.ts:47-68`：queued/leased 直接 `superseded`，清 `lease_id`/`lease_expires_at`，事件 `cancel_before_dispatch`。
- `src/service/dispatcher.ts:80-85`：执行前重读 `runs.cancel_requested_at`，命中则 `skipped/run_cancelled`。
- `src/service/commands/subworkflow.ts:411-441`：子 run 收口时 `parentCancelled` 与 `childCancelled` 决定 `failed` 或 `superseded`。

## G2 必过项 20/20

| 编号 | 结果 | 依据 |
| --- | --- | --- |
| G2-01 | pass | 全量测试 + `ev-g2-01` 生产链 |
| G2-02 | pass | 全量测试 + `ev-g2-02` 重复上报 |
| G2-03 | pass | 全量测试 + `ev-g2-03` 租约拦截 |
| G2-04 | pass | `ev-g2-04` 节点级 attempt 不变；本轮探针另验 run 级取消 attempt 仍为 1、dispatch 不再执行 |
| G2-05 | pass | `ev-g2-05`、`ev-g2-10` |
| G2-06 | pass | 全量测试 + `ev-g2-06` 无裸 blocked |
| G2-07 | pass | 全量测试 + `ev-g2-07` S2 parallel 被拒 |
| G-03 | pass | 全量测试 + `ev-g2-g03` 同 report_id 只落一次 |
| G-04 | pass | 全量测试 + `ev-g2-g04` 租约到期迟到上报被拒 |
| G-05 | pass | 全量测试 + `ev-g2-g05` 工具执行中取消只立一次围栏 |
| G-07 | pass | 全量测试 + `ev-g2-g07` 墙钟跳变不误判截止 |
| G2-08 | pass | 全量测试 + `ev-g2-08` 工具失败不许落完成 |
| G2-09 | pass | 全量测试 + `ev-g2-09` boot_id/单调纳秒 |
| G2-10 | pass | 全量测试 + `ev-g2-10` 报告入口证据门 |
| G2-11 | pass | 全量测试 + `ev-g2-11` 重投不膨胀 |
| G2-12 | pass | 全量测试 + `ev-g2-12` 工具授权只认 workflow 定义 |
| G2-13 | pass | 全量测试 + `ev-g2-13` 单写者/epoch 围栏 |
| G2-14 | pass | 全量测试 + `ev-g2-14` 心跳续租 |
| G2-15 | pass | 全量测试 + `ev-g2-15` 同版本跨重启不可改写 |
| G2-16 | pass | 桥闭环 6 files / 73 passed（记录仍写 70，见 P2-2） |

**必过 20/20，failed_items：无。**

## P2（不阻断重签）

| 编号 | 问题 | 位置 | 复现 |
| --- | --- | --- | --- |
| P2-1 | G2 记录仍是第 51 轮预签态：candidate_hash 仍指旧候选，audit_round=51，报告指 round51；20 条证据哈希中 4 条与当前 HEAD 不符（ev-g2-01、ev-g2-10、ev-g2-14、ev-g2-g05），其余 16 条一致。重签时脚本会按 HEAD 重算。 | `docs/gates/G2.md:143`、`:324`、`:325`、`:326`、`:532`、`:533`；证据行 `:75`、`:84`、`:88`、`:93` | `node scripts/gate-check.ts docs/gates/G2.md` exit 1，首条为审计报告 sha 不符；按 LF 归一重算 4 条不一致：ev-g2-01 want `71825a7d…` got `cee94009…`；ev-g2-10 want `3f3ba099…` got `bd360512…`；ev-g2-14 want `61e9c435…` got `77755fa7…`；ev-g2-g05 want `d400f29d…` got `d6288170…` |
| P2-2 | G2-16 证据计数过期：G2.md 与 ev-g2-16 仍写 70 项、全量 42 files/624 passed，当前实测 G2-16 6 files/73 passed、全量 61 files/856 passed。 | `docs/gates/G2.md:98`；`docs/gates/evidence/G2/ev-g2-16.md:51`、`:54` | `npx vitest run tests/integration/agent-lifecycle.spec.ts tests/integration/bridge-ledger.spec.ts tests/unit/bridge-buffer.spec.ts tests/integration/runtime.spec.ts tests/e2e/production-path.spec.ts tests/contract/execution-concurrency.spec.ts` → 73 passed；`pnpm run test` → 856 passed |
| P2-3 | G2-04 证据仍只覆盖节点级取消：入口写的是 `POST /v1/node-runs/cancel`，没有 run 级取消 queued irreversible 的账本片段；本轮修复的正是 run 级路径，重签时建议补一条 run 级证据。 | `docs/gates/G2.md:34`；`docs/gates/evidence/G2/ev-g2-04.md:3`、`:39` | 读证据文件：参数入口为 `POST /v1/node-runs/cancel → POST /v1/node-runs/report`；本轮探针走 `/v1/runs/cancel` 等价路径 |
| P2-4 | run 级取消遇到 `blocked_post` 且有待决 `verify_human` 卡时，取消输出为空、节点保持 `blocked_post`、run 仍 `running`；卡片保留到人工裁决。它保留了执行后证据门，但取消接口不提示“待人工收口”，使用者可能误以为已取消。 | `src/service/commands/subworkflow.ts:489`（只处理 blocked_pre）、`:514`（状态过滤）；`src/service/commands/run-close.ts:38-44`（未决卡阻止收口）；`src/service/sweep.ts:350` | 探针：run `r1` + 节点 `blocked_post` + decision `d3` pending；`propagateRunCancellation` 后 `out={cancelledRuns:[],cancelledNodes:[],skippedIrreversible:[]}`，`closeRun=null`，节点仍 `blocked_post` |
| P2-5 | 父 run 取消时子 run 仍在跑：父节点 `superseded`，但父 `closeRun` 因 `assertNoOpenChildRuns` 返回 null；父 run 要等子节点停止、子 run 收口后，再由下一轮 sweep 收口。取消不是“立即全链终态”。 | `src/service/commands/subworkflow.ts:538-548`；`src/service/commands/parallel.ts:157-169`；`src/service/commands/run-close.ts:46` | 探针：父取消后 `{parentNode:'superseded', parentClose:null, childNode:'timing_out', childRun:'running'}`；子节点置 done 后 `child run -> cancelled`，父 run 待 sweep |
| P2-6 | `blocked_pre` 被取消时节点落 `failed`，不是 `superseded`；状态机 `blocked_pre` 只有 `queued`/`failed` 两条出口，没有 `superseded` 边，所以这是当前模型下的可解释选择，但与“取消未执行节点”的 `superseded` 口径不一致。 | `src/service/commands/subworkflow.ts:499-506`；`src/core/state-machine.ts:187-188` | 探针：blocked_pre 取消后节点 `failed`、事件 `cancel_blocked_pre`；候选用例 `tests/integration/subworkflow.spec.ts` 也按 `failed` 断言 |

## 工具唯一身份 / 三游标 / 幂等 / 先落账再 ACK

候选 diff 未改这些文件；本轮用现有实现与回归确认未被破坏：

- 工具唯一身份：`src/infra/sqlite/migrations/006_tool_executions_tool_seq.sql:9-24` 仍是 `PRIMARY KEY (node_run_id, attempt, tool_seq)` + `execution_id TEXT NOT NULL UNIQUE`；`src/service/commands/apply-report.ts:620-690` 仍按 `execution_id` 绑定证据行并核对 `tool_finished` 事件。`migrate-tool-seq`、`apply-report` 用例通过。
- 三游标与幂等：`src/executor/bridge.ts:291-340` 同 seq 同 payload 幂等、同 seq 不同 payload `BRIDGE_SEQ_CONFLICT`；`ack` 拒非顺序推进。三游标仍为 `lastReceivedSeq` / `lastContiguousSeq` / `lastPersistedAckSeq`（`:447-450`）。
- 先落账再 ACK：`src/executor/bridge-ledger.ts:98-132` 在单个 `withTx` 内追加 `node_run_events`、写 `bridge_event_receipts`、推进 `last_persisted_ack_seq`；`src/executor/bridge-consumer.ts:81-90` 的 drain 顺序仍是 `ledger.ingest → onEvent → markHandled → buffer.ack`。
- 组合回归：`tests/integration/migrate-tool-seq.spec.ts`、`tests/unit/bridge-buffer.spec.ts`、`tests/integration/bridge-ledger.spec.ts`、`tests/integration/apply-report.spec.ts` 共 4 files/91 passed（exit 0）。

## 重签前待办

1. 重签 G2 时更新 `audit_round=58`、报告路径、candidate_hash/四个 artifact 哈希与 20 条 evidence sha；`ev-g2-16` 的 70/624 改为当前 73/856。
2. 建议把本轮 run 级取消 queued irreversible 的账本片段补进 G2-04 证据，避免“必过项通过但证据只覆盖节点级”的口径落差。
3. P2-4/P2-5 是取消语义的收口延迟说明，不阻断本轮重签；若要取消接口返回“已取消”即全链终态，需要另立设计口径。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 58,
  "candidate_commit": "837b0c6bcf9382f54b0d9abce07cabeadf430cd0",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 6,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": ["G2-01", "G2-02", "G2-03", "G2-04", "G2-05", "G2-06", "G2-07", "G-03", "G-04", "G-05", "G-07", "G2-08", "G2-09", "G2-10", "G2-11", "G2-12", "G2-13", "G2-14", "G2-15", "G2-16"],
  "failed_items": [],
  "notes": "run 级取消 queued/leased irreversible 已作废并清租约，run 落 cancelled，dispatcher 不再执行；子 run 自取消两条父路径均正确。G2 记录仍是第51轮预签态，4条证据sha与ev-g2-16计数滞后，按P2处理，重签时重算。"
}
```
<!-- audit-verdict:end -->
