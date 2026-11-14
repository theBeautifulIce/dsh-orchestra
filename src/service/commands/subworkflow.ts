// src/service/commands/subworkflow.ts —— 子流程 pin 版本、深度/环检测、子运行与取消传播（S3 Task 10）
import { OrchError } from '../../core/errors.ts'
import { definitionHashOf, workflowIdOf, type WorkflowCatalog } from '../workflows.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { appendEvent, appendNodeRunEvent } from '../../infra/db/ledger.ts'
import { runId as newRunId, uuidv7 } from '../../core/ids.ts'
import { applyTransition } from './nodes.ts'
import { loadNodeRun, type NodeRunRow } from './lease.ts'
import { applyCancel, type CancelResult } from './cancel.ts'

export const SUBWORKFLOW_MAX_DEPTH = 2

export type SideEffectPolicy = 'pure' | 'compensable' | 'irreversible'

export type SubworkflowRef = { workflowId: string; pinnedVersion: number }

export type SubworkflowEdge = {
  workflowId: string
  version: number
  children: SubworkflowRef[]
  sideEffectPolicy?: SideEffectPolicy
}

const POLICY_RANK: Record<SideEffectPolicy, number> = { pure: 0, compensable: 1, irreversible: 2 }

function policyMax(a: SideEffectPolicy, b: SideEffectPolicy): SideEffectPolicy {
  return POLICY_RANK[a] >= POLICY_RANK[b] ? a : b
}

function assertRef(ref: SubworkflowRef): void {
  if (typeof ref.workflowId !== 'string' || ref.workflowId.trim().length === 0) {
    throw new OrchError('WORKFLOW_SUBWORKFLOW_VERSION_MISSING', '子流程引用缺少 workflow_id', { ref })
  }
  if (!Number.isInteger(ref.pinnedVersion) || ref.pinnedVersion < 1) {
    throw new OrchError('WORKFLOW_SUBWORKFLOW_VERSION_MISSING', '子流程必须 pin 一个正整数版本，不能跟随最新', {
      workflowId: ref.workflowId,
      pinnedVersion: ref.pinnedVersion,
    })
  }
}

function edgeKey(workflowId: string, version: number): string {
  return workflowId + '@' + version
}

/**
 * DFS 子图：深度按根到叶经过的 subworkflow 边数算，根为 0。
 * 环按递归栈判，不按全局 visited 判——菱形共享同一个子流程是合法 DAG，
 * 全局 visited 会把它误报成环。
 * 返回子图取最大值后的副作用策略（irreversible 由调用方强制前置审批）。
 */
export function assertSubworkflowGraph(
  root: SubworkflowRef,
  edges: ReadonlyMap<string, SubworkflowEdge>,
  maxDepth = SUBWORKFLOW_MAX_DEPTH,
): SideEffectPolicy {
  const stack = new Set<string>()
  const memo = new Map<string, SideEffectPolicy>()

  const walk = (ref: SubworkflowRef, depth: number): SideEffectPolicy => {
    assertRef(ref)
    if (depth > maxDepth) {
      throw new OrchError('SUBWORKFLOW_DEPTH_EXCEEDED', '子流程深度超过 max_depth=2', {
        workflowId: ref.workflowId,
        pinnedVersion: ref.pinnedVersion,
        depth,
        maxDepth,
      })
    }
    const key = edgeKey(ref.workflowId, ref.pinnedVersion)
    if (stack.has(key)) {
      throw new OrchError('SUBWORKFLOW_CYCLE', '子流程引用成环', {
        workflowId: ref.workflowId,
        pinnedVersion: ref.pinnedVersion,
      })
    }
    const cached = memo.get(key)
    if (cached) return cached

    stack.add(key)
    const edge = edges.get(key)
    if (edge && edge.version !== ref.pinnedVersion) {
      throw new OrchError('WORKFLOW_SUBWORKFLOW_VERSION_MISSING', '子流程边与 pin 版本不一致', {
        workflowId: ref.workflowId,
        pinnedVersion: ref.pinnedVersion,
        edgeVersion: edge.version,
      })
    }
    let policy: SideEffectPolicy = edge?.sideEffectPolicy ?? 'pure'
    for (const child of edge?.children ?? []) {
      policy = policyMax(policy, walk(child, depth + 1))
    }
    stack.delete(key)
    memo.set(key, policy)
    return policy
  }

  return walk(root, 0)
}

export type SubworkflowRunRow = {
  run_id: string
  task_id: string
  workflow_id: string | null
  workflow_version: number | null
  parent_run_id: string | null
  parent_node_run_id: string | null
  root_run_id: string | null
  subworkflow_depth: number
  status: string
}

