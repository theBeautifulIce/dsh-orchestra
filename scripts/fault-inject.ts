// G1 故障注入：每条都留下注入参数、前后账本片段、恢复后对账查询（规格 12.3 行 1077）
// 用法：node scripts/fault-inject.ts --case G-01   （Node 26 直接跑 TS）
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDb, withTx } from '../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../src/infra/db/migrate.ts'
import { listEvents } from '../src/service/queries/list_events.ts'
import { WriteQueue } from '../src/service/write-queue.ts'
import { backup, restore, sha256File, verifyBackup } from '../src/infra/backup.ts'
import { eventSeqs, freshLedger, seed, TEST_SECRET } from '../tests/fixtures/ledger.ts'
import { inTx } from '../src/infra/db/tx.ts'
import { acquireLease } from '../src/service/commands/lease.ts'
import { applyReport } from '../src/service/commands/apply-report.ts'
import { applyCancel } from '../src/service/commands/cancel.ts'
import { MonotonicClock, deadlineFromRow } from '../src/core/clock.ts'
import { rearmDeadline } from '../src/service/commands/node-state.ts'
import { sweep } from '../src/service/sweep.ts'
import { createOrchestra } from '../src/index.ts'
import { startServer } from '../src/service/server.ts'
import { ToolRegistry, ReadOnlyToolRunner, type HostRunner } from '../src/executor/tools.ts'
import { runNode } from '../src/executor/run-node.ts'
import type { HostAgentFactory } from '../src/executor/session.ts'
import type { Db } from '../src/infra/sqlite/driver.ts'

export type InjectionCase = 'G-01' | 'G-02' | 'G-03' | 'G-04' | 'G-05' | 'G-07' | 'G-08' | 'G-09' | 'G-14' | 'G-15'
  | 'ev-g2-01' | 'ev-g2-05' | 'ev-g2-06' | 'ev-g2-07'

export type InjectionResult = {
  case: InjectionCase
  params: Record<string, unknown>
  before: string
  after: string
  reconcile: string
}

// 证据要能重跑出同样的字节（审计 F-03）：临时路径统一写 <tmp>/文件名，事件 id 按首次出现归一成 evt_1、evt_2…
function normalizeEvidence(text: string): string {
  const ids = new Map<string, string>()
  const idOf = (raw: string): string => {
    let hit = ids.get(raw)
    if (!hit) { hit = 'evt_' + String(ids.size + 1); ids.set(raw, hit) }
    return hit
  }
  // 实体 id（tsk_/run_/nrun_/dec_/lease_）也是随机串，按首次出现归一成前缀_序号
  const entity = new Map<string, string>()
  const entityCount = new Map<string, number>()
  const entityOf = (raw: string): string => {
    let hit = entity.get(raw)
    if (!hit) {
      const prefix = raw.slice(0, raw.indexOf('_'))
      const n = (entityCount.get(prefix) ?? 0) + 1
      entityCount.set(prefix, n)
      hit = prefix + '_' + String(n)
      entity.set(raw, hit)
    }
    return hit
  }
  let out = text.replace(/evt_[0-9a-f]{20,}/g, (m) => idOf(m))
  out = out.replace(/lease_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => entityOf(m))
  out = out.replace(/(tsk|run|nrun|dec)_[0-9a-f]{32}/g, (m) => entityOf(m))
  return out
}

export function writeEvidence(dir: string, result: InjectionResult): void {
  mkdirSync(dir, { recursive: true })
  const params = normalizeEvidence(JSON.stringify(result.params, (key, value) => (key === 'db' ? '<tmp>/orchestra.db' : value)))
  writeFileSync(join(dir, result.case + '.md'),
    '# ' + result.case + '\n\n- 参数：' + params + '\n'
    + '\n## 注入前账本片段\n\n```\n' + normalizeEvidence(result.before) + '\n```\n'
    + '\n## 恢复后账本片段\n\n```\n' + normalizeEvidence(result.after) + '\n```\n'
    + '\n## 对账查询\n\n```\n' + normalizeEvidence(result.reconcile) + '\n```\n', 'utf8')
}

const DRIVER_URL = pathToFileURL(join(import.meta.dirname, '../src/infra/sqlite/driver.ts')).href
const MIGRATE_URL = pathToFileURL(join(import.meta.dirname, '../src/infra/db/migrate.ts')).href

const dumpEvents = (file: string): string => {
  const db = openDb(file, { readonly: true })
  try {
    const rows = db.raw.prepare('SELECT seq, type, event_id FROM events ORDER BY seq ASC').all() as { seq: number; type: string; event_id: string }[]
    return rows.length === 0 ? '(空)' : rows.map((r) => String(r.seq) + ' ' + r.type + ' ' + r.event_id).join('\n')
  } finally {
    db.raw.close()
  }
}

