# S3 独立审计 第 8 轮：G3 控制节点、取消与 run 收口

**verdict：pass（源码行为层）**。P0 0 项、P1 0 项、P2 7 项；必过项 20/20；failed_items：无。

第 7 轮针对 `e0f9650` 的 1 个 P0、4 个 P1 在本轮全部复跑通过：控制节点终态后 run 自动收口；取消 waiting 节点撤销登记且迟到事件落 inbox；取消子流程父节点收口且父/子 run 落 cancelled；失败子流程父节点 failed；取消子 run 落 cancelled。G3 门记录仍是预签态（`audit_round=3`、哈希全 0），`gate-check` exit 1，这是重签前状态；行为结论通过，**可以重签 G3**，重签时按 P2-1/P2-2/P2-3 更新门记录与证据清单。

## 候选与工作树

- 候选 SHA：`af3970b35aadd38f1dc79fa88f631ae55f0f1fc1`（`af3970b fix(service): close control-node runs and map child terminal states`，main，已推送）。
- 审计 worktree：`C:\Users\ASUS\AppData\Local\Temp\dsh-orchestra-audit-r8`，`git worktree add --detach ... af3970b`；审计结束已删除，原工作树未改源码。
- 审计时原工作树 `HEAD=af3970b`，存在并发改动：`docs/audits/S2-independent-audit-round55.md`、`src/service/commands/cancel.ts`、`src/service/dispatcher.ts`、`tests/integration/cancel.spec.ts`。这些不是本轮审计产物，未读、未测、未改；所有实测都在干净 worktree 完成。
- 运行环境：Node v26.13.1、pnpm 12.3.4。

## 方法与入口

探针 `tmp/audit-r8-probe.mjs` 走真实生产入口，不直接调内部函数：

- `openServiceOrchestra({ phase: 'S3', executor })` 装配 registry / HostRunner / fakeAgentClient / ReadOnlyToolRunner；
- `startServer(...)` 起 HTTP，经 `/v1/workflows/load`、`/v1/runs`、`/v1/runs/dispatch`、`/v1/wait/events`、`/v1/runs/cancel`、`/v1/node-runs/cancel`、`/v1/compensations/{start,settle}` 驱动；
- `sweepNow(service.orchestra.runtime, realNow)` 驱动生产 sweep；SQL 只读观察；
- 子 run 终态由真实 `closeRun` 产生，未手工种 `done`；只有 S5 的补偿前置节点状态按测试夹具方式预置为 `failed`。

## 实测命令与退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm test` | 0 | 61 files passed；**852 passed，1 skipped（853）**，13.87s |
| `pnpm build` | 0 | ESM `lib/index.js` 250295 B（250.29 kB，gzip 59.95 kB）；`lib/index.d.ts` 18069 B（18.07 kB）；CJS `lib/client.js` 287 B（0.29 kB） |
| `node --no-warnings scripts/check-evidence-repro.ts` | 0 | `证据复现成立：25 份，每份重跑两遍都与 HEAD 字节一致` |
| `node scripts/gate-check.ts docs/gates/G3.md` | **1** | `门检查失败（docs/gates/G3.md）：审计报告 sha256 与记录不符（报告改过就重新审计再签）：0000000000000000… != 4876a98892db4661…` |
| `node --no-warnings tmp/audit-r8-probe.mjs` | 0 | 8/8 PASS（S1a、S1b、S2、S2b、S3、S4、S5a、S5b） |

`full-suite.md` 记录 61 files、852 passed | 1 skipped、ESM 250.29 kB / gzip 59.95 kB / d.ts 18.07 kB，与实测逐项一致。

## 五个必验场景（含补偿）

