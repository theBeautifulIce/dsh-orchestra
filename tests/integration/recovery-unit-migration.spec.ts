// 迁移 026：旧毫秒单位的一次性修复（评审 P2-2）
// 只修「缺单调锚点 + 值落在毫秒量级」的旧行；正确纳秒行与带锚点的新行一律不动。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { inTx } from '../../src/infra/db/tx.ts'

const dirs: string[] = []
function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch-unit-'))
  dirs.push(dir)
  return join(dir, 'orchestra.db')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = '2026-11-16T00:00:00.000Z'

/** 只跑到 025 的库：026 之前的旧库形态 */
function legacyDb(stepsCount = 25): { db: Db; steps: ReturnType<typeof loadSteps> } {
  const db = openDb(dbFile())
  const all = loadSteps(defaultMigrationsDir())
  const steps = all.filter((s) => s.version <= stepsCount)
  applySteps(db, steps)
  inTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '样本', 'running', 1, ?, ?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, ?, ?)", [NOW, NOW])
    const insert = "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, revision, startup_unknown_deadline_at, startup_unknown_monotonic_ns, startup_unknown_remaining_ns, created_at, updated_at) VALUES (?, 'r1', ?, ?, 'agent', 'startup_unknown', 1, ?, ?, ?, ?, ?)"
    // 生产旧写入路径的真实形态：四列同写（锚点有值），值仍是毫秒（120 秒写成 120000）
    tx.run(insert, ['nr_legacy', 'n1', 1, NOW, 1000, 120000, NOW, NOW])
    // 已是纳秒的正确行：不许再乘 1e6
    tx.run(insert, ['nr_ns', 'n2', 2, NOW, 1000, 120_000_000_000, NOW, NOW])
    // 模糊带（纳秒的 30ms 剩余）：不换算，只记账
    tx.run(insert, ['nr_ambiguous', 'n3', 3, NOW, 1234, 30_000_000, NOW, NOW])
    // 无法判断：0 与超大纳秒值
    tx.run(insert, ['nr_zero', 'n4', 4, NOW, null, 0, NOW, NOW])
    tx.run(insert, ['nr_huge', 'n5', 5, NOW, null, 999_999_999_999, NOW, NOW])
  })
  return { db, steps: all.filter((s) => s.version === 26) }
}

function remainingOf(db: Db, nodeRunId: string): number | null {
  const row = db.raw.prepare('SELECT startup_unknown_remaining_ns AS v FROM node_runs WHERE node_run_id = ?').get(nodeRunId) as { v: number | null }
  return row.v
}

describe('迁移 026：旧毫秒单位修复', () => {
  it('只把旧毫秒行换算成纳秒，其余行原样保留', () => {
    const { db, steps } = legacyDb()
    expect(applySteps(db, steps)).toEqual([26])
    expect(remainingOf(db, 'nr_legacy')).toBe(120000 * 1e6)
    expect(remainingOf(db, 'nr_ns')).toBe(120_000_000_000)
    expect(remainingOf(db, 'nr_ambiguous')).toBe(30_000_000)
    expect(remainingOf(db, 'nr_zero')).toBe(0)
    expect(remainingOf(db, 'nr_huge')).toBe(999_999_999_999)
    db.raw.close()
  })

  it('审计表记清修了几条、哪些没法判断', () => {
    const { db, steps } = legacyDb()
    applySteps(db, steps)
    const rows = db.raw.prepare('SELECT node_run_id, old_value, new_value, reason FROM recovery_unit_fixes ORDER BY node_run_id').all() as
      { node_run_id: string; old_value: number, new_value: number, reason: string }[]
    const fixed = rows.filter((r) => r.reason === 'legacy_ms_to_ns')
    const kept = rows.filter((r) => r.reason === 'unclassified_kept')
    expect(fixed.map((r) => [r.node_run_id, r.old_value, r.new_value])).toEqual([['nr_legacy', 120000, 120_000_000_000]])
    // 模糊带（nr_ambiguous）与 0（nr_zero）保留并记账；纳秒大值（nr_ns / nr_huge）不记账
    expect(kept.map((r) => r.node_run_id).sort()).toEqual(['nr_ambiguous', 'nr_zero'])
    db.raw.close()
  })

  it('修复后的行不会被同一条规则二次放大', () => {
    const { db, steps } = legacyDb()
    applySteps(db, steps)
    // 再执行一次同一段 UPDATE（等价于有人手工重跑脚本）：已修行值超出毫秒量级，不再命中
    const changed = db.raw.exec(
      'UPDATE node_runs SET startup_unknown_remaining_ns = startup_unknown_remaining_ns * 1000000 '
      + 'WHERE startup_unknown_remaining_ns IS NOT NULL AND startup_unknown_remaining_ns > 0 '
      + 'AND startup_unknown_remaining_ns < 1000000',
    )
    expect(changed).toBeUndefined()
    expect(remainingOf(db, 'nr_legacy')).toBe(120000 * 1e6)
    db.raw.close()
  })
})