// S2 的注入证据要看节点行、节点事件与上报登记表：只 dump events 会让前后两段长得一样（审计 F-03）
const dumpState = (file: string): string => {
  const db = openDb(file, { readonly: true })
  try {
    const parts: string[] = []
    const events = db.raw.prepare('SELECT seq, type, event_id FROM events ORDER BY seq ASC').all() as { seq: number; type: string; event_id: string }[]
    parts.push('events: ' + (events.length === 0 ? '(空)' : events.map((r) => String(r.seq) + ' ' + r.type + ' ' + r.event_id).join('\n  ')))
    const nodes = db.raw.prepare('SELECT node_run_id, status, attempt, revision, action_generation, fence_state, cancel_result, tool_start_at, fence_grace_until, verify_deadline_at, deadline_at, deadline_boot_id, deadline_monotonic_ns FROM node_runs ORDER BY node_run_id ASC').all() as Record<string, unknown>[]
    parts.push('node_runs: ' + (nodes.length === 0 ? '(空)' : nodes.map((r) => JSON.stringify(r)).join('\n  ')))
    const nrev = db.raw.prepare('SELECT node_run_id, seq, type FROM node_run_events ORDER BY node_run_id ASC, seq ASC').all() as Record<string, unknown>[]
    parts.push('node_run_events: ' + (nrev.length === 0 ? '(空)' : nrev.map((r) => JSON.stringify(r)).join('\n  ')))
    const reg = db.raw.prepare('SELECT report_id, node_run_id, state FROM report_registry ORDER BY report_id ASC').all() as Record<string, unknown>[]
    parts.push('report_registry: ' + (reg.length === 0 ? '(空)' : reg.map((r) => JSON.stringify(r)).join('\n  ')))
    return parts.join('\n')
  } finally {
    db.raw.close()
  }
}

// 子进程脚本：打开库、按 body 动作、打印 READY、然后挂着等被杀
function runChild(body: string, env: Record<string, string>): Promise<{ killed: boolean; stdout: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'orch-child-'))
  const file = join(dir, 'child.ts')
  const source = `const { openDb } = await import(process.env.DRIVER_URL)
const db = openDb(process.env.DB_FILE)
${body}
process.stdout.write('READY\\n')
setTimeout(() => {}, 60000)
`
  writeFileSync(file, source, 'utf8')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', file], {
      env: { ...process.env, ...env, DRIVER_URL, DB_FILE: env.DB_FILE ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let ready = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('子进程 15 秒没 READY：' + out)) }, 15000)
    child.stdout.on('data', (buf: Buffer) => {
      out += buf.toString('utf8')
      if (!ready && out.includes('READY')) {
        ready = true
        child.kill('SIGKILL')
      }
    })
    child.stderr.on('data', (buf: Buffer) => { out += buf.toString('utf8') })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rmSync(dir, { recursive: true, force: true })
      if (!ready) reject(new Error('子进程没走到 READY（exit ' + String(code) + '）：' + out))
      else resolve({ killed: true, stdout: out })
    })
  })
}

async function caseG01(): Promise<InjectionResult> {
  const { dir, file, db } = freshLedger()
  seed(db)
  const beforeCount = eventSeqs(db).length
  const before = dumpEvents(file)
  db.raw.close()
  await runChild(`db.raw.exec('BEGIN IMMEDIATE')
db.raw.prepare('INSERT INTO events (event_id, type, occurred_at, created_at) VALUES (?, ?, ?, ?)').run('evt_half', 'inject.g01', 'now', 'now')`, { DB_FILE: file })
  const after = openDb(file, { readonly: true })
  try {
    const seqs = eventSeqs(after)
    const result: InjectionResult = {
      case: 'G-01',
      params: { db: file, killAt: 'COMMIT 之前', beforeCount },
      before,
      after: dumpEvents(file),
      reconcile: 'events 条数=' + String(seqs.length) + '（期望 ' + String(beforeCount) + '）；未提交事务不留半条记录：' + String(seqs.length === beforeCount),
    }
    return result
  } finally {
    after.raw.close()
  }
}

async function caseG02(): Promise<InjectionResult> {
  const { file, db } = freshLedger()
  seed(db)
  const before = dumpEvents(file)
  const beforeCount = eventSeqs(db).length
  db.raw.close()
  await runChild(`db.raw.exec('BEGIN IMMEDIATE')
db.raw.prepare('INSERT INTO events (event_id, type, occurred_at, created_at) VALUES (?, ?, ?, ?)').run('evt_committed', 'inject.g02', 'now', 'now')
db.raw.exec('COMMIT')`, { DB_FILE: file })
  const after = openDb(file)
  try {
    const replay = listEvents(after, { fromSeq: beforeCount, limit: 50 }).rows as { seq: number; event_id: string }[]
    const seqs = eventSeqs(after)
    return {
      case: 'G-02',
      params: { db: file, killAt: 'COMMIT 之后、投递之前', beforeCount },
      before,
      after: dumpEvents(file),
      reconcile: '重放 fromSeq=' + String(beforeCount) + ' 拿到 ' + String(replay.length) + ' 条：' + replay.map((r) => String(r.seq) + ' ' + r.event_id).join('、') + '；总条数 ' + String(seqs.length),
    }
  } finally {
    after.raw.close()
  }
}

