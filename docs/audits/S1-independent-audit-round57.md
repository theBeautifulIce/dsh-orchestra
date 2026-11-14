# S1 独立审计报告 · 第 57 轮（G1）

门：G1
候选提交：df2fc088fc3a2ac66095668bf5f4dcbb5e2fa8a3
审计轮次：57
审计基线：af3970b（round56 判 pass，只作增量边界对照）
审计环境：detached worktree `C:\Users\ASUS\AppData\Local\Temp\orch-audit-r57`（审计结束即删除）；Windows；node v26.13.1；pnpm 12.3.4
审计者：audit-s1-r57（独立 subagent，未参与实现）

## 一、裁决

结论：pass

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G1",
  "audit_round": 57,
  "candidate_commit": "df2fc088fc3a2ac66095668bf5f4dcbb5e2fa8a3",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 4,
  "must_pass_total": 13,
  "must_pass_passed": 13,
  "must_pass_ids": ["G1-01", "G1-02", "G1-03", "G1-04", "G1-05", "G1-06", "G1-07", "G-01", "G-02", "G-08", "G-09", "G-14", "G-15"],
  "failed_items": [],
  "notes": "只新增取消相关修复；节点级作废、派发前二次检查、子 run 自行取消均自洽，G1 不变量未破。P2-1 为 run 级传播与派发守卫叠加出的卡死缺口（不可逆策略当前无生产写入口，纵深防御）；P2-2/P2-3 为 round56 结转；P2-4 为 G1 记录仍锚 round51，重签即清。"
}
```
<!-- audit-verdict:end -->

本轮结论只绑定 df2fc08 的实跑结果；af3970b 的材料只用于确认增量边界，不作为放行依据。

## 二、审计范围

- 候选范围 `af3970b..df2fc08`：10 个文件，+995/-18。
- 生产代码只有三处：`src/service/commands/cancel.ts`（+13/-10）、`src/service/commands/subworkflow.ts`（+7/-1）、`src/service/dispatcher.ts`（+8/-0）；测试两件；其余是审计报告与 G3 证据计数（852→854）。
- 零个 `*.sql` 变更（迁移仍 23 份，末位 `023_verify_started_at.sql`）、零个 `src/core/state-machine.ts` 变更、零个 `src/infra` 变更。
- 全部命令在 detached worktree 内执行，审计结束前工作树干净；主工作树只新增本报告，不改代码。

## 三、实测命令与退出码

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm test` | 0 | Test Files 61 passed；Tests 854 passed / 1 skipped（855）；24.67s |
| `pnpm build` | 0 | ESM `lib/index.js` 250.77 kB（gzip 60.04 kB）；`lib/index.d.ts` 18.07 kB；CJS `lib/client.js` 0.29 kB |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | 证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致 |
| `node scripts/gate-check.ts docs/gates/G1.md` | 1 | 门检查失败（docs/gates/G1.md）：审计报告 sha256 与记录不符（报告改过就重新审计再签）：355a1a582b5584c0… != e3eee74611c3a681… |
| `pnpm exec vitest run tests/audit-r57/probe.spec.ts` | 0 | 1 file / 1 test passed；PROBE_A 三行输出见 6.1 |
| `pnpm exec vitest run tests/gate/gate-check.spec.ts` | 0 | 183 passed / 1 skipped（184） |
| `pnpm exec vitest run tests/unit/execution-scheduler.spec.ts` | 0 | 15 passed |
| `pnpm exec vitest run`（g1、migrate、backup、hash-chain、db-open、run-close、auth、config 八件） | 0 | 8 files / 68 tests passed |

最后一行的门检查退出码 1 需要解释：G1.md 仍锚在 round51 的报告字节（355a…）上，而 HEAD 里的 round51 报告已是改后版本（e3ee…）。这是存量记录滞后，即 6.4 的 P2-4；重签时 sign-gate 会重算该字段。门检查在审计锚点处先失败，后续证据/正文/候选检查没有执行，因此本报告用独立脚本逐项复核（第五、六节），并用重签演练证明整条链能过（第七节）。

## 四、本轮增量复核

### 4.1 未派发节点取消（cancel.ts）

