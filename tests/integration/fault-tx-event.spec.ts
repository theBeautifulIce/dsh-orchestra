import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runFaultCase } from '../../scripts/fault-inject.ts'
import { executeFaultQuery } from '../../scripts/fault-reconcile.ts'
import { openDb } from '../../src/infra/sqlite/driver.ts'
import { listEvents } from '../../src/service/queries/list_events.ts'

describe('S6 transaction recovery and report replay', () => {
  it('replays the committed G-02 event from the pre-cut cursor and detects a skipped event', async () => {
    const out = mkdtempSync(join(tmpdir(), 'fault-tx-'))
    const report = await runFaultCase('G-02', { out })
    expect(report).toMatchObject({
      passed: true,
      boundary: { reached: true, kind: 'after_commit', exit: { code: null, signal: 'SIGKILL' } },
      extra: { queries: { committed_task: { actualCount: 1 }, committed_event: { actualCount: 1 }, uncommitted_control_event: { actualCount: 0 } } },
    })
    const committed = report.extra.queries.committed_event!
    const eventId = report.sampleIds.eventId
    const beforeMaxSeq = Number(report.params.beforeMaxSeq)
    expect(committed.rows).toMatchObject([{ event_id: eventId, seq: beforeMaxSeq + 1 }])
    const directory = join(out, 'G6', 'G-02')
    const db = openDb(join(directory, committed.database), { readonly: true })
    try {
      const replay = listEvents(db, { fromSeq: beforeMaxSeq })
      expect(replay.rows).toMatchObject([{ event_id: eventId, seq: beforeMaxSeq + 1 }])
      expect(listEvents(db, { fromSeq: beforeMaxSeq + 1 }).rows).toEqual([])
    } finally {
      db.raw.close()
    }
    expect(executeFaultQuery(directory, { ...committed, bindings: [...committed.bindings.slice(0, -1), 'wrong-event-id'] }))
      .toMatchObject({ actualCount: 0, passed: false })
  }, 30_000)

  it('reconciles the G-03 single writer and rejects a report count from the wrong scope', async () => {
    const out = mkdtempSync(join(tmpdir(), 'fault-tx-'))
    const report = await runFaultCase('G-03', { out })
    expect(report).toMatchObject({
      passed: true,
      boundary: { reached: true, pendingAtBoundary: 3, writerOrder: ['request-a', 'request-b'] },
      extra: {
        queries: {
          status_progression: { actualCount: 1 }, report_registration: { actualCount: 1 },
          applied_event: { actualCount: 1 }, replayed_event: { actualCount: 1 },
          no_old_attempt_applied_event: { actualCount: 0 }, no_cross_scope_applied_event: { actualCount: 0 },
          healthy_report_event: { actualCount: 1 },
        },
      },
    })
    const query = report.extra.queries.applied_event!
    const directory = join(out, 'G6', 'G-03')
    expect(executeFaultQuery(directory, query)).toEqual(query)
    const [run, , type, reportId] = query.bindings
    expect(executeFaultQuery(directory, { ...query, bindings: [run!, report.sampleIds.controlNodeRunId!, type!, reportId!] }))
      .toMatchObject({ actualCount: 0, passed: false })
  }, 30_000)
})
