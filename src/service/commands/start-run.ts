// src/service/commands/start-run.ts —— 起运行：版本必填、自治档位落任务、operation_id 幂等。
import { OrchError } from '../../core/errors.ts'
import type { TaskOrigin } from '../../core/task-workspace.ts'
import { inTx } from '../../infra/db/tx.ts'
import { appendEvent } from '../../infra/db/ledger.ts'
import type { Db, Tx } from '../../infra/sqlite/driver.ts'
import { AUTONOMY_LEVELS, createRun, createRunInTx, type Autonomy, type CreatedNodeRun, type CreateRunResult } from '../runs.ts'
import { workflowIdOf, type WorkflowCatalog } from '../workflows.ts'

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
  // The production HTTP adapter supplies this only for an authenticated human session.
  startedBy?: string
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
  const created = createRunInTx(tx, catalog, { ...params, startedBy: undefined, escalations: validateEscalations(params.escalations) }, triggerId)
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

function replay(db: Db, operationId: string, startedBy?: string): StartRunResult | null {
  const row = db.raw.prepare(
    'SELECT o.task_id, o.run_id, t.workflow_id, t.workflow_version, t.autonomy, o.started_by'
    + ' FROM start_run_operations o JOIN tasks t ON t.task_id = o.task_id WHERE o.operation_id = ?',
  ).get(operationId) as (Omit<StartRunResult, 'replayed'> & { started_by: string | null }) | undefined
  if (!row) return null
  if (row.started_by !== null && row.started_by !== startedBy) {
    throw new OrchError('OPERATION_ID_CONFLICT', '该启动回执属于另一位已认证的操作者')
  }
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
  catalog.requireWorkflowCapability(p.workflowId)
  const prior = replay(db, p.operationId, p.startedBy)
  if (prior) {
    catalog.requireWorkflowCapability(prior.workflow_id)
    return prior
  }
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
      startedBy: p.startedBy,
      now: p.now,
    })
  } catch (err) {
    // 并发重放：唯一键冲突时以已提交的那一笔为准，不建第二条任务。
    const raced = replay(db, p.operationId, p.startedBy)
    if (raced) {
      catalog.requireWorkflowCapability(raced.workflow_id)
      return raced
    }
    throw err
  }
  return {
    task_id: created.task_id, run_id: created.run_id, workflow_id: created.workflow_id,
    workflow_version: created.workflow_version, autonomy: created.autonomy, replayed: false,
  }
}

/**
 * 服务端可信编排路径的根启动入口（审计 P1-03）：task_local 工作流只有这条路能当根跑。
 * 客户端请求体触发不了它：HTTP /v1/runs/start 只映射显式字段到 startRun，走不到这里。
 */
export type TrustedTaskLocalRunParams = {
  // 必须是 workflows.owner_task_id 登记的那个预留任务号
  taskId: string
  workflowId: string
  // 必填：只能起已发布的确定版本
  workflowVersion: string
  taskTitle?: string
  autonomy?: Autonomy
  escalations?: readonly EscalationRule[]
  operationId?: string
  /**
   * 幂等重放开关：同一个 operation_id 再来时还回既有 run（不重复消费任务、不重复建 run）。
   * 默认关闭，保持可信路径原来的 fail-closed 口径（重复启动一律被拒）。
   */
  allowReplay?: boolean
  /** 与普通启动一致记录触发机制，避免同一操作因内部选路显示「来源未记录」（T13）。 */
  triggerKind?: TaskOrigin
  now: string
}

export type TrustedTaskLocalRunResult = {
  task_id: string
  run_id: string
  workflow_id: string
  workflow_version: string
  autonomy: Autonomy
  nodes: CreatedNodeRun[]
  /** true = 这次没有新建 run，是同一个 operation_id 的重放 */
  replayed: boolean
}

/** 版本号允许 '01' 这种补零写法，与目录内部的别名规则一致 */
function sameVersion(a: string, b: string): boolean {
  if (a === b) return true
  return /^\d+$/.test(a) && /^\d+$/.test(b) && Number(a) === Number(b)
}

/** 版本行必须已发布（published_by 非空）：草稿版本不许起根运行 */
function hasPublishedVersion(tx: Tx, workflowId: string, version: string): boolean {
  const rows = tx.all<{ version: string; published_by: string | null }>(
    'SELECT version, published_by FROM workflow_versions WHERE workflow_id = ?', [workflowId])
  return rows.some((row) => row.published_by !== null && sameVersion(row.version, version))
}

/**
 * 可信路径的幂等重放：同一个 operation_id 再来就还回既有 run。
 * 记账表和 startRun 用的是同一张 start_run_operations，所以这里也是唯一的事实来源。
 */
function replayTrustedRun(
  tx: Tx,
  operationId: string,
  taskId: string,
  workflowId: string,
): TrustedTaskLocalRunResult | null {
  const row = tx.get<{ task_id: string; run_id: string; workflow_id: string; workflow_version: string; autonomy: Autonomy }>(
    'SELECT o.task_id, o.run_id, t.workflow_id, t.workflow_version, t.autonomy FROM start_run_operations o '
    + 'JOIN tasks t ON t.task_id = o.task_id WHERE o.operation_id = ?',
    [operationId],
  )
  if (!row) return null
  if (row.task_id !== taskId || row.workflow_id !== workflowId) {
    throw new OrchError('OPERATION_ID_CONFLICT', 'operation_id 已被别的启动用过', { operation_id: operationId })
  }
  const nodes = tx.all<{ node_run_id: string; node_id: string; seq: number; node_type: string; status: string }>(
    'SELECT node_run_id, node_id, seq, node_type, status FROM node_runs WHERE run_id = ? ORDER BY seq ASC',
    [row.run_id],
  )
  return {
    task_id: row.task_id, run_id: row.run_id, workflow_id: row.workflow_id,
    workflow_version: row.workflow_version, autonomy: row.autonomy,
    nodes: nodes.map((node) => ({ ...node })), replayed: true,
  }
}