async function caseG08(): Promise<InjectionResult> {
  const { dir, file, db } = freshLedger()
  seed(db)
  const before = dumpEvents(file)
  const reader = openDb(file, { readonly: true })
  let readOk = 0
  let busy = ''
  let queueErr = ''
  try {
    db.raw.exec('BEGIN IMMEDIATE')
    db.raw.prepare("INSERT INTO events (event_id, type, occurred_at, created_at) VALUES ('evt_hold', 'inject.g08.hold', 'now', 'now')").run()
    readOk = (reader.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    const writer = openDb(file, { busyTimeoutMs: 30 })
    try {
      writer.raw.exec('BEGIN IMMEDIATE')
    } catch (err) {
      busy = err instanceof Error ? err.message : String(err)
    } finally {
      writer.raw.close()
    }
    const q = new WriteQueue(2)
    const hang = (): Promise<void> => new Promise<void>((r) => { setImmediate(() => { void r }) })
    void q.run(hang)
    void q.run(hang)
    try {
      await q.run(hang)
    } catch (err) {
      queueErr = err instanceof Error && 'code' in err ? String((err as { code: string }).code) : String(err)
    }
  } finally {
    db.raw.exec('ROLLBACK')
    reader.raw.close()
    db.raw.close()
  }
  return {
    case: 'G-08',
    params: { db: file, busyTimeoutMs: 30, queueMax: 2 },
    before,
    after: dumpEvents(file),
    reconcile: '长事务期间读路径返回 ' + String(readOk) + ' 条（不为 0 即没被拖死）；第二个写者报 busy：' + String(busy.length > 0) + '；队列溢出码：' + queueErr,
  }
}

async function caseG09(): Promise<InjectionResult> {
  const { file, db } = freshLedger()
  seed(db)
  const cursorAt = eventSeqs(db).length
  const before = dumpEvents(file)
  const appended: number[] = []
  for (const i of [1, 2, 3]) {
    db.raw.prepare("INSERT INTO events (event_id, type, occurred_at, created_at) VALUES (?, ?, 'now', 'now')")
      .run('evt_off_' + String(i), 'inject.g09.' + String(i))
  }
  const replay = listEvents(db, { fromSeq: cursorAt, limit: 100 }).rows as { seq: number }[]
  appended.push(...replay.map((r) => Number(r.seq)))
  const contiguous = appended.every((seq, i) => i === 0 || seq === appended[i - 1]! + 1)
  db.raw.close()
  return {
    case: 'G-09',
    params: { db: file, offlineFromSeq: cursorAt, appended: 3 },
    before,
    after: dumpEvents(file),
    reconcile: '重放拿到 seq=' + appended.join(',') + '；连续无断号：' + String(contiguous),
  }
}

async function caseG14(): Promise<InjectionResult> {
  const { file, db } = freshLedger()
  seed(db)
  const before = dumpEvents(file)
  const beforeTables = (db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n
  db.raw.close()
  await runChild(`const { applySteps } = await import(process.env.MIGRATE_URL)
applySteps(db, [{ version: 901, name: 'half_a', checksum: 'sum-a', statements: ['CREATE TABLE half_a (id INTEGER PRIMARY KEY)'] }])`, { DB_FILE: file, MIGRATE_URL })
  const after = openDb(file)
  try {
    const steps = [
      { version: 901, name: 'half_a', checksum: 'sum-a', statements: ['CREATE TABLE half_a (id INTEGER PRIMARY KEY)'] },
      { version: 902, name: 'half_b', checksum: 'sum-b', statements: ['CREATE TABLE half_b (id INTEGER PRIMARY KEY)'] },
    ]
    const applied = applySteps(after, steps)
    const migrations = (after.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => Number(r.version))
    const tables = (after.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n
    return {
      case: 'G-14',
      params: { db: file, killAt: '第一步提交之后、第二步之前', beforeTables },
      before,
      after: dumpEvents(file),
      reconcile: '重跑只补了 ' + JSON.stringify(applied) + '；schema_migrations=' + JSON.stringify(migrations) + '；表数 ' + String(beforeTables) + '→' + String(tables) + '，第一步没重复执行',
    }
  } finally {
    after.raw.close()
  }
}

async function caseG15(): Promise<InjectionResult> {
  const { dir, file, db } = freshLedger()
  seed(db)
  const before = dumpEvents(file)
  db.raw.close()
  // 先关连接再取快照：否则 WAL 还没 checkpoint，前后快照被打开动作本身扰动，测不出「线上库不变」
  const online = { size: statSync(file).size, sha: sha256File(file) }
  const dest = join(dir, 'backup-g15')
  const manifest = backup(file, dest)
  const copy = join(dest, 'orchestra.db')
  truncateSync(copy, Math.floor(manifest.db_sha256.length > 0 ? statSync(copy).size / 2 : 1))
  let detected = ''
  try {
    verifyBackup(dest)
  } catch (err) {
    detected = err instanceof Error ? err.message : String(err)
  }
  const restored = join(dir, 'restored', 'orchestra.db')
  let restoreErr = ''
  try {
    restore(dest, restored)
  } catch (err) {
    restoreErr = err instanceof Error ? err.message : String(err)
  }
  const onlineAfter = { size: statSync(file).size, sha: sha256File(file) }
  const rdb = openDb(file, { readonly: true })
  const count = (rdb.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
  rdb.raw.close()
  return {
    case: 'G-15',
    params: { db: file, backup: dest, tamper: 'truncate 到一半' },
    before,
    after: dumpEvents(file),
    reconcile: '损坏检出：' + (detected || '(没检出！)')
      + '；恢复被拒：' + String(restoreErr.length > 0)
      + '；线上库未变：' + String(online.size === onlineAfter.size && online.sha === onlineAfter.sha)
      + '；线上库 sha ' + online.sha.slice(0, 12) + '；线上事件数 ' + String(count),
  }
}

// S2 注入前的统一夹具：一条 queued 的 agent 节点，跑完租约在 dispatched
function injectQueued(db: Db, nodeRunId: string, now = '2026-11-13T03:00:00.000Z'): number {
  inTx(db, (tx) => {
    tx.run('INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, action_generation, rearm_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [nodeRunId, 'r1', 'n1', 9, 'agent', 1, 'queued', 0, 0, 0, now, now])
  })
  inTx(db, (tx) => acquireLease(tx, TEST_SECRET, { nodeRunId, ownerEpoch: 1, leaseTtlMs: 30000, now }))
  const row = db.raw.prepare('SELECT revision FROM node_runs WHERE node_run_id = ?').get(nodeRunId) as { revision: number }
  return Number(row.revision)
}

const strongReport = (nodeRunId: string, reportId: string, status: string) => ({
  report_id: reportId,
  node_run_id: nodeRunId,
  attempt: 1,
  status,
  evidence: { source: 'run_tool' as const, exitCode: 0, stdoutHash: 'a'.repeat(64), stderrHash: 'b'.repeat(64), hashes: {}, producedAt: '2026-11-13T03:00:00.000Z' },
})
const NODE_ROW = (db: Db, id: string) => db.raw.prepare('SELECT status, action_generation, attempt, fence_state, cancel_result, lease_expires_at FROM node_runs WHERE node_run_id = ?').get(id)

async function caseG03(): Promise<InjectionResult> {
  const { file, db } = freshLedger(); seed(db)
  const before = dumpState(file)
  injectQueued(db, 'nrun_g03')
  const policy = { passConditions: [{ path: 'evidence.exitCode', op: 'eq' as const, value: 0 }] }
  const run = () => inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
    nodeRunId: 'nrun_g03', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: '2026-11-13T03:00:00.000Z',
    report: strongReport('nrun_g03', 'rpt_g03_1', 'started'),
  }, policy))
  const first = run()
  const second = run()
  const applied = (db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nrun_g03' AND type = 'report_applied'").get() as { n: number }).n
  const reg = db.raw.prepare("SELECT report_id, state, COUNT(*) AS n FROM report_registry WHERE report_id = 'rpt_g03_1' GROUP BY report_id, state").all() as Record<string, unknown>[]
  db.raw.close()
  return {
    case: 'G-03',
    params: { db: file, report_id: 'rpt_g03_1', node_run_id: 'nrun_g03', repeat: 2 },
    before, after: dumpState(file),
    reconcile: '第一次 accepted=' + String(first.accepted) + '；第二次 accepted=' + String(second.accepted) + ' state=' + String(second.registry_state)
      + '；report_applied 条数=' + String(applied) + '；registry 对账=' + JSON.stringify(reg),
  }
}

async function caseG04(): Promise<InjectionResult> {
  const { file, db } = freshLedger(); seed(db)
  const before = dumpState(file)
  injectQueued(db, 'nrun_g04')
  db.raw.prepare("UPDATE node_runs SET lease_expires_at = '2026-11-11T00:00:00.000Z' WHERE node_run_id = 'nrun_g04'").run()
  let code = ''
  try {
    inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nrun_g04', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: '2026-11-13T03:00:00.000Z',
      report: strongReport('nrun_g04', 'rpt_g04_1', 'started'),
    }, { passConditions: [] }))
  } catch (err) {
    code = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err))
  }
  const row = NODE_ROW(db, 'nrun_g04')
  db.raw.close()
  return {
    case: 'G-04',
    params: { db: file, node_run_id: 'nrun_g04', lease_ttl_ms: 30000, late_by: '2 天' },
    before, after: dumpState(file),
    reconcile: '迟到上报被拒码=' + code + '；节点未动：' + JSON.stringify(row),
  }
}

