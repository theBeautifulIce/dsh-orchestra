import { OrchError } from '../../core/errors.ts'
import { readReleaseGateCard, type ReleaseGateCardState } from '../release-workflow.ts'
import { TASK_LANES, type TaskLane, type TaskOrigin } from '../../core/task-workspace.ts'
import type { Autonomy } from '../runs.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { UNVERIFIED_EFFECT_OCCURRED } from '../../infra/db/unverified-effects.ts'
import { reviewFilesForDoneAttempt } from '../review-manifest.ts'
import { decodeCursor, encodeCursor, makeCursor } from './cursor.ts'
import { attentionWeight, deriveAttention, maxSideEffectLevel, DELIVERY_ACCEPTANCE, type Attention, type DeliveryAcceptance, type SideEffectLevel } from './attention.ts'
import { withReadTx, type ReadTx } from './read-tx.ts'

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
  /** 当前根运行树里可办理的成果验收（留验）数量。 */
  delivery_review_count?: number
  /** 待授权、待人工判断或已升级的返工请求数量。 */
  rework_count?: number
  unverified_count: number
  /** 当前运行的有效步骤数与已完成数：任务行直接给进度（T10）。 */
  step_total?: number
  step_done?: number
  max_side_effect_level: SideEffectLevel | null
  max_heartbeat_age_ms: number | null
  attention: Attention
  attention_reason: string | null
  updated_at: string
  archived_at: string | null
  trigger_kind: TaskOrigin | null
  next_trigger_at?: string | null
  trigger_enabled?: boolean | null
  autonomy: Autonomy
  lane?: TaskLane
  current_run_status: string | null
  delivery_acceptance?: DeliveryAcceptance
  goal_met?: boolean
  /** 当前操作者最能推进这件事的那一个动作（T01/T02/T10）。 */
  next_action?: TaskNextAction
}

/** 验收结论取值由 SQL 汇总；脏数据一律回落到 not_applicable，视图不因它崩。 */
function deliveryAcceptanceOf(value: unknown): DeliveryAcceptance {
  const raw = value === null || value === undefined ? 'not_applicable' : String(value)
  return (DELIVERY_ACCEPTANCE as readonly string[]).includes(raw)
    ? (raw as DeliveryAcceptance)
    : 'not_applicable'
}

