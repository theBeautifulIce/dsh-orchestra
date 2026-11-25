import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import { isRunTerminal } from './commands/run-close.ts'
import type { NodeCommands } from './server.ts'

export const operatorStopInput = z.strictObject({
  task_id: z.string().min(1).max(256),
  run_id: z.string().min(1).max(256),
  confirmed: z.literal(true),
})

export function operatorStopState(status: string, requestedAt: unknown) {
  return isRunTerminal(status) ? 'closed' : requestedAt ? 'requested' : 'available'
}

export function readOperatorRunStop(db: Db, runId: string) {
  const row = db.raw.prepare(
    'SELECT r.task_id,r.status,r.cancel_requested_at,t.title FROM runs r JOIN tasks t USING(task_id) WHERE r.run_id=?',
  ).get(runId) as { task_id: string; title: string; status: string; cancel_requested_at: string | null } | undefined
  if (!row) throw new OrchError('NOT_FOUND', '找不到这次运行')
  return row
}

// Both entry points attest the human before calling this synchronous command. Only the
// executor can confirm what happened to in-flight work after the stop was requested.
export function requestOperatorRunStop(db: Db, taskId: string, runId: string, cancel: NodeCommands['cancelRun'], now: string) {
  const initial = readOperatorRunStop(db, runId)
  if (initial.task_id !== taskId) throw new OrchError('FORBIDDEN', '这次运行不属于所选任务')
  const result = operatorStopState(initial.status, initial.cancel_requested_at) === 'available'
    ? cancel({ runId, cancelResult: 'unknown', graceMs: 30_000, now }) : undefined
  const current = result ? readOperatorRunStop(db, runId) : initial
  return {
    state: 'stop_requested' as const, run_id: runId, status: current.status,
    terminal: isRunTerminal(current.status),
    skipped_irreversible: result?.skippedIrreversible.length ?? 0,
    pending_decisions: result?.pendingHumanDecisions.length ?? 0,
  }
}

export type OperatorStopReceipt = ReturnType<typeof requestOperatorRunStop>
