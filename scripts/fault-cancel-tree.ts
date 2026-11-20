import { copyFileSync, constants } from 'node:fs'
import { join } from 'node:path'
import { ScriptedClock } from '../src/core/clock.ts'
import { openDb, withTx, type Db } from '../src/infra/sqlite/driver.ts'
import { createRun } from '../src/service/runs.ts'
import { WorkflowCatalog } from '../src/service/workflows.ts'
import { ToolRegistry } from '../src/executor/tools.ts'
import { applyTransition } from '../src/service/commands/nodes.ts'
import { closeRun } from '../src/service/commands/run-close.ts'
import { finishSubworkflowChild, propagateRunCancellation, startSubworkflowNode } from '../src/service/commands/subworkflow.ts'
import { freshLedger, TEST_SECRET } from '../tests/fixtures/ledger.ts'
import { ORPHAN_REFERENCES_SQL, MISSING_GLOBAL_EVENTS_SQL, sealCheckpoint, sqlRows } from './fault-reconcile.ts'
import type { FaultCase } from './fault-report.ts'

const now = '2026-11-20T00:00:00.000Z'
const ledgerState = (db: Db, root: string) => ({
  runs: sqlRows(db.raw.prepare('SELECT run_id,root_run_id,parent_run_id,status,revision FROM runs WHERE root_run_id=? ORDER BY run_id').all(root)),
  nodes: sqlRows(db.raw.prepare('SELECT n.node_run_id,n.run_id,n.status,n.attempt,n.action_generation FROM node_runs n JOIN runs r USING(run_id) WHERE r.root_run_id=? ORDER BY n.node_run_id').all(root)),
  terminals: sqlRows(db.raw.prepare("SELECT seq,e.run_id,json_extract(payload_redacted,'$.status') AS status,json_extract(payload_redacted,'$.outcome') AS outcome,json_extract(payload_redacted,'$.unverified_nodes') AS unverified FROM events e JOIN runs r USING(run_id) WHERE type='run.terminal' AND r.root_run_id=? ORDER BY seq").all(root)),
})
export const caseG16S6: FaultCase = ({ directory }) => {
  const setup = freshLedger(directory)
  let db = setup.db
  const registry = new ToolRegistry()
  const catalog = new WorkflowCatalog('S6', undefined, name => registry.lookup(name)?.capability === 'read_only', registry)
  const clock = new ScriptedClock('cancel-test', { wallClockMs: Date.parse(now), monotonicNs: 0 })
  const records: Record<string, unknown> = {}, before: Record<string, unknown> = {}, at: Record<string, unknown> = {}
  const checks: Record<string, { actual: unknown; expected: unknown }> = {}
  const roots: string[] = [], artifacts = ['orchestra.db']
  let expectedEvents
  try {
    for (const path of ['clean','unverified','failed'] as const) {
      const parentFlow = 'root-' + path, childFlow = 'child-' + path
      catalog.load({ workflow_id: parentFlow, workflow_version: '1', nodes: [
        { node_id: 'sub', type: 'subworkflow', subworkflow: { workflow_id: childFlow, pinned_version: 1 } }] })
      catalog.load({ workflow_id: childFlow, workflow_version: '1', nodes: [
        { node_id: 'queued-check', type: 'agent', side_effect_policy: 'pure' },
        { node_id: 'observed-check', type: 'agent', side_effect_policy: path === 'clean' ? 'pure' : 'irreversible' }] })
      const root = createRun(db, catalog, { workflowId: parentFlow, workflowVersion: '1', taskTitle: path, now })
      roots.push(root.run_id)
      const p = root.nodes[0]!.node_run_id
      const child = withTx(db, (tx) => {
        // Set only initial worker state. The child, cancellation, transitions and run receipts use service commands.
        tx.run("UPDATE node_runs SET status='started' WHERE node_run_id=?", [p])
        const created = startSubworkflowNode(tx, TEST_SECRET, catalog, { nodeRunId: p, attempt: 1, workflowId: childFlow, workflowVersion: 1, now })
        if (path !== 'clean') tx.run("UPDATE node_runs SET status='started' WHERE run_id=? AND node_id='observed-check'", [created.run_id])
        return created.run_id
      })
      const id = String(db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='observed-check'").get(child)!.node_run_id)
      const cancel = () => withTx(db, (tx) => propagateRunCancellation(tx, TEST_SECRET, { runId: root.run_id, cancelResult: 'interrupted', now, graceMs: 1000, clock }))
      before[path] = ledgerState(db, root.run_id)
      const stopped = cancel()
      const first = ledgerState(db, root.run_id)
      cancel()
      const repeat = ledgerState(db, root.run_id)
      const early = withTx(db, (tx) => closeRun(tx, TEST_SECRET, root.run_id, now))
      at[path] = { stopped, first, repeat, early }
      checks[path + '_unchanged_repeat'] = { actual: repeat, expected: first }
      checks[path + '_parent_waits'] = { actual: [early,first.terminals.length,stopped.cancelledRuns,stopped.skippedIrreversible], expected: [null,0,[child],path === 'clean' ? [] : [id]] }
      db.raw.close()
      sealCheckpoint(setup.file)
      const breakpoint = path + '-pending.db'
      copyFileSync(setup.file, join(directory, breakpoint), constants.COPYFILE_EXCL)
      artifacts.push(breakpoint)
      db = openDb(setup.file)
      withTx(db, (tx) => {
        if (path !== 'clean') {
          applyTransition(tx, TEST_SECRET, { nodeRunId: id, attempt: 1, from: ['started'], to: 'verifying', ruleId: 'M-15', now })
          applyTransition(tx, TEST_SECRET, { nodeRunId: id, attempt: 1, from: ['verifying'], to: path === 'failed' ? 'failed' : 'done', ruleId: 'M-16', now })
        }
        closeRun(tx, TEST_SECRET, child, now)
        finishSubworkflowChild(tx, TEST_SECRET, { childRunId: child, now })
        closeRun(tx, TEST_SECRET, root.run_id, now)
      })
      const final = ledgerState(db, root.run_id)
      const childEvent = final.terminals[0], parentEvent = final.terminals[1]
      const childOutcome = path === 'clean' ? 'succeeded' : path === 'unverified' ? 'succeeded_with_unverified' : 'failed_with_unverified'
      checks[path + '_child_then_parent'] = { actual: final.terminals.map((r) => [r.run_id,r.status]), expected: [[child,'cancelled'],[root.run_id,'cancelled']] }
      checks[path + '_child_outcome'] = { actual: [childEvent?.outcome, JSON.parse(String(childEvent?.unverified ?? 'null'))], expected: [childOutcome,path === 'clean' ? [] : [id]] }
      checks[path + '_parent_outcome'] = { actual: [parentEvent?.outcome, JSON.parse(String(parentEvent?.unverified ?? 'null'))],
        expected: [path === 'clean' ? 'succeeded' : 'succeeded_with_unverified', path === 'clean' ? [] : [p]] }
      cancel()
      withTx(db, (tx) => { finishSubworkflowChild(tx, TEST_SECRET, { childRunId:child, now }); closeRun(tx,TEST_SECRET,root.run_id,now) })
      checks[path + '_final_replay'] = { actual: ledgerState(db, root.run_id), expected: final }
      records[path] = final
    }
    expectedEvents = sqlRows(db.raw.prepare('SELECT seq,event_id FROM events ORDER BY seq').all())
  } finally { db.raw.close() }
  sealCheckpoint(setup.file)
  return { sampleIds: Object.fromEntries(roots.map((id, i) => ['root' + i,id])), boundary: { reached: true, scenarios: roots.length },
    snapshots: { before, breakpoint: at, after: records }, checks, artifacts, queries: {
      half_rows: { database: 'orchestra.db', sql: "SELECT r.run_id FROM runs r LEFT JOIN events e ON r.run_id=e.run_id AND e.type='run.terminal' GROUP BY r.run_id HAVING count(e.seq)<>1", bindings: [], expectedCount: 0 },
      orphan_runs: { database: 'orchestra.db', sql: ORPHAN_REFERENCES_SQL, bindings: [], expectedCount: 0 },
      missing_events: { database: 'orchestra.db', sql: MISSING_GLOBAL_EVENTS_SQL, bindings: [JSON.stringify(expectedEvents)], expectedCount: 0 },
    } }
}