export type ListTaskParams = {
  /** 只由已认证的服务请求传入。 */
  actor?: string
  status?: string
  attention?: Attention
  query?: string
  lane?: TaskLane
  trigger_kind?: TaskOrigin | 'unknown'
  archived?: boolean
  updated_from?: string
  updated_before?: string
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
  const deliveryReviewCount = Number(row.delivery_review_count ?? 0)
  const reworkCount = Number(row.rework_count ?? 0)
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
  const deliveryAcceptance = deliveryAcceptanceOf(row.delivery_acceptance)
  // 有已确认计划时，目标达成看验收汇总（必需交付项必须全部 passed），不能只看 run 终态
  const executionSucceeded = taskStatus === 'succeeded' || taskStatus === 'succeeded_with_unverified'
  const goalMet = executionSucceeded && (deliveryAcceptance === 'not_applicable' || deliveryAcceptance === 'passed')
  const attention = deriveAttention({
    openDecisionCount,
    oldestOpenDecisionAgeSeconds: oldestDecisionAge,
    deliveryReviewCount,
    reworkCount,
    unverifiedCount,
    currentRunStatus,
    orphanedNodeCount,
    taskStatus,
    deliveryAcceptance,
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
    delivery_review_count: deliveryReviewCount,
    rework_count: reworkCount,
    unverified_count: unverifiedCount,
    step_total: Number(row.step_total ?? 0),
    step_done: Number(row.step_done ?? 0),
    max_side_effect_level: maxSideEffectLevel(sideEffectLevels),
    max_heartbeat_age_ms: heartbeatAge,
    attention: attention.attention,
    attention_reason: attention.attention_reason,
    updated_at: String(row.updated_at),
    archived_at: nullableString(row.archived_at),
    trigger_kind: row.trigger_kind as TaskOrigin | null,
    next_trigger_at: nullableString(row.next_trigger_at),
    trigger_enabled: row.trigger_enabled === null || row.trigger_enabled === undefined ? null : row.trigger_enabled === 1,
    autonomy: row.autonomy as Autonomy,
    lane: row.lane as TaskLane,
    current_run_status: currentRunStatus,
    delivery_acceptance: deliveryAcceptance,
    goal_met: goalMet,
  }
}

// 当前根运行的整棵运行树：子流程的人工事项也要算在父任务上（T02）。
const CURRENT_TREE = `(WITH RECURSIVE tree(run_id) AS (
    SELECT t.current_run_id WHERE t.current_run_id IS NOT NULL
    UNION SELECT c.run_id FROM tree CROSS JOIN runs c ON c.parent_run_id = tree.run_id AND c.task_id = t.task_id
  ) SELECT run_id FROM tree)`
const OPEN_DECISIONS = `FROM human_decision_inbox d WHERE d.run_id IN ${CURRENT_TREE}`
// 与实际办理入口一致：当前有效尝试和本轮返工成果都要进入待验收计数。
const DELIVERY_REVIEWS = `FROM (
  SELECT hn.node_run_id FROM delivery_review_holds h
    JOIN runs hr ON hr.run_id=h.run_id AND hr.status='running' AND hr.cancel_requested_at IS NULL
    JOIN node_runs hn ON hn.run_id=h.run_id AND hn.node_id=h.node_id
      AND hn.replacement_node_run_id IS NULL AND hn.status='done'
    WHERE (h.status='held' OR h.node_run_id<>hn.node_run_id) AND h.run_id IN ${CURRENT_TREE}
      AND hn.attempt=(SELECT MAX(m.attempt) FROM node_runs m WHERE m.run_id=hn.run_id
        AND m.node_id=hn.node_id AND m.replacement_node_run_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM rework_requests rq WHERE rq.run_id=h.run_id
        AND (rq.target_node_run_id=hn.node_run_id OR rq.new_node_run_id=hn.node_run_id)
        AND rq.status NOT IN ('closed','declined','cancelled'))
  UNION
  SELECT rn.node_run_id FROM rework_requests rq
    JOIN runs rr ON rr.run_id=rq.run_id AND rr.status='running' AND rr.cancel_requested_at IS NULL
    JOIN rework_attempts rw ON rw.request_id=rq.request_id AND rw.round_no=rq.round_no AND rw.status='awaiting_review'
    JOIN node_runs rn ON rn.node_run_id=rq.new_node_run_id AND rn.node_run_id=rw.new_node_run_id
      AND rn.run_id=rq.run_id AND rn.status='done' AND rn.replacement_node_run_id IS NULL
    WHERE rq.status='awaiting_review' AND rq.run_id IN ${CURRENT_TREE}
  )`
const REWORK_ITEMS = `FROM rework_requests q
  JOIN runs qr ON qr.run_id=q.run_id AND qr.status='running' AND qr.cancel_requested_at IS NULL
  WHERE q.status IN ('proposed','needs_human_approval','escalated')
  AND q.run_id IN ${CURRENT_TREE}`
const UNVERIFIED_NODES = `FROM node_runs n WHERE n.run_id IN ${CURRENT_TREE}
  AND ${UNVERIFIED_EFFECT_OCCURRED}`
const ORPHANED_NODES = `FROM node_runs n WHERE n.run_id IN ${CURRENT_TREE}
  AND n.status = 'orphaned' AND n.replacement_node_run_id IS NULL`
const RUN_ACCEPTANCE = `FROM run_acceptance_results a WHERE a.run_id = t.current_run_id`
const CURRENT_RUN_JOINS = `LEFT JOIN runs r ON r.run_id = t.current_run_id
  LEFT JOIN task_triggers tr ON tr.task_id = t.task_id`
// Hydrate only the materialized page while keeping the rank, counts and event waterline in the same read snapshot.
const TASK_SUMMARY_SELECT = `SELECT t.task_id, t.title, t.workflow_id, t.workflow_version, t.status, t.display_status,
  t.current_run_id, t.session_id, t.updated_at, t.archived_at, t.trigger_kind, t.autonomy,
  tr.next_fire_at AS next_trigger_at, tr.enabled AS trigger_enabled, r.status AS current_run_status, p.lane, p.sort_at, p.sort_weight,
  (SELECT COUNT(*) FROM runs r WHERE r.task_id = t.task_id AND r.parent_run_id IS NULL) AS run_count,
  CASE
    WHEN EXISTS (SELECT 1 ${RUN_ACCEPTANCE} AND a.outcome = 'failed') THEN 'failed'
    WHEN EXISTS (SELECT 1 ${RUN_ACCEPTANCE} AND (a.outcome = 'unverifiable' OR (a.kind='chat/text_result' AND a.outcome='passed'
      AND (CASE WHEN json_valid(a.evidence_json) THEN json_extract(a.evidence_json,'$.evidence.publication') END IS NOT 'orchestra.chat-text.v1')))) THEN 'unverifiable'
    WHEN EXISTS (SELECT 1 ${RUN_ACCEPTANCE}) THEN 'passed'
    WHEN EXISTS (SELECT 1 FROM start_run_operations o JOIN task_plans plan
      ON plan.launch_operation_id = o.operation_id WHERE o.task_id = t.task_id AND o.run_id = t.current_run_id) THEN 'pending'
    ELSE 'not_applicable'
  END AS delivery_acceptance,
  (SELECT COUNT(*) ${OPEN_DECISIONS}) AS open_decision_count,
  (SELECT MIN(d.created_at) ${OPEN_DECISIONS}) AS oldest_open_decision_at,
  (SELECT COUNT(*) ${DELIVERY_REVIEWS}) AS delivery_review_count,
  (SELECT COUNT(*) ${REWORK_ITEMS}) AS rework_count,
  (SELECT COUNT(*) ${UNVERIFIED_NODES}) AS unverified_count,
  (SELECT COUNT(*) FROM node_runs n WHERE n.run_id = t.current_run_id AND n.replacement_node_run_id IS NULL
    AND n.attempt = (SELECT MAX(m.attempt) FROM node_runs m WHERE m.run_id = n.run_id AND m.node_id = n.node_id
      AND m.replacement_node_run_id IS NULL)) AS step_total,
  (SELECT COUNT(*) FROM node_runs n WHERE n.run_id = t.current_run_id AND n.status = 'done'
    AND n.replacement_node_run_id IS NULL
    AND n.attempt = (SELECT MAX(m.attempt) FROM node_runs m WHERE m.run_id = n.run_id AND m.node_id = n.node_id
      AND m.replacement_node_run_id IS NULL)) AS step_done,
  (SELECT COUNT(*) ${ORPHANED_NODES}) AS orphaned_node_count,
  (SELECT GROUP_CONCAT(DISTINCT n.side_effect_policy) FROM node_runs n WHERE n.run_id = t.current_run_id) AS side_effect_levels,
  (SELECT MIN(n.heartbeat_at) FROM node_runs n WHERE n.run_id = t.current_run_id
    AND n.heartbeat_at IS NOT NULL AND n.status NOT IN ('done','failed','timeout','abandoned_unverified',
      'failed_with_unverified','orphaned','superseded','cancelled')) AS oldest_active_heartbeat_at
FROM task_page p
JOIN tasks t ON t.task_id = p.task_id ${CURRENT_RUN_JOINS}`
const TASK_PAGE_START = `WITH task_page AS MATERIALIZED (
  SELECT task_id, sort_at, sort_weight, lane FROM task_attention_order WHERE `
const TASK_PAGE_ORDER = ' ORDER BY sort_weight DESC, sort_at DESC, task_id DESC'
const LANE_COUNTS = TASK_LANES.map(({ id }) => `COUNT(*) FILTER (WHERE lane = '${id}') AS ${id}`).join(', ')

export type WorkspaceOverview = {
  lanes: Record<TaskLane, number>
  open_decisions: number
  unverified_effects: number
  release_gate?: ReleaseGateCardState
}

export function getWorkspaceOverview(db: Db, includeRelease = false): { item: WorkspaceOverview; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const lanes: WorkspaceOverview['lanes'] = { upcoming: 0, running: 0, attention: 0, finished: 0 }
    const counts = ctx.tx.all<{ lane: TaskLane; count: number }>(
      'SELECT lane, COUNT(*) AS count FROM task_attention_order WHERE archived = 0 GROUP BY lane')
    for (const row of counts) lanes[row.lane] = row.count
    const decisions = ctx.tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM human_decision_inbox')
    const effects = ctx.tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM node_runs n WHERE ' + UNVERIFIED_EFFECT_OCCURRED)
    return { item: { lanes, open_decisions: decisions?.count ?? 0, unverified_effects: effects?.count ?? 0,
      ...(includeRelease ? { release_gate: readReleaseGateCard(ctx.tx) } : {}) }, as_of_seq: ctx.as_of_seq }
  })
}

