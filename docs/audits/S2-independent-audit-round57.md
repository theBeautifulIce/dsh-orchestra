# S2 第 57 轮独立审计报告（G2）

门：G2
候选提交：df2fc088fc3a2ac66095668bf5f4dcbb5e2fa8a3

- 审计日期：2026-11-14
- 审计工作树：`tmp/audit-r57`（detached，基于候选提交），审计结束已删除
- 候选父提交：`af3970b`（第 56 轮被判 fail 的提交）
- 工具链：node v26.13.1，pnpm 12.3.4，vitest 4.1.8
- 方法：先读代码路径，再写独立探针复现；测试只作旁证，不把“新增测试通过”当作修复成立。

## 0. 结论

**fail。不能重签 G2。**

| 项目 | 结果 |
| --- | --- |
| P0 | 0 |
| P1 | 1 |
| P2 | 2 |
| 必过项 | 20 / 20 |
| failed_items | 空 |
| 全量测试 | 61 files / 854 passed / 1 skipped，exit 0 |
| 结论 | 第 56 轮 P1-1 已修复；P1-2 只修了“不再执行”，没修“能收口”，run 级取消仍会永久停在 running |

必过 20 项字面全部通过，所以 `failed_items` 为空；本轮 fail 来自必过清单之外的 run 级取消收口缺陷（P1）。这一点必须和“G2-04 是否通过”分开看，不能用一个 20/20 掩盖 run 级 API 的缺口。

## 1. 两条声明的独立验证

### 1.1 子 run 自行取消、父未取消（第 56 轮 P1-1）——通过

探针不是直接改库，而是走真实取消路径：

1. 建父 run `r1` 与子 run `r2`（通过 subworkflow 节点 `nr-parent` 启动），子 run 内有一个可完成的 agent 节点。
2. 只对子 run 调 `propagateRunCancellation` + `closeRun`，不碰父 run；确认父 run 的 `cancel_requested_at` 仍为 `null`。
3. 再调 `finishSubworkflowChild` 和父 run 的 `closeRun`。

实测：

```text
child closed = cancelled
parent cancel_requested_at before finish = null
wake = { parentNodeRunId: 'nr-parent', status: 'failed' }
closeRun(parent) = 'failed'
parent run = { status: 'failed', cancel_requested_at: null }
parent node = { status: 'failed', side_effect_policy: 'pure' }
```

父节点落 `failed`，父 run 落 `failed`，没有落 `succeeded`，也没有落 `cancelled`。第 56 轮 P1-1 的修复成立。

代码位置：`src/service/commands/subworkflow.ts:411-441`。`parentCancelled` 从 `runs.cancel_requested_at` 读取（413-415），`childCancelled` 只认 `superseded|cancelled`（417），落点表达式为 `childCancelled && parentCancelled ? 'superseded' : 'failed'`（417-420）。语义与“子自行取消、父未取消 → failed”一致。

候选自带测试 `tests/integration/subworkflow.spec.ts:218-230` 比探针弱：它用 `UPDATE runs SET status='cancelled'` 直接造子 run 终态，没有走真实取消传播。探针走真实取消路径仍然通过，所以测试弱不影响结论。

### 1.2 run 级取消含 queued irreversible（第 56 轮 P1-2）——部分通过，仍为 P1

分两段看。

**A. 后续 dispatch 不再执行它：通过。**

探针：run `r1` 里放一个 `queued`、`side_effect_policy='irreversible'` 的节点 `nr_irr`；对 run 调 `propagateRunCancellation` + `closeRun`；再调 `dispatchRun`，注入 `executeNode` 间谍。

实测：

```text
propagate out = {
  cancelledRuns: [],
  cancelledNodes: [],
  skippedIrreversible: ['nr_irr']
}
dispatch outcomes = [
  { node_run_id: 'nr_irr', node_id: 'irr', status: 'skipped', reason: 'run_cancelled' }
]
executeNode 调用次数 = 0
node = { status: 'queued', attempt: 1, lease_id: null }
run  = { status: 'running', cancel_requested_at: '2026-11-14T15:00:00.000Z' }
```

`attempt` 保持 1，没有新 attempt；`dispatchOne` 的取消闸生效，节点没有被执行。G2-04 的字面判据“取消后不产生新 attempt”在这一段是成立的。

**B. run 能收口：失败。**

同一探针继续跑 sweep，等待 run 进入终态：

```text
after sweep: run.status = 'running'
after sweep: node.status = 'queued'
assertion expect(node.status).not.toBe('queued') failed
```

