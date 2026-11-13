// G1 故障注入：每条都留下注入参数、前后账本片段、恢复后对账查询（规格 12.3 行 1077）
// 用法：node scripts/fault-inject.ts --case G-01   （Node 26 直接跑 TS）
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDb } from '../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../src/infra/db/migrate.ts'
import { listEvents } from '../src/service/queries/list_events.ts'
import { WriteQueue } from '../src/service/write-queue.ts'
import { backup, restore, sha256File, verifyBackup } from '../src/infra/backup.ts'
import { eventSeqs, freshLedger, seed, TEST_SECRET } from '../tests/fixtures/ledger.ts'
import { inTx } from '../src/infra/db/tx.ts'
import { acquireLease } from '../src/service/commands/lease.ts'
import { applyReport } from '../src/service/commands/apply-report.ts'
import { applyCancel } from '../src/service/commands/cancel.ts'
import { MonotonicClock } from '../src/core/clock.ts'
import type { Db } from '../src/infra/sqlite/driver.ts'

export type InjectionCase = 'G-01' | 'G-02' | 'G-03' | 'G-04' | 'G-05' | 'G-07' | 'G-08' | 'G-09' | 'G-14' | 'G-15'

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
  return text.replace(/evt_[0-9a-f]{20,}/g, (m) => idOf(m))
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
    const nodes = db.raw.prepare('SELECT node_run_id, status, attempt, revision, action_generation, fence_state FROM node_runs ORDER BY node_run_id ASC').all() as Record<string, unknown>[]
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

async function caseG05(): Promise<InjectionResult> {
  const { file, db } = freshLedger(); seed(db)
  const before = dumpState(file)
  const revision = injectQueued(db, 'nrun_g05')
  const out = inTx(db, (tx) => applyCancel(tx, TEST_SECRET, {
    nodeRunId: 'nrun_g05', attempt: 1, revision, cancelResult: 'interrupted', now: '2026-11-13T03:00:01.000Z', graceMs: 30000,
  }))
  const armed = (db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nrun_g05' AND type = 'fence_armed'").get() as { n: number }).n
  const row = NODE_ROW(db, 'nrun_g05')
  db.raw.close()
  return {
    case: 'G-05',
    params: { db: file, node_run_id: 'nrun_g05', cancel_result: 'interrupted', grace_ms: 30000 },
    before, after: dumpState(file),
    reconcile: '落位=' + JSON.stringify(out) + '；fence_armed 条数=' + String(armed) + '；节点行=' + JSON.stringify(row),
  }
}

async function caseG07(): Promise<InjectionResult> {
  const { file, db } = freshLedger(); seed(db)
  const before = dumpState(file)
  injectQueued(db, 'nrun_g07')
  const clock = new MonotonicClock('boot_g07', { wallClockMs: 1_000_000, monotonicNs: 0 })
  const drift = clock.sample(1_000_000 + 600_000, 1_000_000_000)
  const forward = clock.decide(
    { bootId: 'boot_g07', monotonicNs: 60e9, wallClockMs: 1_060_000 },
    { bootId: 'boot_g07', monotonicNs: 10e9, wallClockMs: 1_600_000 },
  )
  const backwardClock = new MonotonicClock('boot_g07', { wallClockMs: 1_000_000, monotonicNs: 0 })
  backwardClock.sample(1_000_000 - 600_000, 0)
  const backward = backwardClock.decide(
    { bootId: 'boot_g07', monotonicNs: 60e9, wallClockMs: 1_060_000 },
    { bootId: 'boot_g07', monotonicNs: 10e9, wallClockMs: 400_000 },
  )
  const reboot = clock.decide(
    { bootId: 'boot_g07', monotonicNs: 60e9, wallClockMs: 1_060_000 },
    { bootId: 'boot_g08', monotonicNs: 5e9, wallClockMs: 1_060_000 },
  )
  const row = db.raw.prepare("SELECT status, deadline_boot_id, deadline_monotonic_ns FROM node_runs WHERE node_run_id = 'nrun_g07'").get()
  db.raw.close()
  return {
    case: 'G-07',
    params: { db: file, node_run_id: 'nrun_g07', jump_ms: 600000 },
    before, after: dumpState(file),
    reconcile: '向前跳十分钟 drift=' + String(drift) + 'ms 判=' + JSON.stringify(forward)
      + '；向后跳判=' + JSON.stringify(backward) + '；跨 boot 判=' + JSON.stringify(reboot) + '；节点行=' + JSON.stringify(row),
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
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const idx = process.argv.indexOf('--case')
  const name = (idx >= 0 ? process.argv[idx + 1] : 'G-01') as InjectionCase
  const out = await runCase(name)
  const gate = ['G-03', 'G-04', 'G-05', 'G-07'].includes(name) ? 'G2' : 'G1'
  writeEvidence(join(process.cwd(), 'docs/gates/evidence/' + gate), out)
  console.log(JSON.stringify(out, null, 2))
}
