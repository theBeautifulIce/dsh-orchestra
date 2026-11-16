// G1 故障注入：每条都留下注入参数、前后账本片段、恢复后对账查询（规格 12.3 行 1077）
// 用法：node scripts/fault-inject.ts --case G-01   （Node 26 直接跑 TS）
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDb, withTx } from '../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../src/infra/db/migrate.ts'
import { listEvents } from '../src/service/queries/list_events.ts'
import { WriteQueue } from '../src/service/write-queue.ts'
import { createLogger } from '../src/infra/logger.ts'
import { backup, restore, sha256File, verifyBackup } from '../src/infra/backup.ts'
import { bindRunVersion, catalogFor, eventSeqs, freshLedger, seed, TEST_SECRET } from '../tests/fixtures/ledger.ts'
import { fakeAgentClient } from '../tests/fixtures/agent-bridge.ts'
import { inTx } from '../src/infra/db/tx.ts'
import { acquireLease, loadNodeRun } from '../src/service/commands/lease.ts'
import { applyReport } from '../src/service/commands/apply-report.ts'
import { applyCancel } from '../src/service/commands/cancel.ts'
import { MonotonicClock, deadlineFromRow, ScriptedClock } from '../src/core/clock.ts'

// 注入脚本也要单调时钟：取消的宽限/延期必须带锚点，否则扫描端一律判不确定
const injectClock = (nowIso: string) => new ScriptedClock('boot_inject', { wallClockMs: Date.parse(nowIso), monotonicNs: 0 })
import { rearmDeadline, transitionNode } from '../src/service/commands/node-state.ts'
import { sweep } from '../src/service/sweep.ts'
import { openServiceOrchestra } from '../src/index.ts'
import { acquireDbLock } from '../src/infra/lock.ts'
import { bumpEpoch } from '../src/infra/db/open.ts'
import { sweepNow, type RuntimeDeps } from '../src/service/commands/runtime.ts'
import { startServer } from '../src/service/server.ts'
import { ToolRegistry, ReadOnlyToolRunner, type HostRunner } from '../src/executor/tools.ts'
import { EvidenceCollector } from '../src/executor/evidence-collector.ts'
import { openDecision, resolveDecision } from '../src/service/commands/decisions.ts'
import { propagateRunCancellation } from '../src/service/commands/subworkflow.ts'
import { runNode } from '../src/executor/run-node.ts'
import type { HostAgentFactory } from '../src/executor/session.ts'
import type { Db } from '../src/infra/sqlite/driver.ts'

export type InjectionCase = 'G-01' | 'G-02' | 'G-03' | 'G-04' | 'G-05' | 'G-06' | 'G-07' | 'G-08' | 'G-09' | 'G-12' | 'G-14' | 'G-15' | 'G-16'
  | 'ev-g2-01' | 'ev-g2-02' | 'ev-g2-03' | 'ev-g2-04' | 'ev-g2-05' | 'ev-g2-06' | 'ev-g2-07'
  | 'ev-g2-08' | 'ev-g2-09' | 'ev-g2-10' | 'ev-g2-11' | 'ev-g2-12' | 'ev-g2-13' | 'ev-g2-14' | 'ev-g2-15'

export type InjectionResult = {
  case: InjectionCase
  params: Record<string, unknown>
  before: string
  after: string
  reconcile: string
}

// 证据要能重跑出同样的字节（审计 F-03）：临时路径统一写 <tmp>/文件名，事件 id 按首次出现归一成 evt_1、evt_2…
type EvidenceMaps = { ids: Map<string, string>; entity: Map<string, string>; entityCount: Map<string, number> }

// 同一份证据的四个区块必须共用一套映射：否则各自从 1 开始编号，会把 nrun_1/nrun_2 对调（第五轮审计 P2-3）
function normalizeEvidence(text: string, shared?: EvidenceMaps, normalizeRevision = false): string {
  const ids = shared?.ids ?? new Map<string, string>()
  const idOf = (raw: string): string => {
    let hit = ids.get(raw)
    if (!hit) { hit = 'evt_' + String(ids.size + 1); ids.set(raw, hit) }
    return hit
  }
  // 实体 id（tsk_/run_/nrun_/dec_/lease_）也是随机串，按首次出现归一成前缀_序号
  const entity = shared?.entity ?? new Map<string, string>()
  const entityCount = shared?.entityCount ?? new Map<string, number>()
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
  // 运行时刻（租约到期、工具开始、验收截止）也是环境噪声，统一写 <ts> 才谈得上重跑同字节。
  let out = text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<ts>')
  // 库文件的 sha 取决于 sqlite 页布局与随机盐，同一场景重跑也不会一样；它只是「前后是否一致」的证据载体，
  // 归一成 <db_sha>，结论句（线上库未变：true）仍逐字保留（S1 第三十轮 P2-3）。
  out = out.replace(/线上库 sha [0-9a-f]+/g, '线上库 sha <db_sha>')
  // 续租次数取决于调度抖动，revision 每跑一次都可能不同；它不是行为事实，
  // 写进证据会把“同一场景重跑同字节”变成偶然（S2 第二十六轮 P1-1）。
  if (normalizeRevision) out = out.replace(/"revision":\d+/g, '"revision":<n>')
  out = out.replace(/evt_[0-9a-f]{20,}/g, (m) => idOf(m))
  out = out.replace(/lease_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => entityOf(m))
  out = out.replace(/(tsk|run|nrun|dec)_[0-9a-f]{32}/g, (m) => entityOf(m))
  return out
}

