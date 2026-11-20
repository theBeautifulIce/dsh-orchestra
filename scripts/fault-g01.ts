import { spawn } from 'node:child_process'
import { constants, copyFileSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDb } from '../src/infra/sqlite/driver.ts'
import { setTaskAutonomy, type SetTaskAutonomyParams } from '../src/service/commands/start-run.ts'
import { createRun } from '../src/service/runs.ts'
import { listEvents } from '../src/service/queries/list_events.ts'
import { catalogFor, freshLedger } from '../tests/fixtures/ledger.ts'
import type { FaultCase } from './fault-report.ts'
import {
  MISSING_GLOBAL_EVENTS_SQL, ORPHAN_REFERENCES_SQL, sealCheckpoint, sqlRows,
  type FaultQuery, type SqlRow, type SqlValue,
} from './fault-reconcile.ts'

const NOW = '2026-11-20T00:00:00.000Z'
const EVENT_TYPE = 'task.autonomy_changed'
const TASK_SQL = 'SELECT task_id, current_run_id, autonomy, revision, updated_at FROM tasks WHERE task_id = ?'
const EVENTS_SQL = 'SELECT seq, event_id, type, run_id, node_run_id, payload_redacted FROM events ORDER BY seq'
const TARGET_EVENT_SQL = `
  SELECT seq, event_id, type, run_id, payload_redacted
  FROM events WHERE run_id = ? AND type = ? AND seq > ? AND json_extract(payload_redacted, '$.task_id') = ?
`

type Boundary = 'before_commit' | 'after_commit'
type WorkerMode = Boundary | 'commit'
type Marker = { boundary: Boundary; task: SqlRow[]; events: SqlRow[] }
type Readback = { task: SqlRow[]; events: SqlRow[] }

function readback(file: string, taskId: string): Readback {
  const db = openDb(file, { readonly: true })
  try {
    return { task: sqlRows(db.raw.prepare(TASK_SQL).all(taskId)), events: sqlRows(db.raw.prepare(EVENTS_SQL).all()) }
  } finally {
    db.raw.close()
  }
}

function runTransaction(
  file: string,
  input: SetTaskAutonomyParams,
  eventBindings: [string, string, number, string],
  mode: WorkerMode,
): void {
  const db = openDb(file)
  try {
    function emit(boundary: Boundary): void {
      const marker: Marker = {
        boundary,
        task: sqlRows(db.raw.prepare(TASK_SQL).all(input.taskId)),
        events: sqlRows(db.raw.prepare(TARGET_EVENT_SQL).all(...eventBindings)),
      }
      writeSync(1, JSON.stringify(marker) + '\n')
      if (boundary === mode) {
        // Preserve the selected cut if the parent times out or dies at its barrier.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
        throw new Error('Parent did not terminate the transaction at its barrier')
      }
    }
    const exec = db.raw.exec.bind(db.raw)
    db.raw.exec = (sql) => {
      if (sql === 'COMMIT') emit('before_commit')
      exec(sql)
    }
    const result = setTaskAutonomy(db, input)
    emit('after_commit')
    writeSync(1, JSON.stringify({ result }) + '\n')
  } finally {
    db.raw.close()
  }
}

async function runWorker(
  file: string,
  input: SetTaskAutonomyParams,
  bindings: [string, string, number, string],
  mode: WorkerMode,
) {
  const argv = ['--no-warnings', import.meta.filename, file, JSON.stringify(input), JSON.stringify(bindings), mode]
  const target = mode === 'commit' ? 'after_commit' : mode
  const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let cursor = 0
  let stderr = ''
  let marker: Marker | undefined
  let outside: Readback | undefined
  let observedAt: string | undefined
  let killRequested = false
  let timedOut = false
  let error: string | undefined
  return new Promise<{
    marker: Marker | undefined
    outside: Readback | undefined
    exit: { code: number | null; signal: NodeJS.Signals | null }
    observedAt: string | undefined
    killRequested: boolean
    timedOut: boolean
    error: string | undefined
    stdout: string
    stderr: string
  }>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 20_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      while (!marker && !error) {
        const markerEnd = stdout.indexOf('\n', cursor)
        if (markerEnd < 0) return
        try {
          const record = JSON.parse(stdout.slice(cursor, markerEnd)) as Marker
          cursor = markerEnd + 1
          if (record.boundary !== target) continue
          marker = record
          observedAt = new Date().toISOString()
          if (mode !== 'commit') {
            outside = readback(file, input.taskId)
            killRequested = child.kill('SIGKILL')
          }
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause)
          child.kill('SIGKILL')
        }
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (cause) => { error = cause.message })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ marker, outside, exit: { code, signal }, observedAt, killRequested, timedOut, error, stdout, stderr })
    })
  })
}

