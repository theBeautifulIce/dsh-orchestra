# S2 独立审计 · G2 · 第 56 轮

- 门：G2（工具执行唯一身份、证据回执、桥、取消、租约、维护扫描、报告回执）
- 候选提交：`af3970b35aadd38f1dc79fa88f631ae55f0f1fc1`（main，已推送）
- 审计时间：2026-11-14
- 审计方式：`git worktree add --detach` 到系统临时目录 `C:\Users\ASUS\AppData\Local\Temp\s2r56-276662a7`，原工作树不落代码改动；临时工作树审计后删除。
- 工作树说明：审计期间原工作树于 22:50–22:57 出现并发修改（`src/service/commands/cancel.ts`、`src/service/dispatcher.ts`、`tests/integration/cancel.spec.ts`、`docs/audits/S3-independent-audit-round8.md`），不是本审计所做；本审计所有命令都在 detached 临时树的 `af3970b` 上运行，原工作树只新增本报告。
- 结论：**fail**。P0=0，P1=2，P2=6。

## 一、实际运行的命令与退出码

| # | 命令（临时 worktree，HEAD=af3970b） | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `pnpm typecheck` | 0 | 无 tsc 错误 |
| 2 | `pnpm test` | 0 | 61 个文件通过；852 passed \| 1 skipped（853）；10.31s |
| 3 | `pnpm build` | 0 | `lib/index.js` 250.29 kB（gzip 59.95），`lib/index.d.ts` 18.07 kB，`lib/client.js` 0.29 kB |
| 4 | `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致 |
| 5 | `pnpm vitest run tests/integration/g2.spec.ts tests/integration/runtime.spec.ts tests/contract/routes.spec.ts tests/e2e/production-path.spec.ts tests/integration/sweep.spec.ts tests/integration/apply-report.spec.ts` | 0 | 6 个文件，150 passed |
| 6 | `pnpm vitest run tests/integration/agent-lifecycle.spec.ts tests/integration/bridge-ledger.spec.ts tests/unit/bridge-buffer.spec.ts tests/integration/runtime.spec.ts tests/e2e/production-path.spec.ts tests/contract/execution-concurrency.spec.ts` | 0 | 6 个文件，73 passed（G2-16 集合） |
| 7 | `pnpm vitest run tests/integration/bridge-ledger.spec.ts tests/unit/bridge-buffer.spec.ts tests/integration/apply-report.spec.ts tests/integration/migrate-tool-seq.spec.ts tests/integration/migrate-s2.spec.ts` | 0 | 5 个文件，97 passed |
| 8 | `pnpm vitest run tests/audit-r56/probe.spec.ts` | 1 | 独立探针 15 条：12 passed，3 failed（见 P1/P2） |
| 9 | `node scripts/gate-check.ts docs/gates/G2.md` | 1 | 首错：`审计报告 sha256 与记录不符（报告改过就重新审计再签）：b386173930739945… != 3e0753072f37a86e…` |

说明：第 2 项在独立探针加入临时工作树之前运行，计数是候选自身干净的 852 passed / 1 skipped。第 9 项先在干净临时树上跑，未跟踪文件会让 gate-check 先报“工作树有未提交改动”，所以先把临时树清干净再复跑。

## 二、结论

**fail。P0=0，P1=2，P2=6。**

第 54 轮的两条 P1 在 af3970b 上已有实质修复，独立的真实终态探针确认：

- 子 run 真实收口为 `succeeded`、`succeeded_with_unverified`、`failed_with_unverified` 时，`sweep` 能唤醒父节点并映射为 `done`/`done`/`failed`，父 run 收口为 `succeeded`/`succeeded`/`failed`；不再只认 `done` 种数据。
- wait 取消后登记转 `cancelled`，同事件再投递只落 inbox，`woken=0`，不抛 409、不丢事件；重复投递同幂等键只落一行。
- `waiting → done` 需要 `controlCompletion=true`（M-63），控制节点不再被报告写回 `queued`（第 54 轮 P2-2 已闭合）。

但本轮仍判 fail：

1. 子 run **自行取消**（不是父 run 取消向下传播）后，父控制节点映射为 `superseded`，却没有 replacement 指针/无副作用证据，`closeRun` 把 `superseded` 当成功中性终态，父 run 落 `succeeded`。
2. run 级取消遇到 `queued` 的 `irreversible` 节点只跳过、不隔离，`dispatcher` 又不看 `runs.cancel_requested_at`，下一次 `dispatch` 仍会执行这个不可逆节点。

第 55 轮因审计期间工作树被并发修改而未形成有效结论；本轮全程使用 detached 临时 worktree，原工作树只保留审计前已有的 `docs/audits/S2-independent-audit-round55.md` 修改，本报告是唯一新增文件。

## 三、逐项结论（20 项必过）

| 必过项 | 内容 | 本轮结论 | 独立依据 |
| --- | --- | --- | --- |
| G2-01 | 单节点 queued 到终态一条路径（走生产装配） | pass | 必过集合 150 passed；证据 25/25 字节复现 |
| G2-02 | 重复上报只落一次 | pass | `tests/integration/g2.spec.ts`、apply-report 集合通过 |
| G2-03 | 租约过期迟到上报被拒 | pass | 必过集合通过；apply-report 迟到/租约用例通过 |
| G2-04 | 取消后不产生新 attempt | **fail** | 节点级取消证据通过；run 级取消后 queued irreversible 仍被下一次 dispatch 执行（P1-2），按条目文字判 fail |
| G2-05 | 终态必带证据 | pass | 证据 `ev-g2-05` 报告无证据被拒；apply-report 证据门通过 |
| G2-06 | 无裸 blocked（没裁决卡不许卡住） | pass | 必过集合通过 |
| G2-07 | S2 加载 parallel 被拒 | pass | 必过集合通过 |
| G-03 | 同一 report_id 上报两次只落一次 | pass | 必过集合通过；证据复现 25/25 |
| G-04 | 租约到期后原执行器迟到上报被拒 | pass | 必过集合通过；证据复现 25/25 |
| G-05 | 工具执行中取消只立一次围栏 | pass | 必过集合通过；证据复现 25/25（哈希漂移见 P2-3） |
| G-07 | 墙钟跳变不误判截止 | pass | 必过集合通过；证据复现 25/25 |
| G2-08 | 工具失败不许落完成（系统判失败并挂凭据） | pass | 必过集合通过；apply-report 集合通过 |
| G2-09 | 判定时限只认 boot_id 与单调纳秒 | pass | 必过集合通过 |
| G2-10 | 报告入口系统级证据门（弱证据与伪造痕迹一律拒） | pass | apply-report 集合 97 passed（含篡改/弱证据） |
| G2-11 | 反复重投同一 report_id 不许把账本刷膨胀 | pass | 必过集合通过 |
| G2-12 | 工具授权只认 workflow 定义，请求体策略不参与 | pass | 必过集合通过 |
| G2-13 | 单写者锁与 epoch 围栏 | pass | 必过集合通过 |
| G2-14 | 长动作靠心跳续租，扫描不误判过期 | pass | 必过集合通过；证据复现 25/25（哈希漂移见 P2-3） |
| G2-15 | 同一工作流同一版本跨重启不可改写 | pass | 必过集合通过 |
| G2-16 | Agent Bridge 生产闭环：B01–B10 可复现，工具证据只来自宿主执行 | pass | G2-16 集合 73 passed；桥/证据集合 97 passed；计数文本漂移见 P2-3 |

必过项统计：**19/20 通过**；`failed_items=["G2-04"]`。

## 四、P0 与 P1

以下文件与行号均按候选 af3970b 的临时 worktree；原工作树若已有后续改动，行号会偏移。

### P0

无。

### P1-1 子 run 自行取消后，父节点 `superseded` 无替换/证据，父 run 却落 `succeeded`

**位置**

- `src/service/commands/subworkflow.ts:411-414`：`finishSubworkflowChild` 把子 run 的 `superseded`/`cancelled` 映射为父节点 `superseded`。
- `src/service/commands/run-close.ts:57-61`：只有 `runs.cancel_requested_at` 非空才落 `cancelled`；否则 `superseded` 节点不被视为失败/孤儿，最后落到 `else succeeded`。
- `tests/integration/subworkflow.spec.ts:226`：候选自己的“取消的子 run”用例预先给父 run 写了 `cancel_requested_at`，只覆盖父取消向下传播，掩盖了子 run 自行取消。

**复现**

临时 worktree 内：

```powershell
cd %TEMP%\s2r56-276662a7
pnpm vitest run tests/audit-r56/probe.spec.ts -t "cancelled（子 run 自身取消）"
```

探针 `tests/audit-r56/probe.spec.ts:64-86,107-111` 先建父 run `r1` 与 `waiting` 控制节点 `nr_parent`，再建子 run `rc`，给 `rc` 写 `cancel_requested_at`，用真实 `closeRun(tx,'rc',NOW)` 让子 run 落 `cancelled`，然后 `sweep`，读父 run/父节点。

**期望 / 实际**

- 期望：父 run 落 `cancelled`（或至少 `orphaned`/`failed`），不能落 `succeeded`；若父节点保留 `superseded`，必须有 `replacement_node_run_id` 与“无不可逆副作用”的证据。
- 实际：父节点 `superseded`，父 run `succeeded`；子 run 自身仍是 `cancelled`。探针在 `probe.spec.ts:110` 断言 `parentRun.status !== 'succeeded'` 失败。

**影响**

子流程被取消后，父 run 以“成功”终态收口，终态语义与证据不一致；`superseded` 的“有替换、无副作用”前提没有被满足。这是终端映射的真实缺口，不是证据复现问题。

### P1-2 run 级取消跳过 `queued` 的 `irreversible` 节点，但 dispatcher 无取消闸，下一次 dispatch 仍执行它

**位置**

- `src/service/commands/subworkflow.ts:477-479`：`propagateRunCancellation` 遇到 `irreversible` 节点只记 `skippedIrreversible` 并 `continue`，节点保持 `queued`。
- `src/service/dispatcher.ts:56-59`：`dispatchRun` 只按 `run_id` + `status='queued'` 选节点，没有 `runs.cancel_requested_at`/`cancel_result` 谓词。
- `src/service/commands/cancel.ts:46-53`：单节点 `applyCancel` 对 `irreversible` 抛 `FORBIDDEN '不可逆子节点不许取消'`；run 级传播选择跳过而不是隔离，两条路径语义不一致。

**复现**

```powershell
cd %TEMP%\s2r56-276662a7
pnpm vitest run tests/audit-r56/probe.spec.ts -t "irreversible"
```

探针 `probe.spec.ts:181-201`：run `r1` 下放一个 `queued`、`side_effect_policy='irreversible'` 的 `nr_irr`；`propagateRunCancellation` 后断言 `skippedIrreversible=['nr_irr']`、节点仍 `queued`、run 仍 `running`、`closeRun=null`；随后调用 `dispatchRun`，执行桩记录实际执行的 node。

**期望 / 实际**

- 期望：run 已有取消请求时，`dispatchRun` 不得再执行该 run 的任何节点；被跳过的不可逆节点应进入明确的隔离终态（如 `blocked`/待人工裁决），不能留在可被普通派发拾起的 `queued`。
- 实际：`dispatchRun` 执行了 `nr_irr`，执行桩收到 `['nr_irr']`；探针 `probe.spec.ts:200` 断言 `executed=[]` 失败。

**影响**

取消无法阻止不可逆副作用；最坏情况下先产生不可逆副作用，随后 run 因 `cancel_requested_at` 落 `cancelled`，账本却显示“取消成功”。第 55 轮 P1-2 在 run 级取消路径上仍然成立。

## 五、P2

1. **`leased → superseded` 未清租约字段。** `src/service/commands/cancel.ts:55-68` 只写 `cancel_requested_at`/`cancel_result`，不清 `lease_id`、`lease_expires_at`；探针 `probe.spec.ts:161-162` 在 `queued+leased` 用例里断言两者为空失败（实际 `lease_id='lease_l'`）。影响：`superseded` 节点仍带租约，后续租约扫描/审计会把已终态节点当成在飞执行器。复现：`pnpm vitest run tests/audit-r56/probe.spec.ts -t "queued + leased"`。
2. **父取消 + 子 run 仍 running 时，一次 `sweep` 收不干净，需要第二轮。** `src/service/sweep.ts:337-352` 先处理 `finishedChildren`，再对 `runs WHERE status='running' ORDER BY run_id` 做快照收口；`r1` 排在 `rc` 前，父 `closeRun` 先跑、子还没收口，父保持 `running`；第二次 `sweep` 才把父收成 `cancelled`。影响：收敛但非一轮到位，扫描间隔长时父 run 悬空；若调用方只跑一轮就认为“无空 dispatch 即收口”，会误判。复现：`pnpm vitest run tests/audit-r56/probe.spec.ts -t "父 run 取消且子 run 仍 running"`。
3. **G2 门记录仍是签前态，证据表/锚点/计数漂移。** `docs/gates/G2.md:88` 记 `ev-g2-14=61e9c435…`，HEAD LF 实际 `77755fa7…`；`:93` 记 `G-05=d400f29d…`，HEAD LF 实际 `d6288170…`；`docs/gates/evidence/G2/ev-g2-16.md:51` 写 `6 files passed, 70 tests passed`、`:54` 写 `42 files passed, 624 passed | 1 skipped`，本轮实测 73 passed、61 files/852 passed | 1 skipped。门 artifact 仍锚 `audit_round=51`、报告 `b386173930…`、候选 `8fa91fbb…`。`check-evidence-repro` 25/25 通过，说明证据字节可复现；漂移来自 af3970b 给 G-05/ev-g2-14 的 sweep JSON 增加了 `"runs_closed":[]`，签门脚本会重写证据表与索引哈希。影响：签前必须刷新，不能拿旧表直接签。
4. **设计文档仍写 M-01…M-61，代码已到 M-64/M-65。** `src/core/state-machine.ts:165-168` 有 M-63/M-64/M-65；`docs/orchestra-design-draft.md:327`、`docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md:947`、`:1167` 仍写 M-01…M-61。影响：G3 的“迁移表闭合/61 条全绿”口径与代码不一致，签 G3 前必须同步。
5. **`wait_event_inbox.idempotency_key` 全局 UNIQUE，跨 run 同键会静默丢事件。** `src/infra/sqlite/migrations/018_wait_registrations.sql:11` 是全局 `UNIQUE`；`src/service/commands/wait.ts:111` 按全局键回读 `inbox_seq`。两个 run 用同一业务事件键时，第二个 run 的 inbox 行被 `DO NOTHING` 丢掉，`woken=0`，事件不再属于它。影响：多 run 共享事件键时漏唤醒；建议把唯一性限定到 `(run_id, idempotency_key)`。
6. **普通 agent run 的 `succeeded` 终态没有生产写入路径。** `src/service/commands/run-close.ts:52` 对 `side_effect_policy!=='pure' && side_effect_verified_none!==1` 一律记 `succeeded_with_unverified`；全仓 `rg -n side_effect_verified_none src` 只看到读取和迁移默认值 0，没有写入 1 的路径。影响：`succeeded` 目前只有纯控制节点 run 可达，普通 agent run 永远落 `succeeded_with_unverified`；终态枚举虽补齐，生产语义仍是单边。属待确认的设计缺口，不阻断本轮 P1 判定，但签 G2 时应在门记录里写明。

## 六、证据漂移核对（G-05、ev-g2-14）

| 证据 | 门记录 sha256 | HEAD LF sha256 | 结论 |
| --- | --- | --- | --- |
| `docs/gates/evidence/G2/G-05.md` | `d400f29ddeb1e0578c132e0a9abef1e0e3fc123179bfd90a692f526564285f4c` | `d6288170047c2fc02ceea2dab4ba799e4879e381594a0e9484480da39b3b3ae6` | 不一致 |
| `docs/gates/evidence/G2/ev-g2-14.md` | `61e9c435b7d6b652e87889190af7e932ff54799f4d21d4e2b538f5ec3f050896` | `77755fa7a575af95b8c9d24df6279cde50940108f6863b8a00fd85a3d0706e7e` | 不一致 |
| `docs/gates/evidence/G2/ev-g2-16.md` | `8caea691cb48306c222f05fef387f96a5a5abf984cf05bb926eb420328575a76` | `8caea691cb48306c222f05fef387f96a5a5abf984cf05bb926eb420328575a76` | 一致 |

两份不一致的根因是候选 af3970b 只改了 `G-05.md`、`ev-g2-14.md`（以及 G3/full-suite）里的 sweep 结果，增加 `"runs_closed":[]` 字段；`check-evidence-repro` 25/25 通过，说明新字节能由脚本重跑出来。门表未刷新属于签前态，不是代码缺陷，但必须随重签一起重算。

## 七、gate-check 失败的真实原因与重签条件

`node scripts/gate-check.ts docs/gates/G2.md` 在干净临时树上的首错是审计锚点：

- `docs/gates/G2.md` 记 `audit_report_sha256=b386173930739945…`，当前 `docs/audits/S2-independent-audit-round51.md` 的 LF sha 是 `3e0753072f37a86e…`；门记录仍锚在 round51，而本轮是 round56。
- 其后还会失败：候选已前进到 af3970b，`candidate_hash` / `change_scope_hash` 必变；`G-05`、`ev-g2-14` 两份证据表 sha 未刷新；`evidence_index_hash`、`body_hash`、`artifact_hash` 需随正文与证据表重算。

本轮判 **fail**，不具备重签条件。先修 P1-1（子 run 自行取消的父 run 终态与证据）与 P1-2（run 级取消后 dispatcher 不得再执行，不可逆节点隔离），再处理 P2-1/P2-2/P2-3 的租约、收口轮次、门记录与证据表，之后按既有顺序重签 G1/G2。现在不能重签 G2。

## 八、failed_items 与裁决

`failed_items=["G2-04"]`。20 项必过中 19 项通过；两条 P1 分别落在子 run 取消的父 run 终态（P1-1）与 run 级取消后的派发闸（P1-2），其中 P1-2 直接对应 G2-04 的“取消后不产生新 attempt”。

<!-- audit-verdict:begin -->
```json
{"schema":"audit-verdict/1","gate":"G2","audit_round":56,"candidate_commit":"af3970b35aadd38f1dc79fa88f631ae55f0f1fc1","conclusion":"fail","p0":0,"p1":2,"p2":6,"must_pass_total":20,"must_pass_passed":19,"must_pass_ids":["G2-01","G2-02","G2-03","G2-04","G2-05","G2-06","G2-07","G-03","G-04","G-05","G-07","G2-08","G2-09","G2-10","G2-11","G2-12","G2-13","G2-14","G2-15","G2-16"],"failed_items":["G2-04"],"notes":"全量 852 passed / 1 skipped、必过 150 passed、G2-16 73 passed、桥/证据 97 passed、typecheck/build/check-evidence exit 0；gate-check exit 1（审计报告 sha b386… != 3e075307…，签前态）。P1-1：子 run 自行取消→父节点 superseded 无 replacement/证据→父 run succeeded（subworkflow.ts:411-414、run-close.ts:57-61；候选测试 subworkflow.spec.ts:226 预写父 cancel_requested_at 掩盖）。P1-2：run 级取消跳过 queued irreversible 节点但 dispatcher 无取消闸，下一次 dispatch 仍执行（subworkflow.ts:477-479、dispatcher.ts:56-59），对应 G2-04 fail。P2：leased→superseded 残留租约；父取消+子 running 需两轮 sweep；G2 门记录/两份证据 sha/ev-g2-16 计数过期；设计文档仍 M-01…M-61；wait_event_inbox 幂等键全局唯一；普通 agent run 的 succeeded 无生产写入路径。"}
```
<!-- audit-verdict:end -->

## 附录 A：独立探针源码（审计后从临时 worktree 删除）

以下文件在临时 worktree 的 `tests/audit-r56/probe.spec.ts` 运行；重建时把本附录内容原样放入该路径，再跑 `pnpm vitest run tests/audit-r56/probe.spec.ts`。

```ts
// 独立审计探针（round56）：只读取账本行为，不改动候选源码。
// 运行：pnpm vitest run tests/audit-r56/probe.spec.ts
import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import type { Db, Tx } from '../../src/infra/sqlite/driver.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { sweep } from '../../src/service/sweep.ts'
import { propagateRunCancellation } from '../../src/service/commands/subworkflow.ts'
import { enterWaiting, wakeOnEvent, getWaitRegistration } from '../../src/service/commands/wait.ts'
import { applyCancel } from '../../src/service/commands/cancel.ts'
import { dispatchRun } from '../../src/service/dispatcher.ts'
import { BridgeLedger } from '../../src/executor/bridge-ledger.ts'
import { BridgeEventBuffer, type BridgeEvent } from '../../src/executor/bridge.ts'