// G-05 走真实生产路径：工具在飞时取消，围栏只立一次，围栏期间的上报排队，宽限到点撤围栏并挑出队头
async function caseG05(): Promise<InjectionResult> {
  const dir = mkdtempSync(join(tmpdir(), 'orch-g05-'))
  const file = join(dir, 'orchestra.db')
  const secret = 'g05-secret'
  const NOW = '2026-11-13T03:00:00.000Z'
  const gate: { release?: (v: { exitCode: number; stdout: string; stderr: string }) => void; started?: () => void } = {}
  const toolInFlight = new Promise<void>((resolve) => { gate.started = resolve })
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  const host: HostRunner = {
    readonlyAvailable: () => true,
    // 工具起飞后先不返回：取消就发生在它还在飞的时候
    run: async () => {
      gate.started?.()
      return await new Promise((resolve) => { gate.release = resolve })
    },
  }
  const agents: HostAgentFactory = { create: async () => ({ agentId: 'agent_g05', sessionId: 'sess_g05' }) }
  const runner = new ReadOnlyToolRunner(registry, host, dir)
  const orchestra = createOrchestra({ dbFile: file, secret, phase: 'S2', executor: { registry, agents, runner } })
  withTx(orchestra.db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t_g05','取消注入','running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, status, revision, created_at, updated_at) VALUES ('r_g05','t_g05','wf',7,'running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nrun_g05','r_g05','check',1,'agent',1,'queued',0,?,?)", [NOW, NOW])
  })
  orchestra.catalog.load({
    workflow_version: '7',
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
    nodes: [{ node_id: 'check', type: 'agent' }],
  })
  const before = dumpState(file)
  const runPromise = runNode(
    { runtime: orchestra.runtime, db: orchestra.db, secret, registry, agents, runner },
    {
      nodeRunId: 'nrun_g05', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
      toolPolicy: { allow: [], deny: [], declaredPolicy: 'pure' },
      tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
      now: NOW, ownerEpoch: 1, leaseTtlMs: 600000,
    },
  )
  // 等工具真的起飞
  await toolInFlight
  const inFlight = orchestra.db.raw.prepare("SELECT status, tool_start_at FROM node_runs WHERE node_run_id = 'nrun_g05'").get() as { status: string; tool_start_at: string }
  const rev1 = Number((orchestra.db.raw.prepare("SELECT revision FROM node_runs WHERE node_run_id = 'nrun_g05'").get() as { revision: number }).revision)
  const first = inTx(orchestra.db, (tx) => applyCancel(tx, secret, {
    nodeRunId: 'nrun_g05', attempt: 1, revision: rev1, cancelResult: 'interrupted', now: NOW, graceMs: 30000,
  }))
  const rev2 = Number((orchestra.db.raw.prepare("SELECT revision FROM node_runs WHERE node_run_id = 'nrun_g05'").get() as { revision: number }).revision)
  const second = inTx(orchestra.db, (tx) => applyCancel(tx, secret, {
    nodeRunId: 'nrun_g05', attempt: 1, revision: rev2, cancelResult: 'interrupted', now: NOW, graceMs: 30000,
  }))
  // 围栏还立着的时候来的上报：进登记排队
  const late = inTx(orchestra.db, (tx) => applyReport(tx, secret, {
    nodeRunId: 'nrun_g05', attempt: 1, expectedStatus: 'started', generation: 1, now: NOW,
    report: {
      report_id: 'rpt_g05_late', node_run_id: 'nrun_g05', attempt: 1, status: 'done',
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'a'.repeat(64), stderrHash: 'b'.repeat(64), hashes: {}, producedAt: NOW },
    },
  }, { passConditions: [] }))
  // 工具这时才落地：节点已经在围栏里，收口必须被挡住
  gate.release?.({ exitCode: 0, stdout: 'ok\n', stderr: '' })
  let runErr = ''
  try {
    await runPromise
  } catch (err) {
    runErr = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err))
  }
  // 宽限到点：撤围栏回 stopping，并把排队上报的队头挑出来
  const swept = sweep(orchestra.db, secret, { now: '2026-11-13T03:00:30.000Z' })
  const armed = (orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nrun_g05' AND type = 'fence_armed'").get() as { n: number }).n
  const toolEvents = (orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nrun_g05' AND type = 'tool_started'").get() as { n: number }).n
  const row = orchestra.db.raw.prepare("SELECT status, fence_state, cancel_result, tool_start_at FROM node_runs WHERE node_run_id = 'nrun_g05'").get()
  orchestra.close()
  const after = dumpState(file)
  rmSync(dir, { recursive: true, force: true })
  return {
    case: 'G-05',
    params: { db: file, node_run_id: 'nrun_g05', cancel_result: 'interrupted', grace_ms: 30000, tool: 'ro.echo' },
    before, after,
    reconcile: '工具在飞时状态=' + JSON.stringify(inFlight) + '；tool_started 条数=' + String(toolEvents)
      + '；第一次取消=' + JSON.stringify(first) + '；第二次取消=' + JSON.stringify(second)
      + '；fence_armed 条数=' + String(armed)
      + '；围栏期间上报=' + JSON.stringify(late)
      + '；工具落地后收口报错码=' + runErr
      + '；宽限到点扫描=' + JSON.stringify(swept)
      + '；节点行=' + JSON.stringify(row),
  }
}

// G-07：给节点真截止锚点，再让墙钟前后各跳十分钟，判定只认 boot_id + 单调纳秒
async function caseG07(): Promise<InjectionResult> {
  const { file, db } = freshLedger(); seed(db)
  const before = dumpState(file)
  const revision = injectQueued(db, 'nrun_g07')
  inTx(db, (tx) => rearmDeadline(tx, TEST_SECRET, {
    nodeRunId: 'nrun_g07', attempt: 1, revision,
    deadlineAt: '2026-11-13T03:01:00.000Z', deadlineBootId: 'boot_g07', deadlineMonotonicNs: 60e9,
    rearmGeneration: 1, now: '2026-11-13T03:00:00.000Z', reason: 'g07_deadline',
  }))
  const anchor = db.raw.prepare("SELECT deadline_at, deadline_boot_id, deadline_monotonic_ns FROM node_runs WHERE node_run_id = 'nrun_g07'").get() as {
    deadline_at: string; deadline_boot_id: string; deadline_monotonic_ns: number
  }
  const deadline = deadlineFromRow(anchor)
  const origin = { wallClockMs: 1_000_000, monotonicNs: 0 }
  // 不跳钟：按锚点正常判，还有 50 秒
  const steady = new MonotonicClock('boot_g07', origin)
  const normal = steady.decide(deadline!, { bootId: 'boot_g07', monotonicNs: 10e9, wallClockMs: 1_000_000 + 10_000 })
  // 墙钟前跳十分钟：漂移超差，只敢判不确定，不自动判超时
  const forwardClock = new MonotonicClock('boot_g07', origin)
  const drift = forwardClock.sample(origin.wallClockMs + 600_000, 1_000_000_000)
  const forward = forwardClock.decide(deadline!, { bootId: 'boot_g07', monotonicNs: 10e9, wallClockMs: origin.wallClockMs + 600_000 })
  // 墙钟后跳十分钟：同样只判不确定
  const backwardClock = new MonotonicClock('boot_g07', origin)
  backwardClock.sample(origin.wallClockMs - 600_000, 0)
  const backward = backwardClock.decide(deadline!, { bootId: 'boot_g07', monotonicNs: 10e9, wallClockMs: origin.wallClockMs - 600_000 })
  // 跨 boot：停机时间不算进预算，判不确定
  const reboot = forwardClock.decide(deadline!, { bootId: 'boot_g08', monotonicNs: 5e9, wallClockMs: origin.wallClockMs })
  const row = db.raw.prepare("SELECT status, deadline_at, deadline_boot_id, deadline_monotonic_ns FROM node_runs WHERE node_run_id = 'nrun_g07'").get()
  db.raw.close()
  return {
    case: 'G-07',
    params: { db: file, node_run_id: 'nrun_g07', jump_ms: 600000, deadline_at: '2026-11-13T03:01:00.000Z', deadline_boot_id: 'boot_g07' },
    before, after: dumpState(file),
    reconcile: '节点截止锚点=' + JSON.stringify(anchor)
      + '；不跳钟判=' + JSON.stringify(normal)
      + '；向前跳十分钟 drift=' + String(drift) + 'ms 判=' + JSON.stringify(forward)
      + '；向后跳判=' + JSON.stringify(backward) + '；跨 boot 判=' + JSON.stringify(reboot)
      + '；节点行=' + JSON.stringify(row),
  }
}

// —— S2 门证据：四个走真实 HTTP 入口的用例（审计 N-10）——

type HttpBoot = { endpoint: string; file: string; db: Db; close: () => Promise<void> }

// 起真服务：真库、真路由、真执行器；工具固定回 ok，重跑字节一致
async function bootHttp(secret: string): Promise<HttpBoot> {
  const dir = mkdtempSync(join(tmpdir(), 'orch-ev-'))
  const file = join(dir, 'orchestra.db')
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  const host: HostRunner = {
    readonlyAvailable: () => true,
    run: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }),
  }
  const agents: HostAgentFactory = { create: async () => ({ agentId: 'agent_ev', sessionId: 'sess_ev' }) }
  const runner = new ReadOnlyToolRunner(registry, host, dir)
  const orchestra = createOrchestra({ dbFile: file, secret, phase: 'S2', executor: { registry, agents, runner } })
  const server = await startServer({
    secret, phase: 'S2', epoch: orchestra.db.epoch,
    asOfSeq: () => Number((orchestra.db.raw.prepare('SELECT MAX(seq) AS s FROM events').get() as { s: number | null }).s ?? 0),
    listTasks: () => [],
    listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'evt_service' }),
    commands: orchestra.commands,
  })
  return {
    endpoint: server.endpoint, file, db: orchestra.db,
    close: async () => { await server.close(); orchestra.close() },
  }
}

