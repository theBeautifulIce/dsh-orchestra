// src/service/commands/subworkflow.ts —— 子流程 pin 版本、深度/环检测、子运行与取消传播（S3 Task 10）
import { assertWorkflowUsable } from './workflows.ts'
import { requireTrialFlow } from '../trial-circles.ts'
import { isReleaseWorkflow, RELEASE_CHECK_WORKFLOW_ID, RELEASE_WORKFLOW_ID } from '../../core/wf-release-v1.ts'
import { OrchError } from '../../core/errors.ts'
import { definitionHashOf, workflowIdOf, type WorkflowCatalog } from '../workflows.ts'
import type { Tx } from '../../infra/sqlite/driver.ts'
import { appendEvent, appendNodeRunEvent, chainBreakOf, readChain, readChainHead } from '../../infra/db/ledger.ts'
import { UNVERIFIED_EFFECT } from '../../infra/db/unverified-effects.ts'
import { runId as newRunId, uuidv7 } from '../../core/ids.ts'
import { applyTransition } from './nodes.ts'
import { loadNodeRun, type NodeRunRow } from './lease.ts'
import { applyCancel, type CancelResult } from './cancel.ts'
import { cancelDecision } from './decisions.ts'

import { SUBWORKFLOW_MAX_DEPTH } from '../../core/workflow-def.ts'
export { SUBWORKFLOW_MAX_DEPTH }

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
  workflow_definition_hash: string | null
  parent_run_id: string | null
  parent_node_run_id: string | null
  root_run_id: string | null
  subworkflow_depth: number
  status: string
}

function loadRun(tx: Tx, runIdValue: string): SubworkflowRunRow {
  const row = tx.get<SubworkflowRunRow>(
    'SELECT run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, parent_run_id, parent_node_run_id, root_run_id, subworkflow_depth, status '
    + 'FROM runs WHERE run_id = ?', [runIdValue],
  )
  if (!row) throw new OrchError('NOT_FOUND', 'run 不存在', { runId: runIdValue })
  return row
}

function policyOfRank(rank: number): SideEffectPolicy {
  return rank >= 2 ? 'irreversible' : rank >= 1 ? 'compensable' : 'pure'
}

/**
 * 从已固定的工作流目录里建真实的子流程边表：
 * 每个 subworkflow 节点的目标与版本都取自签名定义，不是来自请求。
 * requirePublished=true 时，闭包里任何一个 pin 版本没发布都直接拒——跑到一半才发现缺版本更糟。
 */
export function collectSubworkflowEdges(
  catalog: WorkflowCatalog,
  root: SubworkflowRef,
  opts: { requirePublished: boolean } = { requirePublished: true },
): Map<string, SubworkflowEdge> {
  const edges = new Map<string, SubworkflowEdge>()
  const queue: SubworkflowRef[] = [root]
  while (queue.length > 0) {
    const ref = queue.shift()!
    assertRef(ref)
    const key = edgeKey(ref.workflowId, ref.pinnedVersion)
    if (edges.has(key)) continue
    let def
    try {
      def = catalog.get(ref.workflowId, ref.pinnedVersion)
    } catch (err) {
      if (opts.requirePublished) {
        throw new OrchError('WORKFLOW_SUBWORKFLOW_VERSION_MISSING', '子流程引用的版本不存在或未发布', {
          workflowId: ref.workflowId,
          pinnedVersion: ref.pinnedVersion,
          cause: err instanceof Error ? err.message : String(err),
        })
      }
      edges.set(key, { workflowId: ref.workflowId, version: ref.pinnedVersion, children: [] })
      continue
    }
    const children: SubworkflowRef[] = []
    for (const node of def.nodes) {
      if (node.type !== 'subworkflow') continue
      const cfg = node.subworkflow
      if (!cfg) {
        throw new OrchError('WORKFLOW_VALIDATION_FAILED', 'subworkflow 节点缺少目标工作流配置', {
          workflowId: ref.workflowId,
          version: ref.pinnedVersion,
          node_id: node.node_id,
        })
      }
      children.push({ workflowId: cfg.workflow_id, pinnedVersion: cfg.pinned_version })
    }
    edges.set(key, { workflowId: ref.workflowId, version: ref.pinnedVersion, children })
    queue.push(...children)
  }
  return edges
}

