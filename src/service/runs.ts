// src/service/runs.ts —— 生产路径建任务、run 与节点（审计 F-01：起节点不许靠手写 INSERT）
import { OrchError } from '../core/errors.ts'
import type { TaskOrigin } from '../core/task-workspace.ts'
import { nodeRunId as newNodeRunId, runId as newRunId, taskId as newTaskId } from '../core/ids.ts'
import type { Db, Tx } from '../infra/sqlite/driver.ts'
import { withTx } from '../infra/sqlite/driver.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { definitionHashOf, workflowIdOf, type WorkflowCatalog } from './workflows.ts'
import { assertWorkflowUsable } from './commands/workflows.ts'
import { requireRunIntake } from './trial-access.ts'
import { requireTrialFlow } from './trial-circles.ts'
import { requestHashOf, runIdempotentCommand } from './commands/idempotency.ts'
import { isReleaseWorkflow, RELEASE_WORKFLOW_ID } from '../core/wf-release-v1.ts'
import { releaseRunAuthority } from './release-authority.ts'

export type Autonomy = 'autonomous' | 'assisted' | 'supervised'
export const AUTONOMY_LEVELS: readonly Autonomy[] = ['autonomous', 'assisted', 'supervised']

export type CreateRunParams = {
  taskTitle: string
  // 不传就是旧口径 default；两个工作流各有同版本号时必须传
  workflowId?: string
  workflowVersion: string
  // 只跑其中几个节点；不给就是整版都排上
  nodeIds?: string[]
  // 任务级自治档位与升级规则；旧调用不传时保持 autonomous / 空规则
  autonomy?: Autonomy
  triggerKind?: TaskOrigin
  escalations?: readonly Record<string, unknown>[]
  // 起运行命令的幂等键；旧调用不传就不写操作表
  operationId?: string
  startedBy?: string
  // 任务专属工作流的归属声明：用 task_local 工作流时必须与登记的 owner 一致
  ownerTaskId?: string | null
  // 预留任务号：方向 A——先由服务端生成可信 task_id，再以它为 owner 建 task_local 工作流
  taskId?: string
  now: string
}

export type CreatedNodeRun = {
  node_run_id: string
  node_id: string
  seq: number
  node_type: string
  status: string
}

export type CreateRunResult = {
  task_id: string
  run_id: string
  workflow_id: string
  workflow_version: string
  autonomy: Autonomy
  nodes: CreatedNodeRun[]
}

export type ReserveTaskParams = {
  taskId?: string
  title: string
  actor: string
  now: string
  operationId: string
}

/**
 * 预留任务号（方向 A）：服务端生成可信 task_id，后续 task_local 工作流以它为 owner。
 * 这一层不带事务：调用方要能把「预留任务 → 建流程 → 发布 → 落计划」收进同一笔事务（withTx 不能嵌套）。
 */
export function reserveTaskInTx(tx: Tx, p: ReserveTaskParams): { task_id: string } {
  const requestHash = requestHashOf('task.reserve', { title: p.title, task_id: p.taskId ?? null })
  return runIdempotentCommand(tx, {
    kind: 'task.reserve', operationId: p.operationId, requestHash, now: p.now,
  }, () => {
    const taskIdValue = p.taskId ?? newTaskId()
    const exists = tx.get<{ task_id: string }>('SELECT task_id FROM tasks WHERE task_id = ?', [taskIdValue])
    if (exists) throw new OrchError('OPERATION_ID_CONFLICT', '任务号已存在', { task_id: taskIdValue })
    tx.run(
      "INSERT INTO tasks (task_id, title, status, revision, created_at, updated_at) VALUES (?, ?, 'reserved', 0, ?, ?)",
      [taskIdValue, p.title, p.now, p.now],
    )
    appendEvent(tx, { type: 'task.reserved', payload: { task_id: taskIdValue, title: p.title } })
    return { task_id: taskIdValue }
  }).result
}

/** 预留任务号（方向 A）：服务端生成可信 task_id，后续 task_local 工作流以它为 owner */
export function reserveTask(db: Db, p: ReserveTaskParams): { task_id: string } {
  return withTx(db, (tx) => reserveTaskInTx(tx, p))
}