`propagateRunCancellation` 先给 run 写了 `cancel_requested_at`，但把 `queued` 的不可逆节点放进 `skippedIrreversible` 后直接 `continue`，从未调用 `applyCancel`。因此 `cancel.ts:45-69` 新增的 `queued/leased -> superseded` 分支在 run 级路径上不可达。节点保持 `queued`，`closeRun` 在 `run-close.ts:38-39` 因“存在非终态节点”返回 `null`；`sweep.ts:350-351` 只对全终态 run 调 `closeRun`，没有补救分支。结果是 run 永久停在 `running`，`cancel_requested_at` 已写但永远不会变成 `cancelled`。

代码证据链：

| 位置 | 事实 |
| --- | --- |
| `src/service/commands/subworkflow.ts:481-486` | 状态在 `queued/leased/dispatched/started/waiting/verifying` 的节点，只要 `side_effect_policy==='irreversible'` 就 `skippedIrreversible.push` 后 `continue`，在所有 `applyCancel` 之前 |
| `src/service/commands/cancel.ts:45-69` | `queued/leased` 先于不可逆检查落 `superseded`，并清 `lease_id/lease_expires_at`；这段从 run 级传播路径不可达 |
| `src/service/dispatcher.ts:80-85` | `dispatchOne` 二次查 `runs.cancel_requested_at`，命中只返回 `skipped/run_cancelled`，不推进节点状态 |
| `src/service/commands/run-close.ts:38-39` | 任一节点非终态则 `closeRun` 返回 `null` |
| `src/service/sweep.ts:350-351` | 只对 `status='running'` 的 run 调 `closeRun`，没有“run 已请求取消但仍有 skipped 未终态节点”的收口逻辑 |

这与候选提交说明里的“queued/leased 不可逆节点先于不可逆检查直接 superseded 并清租约”不一致：该行为只发生在节点级 `POST /v1/node-runs/cancel`（`applyCancel`），run 级 `POST /v1/runs/cancel` 走的是 `propagateRunCancellation`，在到达 `applyCancel` 之前就被跳过了。`subworkflow.ts:460-461` 的注释“不可逆节点一律跳过”也仍是旧语义。

**影响**：调用 run 级取消后，HTTP 返回成功、`cancel_requested_at` 已写，但 run 永远停在 `running`；sweep 不会救；再调一次 run 级取消仍然走同一条跳过路径。人工只能再逐个节点调节点级取消，才能让 sweep 收口。对自动化调用方来说，run 级取消是不可用的。

**修复建议**：在 `propagateRunCancellation` 的循环里只对“已经可能产生副作用”的不可逆状态跳过，即 `dispatched/started/waiting/verifying`；对 `queued/leased` 直接调 `applyCancel`，让它走 `cancel.ts:45-69` 的新分支落 `superseded` 并清租约。`dispatcher` 的二次检查保留，作为并发竞态的防线。若仍希望“跳过”而不是“作废”，则必须给跳过的节点一个显式终态或人工决策，不能让它保持 `queued`。

## 2. 必过项逐项

| 项 | 结果 | 说明 |
| --- | --- | --- |
| G2-01 单节点 queued 到终态一条路径 | pass | 本轮未改该路径；全量测试通过 |
| G2-02 重复上报只落一次 | pass | 全量测试通过 |
| G2-03 租约过期迟到上报被拒 | pass | 全量测试通过 |
| G2-04 取消后不产生新 attempt | pass（字面） | 探针显示 `attempt` 保持 1、dispatch 跳过；run 级收口缺陷见 P1，不在该项字面判据内 |
| G2-05 终态必带证据 | pass | 全量测试通过 |
| G2-06 无裸 blocked | pass | 全量测试通过 |
| G2-07 S2 加载 parallel 被拒 | pass | 全量测试通过 |
| G-03 同一 report_id 两次只落一次 | pass | 定向 apply-report 61 项通过 |
| G-04 租约到期后迟到上报被拒 | pass | 全量测试通过 |
| G-05 工具执行中取消只立一次围栏 | pass | 全量测试通过 |
| G-07 墙钟跳变不误判截止 | pass | 全量测试通过 |
| G2-08 工具失败不许落完成 | pass | 全量测试通过 |
| G2-09 判定时限只认 boot_id 与单调纳秒 | pass | 全量测试通过 |
| G2-10 报告入口系统级证据门 | pass | apply-report 61 项通过；`execution_id` 绑定检查见第 3 节 |
| G2-11 重投 report_id 不刷膨胀 | pass | 定向测试通过 |
| G2-12 工具授权只认 workflow 定义 | pass | 全量测试通过 |
| G2-13 单写者锁与 epoch 围栏 | pass | 全量测试通过 |
| G2-14 长动作靠心跳续租 | pass | 全量测试通过 |
| G2-15 同工作流同版本跨重启不可改写 | pass | 全量测试通过 |
| G2-16 Agent Bridge 生产闭环 B01–B10 | pass | bridge-buffer 19 + bridge-ledger 10 通过；证据文件计数过期见 P2-1 |