export type SubworkflowGraphCheck = { policy: SideEffectPolicy; maxDepth: number }

/**
 * 派发前对子图做一次完整校验：深度、环、目标版本都已发布，并算出静态副作用下界。
 * 深度要按真实层级折算：子流程根节点已经占了 depth，剩下的余量才是它自己还能嵌套的层数。
 */
export function assertSubworkflowGraphFor(
  catalog: WorkflowCatalog,
  ref: SubworkflowRef,
  opts: { requirePublished: boolean; rootDepth: number },
): SubworkflowGraphCheck {
  const edges = collectSubworkflowEdges(catalog, ref, { requirePublished: opts.requirePublished })
  const remaining = SUBWORKFLOW_MAX_DEPTH - opts.rootDepth
  if (remaining < 0) {
    throw new OrchError('SUBWORKFLOW_DEPTH_EXCEEDED', '子流程深度超过 max_depth=2', {
      workflowId: ref.workflowId,
      pinnedVersion: ref.pinnedVersion,
      rootDepth: opts.rootDepth,
      maxDepth: SUBWORKFLOW_MAX_DEPTH,
    })
  }
  const policy = assertSubworkflowGraph(ref, edges, remaining)
  let maxDepth = 0
  const walk = (current: SubworkflowRef, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth)
    const edge = edges.get(edgeKey(current.workflowId, current.pinnedVersion))
    for (const child of edge?.children ?? []) walk(child, depth + 1)
  }
  walk(ref, 0)
  return { policy, maxDepth }
}

/**
 * 父运行绑定的定义里必须真的批准过这个子流程目标：
 * 已签名的 workflow_definition_hash 覆盖不到“派发时临时改目标”，这一步就是那道闸。
 */