const NOW = '2026-11-14T00:00:00.000Z'
const LATER = '2026-11-14T00:10:00.000Z'
const dirs: string[] = []
const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.raw.close() } catch { /* 已关闭 */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function ledger(): { db: Db; dir: string } {
  const { db, dir } = freshLedger()
  dirs.push(dir); dbs.push(db)
  return { db, dir }
}

function task(tx: Tx): void {
  tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '审计探针', 'running', 1, ?, ?)", [NOW, NOW])
}

function run(tx: Tx, runId: string, opts: { status?: string; parentRunId?: string | null; parentNodeRunId?: string | null; cancelRequestedAt?: string | null; rootRunId?: string } = {}): void {
  tx.run(
    'INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at, parent_run_id, parent_node_run_id, root_run_id, cancel_requested_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
    [runId, 't1', opts.status ?? 'running', NOW, NOW, opts.parentRunId ?? null, opts.parentNodeRunId ?? null, opts.rootRunId ?? runId, opts.cancelRequestedAt ?? null],
  )
}

function node(tx: Tx, id: string, runId: string, opts: { status: string; nodeId?: string; seq?: number; policy?: string; parentNodeRunId?: string | null; verifiedNone?: number }): void {
  tx.run(
    'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at, parent_node_run_id, side_effect_policy, side_effect_verified_none) VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?, ?, ?)',
    [id, runId, opts.nodeId ?? id, opts.seq ?? 1, 'agent', opts.status, NOW, NOW, opts.parentNodeRunId ?? null, opts.policy ?? 'pure', opts.verifiedNone ?? 1],
  )
}