| 场景 | 实测 | 结论 |
| --- | --- | --- |
| S1a wait 唤醒 | dispatch 200、event 200、`woken=1`、节点 `done`、run `succeeded`；同一 HTTP 操作内收口，未发空 dispatch | PASS |
| S1b wait 超时 | `maxWaitMs=1`，一次 `sweepNow`：`wait_timed_out=1`、节点 `timeout`、run `failed`。`runs_closed=[]` 是因为 `timeoutWaiting` 在扫描内部已 `closeRun`，随后 runs 循环只查 `status='running'`，不是未收口 | PASS |
| S2 取消 waiting（run 级） | `/v1/runs/cancel` 200；登记 `cancelled`、节点 `superseded`、run `cancelled`；迟到匹配事件 200、`woken=0`、`wait_event_inbox=1`（第 7 轮为 409、inbox 0） | PASS |
| S3 取消子流程 | 取消后父节点 `superseded`、父 run `running`、子 run `running`；第 1 次 sweep 子 run `cancelled`；第 2 次 sweep 父 run `cancelled`；最终 `{parentNode:superseded, parentRun:cancelled, childRun:cancelled}`，父节点未卡 `stopping`；`subworkflow.finished=0` 是因为父节点取消时已经 `superseded`，不需再唤醒 | PASS |
| S4 失败子流程 | 子 wait 超时 → 子 run `failed`；父节点 `failed`；父 run `failed`，未落到 `succeeded*` | PASS |
| S5a 补偿 settle(applied) | 前置节点 `failed`/compensable；settle 200；run 从 `running` 收口为 `failed_with_unverified`（`hasUnverified` 按未核验副作用升档，仍是终态，已收口） | PASS |
| S5b 补偿 settle(failed) | settle 200；节点 `failed_with_unverified`；run `failed_with_unverified` | PASS |

补充观察 S2b（节点级 `/v1/node-runs/cancel`）：`reason=control_node_cancelled`、登记 `cancelled`、节点 `superseded`；随后 sweep 把 run 收成 `succeeded`。这属于“节点级取消”与“run 级取消”的语义边界，见 P2-7；本轮场景 2 按第 7 轮口径走 `/v1/runs/cancel`，PASS。

## 必过项与代码对照

- G3-07（wait 先落 inbox 再匹配）：`src/service/commands/wait.ts:293` 先 `recordWaitEvent`，再扫描登记，最后无条件 `closeRun`；S1a/S1b/S2 通过。
- G3-08（子流程 pin、深度/环、父取消传播）：`src/service/commands/subworkflow.ts:345-346` 定义成功/取消集合，`:412-413` 按 child 终态映射，`:467`/`:499` 写父/子 run 的 `cancel_requested_at`；S3/S4 通过。
- G-16（父取消向子 run 传播、跳过不可逆）：`pnpm test` 中 `g3-faults.spec.ts` 与 `subworkflow.spec.ts` 通过；S3 证明父/子 run 收敛。G-16 证据本身仍只断言传播摘要，见 P2-5。
- G3-09（补偿幂等、failed_with_unverified）：S5a/S5b 与 `compensation.spec.ts` 通过。
- G3-14（全量测试与构建全绿）：852 passed / 1 skipped，build exit 0，与证据一致。
- 其余 15 项由 852 条全量用例覆盖，未见新 P0/P1。

必过项合计 **20/20 pass**，failed_items **无**。

## G3 门记录与证据

1. **仍是预签态**：`docs/gates/G3.md:71-74` 的 candidate/change_scope/evidence_index/invariants 哈希全 0；`:111-113` 为 `audit_round=3`、`audit_report=docs/audits/S3-independent-audit-round3.md`、`audit_report_sha256` 全 0；`:119-138` 的 20 条 evidence-index sha256 全 0；正文 `:98` conclusion 仍写 pass。`gate-check` 因此 exit 1，当前记录不放行。
2. **G3 证据未被 `check-evidence-repro` 覆盖**：`scripts/check-evidence-repro.ts:12` 的 CASES 类型只有 `'G1' | 'G2'`，实测 25 份全是 G1/G2；G3 的 G-06/G-12/G-16 虽在 `scripts/fault-inject.ts:456-535` 有可跑的注入函数，但 `:1510` 把它们归到 G1，输出是原始账本 dump，而 `docs/gates/evidence/G3/G-06.md`、`G-12.md`、`G-16.md` 是叙事型证据，两者不是同一种字节产物；G3/full-suite.md 是人工运行记录，不由 fault-inject 生成。故 G3 四份证据目前不在该守卫的覆盖内，见 P2-2。
3. **full-suite 计数一致**：证据写 852 passed | 1 skipped、61 files、250.29 kB / 59.95 kB / 18.07 kB，实测逐项相等。