export function writeEvidence(dir: string, result: InjectionResult): void {
  mkdirSync(dir, { recursive: true })
  const shared: EvidenceMaps = { ids: new Map(), entity: new Map(), entityCount: new Map() }
  // 只有 ev-g2-14 的续租次数会随并发抖动；其余证据保持原字节，避免无谓改锚。
  const norm = (value: string): string => normalizeEvidence(value, shared, result.case === 'ev-g2-14')
  // 临时目录里的一切绝对路径都要归一：G-15 会把备份目录写进参数，路径自带随机后缀，不归一就重跑不出同字节（S1 第三十轮 P2-3）
  const tmpRoot = tmpdir().replace(/[\\/]+$/, '')
  const scrubPath = (value: unknown): unknown => {
    if (typeof value !== 'string') return value
    const trimmed = value.replace(/[\\/]+$/, '')
    if (trimmed === tmpRoot) return '<tmp>'
    if (!trimmed.startsWith(tmpRoot)) return value
    const rest = trimmed.slice(tmpRoot.length).replace(/^[\\/]+/, '').split(/[\\/]/)
    return '<tmp>/' + (rest[rest.length - 1] ?? '')
  }
  const params = norm(JSON.stringify(result.params, (key, value) => scrubPath(value)))
  writeFileSync(join(dir, result.case + '.md'),
    '# ' + result.case + '\n\n- 参数：' + params + '\n'
    + '\n## 注入前账本片段\n\n```\n' + norm(result.before) + '\n```\n'
    + '\n## 恢复后账本片段\n\n```\n' + norm(result.after) + '\n```\n'
    + '\n## 对账查询\n\n```\n' + norm(result.reconcile) + '\n```\n', 'utf8')
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
  // HTTP 入口也验一遍：第一笔挂住占满队列，第二笔必须 503，且 warn 原文落在日志里（S1 第九轮 P2-1）
  const httpSecret = 'g08-http-secret'
  const logLines: string[] = []
  let enteredResolve!: () => void
  const entered = new Promise<void>((r) => { enteredResolve = r })
  let releaseResolve!: () => void
  const release = new Promise<void>((r) => { releaseResolve = r })
  const boot = await bootHttp(httpSecret, {
    queueMax: 1,
    holdAppend: { entered: () => { enteredResolve() }, until: release },
    logSink: logLines,
  })
  const first = postJson(boot.endpoint, '/v1/ledger/events', { type: 'inject.g08.http' }, httpSecret)
  await entered
  const second = await postJson(boot.endpoint, '/v1/ledger/events', { type: 'inject.g08.http2' }, httpSecret)
  releaseResolve()
  await first
  await boot.close()
  const parsedLogs = logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
  const warnRow = parsedLogs.find((row) => row.msg === '写队列满了，拒掉这一笔写')
  const warnText = warnRow
    ? String(warnRow.level) + ' ' + String(warnRow.msg) + ' ' + JSON.stringify({ pending: warnRow.pending, max: warnRow.max })
    : '(日志里没记到 warning)'
  return {
    case: 'G-08',
    params: { db: file, busyTimeoutMs: 30, queueMax: 2, httpQueueMax: 1 },
    before,
    after: dumpEvents(file),
    reconcile: '长事务期间读路径返回 ' + String(readOk) + ' 条（不为 0 即没被拖死）；第二个写者报 busy：' + String(busy.length > 0)
      + '；队列溢出码：' + queueErr
      + '；HTTP 队列满第二笔 HTTP=' + String(second.status) + ' 错误码=' + String(second.body?.error?.code ?? '')
      + '；warning 原文=' + warnText,
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
function injectQueued(db: Db, nodeRunId: string, now = '2026-11-13T03:00:00.000Z', nodeId = 'n2'): number {
  inTx(db, (tx) => {
    tx.run('INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, action_generation, rearm_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [nodeRunId, 'r1', nodeId, 9, 'agent', 1, 'queued', 0, 0, 0, now, now])
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
  const catalog = catalogFor(['n1', 'n2'])
  const { file, db } = freshLedger(); seed(db); bindRunVersion(db, catalog)
  const before = dumpState(file)
  injectQueued(db, 'nrun_g03')
  const run = () => inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
    nodeRunId: 'nrun_g03', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: '2026-11-13T03:00:00.000Z',
    report: strongReport('nrun_g03', 'rpt_g03_1', 'started'),
  }, catalog))
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
  const catalog = catalogFor(['n1', 'n2'])
  const { file, db } = freshLedger(); seed(db); bindRunVersion(db, catalog)
  const before = dumpState(file)
  injectQueued(db, 'nrun_g04')
  db.raw.prepare("UPDATE node_runs SET lease_expires_at = '2026-11-11T00:00:00.000Z' WHERE node_run_id = 'nrun_g04'").run()
  let code = ''
  try {
    inTx(db, (tx) => applyReport(tx, TEST_SECRET, {
      nodeRunId: 'nrun_g04', attempt: 1, expectedStatus: 'dispatched', generation: 1, now: '2026-11-13T03:00:00.000Z',
      report: strongReport('nrun_g04', 'rpt_g04_1', 'started'),
    }, catalog))
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

// G-06：工具已执行、结果没回 Agent；Agent 用同一 callId 重试时只重发结果，不重复执行工具。
async function caseG06(): Promise<InjectionResult> {
  const { dir, file, db } = freshLedger(); seed(db)
  const before = dumpState(file)
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  let executions = 0
  const host: HostRunner = {
    readonlyAvailable: () => true,
    run: async () => { executions += 1; return { exitCode: 0, stdout: 'ok\n', stderr: '' } },
  }
  const collector = new EvidenceCollector({
    db, secret: TEST_SECRET, registry, runner: new ReadOnlyToolRunner(registry, host, dir),
    policy: { allow: ['ro.echo'], deny: [], declaredPolicy: 'pure' }, allowedTools: ['ro.echo'],
    nodeRunId: 'nr1', attempt: 1, executorAgentId: 'agent_1', nowAt: () => '2026-11-13T03:00:00.000Z',
  })
  const call = { callId: 'call_g06', tool: 'ro.echo', args: [], cwd: '.', timeoutMs: 1000 }
  const first = await collector.collect(call)
  // 第一次 toolResult 回送在网络上丢了；Agent 重连后用同一 callId 重试。
  const second = await collector.collect(call)
  const outbox = db.raw.prepare('SELECT status, result_json FROM bridge_tool_outbox WHERE node_run_id = ? AND attempt = ? AND call_id = ?')
    .get('nr1', 1, 'call_g06') as { status: string; result_json: string }
  db.raw.close()
  return {
    case: 'G-06',
    params: { db: file, call_id: 'call_g06', tool: 'ro.echo', retry_after_lost_result: true },
    before,
    after: dumpState(file) + '\nbridge_tool_outbox: ' + JSON.stringify(outbox),
    reconcile: '宿主实际执行次数=' + String(executions)
      + '；两次回传 exitCode=' + String(first.exitCode) + '/' + String(second.exitCode)
      + '；outbox=' + outbox.status,
  }
}

// G-12：人工审批双击；同一 revision 只有一笔能收口，另一笔必须冲突回滚。
function caseG12(): InjectionResult {
  const { file, db } = freshLedger(); seed(db)
  const now = '2026-11-13T03:00:00.000Z'
  const before = dumpState(file)
  inTx(db, (tx) => openDecision(tx, {
    decisionId: 'dec_g12', runId: 'r1', nodeRunId: null, kind: 'pre_execution', createdAt: now,
  }))
  const approve = () => inTx(db, (tx) => resolveDecision(tx, TEST_SECRET, {
    decisionId: 'dec_g12', revision: 1, resolution: 'approved', now,
    actor: { kind: 'human', id: 'human:g12' },
  }))
  approve()
  let code = ''
  try { approve() } catch (err) {
    code = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err))
  }
  const row = db.raw.prepare('SELECT decision_id, status, revision, closed_reason FROM decisions WHERE decision_id = ?').get('dec_g12')
  db.raw.close()
  return {
    case: 'G-12',
    params: { db: file, decision_id: 'dec_g12', clicks: 2, same_revision: 1 },
    before,
    after: dumpState(file) + '\ndecisions: ' + JSON.stringify(row),
    reconcile: '第二次审批被拒码=' + code + '；决策行=' + JSON.stringify(row),
  }
}

// G-16：父 run 取消时，子 run 里可补偿的进行中节点被取消，不可逆节点保留待核验。
function caseG16(): InjectionResult {
  const { file, db } = freshLedger(); seed(db)
  const now = '2026-11-13T03:00:00.000Z'
  inTx(db, (tx) => {
    tx.run("INSERT INTO runs (run_id, task_id, status, revision, parent_run_id, root_run_id, subworkflow_depth, created_at, updated_at) VALUES ('r2', 't1', 'running', 1, 'r1', 'r1', 1, ?, ?)", [now, now])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, side_effect_policy, created_at, updated_at) VALUES ('nr_g16a', 'r2', 'n2', 2, 'agent', 1, 'started', 1, 'compensable', ?, ?)", [now, now])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, side_effect_policy, created_at, updated_at) VALUES ('nr_g16b', 'r2', 'n3', 3, 'agent', 1, 'started', 1, 'irreversible', ?, ?)", [now, now])
  })
  const before = dumpState(file)
  const result = inTx(db, (tx) => propagateRunCancellation(tx, TEST_SECRET, {
    runId: 'r1', cancelResult: 'interrupted', now, graceMs: 1000, clock: injectClock(now),
  }))
  const childRun = db.raw.prepare("SELECT cancel_result FROM runs WHERE run_id = 'r2'").get()
  const nodes = db.raw.prepare("SELECT node_run_id, status, cancel_result FROM node_runs WHERE node_run_id IN ('nr_g16a','nr_g16b') ORDER BY node_run_id").all()
  db.raw.close()
  return {
    case: 'G-16',
    params: { db: file, parent_run_id: 'r1', child_run_id: 'r2', grace_ms: 1000 },
    before,
    after: dumpState(file) + '\nchild_run: ' + JSON.stringify(childRun) + '\nchild_nodes: ' + JSON.stringify(nodes),
    reconcile: '取消传播=' + JSON.stringify(result) + '；子 run=' + JSON.stringify(childRun) + '；子节点=' + JSON.stringify(nodes),
  }
}

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
  const bridge = fakeAgentClient({ agentId: 'agent_g05', steps: [{ tool: 'ro.echo' }], at: NOW })
  const service = await openServiceOrchestra({ dbFile: file, secret, phase: 'S2', executor: { registry, agents, bridge, runner } })
  const orchestra = service.orchestra
  orchestra.catalog.load({
    workflow_version: '7',
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
    nodes: [{ node_id: 'check', type: 'agent', tools: { allow: ['ro.echo'], deny: [] } }],
  })
  const definitionHash = orchestra.catalog.definitionHash('default', '7')
  withTx(orchestra.db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t_g05','取消注入','running',1,?,?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, created_at, updated_at) VALUES ('r_g05','t_g05','default',7,?,'running',1,?,?)", [definitionHash, NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) VALUES ('nrun_g05','r_g05','check',1,'agent',1,'queued',0,?,?)", [NOW, NOW])
  })
  const before = dumpState(file)
  const runPromise = runNode(
    { runtime: orchestra.runtime, db: orchestra.db, secret, registry, agents, bridge, runner },
    {
      nodeRunId: 'nrun_g05', nodeId: 'check', attempt: 1, input: {}, outputSchema: {},
      tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }],
      now: NOW, ownerEpoch: 1, leaseTtlMs: 120000,
    },
  )
  // 等工具真的起飞
  await toolInFlight
  const inFlight = orchestra.db.raw.prepare("SELECT status, tool_start_at FROM node_runs WHERE node_run_id = 'nrun_g05'").get() as { status: string; tool_start_at: string }
  const rev1 = Number((orchestra.db.raw.prepare("SELECT revision FROM node_runs WHERE node_run_id = 'nrun_g05'").get() as { revision: number }).revision)
  // 同一只钟贯穿取消与扫描：围栏锚点与判定必须同一 boot，否则 decide 判不确定（规格 3.4）
  const g05Clock = injectClock(NOW)
  const first = inTx(orchestra.db, (tx) => applyCancel(tx, secret, {
    nodeRunId: 'nrun_g05', attempt: 1, revision: rev1, cancelResult: 'interrupted', now: NOW, graceMs: 30000, clock: g05Clock,
  }))
  const rev2 = Number((orchestra.db.raw.prepare("SELECT revision FROM node_runs WHERE node_run_id = 'nrun_g05'").get() as { revision: number }).revision)
  const second = inTx(orchestra.db, (tx) => applyCancel(tx, secret, {
    nodeRunId: 'nrun_g05', attempt: 1, revision: rev2, cancelResult: 'interrupted', now: NOW, graceMs: 30000, clock: g05Clock,
  }))
  // 围栏还立着的时候来的上报：进登记排队
  const late = inTx(orchestra.db, (tx) => applyReport(tx, secret, {
    nodeRunId: 'nrun_g05', attempt: 1, expectedStatus: 'started', generation: 1, now: NOW,
    report: {
      report_id: 'rpt_g05_late', node_run_id: 'nrun_g05', attempt: 1, status: 'done',
      evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'a'.repeat(64), stderrHash: 'b'.repeat(64), hashes: {}, producedAt: NOW },
    },
  }, orchestra.catalog))
  // 工具这时才落地：节点已经在围栏里，收口必须被挡住
  gate.release?.({ exitCode: 0, stdout: 'ok\n', stderr: '' })
  let runErr = ''
  try {
    await runPromise
  } catch (err) {
    runErr = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err))
  }
  // 宽限到点：撤围栏回 stopping，并把排队上报的队头挑出来
  g05Clock.advanceMs(31_000)
  g05Clock.setWallClockMs(g05Clock.sample().wallClockMs + 31_000)
  const swept = sweep(orchestra.db, secret, { now: '2026-11-13T03:00:31.000Z' , clock: g05Clock})
  const armed = (orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nrun_g05' AND type = 'fence_armed'").get() as { n: number }).n
  const toolEvents = (orchestra.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id = 'nrun_g05' AND type = 'tool_started'").get() as { n: number }).n
  const row = orchestra.db.raw.prepare("SELECT status, fence_state, cancel_result, tool_start_at FROM node_runs WHERE node_run_id = 'nrun_g05'").get()
  await service.release()
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

type HttpBoot = { endpoint: string; file: string; db: Db; runtime: RuntimeDeps; close: () => Promise<void> }

type HttpBootOpts = {
  failingTool?: boolean
  delayMs?: number
  dbFile?: string
  // 写队列上限与挂起入口：G-08 用它把队列灌满，验 HTTP 503 与 warning 原文（S1 第九轮 P2-1）
  queueMax?: number
  holdAppend?: { entered: () => void; until: Promise<void> }
  logSink?: string[]
  // 可推进的服务端时钟：租约到期类用例靠它把上报推到 TTL 之后（审计 r46 P1-1）
  now?: () => string
}

// 起真服务：真库、真路由、真执行器；工具固定回 ok，重跑字节一致
async function bootHttp(secret: string, opts?: HttpBootOpts): Promise<HttpBoot> {
  // 指定 dbFile 就重启同一个库：跨重启用例靠它验定义持久化（ev-g2-15）
  const file = opts?.dbFile ?? join(mkdtempSync(join(tmpdir(), 'orch-ev-')), 'orchestra.db')
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  // 故意失败的工具：宿主直接回非零退出码，用来验「工具失败不许落完成」
  if (opts?.failingTool) registry.register({ name: 'ro.fail', capability: 'read_only', command: { bin: 'ro-fail-bin', args: ['boom'] } })
  const host: HostRunner = {
    readonlyAvailable: () => true,
    run: async (input) => {
      if (opts?.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
      return input.bin === 'ro-fail-bin' ? { exitCode: 1, stdout: '', stderr: 'boom: 工具故意失败' } : { exitCode: 0, stdout: 'ok\n', stderr: '' }
    },
  }
  const agents: HostAgentFactory = { create: async () => ({ agentId: 'agent_ev', sessionId: 'sess_ev' }) }
  const runner = new ReadOnlyToolRunner(registry, host, dir)
  const bridge = fakeAgentClient({
    agentId: 'agent_ev',
    steps: [{ tool: opts?.failingTool ? 'ro.fail' : 'ro.echo' }],
    at: '2026-11-13T03:00:00.000Z',
  })
  const service = await openServiceOrchestra({ dbFile: file, secret, phase: 'S2', executor: { registry, agents, bridge, runner } })
  const orchestra = service.orchestra
  const log = createLogger({ write: (line) => { opts?.logSink?.push(line) } })
  const append = opts?.holdAppend
    ? (async () => {
      opts.holdAppend!.entered()
      await opts.holdAppend!.until
      return { seq: 0, event_id: 'evt_service' }
    })
    : (() => ({ seq: 0, event_id: 'evt_service' }))
  const server = await startServer({
    secret, phase: 'S2', epoch: orchestra.db.epoch,
    asOfSeq: () => Number((orchestra.db.raw.prepare('SELECT MAX(seq) AS s FROM events').get() as { s: number | null }).s ?? 0),
    listTasks: () => [],
    listEvents: () => [],
    appendLedgerEvent: append as unknown as (body: unknown, actor: string) => { seq: number; event_id: string },
    log,
    queue: opts?.queueMax === undefined ? undefined : new WriteQueue(opts.queueMax, log),
    ...(opts?.now ? { now: opts.now } : {}),
    commands: orchestra.commands,
  })
  return {
    endpoint: server.endpoint, file, db: orchestra.db, runtime: orchestra.runtime,
    close: async () => { await server.close(); await service.release() },
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
  nodes: [{ node_id: 'check', type: 'agent', tools: { allow: ['ro.echo'], deny: [] } }],
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
    nodes: { check: { tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }] } },
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
  const leased = await postJson(boot.endpoint, '/v1/node-runs/lease', { nodeRunId, ownerEpoch: 1, leaseTtlMs: 120000, now: EV_NOW }, secret)
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
  const leased = await postJson(boot.endpoint, '/v1/node-runs/lease', { nodeRunId, ownerEpoch: 1, leaseTtlMs: 120000, now: EV_NOW }, secret)
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
// ev-g2-08：工具失败不许落完成——失败由系统判，节点卡在 blocked_post 并留 verify_human（审计 R3-01）
async function caseEvG208(): Promise<InjectionResult> {
  const secret = 'ev-g2-08-secret'
  const boot = await bootHttp(secret, { failingTool: true })
  const before = dumpProduction(boot.file)
  // 判定条件故意留空：失败必须由系统判，不许外包给模板条件
  const def = { workflow_version: '8', pass_conditions: [], nodes: [{ node_id: 'check', type: 'agent', tools: { allow: ['ro.fail'], deny: [] } }] }
  const loaded = await postJson(boot.endpoint, '/v1/workflows/load', def, secret)
  const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '工具失败不许落完成', workflowVersion: '8', now: EV_NOW }, secret)
  const createdData = created.body?.data ?? {}
  const dispatched = await postJson(boot.endpoint, '/v1/runs/dispatch', {
    runId: createdData.run_id,
    nodes: { check: { tools: [{ command: 'ro.fail', args: [], cwd: '.', timeoutMs: 5000 }] } },
    now: EV_NOW,
  }, secret)
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, node_id, status, attempt, revision, action_generation, tool_start_at, verify_deadline_at FROM node_runs ORDER BY node_run_id ASC').all()
  const toolRows = boot.db.raw.prepare('SELECT node_run_id, attempt, tool, exit_code, stdout_hash, command_hash FROM tool_executions ORDER BY node_run_id ASC').all()
  const registry = boot.db.raw.prepare('SELECT report_id, attempt, report_seq, state FROM report_registry ORDER BY report_seq ASC').all()
  const human = boot.db.raw.prepare("SELECT seq, type, payload FROM node_run_events WHERE type = 'verify_human' ORDER BY seq ASC").all()
  const events = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-08',
    params: { db: boot.file, 入口: 'POST /v1/workflows/load → POST /v1/runs → POST /v1/runs/dispatch', workflow_version: '8', 工具: 'ro.fail（宿主回 exitCode 1）', 判定条件: '空（失败必须由系统判，不外包给模板）' },
    before, after,
    reconcile: '加载 HTTP=' + String(loaded.status)
      + '；建 run HTTP=' + String(created.status)
      + '；派发 HTTP=' + String(dispatched.status) + ' 返回=' + JSON.stringify(dispatched.body?.data ?? dispatched.body)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；工具痕迹=' + JSON.stringify(toolRows)
      + '；上报登记=' + JSON.stringify(registry)
      + '；verify_human=' + JSON.stringify(human)
      + '；节点事件=' + JSON.stringify(events),
  }
}