function loadRun(tx: Tx, runIdValue: string): SubworkflowRunRow {
  const row = tx.get<SubworkflowRunRow>(
    'SELECT run_id, task_id, workflow_id, workflow_version, parent_run_id, parent_node_run_id, root_run_id, subworkflow_depth, status '
    + 'FROM runs WHERE run_id = ?', [runIdValue],
  )
  if (!row) throw new OrchError('NOT_FOUND', 'run 不存在', { runId: runIdValue })
  return row
}

export type CreateSubworkflowRunParams = {
  parentRunId: string
  parentNodeRunId: string
  workflowId: string
  workflowVersion: number | string
  resumeFrom?: string | null
  now: string
}

export type SubworkflowRunResult = {
  run_id: string
  workflow_id: string
  workflow_version: string
  depth: number
  created: boolean
}

/**
 * 为 subworkflow 节点创建子运行。版本必须是显式 pin，不允许 undefined / latest。
 * 同一个父节点重复调用返回同一个子运行；换 pin 版本则按操作冲突拒绝。
 */
export function createSubworkflowRun(
  tx: Tx,
  catalog: WorkflowCatalog,
  p: CreateSubworkflowRunParams,
): SubworkflowRunResult {
  const parent = loadRun(tx, p.parentRunId)
  if (parent.status !== 'running') {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '父 run 不在运行中，不能起子流程', {
      parentRunId: p.parentRunId,
      status: parent.status,
    })
  }
  const node = loadNodeRun(tx, p.parentNodeRunId)
  if (node.run_id !== p.parentRunId) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'subworkflow 节点不属于这个父 run', {
      parentRunId: p.parentRunId,
      parentNodeRunId: p.parentNodeRunId,
    })
  }
  if (node.node_type !== 'subworkflow') {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '只有 subworkflow 节点能起子运行', {
      nodeRunId: p.parentNodeRunId,
      nodeType: node.node_type,
    })
  }

  const pinned = Number(p.workflowVersion)
  if (!Number.isInteger(pinned) || pinned < 1) {
    throw new OrchError('WORKFLOW_SUBWORKFLOW_VERSION_MISSING', '子流程必须 pin 一个正整数版本', {
      workflowId: p.workflowId,
      workflowVersion: p.workflowVersion,
    })
  }
  const depth = (parent.subworkflow_depth ?? 0) + 1
  if (depth > SUBWORKFLOW_MAX_DEPTH) {
    throw new OrchError('SUBWORKFLOW_DEPTH_EXCEEDED', '子流程深度超过 max_depth=2', {
      parentRunId: p.parentRunId,
      depth,
      maxDepth: SUBWORKFLOW_MAX_DEPTH,
    })
  }

  // 运行前再按祖先链判一次环：发布期校验可能被旧数据或手工行绕过，
  // 同一 (workflow_id, pinned_version) 在祖先里出现过就不能再挂回来。
  const cycle = tx.get<{ run_id: string }>(
    'WITH RECURSIVE anc(run_id, workflow_id, workflow_version, parent_run_id) AS ('
    + 'SELECT run_id, workflow_id, workflow_version, parent_run_id FROM runs WHERE run_id = ? '
    + 'UNION ALL SELECT r.run_id, r.workflow_id, r.workflow_version, r.parent_run_id FROM runs r JOIN anc a ON r.run_id = a.parent_run_id'
    + ') SELECT run_id FROM anc WHERE workflow_id = ? AND CAST(workflow_version AS TEXT) = ? LIMIT 1',
    [p.parentRunId, p.workflowId, String(pinned)],
  )
  if (cycle) {
    throw new OrchError('SUBWORKFLOW_CYCLE', '子流程引用成环', {
      workflowId: p.workflowId,
      pinnedVersion: pinned,
      ancestorRunId: cycle.run_id,
    })
  }

  const existing = tx.get<{ run_id: string; workflow_id: string; workflow_version: number; subworkflow_depth: number }>(
    'SELECT run_id, workflow_id, workflow_version, subworkflow_depth FROM runs WHERE parent_node_run_id = ?',
    [p.parentNodeRunId],
  )
  if (existing) {
    if (existing.workflow_id !== p.workflowId || Number(existing.workflow_version) !== pinned) {
      throw new OrchError('OPERATION_ID_CONFLICT', '同一个 subworkflow 节点已经起了别的 pin 版本', {
        parentNodeRunId: p.parentNodeRunId,
        existingWorkflowId: existing.workflow_id,
        existingVersion: existing.workflow_version,
        requestedWorkflowId: p.workflowId,
        requestedVersion: pinned,
      })
    }
    return {
      run_id: existing.run_id,
      workflow_id: existing.workflow_id,
      workflow_version: String(existing.workflow_version),
      depth: existing.subworkflow_depth,
      created: false,
    }
  }
  if (node.status !== 'started') {
    throw new OrchError('STALE_GENERATION', '只有 started 的 subworkflow 节点能起子运行', {
      nodeRunId: p.parentNodeRunId,
      status: node.status,
    })
  }

  let def
  try {
    def = catalog.get(p.workflowId, pinned)
  } catch (err) {
    throw new OrchError('WORKFLOW_SUBWORKFLOW_VERSION_MISSING', '子流程引用的版本不存在或未发布', {
      workflowId: p.workflowId,
      workflowVersion: pinned,
      cause: err instanceof Error ? err.message : String(err),
    })
  }
  const childRunId = newRunId()
  const rootRunId = parent.root_run_id ?? parent.run_id
  const definitionHash = definitionHashOf(def)
  tx.run(
    'INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, started_at, created_at, updated_at, '
    + 'parent_run_id, parent_node_run_id, root_run_id, subworkflow_depth, resume_from) '
    + 'VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)',
    [childRunId, parent.task_id, p.workflowId, String(pinned), definitionHash, 'running', p.now, p.now, p.now,
      p.parentRunId, p.parentNodeRunId, rootRunId, depth, p.resumeFrom ?? null],
  )
  def.nodes.forEach((n, idx) => {
    tx.run(
      'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, action_generation, rearm_generation, created_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, 1, ?, 0, 0, 0, ?, ?)',
      [uuidv7(), childRunId, n.node_id, idx + 1, n.type, 'queued', p.now, p.now],
    )
  })
  appendEvent(tx, {
    type: 'run.created',
    runId: childRunId,
    payload: {
      run_id: childRunId,
      workflow_id: p.workflowId,
      workflow_version: String(pinned),
      workflow_definition_hash: definitionHash,
      parent_run_id: p.parentRunId,
      parent_node_run_id: p.parentNodeRunId,
      subworkflow_depth: depth,
    },
  })
  appendEvent(tx, {
    type: 'subworkflow.started',
    runId: p.parentRunId,
    nodeRunId: p.parentNodeRunId,
    payload: { child_run_id: childRunId, workflow_id: p.workflowId, workflow_version: String(pinned), depth },
  })
  return { run_id: childRunId, workflow_id: p.workflowId, workflow_version: String(pinned), depth, created: true }
}