function base(tx: Tx): void {
  task(tx)
  run(tx, 'r1')
}

function readRun(tx: Tx, runId: string): { status: string; cancel_requested_at: string | null; cancel_result: string | null } {
  return tx.get('SELECT status, cancel_requested_at, cancel_result FROM runs WHERE run_id = ?', [runId])!
}

function readNode(tx: Tx, id: string): { status: string; revision: number; fence_state: string | null; cancel_requested_at: string | null; lease_id: string | null; lease_expires_at: string | null } {
  return tx.get('SELECT status, revision, fence_state, cancel_requested_at, lease_id, lease_expires_at FROM node_runs WHERE node_run_id = ?', [id])!
}

function childTerminal(status: 'succeeded' | 'succeeded_with_unverified' | 'failed_with_unverified' | 'cancelled'): { db: Db; parentRun: ReturnType<typeof readRun>; parentNode: ReturnType<typeof readNode> } {
  const { db } = ledger()
  withTx(db, (tx) => {
    task(tx)
    run(tx, 'r1')
    node(tx, 'nr_parent', 'r1', { status: 'waiting', policy: 'pure', seq: 1 })
    run(tx, 'rc', { parentRunId: 'r1', parentNodeRunId: 'nr_parent', rootRunId: 'r1' })
    if (status === 'cancelled') {
      tx.run('UPDATE runs SET cancel_requested_at = ? WHERE run_id = ?', [NOW, 'rc'])
      node(tx, 'nrc', 'rc', { status: 'done', policy: 'pure', verifiedNone: 1 })
    } else if (status === 'succeeded') {
      node(tx, 'nrc', 'rc', { status: 'done', policy: 'pure', verifiedNone: 1 })
    } else if (status === 'succeeded_with_unverified') {
      node(tx, 'nrc', 'rc', { status: 'done', policy: 'compensable', verifiedNone: 0 })
    } else {
      node(tx, 'nrc', 'rc', { status: 'failed', policy: 'compensable', verifiedNone: 0 })
    }
    const got = closeRun(tx, 'rc', NOW)
    if (got !== status) throw new Error(`expected child ${status}, got ${got}`)
  })
  sweep(db, TEST_SECRET, { now: NOW })
  return withTx(db, (tx) => ({ db, parentRun: readRun(tx, 'r1'), parentNode: readNode(tx, 'nr_parent') }))
}