## 3. 工具唯一身份、三游标、幂等、先落账再 ACK

这一轮候选只改了取消路径，没有改工具账本和 Bridge；但要求是“未被破坏”，所以仍按实现和定向测试复核。

### 3.1 工具执行唯一身份

- `src/infra/sqlite/migrations/006_tool_executions_tool_seq.sql:9-24` 重建 `tool_executions`，主键为 `(node_run_id, attempt, tool_seq)`，并新增 `execution_id TEXT NOT NULL UNIQUE`（第 16 行）。同一节点同一次尝试里的多次工具执行不再互相覆盖。
- `src/service/commands/apply-report.ts:620-690` 的 `traceBindingGate` 按 `execution_id` 把报告里的 `evidence_trace` 绑到账本行，同时核对 `toolSeq`、行哈希，以及同一 `execution_id` 的 `tool_finished` 事件（第 684 行附近）；对不上判 `evidence_unverifiable`。
- 定向测试：`tests/integration/migrate-tool-seq.spec.ts`（1）、`tests/integration/apply-report.spec.ts`（61），均通过。

结论：唯一身份没有被候选改动破坏。

### 3.2 三游标与幂等

- `src/executor/bridge.ts:291-340`：同 `seq` 同 payload 幂等，不重复追加；同 `seq` 不同 payload 抛 `BRIDGE_SEQ_CONFLICT`。`ack(seq, persistedAckSeq)` 拒绝 `persistedAckSeq < seq`、`seq > lastContiguous` 和非顺序推进。
- 三个游标 `lastReceivedSeq / lastContiguousSeq / lastPersistedAckSeq` 在 `src/executor/bridge.ts:447-450` 维护。
- `src/executor/bridge-ledger.ts:98-132`：`ingest` 在同一个 `withTx` 里追加 `node_run_events`、写 `bridge_event_receipts`、推进 `bridge_stream_cursors.last_persisted_ack_seq`；同 receipt、同 payload hash 返回 `appended:false`；`seq != ack+1` 拒绝。
- 定向测试：`tests/unit/bridge-buffer.spec.ts`（19）、`tests/integration/bridge-ledger.spec.ts`（10），均通过。

### 3.3 先落账再 ACK

`src/executor/bridge-consumer.ts:81-90` 的 drain 顺序是 `ledger.ingest -> onEvent -> markHandled -> buffer.ack`；`buffer.ack` 只在持久确认之后调用，且要求 `persistedAckSeq >= seq`。重启只信 `lastPersistedAckSeq`。定向测试通过。

结论：三游标、幂等、先落账再 ACK 均未被候选破坏。

## 4. P1 / P2 明细

### P1-1 run 级取消无法收口（queued irreversible 永久停留）

- 严重度：P1
- 位置：`src/service/commands/subworkflow.ts:481-486`（跳过点）；关联 `src/service/commands/cancel.ts:45-69`、`src/service/dispatcher.ts:80-85`、`src/service/commands/run-close.ts:38-39`、`src/service/sweep.ts:350-351`
- 复现：临时 spec 内建 run `r1` + queued irreversible 节点 `nr_irr`；调 `propagateRunCancellation` + `closeRun`；调 `dispatchRun`（executeNode 间谍）后再 sweep。
- 实测：dispatch `executed=0`，`attempt=1`，节点仍 `queued`，run 仍 `running`；断言“节点不应仍为 queued”失败。
- 影响：`POST /v1/runs/cancel` 返回成功但 run 永久 running；自动化调用方无法只靠 run 级取消收口。
- 建议：`propagateRunCancellation` 对 `queued/leased` 不可逆节点也调 `applyCancel`（新分支会落 `superseded` 并清租约）；只对 `dispatched/started/waiting/verifying` 的不可逆节点跳过。

### P2-1 G2 记录与 ev-g2-16 证据计数过期（重签前必须处理）

- 严重度：P2（不是 df2fc08 的代码回归，是预签状态）
- 位置：`docs/gates/G2.md:324-326` 仍是 `audit_round=51`、`audit_report=docs/audits/S2-independent-audit-round51.md`、`audit_report_sha256=b3861739...`；`docs/gates/evidence/G2/ev-g2-16.md:50-54` 仍写 `6 files / 70 tests` 与 `42 files / 624 passed / 1 skipped`
- 复现：`node scripts/gate-check.ts docs/gates/G2.md`，exit 1：
  `门检查失败（docs/gates/G2.md）：审计报告 sha256 与记录不符（报告改过就重新审计再签）：b386173930739945… != 3e0753072f37a86e…`