// 真路由真鉴权地发一条请求
const postJson = async (endpoint: string, path: string, body: unknown, secret: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(endpoint + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orchestra-secret': secret },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = { raw: text }
  try { parsed = JSON.parse(text) } catch { /* 非 JSON 就原样留 */ }
  return { status: res.status, body: parsed }
}

// 生产链路的账本快照：任务、run、节点、节点事件、上报登记
const dumpProduction = (file: string): string => {
  const db = openDb(file, { readonly: true })
  try {
    const parts: string[] = []
    const events = db.raw.prepare('SELECT seq, type, event_id FROM events ORDER BY seq ASC').all() as { seq: number; type: string; event_id: string }[]
    parts.push('events: ' + (events.length === 0 ? '(空)' : events.map((r) => String(r.seq) + ' ' + r.type + ' ' + r.event_id).join('\n  ')))
    const tasks = db.raw.prepare('SELECT task_id, title, workflow_version, status, revision FROM tasks ORDER BY task_id ASC').all() as Record<string, unknown>[]
    parts.push('tasks: ' + (tasks.length === 0 ? '(空)' : tasks.map((r) => JSON.stringify(r)).join('\n  ')))
    const runs = db.raw.prepare('SELECT run_id, task_id, workflow_version, status, revision FROM runs ORDER BY run_id ASC').all() as Record<string, unknown>[]
    parts.push('runs: ' + (runs.length === 0 ? '(空)' : runs.map((r) => JSON.stringify(r)).join('\n  ')))
    const nodes = db.raw.prepare('SELECT node_run_id, run_id, node_id, seq, node_type, status, attempt, revision, action_generation, tool_start_at, verify_deadline_at, fence_state, cancel_result FROM node_runs ORDER BY node_run_id ASC').all() as Record<string, unknown>[]
    parts.push('node_runs: ' + (nodes.length === 0 ? '(空)' : nodes.map((r) => JSON.stringify(r)).join('\n  ')))
    const nrev = db.raw.prepare('SELECT node_run_id, seq, type FROM node_run_events ORDER BY node_run_id ASC, seq ASC').all() as Record<string, unknown>[]
    parts.push('node_run_events: ' + (nrev.length === 0 ? '(空)' : nrev.map((r) => JSON.stringify(r)).join('\n  ')))
    const reg = db.raw.prepare('SELECT report_id, node_run_id, attempt, report_seq, state FROM report_registry ORDER BY report_seq ASC').all() as Record<string, unknown>[]
    parts.push('report_registry: ' + (reg.length === 0 ? '(空)' : reg.map((r) => JSON.stringify(r)).join('\n  ')))
    return parts.join('\n')
  } finally {
    db.raw.close()
  }
}

const EV_NOW = '2026-11-13T03:00:00.000Z'
const EV_DEF = {
  workflow_version: '1',
  pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
  nodes: [{ node_id: 'check', type: 'agent' }],
}

// ev-g2-01：生产全链路——加载定义 → 建 run → 派发 → 收口（审计 F-01）
async function caseEvG201(): Promise<InjectionResult> {
  const secret = 'ev-g2-01-secret'
  const boot = await bootHttp(secret)
  const before = dumpProduction(boot.file)
  const loaded = await postJson(boot.endpoint, '/v1/workflows/load', EV_DEF, secret)
  const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '生产全链路验证', workflowVersion: '1', now: EV_NOW }, secret)
  const createdData = created.body?.data ?? {}
  const dispatched = await postJson(boot.endpoint, '/v1/runs/dispatch', {
    runId: createdData.run_id,
    nodes: { check: { toolPolicy: { allow: [], deny: [], declaredPolicy: 'pure' }, tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }] } },
    now: EV_NOW,
  }, secret)
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, node_id, status, attempt, revision, action_generation, tool_start_at, verify_deadline_at FROM node_runs ORDER BY node_run_id ASC').all()
  const nodeEvents = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  const registry = boot.db.raw.prepare('SELECT report_id, attempt, report_seq, state FROM report_registry ORDER BY report_seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-01',
    params: { db: boot.file, 入口: 'POST /v1/workflows/load → POST /v1/runs → POST /v1/runs/dispatch', workflow_version: '1', 工具: 'ro.echo' },
    before, after,
    reconcile: '加载 HTTP=' + String(loaded.status) + ' 返回=' + JSON.stringify(loaded.body?.data ?? loaded.body)
      + '；建 run HTTP=' + String(created.status) + ' 返回=' + JSON.stringify(createdData)
      + '；派发 HTTP=' + String(dispatched.status) + ' 返回=' + JSON.stringify(dispatched.body?.data ?? dispatched.body)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；节点事件=' + JSON.stringify(nodeEvents)
      + '；上报登记=' + JSON.stringify(registry),
  }
}

