// src/service/runs.ts —— 生产路径建任务、run 与节点（审计 F-01：起节点不许靠手写 INSERT）
import { OrchError } from '../core/errors.ts'
import { nodeRunId as newNodeRunId, runId as newRunId, taskId as newTaskId } from '../core/ids.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import { withTx } from '../infra/sqlite/driver.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { definitionHashOf, workflowIdOf, type WorkflowCatalog } from './workflows.ts'

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
  escalations?: readonly Record<string, unknown>[]
  // 起运行命令的幂等键；旧调用不传就不写操作表
  operationId?: string
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

// 定义没加载过就拒：没有定义的 run 跑起来只会瞎猜
export function createRun(db: Db, catalog: WorkflowCatalog, p: CreateRunParams): CreateRunResult {
  const autonomy = p.autonomy ?? 'autonomous'
  if (!AUTONOMY_LEVELS.includes(autonomy)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', '自治档位只接受 autonomous / assisted / supervised', { autonomy })
  }
  const escalations = p.escalations ?? []
  if (!Array.isArray(escalations)) {
    throw new OrchError('PAYLOAD_SCHEMA_INVALID', 'escalations 必须是数组', {})
  }  const def = p.workflowId === undefined ? catalog.get(p.workflowVersion) : catalog.get(p.workflowId, p.workflowVersion)
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
  if (picked.length === 0) {
    throw new OrchError('NOT_FOUND', '这个工作流版本里没有要跑的节点', {
      workflow_id: workflowIdOf(def),
      workflow_version: p.workflowVersion,
    })
  }
  const taskIdValue = newTaskId()
  const runIdValue = newRunId()
  const workflowId = workflowIdOf(def)
  const version = String(def.workflow_version)
  const definitionHash = definitionHashOf(def)
  const nodes: CreatedNodeRun[] = []
  withTx(db, (tx) => {
    tx.run(
      'INSERT INTO tasks (task_id, title, workflow_id, workflow_version, status, revision, autonomy, escalations_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
      [taskIdValue, p.taskTitle, workflowId, version, 'running', autonomy, JSON.stringify(escalations), p.now, p.now],
    )
    tx.run(
      'INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, started_at, created_at, updated_at, root_run_id, subworkflow_depth) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0)',
      [runIdValue, taskIdValue, workflowId, version, definitionHash, 'running', p.now, p.now, p.now, runIdValue],
    )
    picked.forEach((n, idx) => {
      const id = newNodeRunId()
      const seq = idx + 1
      tx.run(
        'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, action_generation, rearm_generation, created_at, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, 1, ?, 0, 0, 0, ?, ?)',
        [id, runIdValue, n.node_id, seq, n.type, 'queued', p.now, p.now],
      )
      nodes.push({ node_run_id: id, node_id: n.node_id, seq, node_type: n.type, status: 'queued' })
    })
    appendEvent(tx, {
      type: 'task.created',
      runId: runIdValue,
      payload: {
        task_id: taskIdValue, workflow_id: workflowId, workflow_version: version,
        node_count: nodes.length, autonomy, escalations,
      },
    })
    appendEvent(tx, {
      type: 'run.created',
      runId: runIdValue,
      payload: { run_id: runIdValue, workflow_id: workflowId, workflow_version: version, workflow_definition_hash: definitionHash },
    })
    if (p.operationId) {
      tx.run(
        'INSERT INTO start_run_operations (operation_id, task_id, run_id, created_at) VALUES (?, ?, ?, ?)',
        [p.operationId, taskIdValue, runIdValue, p.now],
      )
    }
  })
  return { task_id: taskIdValue, run_id: runIdValue, workflow_id: workflowId, workflow_version: version, autonomy, nodes }
}
