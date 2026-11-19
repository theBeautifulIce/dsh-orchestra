import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import { taskId as newTaskId, uuidv7 } from '../core/ids.ts'
import type { TaskTriggerCreate, TaskTriggerOccurrence, TaskTriggerView } from '../core/task-trigger.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { UNVERIFIED_EFFECT } from '../infra/db/unverified-effects.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand, UUID_V7_RE } from './commands/idempotency.ts'
import { startTriggeredRunInTx } from './commands/start-run.ts'
import { withReadTx } from './queries/read-tx.ts'
import type { Autonomy } from './runs.ts'
import type { WorkflowCatalog } from './workflows.ts'

const ID = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:/-]+$/)
const OPERATION = z.string().regex(UUID_V7_RE)
const CREATE_FIELDS = {
  operation_id: OPERATION, title: z.string().trim().min(1).max(200), workflow_id: ID, workflow_version: ID,
  autonomy: z.enum(['autonomous', 'assisted', 'supervised']).optional(),
}
export const taskTriggerCreateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...CREATE_FIELDS, kind: z.literal('scheduled'), daily_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), time_zone: z.string().min(1).max(100) }),
  z.strictObject({ ...CREATE_FIELDS, kind: z.literal('event'), event_type: ID }),
])
export const taskTriggerEnabledSchema = z.strictObject({
  operation_id: OPERATION, trigger_id: ID, expected_revision: z.number().int().positive(), enabled: z.boolean(),
})
export const taskTriggerEventSchema = z.strictObject({ event_id: ID, event_type: ID })

type TriggerEnabled = z.infer<typeof taskTriggerEnabledSchema>
type TriggerEvent = z.infer<typeof taskTriggerEventSchema>
type TriggerRow = Omit<TaskTriggerView, 'enabled'> & { enabled: number; autonomy: Autonomy; archived_at: string | null; run_status: string | null }
const MAX_RULES = 100
const DUE_PAGE = 16
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const DAILY_TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const TERMINAL_RUN = new Set(['succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'orphaned', 'cancelled'])
const RULE_SELECT = `SELECT a.trigger_id,a.task_id,a.workflow_id,a.workflow_version,a.kind,a.enabled,a.revision,a.daily_time,a.time_zone,
 a.event_type,a.next_fire_at,a.last_fired_at,a.created_at,a.updated_at,t.title,t.autonomy,t.archived_at,r.status AS run_status
 FROM task_triggers a JOIN tasks t ON t.task_id = a.task_id LEFT JOIN runs r ON r.run_id = t.current_run_id`

/** 触发执行就绪态：规则已配置 / 触发已发生 / 执行器未就绪 / 运行已派发 */
export type TriggerExecutionState = 'configured' | 'fired' | 'executor_not_ready' | 'dispatched'
export type TaskTriggerReadiness = {
  state: TriggerExecutionState
  reason: string | null
  run_id: string | null
  fired_at: string | null
  updated_at: string | null
}
export type TaskTriggerExecutionRow = TaskTriggerReadiness & { trigger_id: string; occurrence_key: string }
type TriggerView = TaskTriggerView & { readiness: TaskTriggerReadiness }
type StateReader = { get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined }
const RULE_STATE_KEY = ''
const STATE_SELECT = 'SELECT trigger_id, occurrence_key, run_id, state, reason, fired_at, updated_at FROM task_trigger_execution_state'

function view(tx: StateReader, { enabled, autonomy: _autonomy, archived_at: _archive, run_status: _run, ...row }: TriggerRow): TriggerView {
  return { ...row, enabled: enabled === 1, readiness: readinessOf(tx, row.trigger_id) }
}

/** 先改后插：状态迁移幂等，重放同一个触发不会多出一行 */
function writeState(tx: Tx, next: {
  trigger_id: string; occurrence_key: string; state: TriggerExecutionState; reason: string | null
  run_id: string | null; fired_at: string | null; now: string
}): void {
  const changed = tx.run(
    'UPDATE task_trigger_execution_state SET state = ?, reason = ?, run_id = ?, fired_at = COALESCE(?, fired_at), updated_at = ? '
    + 'WHERE trigger_id = ? AND occurrence_key = ?',
    [next.state, next.reason, next.run_id, next.fired_at, next.now, next.trigger_id, next.occurrence_key],
  )
  if (changed.changes === 0) {
    tx.run('INSERT INTO task_trigger_execution_state (trigger_id, occurrence_key, run_id, state, reason, fired_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
    [next.trigger_id, next.occurrence_key, next.run_id, next.state, next.reason, next.fired_at, next.now])
  }
}

function readState(tx: StateReader, triggerId: string, occurrenceKey: string): TaskTriggerExecutionRow | undefined {
  return tx.get<TaskTriggerExecutionRow>(STATE_SELECT + ' WHERE trigger_id = ? AND occurrence_key = ?', [triggerId, occurrenceKey])
}

function readinessOf(tx: StateReader, triggerId: string): TaskTriggerReadiness {
  const row = readState(tx, triggerId, RULE_STATE_KEY)
  if (!row) return { state: 'configured', reason: null, run_id: null, fired_at: null, updated_at: null }
  return { state: row.state, reason: row.reason, run_id: row.run_id, fired_at: row.fired_at, updated_at: row.updated_at }
}

function loadRule(tx: Pick<Tx, 'get'>, ruleId: string): TriggerRow {
  const row = tx.get<TriggerRow>(RULE_SELECT + ' WHERE a.trigger_id = ?', [ruleId])
  if (!row) throw new OrchError('NOT_FOUND', '找不到这条任务触发规则')
  return row
}

function localFormatter(timeZone: string): Intl.DateTimeFormat {
  // Offset strings are accepted by some Intl runtimes but do not carry DST rules.
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,99}$/.test(timeZone)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '时区须为 IANA 名称，例如 Asia/Shanghai')
  }
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
  } catch {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '无法识别此 IANA 时区')
  }
}