// ev-g2-05：终态必须带证据——走到 verifying 再报 done，没证据就得拒
async function caseEvG205(): Promise<InjectionResult> {
  const secret = 'ev-g2-05-secret'
  const boot = await bootHttp(secret)
  const before = dumpProduction(boot.file)
  await postJson(boot.endpoint, '/v1/workflows/load', EV_DEF, secret)
  const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '终态证据门', workflowVersion: '1', now: EV_NOW }, secret)
  const nodeRunId = created.body?.data?.nodes?.[0]?.node_run_id ?? ''
  const leased = await postJson(boot.endpoint, '/v1/node-runs/lease', { nodeRunId, ownerEpoch: 1, leaseTtlMs: 600000, now: EV_NOW }, secret)
  const gen = Number(leased.body?.data?.action_generation ?? 0)
  const started = await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'dispatched', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev05_started', node_run_id: nodeRunId, attempt: 1, status: 'started' },
  }, secret)
  const verifying = await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'started', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev05_verifying', node_run_id: nodeRunId, attempt: 1, status: 'verifying' },
  }, secret)
  const doneNoEvidence = await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'verifying', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev05_done_no_evidence', node_run_id: nodeRunId, attempt: 1, status: 'done' },
  }, secret)
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, status, attempt, revision, action_generation, verify_deadline_at FROM node_runs ORDER BY node_run_id ASC').all()
  const registry = boot.db.raw.prepare('SELECT report_id, attempt, report_seq, state FROM report_registry ORDER BY report_seq ASC').all()
  const events = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-05',
    params: { db: boot.file, 入口: 'POST /v1/node-runs/report', 节点: nodeRunId, 判定条件: 'evidence.exitCode eq 0', 报告: 'started → verifying → done（不带证据）' },
    before, after,
    reconcile: '租约 HTTP=' + String(leased.status) + ' 动作代=' + String(gen)
      + '；报 started HTTP=' + String(started.status) + ' 返回=' + JSON.stringify(started.body?.data ?? started.body)
      + '；报 verifying HTTP=' + String(verifying.status) + ' 返回=' + JSON.stringify(verifying.body?.data ?? verifying.body)
      + '；报 done（无证据）HTTP=' + String(doneNoEvidence.status) + ' 返回=' + JSON.stringify(doneNoEvidence.body?.data ?? doneNoEvidence.body)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；上报登记=' + JSON.stringify(registry)
      + '；节点事件=' + JSON.stringify(events),
  }
}