// 定义没加载过就拒：没有定义的 run 跑起来只会瞎猜
export function createRun(db: Db, catalog: WorkflowCatalog, p: CreateRunParams): CreateRunResult {
  return withTx(db, (tx) => createRunInTx(tx, catalog, p))
}

/**
 * 服务端可信编排路径的授权凭据：task_local 工作流只认登记的 owner 任务。
 * 客户端自报的 task_id 不算凭据（审计 P2-1），所以这条路径只给服务端内部调用。
 */
export type TrustedTaskLocalAuthority = {
  // 必须与 workflows.owner_task_id 一致的预留任务号
  ownerTaskId: string
}

/** 自动化只能通过已登记触发器取得重复启动同一任务的上下文。 */
export function createRunInTx(
  tx: Tx,
  catalog: WorkflowCatalog,
  p: CreateRunParams,
  triggerId?: string,
  trusted?: TrustedTaskLocalAuthority,
  releaseAuthority?: symbol,
): CreateRunResult {
  const autonomy = p.autonomy ?? 'autonomous'
  if (!AUTONOMY_LEVELS.includes(autonomy)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '自治档位只接受 autonomous / assisted / supervised', { autonomy })
  }
  const escalations = p.escalations ?? []
  if (!Array.isArray(escalations)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'escalations 必须是数组', {})
  }
  const def = p.workflowId === undefined ? catalog.get(p.workflowVersion) : catalog.get(p.workflowId, p.workflowVersion)
  const workflowId = workflowIdOf(def)
  if (isReleaseWorkflow(workflowId) && (releaseAuthority !== releaseRunAuthority || workflowId !== RELEASE_WORKFLOW_ID || triggerId || p.nodeIds)) {
    throw new OrchError('FORBIDDEN', '发布流程只能从专用受信入口整体启动')
  }
  // task_local 只能作为所属任务的子流程出现，不许当独立根工作流起（审计 P2-1：
  // 客户端自报 task id 不是授权凭据，根入口拿不到可信的 owner 上下文）
  // 服务端可信编排路径是唯一例外：凭据里的 owner 必须与登记的 owner_task_id 一致，否则照样拒
  const scopeRow = tx.get<{ scope: string; status: string; owner_task_id: string | null }>(
    'SELECT scope, status, owner_task_id FROM workflows WHERE workflow_id = ?', [workflowId])
  if (scopeRow?.scope === 'task_local') {
    if (!trusted || !scopeRow.owner_task_id || scopeRow.owner_task_id !== trusted.ownerTaskId) {
      throw new OrchError('FORBIDDEN', '任务专属工作流只能作为子流程启动', { workflow_id: workflowId })
    }
  }
  const wanted = p.nodeIds && p.nodeIds.length > 0 ? new Set(p.nodeIds) : null
  if (wanted) {
    const missing = [...wanted].filter((id) => !def.nodes.some((n) => n.node_id === id))
    if (missing.length > 0) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '节点不在这个工作流版本里', {
        workflow_id: workflowIdOf(def),
        workflow_version: p.workflowVersion,
        missing,
      })
    }
  }
  const picked = def.nodes.filter((n) => (wanted ? wanted.has(n.node_id) : true))
  if (wanted) {
    const grouped = new Set(picked.filter(n => n.type === 'branch' || n.parallel).map(n => n.node_id))
    const missingTargets = (def.edges ?? []).filter(edge => grouped.has(edge.from) && !wanted.has(edge.to))
    if (missingTargets.length > 0) {
      throw new OrchError('PAYLOAD_SCHEMA_INVALID', '分支和并行组启动时必须包含所有直接成员', { missing_targets: missingTargets.map(edge => edge.to) })
    }
  }
  if (picked.length === 0) {
    throw new OrchError('NOT_FOUND', '这个工作流版本里没有要跑的节点', {
      workflow_id: workflowIdOf(def),
      workflow_version: p.workflowVersion,
    })
  }
  // 绑定预留任务：预留阶段就存在的 task_id 是可信身份，task_local 的 owner 指向它
  // 依赖闭包（审计 P1）：edges 里指向的前置必须同批入选，否则该节点永远等不到前置完成。
  // 只选部分节点（nodeIds）时必须把依赖一起选上；错误里列出缺谁，方便客户端补齐。
  if (wanted) {
    const preds = new Map<string, string[]>()
    for (const edge of def.edges ?? []) {
      const list = preds.get(edge.to) ?? []
      list.push(edge.from)
      preds.set(edge.to, list)
    }
    const missing = new Map<string, string[]>()
    const stack = [...wanted]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const current = stack.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      for (const pred of preds.get(current) ?? []) {
        if (!wanted.has(pred)) {
          const list = missing.get(current) ?? []
          list.push(pred)
          missing.set(current, list)
        } else {
          stack.push(pred)
        }
      }
    }
    if (missing.size > 0) {
      throw new OrchError('PAYLOAD_SCHEMA_INVALID', '所选节点缺少必要的前置依赖，请把前置节点一起选上', {
        selected_node_ids: [...wanted],
        missing_dependencies: Object.fromEntries(missing),
      })
    }
  }
  let taskIdValue = newTaskId()
  if (p.taskId !== undefined) {
    const reserved = tx.get<{ task_id: string; status: string; current_run_id: string | null }>(
      'SELECT task_id, status, current_run_id FROM tasks WHERE task_id = ?', [p.taskId],
    )
    if (!reserved) throw new OrchError('NOT_FOUND', '预留任务不存在', { task_id: p.taskId })
    if (reserved.status !== 'reserved' || reserved.current_run_id !== null) {
      throw new OrchError('STALE_GENERATION', '预留任务已被占用或不在可绑定状态', {
        task_id: p.taskId,
        status: reserved.status,
      })
    }
    taskIdValue = p.taskId
  }
  const runIdValue = newRunId()
  const version = String(def.workflow_version)
  const definitionHash = definitionHashOf(def)
  const create = () => {
    if (scopeRow?.status === 'disabled' || scopeRow?.status === 'archived') {
      throw new OrchError('FORBIDDEN', 'Workflow 已停用，无法启动新任务', { workflow_id: workflowId })
    }
    assertWorkflowUsable(tx, workflowId, p.ownerTaskId ?? null)
    if (triggerId !== undefined) {
      // The rule is pinned to a workflow version and has one stable task. A manual
      // start has no trigger identity, so it still consumes only a reserved task.
      const trigger = tx.get<{ task_id: string }>(
        'SELECT task_id FROM task_triggers WHERE trigger_id = ? AND workflow_id = ? AND workflow_version = ? AND kind = ? AND enabled = 1',
        [triggerId, workflowId, version, p.triggerKind],
      )
      if (!trigger || p.taskId !== undefined) throw new OrchError('STALE_GENERATION', '触发任务的启动绑定已变化')
      taskIdValue = trigger.task_id
      const bound = tx.run(
        "UPDATE tasks SET status = 'running', display_status = NULL, current_run_id = ?, updated_at = ?, revision = revision + 1 "
        + 'WHERE task_id = ? AND archived_at IS NULL',
        [runIdValue, p.now, taskIdValue],
      )
      if (bound.changes !== 1) throw new OrchError('STALE_GENERATION', '触发任务已归档或不存在')
    } else if (p.taskId !== undefined) {
      // 预留任务行已存在：绑定 run，不新建任务。CAS 带 status/current_run_id 谓词，一个预留只能被消费一次
      const bound = tx.run(
        "UPDATE tasks SET title = ?, workflow_id = ?, workflow_version = ?, status = 'running', autonomy = ?, trigger_kind = COALESCE(?, trigger_kind), escalations_json = ?, current_run_id = ?, updated_at = ? "
        + "WHERE task_id = ? AND status = 'reserved' AND current_run_id IS NULL",
        [p.taskTitle, workflowId, version, autonomy, p.triggerKind ?? null, JSON.stringify(escalations), runIdValue, p.now, taskIdValue],
      )
      if (bound.changes !== 1) {
        throw new OrchError('STALE_GENERATION', '预留任务已被占用或不在可绑定状态', { task_id: taskIdValue })
      }
    } else {
      // 普通新任务：同一笔事务里把任务绑到本次根 run，收口时任务状态才跟得上（审计 P1-04）
      tx.run(
        'INSERT INTO tasks (task_id, title, workflow_id, workflow_version, status, revision, autonomy, trigger_kind, escalations_json, current_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)',
        [taskIdValue, p.taskTitle, workflowId, version, 'running', autonomy, p.triggerKind ?? null, JSON.stringify(escalations), runIdValue, p.now, p.now],
      )
    }
    insertRunInTx(tx, {
      run_id: runIdValue,
      task_id: taskIdValue,
      workflow_id: workflowId,
      workflow_version: version,
      workflow_definition_hash: definitionHash,
      status: 'running',
      root_run_id: runIdValue,
      subworkflow_depth: 0,
      started_at: p.now,
      created_at: p.now,
      updated_at: p.now,
    })
    const nodes = insertNodeRunsInTx(tx, runIdValue, picked.map((n) =>
      ({ node_id: n.node_id, node_type: n.type, effect: catalog.initialAgentEffect(n) })), p.now)
    appendEvent(tx, {
      type: triggerId ? 'task.run_started' : 'task.created',
      runId: runIdValue,
      payload: {
        task_id: taskIdValue, workflow_id: workflowId, workflow_version: version,
        node_count: nodes.length, autonomy, escalations, ...(p.triggerKind ? { trigger_kind: p.triggerKind } : {}),
      },
    })
    appendEvent(tx, {
      type: 'run.created',
      runId: runIdValue,
      payload: { run_id: runIdValue, workflow_id: workflowId, workflow_version: version, workflow_definition_hash: definitionHash },
    })
    if (p.operationId) {
      tx.run(
        'INSERT INTO start_run_operations (operation_id, task_id, run_id, created_at, started_by) VALUES (?, ?, ?, ?, ?)',
        [p.operationId, taskIdValue, runIdValue, p.now, p.startedBy ?? null],
      )
    }
    return { task_id: taskIdValue, run_id: runIdValue, workflow_id: workflowId, workflow_version: version, autonomy, nodes }
  }
  return create()
}

