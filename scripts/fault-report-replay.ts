import { constants, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScriptedClock } from '../src/core/clock.ts'
import { openDb, type Db } from '../src/infra/sqlite/driver.ts'
import { acquireNodeRun, submitReport, type RuntimeDeps } from '../src/service/commands/runtime.ts'
import { createRun } from '../src/service/runs.ts'
import { WriteQueue } from '../src/service/write-queue.ts'
import { catalogFor, freshLedger, TEST_SECRET } from '../tests/fixtures/ledger.ts'
import { MISSING_GLOBAL_EVENTS_SQL, ORPHAN_REFERENCES_SQL, sealCheckpoint, sqlRows, type FaultQuery, type SqlValue } from './fault-reconcile.ts'
import type { FaultCase } from './fault-report.ts'

const NOW = '2026-11-20T00:00:00.000Z'
const REPORT = 's6-g03-concurrent-report'
const OLD_REPORT = 's6-g03-old-attempt'
const HEALTHY_REPORT = 's6-g03-new-report'
const NODE = 'SELECT node_run_id, run_id, status, revision, attempt, action_generation FROM node_runs WHERE node_run_id IN (?, ?) ORDER BY node_run_id'
const REGISTRY = 'SELECT report_id, node_run_id, state, attempt, report_seq FROM report_registry ORDER BY report_id'
const EVENTS = 'SELECT seq, event_id, type, run_id, node_run_id, payload_redacted FROM events ORDER BY seq'
const CHAIN = 'SELECT node_run_id, seq, type, hash, payload FROM node_run_events WHERE node_run_id IN (?, ?) ORDER BY node_run_id, seq'
const APPLIED = `
  SELECT e.node_run_id, e.seq, e.type, e.payload, e.hash FROM node_run_events e JOIN node_runs n ON n.node_run_id = e.node_run_id
  WHERE n.run_id = ? AND n.node_run_id = ? AND e.type = ? AND json_extract(e.payload, '$.report_id') = ?
`
const STATUS_CHANGE = `
  SELECT node_run_id, seq, type, payload FROM node_run_events
  WHERE node_run_id = ? AND type = 'status_changed'
    AND json_extract(payload, '$.reason') = 'report_applied'
    AND json_extract(payload, '$.from') = 'dispatched' AND json_extract(payload, '$.to') = 'started'
    AND json_extract(payload, '$.attempt') = ? ORDER BY seq
`

function snapshot(db: Db, scope: [string, string]) {
  return {
    nodes: sqlRows(db.raw.prepare(NODE).all(...scope)),
    registry: sqlRows(db.raw.prepare(REGISTRY).all()),
    events: sqlRows(db.raw.prepare(EVENTS).all()),
    chain: sqlRows(db.raw.prepare(CHAIN).all(...scope)),
  }
}

function submit(deps: RuntimeDeps, nodeRunId: string, reportId: string, generation: number, attempt = 1) {
  return submitReport(deps, {
    nodeRunId, attempt, expectedStatus: 'dispatched', generation, now: NOW,
    report: { report_id: reportId, node_run_id: nodeRunId, attempt, status: 'started' },
  })
}