describe('A. 子 run 真实终态 → 父节点映射 → 父 run 收口', () => {
  it('succeeded：父节点 done，父 run succeeded', () => {
    const r = childTerminal('succeeded')
    expect(r.parentNode.status).toBe('done')
    expect(r.parentRun.status).toBe('succeeded')
  })

  it('succeeded_with_unverified：父节点 done，父 run succeeded（子 run 保留 unverified）', () => {
    const r = childTerminal('succeeded_with_unverified')
    expect(r.parentNode.status).toBe('done')
    expect(r.parentRun.status).toBe('succeeded')
  })

  it('failed_with_unverified：父节点 failed，父 run failed', () => {
    const r = childTerminal('failed_with_unverified')
    expect(r.parentNode.status).toBe('failed')
    expect(r.parentRun.status).toBe('failed')
  })

  it('cancelled（子 run 自身取消）：父节点 superseded，父 run 不能是 succeeded', () => {
    const r = childTerminal('cancelled')
    expect(r.parentNode.status).toBe('superseded')
    expect(r.parentRun.status).not.toBe('succeeded')
  })
})

describe('B. wait 取消后的登记与事件投递', () => {
  it('取消登记后同事件只落 inbox，不 409、不丢事件；重复投递不重复落行', () => {
    const { db } = ledger()
    withTx(db, (tx) => {
      base(tx)
      node(tx, 'nr_wait', 'r1', { status: 'started', policy: 'pure', seq: 1 })
      tx.run('UPDATE runs SET cancel_requested_at = ?, cancel_result = ? WHERE run_id = ?', [NOW, 'interrupted', 'r1'])
      enterWaiting(tx, TEST_SECRET, {
        nodeRunId: 'nr_wait', attempt: 1, runId: 'r1', waitKind: 'event',
        match: { type: 'ticket.paid' }, idempotencyKey: 'wait-w1', maxWaitMs: 60_000, now: NOW,
      })
      const waiting = readNode(tx, 'nr_wait')
      applyCancel(tx, TEST_SECRET, {
        nodeRunId: 'nr_wait', attempt: 1, revision: waiting.revision,
        cancelResult: 'interrupted', now: NOW, graceMs: 5_000,
      })
      expect(readNode(tx, 'nr_wait').status).toBe('superseded')
      expect(getWaitRegistration(tx, 'nr_wait')!.state).toBe('cancelled')
      const first = wakeOnEvent(tx, TEST_SECRET, {
        runId: 'r1', eventType: 'ticket.paid', payload: { order: 1 }, idempotencyKey: 'evt-1', now: NOW,
      })
      expect(first.woken).toBe(0)
      const second = wakeOnEvent(tx, TEST_SECRET, {
        runId: 'r1', eventType: 'ticket.paid', payload: { order: 1 }, idempotencyKey: 'evt-1', now: NOW,
      })
      expect(second.woken).toBe(0)
      expect((tx.get('SELECT COUNT(*) AS n FROM wait_event_inbox') as { n: number }).n).toBe(1)
      expect((tx.get('SELECT event_type FROM wait_event_inbox LIMIT 1') as { event_type: string }).event_type).toBe('ticket.paid')
    })
  })
})

