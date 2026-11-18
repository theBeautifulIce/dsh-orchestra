import { expect, it } from 'vitest'
import { runCase } from '../../scripts/fault-inject.ts'

it('G-11 写入进程中断后核对全写入、事务回滚和部分写入', async () => {
  const result = await runCase('G-11')
  expect(JSON.parse(result.reconcile)).toMatchObject({
    committed: { evidence_recorded: true, written_count_at_inspect: 2 },
    rolled_back: { evidence_recorded: true, written_count_at_inspect: 0 },
    partial: { evidence_recorded: true, written_count_at_inspect: 1, partial: true },
  })
}, 40_000)