export const caseG03S6: FaultCase = async ({ directory }) => {
  const { file, db } = freshLedger(directory)
  const catalog = catalogFor(['report-target', 'report-control'])
  const clock = new ScriptedClock('s6_g03', { wallClockMs: Date.parse(NOW), monotonicNs: 0 })
  const deps = { db, catalog, clock, secret: TEST_SECRET, phase: 'S2' as const }
  const queue = new WriteQueue()
  const trace: unknown[] = []
  let runId: string
  let scope: [string, string]
  let generation: number
  try {
    const created = createRun(db, catalog, { workflowVersion: '1', taskTitle: 'S6 G-03 report replay', now: NOW })
    runId = created.run_id
    scope = [created.nodes[0]!.node_run_id, created.nodes[1]!.node_run_id]
    generation = acquireNodeRun(deps, { nodeRunId: scope[0], ownerEpoch: db.epoch, leaseTtlMs: 30_000, now: NOW }).action_generation
    acquireNodeRun(deps, { nodeRunId: scope[1], ownerEpoch: db.epoch, leaseTtlMs: 30_000, now: NOW })
  } finally {
    db.raw.close()
  }
  const beforeFile = join(directory, 'before.db')
  sealCheckpoint(file)
  copyFileSync(file, beforeFile, constants.COPYFILE_EXCL)
  const writer = openDb(file)
  let before
  let breakpoint
  let simultaneous
  let oldAttempt
  let crossScope: unknown
  let healthy
  let pendingAtBoundary: number
  const entered: string[] = []
  try {
    const runtime = { ...deps, db: writer }
    before = snapshot(writer, scope)
    const start = Promise.withResolvers<void>()
    const unblock = Promise.withResolvers<void>()
    const held = queue.run(() => unblock.promise)
    const [node] = scope
    const requests = ['request-a', 'request-b'].map(async (label) => {
      await start.promise
      trace.push({ kind: 'enqueued', label, at: new Date().toISOString() })
      return queue.run(() => {
        entered.push(label)
        trace.push({ kind: 'writer-entered', label, at: new Date().toISOString(), number: entered.length })
        const result = submit(runtime, node, REPORT, generation)
        trace.push({ kind: 'writer-result', label, result })
        return result
      })
    })
    start.resolve()
    await Promise.resolve()
    pendingAtBoundary = queue.size
    unblock.resolve()
    await held
    simultaneous = await Promise.all(requests)
    breakpoint = snapshot(writer, scope)
    oldAttempt = await queue.run(() => submit(runtime, node, OLD_REPORT, generation, 0))
    try {
      crossScope = await queue.run(() => submit(runtime, scope[1], REPORT, generation))
    } catch (error) {
      crossScope = { code: (error as { code?: string }).code, message: (error as Error).message }
    }
    healthy = await queue.run(() => submit(runtime, scope[1], HEALTHY_REPORT, generation))
  } finally {
    writer.raw.close()
  }
  sealCheckpoint(file)
  const restart = openDb(file)
  let beforeRetry
  let retry
  let repeated
  try {
    const runtime = { ...deps, db: restart }
    beforeRetry = snapshot(restart, scope)
    retry = await queue.run(() => submit(runtime, scope[0], REPORT, generation))
    repeated = await queue.run(() => submit(runtime, scope[0], REPORT, generation))
  } finally {
    restart.raw.close()
  }
  sealCheckpoint(file)
  const readonly = openDb(file, { readonly: true })
  let after
  try {
    after = snapshot(readonly, scope)
  } finally {
    readonly.raw.close()
  }
  writeFileSync(join(directory, 'requests.json'), JSON.stringify({ trace, simultaneous, oldAttempt, crossScope, healthy, retry, repeated }, null, 2) + '\n')
  const original = before.nodes.find((row) => row.node_run_id === scope[0])
  const initialRevision = Number(original?.revision)
  const query = (sql: string, bindings: SqlValue[], expectedCount: number, database = 'orchestra.db'): FaultQuery =>
    ({ database, sql, bindings, expectedCount })
  const appliedBindings = [runId, scope[0], 'report_applied', REPORT]
  const replayedBindings = [runId, scope[0], 'report_replayed', REPORT]
  return {
    params: { command: 'submitReport', now: NOW, generation, priorRevision: initialRevision },
    sampleIds: { runId, nodeRunId: scope[0], controlNodeRunId: scope[1], reportId: REPORT },
    boundary: { reached: pendingAtBoundary === 3 && entered.length === 2, kind: 'two_requests_waiting_for_single_writer', pendingAtBoundary, writerOrder: entered },
    snapshots: { before, breakpoint, after },
    artifacts: ['before.db', 'orchestra.db', 'requests.json'],
    queries: {
      half_rows: query(`
        WITH business AS (
          SELECT node_run_id, status, revision FROM node_runs
          WHERE run_id = ? AND node_run_id = ? AND attempt = ? AND action_generation = ?
        ), registry AS (
          SELECT report_id, node_run_id, state FROM report_registry WHERE report_id = ?
        ), applied AS (
          ${APPLIED}
        )
        SELECT 'status' AS gap WHERE NOT EXISTS (SELECT 1 FROM business WHERE status = 'started' AND revision = ?)
        UNION ALL
        SELECT 'registry' WHERE NOT EXISTS (
          SELECT 1 FROM registry r JOIN business b ON b.node_run_id = r.node_run_id WHERE r.state = 'replayed'
        )
        UNION ALL
        SELECT 'event' WHERE (SELECT COUNT(*) FROM applied) <> 1
      `, [runId, scope[0], 1, generation, REPORT, ...appliedBindings, initialRevision + 1], 0),
      orphan_runs: query(ORPHAN_REFERENCES_SQL, [], 0),
      missing_events: query(`
        WITH missing_global AS (${MISSING_GLOBAL_EVENTS_SQL}), missing_chain AS (
          SELECT json_extract(p.value, '$.seq') AS seq, json_extract(p.value, '$.hash') AS hash
          FROM json_each(?) p LEFT JOIN node_run_events e
            ON e.node_run_id = json_extract(p.value, '$.node_run_id') AND e.seq = json_extract(p.value, '$.seq')
            AND e.hash = json_extract(p.value, '$.hash')
          WHERE e.seq IS NULL
        )
        SELECT 'global' AS ledger, seq, event_id AS id FROM missing_global
        UNION ALL SELECT 'node', seq, hash FROM missing_chain ORDER BY ledger, seq
      `, [JSON.stringify(before.events), JSON.stringify(breakpoint.chain)], 0),
    },
    extraQueries: {
      baseline_node: query(NODE, scope, 2, 'before.db'),
      report_registration: query("SELECT * FROM report_registry WHERE report_id = ? AND node_run_id = ? AND attempt = ? AND state = 'replayed'",
        [REPORT, scope[0], 1], 1),
      status_progression: query(STATUS_CHANGE, [scope[0], 1], 1),
      applied_event: query(APPLIED, appliedBindings, 1),
      replayed_event: query(APPLIED, replayedBindings, 1),
      no_old_attempt_applied_event: query(APPLIED, [runId, scope[0], 'report_applied', OLD_REPORT], 0),
      no_cross_scope_applied_event: query(APPLIED, [runId, scope[1], 'report_applied', REPORT], 0),
      healthy_report_event: query(APPLIED, [runId, scope[1], 'report_applied', HEALTHY_REPORT], 1),
    },
    checks: {
      concurrent_acceptance_order: {
        actual: simultaneous.map(({ accepted, registry_state }) => ({ accepted, registry_state })),
        expected: [{ accepted: true, registry_state: 'applied' }, { accepted: false, registry_state: 'replayed' }],
      },
      rejected_old_attempt: { actual: oldAttempt, expected: { accepted: false, reason: 'attempt_mismatch', registry_state: 'rejected' } },
      rejected_other_scope: { actual: (crossScope as { code?: string })?.code, expected: 'SCHEMA_VERSION_UNSUPPORTED' },
      healthy_report_accepted: { actual: healthy, expected: { accepted: true, registry_state: 'applied', next_status: 'started' } },
      replay_after_restart: { actual: [retry, repeated].map(({ registry_state }) => registry_state), expected: ['replayed', 'replayed'] },
      repeated_restart_no_additional_rows: { actual: after, expected: beforeRetry },
      global_events_unchanged: { actual: after.events, expected: before.events },
    },
    extra: { receipts: { simultaneous, oldAttempt, crossScope, healthy, retry, repeated } },
  }
}
