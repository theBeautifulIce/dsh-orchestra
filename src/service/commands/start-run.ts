// src/service/commands/start-run.ts —— 起运行：版本必填、自治档位落任务、operation_id 幂等。
import { OrchError } from '../../core/errors.ts'
import type { TaskOrigin } from '../../core/task-workspace.ts'
import { inTx } from '../../infra/db/tx.ts'
import { appendEvent } from '../../infra/db/ledger.ts'
import type { Db, Tx } from '../../infra/sqlite/driver.ts'
import { AUTONOMY_LEVELS, createRun, createRunInTx, type Autonomy, type CreateRunResult } from '../runs.ts'
import type { WorkflowCatalog } from '../workflows.ts'

export type EscalationRule = {
  // node_type / action_category / workflow_version_publish
  kind: 'node_type' | 'action_category' | 'workflow_version_publish'
  value: string
}

export type StartRunParams = {
  workflowId?: string
  // 必填：缺版本不能回退到 current
  workflowVersion: string
  taskTitle: string
  input?: Record<string, unknown>
  autonomy?: Autonomy
  triggerKind?: TaskOrigin
  escalations?: readonly EscalationRule[]
  operationId: string
  nodeIds?: string[]
  // 预留任务号（方向 A）：绑定到 reserveTask 生成的可信 task_id
  taskId?: string
  now: string
}

export type StartRunResult = {
  task_id: string
  run_id: string
  workflow_id: string
  workflow_version: string
  autonomy: Autonomy
  replayed: boolean
}

/** Only a committed trigger occurrence can start another run for the stable task. */
export function startTriggeredRunInTx(tx: Tx, catalog: WorkflowCatalog, triggerId: string, params: StartRunParams): StartRunResult {
  const created = createRunInTx(tx, catalog, { ...params, escalations: validateEscalations(params.escalations) }, triggerId)
  return {
    task_id: created.task_id, run_id: created.run_id, workflow_id: created.workflow_id,
    workflow_version: created.workflow_version, autonomy: created.autonomy, replayed: false,
  }
}

const ESCALATION_KINDS = ['node_type', 'action_category', 'workflow_version_publish'] as const

export function validateEscalations(value: unknown): EscalationRule[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'escalations 必须是数组', {})
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'escalation 必须是对象', { index })
    }
    const rule = entry as Record<string, unknown>
    if (!ESCALATION_KINDS.includes(rule.kind as EscalationRule['kind'])) {
      throw new OrchError('PAYLOAD_SCHEMA_INVALID', '未知的 escalation kind', { index, kind: rule.kind })
    }
    if (typeof rule.value !== 'string' || rule.value.length === 0) {
      throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'escalation.value 必须是非空字符串', { index })
    }
    return { kind: rule.kind as EscalationRule['kind'], value: rule.value }
  })
}

// 命中任一规则就要求确认；空名单合法，表示只使用硬性例外。
export function escalationRequiresConfirm(
  rules: readonly EscalationRule[],
  subject: { nodeType?: string; actionCategory?: string; workflowId?: string; workflowVersion?: string },
): boolean {
  return rules.some((rule) => {
    if (rule.kind === 'node_type') return subject.nodeType === rule.value
    if (rule.kind === 'action_category') return subject.actionCategory === rule.value
    return subject.workflowId === rule.value || subject.workflowVersion === rule.value
  })
}

function replay(db: Db, operationId: string): StartRunResult | null {  const row = db.raw.prepare(
    'SELECT o.task_id, o.run_id, t.workflow_id, t.workflow_version, t.autonomy FROM start_run_operations o JOIN tasks t ON t.task_id = o.task_id WHERE o.operation_id = ?',
  ).get(operationId) as { task_id: string; run_id: string; workflow_id: string; workflow_version: string; autonomy: Autonomy } | undefined
  if (!row) return null
  return {
    task_id: row.task_id, run_id: row.run_id, workflow_id: row.workflow_id,
    workflow_version: row.workflow_version, autonomy: row.autonomy, replayed: true,
  }
}