function autonomyScenario(boundary: Boundary): FaultCase {
  return async ({ directory }) => {
    const { file, db } = freshLedger(directory)
    let run: ReturnType<typeof createRun>
    try {
      run = createRun(db, catalogFor(['g01_node']), { workflowVersion: '1', taskTitle: 'S6 G-01 transaction sample', now: NOW })
    } finally {
      db.raw.close()
    }
    sealCheckpoint(file)
    const beforeFile = join(directory, 'before.db')
    const controlFile = join(directory, 'control.db')
    copyFileSync(file, beforeFile, constants.COPYFILE_EXCL)
    copyFileSync(file, controlFile, constants.COPYFILE_EXCL)
    const before = readback(beforeFile, run.task_id)
    const beforeMaxSeq = Number(before.events.at(-1)?.seq ?? 0)
    const beforeRevision = Number(before.task[0]?.revision)
    const input = { taskId: run.task_id, autonomy: 'assisted', expectedRevision: beforeRevision, now: '2026-11-20T00:01:00.000Z' } as const
    const eventBindings: [string, string, number, string] = [run.run_id, EVENT_TYPE, beforeMaxSeq, run.task_id]
    const rollback = boundary === 'before_commit'
    const [killed, control] = await Promise.all([
      runWorker(file, input, eventBindings, boundary),
      runWorker(controlFile, input, eventBindings, rollback ? 'commit' : 'before_commit'),
    ])
    writeFileSync(join(directory, 'processes.json'), JSON.stringify({ killed, control }, null, 2) + '\n')
    sealCheckpoint(file)
    sealCheckpoint(controlFile)
    const after = readback(file, run.task_id)
    const controlAfter = readback(controlFile, run.task_id)
    const recoveredAgain = readback(file, run.task_id)
    const targetEvent = killed.marker?.events[0]
    const query = (database: string, sql: string, bindings: SqlValue[], expectedCount: number): FaultQuery =>
      ({ database, sql, bindings, expectedCount })
    const matchesAfter = [input.autonomy, beforeRevision + 1, run.task_id, run.run_id]
    const targetEventAfter = `SELECT * FROM (${TARGET_EVENT_SQL}) WHERE event_id = ?`
    const initiated = before.task[0]?.current_run_id === run.run_id && beforeMaxSeq > 0
    const markerTask = killed.marker?.task[0]
    const controlEventId = control.marker?.events[0]?.event_id
    const expectedEventCount = rollback ? 0 : 1
    const replayDb = openDb(file, { readonly: true })
    let replay
    try {
      const fromSeq = beforeMaxSeq
      const first = listEvents(replayDb, { fromSeq, limit: 10 })
      const repeated = listEvents(replayDb, { fromSeq, limit: 10 })
      const resumed = listEvents(replayDb, { fromSeq: beforeMaxSeq + expectedEventCount, limit: 10 })
      const consumer = new Map<number, SqlRow>()
      for (const value of [...first.rows, ...repeated.rows]) {
        const row = value as SqlRow
        if (!consumer.has(Number(row.seq))) consumer.set(Number(row.seq), row)
      }
      replay = { fromSeq, first, repeated, resumed, consumerRows: [...consumer.values()] }
    } finally {
      replayDb.raw.close()
    }
    const durablePrefix = rollback || !targetEvent ? before.events : [...before.events, targetEvent]
    const expectedRecovery = rollback ? before : killed.outside
    return {
      params: { command: 'setTaskAutonomy', requested: input, beforeMaxSeq, boundary },
      sampleIds: { taskId: run.task_id, runId: run.run_id, nodeRunId: run.nodes[0]!.node_run_id, ...(targetEvent?.event_id ? { eventId: String(targetEvent.event_id) } : {}) },
      boundary: {
        reached: initiated && !killed.error && !killed.timedOut && killed.killRequested
          && killed.exit.code === null && killed.exit.signal === 'SIGKILL'
          && killed.marker?.task.length === 1 && markerTask?.task_id === run.task_id
          && markerTask?.autonomy === input.autonomy && markerTask.revision === beforeRevision + 1
          && killed.marker.events.length === 1 && typeof targetEvent?.event_id === 'string' && targetEvent.seq === beforeMaxSeq + 1,
        kind: boundary,
        marker: killed.marker,
        observedAt: killed.observedAt,
        exit: killed.exit,
        error: killed.error,
        timedOut: killed.timedOut,
      },
      snapshots: { before, breakpoint: killed.outside, after },
      artifacts: ['before.db', 'orchestra.db', 'control.db', 'processes.json'],
      queries: {
        half_rows: query('orchestra.db', `
          WITH business AS (
            SELECT task_id FROM tasks WHERE autonomy = ? AND revision = ? AND task_id = ? AND current_run_id = ?
          ), durable_event AS (
            ${targetEventAfter}
          )
          SELECT 'business_without_event' AS gap, task_id AS id FROM business WHERE NOT EXISTS (SELECT 1 FROM durable_event)
          UNION ALL
          SELECT 'event_without_business', event_id FROM durable_event WHERE NOT EXISTS (SELECT 1 FROM business)
        `, [...matchesAfter, ...eventBindings, targetEvent?.event_id ?? null], 0),
        orphan_runs: query('orchestra.db', ORPHAN_REFERENCES_SQL, [], 0),
        missing_events: query('orchestra.db', MISSING_GLOBAL_EVENTS_SQL, [JSON.stringify(durablePrefix)], 0),
      },
      extraQueries: {
        baseline_task: query('before.db', TASK_SQL, [run.task_id], 1),
        ...(rollback ? {
          rollback_task: query('orchestra.db', TASK_SQL + ' AND current_run_id = ? AND autonomy = ? AND revision = ?',
            [run.task_id, run.run_id, before.task[0]?.autonomy ?? null, beforeRevision], 1),
          rollback_event: query('orchestra.db', `${TARGET_EVENT_SQL} ORDER BY seq`, eventBindings, 0),
          committed_healthy_task: query('control.db',
            'SELECT task_id FROM tasks WHERE autonomy = ? AND revision = ? AND task_id = ? AND current_run_id = ?', matchesAfter, 1),
          committed_healthy_event: query('control.db', targetEventAfter, [...eventBindings, controlEventId ?? null], 1),
        } : {
          committed_task: query('orchestra.db',
            'SELECT task_id FROM tasks WHERE autonomy = ? AND revision = ? AND task_id = ? AND current_run_id = ?', matchesAfter, 1),
          committed_event: query('orchestra.db', targetEventAfter, [...eventBindings, targetEvent?.event_id ?? null], 1),
          committed_scope_event_count: query('orchestra.db', TARGET_EVENT_SQL, eventBindings, 1),
          uncommitted_control_event: query('control.db', TARGET_EVENT_SQL, eventBindings, 0),
        }),
        legal_business_orphaned: query('orchestra.db', "SELECT run_id FROM runs WHERE status = 'orphaned' ORDER BY run_id", [], 0),
      },
      checks: {
        reader_sees_only_committed_rows: {
          actual: killed.outside,
          expected: rollback ? before : {
            task: killed.marker?.task,
            events: [...before.events, ...after.events.filter((row) => row.event_id === targetEvent?.event_id)],
          },
        },
        recovered_ledger_matches_expected: { actual: after, expected: expectedRecovery },
        repeat_recovery: { actual: recoveredAgain, expected: after },
        control_worker_exit: { actual: control.exit, expected: rollback ? { code: 0, signal: null } : { code: null, signal: 'SIGKILL' } },
        control_event_increment: { actual: controlAfter.events.length - before.events.length, expected: rollback ? 1 : 0 },
        baseline_event_prefix: { actual: after.events.slice(0, before.events.length), expected: before.events },
        replayed_event_ids: { actual: replay.consumerRows.map((row) => row.event_id), expected: rollback ? [] : [targetEvent?.event_id ?? null] },
        replayed_event_seqs: { actual: replay.consumerRows.map((row) => row.seq), expected: rollback ? [] : [beforeMaxSeq + 1] },
        repeated_replay_is_identical: { actual: replay.repeated, expected: replay.first },
        resume_from_last_applied_seq: { actual: replay.resumed.rows, expected: [] },
      },
      extra: { replay, control: { after: controlAfter, exit: control.exit, marker: control.marker } },
    }
  }
}

export const caseG01S6 = autonomyScenario('before_commit')
export const caseG02S6 = autonomyScenario('after_commit')

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, input, scope, mode] = process.argv.slice(2)
  if (!file || !input || !scope || (mode !== 'before_commit' && mode !== 'after_commit' && mode !== 'commit')) {
    throw new Error('Missing fault transaction worker parameters')
  }
  runTransaction(file, JSON.parse(input), JSON.parse(scope), mode)
}