describe('C. run 级取消', () => {
  it('queued + leased 的 pure 节点被收成 superseded，run 落 cancelled', () => {
    const { db } = ledger()
    const out = withTx(db, (tx) => {
      base(tx)
      node(tx, 'nr_q', 'r1', { status: 'queued', policy: 'pure', seq: 1 })
      node(tx, 'nr_l', 'r1', { status: 'leased', policy: 'pure', seq: 2 })
      tx.run("UPDATE node_runs SET lease_id = 'lease_l', lease_expires_at = ? WHERE node_run_id = 'nr_l'", [LATER])
      const p = propagateRunCancellation(tx, TEST_SECRET, { runId: 'r1', cancelResult: 'interrupted', now: NOW, graceMs: 5_000 })
      const closed = closeRun(tx, 'r1', NOW)
      return { p, closed, q: readNode(tx, 'nr_q').status, l: readNode(tx, 'nr_l'), run: readRun(tx, 'r1') }
    })
    expect(out.p.cancelledNodes.sort()).toEqual(['nr_l', 'nr_q'])
    expect(out.q).toBe('superseded')
    expect(out.l.status).toBe('superseded')
    expect(out.l.lease_id).toBeNull()
    expect(out.l.lease_expires_at).toBeNull()
    expect(out.closed).toBe('cancelled')
    expect(out.run.status).toBe('cancelled')
  })

  it('started 的 pure 节点被取消到 timing_out 并立围栏，run 暂不收口', () => {
    const { db } = ledger()
    const out = withTx(db, (tx) => {
      base(tx)
      node(tx, 'nr_s', 'r1', { status: 'started', policy: 'pure', seq: 1 })
      propagateRunCancellation(tx, TEST_SECRET, { runId: 'r1', cancelResult: 'interrupted', now: NOW, graceMs: 5_000 })
      return { node: readNode(tx, 'nr_s'), run: readRun(tx, 'r1'), closed: closeRun(tx, 'r1', NOW) }
    })
    expect(out.node.status).toBe('timing_out')
    expect(out.node.fence_state).toBe('armed')
    expect(out.run.cancel_requested_at).toBe(NOW)
    expect(out.closed).toBeNull()
  })

  it('queued 的 irreversible 节点被 skip 后，下一次 dispatch 仍会执行它', async () => {
    const { db } = ledger()
    withTx(db, (tx) => {
      base(tx)
      node(tx, 'nr_irr', 'r1', { status: 'queued', policy: 'irreversible', seq: 1 })
      const p = propagateRunCancellation(tx, TEST_SECRET, { runId: 'r1', cancelResult: 'interrupted', now: NOW, graceMs: 5_000 })
      expect(p.skippedIrreversible).toEqual(['nr_irr'])
      expect(readNode(tx, 'nr_irr').status).toBe('queued')
      expect(readRun(tx, 'r1').status).toBe('running')
      expect(closeRun(tx, 'r1', NOW)).toBeNull()
    })
    const executed: string[] = []
    await dispatchRun({
      db,
      executeNode: async (p) => {
        executed.push(p.nodeRunId)
        return { final_status: 'done', agent_id: 'audit', evidence: { source: 'audit-probe' } }
      },
    } as never, { runId: 'r1', now: LATER, nodes: { nr_irr: { tools: [] } } })
    expect(executed).toEqual([])
  })

  it('父 run 取消且子 run 仍 running：一次 sweep 后子/父都应落 cancelled', () => {
    const { db } = ledger()
    withTx(db, (tx) => {
      base(tx)
      node(tx, 'nr_parent', 'r1', { status: 'waiting', policy: 'pure', seq: 1 })
      run(tx, 'rc', { parentRunId: 'r1', parentNodeRunId: 'nr_parent', rootRunId: 'r1' })
      node(tx, 'nrc', 'rc', { status: 'queued', policy: 'pure', seq: 1 })
      propagateRunCancellation(tx, TEST_SECRET, { runId: 'r1', cancelResult: 'interrupted', now: NOW, graceMs: 5_000 })
      expect(closeRun(tx, 'r1', NOW)).toBeNull()
    })
    sweep(db, TEST_SECRET, { now: NOW })
    const afterFirst = withTx(db, (tx) => ({ child: readRun(tx, 'rc').status, parent: readRun(tx, 'r1').status }))
    expect(afterFirst.child).toBe('cancelled')
    sweep(db, TEST_SECRET, { now: LATER })
    const after = withTx(db, (tx) => ({ child: readRun(tx, 'rc').status, parent: readRun(tx, 'r1').status }))
    expect(after.child).toBe('cancelled')
    expect(after.parent).toBe('cancelled')
  })
})