export function startRun(db: Db, catalog: WorkflowCatalog, p: StartRunParams): StartRunResult {
  if (typeof p.workflowVersion !== 'string' || p.workflowVersion.trim().length === 0) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '起运行必须固定 workflow_version', {})
  }
  if (typeof p.operationId !== 'string' || p.operationId.trim().length === 0) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '起运行必须带 operation_id', {})
  }
  const prior = replay(db, p.operationId)
  if (prior) return prior
  const autonomy = p.autonomy ?? 'autonomous'
  const escalations = validateEscalations(p.escalations)
  let created: CreateRunResult
  try {
    created = createRun(db, catalog, {
      taskTitle: p.taskTitle,
      workflowId: p.workflowId,
      workflowVersion: p.workflowVersion,
      nodeIds: p.nodeIds,
      taskId: p.taskId,
      autonomy,
      triggerKind: p.triggerKind,
      escalations,
      operationId: p.operationId,
      now: p.now,
    })
  } catch (err) {
    // 并发重放：唯一键冲突时以已提交的那一笔为准，不建第二条任务。
    const raced = replay(db, p.operationId)
    if (raced) return raced
    throw err
  }
  return {
    task_id: created.task_id, run_id: created.run_id, workflow_id: created.workflow_id,
    workflow_version: created.workflow_version, autonomy: created.autonomy, replayed: false,
  }
}

// decision 生成时用它把任务级 escalations 翻成 confirm_required。
export function decisionConfirmRequired(
  tx: Tx,
  runId: string,
  subject: { nodeType?: string; actionCategory?: string; workflowId?: string; workflowVersion?: string },
): boolean {
  const row = tx.get<{ escalations_json: string }>(
    'SELECT t.escalations_json FROM runs r JOIN tasks t ON t.task_id = r.task_id WHERE r.run_id = ?',
    [runId],
  )
  if (!row) return false
  let raw: unknown = []
  try { raw = JSON.parse(row.escalations_json) } catch { return false }
  return escalationRequiresConfirm(validateEscalations(raw), subject)
}

export type SetTaskAutonomyParams = {  taskId: string
  autonomy: Autonomy
  // 乐观锁：读取时拿到的 task.revision
  expectedRevision: number
  // 审批通过后才生效时填决策 id；这里仍立刻落库并留痕，由调用方在决策后使用
  effectiveAfterDecision?: string
  now: string
}

export type SetTaskAutonomyResult = { from: Autonomy; to: Autonomy; revision: number }

export function setTaskAutonomy(db: Db, p: SetTaskAutonomyParams): SetTaskAutonomyResult {
  if (!AUTONOMY_LEVELS.includes(p.autonomy)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '未知的自治档位', { autonomy: p.autonomy })
  }
  return inTx(db, (tx) => {
    const row = tx.get<{ autonomy: Autonomy; revision: number; current_run_id: string | null }>(
      'SELECT autonomy, revision, current_run_id FROM tasks WHERE task_id = ?', [p.taskId],
    )
    if (!row) throw new OrchError('NOT_FOUND', 'task 不存在', { taskId: p.taskId })
    const res = tx.run(
      'UPDATE tasks SET autonomy = ?, revision = revision + 1, updated_at = ? WHERE task_id = ? AND revision = ?',
      [p.autonomy, p.now, p.taskId, p.expectedRevision],
    )
    if (res.changes !== 1) {
      throw new OrchError('STALE_GENERATION', 'task 改档 CAS 未命中', {
        taskId: p.taskId, expectedRevision: p.expectedRevision,
      })
    }
    appendEvent(tx, {
      type: 'task.autonomy_changed',
      runId: row.current_run_id ?? undefined,
      payload: { task_id: p.taskId, from: row.autonomy, to: p.autonomy, effective_after_decision: p.effectiveAfterDecision ?? null },
    })
    return { from: row.autonomy, to: p.autonomy, revision: p.expectedRevision + 1 }
  })
}
