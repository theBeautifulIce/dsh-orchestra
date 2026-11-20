import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { appendEvent } from '../src/infra/db/ledger.ts'
import { OrchError } from '../src/core/errors.ts'
import { createLogger } from '../src/infra/logger.ts'
import { openDb, withTx, type Db } from '../src/infra/sqlite/driver.ts'
import { getRun } from '../src/service/queries/runs.ts'
import { listEvents } from '../src/service/queries/list_events.ts'
import { listNodes } from '../src/service/queries/nodes.ts'
import { listTaskSummaries } from '../src/service/queries/tasks.ts'
import { startServer, type ServerQueries } from '../src/service/server.ts'
import { WriteQueue } from '../src/service/write-queue.ts'
import { freshLedger } from '../tests/fixtures/ledger.ts'
import { PERF_BUDGETS, PERF_ROUNDS, PERF_WARMUP, perfStats, type PerfRoute } from './perf-budget-evidence.ts'
import { MISSING_GLOBAL_EVENTS_SQL, ORPHAN_REFERENCES_SQL, sqlRows } from './fault-reconcile.ts'
import { checkpoint, eventually, FIXTURE_TIME, recordJson, seedScope } from './fault-clock-support.ts'
import type { FaultCase } from './fault-report.ts'

const RUN = 's6-write-queue-run'
const NODE = 's6-write-queue-node'
const TYPE = 's6.queue_probe'
const SEED_TYPE = 's6.queue_read_fixture'
const CAPACITY = 1000
const BUSY_TIMEOUT = 5000
const FAILED_REQUEST = CAPACITY + 2
const FOLLOWUP_REQUEST = CAPACITY + 3

class QueuedWriteBarrier extends WriteQueue {
  readonly entered = Promise.withResolvers<void>()
  readonly hold = Promise.withResolvers<void>()
  private armed = true

  override run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (!this.armed) return super.run(operation)
    this.armed = false
    return super.run(async () => {
      this.entered.resolve()
      await this.hold.promise
      return operation()
    })
  }
}
const TASKS = 10_000
const NODES = 1000
const EVENT_PAGE = 200
const BODY_SQL = `SELECT seq, event_id, run_id, node_run_id, json_extract(payload_redacted, '$.index') AS request_index
  FROM events WHERE run_id = ? AND type = ? ORDER BY seq`

function write(db: Db, index: number) {
  return withTx(db, (tx) => appendEvent(tx, { type: TYPE, runId: RUN, nodeRunId: NODE, payload: { index } }))
}

function seedLoad(db: Db): void {
  seedScope(db, RUN, NODE)
  withTx(db, (tx) => {
    for (let index = 0; index < TASKS - 1; index++) {
      tx.run("INSERT INTO tasks (task_id,title,status,revision,created_at,updated_at) VALUES (?,?,'draft',1,?,?)",
        ['bulk-' + index, 'Seed task ' + index, FIXTURE_TIME, FIXTURE_TIME])
    }
    for (let index = 1; index < NODES; index++) {
      const id = 'bulk-node-' + index
      tx.run(`INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,revision,created_at,updated_at)
        VALUES (?,?,?,?,'agent','done',1,?,?)`, [id, RUN, id, index + 1, FIXTURE_TIME, FIXTURE_TIME])
    }
    for (let index = 0; index < NODES; index++) {
      appendEvent(tx, { type: SEED_TYPE, runId: RUN, nodeRunId: NODE, payload: { index } })
    }
  })
}

type ChildMark = {
  stage: string; pid: number; at: string; elapsedMs?: number; busyTimeoutMs?: number; errcode?: number; code?: string; message?: string
}