// ev-g2-06：卡住必须挂凭据——裸 blocked_post 要拒，带 verify_human 才算数
async function caseEvG206(): Promise<InjectionResult> {
  const secret = 'ev-g2-06-secret'
  const boot = await bootHttp(secret)
  const before = dumpProduction(boot.file)
  await postJson(boot.endpoint, '/v1/workflows/load', EV_DEF, secret)
  const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '阻塞凭据门', workflowVersion: '1', now: EV_NOW }, secret)
  const nodeRunId = created.body?.data?.nodes?.[0]?.node_run_id ?? ''
  const leased = await postJson(boot.endpoint, '/v1/node-runs/lease', { nodeRunId, ownerEpoch: 1, leaseTtlMs: 600000, now: EV_NOW }, secret)
  const gen = Number(leased.body?.data?.action_generation ?? 0)
  await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'dispatched', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev06_started', node_run_id: nodeRunId, attempt: 1, status: 'started' },
  }, secret)
  const bare = await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'started', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev06_bare_block', node_run_id: nodeRunId, attempt: 1, status: 'blocked_post' },
  }, secret)
  const withReason = await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'started', generation: gen, now: EV_NOW,
    report: {
      report_id: 'rpt_ev06_block_with_reason', node_run_id: nodeRunId, attempt: 1, status: 'blocked_post',
      output: { request: { reason: '外部接口凭证过期，要换新凭证才能继续', missing: ['接口凭证'] } },
    },
  }, secret)
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, status, attempt, revision, action_generation FROM node_runs ORDER BY node_run_id ASC').all()
  const registry = boot.db.raw.prepare('SELECT report_id, attempt, report_seq, state FROM report_registry ORDER BY report_seq ASC').all()
  const verifyHuman = boot.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'verify_human'").get() as { n: number }
  const events = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-06',
    params: { db: boot.file, 入口: 'POST /v1/node-runs/report', 节点: nodeRunId, 报告: 'blocked_post（裸）→ blocked_post（带 verify_human）' },
    before, after,
    reconcile: '裸阻塞 HTTP=' + String(bare.status) + ' 返回=' + JSON.stringify(bare.body?.data ?? bare.body)
      + '；带凭据阻塞 HTTP=' + String(withReason.status) + ' 返回=' + JSON.stringify(withReason.body?.data ?? withReason.body)
      + '；verify_human 事件条数=' + String(verifyHuman.n)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；上报登记=' + JSON.stringify(registry)
      + '；节点事件=' + JSON.stringify(events),
  }
}

