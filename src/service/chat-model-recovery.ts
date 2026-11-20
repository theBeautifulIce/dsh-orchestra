import { OrchError } from '../core/errors.ts'
import { type ModelRouting } from '../executor/model-routing.ts'
import { resolveModelAssignment } from '../executor/run-node.ts'
import { appendNodeRunEvent, chainIsIntact, readChain, readChainHead } from '../infra/db/ledger.ts'
import { makeTx, withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { loadNodeRun } from './commands/lease.ts'
import { transitionNode } from './commands/node-state.ts'
import { assertReworkExecutionAllowed } from './rework-runtime.ts'

type Candidate = { node_run_id: string; action_generation: number; revision: number }
const reason = 'model_assignment_unavailable'
const requeued = 'model_assignment_requeued'
const RETRY_DELAYS_MS = [2_000, 4_000] as const
export type ChatModelRecoveryChecks = Map<string, { attempts: number; retryAt?: number }>

// The old pre-spawn event has no action_generation. Match the latest acquisition
// immediately preceding that blocked transition and rule out any executor activity.
function candidates(tx: Tx, actor: string, runId: string, now: string): Candidate[] {
  return tx.all<Candidate>(`
    SELECT n.node_run_id, n.action_generation, n.revision
    FROM node_runs n JOIN runs r USING(run_id)
    JOIN start_run_operations o ON o.run_id = r.run_id
    JOIN task_plans p ON p.launch_operation_id = o.operation_id
    JOIN chat_task_receipts c USING(plan_id)
    JOIN node_run_events e ON e.node_run_id = n.node_run_id AND e.seq = (
      SELECT MAX(seq) FROM node_run_events WHERE node_run_id = n.node_run_id AND type = 'status_changed'
    )
    JOIN node_run_events l ON l.node_run_id = n.node_run_id AND l.seq = (
      SELECT MAX(seq) FROM node_run_events WHERE node_run_id = n.node_run_id AND type = 'lease_acquired'
    )
    JOIN node_run_events v ON v.node_run_id = n.node_run_id AND v.seq = e.seq + 1 AND v.type = 'verify_human'
    WHERE p.created_by = ? AND r.run_id = ? AND r.status = 'running' AND r.cancel_requested_at IS NULL
      AND n.status = 'blocked_pre' AND n.node_type = 'agent' AND n.side_effect_policy = 'pure'
      AND n.hang_reason IS NULL AND n.recovery_uncertain IS NULL AND n.resume_state IS NULL
      AND n.blocked_decision_id IS NULL AND n.contradiction_decision_id IS NULL
      AND n.replacement_node_run_id IS NULL AND n.lease_id IS NULL
      AND n.executor_agent_id IS NULL AND n.executor_session_id IS NULL AND n.started_at IS NULL
      AND n.cancel_requested_at IS NULL AND n.fence_state IS NULL AND n.tool_start_at IS NULL
      AND l.seq < e.seq AND json_extract(CASE WHEN json_valid(l.payload) THEN l.payload END, '$.action_generation') = n.action_generation
      AND json_extract(CASE WHEN json_valid(e.payload) THEN e.payload END, '$.from') = 'dispatched' AND json_extract(CASE WHEN json_valid(e.payload) THEN e.payload END, '$.to') = 'blocked_pre'
      AND json_extract(CASE WHEN json_valid(e.payload) THEN e.payload END, '$.attempt') = n.attempt AND json_extract(CASE WHEN json_valid(e.payload) THEN e.payload END, '$.reason') = ?
      AND json_extract(CASE WHEN json_valid(e.payload) THEN e.payload END, '$.decision_id') IS NULL
      AND COALESCE(json_extract(CASE WHEN json_valid(e.payload) THEN e.payload END, '$.action_generation'), n.action_generation) = n.action_generation
      AND json_extract(CASE WHEN json_valid(v.payload) THEN v.payload END, '$.reason') = ?
      AND json_extract(CASE WHEN json_valid(v.payload) THEN v.payload END, '$.status') = 'blocked_pre'
      AND NOT EXISTS (SELECT 1 FROM node_run_events WHERE node_run_id = n.node_run_id AND type = ?)
      AND NOT EXISTS (SELECT 1 FROM leases WHERE node_run_id = n.node_run_id AND expires_at > ?)
      AND NOT EXISTS (SELECT 1 FROM bridge_stream_cursors WHERE node_run_id = n.node_run_id)
      AND NOT EXISTS (SELECT 1 FROM bridge_event_receipts WHERE node_run_id = n.node_run_id)
      AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.run_id = r.run_id
        AND (d.node_run_id IS NULL OR d.node_run_id = n.node_run_id)
        AND d.status IN ('pending','acknowledged','blocked_for_human'))
    ORDER BY n.seq
  `, [actor, runId, reason, reason, requeued, now])
}

function candidateKey(node: Candidate): string {
  return `${node.node_run_id}:${node.action_generation}:${node.revision}`
}

/** Only temporary catalog failures are retried in the loaded conversation. */
export async function recoverChatModelAssignment(db: Db, secret: string, routing: ModelRouting, input: {
  actor: string; runId: string; signal: AbortSignal; checked: ChatModelRecoveryChecks; isCurrent(): boolean
  clock?: () => number
}): Promise<{ resumed: number; retrying: string[] }> {
  const { actor, runId, signal, checked, isCurrent, clock = Date.now } = input
  const inactive = () => signal.aborted || !isCurrent()
  if (inactive()) return { resumed: 0, retrying: [] }
  const observedAt = clock()
  const observed = candidates(makeTx(db.raw), actor, runId, new Date(observedAt).toISOString())
  const pending = observed.filter((node) => {
    const check = checked.get(candidateKey(node))
    return !check || (check.retryAt !== undefined && check.retryAt <= observedAt)
  })
  const retrying = () => observed.filter((node) => checked.get(candidateKey(node))?.retryAt !== undefined)
    .map(({ node_run_id }) => node_run_id)
  if (pending.length === 0) return { resumed: 0, retrying: retrying() }
  const keys = new Set(pending.map(candidateKey))
  for (const key of keys) checked.set(key, { attempts: (checked.get(key)?.attempts ?? 0) + 1 })
  let catalogReady = false
  try {
    await routing.refresh?.(signal)
    catalogReady = Boolean(routing.catalog?.()?.session_execution_model_ref)
  } catch {
    // Probe again after a delay if the native host could not read its model catalog.
  }
  if (inactive()) return { resumed: 0, retrying: [] }
  if (!catalogReady) {
    for (const key of keys) {
      const check = checked.get(key)!
      const delay = RETRY_DELAYS_MS[check.attempts - 1]
      if (delay !== undefined) check.retryAt = clock() + delay
    }
    return { resumed: 0, retrying: retrying() }
  }
  const now = new Date(clock()).toISOString()
  const resumed = withTx(db, (tx) => {
    let resumed = 0
    for (const node of candidates(tx, actor, runId, now)) {
      if (!keys.has(candidateKey(node))) continue
      const id = node.node_run_id
      if (!chainIsIntact(secret, readChain(tx, id), readChainHead(tx, id), true)) continue
      const row = loadNodeRun(tx, id)
      let assignment
      try {
        assertReworkExecutionAllowed(tx, id)
        assignment = resolveModelAssignment(tx, db, row, routing)
      } catch (error) {
        if (error instanceof OrchError) continue
        throw error
      }
      transitionNode(tx, secret, { nodeRunId: id, from: 'blocked_pre', to: 'queued', attempt: row.attempt,
        revision: row.revision, now, reason: requeued, actionGeneration: row.action_generation })
      appendNodeRunEvent(tx, secret, id, requeued, { attempt: row.attempt, action_generation: row.action_generation,
        model_ref: assignment.model_ref, reason: assignment.reason })
      resumed++
    }
    return resumed
  })
  return { resumed, retrying: retrying() }
}
