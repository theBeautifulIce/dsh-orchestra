import { join } from 'node:path'
import { ScriptedClock } from '../src/core/clock.ts'
import { openDb, withTx, type Db } from '../src/infra/sqlite/driver.ts'
import { enterWaiting } from '../src/service/commands/wait.ts'
import { sweep } from '../src/service/sweep.ts'
import { freshLedger, TEST_SECRET } from '../tests/fixtures/ledger.ts'
import { MISSING_GLOBAL_EVENTS_SQL, ORPHAN_REFERENCES_SQL, sqlRows, type FaultQuery } from './fault-reconcile.ts'
import { checkpoint, recordJson, seedScope } from './fault-clock-support.ts'
import type { FaultCase } from './fault-report.ts'

export { caseG08S6 } from './fault-write-queue.ts'
export { caseG09S6 } from './fault-sse-resume.ts'

const START = Date.parse('2026-11-20T12:00:00.000Z')
const JUMP_MS = 600_000
const BUDGET_MS = 60_000
const CLOCK_IDS = ['forward', 'backward', 'trusted', 'legacy']
const CLOCK_SQL = `SELECT n.node_run_id, n.run_id, n.status, n.revision, n.wait_deadline_at, n.wait_deadline_boot_id,
  n.wait_deadline_monotonic_ns, n.wait_remaining_ns, n.recovery_uncertain, w.state AS registration, r.status AS run_status
  FROM node_runs n LEFT JOIN wait_registrations w USING(node_run_id) JOIN runs r ON n.run_id=r.run_id
  WHERE n.node_run_id IN (SELECT value FROM json_each(?)) ORDER BY n.node_run_id`
const NODE_EVENT_SQL = `SELECT node_run_id, seq, type, payload, hash FROM node_run_events
  WHERE node_run_id IN (SELECT value FROM json_each(?)) ORDER BY node_run_id, seq`
const EVENT_SQL = 'SELECT seq, event_id, type, run_id, node_run_id FROM events ORDER BY seq'
const HALF_WAIT_SQL = `SELECT n.node_run_id, n.status, n.revision, w.state, r.status AS run_status
  FROM node_runs n LEFT JOIN wait_registrations w USING(node_run_id) JOIN runs r ON r.run_id=n.run_id
  WHERE n.node_run_id IN (SELECT value FROM json_each(?)) AND (
    w.state IS NULL OR (w.state = 'timed_out') <> (n.status = 'timeout')
    OR (r.status = 'failed') <> (n.status = 'timeout')
    OR (SELECT COUNT(*) FROM node_run_events e WHERE e.node_run_id=n.node_run_id AND e.type='wait.event_timeout') <> (n.status='timeout')
    OR (SELECT COUNT(*) FROM events e WHERE e.node_run_id=n.node_run_id AND e.run_id=n.run_id AND e.type='wait.event_timeout') <> (n.status='timeout')
    OR (SELECT COUNT(*) FROM events e WHERE e.run_id=n.run_id AND e.type='run.terminal') <> (n.status='timeout')
  )`

function clockSnapshot(db: Db) {
  return {
    nodes: sqlRows(db.raw.prepare(CLOCK_SQL).all(JSON.stringify(CLOCK_IDS))),
    nodeEvents: sqlRows(db.raw.prepare(NODE_EVENT_SQL).all(JSON.stringify(CLOCK_IDS))),
    globalEvents: sqlRows(db.raw.prepare(EVENT_SQL).all()),
  }
}

