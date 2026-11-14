import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrchError } from '../../src/core/errors.ts'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { appendEvent, appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { CURSOR_TTL_MS, decodeCursor, encodeCursor, makeCursor } from '../../src/service/queries/cursor.ts'
import { listEvents } from '../../src/service/queries/list_events.ts'
import { listTasks } from '../../src/service/queries/list_tasks.ts'
import { getOperation } from '../../src/service/queries/get_operation.ts'
import { verifyLedger } from '../../src/service/queries/verify_ledger.ts'

const SECRET = 'query-secret'
const dirs: string[] = []
const closers: { close: () => void }[] = []
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-q-'))
  dirs.push(dir)
  const db = openDb(join(dir, 'orchestra.db'))
  closers.push(db.raw)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    for (let i = 1; i <= 3; i += 1) {
      tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES (?, ?, 'running', 1, ?, ?)",
        ['t' + String(i), '任务' + String(i), '2026-11-13T0' + String(i) + ':00:00.000Z', '2026-11-13T0' + String(i) + ':00:00.000Z'])
      appendEvent(tx, { type: 'task.created', runId: null, payload: { i } })
    }
    // 节点得在 node_runs 里有一条：账本校验要能看出「链挂在不存在的节点上」
    tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, ?, ?)",
      ['2026-11-13T01:00:00.000Z', '2026-11-13T01:00:00.000Z'])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) "
      + "VALUES ('n1', 'r1', 'n1', 1, 'agent', 1, 'started', 1, ?, ?)",
      ['2026-11-13T01:00:00.000Z', '2026-11-13T01:00:00.000Z'])
    appendNodeRunEvent(tx, SECRET, 'n1', 'started', { a: 1 })
    appendNodeRunEvent(tx, SECRET, 'n1', 'done', { a: 2 })
  })
  return db
}
afterEach(() => {
  for (const db of closers.splice(0)) { try { db.close() } catch { /* 已关 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})
const codeOf = (fn: () => unknown): string => {
  try { fn() } catch (err) { if (err instanceof OrchError) return err.code; throw err }
  throw new Error('本应抛错却通过了')
}

describe('事件分页', () => {
  it('按 seq 升序，as_of_seq 是最大 seq', () => {
    const db = seeded()
    const page = listEvents(db, { limit: 2 })
    expect((page.rows as { seq: number }[]).map((r) => r.seq)).toEqual([1, 2])
    expect(page.as_of_seq).toBe(3)
    const rest = listEvents(db, { fromSeq: 2, limit: 10 })
    expect((rest.rows as { seq: number }[]).map((r) => r.seq)).toEqual([3])
  })

  it('limit 超 200 → RANGE_TOO_LARGE', () => {
    const db = seeded()
    expect(codeOf(() => listEvents(db, { limit: 201 }))).toBe('RANGE_TOO_LARGE')
  })
})

describe('任务分页', () => {
  it('按 created_at DESC 分两页，游标接得上且不重不漏', () => {
    const db = seeded()
    const first = listTasks(db, { limit: 2 })
    expect((first.rows as { task_id: string }[]).map((r) => r.task_id)).toEqual(['t3', 't2'])
    expect(first.next_cursor).toBeTruthy()
    const second = listTasks(db, { limit: 2, cursor: first.next_cursor })
    expect((second.rows as { task_id: string }[]).map((r) => r.task_id)).toEqual(['t1'])
    expect(second.next_cursor).toBeNull()
  })

  it('limit 超 100 → RANGE_TOO_LARGE', () => {
    const db = seeded()
    expect(codeOf(() => listTasks(db, { limit: 101 }))).toBe('RANGE_TOO_LARGE')
  })

  it('status 过滤后游标换了 filter → CURSOR_FILTER_MISMATCH', () => {
    const db = seeded()
    const page = listTasks(db, { limit: 1 })
    expect(codeOf(() => listTasks(db, { limit: 1, cursor: page.next_cursor, filter: { status: 'running' } }))).toBe('CURSOR_FILTER_MISMATCH')
  })
})

describe('游标', () => {
  const filter = { status: null }
  it('往返拿回同值', () => {
    const c = makeCursor('tasks', filter, '2026-11-13', 't1', 7)
    expect(decodeCursor(encodeCursor(c), 'tasks', filter)).toEqual(c)
  })

  it('过期 → CURSOR_EXPIRED', () => {
    const c = makeCursor('tasks', filter, 'k', 'id', 7)
    expect(codeOf(() => decodeCursor(encodeCursor(c), 'tasks', filter, c.issued_at + CURSOR_TTL_MS + 1))).toBe('CURSOR_EXPIRED')
  })

  it('过滤条件变了 → CURSOR_FILTER_MISMATCH', () => {
    const c = makeCursor('tasks', filter, 'k', 'id', 7)
    expect(codeOf(() => decodeCursor(encodeCursor(c), 'tasks', { status: 'done' }))).toBe('CURSOR_FILTER_MISMATCH')
  })

  it('版本不认识 → PROTOCOL_VERSION_MISMATCH', () => {
    const c = { ...makeCursor('tasks', filter, 'k', 'id', 7), v: 2 } as unknown as { v: 1 }
    const raw = Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
    expect(codeOf(() => decodeCursor(raw, 'tasks', filter))).toBe('PROTOCOL_VERSION_MISMATCH')
  })

  it('乱码 → CURSOR_EXPIRED', () => {
    expect(codeOf(() => decodeCursor('!!!not-base64-json!!!', 'tasks', filter))).toBe('CURSOR_EXPIRED')
  })
})

describe('账本校验与回执', () => {
  it('链完好 ok=true，条目数对得上', () => {
    const db = seeded()
    expect(verifyLedger(db, SECRET)).toEqual({ ok: true, chains: 1, entries: 2, break: null, gaps: [] })
  })

  it('改一条 payload → ok=false 且 break.seq 指到那条', () => {
    const db = seeded()
    // 只追加触发器在位时账本改不动：要模拟篡改，先卸掉触发器（等于绕过应用直接改库）
    db.raw.exec('DROP TRIGGER trg_node_run_events_no_update')
    db.raw.prepare("UPDATE node_run_events SET payload = '{\"a\":9}' WHERE node_run_id = 'n1' AND seq = 2").run()
    const out = verifyLedger(db, SECRET)
    expect(out.ok).toBe(false)
    expect(out.break?.seq).toBe(2)
  })

  it('回执：有则返回、无则 NOT_FOUND、过期则 OPERATION_EXPIRED', () => {
    const db = seeded()
    expect(codeOf(() => getOperation(db, 'op-missing'))).toBe('NOT_FOUND')
    withTx(db, (tx) => {
      tx.run("INSERT INTO inbox (kind, operation_id, request_hash, status, receipt_json, created_at, completed_at, receipt_expired_at) VALUES ('command', 'op1', 'h1', 'done', '{}', 'now', 'now', NULL)")
      tx.run("INSERT INTO inbox (kind, operation_id, request_hash, status, receipt_json, created_at, completed_at, receipt_expired_at) VALUES ('command', 'op2', 'h2', 'done', '{}', 'now', 'now', '2026-01-01T00:00:00.000Z')")
    })
    expect(getOperation(db, 'op1').status).toBe('done')
    expect(codeOf(() => getOperation(db, 'op2'))).toBe('OPERATION_EXPIRED')
  })
})