// ev-g2-09：判定时限只认 boot_id 与单调纳秒——墙钟跳变、跨 boot、没锚点都不许误判超时（审计 R3-02）
async function caseEvG209(): Promise<InjectionResult> {
  const secret = 'ev-g2-09-secret'
  const boot = await bootHttp(secret)
  const before = dumpProduction(boot.file)
  const def = { workflow_version: '9', pass_conditions: [], nodes: [{ node_id: 'check', type: 'agent' }] }
  await postJson(boot.endpoint, '/v1/workflows/load', def, secret)

  // 真入口建节点并推到 started
  const startNode = async (title: string, tag: string): Promise<{ nodeRunId: string; generation: number }> => {
    const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: title, workflowVersion: '9', now: EV_NOW }, secret)
    const nodeRunId = String(created.body?.data?.nodes?.[0]?.node_run_id ?? '')
    const leased = await postJson(boot.endpoint, '/v1/node-runs/lease', { nodeRunId, ownerEpoch: 1, leaseTtlMs: 120000, now: EV_NOW }, secret)
    const generation = Number(leased.body?.data?.action_generation ?? 0)
    await postJson(boot.endpoint, '/v1/node-runs/report', {
      nodeRunId, attempt: 1, expectedStatus: 'dispatched', generation, now: EV_NOW,
      report: { report_id: 'rpt_ev09_started_' + tag, node_run_id: nodeRunId, attempt: 1, status: 'started' },
    }, secret)
    return { nodeRunId, generation }
  }

  // 挂判定锚点：墙钟只作展示，判定列写 boot_id 与单调纳秒（规格 3.4 行 171）
  const anchorVerifying = (nodeRunId: string, bootId: string): void => {
    withTx(boot.db, (tx) => {
      const row = loadNodeRun(tx, nodeRunId)
      transitionNode(tx, secret, {
        nodeRunId, from: 'started', to: 'verifying',
        attempt: row.attempt, revision: row.revision, now: EV_NOW, reason: 'work_submitted',
        verifyTimeoutMs: 10000,
        verifyAnchor: { bootId, monotonicNs: 0, wallClockMs: Date.parse(EV_NOW) },
      })
    })
  }

  // 场景一：墙钟向前跳十分钟、单调钟只走五秒——漂移超差只能判不确定，不许误判超时
  const a = await startNode('墙钟跳变不误判超时', 'a')
  anchorVerifying(a.nodeRunId, 'boot_ev09_a')
  const clockA = new ScriptedClock('boot_ev09_a', { wallClockMs: Date.parse(EV_NOW), monotonicNs: 0 })
  clockA.advanceMs(5000)
  clockA.setWallClockMs(Date.parse(EV_NOW) + 600000)
  const sweepA = sweep(boot.db, secret, { now: EV_NOW, clock: clockA })

  // 场景二：单调钟与墙钟同步走满预算——判定时限真的到点，才转阻塞
  const b = await startNode('判定预算走完转阻塞', 'b')
  anchorVerifying(b.nodeRunId, 'boot_ev09_a')
  const clockB = new ScriptedClock('boot_ev09_a', { wallClockMs: Date.parse(EV_NOW), monotonicNs: 0 })
  clockB.advanceMs(11000)
  clockB.setWallClockMs(Date.parse(EV_NOW) + 11000)
  const sweepB = sweep(boot.db, secret, { now: EV_NOW, clock: clockB })

  // 场景三：判定中途重启——跨 boot 只能判不确定，不许拿旧预算硬判超时
  const c = await startNode('跨 boot 不误判超时', 'c')
  anchorVerifying(c.nodeRunId, 'boot_ev09_a')
  const clockC = new ScriptedClock('boot_ev09_a', { wallClockMs: Date.parse(EV_NOW), monotonicNs: 0 })
  clockC.advanceMs(5000)
  clockC.setWallClockMs(Date.parse(EV_NOW) + 5000)
  clockC.reboot('boot_ev09_b')
  const sweepC = sweep(boot.db, secret, { now: EV_NOW, clock: clockC })

  // 场景四：报告入口没有锚点——没有判定依据就等人来看，不自动判超时
  const d = await startNode('没有锚点不自动判超时', 'd')
  await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId: d.nodeRunId, attempt: 1, expectedStatus: 'started', generation: d.generation, now: EV_NOW,
    report: { report_id: 'rpt_ev09_verifying_d', node_run_id: d.nodeRunId, attempt: 1, status: 'verifying' },
  }, secret)
  const clockD = new ScriptedClock('boot_ev09_a', { wallClockMs: Date.parse(EV_NOW) + 600000, monotonicNs: 0 })
  const sweepD = sweep(boot.db, secret, { now: EV_NOW, clock: clockD })

  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, node_id, status, attempt, revision, verify_deadline_at, verify_deadline_boot_id, verify_deadline_monotonic_ns, verify_remaining_ns FROM node_runs ORDER BY node_run_id ASC').all()
  const human = boot.db.raw.prepare("SELECT seq, type, payload FROM node_run_events WHERE type = 'verify_human' ORDER BY seq ASC").all()
  const events = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  const registry = boot.db.raw.prepare('SELECT report_id, attempt, report_seq, state FROM report_registry ORDER BY report_seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-09',
    params: { db: boot.file, 入口: 'POST /v1/runs → POST /v1/node-runs/lease → POST /v1/node-runs/report → sweep', workflow_version: '9', 判定预算: '10000 毫秒', 锚点: 'boot_ev09_a / 单调纳秒 0' },
    before, after,
    reconcile: '墙钟跳十分钟：超时=' + JSON.stringify(sweepA.verify_timed_out) + ' 不确定=' + JSON.stringify(sweepA.verify_uncertain)
      + '；预算走完：超时=' + JSON.stringify(sweepB.verify_timed_out) + ' 不确定=' + JSON.stringify(sweepB.verify_uncertain)
      + '；跨 boot：超时=' + JSON.stringify(sweepC.verify_timed_out) + ' 不确定=' + JSON.stringify(sweepC.verify_uncertain)
      + '；没有锚点：超时=' + JSON.stringify(sweepD.verify_timed_out) + ' 不确定=' + JSON.stringify(sweepD.verify_uncertain)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；verify_human=' + JSON.stringify(human)
      + '；上报登记=' + JSON.stringify(registry)
      + '；节点事件=' + JSON.stringify(events),
  }
}