## P2

| 编号 | 内容 | 文件:行号 | 复现 |
| --- | --- | --- | --- |
| P2-1 | G3.md 正文、G3-01 表格与 I1 仍写 `M-01…M-62`，实际迁移表已 65 条（M-63/64/65）；`full-suite.md` 已写 M-01…M-65，门记录与证据口径不一致（第 7 轮 P2-1 未收） | `docs/gates/G3.md:11`、`:21`、`:55`、`:144`；`src/core/state-machine.ts:165-168`、`:269-276` | `grep -n "M-01…M-62\|M-01 到 M-62" docs/gates/G3.md`；`grep -n "'M-61', 'M-62', 'M-63', 'M-64', 'M-65'" src/core/state-machine.ts` |
| P2-2 | G3 注入证据未进 `check-evidence-repro`；G-06/G-12/G-16 被 fault-inject 归到 G1 且产出原始 dump，与 G3 叙事证据不同字节；full-suite 为人工记录，均不在 25 份字节复现内（第 7 轮 P2-2 未收） | `scripts/check-evidence-repro.ts:12-15`；`scripts/fault-inject.ts:1510`；`docs/gates/evidence/G3/*.md` | `node --no-warnings scripts/check-evidence-repro.ts`（25 份，无 G3）；`node --experimental-strip-types --no-warnings scripts/fault-inject.ts --case G-16 --out tmp/g3-repro`（写到 `tmp/g3-repro/G1/G-16.md`，与 `docs/gates/evidence/G3/G-16.md` 不同） |
| P2-3 | G3.md 仍预签：`audit_round=3`、报告指向 round3、五个 GateArtifact 哈希全 0、20 条 evidence sha 全 0；当前 gate-check 以“审计报告 sha256 与记录不符”exit 1（第 7 轮 P2-3 未收） | `docs/gates/G3.md:71-74`、`:111-113`、`:119-138` | `node scripts/gate-check.ts docs/gates/G3.md`；退出码 1，错误见上表 |
| P2-4 | `BRIDGE_BOUND` 含 `waiting`，规格 §4.4 executor-bound 只列六态；`BRIDGE_SILENCE_MS=10min` 硬编码，不读 `execution.lease_ttl_ms`，部署不可调（第 7 轮 P2-4 遗留） | `src/service/commands/runtime.ts:63-64` | `grep -n "BRIDGE_BOUND\|BRIDGE_SILENCE_MS" src/service/commands/runtime.ts` |
| P2-5 | G-16 证据只断言 `cancelledNodes`/`skippedIrreversible`/`timing_out`，不验“子 run 收敛后再判”与父/子 run 终态；本轮代码已收敛，证据仍弱（第 7 轮 P2-7 遗留） | `docs/gates/evidence/G3/G-16.md:3-4`、`:13` | `pnpm vitest run tests/integration/g3-faults.spec.ts -t G-16`；对照 `docs/gates/evidence/G3/G-16.md` |
| P2-6 | `dispatch` 未装 executor 时一律 `EVIDENCE_SOURCE_UNAVAILABLE`，control-only 的 wait/subworkflow 也被挡；`serveOrchestra` 却只跑 sweep（第 7 轮 P2-8 遗留） | `src/index.ts:208-209` | `grep -n "if (!opts.executor)" src/index.ts` |
| P2-7 | 节点级 `/v1/node-runs/cancel` 取消 waiting 节点后，节点/登记正确收口，但 run 在 sweep 后收为 `succeeded`；run 级取消才写 `runs.cancel_requested_at`，`closeRun` 只按该列落 `cancelled`。若门记录把“取消 waiting 节点”也定义为 run 取消，此项应升 P1；本轮场景 2 按 run 级验收通过 | `src/service/commands/cancel.ts:78-108`；`src/service/commands/run-close.ts:57-61` | 附录探针 S2b：`node --no-warnings tmp/audit-r8-probe.mjs`（S2b 输出 `run:"succeeded"`） |