export function listTaskSummaries(db: Db, params: ListTaskParams = {}):
{ items: TaskSummary[]; next_cursor: string | null; lane_counts: Partial<Record<TaskLane, number>>; as_of_seq: number } {
  const limit = params.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'limit 要是正整数', { limit })
  if (limit > TASKS_LIMIT_MAX) throw new OrchError('RANGE_TOO_LARGE', '一次最多要 ' + String(TASKS_LIMIT_MAX) + ' 条', { limit })
  const filter = {
    actor: params.actor ?? null, status: params.status ?? null, attention: params.attention ?? null, query: params.query ?? null,
    lane: params.lane ?? null, trigger_kind: params.trigger_kind ?? null, archived: params.archived === true,
    updated_from: params.updated_from ?? null, updated_before: params.updated_before ?? null,
  }
  return withReadTx(db, (ctx) => {
    const now = params.now ?? Date.now()
    const where = ['archived = ?']
    const values: unknown[] = [filter.archived ? 1 : 0]
    if (filter.status) { where.push('status = ?'); values.push(filter.status) }
    if (filter.attention) { where.push('attention_weight = ?'); values.push(attentionWeight(filter.attention)) }
    if (filter.lane) { where.push('lane = ?'); values.push(filter.lane) }
    if (filter.trigger_kind === 'unknown') where.push('trigger_kind IS NULL')
    else if (filter.trigger_kind) { where.push('trigger_kind = ?'); values.push(filter.trigger_kind) }
    if (filter.updated_from) { where.push('updated_at >= ?'); values.push(filter.updated_from) }
    if (filter.updated_before) { where.push('updated_at < ?'); values.push(filter.updated_before) }
    if (filter.query) {
      where.push(`EXISTS (SELECT 1 FROM tasks search
        WHERE search.task_id = task_attention_order.task_id AND
          (instr(lower(search.title), lower(?)) > 0 OR instr(lower(search.task_id), lower(?)) > 0))`)
      values.push(filter.query, filter.query)
    }
    // 同快照的分列计数：用于看板列头与「未加载」判断，不受本页 limit 影响（T08）。
    const baseWhere = [...where]
    const baseValues = [...values]
    if (params.cursor) {
      const cursor = decodeCursor(params.cursor, 'tasks', filter, now)
      const separator = cursor.last_key.indexOf('\t')
      const lastWeight = Number(cursor.last_key.slice(0, separator))
      const lastUpdatedAt = cursor.last_key.slice(separator + 1)
      if (separator < 1 || !Number.isInteger(lastWeight) || lastWeight < 1 || lastWeight > 6 || !lastUpdatedAt) {
        throw new OrchError('CURSOR_EXPIRED', '游标里的任务位置不合法，请重新加载', { task_id: cursor.last_id })
      }
      where.push('(sort_weight, sort_at, task_id) < (?, ?, ?)')
      values.push(lastWeight, lastUpdatedAt, cursor.last_id)
    }
    const rows = ctx.tx.all<TaskRow & { sort_weight: number; sort_at: string }>(
      TASK_PAGE_START + where.join(' AND ') + TASK_PAGE_ORDER + ' LIMIT ?) '
      + TASK_SUMMARY_SELECT + ' ORDER BY p.sort_weight DESC, p.sort_at DESC, p.task_id DESC',
      [...values, limit + 1],
    )
    const laneCounts: Partial<Record<TaskLane, number>> = {}
    const counts = ctx.tx.get<Record<TaskLane, number>>(
      `SELECT ${LANE_COUNTS} FROM task_attention_order WHERE ${baseWhere.join(' AND ')}`, baseValues,
    )
    for (const { id } of TASK_LANES) if (counts && counts[id] > 0) laneCounts[id] = counts[id]
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const items = attachNextActions(ctx.tx, page.map((row) => taskSummary(row, now)), params.actor, now)
    const last = page[page.length - 1]
    const nextCursor = hasMore && last
      ? encodeCursor(makeCursor('tasks', filter, `${last.sort_weight}\t${last.sort_at}`, last.task_id, ctx.as_of_seq, now))
      : null
    return { items, next_cursor: nextCursor, lane_counts: laneCounts, as_of_seq: ctx.as_of_seq }
  })
}