// ev-g2-10：报告入口的系统级证据门——伪造的完成进不来，真跑出来的照样收口（审计 R3-03）
async function caseEvG210(): Promise<InjectionResult> {
  const secret = 'ev-g2-10-secret'
  const boot = await bootHttp(secret)
  const before = dumpProduction(boot.file)
  const loaded = await postJson(boot.endpoint, '/v1/workflows/load', EV_DEF, secret)
  const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '报告入口证据门', workflowVersion: '1', now: EV_NOW }, secret)
  const nodeRunId = String(created.body?.data?.nodes?.[0]?.node_run_id ?? '')
  const leased = await postJson(boot.endpoint, '/v1/node-runs/lease', { nodeRunId, ownerEpoch: 1, leaseTtlMs: 120000, now: EV_NOW }, secret)
  const gen = Number(leased.body?.data?.action_generation ?? 0)
  await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'dispatched', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev10_started', node_run_id: nodeRunId, attempt: 1, status: 'started' },
  }, secret)
  await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'started', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev10_verifying', node_run_id: nodeRunId, attempt: 1, status: 'verifying' },
  }, secret)
  // 伪造的强证据：看着像执行器跑出来的，其实账本里没有这条工具痕迹
  const forged = await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'verifying', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev10_forged_done', node_run_id: nodeRunId, attempt: 1, status: 'done', evidence: { source: 'run_tool', exitCode: 0, stdoutHash: 'deadbeef', stderrHash: 'deadbeef', hashes: {}, producedAt: EV_NOW } },
  }, secret)
  // 弱来源的证据：来源不是执行器跑出来的
  const weak = await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'verifying', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev10_weak_done', node_run_id: nodeRunId, attempt: 1, status: 'done', evidence: { source: 'tool_result', exitCode: 0, stdoutHash: 'deadbeef' } },
  }, secret)
  // 空证据：什么都没带
  const empty = await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'verifying', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev10_empty_done', node_run_id: nodeRunId, attempt: 1, status: 'done' },
  }, secret)
  // 对照组：真派发真工具，证据门不许把正常路堵死
  const control = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '真派发对照', workflowVersion: '1', now: EV_NOW }, secret)
  const controlDispatch = await postJson(boot.endpoint, '/v1/runs/dispatch', {
    runId: control.body?.data?.run_id,
    nodes: { check: { tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }] } },
    now: EV_NOW,
  }, secret)
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, node_id, status, attempt, revision, verify_deadline_at FROM node_runs ORDER BY node_run_id ASC').all()
  const toolRows = boot.db.raw.prepare('SELECT node_run_id, attempt, tool, exit_code, stdout_hash FROM tool_executions ORDER BY node_run_id ASC').all()
  const registry = boot.db.raw.prepare('SELECT report_id, node_run_id, attempt, report_seq, state FROM report_registry ORDER BY report_seq ASC').all()
  const events = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-10',
    params: { db: boot.file, 入口: 'POST /v1/node-runs/report（伪造三条）＋对照真派发', workflow_version: '1', 伪造证据: 'run_tool 强证据 / tool_result 弱来源 / 空证据' },
    before, after,
    reconcile: '加载 HTTP=' + String(loaded.status)
      + '；建 run HTTP=' + String(created.status)
      + '；伪造强证据返回=' + JSON.stringify(forged.body?.data ?? forged.body)
      + '；弱来源证据返回=' + JSON.stringify(weak.body?.data ?? weak.body)
      + '；空证据返回=' + JSON.stringify(empty.body?.data ?? empty.body)
      + '；对照派发 HTTP=' + String(controlDispatch.status) + ' 返回=' + JSON.stringify(controlDispatch.body?.data ?? controlDispatch.body)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；工具痕迹=' + JSON.stringify(toolRows)
      + '；上报登记=' + JSON.stringify(registry)
      + '；节点事件=' + JSON.stringify(events),
  }
}
// ev-g2-02：重复上报只落一次——同一个 report_id 连投三次，账本只留一条落账（审计 R3-04）
async function caseEvG202(): Promise<InjectionResult> {
  const secret = 'ev-g2-02-secret'
  const boot = await bootHttp(secret)
  const before = dumpProduction(boot.file)
  await postJson(boot.endpoint, '/v1/workflows/load', EV_DEF, secret)
  const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '重复上报只落一次', workflowVersion: '1', now: EV_NOW }, secret)
  const nodeRunId = String(created.body?.data?.nodes?.[0]?.node_run_id ?? '')
  const leased = await postJson(boot.endpoint, '/v1/node-runs/lease', { nodeRunId, ownerEpoch: 1, leaseTtlMs: 120000, now: EV_NOW }, secret)
  const gen = Number(leased.body?.data?.action_generation ?? 0)
  const body = {
    nodeRunId, attempt: 1, expectedStatus: 'dispatched', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev02_same', node_run_id: nodeRunId, attempt: 1, status: 'started' },
  }
  const first = await postJson(boot.endpoint, '/v1/node-runs/report', body, secret)
  const second = await postJson(boot.endpoint, '/v1/node-runs/report', body, secret)
  const third = await postJson(boot.endpoint, '/v1/node-runs/report', body, secret)
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, status, attempt, revision, action_generation FROM node_runs ORDER BY node_run_id ASC').all()
  const applied = boot.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'report_applied'").get() as { n: number }
  const replayed = boot.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'report_replayed'").get() as { n: number }
  const rejected = boot.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'report_rejected'").get() as { n: number }
  const registry = boot.db.raw.prepare('SELECT report_id, attempt, report_seq, state FROM report_registry ORDER BY report_seq ASC').all()
  const events = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-02',
    params: { db: boot.file, 入口: 'POST /v1/node-runs/report', 节点: nodeRunId, 报告: '同一个 report_id 连投三次' },
    before, after,
    reconcile: '第一次 HTTP=' + String(first.status) + ' 返回=' + JSON.stringify(first.body?.data ?? first.body)
      + '；第二次 HTTP=' + String(second.status) + ' 返回=' + JSON.stringify(second.body?.data ?? second.body)
      + '；第三次 HTTP=' + String(third.status) + ' 返回=' + JSON.stringify(third.body?.data ?? third.body)
      + '；report_applied 条数=' + String(applied.n)
      + '；report_replayed 条数=' + String(replayed.n)
      + '；report_rejected 条数=' + String(rejected.n)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；上报登记=' + JSON.stringify(registry)
      + '；节点事件=' + JSON.stringify(events),
  }
}

