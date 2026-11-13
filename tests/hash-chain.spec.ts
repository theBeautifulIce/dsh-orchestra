import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chainHash, verifyChain, ZERO_HASH } from '../src/core/hash-chain.ts'
import { canonicalJson } from '../src/core/canonical.ts'
import { uuidv7 } from '../src/core/ids.ts'
import { openDb, withTx } from '../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../src/infra/db/migrate.ts'
import { appendEvent, appendNodeRunEvent, readChain } from '../src/infra/db/ledger.ts'

const SECRET = 'test-secret-1'
const dirs: string[] = []
const open: { raw: { close: () => void } }[] = []
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-chain-'))
  dirs.push(dir)
  const db = openDb(join(dir, 'orchestra.db'))
  open.push(db)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  return db
}
afterEach(() => {
  for (const db of open.splice(0)) { try { db.raw.close() } catch { /* 已经关了 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 句柄晚释放 */ } }
})

describe('哈希链', () => {
  it('追加三条：seq 1/2/3，首条 prev_hash 是 64 个 0，校验通过', () => {
    const db = freshDb()
    const rows = withTx(db, (tx) => {
      appendNodeRunEvent(tx, SECRET, 'n1', 'started', { a: 1 })
      appendNodeRunEvent(tx, SECRET, 'n1', 'progress', { a: 2 })
      appendNodeRunEvent(tx, SECRET, 'n1', 'done', { a: 3 })
      return readChain(tx, 'n1')
    })
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(rows[0]!.prev_hash).toBe(ZERO_HASH)
    expect(verifyChain(SECRET, rows)).toBeNull()
    db.raw.close()
  })

  it('改掉第 2 条 payload → 报 seq=2 且 hash 对不上', () => {
    const db = freshDb()
    withTx(db, (tx) => {
      appendNodeRunEvent(tx, SECRET, 'n1', 'started', { a: 1 })
      appendNodeRunEvent(tx, SECRET, 'n1', 'progress', { a: 2 })
      appendNodeRunEvent(tx, SECRET, 'n1', 'done', { a: 3 })
    })
    db.raw.prepare("UPDATE node_run_events SET payload = '{\"a\":99}' WHERE node_run_id = 'n1' AND seq = 2").run()
    const rows = withTx(db, (tx) => readChain(tx, 'n1'))
    const broken = verifyChain(SECRET, rows)
    expect(broken?.seq).toBe(2)
    expect(broken?.reason).toContain('hash 对不上')
    db.raw.close()
  })

  it('删掉第 2 条 → 报 prev_hash 不接上一条', () => {
    const db = freshDb()
    withTx(db, (tx) => {
      appendNodeRunEvent(tx, SECRET, 'n1', 'started', { a: 1 })
      appendNodeRunEvent(tx, SECRET, 'n1', 'progress', { a: 2 })
      appendNodeRunEvent(tx, SECRET, 'n1', 'done', { a: 3 })
    })
    db.raw.prepare("DELETE FROM node_run_events WHERE node_run_id = 'n1' AND seq = 2").run()
    const rows = withTx(db, (tx) => readChain(tx, 'n1'))
    const broken = verifyChain(SECRET, rows)
    expect(broken?.seq).toBe(3)
    expect(broken?.reason).toContain('prev_hash 不接上一条')
    db.raw.close()
  })

  it('换一把 secret → 报 hash 对不上', () => {
    const db = freshDb()
    const rows = withTx(db, (tx) => {
      appendNodeRunEvent(tx, SECRET, 'n1', 'started', { a: 1 })
      return readChain(tx, 'n1')
    })
    expect(verifyChain('another-secret', rows)?.reason).toContain('hash 对不上')
    db.raw.close()
  })

  it('键序不影响哈希：同一对象键序不同 hash 相同', () => {
    const a = chainHash(SECRET, ZERO_HASH, { b: 2, a: 1, c: { y: 2, x: 1 } })
    const b = chainHash(SECRET, ZERO_HASH, { c: { x: 1, y: 2 }, a: 1, b: 2 })
    expect(a).toBe(b)
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it('两条链互不干扰，events 与链各自独立追加', () => {
    const db = freshDb()
    const out = withTx(db, (tx) => {
      appendNodeRunEvent(tx, SECRET, 'n1', 'started', {})
      appendNodeRunEvent(tx, SECRET, 'n2', 'started', {})
      const ev = appendEvent(tx, { type: 'node.started', nodeRunId: 'n1', payload: { k: 1 } })
      return { ev, chain1: readChain(tx, 'n1'), chain2: readChain(tx, 'n2') }
    })
    expect(out.ev.seq).toBe(1)
    expect(out.chain1.map((r) => r.seq)).toEqual([1])
    expect(out.chain2.map((r) => r.seq)).toEqual([1])
    expect(out.chain2[0]!.prev_hash).toBe(ZERO_HASH)
    expect(verifyChain(SECRET, out.chain1)).toBeNull()
    expect(verifyChain(SECRET, out.chain2)).toBeNull()
    db.raw.close()
  })

  it('uuidv7 形如 UUID 且版本位是 7', () => {
    const id = uuidv7()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