/**
 * 起 task_local 工作流的根运行：只有服务端可信编排路径能调。
 * 逐项 fail-closed：任务在预留态、owner 对得上、工作流 active、版本已发布；任一不满足就拒，不留副作用。
 * 任务消费与 run 创建在同一笔事务里（走既有 CAS），重复与并发启动只有一个成功。
 */
export function startTrustedTaskLocalRun(
  tx: Tx,
  catalog: WorkflowCatalog,
  p: TrustedTaskLocalRunParams,
): TrustedTaskLocalRunResult {
  if (typeof p.taskId !== 'string' || p.taskId.trim().length === 0) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '可信启动必须带预留任务号', {})
  }
  if (typeof p.workflowId !== 'string' || p.workflowId.trim().length === 0) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '可信启动必须带 workflow_id', {})
  }
  if (typeof p.workflowVersion !== 'string' || p.workflowVersion.trim().length === 0) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '可信启动必须固定 workflow_version', {})
  }
  catalog.requireWorkflowCapability(p.workflowId)
  // 0) 幂等重放优先于占用检查：重放时任务已经被上一次启动消费掉了
  if (p.allowReplay === true && p.operationId !== undefined) {
    const prior = replayTrustedRun(tx, p.operationId, p.taskId, p.workflowId)
    if (prior) return prior
  }
  // 1) 任务必须存在且在预留态：这是服务端 reserveTask 预留出来的身份
  const task = tx.get<{ task_id: string; title: string; status: string; current_run_id: string | null; archived_at: string | null }>(
    'SELECT task_id, title, status, current_run_id, archived_at FROM tasks WHERE task_id = ?', [p.taskId],
  )
  if (!task) throw new OrchError('NOT_FOUND', '预留任务不存在', { task_id: p.taskId })
  if (task.status !== 'reserved' || task.current_run_id !== null || task.archived_at !== null) {
    throw new OrchError('STALE_GENERATION', '预留任务已被占用或不在可绑定状态', {
      task_id: p.taskId, status: task.status,
    })
  }
  // 2) 工作流必须是 active 的 task_local，且 owner 就是这个预留任务
  const scopeRow = tx.get<{ scope: string; status: string; owner_task_id: string | null }>(
    'SELECT scope, status, owner_task_id FROM workflows WHERE workflow_id = ?', [p.workflowId])
  if (!scopeRow) throw new OrchError('NOT_FOUND', '工作流不存在', { workflow_id: p.workflowId })
  if (scopeRow.scope !== 'task_local') {
    throw new OrchError('FORBIDDEN', '可信启动只接受任务专属工作流', {
      workflow_id: p.workflowId, scope: scopeRow.scope,
    })
  }
  if (scopeRow.status !== 'active') {
    throw new OrchError('FORBIDDEN', 'Workflow 已停用，无法启动新任务', { workflow_id: p.workflowId })
  }
  if (!scopeRow.owner_task_id || scopeRow.owner_task_id !== p.taskId) {
    throw new OrchError('FORBIDDEN', '任务专属工作流只允许所属任务使用', {
      workflow_id: p.workflowId, owner_task_id: scopeRow.owner_task_id, requested_by: p.taskId,
    })
  }
  // 3) 目标版本必须已发布：草稿版本不许起
  const def = catalog.get(p.workflowId, p.workflowVersion)
  const version = String(def.workflow_version)
  if (!hasPublishedVersion(tx, p.workflowId, version)) {
    throw new OrchError('WORKFLOW_NOT_PUBLISHED', '只能起已发布的工作流版本', {
      workflow_id: p.workflowId, workflow_version: version,
    })
  }
  // 4) operation_id 复用既有记账表，不新增第二套幂等
  if (p.operationId !== undefined) {
    const prior = tx.get<{ run_id: string }>(
      'SELECT run_id FROM start_run_operations WHERE operation_id = ?', [p.operationId])
    if (prior) {
      throw new OrchError('OPERATION_ID_CONFLICT', 'operation_id 已被别的启动用过', {
        operation_id: p.operationId,
      })
    }
  }
  // 5) 起运行：owner 凭据一起带上，任务消费与 run 创建在同一笔事务里
  const created = createRunInTx(tx, catalog, {
    taskTitle: p.taskTitle ?? task.title,
    workflowId: p.workflowId,
    workflowVersion: p.workflowVersion,
    autonomy: p.autonomy,
    escalations: validateEscalations(p.escalations),
    ownerTaskId: p.taskId,
    taskId: p.taskId,
    operationId: p.operationId,
    ...(p.triggerKind === undefined ? {} : { triggerKind: p.triggerKind }),
    now: p.now,
  }, undefined, { ownerTaskId: p.taskId })
  return {
    task_id: created.task_id, run_id: created.run_id, workflow_id: created.workflow_id,
    workflow_version: created.workflow_version, autonomy: created.autonomy, nodes: created.nodes,
    replayed: false,
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
