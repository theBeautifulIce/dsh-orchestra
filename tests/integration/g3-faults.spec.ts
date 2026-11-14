// G3 六个故障注入：G-01 / G-02 / G-04 / G-06 / G-12 / G-16。
// 每条都从真实迁移后的临时账本走 runCase，断言恢复后的对账结果，不只断言抛错。
import { describe, expect, it } from 'vitest'
import { runCase, type InjectionCase } from '../../scripts/fault-inject.ts'

const CASES: readonly { name: InjectionCase; includes: string[] }[] = [
  { name: 'G-01', includes: ['未提交事务不留半条记录：true', 'events 条数=1'] },
  { name: 'G-02', includes: ['重放 fromSeq=1 拿到 1 条', 'evt_committed', '总条数 2'] },
  { name: 'G-04', includes: ['LEASE_EXPIRED', '"status":"dispatched"'] },
  { name: 'G-06', includes: ['宿主实际执行次数=1', 'exitCode=0/0', 'outbox=completed'] },
  { name: 'G-12', includes: ['DECISION_REVISION_CONFLICT', '"status":"resolved"', '"revision":2'] },
  { name: 'G-16', includes: ['"cancelledNodes":["nr_g16a"]', '"skippedIrreversible":["nr_g16b"]', 'timing_out'] },
]

describe('G3 故障注入', () => {
  for (const item of CASES) {
    it(`${item.name}：恢复后账本可对账`, async () => {
      const result = await runCase(item.name)
      expect(result.case).toBe(item.name)
      for (const needle of item.includes) expect(result.reconcile).toContain(needle)
    }, 60_000)
  }
})