- 顺序调整：queued/leased 判定移到不可逆判定之前（`src/service/commands/cancel.ts:47-68`，不可逆拒绝在 :70）。语义：节点还没执行，作废不会掩盖副作用，因此 queued/leased 的 irreversible 也允许 superseded。
- 状态机路由：`src/core/state-machine.ts:208` 的 M-62 允许 queued/leased→superseded，trigger `cancel-before-dispatch`，无 requires。
- 落账：同事务内 applyTransition（带 expectedRevision、allowHung），patch 清 lease_id/lease_expires_at 并写 cancel_requested_at/cancel_result，追加 cancel_before_dispatch 事件，返回 cancelled_before_dispatch。
- 测试：`tests/integration/cancel.spec.ts:31` 覆盖 queued+irreversible 的作废与清租约。
- 判定：节点级取消路径自洽，没有把已执行节点当未执行处理。

### 4.2 派发前二次检查（dispatcher.ts）

- `src/service/dispatcher.ts:78-85`：进入 dispatchOne 先查 runs.cancel_requested_at，命中即返回 skipped/run_cancelled，不执行、不改节点状态。
- 判定：堵住了「选行后到执行前」的取消窗口，方向正确；副作用是节点留在 queued，见 6.1。

### 4.3 子 run 自行取消（subworkflow.ts）

- `src/service/commands/subworkflow.ts:411-426`：parentCancelled 取父 run 的 cancel_requested_at；childCancelled 取 CHILD_CANCELLED（:346，superseded/cancelled）；目标是三选一：子成功 done；父子都取消 superseded；其余 failed。
- 用 `context.controlCompletion=true` 走 waiting→failed/superseded，满足 M-64/M-65 的 requires（`src/core/state-machine.ts:167-168`）。
- 测试：`tests/integration/subworkflow.spec.ts:218` 覆盖子自行取消、父未取消→failed，且 closeRun 收 failed 而非 succeeded。
- 判定：与 G-16「取消的子运行收口父节点为 superseded、父 run 落 cancelled」并列成立，没有把父 run 收成 succeeded。

## 五、G1 语义复核

### 5.1 调度双入口同一闸，默认上限 3

- `src/index.ts:99-104` 只有一个 executeNode 底层实现，`:111-112` `executeScheduled = runThroughScheduler(opts.scheduler, () => executeNode(p))`；两个入口都走它：`:211` dispatchRun 注入 `executeNode: executeScheduled`，`:224` 单节点 runNode 也调用 executeScheduled。
- dispatcher 不再持有/调用 scheduler（`src/service/dispatcher.ts:46` 注释）；`src/service/execution-scheduler.ts:9` DEFAULT_EXECUTION_CONCURRENCY=3，`:215` concurrency 缺省 3，`:231-241` 无外部 scheduler 时共用 fallbackScheduler。
- 实测：`tests/unit/execution-scheduler.spec.ts` 15 passed，`:133-135` 断言默认值 3，`:201-210` 以真实执行的最大并发断言 maxActive===3，`:213-247` 断言 dispatcher 只调用注入的 executeNode、不二次排队。
- 判定：成立，本轮未改这条装配。

### 5.2 账本/迁移只追加

- 候选零 `*.sql` 变更；迁移 23 份，末位仍是 `023_verify_started_at.sql`；MIGRATION_CASE_IDS（`src/core/state-machine.ts:270-276`）尾部仍是追加的 M-61…M-65，无删改。
- 事件与节点事件只追加，哈希链可检出篡改（不变量 I2，ev-chain 在 check-evidence-repro 内逐份复跑）。
- 实测：check-evidence-repro exit 0，25 份×2 遍与 HEAD 字节一致。

### 5.3 控制节点 pure 与终态收口

- 控制节点创建即 pure：`src/service/dispatcher.ts:148`、`:178`，`src/service/commands/wait.ts:241`，`src/service/commands/subworkflow.ts:312`。
- 收口：`src/service/commands/run-close.ts:25-85` 只有在 nodes.length>0、全部节点属于终态集合、无未决 decision、assertRunCanTerminal 通过时才写终态；更新带「状态不在终态集合」CAS。
- 扫描收口：`src/service/sweep.ts:332-352` 先收子运行完成的父控制节点，再收「节点全终态」的 running run。
- 判定：控制节点不落普通副作用、终态收口路径未受影响。

