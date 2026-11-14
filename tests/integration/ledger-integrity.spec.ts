// 账本完整性：只追加保护 + 链头对账（第二次意见 P1：账本没有数据库级只追加保护、整条链被删校验就失效）
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chainHash, ZERO_HASH } from '../../src/core/hash-chain.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { appendNodeRunEvent, readChainHead } from '../../src/infra/db/ledger.ts'
import { verifyLedger } from '../../src/service/queries/verify_ledger.ts'

const SECRET = 'ledger-integrity-secret'
const NOW = '2026-11-14T00:00:00.000Z'
const dirs: string[] = []
const opened: { close: () => void }[] = []

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-ledger-'))
  dirs.push(dir)
  const db = openDb(join(dir, 'orchestra.db'))
  opened.push(db.raw)
  applySteps(db, loadSteps(defaultMigrationsDir()))
  return db
}

afterEach(() => {
  for (const raw of opened.splice(0)) { try { raw.close() } catch { /* 句柄晚释放 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})

// 建一个节点（node_runs 有行），让它后面挂链或不挂链由用例自己决定
function seedNodeRun(db: Db, nodeRunId: string, status: string) {
  withTx(db, (tx) => {
    tx.run("INSERT OR IGNORE INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '样本任务', 'running', 1, ?, ?)", [NOW, NOW])
    tx.run("INSERT OR IGNORE INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, ?, ?)", [NOW, NOW])
    tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) "
      + "VALUES (?, 'r1', 'n1', 1, 'agent', 1, ?, 1, ?, ?)", [nodeRunId, status, NOW, NOW])
  })
}

// 一个跑过一轮的节点：node_runs 有行，账本里有两条链事件
function seedChain(db: Db, nodeRunId = 'nr1') {
  seedNodeRun(db, nodeRunId, 'started')
  withTx(db, (tx) => {
    appendNodeRunEvent(tx, SECRET, nodeRunId, 'status_changed', { from: 'dispatched', to: 'started' })
    appendNodeRunEvent(tx, SECRET, nodeRunId, 'tool_finished', { tool: 'echo', exit_code: 0 })
  })
}

describe('账本只追加保护', () => {
  it('直接 UPDATE node_run_events → 触发器拒绝', () => {
    const db = freshDb()
    seedChain(db)
    expect(() => db.raw.prepare("UPDATE node_run_events SET payload = '{}' WHERE node_run_id = 'nr1'").run()).toThrow(/只追加/)
  })

  it('直接 DELETE node_run_events → 触发器拒绝', () => {
    const db = freshDb()
    seedChain(db)
    expect(() => db.raw.prepare("DELETE FROM node_run_events WHERE node_run_id = 'nr1'").run()).toThrow(/只追加/)
  })

  it('触发器不拦正常追加：账本仍然只进不出', () => {
    const db = freshDb()
    seedChain(db)
    const out = withTx(db, (tx) => appendNodeRunEvent(tx, SECRET, 'nr1', 'tool_started', { tool: 'echo' }))
    expect(out.seq).toBe(3)
    expect(verifyLedger(db, SECRET).ok).toBe(true)
  })

  it('直接 DELETE 链头 → 触发器拒绝', () => {
    const db = freshDb()
    seedChain(db)
    expect(() => db.raw.prepare("DELETE FROM node_run_chain_heads WHERE node_run_id = 'nr1'").run()).toThrow(/只由追加维护/)
  })

  it('直接 UPDATE 链头跳号 → 触发器拒绝', () => {
    const db = freshDb()
    seedChain(db)
    expect(() => db.raw.prepare("UPDATE node_run_chain_heads SET last_seq = 4, event_count = 4 WHERE node_run_id = 'nr1'").run())
      .toThrow(/链头序号必须逐条递增/)
  })

  it('直接 UPDATE 链头到没有对应事件的位置 → 触发器拒绝', () => {
    const db = freshDb()
    seedChain(db)
    expect(() => db.raw.prepare("UPDATE node_run_chain_heads SET last_seq = 3, last_hash = ?, event_count = 3 WHERE node_run_id = 'nr1'")
      .run('f'.repeat(64))).toThrow(/链头更新缺少对应事件/)
  })

  it('直接 INSERT 跳号事件 → 触发器拒绝', () => {
    const db = freshDb()
    seedChain(db)
    const tail = db.raw.prepare("SELECT hash FROM node_run_events WHERE node_run_id = 'nr1' ORDER BY seq DESC LIMIT 1").get() as { hash: string }
    expect(() => db.raw.prepare("INSERT INTO node_run_events (node_run_id, seq, type, prev_hash, hash, payload, created_at) VALUES ('nr1', 5, 'jump', ?, ?, '{}', ?)")
      .run(tail.hash, 'e'.repeat(64), NOW)).toThrow(/必须接在链头之后/)
  })

  it('链头缺失但已有事件 → appendNodeRunEvent 拒绝，不再凭事件行补写', () => {
    const db = freshDb()
    seedChain(db)
    db.raw.exec('DROP TRIGGER trg_node_run_chain_heads_no_delete')
    db.raw.exec('DELETE FROM node_run_chain_heads')
    expect(() => withTx(db, (tx) => appendNodeRunEvent(tx, SECRET, 'nr1', 'tool_started', { tool: 'echo' })))
      .toThrow(/链头缺失但账本里已有事件/)
    expect(verifyLedger(db, SECRET).ok).toBe(false)
  })

  it('新链首条事件从 seq=1 与零哈希开始，链头只记一条', () => {
    const db = freshDb()
    seedNodeRun(db, 'nr2', 'queued')
    const out = withTx(db, (tx) => appendNodeRunEvent(tx, SECRET, 'nr2', 'started', {}))
    expect(out.seq).toBe(1)
    const head = withTx(db, (tx) => readChainHead(tx, 'nr2'))
    expect(head).toMatchObject({ last_seq: 1, event_count: 1, last_hash: out.hash })
  })

  it('直接 INSERT 新链头但没有对应首条事件 → 触发器拒绝', () => {
    const db = freshDb()
    expect(() => db.raw.prepare("INSERT INTO node_run_chain_heads (node_run_id, last_seq, last_hash, event_count, updated_at) VALUES ('ghost', 1, ?, 1, ?)")
      .run('a'.repeat(64), NOW)).toThrow(/缺少对应的首条事件/)
  })
})

describe('链头投影', () => {
  it('追加两条事件：链头记到第 2 条、条数 2、链尾哈希对得上', () => {
    const db = freshDb()
    seedChain(db)
    const head = withTx(db, (tx) => readChainHead(tx, 'nr1'))
    const tail = db.raw.prepare("SELECT seq, hash FROM node_run_events WHERE node_run_id = 'nr1' ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string }
    expect(head?.last_seq).toBe(2)
    expect(head?.event_count).toBe(2)
    expect(head?.last_hash).toBe(tail.hash)
  })

  it('链头表被清空 → 校验报链头记录缺失（说明账本和链头对不上）', () => {
    const db = freshDb()
    seedChain(db)
    // 012 起链头不许直接删；模拟绕过应用改库，先卸掉链头删除触发器
    db.raw.exec('DROP TRIGGER trg_node_run_chain_heads_no_delete')
    db.raw.exec('DELETE FROM node_run_chain_heads')
    const out = verifyLedger(db, SECRET)
    expect(out.ok).toBe(false)
    expect(out.break?.reason).toContain('链头记录缺失')
  })

  it('存量库回填：升级前就在的链，升级后链头对得上、校验过得去', () => {
    // 老库：007 之前只有链，没有链头表，链头靠迁移回填
    const dir = mkdtempSync(join(tmpdir(), 'orch-ledger-old-'))
    dirs.push(dir)
    const db = openDb(join(dir, 'orchestra.db'))
    opened.push(db.raw)
    const steps = loadSteps(defaultMigrationsDir())
    applySteps(db, steps.filter((s) => s.version < 7))
    const hash = chainHash(SECRET, ZERO_HASH, { node_run_id: 'nr1', seq: 1, type: 'started', payload: '{}' })
    withTx(db, (tx) => {
      tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '样本任务', 'running', 1, ?, ?)", [NOW, NOW])
      tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, ?, ?)", [NOW, NOW])
      tx.run("INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, created_at, updated_at) "
        + "VALUES ('nr1', 'r1', 'n1', 1, 'agent', 1, 'started', 1, ?, ?)", [NOW, NOW])
      tx.run("INSERT INTO node_run_events (node_run_id, seq, type, prev_hash, hash, payload, created_at) VALUES ('nr1', 1, 'started', ?, ?, '{}', ?)",
        [ZERO_HASH, hash, NOW])
    })
    applySteps(db, steps.filter((s) => s.version >= 7))
    const head = db.raw.prepare('SELECT last_seq, last_hash, event_count FROM node_run_chain_heads WHERE node_run_id = ?').get('nr1') as
      { last_seq: number; last_hash: string; event_count: number }
    expect(head.last_seq).toBe(1)
    expect(head.last_hash).toBe(hash)
    expect(head.event_count).toBe(1)
    expect(verifyLedger(db, SECRET).ok).toBe(true)
  })
})

describe('账本校验能发现缺口', () => {
  it('链完好 → ok=true，链数 1、条目 2、缺口清单为空', () => {
    const db = freshDb()
    seedChain(db)
    const out = verifyLedger(db, SECRET)
    expect(out.ok).toBe(true)
    expect(out.chains).toBe(1)
    expect(out.entries).toBe(2)
    expect(out.break).toBeNull()
    expect(out.gaps).toEqual([])
  })

  it('尾部事件被删 → 失败，并指出链尾与链头对不上', () => {
    const db = freshDb()
    seedChain(db)
    // 模拟绕过应用直接改库：先卸掉只追加触发器再删
    db.raw.exec('DROP TRIGGER trg_node_run_events_no_delete')
    db.raw.prepare("DELETE FROM node_run_events WHERE node_run_id = 'nr1' AND seq = 2").run()
    const out = verifyLedger(db, SECRET)
    expect(out.ok).toBe(false)
    expect(out.break?.node_run_id).toBe('nr1')
    const reasons = out.gaps.map((g) => g.reason).join(' | ')
    expect(reasons).toContain('条数与链头记录对不上')
    expect(reasons).toContain('链尾序号与链头记录对不上')
  })

  it('整条链被删 → 失败，并指出整条链没了', () => {
    const db = freshDb()
    seedChain(db)
    db.raw.exec('DROP TRIGGER trg_node_run_events_no_delete')
    db.raw.prepare("DELETE FROM node_run_events WHERE node_run_id = 'nr1'").run()
    const out = verifyLedger(db, SECRET)
    expect(out.ok).toBe(false)
    expect(out.break?.node_run_id).toBe('nr1')
    expect(out.break?.reason).toContain('整条链在账本里没了')
  })

  it('中间事件被篡改 → 失败，哈希重算对不上并指出是哪一条', () => {
    const db = freshDb()
    seedChain(db)
    db.raw.exec('DROP TRIGGER trg_node_run_events_no_update')
    db.raw.prepare("UPDATE node_run_events SET payload = '{\"a\":9}' WHERE node_run_id = 'nr1' AND seq = 1").run()
    const out = verifyLedger(db, SECRET)
    expect(out.ok).toBe(false)
    expect(out.break?.node_run_id).toBe('nr1')
    expect(out.break?.seq).toBe(1)
    expect(out.break?.reason).toContain('hash 对不上')
  })

  it('节点已经动过却没有链 → 失败，并指出这个节点缺链', () => {
    const db = freshDb()
    // 节点状态已经离开 queued，账本里却一条链都没有
    seedNodeRun(db, 'nr2', 'started')
    const out = verifyLedger(db, SECRET)
    expect(out.ok).toBe(false)
    expect(out.break?.node_run_id).toBe('nr2')
    expect(out.break?.reason).toContain('没有链')
  })

  it('刚建还没派发的节点（queued）不算缺链', () => {
    const db = freshDb()
    seedNodeRun(db, 'nr3', 'queued')
    const out = verifyLedger(db, SECRET)
    expect(out.ok).toBe(true)
    expect(out.chains).toBe(0)
  })

  it('链挂在账本里没有的节点上 → 失败，并指出节点不存在', () => {
    const db = freshDb()
    withTx(db, (tx) => {
      appendNodeRunEvent(tx, SECRET, 'ghost', 'status_changed', { from: 'dispatched', to: 'started' })
    })
    const out = verifyLedger(db, SECRET)
    expect(out.ok).toBe(false)
    expect(out.break?.node_run_id).toBe('ghost')
    expect(out.break?.reason).toContain('没有的节点')
  })
})
