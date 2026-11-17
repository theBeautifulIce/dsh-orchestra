import { OrchError } from '../../core/errors.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts'
import { deriveAttention, maxSideEffectLevel, type Attention, type SideEffectLevel } from './attention.ts'
import { withReadTx } from './read-tx.ts'

const TASKS_LIMIT_MAX = 100

export type TaskSummary = {
  task_id: string
  title: string
  workflow_id: string | null
  workflow_version: number | null
  status: string
  display_status: string
  current_run_id: string | null
  session_id: string | null
  run_count: number
  open_decision_count: number
  oldest_open_decision_age_seconds: number | null
  unverified_count: number
  max_side_effect_level: SideEffectLevel | null
  max_heartbeat_age_ms: number | null
  attention: Attention
  attention_reason: string | null
  updated_at: string
}

export type ListTaskParams = {
  status?: string
  attention?: Attention
  query?: string
  limit?: number
  cursor?: string
  now?: number
}

type TaskRow = Record<string, unknown> & {
  task_id: string
  updated_at: string
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function taskSummary(row: TaskRow, now: number): TaskSummary {
  const currentRunStatus = nullableString(row.current_run_status)
  const openDecisionCount = Number(row.open_decision_count ?? 0)
  const unverifiedCount = Number(row.unverified_count ?? 0)
  const orphanedNodeCount = Number(row.orphaned_node_count ?? 0)
  const oldestDecisionAt = nullableString(row.oldest_open_decision_at)
  const oldestDecisionAge = oldestDecisionAt === null
    ? null
    : Math.max(0, Math.floor((now - Date.parse(oldestDecisionAt)) / 1000))
  const heartbeatAt = nullableString(row.oldest_active_heartbeat_at)
  const heartbeatAge = heartbeatAt === null ? null : Math.max(0, now - Date.parse(heartbeatAt))
  const sideEffectLevels = String(row.side_effect_levels ?? '').split(',').filter(Boolean)
  const taskStatus = String(row.status ?? '')
  const attention = deriveAttention({
    openDecisionCount,
    oldestOpenDecisionAgeSeconds: oldestDecisionAge,
    unverifiedCount,
    currentRunStatus,
    orphanedNodeCount,
    taskStatus,
  })

  return {
    task_id: String(row.task_id),
    title: String(row.title ?? ''),
    workflow_id: nullableString(row.workflow_id),
    workflow_version: nullableNumber(row.workflow_version),
    status: taskStatus,
    display_status: String(row.display_status ?? taskStatus),
    current_run_id: nullableString(row.current_run_id),
    session_id: nullableString(row.session_id),
    run_count: Number(row.run_count ?? 0),
    open_decision_count: openDecisionCount,
    oldest_open_decision_age_seconds: oldestDecisionAge,
    unverified_count: unverifiedCount,
    max_side_effect_level: maxSideEffectLevel(sideEffectLevels),
    max_heartbeat_age_ms: heartbeatAge,
    attention: attention.attention,
    attention_reason: attention.attention_reason,
    updated_at: String(row.updated_at),
  }
}

const TASK_SELECT = `SELECT t.task_id, t.title, t.workflow_id, t.workflow_version, t.status, t.display_status,
  t.current_run_id, t.session_id, t.updated_at,
  (SELECT COUNT(*) FROM runs r WHERE r.task_id = t.task_id) AS run_count,
  (SELECT r.status FROM runs r WHERE r.run_id = t.current_run_id) AS current_run_status,
  (SELECT COUNT(*) FROM decisions d WHERE d.run_id = t.current_run_id
    AND d.status IN ('pending','acknowledged','blocked_for_human')) AS open_decision_count,
  (SELECT MIN(d.created_at) FROM decisions d WHERE d.run_id = t.current_run_id
    AND d.status IN ('pending','acknowledged','blocked_for_human')) AS oldest_open_decision_at,
  (SELECT COUNT(*) FROM node_runs n WHERE n.run_id = t.current_run_id
    AND n.side_effect_policy <> 'pure' AND n.side_effect_verified_none <> 1
    AND NOT EXISTS (SELECT 1 FROM unverified_resolutions ur WHERE ur.node_run_id = n.node_run_id)) AS unverified_count,
  (SELECT COUNT(*) FROM node_runs n WHERE n.run_id = t.current_run_id
    AND n.status = 'orphaned' AND n.replacement_node_run_id IS NULL) AS orphaned_node_count,
  (SELECT GROUP_CONCAT(DISTINCT n.side_effect_policy) FROM node_runs n WHERE n.run_id = t.current_run_id) AS side_effect_levels,
  (SELECT MIN(n.heartbeat_at) FROM node_runs n WHERE n.run_id = t.current_run_id
    AND n.heartbeat_at IS NOT NULL AND n.status NOT IN ('done','failed','timeout','abandoned_unverified',
      'failed_with_unverified','orphaned','superseded','cancelled')) AS oldest_active_heartbeat_at
FROM tasks t`

// The CASE ordering mirrors deriveAttention() and attentionWeight(); keep the SQL projection in sync with those display helpers.
const TASK_ATTENTION_CTE = `WITH task_metrics AS (${TASK_SELECT}), task_attention AS (
  SELECT task_metrics.*,
    CASE
      WHEN open_decision_count > 0 THEN 'decision'
      WHEN unverified_count > 0 THEN 'unverified'
      WHEN current_run_status IN ('failed','failed_with_unverified') THEN 'failed'
      WHEN current_run_status = 'orphaned' OR orphaned_node_count > 0 THEN 'orphaned'
      WHEN status = 'running' OR (current_run_status IS NOT NULL AND current_run_status NOT IN
        ('succeeded','succeeded_with_unverified','failed','failed_with_unverified','orphaned','cancelled')) THEN 'running'
      ELSE 'none'
    END AS attention,
    CASE
      WHEN open_decision_count > 0 THEN 6
      WHEN unverified_count > 0 THEN 5
      WHEN current_run_status IN ('failed','failed_with_unverified') THEN 4
      WHEN current_run_status = 'orphaned' OR orphaned_node_count > 0 THEN 3
      WHEN status = 'running' OR (current_run_status IS NOT NULL AND current_run_status NOT IN
        ('succeeded','succeeded_with_unverified','failed','failed_with_unverified','orphaned','cancelled')) THEN 2
      ELSE 1
    END AS attention_weight
  FROM task_metrics
)`

export function listTaskSummaries(db: Db, params: ListTaskParams = {}): { items: TaskSummary[]; next_cursor: string | null; as_of_seq: number } {
  const limit = params.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > TASKS_LIMIT_MAX) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + String(TASKS_LIMIT_MAX) + ' 条', { limit })
  const filter = { status: params.status ?? null, attention: params.attention ?? null, query: params.query ?? null }
  return withReadTx(db, (ctx) => {
    const now = params.now ?? Date.now()
    const where: string[] = []
    const values: unknown[] = []
    if (filter.status) { where.push('status = ?'); values.push(filter.status) }
    if (filter.attention) { where.push('attention = ?'); values.push(filter.attention) }
    if (filter.query) {
      where.push('(instr(lower(title), lower(?)) > 0 OR instr(lower(task_id), lower(?)) > 0)')
      values.push(filter.query, filter.query)
    }
    if (params.cursor) {
      const cursor = decodeCursor(params.cursor, 'tasks', filter)
      const separator = cursor.last_key.indexOf('\t')
      const lastWeight = Number(cursor.last_key.slice(0, separator))
      const lastUpdatedAt = cursor.last_key.slice(separator + 1)
      if (separator < 1 || !Number.isInteger(lastWeight) || lastWeight < 1 || lastWeight > 6 || !lastUpdatedAt) {
        throw new OrchError('CURSOR_EXPIRED', '游标里的任务位置不合法，请重新加载', { task_id: cursor.last_id })
      }
      where.push('(attention_weight < ? OR (attention_weight = ? AND (updated_at < ? OR (updated_at = ? AND task_id < ?))))')
      values.push(lastWeight, lastWeight, lastUpdatedAt, lastUpdatedAt, cursor.last_id)
    }
    const rows = ctx.tx.all<TaskRow & { attention: Attention; attention_weight: number }>(
      TASK_ATTENTION_CTE + ' SELECT * FROM task_attention'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY attention_weight DESC, updated_at DESC, task_id DESC LIMIT ?',
      [...values, limit + 1],
    )
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const items = page.map((row) => taskSummary(row, now))
    const last = page[page.length - 1]
    const nextCursor = hasMore && last
      ? encodeCursor(makeCursor('tasks', filter, `${last.attention_weight}\t${last.updated_at}`, last.task_id, ctx.as_of_seq, now))
      : null
    return { items, next_cursor: nextCursor, as_of_seq: ctx.as_of_seq }
  })
}

export function getTaskSummarySnapshot(db: Db, taskId: string, now = Date.now()): { item: TaskSummary; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<TaskRow>(TASK_SELECT + ' WHERE t.task_id = ?', [taskId])
    if (!row) throw new OrchError('NOT_FOUND', '没找到这个任务', { task_id: taskId })
    return { item: taskSummary(row, now), as_of_seq: ctx.as_of_seq }
  })
}

export function getTaskSummary(db: Db, taskId: string, now = Date.now()): TaskSummary {
  return getTaskSummarySnapshot(db, taskId, now).item
}