### 5.4 取消 run 不导致 succeeded

- run-close.ts 终态优先级：cancel_requested_at 存在时先取 cancelled，再考虑 failed_with_unverified/failed/orphaned/succeeded_with_unverified/succeeded；节点全 done 但 run 被取消，仍落 cancelled。
- 实测：`tests/integration/run-close.spec.ts:58`「取消过的运行即使节点全 done 也落 cancelled，不冒充成功」通过；subworkflow 侧 `:229` 覆盖父 run 落 cancelled。
- 判定：成立。

### 5.5 审计散文/表格一致

- G1.md GateArtifact：must_pass_items 13、failed_items 0、conclusion pass、13 行正文表全为通过；artifact 的 audit_round/audit_report 仍指 round51（P2-4），但与正文表内部一致。
- 本报告按 audit-verdict/1 写结构化裁决，正文只保留一条结论行；重签演练时 gate-check 的 proseVerdictClashes 未报冲突（第七节）。
- 判定：本轮候选没有改 G1.md，一致性由存量记录承担；重签会刷新轮次与哈希。

### 5.6 门检查重算哈希与必过项

- `tests/gate/gate-check.spec.ts` 184 例 183 passed / 1 skipped，覆盖证据哈希、candidate_hash、清单截短、必过项换证据、不变量语句、正文表删行复制、前序门哈希链、审计报告字节/轮次/路径、body_hash、脏树拒签等篡改。
- 三份篡改副本（证据 sha 清零、必过项正文内容变更、G-15 行删除）都被拒（exit 1），但都停在审计锚点——锚点检查在前（`scripts/gate-check.ts:2659`），这属于 P2-4 的记录滞后，不是放行漏洞。
- 13 份 G1 证据哈希独立重算：12 份与记录一致；ev-g14 记录 ec2b935d…，HEAD 文件 c1da5460…（P2-4，重签时刷新）。
- 判定：门检查的重算与固定清单逻辑没有退化。

## 六、发现

P0：0 个。
P1：0 个。

### 6.1 P2-1（本轮新增面）：run 级取消跳过 queued 不可逆节点，派发守卫随后让它永久留在队列

- 位置：`src/service/commands/subworkflow.ts:477-486`（`:483` 的 irreversible 提前 continue）与 `src/service/dispatcher.ts:78-85` 组合。
- 触发：节点 status=queued、side_effect_policy=irreversible 的 run 收到 run 级取消。
- 现象：propagateRunCancellation 把 run 的 cancel_requested_at 写上，但对不可逆节点直接跳过，节点仍是 queued；dispatchRun 看到 cancel_requested_at 返回 skipped，不做状态迁移；closeRun 因节点非终态返回 null。三步合起来把 run 永久留在 running/cancel_requested_at。
- 复现（`tests/audit-r57/probe.spec.ts`，审计后删除；探针源码见附录 A，实测输出）：

  ```
  PROBE_A_PROPAGATE {"cancelledRuns":[],"cancelledNodes":[],"skippedIrreversible":["nr1"],"run":{"status":"running","cancel_requested_at":"2026-11-14T15:00:00.000Z"},"node":"queued"}
  PROBE_A_DISPATCH [{"node_run_id":"nr1","node_id":"n1","status":"skipped","reason":"run_cancelled"}] executed=0 node=queued
  PROBE_A_CLOSE null run={"status":"running","cancel_requested_at":"2026-11-14T15:00:00.000Z"}
  ```

  退出码 0（1 passed）；断言 executed=0、node=queued、closed=null 均成立。
- 影响与定级：这是本轮节点级修复留下的同族缺口——`tests/integration/cancel.spec.ts:31` 的用例名声称「不能靠跳过把 run 卡在 running」，但只覆盖节点级 applyCancel，run 级传播仍走 `:483` 的跳过。不可逆策略目前没有生产写入口（迁移 017 默认 compensable，只有测试会写 irreversible；pre_execution 决策卡 ensurePreExecutionDecision 只有测试调用），因此是纵深防御缺口，定 P2，不定 P1。
- 处置建议：run 级传播对 queued/leased 的 irreversible 节点复用 applyCancel 的作废分支（或先作废再跳过），保证 skip 之后节点仍有终态。

