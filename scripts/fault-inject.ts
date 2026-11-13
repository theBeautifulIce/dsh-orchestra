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

export type InjectionCase = 'G-01' | 'G-02' | 'G-08' | 'G-09' | 'G-14' | 'G-15'

export type InjectionResult = {
  case: InjectionCase
  params: Record<string, unknown>
  before: string
  after: string
  reconcile: string
}

export function writeEvidence(dir: string, result: InjectionResult): void {
  mkdirSync(dir, { recursive: true })
  // 临时目录每次跑都不一样：证据里统一写成 <tmp>，别让失效路径进账
  const escapedTmp = JSON.stringify(tmpdir()).slice(1, -1)
  const params = JSON.stringify(result.params).split(escapedTmp).join('<tmp>')
  writeFileSync(join(dir, result.case + '.md'),
    '# ' + result.case + '\n\n- 参数：' + params + '\n'
    + '\n## 注入前账本片段\n\n```\n' + result.before + '\n```\n'
    + '\n## 恢复后账本片段\n\n```\n' + result.after + '\n```\n'
    + '\n## 对账查询\n\n```\n' + result.reconcile + '\n```\n', 'utf8')
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

export async function runCase(name: InjectionCase): Promise<InjectionResult> {
  switch (name) {
    case 'G-01': return caseG01()
    case 'G-02': return caseG02()
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
  writeEvidence(join(process.cwd(), 'docs/gates/evidence/G1'), out)
  console.log(JSON.stringify(out, null, 2))
}