export type RunRowInput = {
  run_id: string
  task_id: string
  workflow_id: string | null
  workflow_version: string | null
  workflow_definition_hash: string | null
  status: string
  root_run_id?: string | null
  subworkflow_depth?: number
  started_at: string
  created_at: string
  updated_at: string
}

/** 事务内建 run 行：createRun 与记忆发起共用，保证 run 与业务写入同一笔事务提交 */
export function insertRunInTx(tx: Tx, row: RunRowInput, admittedFlow: Pick<RunRowInput, 'workflow_id' | 'workflow_definition_hash'> = row): void {
  requireRunIntake(tx)
  requireTrialFlow(tx, admittedFlow.workflow_id, admittedFlow.workflow_definition_hash)
  const rootRunId = row.root_run_id ?? row.run_id
  const depth = row.subworkflow_depth ?? 0
  tx.run(
    'INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, started_at, created_at, updated_at, root_run_id, subworkflow_depth) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)',
    [
      row.run_id, row.task_id, row.workflow_id, row.workflow_version, row.workflow_definition_hash,
      row.status, row.started_at, row.created_at, row.updated_at, rootRunId, depth,
    ],
  )
}

export type NodeRunInput = { node_id: string; node_type: string; effect?: 'pure' | 'compensable' | 'irreversible' }

/** 事务内建 node_run 行：seq 按给定顺序从 1 开始 */
export function insertNodeRunsInTx(tx: Tx, runId: string, nodes: readonly NodeRunInput[], now: string): CreatedNodeRun[] {
  const created: CreatedNodeRun[] = []
  nodes.forEach((node, idx) => {
    const id = newNodeRunId()
    const seq = idx + 1
    tx.run(
      'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, action_generation, rearm_generation, side_effect_policy, created_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, 1, ?, 0, 0, 0, ?, ?, ?)',
      [id, runId, node.node_id, seq, node.node_type, 'queued', node.effect ?? 'compensable', now, now],
    )
    created.push({ node_run_id: id, node_id: node.node_id, seq, node_type: node.node_type, status: 'queued' })
  })
  return created
}