### 6.2 P2-2（round56 结转）：M-64 前置条件可被无 requires 的 M-48 绕过

- 位置：`src/service/commands/nodes.ts:96`（candidates.every((rule) => rule.requires !== undefined) 才校验 requires）；M-48 是 NON_TERMINAL→错误终态的兜底路由，无 requires。
- 复现：`tmp/probe-m64.ts`（附录 B）在 df2fc08 上输出 `threw=false, node=failed`，exit 1；即 controlCompletion=false 的 waiting→failed 仍成功。
- 影响：控制节点收口的 requires 在兜底路由存在时形同虚设；本轮新增的 subworkflow 分支自己传了 controlCompletion=true，所以不依赖这条兜底，但缺口仍在。
- 定级：P2（纵深防御；fail-open 范围是控制节点错误迁移，未观察到生产触发）。

### 6.3 P2-3（round56 结转）：审计正文表格的历史轮次豁免只做在散文侧

- 位置：`scripts/gate-check.ts:1628-1700` 的表格分支没有用 historicalTableRows（`:1715-1735`）的轮次豁免；散文侧 `:1715` 起有。
- 复现：`tmp/probe-b.ts` 对含历史第 50 轮否决行的表格输出 `RESULT=null`，exit 1，即找不到唯一结论。
- 影响：带历史表格的旧报告走词法兜底时被判「找不到结论」，属 fail-closed；不会放过坏报告，但会误伤合规的历史记录。
- 定级：P2。

### 6.4 P2-4（存量记录滞后）：G1.md 仍锚 round51，ev-g14 哈希过期，必跑门检查 exit 1

- 现象：G1.md artifact audit_round=51、audit_report=docs/audits/S1-independent-audit-round51.md、audit_report_sha256=355a1a58…、candidate_hash=85dccd92…；HEAD 的 round51 报告哈希是 e3eee746…；ev-g14 记录 ec2b935d…，HEAD 的 `docs/gates/evidence/G1/G-14.md` 是 c1da5460…。
- 复现：`node scripts/gate-check.ts docs/gates/G1.md` → exit 1，报「审计报告 sha256 与记录不符（报告改过就重新审计再签）：355a1a582b5584c0… != e3eee74611c3a681…」。
- 影响：这是签后记录未跟进的存量问题，round56 已报（P2-3）；本轮候选的代码不依赖它，重签即清。
- 定级：P2（流程项，不是代码缺陷）。

## 七、重签演练

在临时 worktree 按正式顺序演练（不碰主工作树）：提交本报告 → 改 G1.md 的 audit_round=57 与 audit_report=本报告路径 → `node --no-warnings scripts/sign-gate.ts docs/gates/G1.md` → 提交 G1.md → `node scripts/gate-check.ts docs/gates/G1.md` → `pnpm test`。

演练结果：sign-gate exit 0；gate-check exit 0；pnpm test exit 0（854 passed / 1 skipped）。docs/audits 与 docs/gates/G1.md 都在候选排除项内，候选哈希仍是 df2fc08，不需要新的代码提交。

## 八、必过项逐项

| 项 | 要求 | 结论 |
| --- | --- | --- |
| G1-01 | 迁移空库可重复 | 通过（migrate.spec.ts；check-evidence-repro 复跑一致） |
| G1-02 | 迁移中途杀可重入 | 通过（G-14 证据与用例；复跑一致） |
| G1-03 | 进程杀不丢已提交事件 | 通过（G-02 证据；复跑一致） |
| G1-04 | 备份独立目录行数与哈希一致 | 通过（backup.spec.ts；复跑一致） |
| G1-05 | 损坏备份可检出 | 通过（G-15 证据；复跑一致） |
| G1-06 | 认证拒匿名写 | 通过（auth.spec.ts；复跑一致） |
| G1-07 | 阶段开关拒未知值 | 通过（config.spec.ts；复跑一致） |
| G-01 | 事务 COMMIT 前杀进程 | 通过（G-01 证据；复跑一致） |
| G-02 | COMMIT 后未投递被杀 | 通过（G-02 证据；复跑一致） |
| G-08 | 长事务期间读不被拖死、写报 busy、队列溢出报 503 | 通过（G-08 证据；复跑一致） |
| G-09 | 订阅者离线重放 | 通过（G-09 证据；复跑一致） |
| G-14 | 迁移一半杀后重跑 | 通过（G-14 证据与用例；复跑一致，记录哈希见 P2-4） |
| G-15 | 备份截断能检出、恢复被拒、线上库不变 | 通过（G-15 证据；复跑一致） |

