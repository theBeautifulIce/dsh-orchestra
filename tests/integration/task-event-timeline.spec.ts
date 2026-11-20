import { expect, it } from 'vitest'
import { appendEvent, appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { listExecutionHistory } from '../../src/service/queries/execution-history.ts'
import { listEventHistory } from '../../src/service/queries/list_events.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'

it('按筛选后的时间线游标分页，保留记录范围并只标记账本已证实的需留意事件', () => {
  const { db } = freshLedger()
  try {
    seed(db)
    const ids = withTx(db, (tx) => {
      const task = appendEvent(tx, { type: 'task.trigger_skipped', payload: { task_id: 't1' } })
      const other = appendEvent(tx, { type: 'task.trigger_skipped', payload: { task_id: 'other' } })
      const failed = appendEvent(tx, { type: 'run.terminal', runId: 'r1', payload: { status: 'cancelled', outcome: 'failed' } })
      appendEvent(tx, { type: 'run.terminal', runId: 'r1', payload: { status: 'cancelled', outcome: 'succeeded' } })
      const rejected = appendEvent(tx, { type: 'executor.model_rejected', runId: 'r1' })
      appendEvent(tx, { type: 'executor.model_selected', runId: 'r1' })
      appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'tool_finished', { exit_code: 8 })
      appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'tool_finished', { exit_code: 0 })
      appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'status_changed', { from: 'started', to: 'done' })
      appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'report.contradicted', {})
      appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'report_replayed', { report_id: 'report-1', report_seq: 3, reason: 'already_applied' })
      appendNodeRunEvent(tx, TEST_SECRET, 'nr1', 'executor.model_confirmed', {})
      return { task: task.seq, other: other.seq, failed: failed.seq, rejected: rejected.seq }
    })
    const first = listEventHistory(db, { taskId: 't1', filter: 'attention', limit: 2 })
    expect(first.items.map(({ seq, attention }) => [seq, attention])).toEqual([[ids.rejected, true], [ids.failed, true]])
    const second = listEventHistory(db, { taskId: 't1', filter: 'attention', beforeSeq: first.next_before_seq!, limit: 2 })
    expect(second.items.map(({ seq }) => seq)).toEqual([ids.task])
    expect(second.next_before_seq).toBeNull()
    expect(listEventHistory(db, { taskId: 'other', filter: 'attention' }).items.map(({ seq }) => seq)).toEqual([ids.other])
    expect(listEventHistory(db, { runId: 'r1' }).items[0]).not.toHaveProperty('attention')
    expect(listEventHistory(db, { runId: 'r1', filter: 'all' }).items[0]).toMatchObject({ type: 'executor.model_selected', attention: false })
    expect(() => listEventHistory(db, { runId: 'r1', filter: 'unknown' })).toThrow()

    const issue = listExecutionHistory(db, { runId: 'r1', filter: 'attention', limit: 1 })
    const older = listExecutionHistory(db, { runId: 'r1', filter: 'attention', before: issue.next_before!, limit: 1 })
    expect(issue.items[0]).toMatchObject({ type: 'report.contradicted', attention: true })
    expect(older.items[0]).toMatchObject({ type: 'tool_finished', attention: true })
    expect(older.next_before).toBeNull()
    expect(older.items[0]!.id).toBeLessThan(issue.items[0]!.id)
    expect(listExecutionHistory(db, { taskId: 't1', filter: 'tool' }).items.map(({ attention }) => attention)).toEqual([false, true])
    const reports = listExecutionHistory(db, { taskId: 't1', filter: 'report', limit: 1 })
    expect(reports.items[0]).toMatchObject({ type: 'report_replayed', title: '记录执行报告重放', attention: false,
      details: expect.arrayContaining([{ label: '报告序号', value: '3' }, { label: '原因', value: 'already_applied' }]) })
    const olderReport = listExecutionHistory(db, { taskId: 't1', filter: 'report', before: reports.next_before!, limit: 1 })
    expect(olderReport.items.map(({ type }) => type)).toEqual(['report.contradicted'])
    expect(olderReport.next_before).toBeNull()
    expect(listExecutionHistory(db, { taskId: 't1', filter: 'model' }).items).toHaveLength(1)
    expect(listExecutionHistory(db, { nodeId: 'nr1' }).items[0]).not.toHaveProperty('attention')
  } finally { db.raw.close() }
})