## 收口建议

1. 重签 G3 时把 `audit_round` 改为 8、`audit_report` 指向本文件、重算五个哈希与 20 条 evidence sha；正文/表格/I1 一并从 `M-01…M-62` 更新到 `M-01…M-65`。
2. 把 G-06/G-12/G-16 纳入证据复现守卫（`check-evidence-repro` 的 CASES + fault-inject 的 G3 目录映射），并明确 full-suite 这类人工证据的复现方式；若保留叙事型 G3 证据，守卫应做“重跑注入并核对叙事中的对账结论”，不是比对原始 dump 字节。
3. 在门记录中写清“节点级取消”和“run 级取消”的语义：节点级取消后 run 落 `succeeded` 是否可接受；若不可接受，让节点级取消也写 run 取消标记或给 run 专属取消终态。
4. 重签后执行 `node scripts/gate-check.ts docs/gates/G3.md`，两门全绿后再提交。

<!-- audit-verdict:begin -->
```json
{
  "schema": "audit-verdict/1",
  "gate": "G3",
  "audit_round": 8,
  "candidate_commit": "af3970b35aadd38f1dc79fa88f631ae55f0f1fc1",
  "conclusion": "pass",
  "p0": 0,
  "p1": 0,
  "p2": 7,
  "must_pass_total": 20,
  "must_pass_passed": 20,
  "must_pass_ids": ["G3-01", "G3-02", "G3-03", "G3-04", "G3-05", "G3-06", "G3-07", "G3-08", "G3-09", "G3-10", "G3-11", "G-01", "G-02", "G-04", "G-06", "G-12", "G-16", "G3-12", "G3-13", "G3-14"],
  "failed_items": [],
  "notes": "第 7 轮 1 P0 + 4 P1 全部复跑通过：wait 唤醒/超时同操作或同次 sweep 收口；取消 waiting 登记撤销、迟到事件落 inbox；取消子流程父节点收口且父/子 run cancelled；失败子流程父节点/父 run failed；补偿 settle 收口。全量 852 passed / 1 skipped、build 一致。G3.md 仍预签（round3、哈希全 0），gate-check exit 1；7 项 P2 见报告，重签前更新门记录与证据复现清单。"
}
```
<!-- audit-verdict:end -->

## 附录：探针脚本

在干净 worktree 的 `tmp/audit-r8-probe.mjs` 运行；从仓库根执行 `node --no-warnings tmp/audit-r8-probe.mjs`。