export const caseG07S6: FaultCase = ({ directory }) => {
  const live = freshLedger(directory)
  let db = live.db
  let clock = new ScriptedClock('s6_clock_a', { wallClockMs: START, monotonicNs: 0 })
  const artifacts: string[] = []
  const scans: { label: string; clock: ReturnType<ScriptedClock['sample']>;
    result: ReturnType<typeof sweep>; snapshot: ReturnType<typeof clockSnapshot> }[] = []
  const snapshot = (file: string) => {
    artifacts.push(checkpoint(live.file, directory, file))
    return { database: file, ...clockSnapshot(db), clock: clock.sample() }
  }
  const sample = (label: string, wallClockMs: number, advanceMs = 0) => {
    clock.advanceMs(advanceMs)
    clock.setWallClockMs(wallClockMs)
    const time = clock.sample()
    const result = sweep(db, TEST_SECRET, { now: new Date(time.wallClockMs).toISOString(), clock })
    const entry = { label, clock: time, result, snapshot: clockSnapshot(db) }
    scans.push(entry)
    return entry
  }
  const reboot = (bootId: string, wallClockMs: number) => {
    db.raw.close()
    db = openDb(live.file)
    clock = new ScriptedClock(bootId, { wallClockMs, monotonicNs: 0 })
  }
  const row = (entry: typeof scans[number], nodeId: string) => entry.snapshot.nodes.find((n) => n.node_run_id === nodeId)!
  const binding = JSON.stringify(CLOCK_IDS)
  try {
    for (const id of CLOCK_IDS) {
      seedScope(db, id + '-run', id, 'wait')
      withTx(db, (tx) => enterWaiting(tx, TEST_SECRET, {
        nodeRunId: id, runId: id + '-run', attempt: 1, waitKind: 'timer', match: { type: 's6.never' },
        idempotencyKey: 's6-clock-' + id, maxWaitMs: BUDGET_MS, now: new Date(START).toISOString(), clock,
      }))
    }
    const before = snapshot('before.db')
    const future = sample('wall_forward_pending', START + 20_000 + JUMP_MS, 20_000)
    const past = sample('wall_backward_pending', START + 20_000 - JUMP_MS)
    const breakpoint = snapshot('wall-jump.db')

    // Keep the restart branches at their real 40-second checkpoint. Run the deadline
    // boundary on an independent copy of this committed state.
    const boundaryFile = join(directory, 'clock-boundary-live.db')
    checkpoint(live.file, directory, 'clock-boundary-live.db')
    const original = db
    db = openDb(boundaryFile)
    let futureAtDeadline: typeof scans[number]
    let pastAtDeadline: typeof scans[number]
    let calibratedAtDeadline: typeof scans[number]
    try {
      futureAtDeadline = sample('wall_forward_at_deadline', START + BUDGET_MS + JUMP_MS, 40_000)
      pastAtDeadline = sample('wall_backward_at_deadline', START + BUDGET_MS - JUMP_MS)
      calibratedAtDeadline = sample('calibrated_at_deadline', START + BUDGET_MS)
      artifacts.push(checkpoint(boundaryFile, directory, 'clock-boundary.db'))
    } finally {
      db.raw.close()
      db = original
    }

    // Model an old row missing the checkpoint column's data, retaining its original boot anchor and chain.
    withTx(db, (tx) => tx.run('UPDATE node_runs SET wait_remaining_ns = NULL WHERE node_run_id = ?', ['legacy']))
    artifacts.push(checkpoint(live.file, directory, 'restart-input.db'))
    reboot('s6_clock_b', START + JUMP_MS)
    const rebased = sample('first_reopen', START + JUMP_MS)
    const elapsed = sample('first_reopen_elapsed', START + JUMP_MS + 15_000, 15_000)
    artifacts.push(checkpoint(live.file, directory, 'first-restart.db'))
    reboot('s6_clock_c', START - JUMP_MS)
    const rebasedAgain = sample('second_reopen', START - JUMP_MS)
    const beforeExpiry = sample('one_ms_before_restored_deadline', START - JUMP_MS + 24_999, 24_999)
    const expiry = sample('restored_deadline', START - JUMP_MS + 25_000, 1)
    const replay = sample('repeat_restored_deadline', START - JUMP_MS + 25_000)
    const after = snapshot('after.db')
    artifacts.push(recordJson(directory, 'clock-scans.json', scans))
    const expectedEntered = before.globalEvents.filter((event) => event.type === 'wait.entered')
    const expectedTerminal = expiry.snapshot.globalEvents.filter((event) =>
      event.type === 'wait.event_timeout' || event.type === 'run.terminal')
    const q = (database: string, sql: string, expectedCount: number, bindings: FaultQuery['bindings'] = [binding]): FaultQuery =>
      ({ database, sql, bindings, expectedCount })
    const counts = (entry: typeof scans[number]) => entry.snapshot.nodes.map(({ status, revision }) => ({ status, revision }))
    return {
      params: { budgetMs: BUDGET_MS, wallJumpMs: JUMP_MS },
      sampleIds: { forwardNode: 'forward', backwardNode: 'backward', trustedNode: 'trusted', legacyNode: 'legacy' },
      boundary: { reached: future.clock.monotonicNs === past.clock.monotonicNs
          && future.clock.wallClockMs === START + 20_000 + JUMP_MS && past.clock.wallClockMs === START + 20_000 - JUMP_MS
          && futureAtDeadline.clock.monotonicNs === BUDGET_MS * 1e6 && pastAtDeadline.clock.monotonicNs === BUDGET_MS * 1e6
          && rebased.clock.bootId !== rebasedAgain.clock.bootId,
        wallClockPending: [future.clock, past.clock], wallClockAtDeadline: [futureAtDeadline.clock, pastAtDeadline.clock] },
      snapshots: { before, breakpoint, after },
      queries: {
        half_rows: q('after.db', HALF_WAIT_SQL, 0),
        orphan_runs: q('after.db', ORPHAN_REFERENCES_SQL, 0, []),
        missing_events: q('after.db', MISSING_GLOBAL_EVENTS_SQL, 0, [JSON.stringify([...expectedEntered, ...expectedTerminal])]),
      },
      extraQueries: {
        all_wait_nodes_before: q('before.db', CLOCK_SQL, 4),
        all_wait_nodes_at_wall_jump: q('wall-jump.db', CLOCK_SQL, 4),
        all_wait_nodes_after: q('after.db', CLOCK_SQL, 4),
        boundary_terminal: q('clock-boundary.db', "SELECT event_id, run_id FROM events WHERE type = 'run.terminal'", 4, []),
        legacy_uncertain: q('after.db', "SELECT type, payload FROM node_run_events WHERE node_run_id = ? AND type = 'timer_uncertain' AND json_extract(payload, '$.reason') = 'checkpoint_missing'", 1, ['legacy']),
        trusted_reanchors: q('after.db', "SELECT type, payload FROM node_run_events WHERE node_run_id = ? AND type = 'deadline.reanchored' ORDER BY seq", 2, ['trusted']),
        restored_terminal: q('after.db', "SELECT event_id, run_id FROM events WHERE type = 'run.terminal'", 3, []),
      },
      checks: {
        walls_do_not_change_status_or_revision: {
          actual: [future, past, futureAtDeadline, pastAtDeadline].map(counts),
          expected: Array.from({ length: 4 }, () => before.nodes.map(({ status, revision }) => ({ status, revision }))),
        },
        positive_calibrated_deadline: { actual: calibratedAtDeadline.result.wait_timed_out, expected: 4 },
        trusted_budget_ns: { actual: [row(future, 'trusted').wait_remaining_ns, row(rebased, 'trusted').wait_remaining_ns,
          row(elapsed, 'trusted').wait_remaining_ns, row(rebasedAgain, 'trusted').wait_remaining_ns,
          row(beforeExpiry, 'trusted').wait_remaining_ns], expected: [40e9, 40e9, 25e9, 25e9, 1e6] },
        trusted_anchor_ns: { actual: [row(rebased, 'trusted').wait_deadline_monotonic_ns, row(rebasedAgain, 'trusted').wait_deadline_monotonic_ns], expected: [40e9, 25e9] },
        pending_then_expired: { actual: [beforeExpiry.result.wait_timed_out, expiry.result.wait_timed_out, replay.result.wait_timed_out], expected: [0, 3, 0] },
        deterministic_event_counts: { actual: [expectedEntered.length, expectedTerminal.length], expected: [4, 6] },
        legacy_remains_waiting: { actual: [row(replay, 'legacy').status, row(replay, 'legacy').registration,
          row(replay, 'legacy').recovery_uncertain, row(replay, 'legacy').wait_deadline_boot_id,
          row(replay, 'legacy').revision], expected: ['waiting', 'active', 'wait_timer', 's6_clock_a',
          before.nodes.find((n) => n.node_run_id === 'legacy')!.revision] },
        repeat_scan_keeps_rows_and_events: { actual: replay.snapshot, expected: expiry.snapshot },
      },
      artifacts,
      extra: { legacyCheckpointFixture: 'Only wait_remaining_ns was cleared after the committed wall-jump checkpoint' },
    }
  } finally {
    db.raw.close()
  }
}