function assertDeclaredSubworkflowRef(
  tx: Tx,
  catalog: WorkflowCatalog,
  parent: SubworkflowRunRow,
  node: NodeRunRow,
  requested: SubworkflowRef,
): void {
  if (!parent.workflow_id || parent.workflow_version === null) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '父 run 没有绑定工作流定义，不能起子流程', {
      parentRunId: parent.run_id,
      parentNodeRunId: node.node_run_id,
    })
  }
  let def
  try {
    def = catalog.get(parent.workflow_id, parent.workflow_version)
  } catch (err) {
    throw new OrchError('WORKFLOW_SUBWORKFLOW_VERSION_MISSING', '父 run 绑定的工作流版本没加载，不能校验子流程目标', {
      workflowId: parent.workflow_id,
      workflowVersion: parent.workflow_version,
      cause: err instanceof Error ? err.message : String(err),
    })
  }
  // 子流程目标必须是“签名定义说过”的目标：父 run 没有定义哈希时无从校验，一律拒
  if (!parent.workflow_definition_hash) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '父 run 没有绑定定义哈希，不能起子流程', {
      parentRunId: parent.run_id,
      parentNodeRunId: node.node_run_id,
      workflowId: parent.workflow_id,
      workflowVersion: parent.workflow_version,
    })
  }
  if (definitionHashOf(def) !== parent.workflow_definition_hash) {
    throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '父 run 绑定的定义哈希与目录不一致，不能起子流程', {
      workflowId: parent.workflow_id,
      workflowVersion: parent.workflow_version,
    })
  }
  const declared = def.nodes.find((item) => item.node_id === node.node_id)
  if (!declared) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '父节点不在已签名的工作流定义里', {
      workflowId: parent.workflow_id,
      workflowVersion: parent.workflow_version,
      nodeId: node.node_id,
    })
  }
  if (declared.type !== 'subworkflow' || !declared.subworkflow) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '已签名定义里这个节点不是子流程节点', {
      nodeId: node.node_id,
      type: declared.type,
    })
  }
  if (declared.subworkflow.workflow_id !== requested.workflowId
    || declared.subworkflow.pinned_version !== requested.pinnedVersion) {
    throw new OrchError('OPERATION_ID_CONFLICT', '子流程目标与已签名定义不一致，请求体不能替换目标', {
      nodeRunId: node.node_run_id,
      declared: {
        workflow_id: declared.subworkflow.workflow_id,
        pinned_version: declared.subworkflow.pinned_version,
      },
      requested,
    })
  }
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
  if (isReleaseWorkflow(p.workflowId) && (p.workflowId !== RELEASE_CHECK_WORKFLOW_ID || parent.workflow_id !== RELEASE_WORKFLOW_ID)) {
    throw new OrchError('FORBIDDEN', '发布检查子流程只能为受信发布根运行执行')
  }
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

  // 子流程引用同样过归属闸：不能借引用 task_local 工作流绕过 owner 限制
  assertWorkflowUsable(tx, p.workflowId, (parent as { task_id?: string }).task_id ?? null)
  const pinned = Number(p.workflowVersion)
  if (!Number.isInteger(pinned) || pinned < 1) {
    throw new OrchError('WORKFLOW_SUBWORKFLOW_VERSION_MISSING', '子流程必须 pin 一个正整数版本', {
      workflowId: p.workflowId,
      workflowVersion: p.workflowVersion,
    })
  }
  // 目标工作流与版本必须来自父 run 绑定的已签名定义；请求体只能复述，不能替换。
  const depth = (parent.subworkflow_depth ?? 0) + 1
  if (depth > SUBWORKFLOW_MAX_DEPTH) {
    throw new OrchError('SUBWORKFLOW_DEPTH_EXCEEDED', '子流程深度超过 max_depth=2', {
      parentRunId: p.parentRunId,
      depth,
      maxDepth: SUBWORKFLOW_MAX_DEPTH,
    })
  }
  assertDeclaredSubworkflowRef(tx, catalog, parent, node, { workflowId: p.workflowId, pinnedVersion: pinned })
  // 子图整体校验：目标版本要已发布，深度与环要在真实层级上成立。
  assertSubworkflowGraphFor(catalog, { workflowId: p.workflowId, pinnedVersion: pinned }, {
    requirePublished: true,
    rootDepth: depth,
  })

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
    requireTrialFlow(tx, p.workflowId, definitionHash)
  tx.run(
    'INSERT INTO runs (run_id, task_id, workflow_id, workflow_version, workflow_definition_hash, status, revision, started_at, created_at, updated_at, '
    + 'parent_run_id, parent_node_run_id, root_run_id, subworkflow_depth, resume_from) '
    + 'VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)',
    [childRunId, parent.task_id, p.workflowId, String(pinned), definitionHash, 'running', p.now, p.now, p.now,
      p.parentRunId, p.parentNodeRunId, rootRunId, depth, p.resumeFrom ?? null],
  )
  def.nodes.forEach((n, idx) => {
    // 副作用等级在子节点创建时就要明确写下，不靠 DDL 默认值：
    // 等待节点是纯控制节点，其余节点在真正执行前按保守值 compensable 落库。
    const policy: SideEffectPolicy = n.type === 'wait' ? 'pure' : catalog.initialAgentEffect(n)
    tx.run(
      'INSERT INTO node_runs (node_run_id, run_id, node_id, seq, node_type, attempt, status, revision, action_generation, rearm_generation, side_effect_policy, created_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, 1, ?, 0, 0, 0, ?, ?, ?)',
      [uuidv7(), childRunId, n.node_id, idx + 1, n.type, 'queued', policy, p.now, p.now],
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
  // 父节点在子运行收口前不声明“干净”：子流程里可能含不可逆动作，
  // 先按保守的 compensable 落库（不依赖 DDL 默认值），收口时再按子运行实际节点重算。
  // 这样节点级取消失败时也不会出现“父节点 pure + 子 run 未核实”的假成功。
  tx.run("UPDATE node_runs SET side_effect_policy = 'compensable' WHERE node_run_id = ?", [p.nodeRunId])
  applyTransition(tx, secret, {
    nodeRunId: p.nodeRunId,
    from: ['started'],
    to: 'waiting',
    attempt: p.attempt,
    now: p.now,
    // 父节点等待子运行时不能再占租约/执行器：否则扫描会把等待节点当失联，Dispatcher 也派不进来
    patch: { wait_started_at: p.now, lease_id: null, lease_expires_at: null, executor_session_id: null, executor_agent_id: null },
  })
  appendNodeRunEvent(tx, secret, p.nodeRunId, 'subworkflow.waiting', {
    child_run_id: child.run_id,
    workflow_id: child.workflow_id,
    workflow_version: child.workflow_version,
  })
  return child
}

const RUN_TERMINAL = [
  'succeeded', 'succeeded_with_unverified',
  'done', 'failed', 'failed_with_unverified', 'timeout',
  'abandoned_unverified', 'orphaned', 'superseded', 'cancelled',
] as const

function isRunTerminal(status: string): boolean {
  return (RUN_TERMINAL as readonly string[]).includes(status)
}

const NODE_TERMINAL = [
  'done', 'failed', 'timeout', 'abandoned_unverified', 'failed_with_unverified',
  'orphaned', 'superseded', 'cancelled',
] as const

const CHILD_SUCCESS = ['succeeded', 'succeeded_with_unverified', 'done'] as const
const CHILD_CANCELLED = ['superseded', 'cancelled'] as const
// 这些子运行终态本身就带“副作用没核实”的语义，不能只按状态名判成功

type ChildSideEffectAggregate = { policy: SideEffectPolicy; unverified: number }

/**
 * 子运行里实际发生过的副作用：取节点策略最大值，并数出“非 pure 且未核实”的节点。
 * 这是运行期事实，比定义里的静态声明更可靠；父节点据此决定能不能算“干净成功”。
 */
function childSideEffectAggregate(tx: Tx, childRunId: string): ChildSideEffectAggregate {
  const row = tx.get<{ policy_rank: number; unverified: number }>(
    'SELECT COALESCE(MAX(CASE side_effect_policy WHEN \'irreversible\' THEN 2 WHEN \'compensable\' THEN 1 ELSE 0 END), 0) AS policy_rank, '
    + `COALESCE(SUM(CASE WHEN ${UNVERIFIED_EFFECT} THEN 1 ELSE 0 END), 0) AS unverified `
    + 'FROM node_runs n WHERE run_id = ?',
    [childRunId],
  )
  return {
    policy: policyOfRank(Number(row?.policy_rank ?? 0)),
    unverified: Number(row?.unverified ?? 0),
  }
}

export function nodeRunChainIsIntact(tx: Tx, secret: string, nodeRunId: string, needsEvents = false): boolean {
  const chain = readChain(tx, nodeRunId)
  const head = readChainHead(tx, nodeRunId)
  const tail = chain.at(-1)
  if (!tail) return !needsEvents && !head
  return !!head && head.event_count === chain.length && head.last_seq === tail.seq
    && head.last_hash === tail.hash && !chainBreakOf(secret, chain)
}

/**
 * 子运行落终态后收口父控制节点。
 * 父节点在 waiting 时按子 run 终态映射 done/failed/superseded，不能一律当成功；
 * 子 run 的未核实副作用必须落到父节点的策略与核实位上，父 run 的终态才能继承这个事实。
 * 已终态或已取消的父节点直接幂等返回，让 sweep 继续收口父 run。
 */
export function finishSubworkflowChild(
  tx: Tx,
  secret: string,
  p: { childRunId: string; now: string; closeHealthyChild?: true },
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
  const unchanged = { parentNodeRunId: node.node_run_id, status: node.status }
  // The child can commit independently. Paths writing the parent also require its siblings'
  // chains and recovery state to be trustworthy, as the maintenance scan does.
  const canWriteParent = () => {
    const siblings = tx.all<{ node_run_id: string; recovery_uncertain: string | null }>(
      'SELECT node_run_id, recovery_uncertain FROM node_runs WHERE run_id = ?', [node.run_id],
    )
    const unsafe = siblings.find(row => row.recovery_uncertain !== null
      || !nodeRunChainIsIntact(tx, secret, row.node_run_id, row.node_run_id === node.node_run_id))
    if (!unsafe) return true
    if (p.closeHealthyChild) return false
    throw new OrchError('FORBIDDEN', '父运行的节点链或恢复状态尚未核实，暂不能收口父节点', {
      runId: node.run_id, nodeRunId: unsafe.node_run_id,
    })
  }
  const aggregate = childSideEffectAggregate(tx, p.childRunId)
  const childUnverified = aggregate.unverified > 0 || child.status === 'orphaned'
  if ((NODE_TERMINAL as readonly string[]).includes(node.status)) {
    // 父节点已经被取消/超时收口，但子 run 是后来才收的：未核实事实不能因此丢掉。
    // 状态不改，只把子运行的副作用事实回填到父节点，父 run 的终态仍能继承它。
    if (childUnverified) {
      const inherited: SideEffectPolicy = aggregate.policy === 'pure' ? 'compensable' : aggregate.policy
      if (!canWriteParent()) return unchanged
      const res = tx.run(
        'UPDATE node_runs SET side_effect_policy = ?, side_effect_verified_none = 0, revision = revision + 1, updated_at = ? '
        + 'WHERE node_run_id = ? AND status = ? AND (side_effect_policy <> ? OR side_effect_verified_none <> 0)',
        [inherited, p.now, node.node_run_id, node.status, inherited],
      )
      // 已经回填过就不重复写：扫描每两秒跑一轮，反复 bump revision 会让账本无谓增长
      if (res.changes !== 1) return { parentNodeRunId: node.node_run_id, status: node.status }
      appendNodeRunEvent(tx, secret, node.node_run_id, 'subworkflow.unverified_inherited', {
        child_run_id: p.childRunId,
        child_status: child.status,
        parent_status: node.status,
        child_side_effect_policy: aggregate.policy,
        child_unverified_nodes: aggregate.unverified,
        parent_side_effect_policy: inherited,
      })
    } else if (node.status === 'superseded' && node.side_effect_policy === 'compensable' && child.status === 'cancelled' && aggregate.policy === 'pure') {
      // A cancelled control node provisionally represents its child. Its actual pure child now has a definitive receipt.
      const receipt = tx.get<{ seq: number }>("SELECT seq FROM events WHERE run_id=? AND type='run.terminal' AND json_extract(payload_redacted,'$.outcome')='succeeded' AND json_extract(payload_redacted,'$.status')='cancelled' LIMIT 1", [child.run_id])
      if (receipt && !tx.get('SELECT 1 FROM runs WHERE parent_node_run_id=? AND run_id<>? LIMIT 1', [node.node_run_id,child.run_id])) {
        if (!canWriteParent()) return unchanged
        tx.run("UPDATE node_runs SET side_effect_policy='pure',revision=revision+1,updated_at=? WHERE node_run_id=?", [p.now,node.node_run_id])
        appendNodeRunEvent(tx, secret, node.node_run_id, 'subworkflow.pure_child_confirmed', { child_run_id: child.run_id, terminal_seq: receipt.seq })
      }
    }
    return unchanged
  }
  // 旧数据里父节点可能已经被取消围栏推进到 timing_out/stopping：为它补一个终态出口，
  // 不能因为取消路径和唤醒路径互斥而把父 run 永久悬空。
  if (node.status === 'timing_out') {
    if (!canWriteParent()) return unchanged
    applyTransition(tx, secret, {
      nodeRunId: node.node_run_id,
      from: ['timing_out'],
      to: 'timeout',
      attempt: node.attempt,
      now: p.now,
    })
    appendNodeRunEvent(tx, secret, node.node_run_id, 'subworkflow.finished', {
      child_run_id: p.childRunId,
      child_status: child.status,
      parent_status: 'timeout',
    })
    return { parentNodeRunId: node.node_run_id, status: 'timeout' }
  }
  if (node.status === 'stopping') {
    if (!canWriteParent()) return unchanged
    applyTransition(tx, secret, {
      nodeRunId: node.node_run_id,
      from: ['stopping'],
      to: 'abandoned_unverified',
      attempt: node.attempt,
      now: p.now,
      allowHung: true,
    })
    appendNodeRunEvent(tx, secret, node.node_run_id, 'subworkflow.finished', {
      child_run_id: p.childRunId,
      child_status: child.status,
      parent_status: 'abandoned_unverified',
    })
    return { parentNodeRunId: node.node_run_id, status: 'abandoned_unverified' }
  }
  if (node.status !== 'waiting') {
    throw new OrchError('STALE_GENERATION', '父节点不在等待中，不能被子流程唤醒', {
      nodeRunId: node.node_run_id,
      status: node.status,
    })
  }
  if (!canWriteParent()) return unchanged
  // 子运行自己取消、而父运行没有取消意图时，父节点不能记成 superseded：
  // 那会让父 run 在所有节点终态后收成 succeeded。没有替代物就按失败收口。
  const parentCancelled = tx.get<{ cancel_requested_at: string | null }>(
    'SELECT cancel_requested_at FROM runs WHERE run_id = ?', [node.run_id],
  )?.cancel_requested_at != null
  const childCancelled = (CHILD_CANCELLED as readonly string[]).includes(child.status)
  // 子 run 的“成功族”包含 succeeded_with_unverified：它算完成，但不算已核实。
  const childSucceeded = (CHILD_SUCCESS as readonly string[]).includes(child.status)
  const target: 'done' | 'failed' | 'superseded' = childSucceeded
    ? 'done'
    : childCancelled && parentCancelled ? 'superseded' : 'failed'
  // 父节点自己不再产生副作用，但它代表子流程这段执行：
  // - 干净成功：沿用子图策略，并标记“已核实”（不会再被 run-close 当成未核实）；
  // - 失败/取消/未核实：至少抬到 compensable 且清掉核实位，父 run 才能继承未核实事实。
  const parentPolicy: SideEffectPolicy = childSucceeded && !childUnverified
    ? aggregate.policy
    : (aggregate.policy === 'pure' ? 'compensable' : aggregate.policy)
  const verifiedNone = childSucceeded && !childUnverified ? 1 : 0
  const ruleId = target === 'done' ? 'M-63' : target === 'failed' ? 'M-64' : 'M-65'
  applyTransition(tx, secret, {
    nodeRunId: node.node_run_id,
    from: ['waiting'],
    to: target,
    ruleId,
    attempt: node.attempt,
    now: p.now,
    context: {
      hasToolCall: false,
      cancelResult: null,
      hangReason: null,
      sideEffectVerifiedNone: verifiedNone === 1,
      controlCompletion: true,
    },
    patch: {
      wait_started_at: null,
      lease_id: null,
      lease_expires_at: null,
      side_effect_policy: parentPolicy,
      side_effect_verified_none: verifiedNone,
    },
  })
  appendNodeRunEvent(tx, secret, node.node_run_id, 'subworkflow.finished', {
    child_run_id: p.childRunId,
    child_status: child.status,
    parent_status: target,
    child_side_effect_policy: aggregate.policy,
    child_unverified_nodes: aggregate.unverified,
    parent_side_effect_policy: parentPolicy,
  })
  return { parentNodeRunId: node.node_run_id, status: target }
}

export type PropagateCancelParams = {
  runId: string
  cancelResult: CancelResult
  now: string
  graceMs: number
  extendDeadlineMs?: number
  clock: import('../../core/clock.ts').ClockProvider
}

export type PropagateCancelResult = {
  cancelledRuns: string[]
  cancelledNodes: string[]
  skippedIrreversible: string[]
  // 还压着人工裁决的节点：取消请求已接受，但这些节点不能替人清掉
  pendingHumanDecisions: string[]
  runStatus: 'cancelled' | 'cancelling' | 'cancellation_pending' | 'already_stopped'
}

const ACTIVE_DECISION_STATUSES = "('pending', 'acknowledged', 'blocked_for_human')"

/**
 * 父运行取消向子运行传播：先把请求落到每个子 run 上，再对子 run 里可取消的节点发 cancel。
 * 不可逆节点一律跳过，交给核实/补偿；blocked_post 压在人工核验上，不替人清证据门。
 * 终态 run 不再接受取消写入：状态语义不能被后来的请求改写。
 */
export function propagateRunCancellation(
  tx: Tx,
  secret: string,
  p: PropagateCancelParams,
): PropagateCancelResult {
  const cancelledRuns: string[] = []
  const cancelledNodes: string[] = []
  const skippedIrreversible: string[] = []
  const pendingHumanDecisions: string[] = []

  const runRow = loadRun(tx, p.runId)
  if (isRunTerminal(runRow.status)) {
    // 已终态：不写 cancel 列，不传播，明确告诉调用方“早就停了”
    return {
      cancelledRuns,
      cancelledNodes,
      skippedIrreversible,
      pendingHumanDecisions,
      runStatus: 'already_stopped',
    }
  }

  tx.run(
    'UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_result = ?, revision = revision + 1, updated_at = ? WHERE run_id = ? AND (cancel_requested_at IS NULL OR cancel_result IS NOT ?)',
    [p.now, p.cancelResult, p.now, p.runId, p.cancelResult],
  )
  // 运行级取消先收目标 run 自己的在跑节点，再向子 run 传播
  const ownNodes = tx.all<{
    node_run_id: string
    status: string
    attempt: number
    revision: number
    node_type: string
    side_effect_policy: SideEffectPolicy
    blocked_decision_id: string | null
  }>(
    'SELECT node_run_id, status, attempt, revision, node_type, side_effect_policy, blocked_decision_id FROM node_runs WHERE run_id = ? ORDER BY node_run_id',
    [p.runId],
  )
  for (const node of ownNodes) {
    if (node.status === 'blocked_pre') {
      // 取消 run 时压在审批卡上的节点不能留着：批准入口会在取消后把它放回 queued，
      // 而 dispatcher 拒绝执行已取消的 run，节点就会永远停在 queued、run 永远 running。
      if (node.blocked_decision_id) {
        cancelDecision(tx, secret, { decisionId: node.blocked_decision_id, now: p.now, reason: 'cancelled' })
      }
      applyTransition(tx, secret, {
        nodeRunId: node.node_run_id,
        from: ['blocked_pre'],
        to: 'failed',
        ruleId: 'M-41',
        attempt: node.attempt,
        now: p.now,
        patch: {
          resume_state: null,
          blocked_decision_id: null,
          wait_started_at: null,
          lease_id: null,
          lease_expires_at: null,
          executor_session_id: null,
          executor_agent_id: null,
        },
      })
      appendNodeRunEvent(tx, secret, node.node_run_id, 'cancel_blocked_pre', {
        cancel_result: p.cancelResult,
        decision_id: node.blocked_decision_id,
      })
      cancelledNodes.push(node.node_run_id)
      continue
    }
    if (node.status === 'blocked_post') {
      // 校验门压着人工证据：不能为了让取消“成功”就把证据门清掉。
      // 取消请求保持 accepted，但 run 进入 cancellation_pending，等人工核验。
      const decisions = tx.all<{ decision_id: string }>(
        `SELECT decision_id FROM decisions WHERE node_run_id = ? AND status IN ${ACTIVE_DECISION_STATUSES}`,
        [node.node_run_id],
      )
      for (const decision of decisions) pendingHumanDecisions.push(decision.decision_id)
      appendNodeRunEvent(tx, secret, node.node_run_id, 'cancel_blocked_post_pending', {
        cancel_result: p.cancelResult,
        decision_ids: decisions.map((item) => item.decision_id),
      })
      continue
    }
    if (['queued', 'leased', 'dispatched', 'started', 'waiting', 'verifying'].includes(node.status) === false) continue
    // 已派发/在跑的不可逆节点不能取消；但 queued/leased 的副作用尚未发生，
    // 仍走 applyCancel 的作废分支，否则 run 会永远等一个永远不会执行的节点。
    const irreversibleRunning = node.side_effect_policy === 'irreversible'
      && ['dispatched', 'started', 'waiting', 'verifying'].includes(node.status)
    if (irreversibleRunning) {
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
      clock: p.clock,
    })
    cancelledNodes.push(node.node_run_id)
  }
  const children = tx.all<{ run_id: string; status: string }>(
    'SELECT run_id, status FROM runs WHERE parent_run_id = ? ORDER BY run_id', [p.runId],
  )
  for (const child of children) {
    if (isRunTerminal(child.status)) continue
    cancelledRuns.push(child.run_id)
    const nested = propagateRunCancellation(tx, secret, { ...p, runId: child.run_id })
    cancelledRuns.push(...nested.cancelledRuns)
    cancelledNodes.push(...nested.cancelledNodes)
    skippedIrreversible.push(...nested.skippedIrreversible)
    pendingHumanDecisions.push(...nested.pendingHumanDecisions)
  }
  return {
    cancelledRuns,
    cancelledNodes,
    skippedIrreversible,
    pendingHumanDecisions: [...new Set(pendingHumanDecisions)],
    runStatus: pendingHumanDecisions.length > 0
      ? 'cancellation_pending'
      : cancelledRuns.length > 0 || skippedIrreversible.length > 0 ? 'cancelling' : 'cancelled',
  }
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
