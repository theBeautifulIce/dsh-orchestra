import { OrchError } from '../../core/errors.ts'
import { appendEvent } from '../../infra/db/ledger.ts'
import { withTx, type Db } from '../../infra/sqlite/driver.ts'
import { assertOperationId, requestHashOf, runIdempotentCommand } from './idempotency.ts'

export type SetTaskArchive = { task_id: string; archived: boolean; expected_archived_at: string | null; operation_id: string }

export function setTaskArchive(db: Db, input: SetTaskArchive, actor: string, now: string) {
  const { task_id, archived, expected_archived_at, operation_id } = input
  const kind = archived ? 'task.archive' : 'task.restore'
  return withTx(db, (tx) => runIdempotentCommand(tx, {
    kind, operationId: assertOperationId(operation_id), requestHash: requestHashOf(kind, { task_id, expected_archived_at, actor }), now,
  }, () => {
    const row = tx.get<{ archived_at: string | null; current_run_id: string | null }>(
      'SELECT archived_at, current_run_id FROM tasks WHERE task_id = ?', [task_id],
    )
    if (!row) throw new OrchError('NOT_FOUND', '没找到这个任务')
    if (row.archived_at !== expected_archived_at) throw new OrchError('STALE_GENERATION', '归档状态已有变化，请刷新')
    const archivedAt = archived ? row.archived_at ?? now : null
    if (archivedAt !== row.archived_at) {
      tx.run('UPDATE tasks SET archived_at = ? WHERE task_id = ?', [archivedAt, task_id])
      appendEvent(tx, { type: archived ? 'task.archived' : 'task.restored', runId: row.current_run_id,
        payload: { task_id, archived_at: archivedAt, actor } })
    }
    return { task_id, archived_at: archivedAt }
  }).result)
}
