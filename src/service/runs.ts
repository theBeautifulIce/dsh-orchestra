// src/service/runs.ts —— 生产路径建任务、run 与节点（审计 F-01：起节点不许靠手写 INSERT）
import { OrchError } from '../core/errors.ts'
import { nodeRunId as newNodeRunId, runId as newRunId, taskId as newTaskId } from '../core/ids.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import { withTx } from '../infra/sqlite/driver.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import type { WorkflowCatalog } from './workflows.ts'

export type CreateRunParams = {
  taskTitle: string
  workflowVersion: string
  // 只跑其中几个节点；不给就是整版都排上
  nodeIds?: string[]
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
  workflow_version: string
  nodes: CreatedNodeRun[]
}

// 定义没加载过就拒：没有定义的 run 跑起来只会瞎猜
export function createRun(db: Db, catalog: WorkflowCatalog, p: CreateRunParams): CreateRunResult {
  const def = catalog.get(p.workflowVersion)
  const wanted = p.nodeIds && p.nodeIds.length > 0 ? new Set(p.nodeIds) : null
  if (wanted) {
    const missing = [...wanted].filter((id) => !def.nodes.some((n) => n.node_id === id))
    if (missing.length > 0) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '节点不在这个工作流版本里', {
        workflow_version: p.workflowVersion,
        missing,
      })
    }
  }
  const picked = def.nodes.filter((n) => (wanted ? wanted.has(n.node_id) : true))
  if (picked.length === 0) {
    throw new OrchError('NOT_FOUND', '这个工作流版本里没有要跑的节点', { workflow_version: p.workflowVersion })
  }
  const taskIdValue = newTaskId()
  const runIdValue = newRunId()
  const version = String(def.workflow_version)
  const nodes: CreatedNodeRun[] = []
  withTx(db, (tx) => {
    tx.run(
      'INSERT INTO tasks (task_id, title, workflow_version, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [taskIdValue, p.taskTitle, version, 'running', p.now, p.now],
    )
    tx.run(
      'INSERT INTO runs (run_id, task_id, workflow_version, status, revision, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
      [runIdValue, taskIdValue, version, 'running', p.now, p.now, p.now],
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
    appendEvent(tx, { type: 'task.created', runId: runIdValue, payload: { task_id: taskIdValue, workflow_version: version, node_count: nodes.length } })
    appendEvent(tx, { type: 'run.created', runId: runIdValue, payload: { run_id: runIdValue, workflow_version: version } })
  })
  return { task_id: taskIdValue, run_id: runIdValue, workflow_version: version, nodes }
}