export type TaskNextAction = {
  kind: 'review' | 'decision' | 'rework' | 'progress'
  /** 一句话说明要办什么，直接进按钮文案。 */
  label: string
  run_id: string | null
  node_id?: string | null
  node_run_id?: string | null
  artifact_id?: string | null
  sha256?: string | null
  file_name?: string | null
  decision_id?: string | null
  request_id?: string | null
}

/** 任务行只给一个最有用的动作；其余运行信息留在详情里（T01/T02/T10）。 */
function attachNextActions(tx: ReadTx, items: TaskSummary[], actor: string | undefined, now: number): TaskSummary[] {
  if (!items.length) return items
  const placeholders = items.map(() => '?').join(',')
  const ids = items.map((item) => item.task_id)
  const at = new Date(now).toISOString()
  const tree = `(WITH RECURSIVE roots(task_id,run_id) AS (
      SELECT task_id,current_run_id FROM tasks WHERE task_id IN (${placeholders}) AND current_run_id IS NOT NULL
      UNION SELECT roots.task_id,c.run_id FROM roots CROSS JOIN runs c
        ON c.parent_run_id=roots.run_id AND c.task_id=roots.task_id
    ) SELECT task_id,run_id FROM roots)`
  type ReviewTarget = {
    task_id: string; run_id: string; node_id: string; node_run_id: string;
    request_id: string | null; review_set_json: string | null; accepted_json: string | null;
    artifact_id: string | null; sha256: string | null; file_name: string | null;
  }
  // Start each lookup from the displayed tasks. SQLite can otherwise start at every
  // historical node, review, or approval and only afterwards filter by these runs.
  const reviews = tx.all<ReviewTarget>(
    `WITH current_tree AS ${tree}, targets AS (
      SELECT t.task_id,h.run_id,hn.node_id,hn.node_run_id,NULL AS request_id,
        CASE WHEN hn.node_run_id=h.node_run_id THEN h.review_set_json END AS review_set_json,
        CASE WHEN hn.node_run_id=h.node_run_id THEN h.accepted_json END AS accepted_json,
        NULL AS artifact_id,NULL AS sha256,NULL AS file_name,h.updated_at
      FROM current_tree t CROSS JOIN delivery_review_holds h ON h.run_id=t.run_id
      JOIN runs r ON r.run_id=h.run_id AND r.status='running' AND r.cancel_requested_at IS NULL
      CROSS JOIN node_runs hn ON hn.run_id=h.run_id AND hn.node_id=h.node_id
        AND hn.replacement_node_run_id IS NULL AND hn.status='done'
      WHERE (h.status='held' OR h.node_run_id<>hn.node_run_id) AND (? IS NULL OR h.owner_actor=?)
        AND hn.attempt=(SELECT MAX(n.attempt) FROM node_runs n
          WHERE n.run_id=hn.run_id AND n.node_id=hn.node_id AND n.replacement_node_run_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM rework_requests q WHERE q.run_id=h.run_id
          AND (q.target_node_run_id=hn.node_run_id OR q.new_node_run_id=hn.node_run_id)
          AND q.status NOT IN ('closed','declined','cancelled'))
      UNION ALL
      SELECT t.task_id,q.run_id,n.node_id,n.node_run_id,q.request_id,
        w.result_manifest_json,w.accepted_files_json,a.artifact_id,a.sha256,c.file_name,q.updated_at
      FROM current_tree t CROSS JOIN rework_requests q ON q.run_id=t.run_id
      JOIN runs r ON r.run_id=q.run_id AND r.status='running' AND r.cancel_requested_at IS NULL
      CROSS JOIN rework_attempts w ON w.request_id=q.request_id AND w.round_no=q.round_no AND w.status='awaiting_review'
      JOIN node_runs n ON n.node_run_id=q.new_node_run_id AND n.node_run_id=w.new_node_run_id
        AND n.run_id=q.run_id AND n.status='done' AND n.replacement_node_run_id IS NULL
      LEFT JOIN artifacts a ON a.artifact_id=w.result_artifact_id AND a.sha256=w.result_artifact_hash AND a.run_id=q.run_id
      LEFT JOIN artifact_contents c ON c.artifact_id=a.artifact_id AND c.node_run_id=n.node_run_id
      WHERE q.status='awaiting_review' AND q.expires_at>? AND (? IS NULL OR q.owner_actor=?)
    ) SELECT * FROM targets ORDER BY updated_at DESC,task_id,node_run_id`,
    [...ids,actor ?? null,actor ?? null,at,actor ?? null,actor ?? null])
  const reviewByTask = new Map<string, TaskNextAction>()
  for (const target of reviews) {
    if (reviewByTask.has(target.task_id)) continue
    let file = pendingFile(target.review_set_json, target.accepted_json)
    if (!target.request_id && target.review_set_json === null) {
      try {
        const files = reviewFilesForDoneAttempt(tx, target.run_id, target.node_run_id, target.node_id, at, null)
        file = pendingFile(JSON.stringify(files), target.accepted_json)
      } catch (error) {
        if (!(error instanceof OrchError)) throw error
      }
    }
    if (target.request_id && target.review_set_json === null && target.artifact_id && target.sha256) {
      file = { artifact_id: target.artifact_id, sha256: target.sha256, file_name: target.file_name }
    }
    reviewByTask.set(target.task_id, {
      kind: 'review', label: file?.file_name ? `打开「${file.file_name}」验收` : '处理本轮留验',
      run_id: target.run_id, node_id: target.node_id, node_run_id: target.node_run_id,
      artifact_id: file?.artifact_id ?? null, sha256: file?.sha256 ?? null,
      file_name: file?.file_name ?? null, request_id: target.request_id,
    })
  }
  const decisions = tx.all<{ task_id: string; run_id: string; decision_id: string }>(
    `SELECT t.task_id,d.run_id,d.decision_id FROM ${tree} t CROSS JOIN human_decision_inbox d ON d.run_id=t.run_id
     ORDER BY d.created_at,d.decision_id`, ids)
  const decisionByTask = new Map<string, TaskNextAction>()
  for (const decision of decisions) {
    if (decisionByTask.has(decision.task_id)) continue
    decisionByTask.set(decision.task_id, { kind: 'decision', label: '查看待批准事项', run_id: decision.run_id,
      decision_id: decision.decision_id })
  }
  const reworks = tx.all<{ task_id: string; run_id: string; request_id: string }>(
    `SELECT t.task_id,q.run_id,q.request_id FROM ${tree} t CROSS JOIN rework_requests q ON q.run_id=t.run_id
     JOIN runs qr ON qr.run_id=q.run_id AND qr.status='running' AND qr.cancel_requested_at IS NULL
     WHERE q.status IN ('proposed','needs_human_approval','escalated') AND (? IS NULL OR q.owner_actor=?)
     ORDER BY q.created_at,q.request_id`, [...ids,actor ?? null,actor ?? null])
  return items.map((item) => {
    const review = reviewByTask.get(item.task_id)
    if (review) return { ...item, next_action: review }
    const decision = decisionByTask.get(item.task_id)
    if (decision) return { ...item, next_action: decision }
    const rework = reworks.find(row => row.task_id === item.task_id)
    if (rework) return { ...item, next_action: { kind: 'rework', label: '处理返工待办', run_id: rework.run_id, request_id: rework.request_id } }
    if ((item.open_decision_count > 0 || item.unverified_count > 0) && item.current_run_id) {
      return { ...item, next_action: { kind: 'progress', label: '查看进度', run_id: item.current_run_id } }
    }
    return item
  })
}