describe('D. closeRun 与 sweep 收口', () => {
  it('非终态节点存在时 closeRun 返回 null，sweep 不误收', () => {
    const { db } = ledger()
    withTx(db, (tx) => {
      base(tx)
      node(tx, 'nr_x', 'r1', { status: 'started', policy: 'pure', seq: 1 })
      expect(closeRun(tx, 'r1', NOW)).toBeNull()
    })
    const s = sweep(db, TEST_SECRET, { now: NOW })
    expect(s.runs_closed).toEqual([])
    withTx(db, (tx) => { expect(readRun(tx, 'r1').status).toBe('running') })
  })

  it('cancel_requested_at 已写且节点全终态：closeRun 落 cancelled', () => {
    const { db } = ledger()
    withTx(db, (tx) => {
      base(tx)
      tx.run('UPDATE runs SET cancel_requested_at = ?, cancel_result = ? WHERE run_id = ?', [NOW, 'interrupted', 'r1'])
      node(tx, 'nr_d', 'r1', { status: 'done', policy: 'pure', seq: 1 })
      expect(closeRun(tx, 'r1', NOW)).toBe('cancelled')
      expect(readRun(tx, 'r1').status).toBe('cancelled')
    })
  })

  it('无空 dispatch 时 sweep 收口所有节点已终态的 running run', () => {
    const { db } = ledger()
    withTx(db, (tx) => {
      base(tx)
      node(tx, 'nr_d', 'r1', { status: 'done', policy: 'pure', seq: 1 })
    })
    const s = sweep(db, TEST_SECRET, { now: NOW })
    expect(s.runs_closed).toEqual(['r1'])
    withTx(db, (tx) => { expect(readRun(tx, 'r1').status).toBe('succeeded') })
  })
})

