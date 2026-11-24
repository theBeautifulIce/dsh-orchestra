import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { requestHashOf } from './commands/idempotency.ts'
import type { ReadTx } from './queries/read-tx.ts'

export const draftReferenceSchema = z.strictObject({
  plan_id: z.uuidv7(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/u),
})
export type DraftReference = z.infer<typeof draftReferenceSchema>
export type DraftRevision = { reference: DraftReference; requestHash: string }

type EndedDraft = { successor_id: string | null; request_hash: string }

export function readDraftEnding(tx: ReadTx, reference: DraftReference, actor: string): EndedDraft | undefined {
  const row = tx.get<{ created_by: string; content_hash: string }>(
    'SELECT created_by, content_hash FROM task_plans WHERE plan_id=?', [reference.plan_id])
  if (!row || row.created_by !== actor) throw new OrchError('NOT_FOUND', '找不到这份计划')
  if (row.content_hash !== reference.content_hash) throw new OrchError('CONFIRMATION_MISMATCH', '计划版本已变化，请重新读取')
  return tx.get<EndedDraft>('SELECT successor_id, request_hash FROM task_plan_draft_end WHERE plan_id=?', [reference.plan_id])
}

export function assertDraftActive(tx: ReadTx, reference: DraftReference, actor: string): void {
  if (readDraftEnding(tx, reference, actor)) throw new OrchError('CONFIRMATION_MISMATCH', '这份计划已调整或放弃，请读取当前计划')
  const started = tx.get(`SELECT 1 FROM task_plans p JOIN start_run_operations o
    ON o.operation_id=p.launch_operation_id WHERE p.plan_id=?`, [reference.plan_id])
  if (started) throw new OrchError('CONFIRMATION_MISMATCH', '这份计划已经启动，请打开本次运行')
}

/** Closing a draft and inserting its successor share the caller's write transaction. */
export function finishDraftRevision(tx: Tx, revision: DraftRevision | undefined, successorId: string, actor: string, now: string): void {
  if (!revision) return
  assertDraftActive(tx, revision.reference, actor)
  const successor = tx.get<{ created_by: string }>('SELECT created_by FROM task_plans WHERE plan_id=?', [successorId])
  if (!successor || successor.created_by !== actor) throw new OrchError('CONFIRMATION_MISMATCH', '后续计划的归属无效')
  tx.run('INSERT INTO task_plan_draft_end(plan_id, successor_id, request_hash, ended_at) VALUES (?,?,?,?)',
    [revision.reference.plan_id, successorId, revision.requestHash, now])
  tx.run('UPDATE chat_task_receipts SET plan_id=? WHERE plan_id=?', [successorId, revision.reference.plan_id])
  tx.run(`UPDATE chat_planning_progress SET plan_id=?,
    title=(SELECT json_extract(proposal_json,'$.title') FROM task_plans WHERE plan_id=?),
    stage=CASE WHEN (SELECT json_extract(quality_json,'$.ready') FROM task_plans WHERE plan_id=?)=1 THEN 'approval' ELSE 'blocked' END,
    updated_ms=? WHERE plan_id=? AND stage<>'started'`,
    [successorId, successorId, successorId, Date.parse(now), revision.reference.plan_id])
  appendEvent(tx, { type: 'task_plan.revised', payload: { plan_id: revision.reference.plan_id, successor_id: successorId } })
}

export function discardDraft(db: Db, reference: DraftReference, actor: string, now: string) {
  return withTx(db, tx => {
    const hash = requestHashOf('task_plan.discard', reference)
    const end = readDraftEnding(tx, reference, actor)
    if (end?.successor_id === null && end.request_hash === hash) return { plan_id: reference.plan_id, discarded: true, replayed: true }
    assertDraftActive(tx, reference, actor)
    tx.run('INSERT INTO task_plan_draft_end(plan_id, successor_id, request_hash, ended_at) VALUES (?,NULL,?,?)',
      [reference.plan_id, hash, now])
    tx.run("UPDATE chat_planning_progress SET stage='cancelled',updated_ms=? WHERE plan_id=? AND stage<>'started'",
      [Date.parse(now), reference.plan_id])
    appendEvent(tx, { type: 'task_plan.discarded', payload: { plan_id: reference.plan_id } })
    return { plan_id: reference.plan_id, discarded: true, replayed: false }
  })
}
