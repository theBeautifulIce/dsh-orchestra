import { describe, expect, it } from 'vitest'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { compensationId } from '../../src/core/canonical.ts'
import {
  assertCompensationDescriptor, getCompensation, registerNoExecutableCompensation,
  settleCompensation, startCompensation, type CompensationDescriptor,
} from '../../src/service/commands/compensation.ts'

const NOW = '2026-11-14T12:00:00.000Z'
const SECRET = 'compensation-secret'
const DESCRIPTOR: CompensationDescriptor = {
  tool: 'fs.restore',
  args: ['--file', 'a.txt'],
  verify: { command: 'cat', args: ['a.txt'] },
  descriptorVersion: 'v1',
}

function memoryDb(status = 'failed'): Db {
  const db = openDb(':memory:')
  applySteps(db, loadSteps(defaultMigrationsDir()))
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES ('t1', '补偿', 'running', 1, ?, ?)", [NOW, NOW])
    tx.run("INSERT INTO runs (run_id, task_id, status, revision, root_run_id, subworkflow_depth, created_at, updated_at) VALUES ('r1', 't1', 'running', 1, 'r1', 0, ?, ?)", [NOW, NOW])
    tx.run(
      "INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, status, revision, attempt, rearm_generation, created_at, updated_at) "
        + "VALUES ('nr1', 'r1', 'a', 1, 'agent', ?, 1, 2, 4, ?, ?)",
      [status, NOW, NOW],
    )
  })
  return db
}

function node(tx: any): { status: string; attempt: number; rearm_generation: number } {
  return tx.get("SELECT status, attempt, rearm_generation FROM node_runs WHERE node_run_id = 'nr1'")
}

describe('补偿幂等与未验证落账', () => {
  it('同一节点、attempt、描述符版本得到同一个补偿 id；换 attempt 就换 id', () => {
    expect(compensationId('nr1', 2, 'v1')).toBe(compensationId('nr1', 2, 'v1'))
    expect(compensationId('nr1', 2, 'v1')).not.toBe(compensationId('nr1', 3, 'v1'))
  })

  it('描述符缺工具或验证命令时报 COMPENSATION_UNEXECUTABLE', () => {
    expect(() => assertCompensationDescriptor({ ...DESCRIPTOR, tool: '  ' })).toThrowError(/缺工具或验证命令/)
    expect(() => assertCompensationDescriptor({ ...DESCRIPTOR, verify: { command: '', args: [] } })).toThrowError(/缺工具或验证命令/)
    expect(() => assertCompensationDescriptor({ ...DESCRIPTOR, descriptorVersion: ' ' })).toThrowError(/descriptorVersion/)
  })

  it('同一补偿重放只插一行、只发一条 started', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      const first = startCompensation(tx, SECRET, { nodeRunId: 'nr1', attempt: 2, descriptor: DESCRIPTOR, now: NOW })
      const again = startCompensation(tx, SECRET, { nodeRunId: 'nr1', attempt: 2, descriptor: DESCRIPTOR, now: NOW })
      expect(first.started).toBe(true)
      expect(again.started).toBe(false)
      expect(again.compensationId).toBe(first.compensationId)
      const rows = tx.all("SELECT * FROM compensations WHERE node_run_id = 'nr1'")
      expect(rows).toHaveLength(1)
      const events = tx.all("SELECT * FROM node_run_events WHERE node_run_id = 'nr1' AND type = 'compensation.started'")
      expect(events).toHaveLength(1)
    })
  })

  it('同版本换了工具或参数按 OPERATION_ID_CONFLICT 拒，不覆盖原记录', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      startCompensation(tx, SECRET, { nodeRunId: 'nr1', attempt: 2, descriptor: DESCRIPTOR, now: NOW })
      expect(() => startCompensation(tx, SECRET, {
        nodeRunId: 'nr1', attempt: 2, now: NOW,
        descriptor: { ...DESCRIPTOR, args: ['--file', 'b.txt'] },
      })).toThrowError(/换了工具或参数/)
    })
  })

  it('补偿失败落 failed_with_unverified，attempt 与 Gr 不变，事件只一条', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      const { compensationId: id } = startCompensation(tx, SECRET, { nodeRunId: 'nr1', attempt: 2, descriptor: DESCRIPTOR, now: NOW })
      expect(settleCompensation(tx, SECRET, { compensationId: id, state: 'failed', evidence: { exitCode: 1 }, now: NOW })).toBe(true)
      expect(node(tx)).toMatchObject({ status: 'failed_with_unverified', attempt: 2, rearm_generation: 4 })
      expect(getCompensation(tx, id)?.state).toBe('failed')
      const events = tx.all("SELECT * FROM node_run_events WHERE node_run_id = 'nr1' AND type = 'compensation.failed'")
      expect(events).toHaveLength(1)
    })
  })

  it('补偿成功只记 applied，不把节点从 failed 改成别处', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      const { compensationId: id } = startCompensation(tx, SECRET, { nodeRunId: 'nr1', attempt: 2, descriptor: DESCRIPTOR, now: NOW })
      settleCompensation(tx, SECRET, { compensationId: id, state: 'applied', evidence: { exitCode: 0 }, now: NOW })
      expect(node(tx).status).toBe('failed')
      expect(getCompensation(tx, id)?.state).toBe('applied')
      expect(tx.all("SELECT * FROM node_run_events WHERE node_run_id = 'nr1' AND type = 'compensation.applied'")).toHaveLength(1)
    })
  })

  it('终态补偿不能再改判，重复收口返回 false', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      const { compensationId: id } = startCompensation(tx, SECRET, { nodeRunId: 'nr1', attempt: 2, descriptor: DESCRIPTOR, now: NOW })
      settleCompensation(tx, SECRET, { compensationId: id, state: 'failed', now: NOW })
      expect(settleCompensation(tx, SECRET, { compensationId: id, state: 'failed', now: NOW })).toBe(false)
      expect(() => settleCompensation(tx, SECRET, { compensationId: id, state: 'applied', now: NOW }))
        .toThrowError(/不能改成另一个终态/)
    })
  })

  it('无可执行补偿以 NULL compensation_id 幂等落账，节点落 failed_with_unverified', () => {
    const db = memoryDb()
    withTx(db, (tx) => {
      expect(registerNoExecutableCompensation(tx, SECRET, { nodeRunId: 'nr1', attempt: 2, now: NOW }).created).toBe(true)
      expect(registerNoExecutableCompensation(tx, SECRET, { nodeRunId: 'nr1', attempt: 2, now: NOW }).created).toBe(false)
      const rows = tx.all("SELECT * FROM compensations WHERE node_run_id = 'nr1' AND kind = 'none'")
      expect(rows).toHaveLength(1)
      expect((rows[0] as { compensation_id: string | null }).compensation_id).toBeNull()
      expect(node(tx)).toMatchObject({ status: 'failed_with_unverified', attempt: 2, rearm_generation: 4 })
    })
  })

  it('done 节点不许被补偿失败降级成 failed_with_unverified', () => {
    const db = memoryDb('done')
    withTx(db, (tx) => {
      const { compensationId: id } = startCompensation(tx, SECRET, { nodeRunId: 'nr1', attempt: 2, descriptor: DESCRIPTOR, now: NOW })
      expect(() => settleCompensation(tx, SECRET, { compensationId: id, state: 'unverified', now: NOW }))
        .toThrowError(/当前节点状态不能落/)
    })
  })
})
