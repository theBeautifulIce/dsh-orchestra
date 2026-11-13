import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { OrchError } from '../src/core/errors.ts'
import { openDb, withTx } from '../src/infra/sqlite/driver.ts'
import { bumpEpoch, openServiceDb } from '../src/infra/db/open.ts'
import { runCas } from '../src/infra/db/tx.ts'
import { acquireDbLock } from '../src/infra/lock.ts'

const dirs: string[] = []
function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-s1-'))
  dirs.push(dir)
  return join(dir, 'orchestra.db')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    if (err instanceof OrchError) return err.code
    throw err
  }
  throw new Error('本应抛错却通过了')
}

describe('连接与 PRAGMA', () => {
  it('新库的 PRAGMA 符合预期', () => {
    const db = openDb(dbFile())
    const one = (sql: string): unknown => Object.values(db.raw.prepare(sql).get() as Record<string, unknown>)[0]
    expect(one('PRAGMA journal_mode')).toBe('wal')
    expect(Number(one('PRAGMA foreign_keys'))).toBe(1)
    expect(Number(one('PRAGMA busy_timeout'))).toBe(5000)
    expect(Number(one('PRAGMA synchronous'))).toBe(2)
    db.raw.close()
  })

  it('只读连接不许写', () => {
    const file = dbFile()
    const w = openDb(file)
    withTx(w, (tx) => tx.run("INSERT INTO service_meta (key, value, updated_at) VALUES ('k', 'v', 'now')"))
    w.raw.close()
    const ro = openDb(file, { readonly: true })
    expect(codeOf(() => withTx(ro, (tx) => tx.run("INSERT INTO service_meta (key, value, updated_at) VALUES ('k2', 'v', 'now')")))).toBe('FORBIDDEN')
    ro.raw.close()
  })
})

describe('epoch 栅栏', () => {
  it('bumpEpoch 递增并把 epoch 存成字符串', () => {
    const file = dbFile()
    expect(bumpEpoch(file)).toBe(1)
    expect(bumpEpoch(file)).toBe(2)
    const db = openDb(file, { readonly: true })
    const row = db.raw.prepare("SELECT value FROM service_meta WHERE key = 'instance_epoch'").get() as { value: string }
    expect(row.value).toBe('2')
    db.raw.close()
  })

  it('旧进程复活写不进去，新进程正常', () => {
    const file = dbFile()
    const first = bumpEpoch(file)
    const stale = openServiceDb(file, first)
    const second = bumpEpoch(file)
    const fresh = openServiceDb(file, second)
    expect(second).toBe(first + 1)
    expect(codeOf(() => withTx(stale, (tx) => tx.run("UPDATE service_meta SET value = 'x' WHERE key = 'instance_epoch'")))).toBe('STALE_GENERATION')
    withTx(fresh, (tx) => tx.run("INSERT INTO service_meta (key, value, updated_at) VALUES ('alive', '1', 'now')"))
    expect(fresh.raw.prepare("SELECT value FROM service_meta WHERE key = 'alive'").get()).toBeTruthy()
    stale.raw.close()
    fresh.raw.close()
  })
})

describe('写者锁', () => {
  it('第二把锁拿不到，释放后能再拿（S1 第九轮 P2-2）', async () => {
    const file = dbFile()
    const release = await acquireDbLock(file)
    await expect(acquireDbLock(file)).rejects.toMatchObject({ code: 'ELOCKED' })
    await release()
    const again = await acquireDbLock(file)
    await again()
  })
})

describe('事务与回滚', () => {
  it('withTx 内抛错时整笔回滚', () => {
    const db = openDb(dbFile())
    withTx(db, (tx) => tx.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)"))
    expect(() => withTx(db, (tx) => {
      tx.run('INSERT INTO t (v) VALUES (?)', ['a'])
      throw new Error('炸了')
    })).toThrow('炸了')
    expect(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n)).toBe(0)
    db.raw.close()
  })

  it('runCas 行数不符抛 STALE_GENERATION 并回滚', () => {
    const db = openDb(dbFile())
    withTx(db, (tx) => {
      tx.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, ver INTEGER)')
      tx.run('INSERT INTO t (id, v, ver) VALUES (1, ?, 1)', ['a'])
    })
    expect(() => withTx(db, (tx) => {
      runCas(tx, 'UPDATE t SET v = ?, ver = ver + 1 WHERE id = ? AND ver = ?', ['b', 1, 9], { rows: 1, what: 'bump t#1' })
    })).toThrow(OrchError)
    const row = db.raw.prepare('SELECT v, ver FROM t WHERE id = 1').get() as { v: string; ver: number }
    expect(row).toEqual({ v: 'a', ver: 1 })
    withTx(db, (tx) => runCas(tx, 'UPDATE t SET v = ?, ver = ver + 1 WHERE id = ? AND ver = ?', ['b', 1, 1], { rows: 1, what: 'bump t#1' }))
    expect((db.raw.prepare('SELECT v FROM t WHERE id = 1').get() as { v: string }).v).toBe('b')
    db.raw.close()
  })

  it('两个连接抢写：只有一个进得去，另一个按 busy_timeout 报错且不留半条记录', () => {
    const file = dbFile()
    const a = openDb(file)
    withTx(a, (tx) => tx.run('CREATE TABLE t (id INTEGER PRIMARY KEY)'))
    const b = openDb(file, { busyTimeoutMs: 50 })
    a.raw.exec('BEGIN IMMEDIATE')
    try {
      a.raw.exec('INSERT INTO t (id) VALUES (1)')
      expect(() => withTx(b, (tx) => tx.run('INSERT INTO t (id) VALUES (2)'))).toThrow()
    } finally {
      a.raw.exec('COMMIT')
    }
    expect(Number((a.raw.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n)).toBe(1)
    a.raw.close()
    b.raw.close()
  })
})

describe('单一 node:sqlite 入口', () => {
  it('只有 src/infra/sqlite/driver.ts import node:sqlite', () => {
    const root = process.cwd()
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
          if (readFileSync(full, 'utf8').includes("from 'node:sqlite'")) hits.push(relative(root, full).replaceAll('\\', '/'))
        }
      }
    }
    walk(join(root, 'src'))
    expect(hits).toEqual(['src/infra/sqlite/driver.ts'])
  })
})
