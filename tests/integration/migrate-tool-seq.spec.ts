// 迁移 006：tool_executions 换成 (node_run_id, attempt, tool_seq) 主键并加 execution_id（第二次意见 P1）
// 重点验「在已有库上跑通」：老表有数据时旧行要补上序号与唯一身份，同名工具再跑一次不再撞主键
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'

const NOW = '2026-11-13T03:00:00.000Z'

type TraceRow = {
  node_run_id: string
  attempt: number
  tool_seq: number
  tool: string
  execution_id: string
  stdout_hash: string
}

describe('迁移 006：工具执行痕迹带唯一身份', () => {
  it('已有库上跑通：旧行补上 tool_seq 与 execution_id，同名工具再跑一次不再撞主键', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-migrate-'))
    const db = openDb(join(dir, 'orchestra.db'))
    try {
      const steps = loadSteps(defaultMigrationsDir())
      // 先只跑到 005：模拟升级前的老库
      applySteps(db, steps.filter((s) => s.version <= 5))
      db.raw.prepare(
        "INSERT INTO tool_executions (node_run_id, attempt, tool, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES ('nr_1', 1, 'ro.b', 0, 'h2', NULL, 'c2', ?, ?)",
      ).run(NOW, NOW)
      db.raw.prepare(
        "INSERT INTO tool_executions (node_run_id, attempt, tool, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES ('nr_1', 1, 'ro.a', 0, 'h1', NULL, 'c1', ?, ?)",
      ).run(NOW, NOW)
      const applied = applySteps(db, steps.filter((s) => s.version === 6))
      expect(applied).toEqual([6])
      const rows = db.raw.prepare(
        'SELECT node_run_id, attempt, tool_seq, tool, execution_id, stdout_hash FROM tool_executions ORDER BY tool_seq ASC',
      ).all() as TraceRow[]
      expect(rows.length).toBe(2)
      // 旧行按稳定顺序补序号：tool 升序，序号从 1 起
      expect(Number(rows[0]!.tool_seq)).toBe(1)
      expect(Number(rows[1]!.tool_seq)).toBe(2)
      expect(rows[0]!.tool).toBe('ro.a')
      expect(rows[1]!.tool).toBe('ro.b')
      expect(rows[0]!.stdout_hash).toBe('h1')
      expect(rows[1]!.stdout_hash).toBe('h2')
      // execution_id 每行都有且互不相同
      expect(rows[0]!.execution_id.length).toBeGreaterThan(0)
      expect(rows[1]!.execution_id.length).toBeGreaterThan(0)
      expect(rows[0]!.execution_id).not.toBe(rows[1]!.execution_id)
      // 升级后同名工具在同一次 attempt 里再跑一次：不再撞主键
      db.raw.prepare(
        "INSERT INTO tool_executions (node_run_id, attempt, tool_seq, tool, execution_id, exit_code, stdout_hash, stderr_hash, command_hash, started_at, finished_at) VALUES ('nr_1', 1, 3, 'ro.a', 'tex_new_1', 0, 'h3', NULL, 'c3', ?, ?)",
      ).run(NOW, NOW)
      const after = db.raw.prepare("SELECT COUNT(*) AS n FROM tool_executions WHERE node_run_id='nr_1' AND attempt=1").get() as { n: number }
      expect(Number(after.n)).toBe(3)
    } finally {
      // Windows 上文件还开着就删不掉：先关库再清目录
      db.raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