// ev-g2-03：租约过期迟到上报被拒——租约只给 1 秒，执行器 5 秒后才回话（审计 R3-11）
async function caseEvG203(): Promise<InjectionResult> {
  const secret = 'ev-g2-03-secret'
  // 服务端只认自己的时钟，请求体 now 不参与判定；这里把服务端时钟从 T0 推到 T0+5s。
  let nowMs = Date.parse(EV_NOW)
  const boot = await bootHttp(secret, { now: () => new Date(nowMs).toISOString() })
  const before = dumpProduction(boot.file)
  await postJson(boot.endpoint, '/v1/workflows/load', EV_DEF, secret)
  const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '租约过期迟到上报被拒', workflowVersion: '1', now: EV_NOW }, secret)
  const nodeRunId = String(created.body?.data?.nodes?.[0]?.node_run_id ?? '')
  const leased = await postJson(boot.endpoint, '/v1/node-runs/lease', { nodeRunId, ownerEpoch: 1, leaseTtlMs: 1000, now: EV_NOW }, secret)
  const gen = Number(leased.body?.data?.action_generation ?? 0)
  nowMs += 5000
  const late = await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'dispatched', generation: gen, now: '2026-11-13T03:00:05.000Z',
    report: { report_id: 'rpt_ev03_late', node_run_id: nodeRunId, attempt: 1, status: 'started' },
  }, secret)
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, status, attempt, revision, action_generation, lease_expires_at FROM node_runs ORDER BY node_run_id ASC').all()
  const registry = boot.db.raw.prepare('SELECT report_id, attempt, report_seq, state FROM report_registry ORDER BY report_seq ASC').all()
  const applied = boot.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'report_applied'").get() as { n: number }
  const events = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-03',
    params: { db: boot.file, 入口: 'POST /v1/node-runs/lease → POST /v1/node-runs/report', 节点: nodeRunId, 租约毫秒: 1000, 迟到毫秒: 5000 },
    before, after,
    reconcile: '租约 HTTP=' + String(leased.status) + ' 到期=' + String(leased.body?.data?.expires_at ?? '')
      + '；迟到上报 HTTP=' + String(late.status) + ' 错误=' + JSON.stringify(late.body?.error ?? late.body)
      + '；report_applied 条数=' + String(applied.n)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；上报登记=' + JSON.stringify(registry)
      + '；节点事件=' + JSON.stringify(events),
  }
}