export type StartSubworkflowParams = {
  nodeRunId: string
  attempt: number
  workflowId: string
  workflowVersion: number | string
  resumeFrom?: string | null
  now: string
}

/** 父节点 started→waiting 与子运行创建在同一笔事务里；不会出现“子运行在跑、父节点还能被派发”。 */
export function startSubworkflowNode(
  tx: Tx,
  secret: string,
  catalog: WorkflowCatalog,
  p: StartSubworkflowParams,
): SubworkflowRunResult {
  const node = loadNodeRun(tx, p.nodeRunId)
  if (node.status !== 'started') {
    throw new OrchError('STALE_GENERATION', '只有 started 的 subworkflow 节点能进等待', {
      nodeRunId: p.nodeRunId,
      status: node.status,
    })
  }
  const child = createSubworkflowRun(tx, catalog, {
    parentRunId: node.run_id,
    parentNodeRunId: p.nodeRunId,
    workflowId: p.workflowId,
    workflowVersion: p.workflowVersion,
    resumeFrom: p.resumeFrom,
    now: p.now,
  })
  applyTransition(tx, {
    nodeRunId: p.nodeRunId,
    from: ['started'],
    to: 'waiting',
    attempt: p.attempt,
    now: p.now,
    patch: { wait_started_at: p.now },
  })
  appendNodeRunEvent(tx, secret, p.nodeRunId, 'subworkflow.waiting', {
    child_run_id: child.run_id,
    workflow_id: child.workflow_id,
    workflow_version: child.workflow_version,
  })
  return child
}

const RUN_TERMINAL = ['done', 'failed', 'timeout', 'abandoned_unverified', 'failed_with_unverified', 'orphaned', 'superseded', 'cancelled'] as const

function isRunTerminal(status: string): boolean {
  return (RUN_TERMINAL as readonly string[]).includes(status)
}

/**
 * 子运行落终态后唤醒父节点。只允许 waiting→dispatched；重复调用在看到 dispatched 时幂等返回。
 */