function spawnWriter(mode: 'holder' | 'contender', file: string) {
  const child = fork(fileURLToPath(import.meta.url), ['--s6-queue-child', mode, file], {
    execArgv: ['--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const marks: ChildMark[] = []
  let stdout = ''
  let stderr = ''
  let exited = false
  child.on('message', (data) => marks.push(data as ChildMark))
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const closed = once(child, 'close').then(([code, signal]) => {
    exited = true
    return { pid: child.pid, code, signal, marks, stdout, stderr }
  }, (error: Error) => {
    exited = true
    return { pid: child.pid, error: error.message, marks, stdout, stderr }
  })
  return {
    marks,
    closed,
    async release() { if (child.connected) child.send('release'); return closed },
    async close() { if (!exited) child.kill(); return closed },
  }
}

function childWrite(mode: string, file: string): void {
  const db = openDb(file)
  const send = (stage: string, fields: Omit<Partial<ChildMark>, 'stage' | 'pid' | 'at'> = {}) =>
    process.send?.({ stage, pid: process.pid, at: new Date().toISOString(), ...fields })
  if (mode === 'holder') {
    db.raw.exec('BEGIN IMMEDIATE')
    // Leave a real uncommitted row while the service takes read snapshots.
    db.raw.prepare('UPDATE tasks SET title = ? WHERE task_id = ?').run('uncommitted S6 title', RUN + '-task')
    send('lock_held')
    const timer = setTimeout(() => { process.exitCode = 1; close() }, 55_000)
    const close = () => {
      clearTimeout(timer)
      db.raw.exec('ROLLBACK')
      db.raw.close()
      send('lock_released')
      if (process.connected) process.disconnect?.()
    }
    process.once('message', close)
    process.once('disconnect', () => { if (timer.hasRef()) clearTimeout(timer) })
    return
  }

  const busyTimeoutMs = Number(db.raw.prepare('PRAGMA busy_timeout').get()?.timeout)
  send('writer_entered', { busyTimeoutMs })
  const started = performance.now()
  try {
    write(db, CAPACITY + 1)
    send('unexpected_commit', { elapsedMs: performance.now() - started, busyTimeoutMs })
  } catch (error) {
    const { code, errcode, message } = error as Error & { errcode?: number; code?: string }
    send('writer_failed', { elapsedMs: performance.now() - started, busyTimeoutMs, errcode, code, message })
  } finally {
    db.raw.close()
    if (process.connected) process.disconnect?.()
  }
}

if (process.argv[2] === '--s6-queue-child' && process.send && process.argv[3] && process.argv[4]) {
  childWrite(process.argv[3], process.argv[4])
}

type Envelope = { as_of_seq?: number; ok?: boolean; data?: { items?: unknown[]; total?: number; seq?: number; event_id?: string }; error?: { code: string } }

export const caseG08S6: FaultCase = async ({ directory }) => {
  const { file, db } = freshLedger(directory)
  const logLines: string[] = []
  const log = createLogger({ write: (line) => logLines.push(line) })
  const queue = new QueuedWriteBarrier(undefined, log)
  const headers = { 'x-orchestra-secret': 'local-g08-fixture', 'content-type': 'application/json' }
  const asOfSeq = () => Number(db.raw.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get()?.n)
  const queryRoutes: Pick<ServerQueries, 'listTaskSummaries' | 'getRun' | 'listNodes' | 'listEvents'> = {
    listTaskSummaries: (params) => listTaskSummaries(db, params),
    getRun: (id) => getRun(db, id),
    listNodes: (id, limit) => listNodes(db, id, limit),
    listEvents: (fromSeq, limit) => listEvents(db, { fromSeq, limit }),
  }
  const invokeOrder: { index: number; pending: number; atMs: number }[] = []
  const depth: { stage: string; pending: number; atMs: number; index?: number }[] = []
  const noteDepth = (stage: string, index?: number) => depth.push({ stage, pending: queue.size, atMs: performance.now(), index })
  const reads: { stage: string; route: PerfRoute; warmup: boolean; round: number; ms: number;
    status: number; size: number; asOfSeq?: number; bytes: number; error?: string }[] = []
  const accepted: Array<Promise<{ index: number; status: number; body: Envelope }>> = []
  let holder: ReturnType<typeof spawnWriter> | undefined
  let contender: ReturnType<typeof spawnWriter> | undefined
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  const paths: Record<PerfRoute, string> = {
    list_tasks: '/v1/tasks',
    get_run: '/v1/runs/get?run_id=' + RUN,
    list_nodes: '/v1/node-runs?limit=200&run_id=' + RUN,
    list_events: '/v1/events?from_seq=0&limit=200',
  }
  const fetchRead = async (stage: string, route: PerfRoute, round: number) => {
    const startMs = performance.now()
    try {
      const response = await fetch(server!.endpoint + paths[route], { headers, signal: AbortSignal.timeout(8000) })
      const bytes = await response.text()
      const data = JSON.parse(bytes) as Envelope
      reads.push({ stage, route, warmup: round < 0, round, ms: performance.now() - startMs,
        status: response.status, size: data.data?.total ?? data.data?.items?.length ?? 0,
        asOfSeq: data.as_of_seq, bytes: Buffer.byteLength(bytes) })
    } catch (error) {
      reads.push({ stage, route, warmup: round < 0, round, ms: performance.now() - startMs,
        status: 0, size: 0, bytes: 0, error: String(error) })
    }
  }
  const sample = async (stage: string) => {
    for (const route of Object.keys(paths) as PerfRoute[]) {
      for (let round = -PERF_WARMUP; round < PERF_ROUNDS; round++) await fetchRead(stage, route, round)
    }
  }
  const post = async (index: number) => {
    try {
      const response = await fetch(server!.endpoint + '/v1/ledger/events', {
        method: 'POST', headers, body: JSON.stringify({ type: TYPE, index }), signal: AbortSignal.timeout(50_000),
      })
      return { index, status: response.status, body: await response.json() as Envelope }
    } catch (error) {
      return { index, status: 0, body: { error: { code: String(error) } } }
    }
  }
  const artifacts: string[] = []
  try {
    seedLoad(db)
    server = await startServer({
      secret: headers['x-orchestra-secret'], phase: 'S6', epoch: db.epoch, log, queue, asOfSeq,
      listTasks: () => { throw new Error('Legacy task route is not a measurement') },
      listEvents: () => { throw new Error('Legacy event route is not a measurement') },
      queries: queryRoutes as ServerQueries,
      appendLedgerEvent(body) {
        const { index } = body as { index: number }
        invokeOrder.push({ index, pending: queue.size, atMs: performance.now() })
        if (index === FAILED_REQUEST) throw new OrchError('SERVICE_UNAVAILABLE', 'Intentional queue failure')
        return write(db, index)
      },
    })
    await sample('baseline')
    const before = { db: checkpoint(file, directory, 'before.db'), head: asOfSeq(), pending: queue.size }
    artifacts.push(before.db)
    holder = spawnWriter('holder', file)
    await eventually(() => holder!.marks.some(({ stage }) => stage === 'lock_held'), 'separate SQLite writer lock')
    for (let index = 0; index < CAPACITY; index++) {
      accepted.push(post(index))
      await eventually(() => queue.size === index + 1, 'admitted HTTP write ' + index, 1500)
      if (index === 0) await queue.entered.promise
      noteDepth('admitted', index)
    }
    const rejected = await post(CAPACITY)
    noteDepth('rejected', CAPACITY)
    const breakpoint = { db: checkpoint(file, directory, 'locked.db'), pending: queue.size, head: asOfSeq(), rejected,
      holder: holder.marks.at(-1), callbacksEntered: invokeOrder.length }
    artifacts.push(breakpoint.db)
    contender = spawnWriter('contender', file)
    await sample('locked')
    const competingWriter = await contender.closed
    const lockProcess = await holder.release()
    queue.hold.resolve()
    const receipts = await Promise.all(accepted)
    noteDepth('drained')
    const deliberateFailure = post(FAILED_REQUEST)
    await eventually(() => invokeOrder.some(({ index }) => index === FAILED_REQUEST), 'failed command enters the queue')
    const afterFailure = await post(FOLLOWUP_REQUEST)
    const failed = await deliberateFailure
    const after = { db: checkpoint(file, directory, 'after.db'), head: asOfSeq(), pending: queue.size,
      successfulHttp: receipts.filter(({ status }) => status === 200).length, afterFailure }
    artifacts.push(after.db)
    const timings = Object.fromEntries(['baseline', 'locked'].map((stage) => [stage, Object.fromEntries(
      (Object.keys(paths) as PerfRoute[]).map((route) => {
        const samples = reads.filter((read) => read.stage === stage && read.route === route && !read.warmup)
        return [route, { ...perfStats(samples.map(({ ms }) => ms)), requests: samples.length,
          success: samples.filter(({ status, size, asOfSeq: head }) => status === 200 && size === PERF_BUDGETS[route].size && head === before.head).length,
          budgetMs: PERF_BUDGETS[route].ms }]
      }))]))
    const committed = sqlRows(db.raw.prepare(BODY_SQL).all(RUN, TYPE))
    const warned = logLines.map((line) => JSON.parse(line) as { level: string; pending?: number; max?: number })
      .some(({ level, pending, max }) => level === 'warn' && pending === CAPACITY && max === CAPACITY)
    const sqlite = competingWriter.marks.find(({ stage }) => stage === 'writer_failed')
    const boundaryReached = queue.capacity === CAPACITY && breakpoint.pending === CAPACITY
      && breakpoint.callbacksEntered === 0 && breakpoint.holder?.stage === 'lock_held' && breakpoint.holder.pid !== process.pid
    const expectedEventRows = [...receipts.map(({ body }) => body.data), afterFailure.body.data]
      .map((item) => ({ seq: item?.seq ?? -1, event_id: item?.event_id ?? 'missing' }))
    artifacts.push(recordJson(directory, 'queue-raw.json', { logLines, reads, depth, invokeOrder, receipts,
      rejected, failed, afterFailure, competingWriter, lockProcess, committed }))
    return {
      params: { queueCapacity: CAPACITY, seededTasks: TASKS, scopedNodes: NODES,
        eachReadResults: [PERF_BUDGETS.list_tasks.size, NODES, EVENT_PAGE, EVENT_PAGE], busyTimeoutMs: BUSY_TIMEOUT },
      sampleIds: { runId: RUN, nodeRunId: NODE, refusedRequest: CAPACITY, holderPid: breakpoint.holder?.pid ?? -1 },
      boundary: { reached: boundaryReached, pending: breakpoint.pending, firstWriteHeldBeforeSqlite: breakpoint.callbacksEntered === 0 },
      snapshots: { before, breakpoint, after },
      queries: {
        half_rows: { database: 'after.db', sql: `SELECT e.seq, e.event_id, e.run_id, e.node_run_id, n.run_id AS node_owner
          FROM events e LEFT JOIN node_runs n ON e.node_run_id=n.node_run_id WHERE e.type = ? AND (e.run_id <> ? OR n.node_run_id IS NULL OR n.run_id <> e.run_id
            OR json_extract(e.payload_redacted, '$.index') IN (?,?,?))`, bindings: [TYPE, RUN, CAPACITY, CAPACITY + 1, FAILED_REQUEST], expectedCount: 0 },
        orphan_runs: { database: 'after.db', sql: ORPHAN_REFERENCES_SQL, bindings: [], expectedCount: 0 },
        missing_events: { database: 'after.db', sql: MISSING_GLOBAL_EVENTS_SQL, bindings: [JSON.stringify(expectedEventRows)], expectedCount: 0 },
      },
      extraQueries: {
        scheduled_rows_at_lock: { database: 'locked.db', sql: BODY_SQL, bindings: [RUN, TYPE], expectedCount: 0 },
        scheduled_rows_after: { database: 'after.db', sql: BODY_SQL, bindings: [RUN, TYPE], expectedCount: CAPACITY + 1 },
        uncommitted_title_at_lock: { database: 'locked.db', sql: "SELECT task_id,title FROM tasks WHERE task_id=? AND title='uncommitted S6 title'", bindings: [RUN + '-task'], expectedCount: 0 },
        seed_tasks: { database: 'before.db', sql: 'SELECT task_id FROM tasks ORDER BY task_id', bindings: [], expectedCount: TASKS },
        seed_nodes: { database: 'before.db', sql: 'SELECT node_run_id FROM node_runs WHERE run_id=? ORDER BY seq', bindings: [RUN], expectedCount: NODES },
      },
      checks: {
        http_reject: { actual: [rejected.status, rejected.body.error?.code], expected: [503, 'SERVICE_UNAVAILABLE'] },
        warning: { actual: warned, expected: true },
        real_busy_timeout: { actual: [sqlite?.busyTimeoutMs, sqlite?.errcode, (sqlite?.elapsedMs ?? 0) >= 4900], expected: [BUSY_TIMEOUT, 5, true] },
        lock_released: { actual: lockProcess.marks.at(-1)?.stage, expected: 'lock_released' },
        read_budgets: { actual: Object.values(timings).flatMap((stage) => Object.values(stage)
          .map((route) => [route.requests, route.success, route.p95 < route.budgetMs])),
          expected: Array.from({ length: 8 }, () => [PERF_ROUNDS, PERF_ROUNDS, true]) },
        no_visibility_at_lock: { actual: breakpoint.head, expected: before.head },
        queue_drained_and_followup_ok: { actual: [after.pending, after.successfulHttp, failed.status, failed.body.error?.code, afterFailure.status],
          expected: [0, CAPACITY, 503, 'SERVICE_UNAVAILABLE', 200] },
        actual_commit_fifo: { actual: committed.map(({ request_index }) => request_index),
          expected: [...Array.from({ length: CAPACITY }, (_, index) => index), FOLLOWUP_REQUEST] },
      },
      artifacts,
      extra: { timings, elapsedMethod: 'HTTP request through JSON decode, nearest-rank p95; five warmups', competingWriter },
    }
  } finally {
    await contender?.close()
    await holder?.close()
    queue.hold.resolve()
    try {
      await Promise.allSettled(accepted)
    } finally {
      try { await server?.close() } finally { db.raw.close() }
      if (!artifacts.includes('queue-raw.json')) recordJson(directory, 'queue-partial.json', {
        reads, depth, logLines, invokeOrder, holder: holder?.marks, contender: contender?.marks,
      })
    }
  }
}
