// 任务列表：按 created_at DESC, task_id DESC 键集分页；limit 上限 100（规格 8.3 行 637）
import { OrchError } from '../../core/errors.ts'
import { type Db } from '../../infra/sqlite/driver.ts'
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts'
import { withReadTx } from './read-tx.ts'

export const TASKS_LIMIT_MAX = 100

export type TaskFilter = { status?: string | null }

export type TaskPage = {
  rows: unknown[]
  as_of_seq: number
  next_cursor: string | null
}

export function listTasks(db: Db, opts: { limit?: number; cursor?: string | null; filter?: TaskFilter }): TaskPage {
  const limit = opts.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > TASKS_LIMIT_MAX) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + String(TASKS_LIMIT_MAX) + ' 条', { limit })
  const filter: TaskFilter = opts.filter ?? {}
  return withReadTx(db, ({ tx, as_of_seq }) => {
    const params: unknown[] = []
    let where = '1 = 1'
    if (filter.status) { where += ' AND status = ?'; params.push(filter.status) }
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor, 'tasks', filter)
      where += ' AND (created_at < ? OR (created_at = ? AND task_id < ?))'
      params.push(c.last_key, c.last_key, c.last_id)
    }
    const rows = tx.all<Record<string, unknown>>(
      'SELECT task_id, title, workflow_id, workflow_version, session_id, status, display_status, current_run_id, revision, created_at, updated_at '
      + 'FROM tasks WHERE ' + where + ' ORDER BY created_at DESC, task_id DESC LIMIT ?',
      [...params, limit + 1],
    )

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const next = hasMore && last
      ? encodeCursor(makeCursor('tasks', filter, String(last.created_at), String(last.task_id), as_of_seq))
      : null
    return { rows: page, as_of_seq, next_cursor: next }
  })
}