function wallMinute(formatter: Intl.DateTimeFormat, at: number): number {
  const parts = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, Number(value)]))
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!)
}

/** A wall-clock minute occurs once per local day. In a fold use the first instant, and in a gap skip that day. */
export function nextDailyFire(dailyTime: string, timeZone: string, after: string): string {
  const start = Date.parse(after)
  if (!DAILY_TIME.test(dailyTime) || !Number.isFinite(start)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '每日时间或计算起点无效')
  }
  const formatter = localFormatter(timeZone)
  const [hour, minute] = dailyTime.split(':').map(Number)
  const localDay = Math.floor(wallMinute(formatter, start) / DAY_MS) * DAY_MS
  for (let day = 0; day < 4; day += 1) {
    const wall = localDay + day * DAY_MS + hour! * HOUR_MS + minute! * 60_000
    const candidateOffsets = [wall - DAY_MS, wall, wall + DAY_MS].map((near) => wallMinute(formatter, near) - near)
    const first = candidateOffsets.map((offset) => wall - offset)
      .filter((instant) => wallMinute(formatter, instant) === wall)
      .sort((left, right) => left - right)[0]
    if (first !== undefined && first > start) return new Date(first).toISOString()
  }
  throw new OrchError('PAYLOAD_SCHEMA_INVALID', '无法计算下一次触发时间')
}

function publishedReusable(tx: Pick<Tx, 'get'>, workflowId: string, version: string): boolean {
  return tx.get(
    `SELECT 1 FROM workflows w JOIN workflow_versions v ON v.workflow_id = w.workflow_id
    WHERE w.workflow_id = ? AND v.version = ? AND w.scope = 'reusable' AND w.status = 'active' AND v.published_by IS NOT NULL`,
    [workflowId, version],
  ) !== undefined
}

export type TaskTriggerHostOptions = {
  /** 宿主是否已装配可信的节点规格解析器：没装配就只能停在"触发已发生"，不能冒充运行成功 */
  executorReady?: () => boolean
}