## 九、结论与放行建议

本轮候选只改取消路径，未触碰迁移、状态机规则表、调度装配与账本；节点级作废、派发前二次检查、子 run 自行取消三条改动方向正确，G1 不变量未被破坏。P0=0、P1=0、P2=4，必过项 13/13，failed_items 为空。可以重签 G1：按第七节顺序先签报告再签门，docs/audits 与 G1.md 不进候选哈希；6.1 建议在下一轮补 run 级作废分支，6.2/6.3 维持 round56 的整改项，6.4 随本次重签清掉。

## 附录 A：run 级取消探针

```ts
import { describe, expect, it } from 'vitest'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { propagateRunCancellation } from '../../src/service/commands/subworkflow.ts'
import { dispatchRun } from '../../src/service/dispatcher.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'

const NOW = '2026-11-14T15:00:00.000Z'
const nodeStatus = (db: any): string =>
  (db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='nr1'").get() as { status: string }).status
const runRow = (db: any): any =>
  db.raw.prepare("SELECT status, cancel_requested_at FROM runs WHERE run_id='r1'").get()

describe('round57 probe', () => {
  it('run 级取消跳过 queued 不可逆节点后，派发守卫让它永远留在队列', async () => {
    const { db } = freshLedger(); seed(db)
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status='queued', side_effect_policy='irreversible' WHERE node_run_id='nr1'")
    })
    const prop = withTx(db, (tx) => propagateRunCancellation(tx, TEST_SECRET, {
      runId: 'r1', cancelResult: 'interrupted', now: NOW, graceMs: 30000,
    }))
    console.log('PROBE_A_PROPAGATE ' + JSON.stringify({ ...prop, run: runRow(db), node: nodeStatus(db) }))
    let executed = 0
    const deps: any = { db, executeNode: async () => { executed += 1; throw new Error('should not execute') } }
    const out = await dispatchRun(deps, { runId: 'r1', nodes: { n1: { tools: [] } }, now: NOW })
    const closed = withTx(db, (tx) => closeRun(tx, 'r1', NOW))
    console.log('PROBE_A_DISPATCH ' + JSON.stringify(out) + ' executed=' + String(executed) + ' node=' + nodeStatus(db))
    console.log('PROBE_A_CLOSE ' + JSON.stringify(closed) + ' run=' + JSON.stringify(runRow(db)))
    expect(executed).toBe(0)
    expect(nodeStatus(db)).toBe('queued')
    expect(closed).toBeNull()
  })
})
```

## 附录 B：M-64 绕过探针

```ts
import { openDb, withTx } from '../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../src/infra/db/migrate.ts'
import { applyTransition } from '../src/service/commands/nodes.ts'
const NOW = '2026-11-14T12:00:00.000Z'
const d = openDb(':memory:')
applySteps(d, loadSteps(defaultMigrationsDir()))
withTx(d, (tx) => {
  tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1','x','running',1,?,?)", [NOW, NOW])
  tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1','t1','running',1,?,?)", [NOW, NOW])
  tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, side_effect_policy, created_at, updated_at) VALUES ('n1','r1','n1',1,'wait',1,'waiting',1,'pure',?,?)", [NOW, NOW])
})
let threw = false
withTx(d, (tx) => {
  try {
    applyTransition(tx, { nodeRunId: 'n1', from: ['waiting'], to: 'failed', attempt: 1, now: NOW, context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true, controlCompletion: false } })
  } catch { threw = true }
})
const status = (d.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='n1'").get() as { status: string }).status
console.log('threw=' + threw + ', node=' + status)
process.exit(threw && status === 'waiting' ? 0 : 1)
```