```js
// Independent round-8 probe: production commands over HTTP + real sweep, SQLite observation only.
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openServiceOrchestra } from '../src/index.ts'
import { sweepNow } from '../src/service/commands/runtime.ts'
import { startServer } from '../src/service/server.ts'
import { withTx } from '../src/infra/sqlite/driver.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../src/executor/tools.ts'
import { fakeAgentClient } from '../tests/fixtures/agent-bridge.ts'

const SECRET = 'round8-probe-secret'
const NOW = new Date().toISOString()
const dir = mkdtempSync(join(tmpdir(), 'orch-r8-'))
const results = []
function check(id, label, ok, detail) {
  results.push({ id, label, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + label + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const registry = new ToolRegistry()
registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
const host = { readonlyAvailable: () => true, run: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }) }
const agents = { create: async () => ({ agentId: 'agent_1', sessionId: 'sess_1' }) }
const service = await openServiceOrchestra({
  dbFile: join(dir, 'orchestra.db'), secret: SECRET, phase: 'S3',
  executor: { registry, agents, bridge: fakeAgentClient({ agentId: 'agent_1', steps: [], at: NOW }), runner: new ReadOnlyToolRunner(registry, host, dir) },
})
const db = service.orchestra.db
const server = await startServer({
  secret: SECRET, phase: 'S3', epoch: db.epoch,
  asOfSeq: () => (db.raw.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM events').get()).s,
  listTasks: () => [], listEvents: () => [],
  appendLedgerEvent: () => { throw new Error('not used') },
  commands: service.orchestra.commands,
})
const base = server.endpoint
async function post(path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestra-secret': SECRET }, body: JSON.stringify(body) })
  const json = await res.json()
  return { status: res.status, json }
}
function row(sql, ...p) { return db.raw.prepare(sql).get(...p) }
function realNow() { return new Date().toISOString() }
async function load(id, nodes) { return post('/v1/workflows/load', { workflow_id: id, workflow_version: '1', nodes }) }
async function newRun(wf, title) { return post('/v1/runs', { taskTitle: title, workflowId: wf, workflowVersion: '1' }) }
async function dispatch(runId, nodes) { return post('/v1/runs/dispatch', { runId, nodes }) }
async function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

console.log('candidate', (await import('node:child_process')).execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim())
await load('wf_wait', [{ node_id: 'w', type: 'wait' }])
await load('wf_sub', [{ node_id: 's', type: 'subworkflow' }])
await load('wf_agent', [{ node_id: 'a', type: 'agent' }])
await load('child_wait', [{ node_id: 'cw', type: 'wait' }])
await load('child_ok', [{ node_id: 'ca', type: 'agent' }])

// ---- S1a: wait wake, same transaction closes run ----
{
  const r = await newRun('wf_wait', 'wait wake'); const runId = r.json.data.run_id
  const d = await dispatch(runId, { w: { tools: [], control: { kind: 'wait', waitKind: 'event', match: { type: 'approval.approved' }, idempotencyKey: 'w1', maxWaitMs: 60000 } } })
  const regBefore = row('SELECT state FROM wait_registrations WHERE run_id=?', runId)
  const e = await post('/v1/wait/events', { runId, eventType: 'approval.approved', payload: { ok: true }, idempotencyKey: 'ev-w1' })
  const node = row("SELECT status FROM node_runs WHERE run_id=?", runId)
  const run = row('SELECT status FROM runs WHERE run_id=?', runId)
  check('S1a', 'wake: node done + run succeeded same op, no empty dispatch', d.status === 200 && e.status === 200 && regBefore.state === 'active' && node.status === 'done' && run.status === 'succeeded', { dispatch: d.status, event: e.status, woken: e.json.data?.woken, node: node.status, run: run.status })
}

// ---- S1b: wait timeout, next sweep closes run ----
{
  const r = await newRun('wf_wait', 'wait timeout'); const runId = r.json.data.run_id
  await dispatch(runId, { w: { tools: [], control: { kind: 'wait', waitKind: 'timer', match: { type: 'never' }, idempotencyKey: 'w2', maxWaitMs: 1 } } })
  await wait(30)
  const sw = sweepNow(service.orchestra.runtime, realNow())
  const node = row("SELECT status FROM node_runs WHERE run_id=?", runId)
  const run = row('SELECT status FROM runs WHERE run_id=?', runId)
  check('S1b', 'timeout: node timeout + run failed in one sweep', node.status === 'timeout' && run.status === 'failed' && sw.wait_timed_out >= 1, { wait_timed_out: sw.wait_timed_out, runs_closed: sw.runs_closed, node: node.status, run: run.status })
}

// ---- S2: run-level cancel of waiting node; late event accepted, not 409 ----
{
  const r = await newRun('wf_wait', 'wait cancel'); const runId = r.json.data.run_id
  await dispatch(runId, { w: { tools: [], control: { kind: 'wait', waitKind: 'event', match: { type: 'approval.approved' }, idempotencyKey: 'w3', maxWaitMs: 60000 } } })
  const c = await post('/v1/runs/cancel', { runId, cancelResult: 'interrupted', graceMs: 5000 })
  const node = row('SELECT status FROM node_runs WHERE run_id=?', runId)
  const reg = row('SELECT state FROM wait_registrations WHERE run_id=?', runId)
  const run = row('SELECT status FROM runs WHERE run_id=?', runId)
  const late = await post('/v1/wait/events', { runId, eventType: 'approval.approved', payload: { ok: true }, idempotencyKey: 'ev-late-1' })
  const inbox = row("SELECT COUNT(*) AS n FROM wait_event_inbox WHERE idempotency_key='ev-late-1'")
  check('S2', 'run cancel: registration cancelled, node superseded, run cancelled; late event 200 + inbox', c.status === 200 && reg.state === 'cancelled' && node.status === 'superseded' && run.status === 'cancelled' && late.status === 200 && late.json.data?.woken === 0 && inbox.n === 1, { cancel: c.status, reg: reg.state, node: node.status, run: run.status, late: late.status, woken: late.json.data?.woken, inbox: inbox.n })
}

// ---- S2b (extra): node-level cancel of waiting node, then sweep ----
{
  const r = await newRun('wf_wait', 'wait node cancel'); const runId = r.json.data.run_id
  await dispatch(runId, { w: { tools: [], control: { kind: 'wait', waitKind: 'event', match: { type: 'x' }, idempotencyKey: 'w4', maxWaitMs: 60000 } } })
  const n = row('SELECT node_run_id, attempt, revision, status FROM node_runs WHERE run_id=?', runId)
  const c = await post('/v1/node-runs/cancel', { nodeRunId: n.node_run_id, attempt: n.attempt, revision: n.revision, cancelResult: 'interrupted', graceMs: 5000 })
  const sw = sweepNow(service.orchestra.runtime, realNow())
  const node = row('SELECT status FROM node_runs WHERE node_run_id=?', n.node_run_id)
  const reg = row('SELECT state FROM wait_registrations WHERE run_id=?', runId)
  const run = row('SELECT status FROM runs WHERE run_id=?', runId)
  check('S2b', 'node-level cancel: registration cancelled + node superseded; run status recorded', c.status === 200 && reg.state === 'cancelled' && node.status === 'superseded', { cancel: c.status, reason: c.json.data?.reason, reg: reg.state, node: node.status, run: run.status, runs_closed: sw.runs_closed })
}

// ---- S3: cancel parent subworkflow; parent node settles, parent run cancelled, child run cancelled ----
{
  const r = await newRun('wf_sub', 'sub cancel'); const parentRun = r.json.data.run_id
  const d = await dispatch(parentRun, { s: { tools: [], control: { kind: 'subworkflow', workflowId: 'child_wait', workflowVersion: 1 } } })
  const child = row('SELECT run_id, status FROM runs WHERE parent_run_id=?', parentRun)
  const c = await post('/v1/runs/cancel', { runId: parentRun, cancelResult: 'interrupted', graceMs: 5000 })
  const afterCancel = { node: row('SELECT status FROM node_runs WHERE run_id=?', parentRun).status, run: row('SELECT status FROM runs WHERE run_id=?', parentRun).status, child: row('SELECT status FROM runs WHERE run_id=?', child.run_id).status }
  sweepNow(service.orchestra.runtime, realNow())
  const mid = { node: row('SELECT status FROM node_runs WHERE run_id=?', parentRun).status, run: row('SELECT status FROM runs WHERE run_id=?', parentRun).status, child: row('SELECT status FROM runs WHERE run_id=?', child.run_id).status }
  sweepNow(service.orchestra.runtime, realNow())
  const final = { node: row('SELECT status FROM node_runs WHERE run_id=?', parentRun).status, run: row('SELECT status FROM runs WHERE run_id=?', parentRun).status, child: row('SELECT status FROM runs WHERE run_id=?', child.run_id).status, finished: row("SELECT COUNT(*) AS n FROM node_run_events e JOIN node_runs n ON n.node_run_id=e.node_run_id WHERE n.run_id=? AND e.type='subworkflow.finished'", parentRun).n }
  check('S3', 'subflow cancel: parent node terminal, parent+child runs cancelled, not stopping', c.status === 200 && d.status === 200 && ['superseded', 'failed', 'abandoned_unverified'].includes(afterCancel.node) && final.run === 'cancelled' && final.child === 'cancelled' && afterCancel.node !== 'stopping' && afterCancel.run !== 'stopping', { child: child.run_id, afterCancel, mid, final })
}

// ---- S4: failed child (timeout) -> parent node failed, parent run not succeeded ----
{
  const r = await newRun('wf_sub', 'sub failed'); const parentRun = r.json.data.run_id
  await dispatch(parentRun, { s: { tools: [], control: { kind: 'subworkflow', workflowId: 'child_wait', workflowVersion: 1 } } })
  const child = row('SELECT run_id FROM runs WHERE parent_run_id=?', parentRun)
  const cd = await dispatch(child.run_id, { cw: { tools: [], control: { kind: 'wait', waitKind: 'timer', match: { type: 'never' }, idempotencyKey: 'cw1', maxWaitMs: 1 } } })
  await wait(30)
  const sw = sweepNow(service.orchestra.runtime, realNow())
  const parentNode = row('SELECT status FROM node_runs WHERE run_id=?', parentRun)
  const parentRunRow = row('SELECT status FROM runs WHERE run_id=?', parentRun)
  const childRun = row('SELECT status FROM runs WHERE run_id=?', child.run_id)
  check('S4', 'failed child: parent node failed, parent run failed (not succeeded)', cd.status === 200 && childRun.status === 'failed' && parentNode.status === 'failed' && parentRunRow.status === 'failed', { childRun: childRun.status, parentNode: parentNode.status, parentRun: parentRunRow.status, runs_closed: sw.runs_closed })
}

// ---- S5: compensation settle closes run (applied and failed) ----
{
  const r = await newRun('wf_agent', 'comp applied'); const runId = r.json.data.run_id
  const n = row('SELECT node_run_id, attempt FROM node_runs WHERE run_id=?', runId)
  withTx(db, (tx) => { tx.run("UPDATE node_runs SET status='failed', side_effect_policy='compensable', side_effect_verified_none=0 WHERE node_run_id=?", [n.node_run_id]) })
  const before = row('SELECT status FROM runs WHERE run_id=?', runId)
  const st = await post('/v1/compensations/start', { nodeRunId: n.node_run_id, attempt: n.attempt, descriptor: { tool: 'echo', args: [], verify: { command: 'true', args: [] }, descriptorVersion: 'v1' } })
  const se = await post('/v1/compensations/settle', { compensationId: st.json.data.compensationId, state: 'applied', evidence: { ok: true } })
  const after = row('SELECT status FROM runs WHERE run_id=?', runId)
  check('S5a', 'settle applied: run closed failed (was running)', before.status === 'running' && st.status === 200 && se.status === 200 && ['failed','failed_with_unverified'].includes(after.status), { before: before.status, start: st.status, settle: se.status, after: after.status })
}
{
  const r = await newRun('wf_agent', 'comp failed'); const runId = r.json.data.run_id
  const n = row('SELECT node_run_id, attempt FROM node_runs WHERE run_id=?', runId)
  withTx(db, (tx) => { tx.run("UPDATE node_runs SET status='failed', side_effect_policy='compensable', side_effect_verified_none=0 WHERE node_run_id=?", [n.node_run_id]) })
  const st = await post('/v1/compensations/start', { nodeRunId: n.node_run_id, attempt: n.attempt, descriptor: { tool: 'echo', args: [], verify: { command: 'true', args: [] }, descriptorVersion: 'v2' } })
  const se = await post('/v1/compensations/settle', { compensationId: st.json.data.compensationId, state: 'failed', reason: 'probe' })
  const node = row('SELECT status FROM node_runs WHERE node_run_id=?', n.node_run_id)
  const run = row('SELECT status FROM runs WHERE run_id=?', runId)
  check('S5b', 'settle failed: node failed_with_unverified + run failed_with_unverified', st.status === 200 && se.status === 200 && node.status === 'failed_with_unverified' && run.status === 'failed_with_unverified', { start: st.status, settle: se.status, node: node.status, run: run.status })
}

const passed = results.filter((r) => r.ok).length
console.log('SUMMARY ' + JSON.stringify({ total: results.length, passed, failed: results.filter((r) => !r.ok).map((r) => r.id) }))
await server.close()
await service.release()
try { rmSync(dir, { recursive: true, force: true }) } catch {}
process.exit(passed === results.length ? 0 : 1)
```