export function createTaskTriggerHost(db: Db, catalog: WorkflowCatalog, options?: TaskTriggerHostOptions) {
  const executorReady = options?.executorReady ?? (() => false)
  return {
    list(taskId?: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => ({
        items: tx.all<TriggerRow>(RULE_SELECT + (taskId ? ' WHERE a.task_id = ?' : '')
          + ' ORDER BY a.created_at DESC, a.trigger_id DESC LIMIT ?', taskId ? [taskId, MAX_RULES] : [MAX_RULES]).map((row) => view(tx, row)),
        as_of_seq,
      }))
    },
    create(input: TaskTriggerCreate, actor: string, now: string) {
      return withTx(db, (tx) => runIdempotentCommand(tx, {
        kind: 'task.trigger_create', operationId: input.operation_id, requestHash: requestHashOf('task.trigger_create', { input, actor }), now,
      }, () => {
        if ((tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM task_triggers')?.count ?? 0) >= MAX_RULES) {
          throw new OrchError('RANGE_TOO_LARGE', '一个服务最多登记 100 条触发规则')
        }
        if (!publishedReusable(tx, input.workflow_id, input.workflow_version)) {
          throw new OrchError('WORKFLOW_NOT_PUBLISHED', '触发规则需要固定可复用的已发布流程版本')
        }
        catalog.get(input.workflow_id, input.workflow_version)
        const taskId = newTaskId()
        const ruleId = 'trg_' + uuidv7()
        const next = input.kind === 'scheduled' ? nextDailyFire(input.daily_time, input.time_zone, now) : null
        tx.run(`INSERT INTO tasks (task_id, title, status, workflow_id, workflow_version, autonomy, trigger_kind, created_at, updated_at)
          VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
        [taskId, input.title, input.workflow_id, input.workflow_version, input.autonomy ?? 'assisted', input.kind, now, now])
        tx.run(`INSERT INTO task_triggers (trigger_id,task_id,workflow_id,workflow_version,kind,daily_time,time_zone,event_type,next_fire_at,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
          ruleId, taskId, input.workflow_id, input.workflow_version, input.kind,
          input.kind === 'scheduled' ? input.daily_time : null, input.kind === 'scheduled' ? input.time_zone : null,
          input.kind === 'event' ? input.event_type : null, next, actor, now, now,
        ])
        writeState(tx, {
          trigger_id: ruleId, occurrence_key: RULE_STATE_KEY,
          state: executorReady() ? 'configured' : 'executor_not_ready',
          reason: executorReady() ? null : 'executor_not_ready',
          run_id: null, fired_at: null, now,
        })
        appendEvent(tx, { type: 'task.trigger_created', payload: { task_id: taskId, trigger_id: ruleId, kind: input.kind, actor } })
        return view(tx, loadRule(tx, ruleId))
      }).result)
    },
    setEnabled(input: TriggerEnabled, actor: string, now: string) {
      return withTx(db, (tx) => runIdempotentCommand(tx, {
        kind: 'task.trigger_set_enabled', operationId: input.operation_id, requestHash: requestHashOf('task.trigger_set_enabled', { input, actor }), now,
      }, () => {
        const row = loadRule(tx, input.trigger_id)
        if (row.revision !== input.expected_revision) throw new OrchError('STALE_GENERATION', '触发规则已变化，请刷新')
        if (row.enabled === Number(input.enabled)) return view(tx, row)
        const next = input.enabled && row.kind === 'scheduled' ? nextDailyFire(row.daily_time!, row.time_zone!, now) : null
        tx.run('UPDATE task_triggers SET enabled = ?, revision = revision + 1, next_fire_at = ?, updated_at = ? WHERE trigger_id = ?',
          [Number(input.enabled), next, now, row.trigger_id])
        writeState(tx, {
          trigger_id: row.trigger_id, occurrence_key: RULE_STATE_KEY,
          state: executorReady() ? 'configured' : 'executor_not_ready',
          reason: executorReady() ? null : 'executor_not_ready',
          run_id: null, fired_at: null, now,
        })
        appendEvent(tx, { type: input.enabled ? 'task.trigger_enabled' : 'task.trigger_paused',
          payload: { task_id: row.task_id, trigger_id: row.trigger_id, actor } })
        return view(tx, loadRule(tx, row.trigger_id))
      }).result)
    },
    emit(input: TriggerEvent, actor: string, now: string) {
      return withTx(db, (tx) => {
        const existing = tx.get<{ event_type: string; received_by: string }>('SELECT event_type, received_by FROM task_trigger_events WHERE event_id = ?', [input.event_id])
        if (existing) {
          if (existing.event_type !== input.event_type || existing.received_by !== actor) {
            throw new OrchError('OPERATION_ID_CONFLICT', '事件编号已经用于另一种事件或接收主体')
          }
          const items = tx.all<TaskTriggerOccurrence>(
            'SELECT o.trigger_id,a.task_id,o.due_at,o.run_id,o.status,o.reason FROM task_trigger_occurrences o '
            + 'JOIN task_triggers a ON a.trigger_id = o.trigger_id WHERE o.source_event_id = ? ORDER BY o.trigger_id', [input.event_id],
          )
          return { items, replayed: true }
        }
        tx.run('INSERT INTO task_trigger_events (event_id,event_type,received_at,received_by) VALUES (?,?,?,?)', [input.event_id, input.event_type, now, actor])
        const matched = tx.all<TriggerRow>(RULE_SELECT + " WHERE a.kind = 'event' AND a.enabled = 1 AND a.event_type = ? ORDER BY a.trigger_id", [input.event_type])
        const items = matched.map((row) => fire(tx, catalog, row, input.event_id, now, now, input.event_id, executorReady()))
        return { items, replayed: false }
      })
    },
    tick(now: string, onError: (error: unknown) => void) {
      const due = db.raw.prepare(
        "SELECT trigger_id FROM task_triggers WHERE kind = 'scheduled' AND enabled = 1 AND next_fire_at <= ? ORDER BY next_fire_at,trigger_id LIMIT ?",
      ).all(now, MAX_RULES) as { trigger_id: string }[]
      let advanced = 0
      for (const row of due) {
        if (advanced >= DUE_PAGE) break
        try {
          withTx(db, (tx) => {
            const active = loadRule(tx, row.trigger_id)
            if (active.enabled !== 1 || active.next_fire_at === null || active.next_fire_at > now) return
            const next = nextDailyFire(active.daily_time!, active.time_zone!, now)
            fire(tx, catalog, active, active.next_fire_at, active.next_fire_at, now, null, executorReady())
            // Downtime can leave one overdue occurrence. Move forward from now instead of replaying a backlog.
            tx.run('UPDATE task_triggers SET next_fire_at = ? WHERE trigger_id = ?', [next, active.trigger_id])
          })
          advanced += 1
        } catch (error) {
          onError(error)
        }
      }
    },
  }
}