export function finishSubworkflowChild(
  tx: Tx,
  secret: string,
  p: { childRunId: string; now: string },
): { parentNodeRunId: string; status: string } {
  const child = loadRun(tx, p.childRunId)
  if (!isRunTerminal(child.status)) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '子流程还没收口，不能唤醒父节点', {
      childRunId: p.childRunId,
      status: child.status,
    })
  }
  if (!child.parent_node_run_id) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '子运行没有父节点，不能唤醒', { childRunId: p.childRunId })
  }
  const node = loadNodeRun(tx, child.parent_node_run_id)
  if (node.status === 'dispatched') {
    return { parentNodeRunId: node.node_run_id, status: node.status }
  }
  if (node.status !== 'waiting') {
    throw new OrchError('STALE_GENERATION', '父节点不在等待中，不能被子流程唤醒', {
      nodeRunId: node.node_run_id,
      status: node.status,
    })
  }
  applyTransition(tx, {
    nodeRunId: node.node_run_id,
    from: ['waiting'],
    to: 'dispatched',
    attempt: node.attempt,
    now: p.now,
    patch: { wait_started_at: null },
  })
  appendNodeRunEvent(tx, secret, node.node_run_id, 'subworkflow.finished', {
    child_run_id: p.childRunId,
    child_status: child.status,
  })
  return { parentNodeRunId: node.node_run_id, status: 'dispatched' }
}

export type PropagateCancelParams = {
  runId: string
  cancelResult: CancelResult
  now: string
  graceMs: number
  extendDeadlineMs?: number
}

export type PropagateCancelResult = {
  cancelledRuns: string[]
  cancelledNodes: string[]
  skippedIrreversible: string[]
}

/**
 * 父运行取消向子运行传播：先把请求落到每个子 run 上，再对子 run 里可取消的节点发 cancel。
 * 不可逆节点一律跳过，交给核实/补偿；父运行是否收口由 assertNoOpenChildRuns 守。
 */
export function propagateRunCancellation(
  tx: Tx,
  secret: string,
  p: PropagateCancelParams,
): PropagateCancelResult {
  const cancelledRuns: string[] = []
  const cancelledNodes: string[] = []
  const skippedIrreversible: string[] = []

  tx.run(
    'UPDATE runs SET cancel_requested_at = ?, cancel_result = ?, revision = revision + 1, updated_at = ? WHERE run_id = ?',
    [p.now, p.cancelResult, p.now, p.runId],
  )
  const children = tx.all<{ run_id: string; status: string }>(
    'SELECT run_id, status FROM runs WHERE parent_run_id = ? ORDER BY run_id', [p.runId],
  )
  for (const child of children) {
    if (isRunTerminal(child.status)) continue
    tx.run(
      'UPDATE runs SET cancel_requested_at = ?, cancel_result = ?, revision = revision + 1, updated_at = ? WHERE run_id = ?',
      [p.now, p.cancelResult, p.now, child.run_id],
    )
    cancelledRuns.push(child.run_id)
    const nodes = tx.all<Pick<NodeRunRow, 'node_run_id' | 'status' | 'attempt' | 'revision' | 'side_effect_policy'>>(
      'SELECT node_run_id, status, attempt, revision, side_effect_policy FROM node_runs WHERE run_id = ? ORDER BY node_run_id',
      [child.run_id],
    )
    for (const node of nodes) {
      if (['dispatched', 'started', 'waiting', 'verifying'].includes(node.status) === false) continue
      if (node.side_effect_policy === 'irreversible') {
        skippedIrreversible.push(node.node_run_id)
        continue
      }
      applyCancel(tx, secret, {
        nodeRunId: node.node_run_id,
        attempt: node.attempt,
        revision: node.revision,
        cancelResult: p.cancelResult,
        now: p.now,
        graceMs: p.graceMs,
        extendDeadlineMs: p.extendDeadlineMs,
      })
      cancelledNodes.push(node.node_run_id)
    }
    const nested = propagateRunCancellation(tx, secret, { ...p, runId: child.run_id })
    cancelledRuns.push(...nested.cancelledRuns)
    cancelledNodes.push(...nested.cancelledNodes)
    skippedIrreversible.push(...nested.skippedIrreversible)
  }
  return { cancelledRuns, cancelledNodes, skippedIrreversible }
}

/** 父运行进终态前必须没有未收口子运行；与 settling/不可逆子节点闸一起用。 */
export function assertNoOpenChildRuns(tx: Tx, runIdValue: string): void {
  const open = tx.all<{ run_id: string; status: string }>(
    'SELECT run_id, status FROM runs WHERE parent_run_id = ? AND status NOT IN (' + RUN_TERMINAL.map(() => '?').join(', ') + ') ORDER BY run_id',
    [runIdValue, ...RUN_TERMINAL],
  )
  if (open.length > 0) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '还有未收口的子运行，父运行不能进终态', {
      runId: runIdValue,
      open_child_runs: open,
    })
  }
}