describe('E. 工具执行唯一身份', () => {
  it('tool_executions 的主键与 execution_id 唯一约束生效', () => {
    const { db } = ledger()
    const cols = db.raw.prepare("PRAGMA table_info('tool_executions')").all() as { name: string; pk: number }[]
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['tool_seq', 'execution_id']))
    expect(cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)).toEqual(['node_run_id', 'attempt', 'tool_seq'])
    const ins = db.raw.prepare('INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code) VALUES (?, ?, ?, ?, ?, ?)')
    ins.run('nr1', 1, 1, 'a', 'tex_one', 0)
    ins.run('nr1', 1, 2, 'a', 'tex_two', 0)
    expect(() => ins.run('nr1', 1, 1, 'a', 'tex_three', 0)).toThrowError(/UNIQUE|PRIMARY/i)
    expect(() => ins.run('nr1', 1, 3, 'b', 'tex_one', 0)).toThrowError(/UNIQUE|PRIMARY/i)
    const n = db.raw.prepare('SELECT COUNT(*) AS n FROM tool_executions').get() as { n: number }
    expect(Number(n.n)).toBe(2)
  })
})

describe('F. 桥三游标与同 seq 幂等/冲突', () => {
  it('同 seq 同 payload 幂等，不同 payload 抛 BRIDGE_SEQ_CONFLICT，游标只到已落账位', () => {
    const { db } = ledger()
    seed(db)
    const bl = new BridgeLedger(db, TEST_SECRET, { nodeRunId: 'nr1', attempt: 1, executorAgentId: 'a1' })
    const e1: BridgeEvent = { seq: 1, type: 'step', at: NOW, toolStartAt: null, payload: { n: 1 } }
    expect(bl.ingest(e1).appended).toBe(true)
    expect(bl.ingest(e1).appended).toBe(false)
    let conflict: unknown
    try { bl.ingest({ ...e1, payload: { n: 2 } }) } catch (err) { conflict = err }
    expect((conflict as { code?: string }).code).toBe('BRIDGE_SEQ_CONFLICT')
    expect(bl.cursor()).toBe(1)
    expect(() => bl.ingest({ ...e1, seq: 3 })).toThrowError(/不连续/)
  })

  it('BridgeEventBuffer 三游标：received / contiguous / persistedAck', () => {
    const { db, dir } = ledger()
    seed(db)
    const bl = new BridgeLedger(db, TEST_SECRET, { nodeRunId: 'nr1', attempt: 1, executorAgentId: 'a1' })
    bl.ingest({ seq: 1, type: 'step', at: NOW, toolStartAt: null, payload: { n: 1 } })
    const buf = new BridgeEventBuffer(
      { limitBytes: 8192, highWaterBytes: 4096, spillDir: dir, agentId: 'a1' },
      { lastPersistedAckSeq: bl.cursor(), lookupPersisted: (seq) => bl.lookup(seq) },
    )
    expect(buf.lastPersistedAckSeq).toBe(1)
    const pushed = buf.push({ seq: 2, type: 'step', at: NOW, toolStartAt: null, payload: { n: 2 } })
    expect(pushed.accepted).toBe(true)
    bl.ingest({ seq: 2, type: 'step', at: NOW, toolStartAt: null, payload: { n: 2 } })
    expect(buf.lastContiguousSeq).toBe(2)
    buf.ack(2, bl.cursor())
    expect(buf.lastReceivedSeq).toBe(2)
    expect(buf.lastContiguousSeq).toBe(2)
    expect(buf.lastPersistedAckSeq).toBe(2)
    expect(() => buf.ack(3, 2)).toThrow()
  })
})
```