function fire(tx: Tx, catalog: WorkflowCatalog, row: TriggerRow, occurrenceKey: string, dueAt: string, now: string, eventId: string | null, executorReady: boolean): TaskTriggerOccurrence {
  let reason: TaskTriggerOccurrence['reason'] = null
  if (row.archived_at !== null) reason = 'task_archived'
  else if (row.run_status !== null && !TERMINAL_RUN.has(row.run_status)) reason = 'previous_run_active'
  else if (tx.get(`SELECT 1 FROM node_runs n JOIN runs r ON r.run_id = n.run_id WHERE r.task_id = ? AND ${UNVERIFIED_EFFECT} LIMIT 1`, [row.task_id])) reason = 'unresolved_effects'
  else if (!publishedReusable(tx, row.workflow_id, row.workflow_version)) reason = 'workflow_inactive'

  const run = reason === null ? startTriggeredRunInTx(tx, catalog, row.trigger_id, {
    workflowId: row.workflow_id, workflowVersion: row.workflow_version, taskTitle: row.title,
    triggerKind: row.kind, autonomy: row.autonomy, operationId: uuidv7(), now,
  }) : null
  const occurrence: TaskTriggerOccurrence = {
    trigger_id: row.trigger_id, task_id: row.task_id, due_at: dueAt, run_id: run?.run_id ?? null, status: run ? 'started' : 'skipped', reason,
  }
  tx.run(`INSERT INTO task_trigger_occurrences (trigger_id,occurrence_key,source_event_id,due_at,run_id,status,reason,created_at)
    VALUES (?,?,?,?,?,?,?,?)`, [row.trigger_id, occurrenceKey, eventId, dueAt, occurrence.run_id, occurrence.status, reason, now])
  if (run) tx.run('UPDATE task_triggers SET last_fired_at = ?, updated_at = ? WHERE trigger_id = ?', [now, now, row.trigger_id])
  // 触发已发生不等于运行已派发：宿主没装配解析器时明确记成 executor_not_ready
  writeState(tx, {
    trigger_id: row.trigger_id, occurrence_key: occurrenceKey, state: 'fired', reason,
    run_id: occurrence.run_id, fired_at: now, now,
  })
  writeState(tx, {
    trigger_id: row.trigger_id, occurrence_key: RULE_STATE_KEY,
    state: reason === null && !executorReady ? 'executor_not_ready' : 'fired',
    reason: reason !== null ? reason : (executorReady ? null : 'executor_not_ready'),
    run_id: occurrence.run_id, fired_at: now, now,
  })
  appendEvent(tx, { type: run ? 'task.trigger_fired' : 'task.trigger_skipped', runId: occurrence.run_id, payload: occurrence })
  return occurrence
}