// ev-g2-04：取消后不产生新 attempt——作废后 attempt 仍是 1，迟到上报按 attempt 不符被拒（审计 R3-11）
async function caseEvG204(): Promise<InjectionResult> {
  const secret = 'ev-g2-04-secret'
  const boot = await bootHttp(secret)
  const before = dumpProduction(boot.file)
  await postJson(boot.endpoint, '/v1/workflows/load', EV_DEF, secret)
  // 节点一：还没派发就取消——直接作废，不进围栏、不产生新 attempt
  const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '取消后不产生新 attempt', workflowVersion: '1', now: EV_NOW }, secret)
  const nodeRunId = String(created.body?.data?.nodes?.[0]?.node_run_id ?? '')
  const rev1 = Number((boot.db.raw.prepare('SELECT revision FROM node_runs WHERE node_run_id = ?').get(nodeRunId) as { revision: number }).revision)
  const cancelled = await postJson(boot.endpoint, '/v1/node-runs/cancel', {
    nodeRunId, attempt: 1, revision: rev1, cancelResult: 'not_interruptible', now: EV_NOW, graceMs: 1000,
  }, secret)
  // 取消后还想按新 attempt 上报：按 attempt 不符被拒，不许新起一轮
  const lateNewAttempt = await postJson(boot.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 2, expectedStatus: 'superseded', generation: 0, now: EV_NOW,
    report: { report_id: 'rpt_ev04_new_attempt', node_run_id: nodeRunId, attempt: 2, status: 'started' },
  }, secret)
  // 节点二：派发后取消——只立一次围栏，attempt 同样不涨
  const created2 = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '派发后取消只立一次围栏', workflowVersion: '1', now: EV_NOW }, secret)
  const nodeRunId2 = String(created2.body?.data?.nodes?.[0]?.node_run_id ?? '')
  await postJson(boot.endpoint, '/v1/node-runs/lease', { nodeRunId: nodeRunId2, ownerEpoch: 1, leaseTtlMs: 120000, now: EV_NOW }, secret)
  const rev2 = Number((boot.db.raw.prepare('SELECT revision FROM node_runs WHERE node_run_id = ?').get(nodeRunId2) as { revision: number }).revision)
  const cancelled2 = await postJson(boot.endpoint, '/v1/node-runs/cancel', {
    nodeRunId: nodeRunId2, attempt: 1, revision: rev2, cancelResult: 'interrupted', now: EV_NOW, graceMs: 1000,
  }, secret)
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, status, attempt, revision, action_generation, fence_state, cancel_result FROM node_runs ORDER BY node_run_id ASC').all()
  const armed = boot.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'fence_armed'").get() as { n: number }
  const registry = boot.db.raw.prepare('SELECT report_id, attempt, report_seq, state FROM report_registry ORDER BY report_seq ASC').all()
  const events = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-04',
    params: { db: boot.file, 入口: 'POST /v1/node-runs/cancel → POST /v1/node-runs/report', 节点: nodeRunId, 取消结果: 'not_interruptible（未派发） / interrupted（派发后）' },
    before, after,
    reconcile: '未派发就取消 HTTP=' + String(cancelled.status) + ' 返回=' + JSON.stringify(cancelled.body?.data ?? cancelled.body)
      + '；取消后按 attempt=2 上报 HTTP=' + String(lateNewAttempt.status) + ' 返回=' + JSON.stringify(lateNewAttempt.body?.data ?? lateNewAttempt.body)
      + '；派发后取消 HTTP=' + String(cancelled2.status) + ' 返回=' + JSON.stringify(cancelled2.body?.data ?? cancelled2.body)
      + '；fence_armed 条数=' + String(armed.n)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；上报登记=' + JSON.stringify(registry)
      + '；节点事件=' + JSON.stringify(events),
  }
}

