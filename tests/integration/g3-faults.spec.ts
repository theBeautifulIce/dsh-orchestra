// G3 六个故障注入：G-01 / G-02 / G-04 / G-06 / G-12 / G-16。
// 每条都从真实迁移后的临时账本走 runCase，断言恢复后的对账结果，不只断言抛错。
import { describe, expect, it } from 'vitest'
import { runCase, type InjectionCase } from '../../scripts/fault-inject.ts'

const CASES: readonly { name: InjectionCase; includes: string[] }[] = [
  { name: 'G-01', includes: ['未提交事务不留半条记录：true', 'events 条数=1'] },
  { name: 'G-02', includes: ['重放 fromSeq=1 拿到 1 条', 'evt_committed', '总条数 2'] },
  { name: 'G-04', includes: ['LEASE_EXPIRED'] },
  { name: 'G-06', includes: ['宿主实际执行次数=1', 'exitCode=0/0', 'outbox=completed'] },
  { name: 'G-12', includes: ['DECISION_REVISION_CONFLICT'] },
  { name: 'G-16', includes: ['"cancelledNodes":["nr_g16a"]', '"skippedIrreversible":["nr_g16b"]'] },
]

function nodeRow(state: string, id: string): Record<string, unknown> {
  const line = state.split('\n').find((item) => item.includes(`"node_run_id":"${id}"`) || item.includes(`"decision_id":"${id}"`))
  if (!line) throw new Error(`账本里找不到 ${id}`)
  return JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>
}

function occurrences(state: string, needle: string): number {
  return state.split(needle).length - 1
}

describe('G3 故障注入', () => {
  for (const item of CASES) {
    it(`${item.name}：恢复后账本可对账`, async () => {
      const result = await runCase(item.name)
      expect(result.case).toBe(item.name)
      for (const needle of item.includes) expect(result.reconcile).toContain(needle)
    }, 60_000)
  }

  it('G-04：迟到上报被拒后 attempt 与 action_generation 都不变', async () => {
    const result = await runCase('G-04')
    const before = nodeRow(result.before, 'nr1')
    const after = nodeRow(result.after, 'nr1')
    expect(after).toMatchObject({
      status: before.status,
      attempt: before.attempt,
      action_generation: before.action_generation,
    })
  })

  it('G-06：工具只执行一次，前后账本恰有一条 tool_started 与一条 tool_finished', async () => {
    const result = await runCase('G-06')
    expect(result.before).not.toContain('call_g06')
    expect(occurrences(result.after, '"type":"tool_started"')).toBe(1)
    expect(occurrences(result.after, '"type":"tool_finished"')).toBe(1)
    expect(result.after).toContain('"status":"completed"')
    expect(result.after).toContain('call_g06')
  })

  it('G-12：双击只留一笔 resolved，revision 前进到 2', async () => {
    const result = await runCase('G-12')
    expect(result.before).not.toContain('dec_g12')
    expect(occurrences(result.after, 'decision.resolved')).toBe(1)
    const after = nodeRow(result.after, 'dec_g12')
    expect(after).toMatchObject({ status: 'resolved', revision: 2, closed_reason: 'approved' })
  })

  it('G-16：父取消只收可补偿子节点，不可逆子节点留在 started 等核验', async () => {
    const result = await runCase('G-16')
    const beforeA = nodeRow(result.before, 'nr_g16a')
    const beforeB = nodeRow(result.before, 'nr_g16b')
    expect(beforeA.status).toBe('started')
    expect(beforeB.status).toBe('started')
    const afterA = nodeRow(result.after, 'nr_g16a')
    const afterB = nodeRow(result.after, 'nr_g16b')
    expect(afterA).toMatchObject({ status: 'timing_out', cancel_result: 'interrupted' })
    expect(afterB.status).toBe('started')
    expect(result.reconcile).toContain('"skippedIrreversible":["nr_g16b"]')
  })
})