/** 派发成功：把这次触发和规则当前就绪态都推进到"运行已派发" */
export function markTriggerDispatched(db: Db, runId: string, now: string): void {
  withTx(db, (tx) => {
    const occurrence = tx.get<{ trigger_id: string; occurrence_key: string }>(
      'SELECT trigger_id, occurrence_key FROM task_trigger_occurrences WHERE run_id = ?', [runId])
    if (!occurrence) return
    writeState(tx, {
      trigger_id: occurrence.trigger_id, occurrence_key: occurrence.occurrence_key,
      state: 'dispatched', reason: null, run_id: runId, fired_at: null, now,
    })
    writeState(tx, {
      trigger_id: occurrence.trigger_id, occurrence_key: RULE_STATE_KEY,
      state: 'dispatched', reason: null, run_id: runId, fired_at: null, now,
    })
  })
}

/** 解析没成功：状态停在"触发已发生"，原因写进就绪态，不让排障只能翻日志 */
export function markTriggerResolveFailed(db: Db, runId: string, reason: string, now: string): void {
  withTx(db, (tx) => {
    const occurrence = tx.get<{ trigger_id: string; occurrence_key: string }>(
      'SELECT trigger_id, occurrence_key FROM task_trigger_occurrences WHERE run_id = ?', [runId])
    if (!occurrence) return
    writeState(tx, {
      trigger_id: occurrence.trigger_id, occurrence_key: occurrence.occurrence_key,
      state: 'fired', reason, run_id: runId, fired_at: null, now,
    })
    writeState(tx, {
      trigger_id: occurrence.trigger_id, occurrence_key: RULE_STATE_KEY,
      state: 'fired', reason, run_id: runId, fired_at: null, now,
    })
  })
}

export type TaskTriggerExecutionFilter = { trigger_id?: string; run_id?: string; state?: TriggerExecutionState }

/** 就绪态读取入口：规则当前四态与每次触发的历史都能查，事件与运行都能当筛选条件 */
export function listTriggerExecutionStates(db: Db, filter?: TaskTriggerExecutionFilter): TaskTriggerExecutionRow[] {
  return withReadTx(db, ({ tx }) => {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter?.trigger_id) { clauses.push('trigger_id = ?'); params.push(filter.trigger_id) }
    if (filter?.run_id) { clauses.push('run_id = ?'); params.push(filter.run_id) }
    if (filter?.state) { clauses.push('state = ?'); params.push(filter.state) }
    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : ''
    return tx.all<TaskTriggerExecutionRow>(STATE_SELECT + where + ' ORDER BY trigger_id, occurrence_key', params)
  })
}

export type TaskTriggerHost = ReturnType<typeof createTaskTriggerHost>