- 实测当前全量：61 files / 854 passed / 1 skipped（候选比第 56 轮多 2 个测试）
- 影响：G2 记录不能直接签；重签前要把 `audit_round=57`、本轮报告路径与 sha256、`candidate_hash`、证据哈希和 ev-g2-16 计数一起重算。该失败是预期预签态，不改变 P1 结论。

### P2-2 wait_event_inbox 的 idempotency_key 仍是全局唯一

- 严重度：P2（第 56 轮 P2-5 未处理）
- 位置：`src/infra/sqlite/migrations/018_wait_registrations.sql:11`（`idempotency_key TEXT UNIQUE`）；`src/service/commands/wait.ts:108-112`（`ON CONFLICT (idempotency_key) DO NOTHING` 后按 key 查回）
- 复现：同一 `idempotencyKey='same-key'` 先给 `r1` 记录一次，再给 `r2` 记录一次。
- 实测输出：`WAIT {"a":1,"b":1,"rows":[{"inbox_seq":1,"run_id":"r1","payload_json":"{\"n\":1}"}]}`；第二次调用返回第一次的行号，`r2` 的事件被静默丢弃。
- 影响：不同 run 复用同一幂等键时，后一个 run 的等待事件消失；如果键来自调用方模板或重试器，这是可复现的事件丢失。
- 建议：唯一约束改为 `(run_id, idempotency_key)`，或把 key 纳入 run 作用域后生成。

### 历史 P2 说明

第 56 轮还有 P2-2（父取消 + 子仍在跑需要两轮 sweep）、P2-4（文档仍写 M-01..M-61）、P2-6（普通 agent run 没有 `succeeded` 的生产写入路径）。候选没有触碰这三处，本轮也没有逐条复验；它们不改变本轮“因 P1 判 fail”的结论，但重签前应确认是否仍要登记为例外或后续项。

## 5. 实测命令与计数

| # | 命令 | 退出码 | 关键结果 |
| --- | --- | --- | --- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit` | 0 | 直接 typecheck 通过 |
| 2 | `pnpm --config.verify-deps-before-run=false run typecheck` | 0 | 通过 |
| 3 | `pnpm --config.verify-deps-before-run=false run test` | 0 | 61 files；854 passed；1 skipped（855） |
| 4 | `pnpm --config.verify-deps-before-run=false run build` | 0 | tsdown；`lib/index.js` 250.77 kB；`lib/index.d.ts` 18.07 kB |
| 5 | `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致 |
| 6 | `node scripts/gate-check.ts docs/gates/G2.md` | 1 | 审计报告 sha256 与记录不符（预签态，见 P2-1） |
| 7 | 定向：`vitest run tests/integration/migrate-tool-seq.spec.ts tests/unit/bridge-buffer.spec.ts tests/integration/bridge-ledger.spec.ts tests/integration/apply-report.spec.ts` | 0 | 4 files；91 passed |
| 8 | 探针 A/B：`vitest run tests/audit-r57/probe.spec.ts` | 1 | 3 tests；1 failed；2 passed（失败项即 P1 的“节点仍 queued”） |
| 9 | 探针 wait：`vitest run tests/audit-r57/wait-probe.spec.ts` | 0 | 1 passed；输出见 P2-2 |

环境说明：在审计工作树里直接跑 `pnpm typecheck` / `pnpm build` 会因 `node_modules` 是指向主工作树的 junction 而报 `ERR_PNPM_PACKAGE_MANAGER_SYMLINK_FAILED`（pnpm 的 verify-deps 步骤试图重建 `node_modules/zod`）。这不是候选代码失败；用 `--config.verify-deps-before-run=false` 跑同一脚本 exit 0，直接 `tsc --noEmit` 也 exit 0。主工作树未被修改，主 `node_modules` 仍可用。

## 6. 复现附录

### 6.1 P1 探针结构（示意）

以下代码保留关键调用与断言，省略了与结论无关的参数；实测以本节末尾的输出为准。