/** 封存清单里第一份尚未确认的精确版本，不把旧封存改指向同名新版。 */
function pendingFile(reviewSetJson: string | null, acceptedJson: string | null):
{ artifact_id: string; sha256: string; file_name: string | null } | null {
  const parse = (raw: string | null): Array<{ artifact_id?: unknown; sha256?: unknown; file_name?: unknown }> => {
    if (typeof raw !== 'string' || raw.length === 0) return []
    try {
      const value = JSON.parse(raw) as unknown
      return Array.isArray(value) ? value.filter((item): item is { artifact_id?: unknown; sha256?: unknown; file_name?: unknown } =>
        item !== null && typeof item === 'object' && !Array.isArray(item)) : []
    } catch { return [] }
  }
  const files = parse(reviewSetJson).flatMap((item) => typeof item.artifact_id === 'string' && typeof item.sha256 === 'string'
    ? [{ artifact_id: item.artifact_id, sha256: item.sha256, file_name: typeof item.file_name === 'string' ? item.file_name : null }] : [])
  const accepted = parse(acceptedJson)
  const pending = files.find((file) => !accepted.some((done) =>
    done.artifact_id === file.artifact_id && done.sha256 === file.sha256))
  return pending ?? null
}

export function getTaskSummarySnapshot(db: Db, taskId: string, now = Date.now(), actor?: string): { item: TaskSummary; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<TaskRow>(TASK_PAGE_START + 'task_id = ?) ' + TASK_SUMMARY_SELECT, [taskId])
    if (!row) throw new OrchError('NOT_FOUND', '没找到这个任务', { task_id: taskId })
    return { item: attachNextActions(ctx.tx, [taskSummary(row, now)], actor, now)[0]!, as_of_seq: ctx.as_of_seq }
  })
}

export function getTaskSummary(db: Db, taskId: string, now = Date.now()): TaskSummary {
  return getTaskSummarySnapshot(db, taskId, now).item
}