// ev-g2-07：阶段能力闸——越界定义在加载口就被拒，不许留痕
async function caseEvG207(): Promise<InjectionResult> {
  const secret = 'ev-g2-07-secret'
  const boot = await bootHttp(secret)
  const before = dumpProduction(boot.file)
  const parallelLoad = await postJson(boot.endpoint, '/v1/workflows/load', {
    workflow_version: '2', pass_conditions: [], nodes: [{ node_id: 'fan', type: 'parallel' }],
  }, secret)
  const agentLoad = await postJson(boot.endpoint, '/v1/workflows/load', {
    workflow_version: '3', pass_conditions: [], nodes: [{ node_id: 'check', type: 'agent' }],
  }, secret)
  const runAfterReject = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '越界定义不许留痕', workflowVersion: '2', now: EV_NOW }, secret)
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, status FROM node_runs ORDER BY node_run_id ASC').all()
  const eventRows = boot.db.raw.prepare('SELECT seq, type, event_id FROM events ORDER BY seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-07',
    params: { db: boot.file, 入口: 'POST /v1/workflows/load', 阶段: 'S2', 越界定义: 'nodes[0].type=parallel' },
    before, after,
    reconcile: '加载 parallel 定义 HTTP=' + String(parallelLoad.status) + ' 错误=' + JSON.stringify(parallelLoad.body?.error ?? parallelLoad.body)
      + '；加载 agent 定义 HTTP=' + String(agentLoad.status) + ' 返回=' + JSON.stringify(agentLoad.body?.data ?? agentLoad.body)
      + '；用被拒的版本建 run HTTP=' + String(runAfterReject.status) + ' 错误=' + JSON.stringify(runAfterReject.body?.error ?? runAfterReject.body)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；账本事件=' + JSON.stringify(eventRows),
  }
}
export async function runCase(name: InjectionCase): Promise<InjectionResult> {
  switch (name) {
    case 'G-01': return caseG01()
    case 'G-02': return caseG02()
    case 'G-03': return caseG03()
    case 'G-04': return caseG04()
    case 'G-05': return caseG05()
    case 'G-07': return caseG07()
    case 'G-08': return caseG08()
    case 'G-09': return caseG09()
    case 'G-14': return caseG14()
    case 'G-15': return caseG15()
    case 'ev-g2-01': return caseEvG201()
    case 'ev-g2-05': return caseEvG205()
    case 'ev-g2-06': return caseEvG206()
    case 'ev-g2-07': return caseEvG207()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const idx = process.argv.indexOf('--case')
  const name = (idx >= 0 ? process.argv[idx + 1] : 'G-01') as InjectionCase
  const out = await runCase(name)
  const gate = ['G-03', 'G-04', 'G-05', 'G-07', 'ev-g2-01', 'ev-g2-05', 'ev-g2-06', 'ev-g2-07'].includes(name) ? 'G2' : 'G1'
  writeEvidence(join(process.cwd(), 'docs/gates/evidence/' + gate), out)
  console.log(JSON.stringify(out, null, 2))
}