```ts
import { describe, expect, it } from 'vitest'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { propagateRunCancellation } from '../../src/service/commands/subworkflow.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { dispatchRun } from '../../src/service/dispatcher.ts'
import { sweep } from '../../src/service/sweep.ts'
import { TEST_SECRET } from '../fixtures/ledger.ts'

describe('audit r57 run-level cancel with queued irreversible', () => {
  it('must not leave the run running forever', async () => {
    const db = openDb(':memory:')
    applySteps(db, loadSteps(defaultMigrationsDir()))
    db.raw.prepare("INSERT INTO tasks (task_id, status, created_at, updated_at) VALUES ('t1','running','2026-11-14T14:00:00.000Z','2026-11-14T14:00:00.000Z')").run()
    db.raw.prepare("INSERT INTO runs (run_id, task_id, status, created_at, updated_at) VALUES ('r1','t1','running','2026-11-14T14:00:00.000Z','2026-11-14T14:00:00.000Z')").run()
    db.raw.prepare("INSERT INTO node_runs (node_run_id, run_id, node_id, status, attempt, revision, side_effect_policy, created_at, updated_at) VALUES ('nr_irr','r1','irr','queued',1,1,'irreversible','2026-11-14T14:00:00.000Z','2026-11-14T14:00:00.000Z')").run()

    const out = withTx(db, (tx) => {
      const r = propagateRunCancellation(tx, TEST_SECRET, { runId: 'r1', cancelResult: 'user_cancelled', now: '2026-11-14T15:00:00.000Z', graceMs: 0, extendDeadlineMs: 0, clock: { now: () => '2026-11-14T15:00:00.000Z' } } as any)
      closeRun(tx, 'r1', '2026-11-14T15:00:00.000Z')
      return r
    })
    const executed: string[] = []
    await dispatchRun({ db, secret: TEST_SECRET, now: '2026-11-14T15:00:01.000Z', executeNode: async (p: any) => { executed.push(p.nodeRunId); return { status: 'done' } } } as any, { runId: 'r1', nodes: { irr: { input: {} } } } as any)
    withTx(db, (tx) => { sweep(tx, { now: '2026-11-14T15:00:02.000Z', secret: TEST_SECRET } as any) })

    console.log('OUT', JSON.stringify(out), 'EXEC', executed)
    const node = db.raw.prepare("SELECT status, attempt, lease_id FROM node_runs WHERE node_run_id='nr_irr'").get()
    const run = db.raw.prepare("SELECT status, cancel_requested_at FROM runs WHERE run_id='r1'").get()
    console.log('NODE', JSON.stringify(node), 'RUN', JSON.stringify(run))
    expect(node.status).not.toBe('queued')
  })
})
```

实测输出：

```text
OUT {"cancelledRuns":[],"cancelledNodes":[],"skippedIrreversible":["nr_irr"]}
EXEC []
NODE {"status":"queued","attempt":1,"lease_id":null}
RUN {"status":"running","cancel_requested_at":"2026-11-14T15:00:00.000Z"}
```

### 6.2 P2-2 探针

```ts
const a = withTx(db, (tx) => recordWaitEvent(tx, { runId: 'r1', eventType: 'evt', payload: { n: 1 }, idempotencyKey: 'same-key', now: '2026-11-14T15:00:00.000Z' }))
const b = withTx(db, (tx) => recordWaitEvent(tx, { runId: 'r2', eventType: 'evt', payload: { n: 2 }, idempotencyKey: 'same-key', now: '2026-11-14T15:00:01.000Z' }))
console.log(JSON.stringify({ a, b, rows: db.raw.prepare('SELECT inbox_seq, run_id, payload_json FROM wait_event_inbox').all() }))
```

实测：`{"a":1,"b":1,"rows":[{"inbox_seq":1,"run_id":"r1","payload_json":"{\"n\":1}"}]}`。

## 7. 签署意见

本轮判 **fail**，G2 不能重签。第 56 轮 P1-1 已经闭合，P1-2 只完成了“dispatch 不再执行”，没有完成“run 级取消能收口”。把 `propagateRunCancellation` 对 `queued/leased` 不可逆节点的跳过改成走 `applyCancel`（或给跳过节点显式终态）后，重新跑本报告第 5 节的 1-7 项，再签 G2。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G2",
  "audit_round": 57,
  "candidate_commit": "df2fc088fc3a2ac66095668bf5f4dcbb5e2fa8a3",
  "conclusion": "fail",
  "p0": 0,
  "p1": 1,
  "p2": 2,
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
  "notes": "G2-04 字面通过：queued irreversible 的 attempt 保持 1，dispatch 不再执行；但 run 级取消后节点仍 queued、run 永久 running，P1 在必过清单之外。P2：G2 记录/ev-g2-16 计数仍是 round51，wait_event_inbox 的 idempotency_key 仍全局唯一。"
}
```
<!-- audit-verdict:end -->