// ev-g2-11：反复重投同一条被拒的报告——账本不许被重试刷膨胀（审计 R3-04）
async function caseEvG211(): Promise<InjectionResult> {
  const secret = 'ev-g2-11-secret'
  const boot = await bootHttp(secret)
  const before = dumpProduction(boot.file)
  await postJson(boot.endpoint, '/v1/workflows/load', EV_DEF, secret)
  const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '反复重投被拒报告', workflowVersion: '1', now: EV_NOW }, secret)
  const nodeRunId = String(created.body?.data?.nodes?.[0]?.node_run_id ?? '')
  // 节点还在排队，故意报一个对不上的状态：每次都被拒，登记在 rejected 与 replayed 之间来回翻
  const body = {
    nodeRunId, attempt: 1, expectedStatus: 'dispatched', generation: 0, now: EV_NOW,
    report: { report_id: 'rpt_ev11_retry', node_run_id: nodeRunId, attempt: 1, status: 'started' },
  }
  const codes: number[] = []
  const results: unknown[] = []
  for (let i = 0; i < 4; i += 1) {
    const res = await postJson(boot.endpoint, '/v1/node-runs/report', body, secret)
    codes.push(res.status)
    results.push(res.body?.data ?? res.body)
  }
  // report_id 带引号：JSON 转义会让按文本比对的判重失效，所以入口就按字符集挡下（第三十四轮审计 P1-1）
  const quotedBody = {
    nodeRunId, attempt: 1, expectedStatus: 'dispatched', generation: 0, now: EV_NOW,
    report: { report_id: 'rpt_"ev11_quote', node_run_id: nodeRunId, attempt: 1, status: 'started' },
  }
  const quotedCodes: number[] = []
  const quotedResults: unknown[] = []
  for (let i = 0; i < 2; i += 1) {
    const res = await postJson(boot.endpoint, '/v1/node-runs/report', quotedBody, secret)
    quotedCodes.push(res.status)
    quotedResults.push(res.body?.error ?? res.body?.data ?? res.body)
  }
  const rejected = boot.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'report_rejected'").get() as { n: number }
  const replayed = boot.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'report_replayed'").get() as { n: number }
  const applied = boot.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'report_applied'").get() as { n: number }
  const registry = boot.db.raw.prepare('SELECT report_id, attempt, report_seq, state FROM report_registry ORDER BY report_seq ASC').all()
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, status, attempt, revision FROM node_runs ORDER BY node_run_id ASC').all()
  const events = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-11',
    params: { db: boot.file, 入口: 'POST /v1/node-runs/report', 节点: nodeRunId, 报告: '同一个 report_id 连投四次（每次都被拒）；再用带引号的 report_id 连投两次' },
    before, after,
    reconcile: '四次 HTTP 码=' + JSON.stringify(codes)
      + '；带引号 report_id 的 HTTP 码=' + JSON.stringify(quotedCodes)
      + '；带引号 report_id 的返回=' + JSON.stringify(quotedResults)
      + '；逐次返回=' + JSON.stringify(results)
      + '；report_rejected 条数=' + String(rejected.n)
      + '；report_replayed 条数=' + String(replayed.n)
      + '；report_applied 条数=' + String(applied.n)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；上报登记=' + JSON.stringify(registry)
      + '；节点事件=' + JSON.stringify(events),
  }
}

// ev-g2-12：授权只认 worker 定义——请求体里的 toolPolicy 不算数，越权与未注册在租约前就被拒（第五轮审计 P1-2）
async function caseEvG212(): Promise<InjectionResult> {
  const secret = 'ev-g2-12-secret'
  const boot = await bootHttp(secret, { failingTool: true })
  const before = dumpProduction(boot.file)
  const cases = [
    { version: '12', allow: ['ro.echo'], run: 'ro.fail', code: 'FORBIDDEN' },
    { version: '13', allow: [], run: 'ro.echo', code: 'FORBIDDEN' },
    { version: '14', allow: ['ro.ghost'], run: 'ro.echo', code: 'TOOL_NOT_REGISTERED' },
  ]
  const outcomes: unknown[] = []
  for (const item of cases) {
    await postJson(boot.endpoint, '/v1/workflows/load', {
      workflow_version: item.version, pass_conditions: [],
      nodes: [{ node_id: 'check', type: 'agent', tools: { allow: item.allow, deny: [] } }],
    }, secret)
    const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '授权只认定义 ' + item.version, workflowVersion: item.version, now: EV_NOW }, secret)
    const nodeRunId = String(created.body?.data?.nodes?.[0]?.node_run_id ?? '')
    // 请求体故意塞一份更宽的策略：服务端必须忽略它
    const dispatched = await postJson(boot.endpoint, '/v1/runs/dispatch', {
      runId: created.body?.data?.run_id, now: EV_NOW,
      toolPolicy: { allow: ['ro.echo', 'ro.fail'], deny: [], declaredPolicy: 'pure' },
      nodes: { check: { tools: [{ command: item.run, args: [], cwd: '.', timeoutMs: 5000 }] } },
    }, secret)
    const node = boot.db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id = ?').get(nodeRunId)
    outcomes.push({ version: item.version, http: dispatched.status, outcome: dispatched.body?.data?.[0], node })
  }
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, status, attempt, revision FROM node_runs ORDER BY node_run_id ASC').all()
  const leases = boot.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'lease_acquired'").get() as { n: number }
  const events = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-12',
    params: { db: boot.file, 入口: 'POST /v1/workflows/load → /v1/runs → /v1/runs/dispatch', 请求体策略: '故意带 toolPolicy allow=[ro.echo,ro.fail]' },
    before, after,
    reconcile: '三种定义下的派发结果=' + JSON.stringify(outcomes)
      + '；lease_acquired 条数=' + String(leases.n)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；节点事件=' + JSON.stringify(events),
  }
}

// ev-g2-13：单写者与围栏——第二把锁拿不到，老 epoch 的连接写不进（第五轮审计 P1-3）
async function caseEvG213(): Promise<InjectionResult> {
  const dir = mkdtempSync(join(tmpdir(), 'orch-g213-'))
  const file = join(dir, 'orchestra.db')
  const service = await openServiceOrchestra({ dbFile: file, secret: 'ev-g2-13-secret', phase: 'S2' })
  const firstEpoch = service.orchestra.db.epoch
  let secondLock = 'acquired'
  let releaseSecond: (() => Promise<void>) | null = null
  try {
    releaseSecond = await acquireDbLock(file)
  } catch (err) {
    secondLock = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err))
  }
  if (releaseSecond) await releaseSecond()
  const nextEpoch = bumpEpoch(file)
  let staleWrite = 'accepted'
  try {
    withTx(service.orchestra.db, (tx) => {
      tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t_old','老进程想写','running',1,?,?)", [EV_NOW, EV_NOW])
    })
  } catch (err) {
    staleWrite = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err))
  }
  await service.release()
  const after = dumpState(file)
  rmSync(dir, { recursive: true, force: true })
  return {
    case: 'ev-g2-13',
    params: { db: file, 入口: 'openServiceOrchestra（取锁 + epoch 自增）→ 再取锁 → bumpEpoch → 老连接写' },
    before: '(空账本，未建任何业务行)',
    after,
    reconcile: '首个写者 epoch=' + String(firstEpoch)
      + '；第二把锁=' + secondLock
      + '；外部 epoch 递增到=' + String(nextEpoch)
      + '；老连接写结果=' + staleWrite
      + '；释放后账本=' + after,
  }
}

// ev-g2-14：长动作心跳——动作 3 秒、租约 2 秒、500 毫秒续租，2.5 秒扫描不判过期（第五轮审计 P2-1）
async function caseEvG214(): Promise<InjectionResult> {
  const secret = 'ev-g2-14-secret'
  const boot = await bootHttp(secret, { delayMs: 3000 })
  const before = dumpProduction(boot.file)
  await postJson(boot.endpoint, '/v1/workflows/load', {
    workflow_version: '15', pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
    nodes: [{ node_id: 'check', type: 'agent', tools: { allow: ['ro.echo'], deny: [] } }],
  }, secret)
  const created = await postJson(boot.endpoint, '/v1/runs', { taskTitle: '长动作心跳', workflowVersion: '15', now: EV_NOW }, secret)
  const nodeRunId = String(created.body?.data?.nodes?.[0]?.node_run_id ?? '')
  const pending = postJson(boot.endpoint, '/v1/runs/dispatch', {
    runId: created.body?.data?.run_id, now: EV_NOW,
    leaseTtlMs: 2000, leaseRenewIntervalMs: 500,
    nodes: { check: { tools: [{ command: 'ro.echo', args: [], cwd: '.', timeoutMs: 5000 }] } },
  }, secret)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const swept = sweepNow(boot.runtime, new Date(Date.parse(EV_NOW) + 2500).toISOString())
  const midNode = boot.db.raw.prepare('SELECT status, lease_expires_at, tool_start_at FROM node_runs WHERE node_run_id = ?').get(nodeRunId)
  const dispatched = await pending
  const nodeRows = boot.db.raw.prepare('SELECT node_run_id, status, attempt, revision, lease_expires_at FROM node_runs ORDER BY node_run_id ASC').all()
  const expired = boot.db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE type = 'lease_expired'").get() as { n: number }
  const events = boot.db.raw.prepare('SELECT seq, type FROM node_run_events ORDER BY seq ASC').all()
  await boot.close()
  const after = dumpProduction(boot.file)
  return {
    case: 'ev-g2-14',
    params: { db: boot.file, 入口: 'POST /v1/runs/dispatch（3 秒动作 / 2 秒租约 / 500 毫秒续租）', 扫描时刻: '第 2500 毫秒' },
    before, after,
    reconcile: '派发 HTTP=' + String(dispatched.status) + ' 返回=' + JSON.stringify(dispatched.body?.data ?? dispatched.body)
      + '；2.5 秒扫描=' + JSON.stringify(swept)
      + '；扫描时节点=' + JSON.stringify(midNode)
      + '；lease_expired 条数=' + String(expired.n)
      + '；节点行=' + JSON.stringify(nodeRows)
      + '；节点事件=' + JSON.stringify(events),
  }
}

// ev-g2-15：定义必须跨重启落库——重启后同名版本不许改写，在飞 run 的判定条件不跟着变
// 先起服务把定义跑进 verifying，关掉，再用同一个库重启：hydrate 装回旧定义，改写被 409 拒
async function caseEvG215(): Promise<InjectionResult> {
  const secret = 'ev-g2-15-secret'
  const base = mkdtempSync(join(tmpdir(), 'orch-ev15-'))
  const file = join(base, 'orchestra.db')
  const first = await bootHttp(secret, { dbFile: file })
  const before = dumpProduction(file)
  const loaded = await postJson(first.endpoint, '/v1/workflows/load', EV_DEF, secret)
  const created = await postJson(first.endpoint, '/v1/runs', { taskTitle: '跨重启定义绑定', workflowVersion: '1', now: EV_NOW }, secret)
  const nodeRunId = String(created.body?.data?.nodes?.[0]?.node_run_id ?? '')
  const leased = await postJson(first.endpoint, '/v1/node-runs/lease', { nodeRunId, ownerEpoch: 1, leaseTtlMs: 120000, now: EV_NOW }, secret)
  const gen = Number(leased.body?.data?.action_generation ?? 0)
  await postJson(first.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'dispatched', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev15_started', node_run_id: nodeRunId, attempt: 1, status: 'started' },
  }, secret)
  const verifying = await postJson(first.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'started', generation: gen, now: EV_NOW,
    report: { report_id: 'rpt_ev15_verifying', node_run_id: nodeRunId, attempt: 1, status: 'verifying' },
  }, secret)
  const boundBefore = first.db.raw.prepare('SELECT workflow_version, workflow_definition_hash FROM runs ORDER BY run_id ASC').get()
  await first.close()

  // 重启同一个库：定义只应从账本装回来，不许从空目录重新放行
  const second = await bootHttp(secret, { dbFile: file })
  const versions = second.db.raw.prepare('SELECT version, content_hash FROM workflow_versions ORDER BY version ASC').all()
  const altered = { ...EV_DEF, pass_conditions: [] }
  const reload = await postJson(second.endpoint, '/v1/workflows/load', altered, secret)
  const boundAfter = second.db.raw.prepare('SELECT workflow_version, workflow_definition_hash FROM runs ORDER BY run_id ASC').get()
  const nodeAfter = second.db.raw.prepare('SELECT status, attempt, revision FROM node_runs WHERE node_run_id = ?').get(nodeRunId)
  // 弱证据（不是 run_tool 签发）来收口：判定条件若被改写就会放行，这里必须仍被拒
  const doneWeak = await postJson(second.endpoint, '/v1/node-runs/report', {
    nodeRunId, attempt: 1, expectedStatus: 'verifying', generation: gen, now: '2026-11-13T03:00:01.000Z',
    report: {
      report_id: 'rpt_ev15_done_weak', node_run_id: nodeRunId, attempt: 1, status: 'done',
      evidence: { source: 'tool_result', exitCode: 0, stdoutHash: 'h_ev15', hashes: {} },
    },
  }, secret)
  await second.close()
  const after = dumpProduction(file)
  return {
    case: 'ev-g2-15',
    params: { db: file, 入口: 'POST /v1/workflows/load × 2（同一库重启）', 节点: nodeRunId, 改写: 'workflow_version=1 但 pass_conditions=[]' },
    before, after,
    reconcile: '首次加载 HTTP=' + String(loaded.status)
      + '；验收到 verifying HTTP=' + String(verifying.status)
      + '；重启前绑定=' + JSON.stringify(boundBefore)
      + '；重启后定义表=' + JSON.stringify(versions)
      + '；改写同版本 HTTP=' + String(reload.status) + ' 错误=' + JSON.stringify(reload.body?.error ?? reload.body)
      + '；重启后绑定=' + JSON.stringify(boundAfter)
      + '；节点行=' + JSON.stringify(nodeAfter)
      + '；弱证据收口 HTTP=' + String(doneWeak.status) + ' 返回=' + JSON.stringify(doneWeak.body?.data ?? doneWeak.body?.error),
  }
}

export async function runCase(name: InjectionCase): Promise<InjectionResult> {
  switch (name) {
    case 'G-01': return caseG01()
    case 'G-02': return caseG02()
    case 'G-03': return caseG03()
    case 'G-04': return caseG04()
    case 'G-05': return caseG05()
    case 'G-06': return caseG06()
    case 'G-07': return caseG07()
    case 'G-08': return caseG08()
    case 'G-09': return caseG09()
    case 'G-12': return caseG12()
    case 'G-14': return caseG14()
    case 'G-15': return caseG15()
    case 'G-16': return caseG16()
    case 'ev-g2-01': return caseEvG201()
    case 'ev-g2-05': return caseEvG205()
    case 'ev-g2-06': return caseEvG206()
    case 'ev-g2-07': return caseEvG207()
    case 'ev-g2-08': return caseEvG208()
    case 'ev-g2-09': return caseEvG209()
    case 'ev-g2-10': return caseEvG210()
    case 'ev-g2-02': return caseEvG202()
    case 'ev-g2-03': return caseEvG203()
    case 'ev-g2-04': return caseEvG204()
    case 'ev-g2-11': return caseEvG211()
    case 'ev-g2-12': return caseEvG212()
    case 'ev-g2-13': return caseEvG213()
    case 'ev-g2-14': return caseEvG214()
    case 'ev-g2-15': return caseEvG215()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const idx = process.argv.indexOf('--case')
  const name = (idx >= 0 ? process.argv[idx + 1] : 'G-01') as InjectionCase
  const out = await runCase(name)
  const gate = ['G-03', 'G-04', 'G-05', 'G-07', 'ev-g2-01', 'ev-g2-02', 'ev-g2-03', 'ev-g2-04', 'ev-g2-05', 'ev-g2-06', 'ev-g2-07', 'ev-g2-08', 'ev-g2-09', 'ev-g2-10', 'ev-g2-11', 'ev-g2-12', 'ev-g2-13', 'ev-g2-14', 'ev-g2-15'].includes(name) ? 'G2' : 'G1'
  // --out 只是给复现守卫用的：把证据写到临时目录，别把工作树弄脏（S2 第三十五轮 P1-1）
  const outIdx = process.argv.indexOf('--out')
  const evidenceRoot = outIdx >= 0 ? process.argv[outIdx + 1]! : join(process.cwd(), 'docs/gates/evidence')
  writeEvidence(join(evidenceRoot, gate), out)
  console.log(JSON.stringify(out, null, 2))
}
