import { OrchError } from '../core/errors.ts'
import { branchEdgesOf, type WorkflowDefinition } from '../core/workflow-def.ts'
import { appendNodeRunEvent, assertChainIntact, chainIsIntact, readChain, readChainHead } from '../infra/db/ledger.ts'
import type { Tx } from '../infra/sqlite/driver.ts'
import { applyTransition } from './commands/nodes.ts'
import type { ReadTx } from './queries/read-tx.ts'
import { runtimeEdges } from './rework-edges.ts'
import { definitionHashOf, type WorkflowCatalog } from './workflows.ts'
import { isVerifiedParallelMembership, parallelOpening, parallelToleratesMember } from './workflow-parallel.ts'
import { resolvePinnedNodeId } from './rework-extra-steps.ts'

export function ruleNodeInput(tx: Tx, secret: string, runId: string, nodeId: string, definition: WorkflowDefinition, initialInput: unknown): unknown {
  const predecessors = runtimeEdges(tx, runId, definition.edges ?? []).filter(edge => edge.to === nodeId)
  if (!predecessors.length) return initialInput
  const payloads: [string, unknown][] = []
  for (const predecessor of predecessors) {
    const previous = tx.get<{ node_run_id: string; node_type: string; status: string; parent_node_run_id: string | null }>(
      'SELECT node_run_id,node_type,status,parent_node_run_id FROM node_runs WHERE run_id=? AND node_id=? ORDER BY attempt DESC,seq DESC LIMIT 1',
      [runId, predecessor.from],
    )
    if (!previous) throw new OrchError('VERDICT_UNSUPPORTED', '规则节点缺少上游节点')
    assertChainIntact(tx, secret, previous.node_run_id)
    if (previous.status === 'superseded' && branchSkipped(tx, previous.node_run_id)) continue
    if (previous.parent_node_run_id && parallelToleratesMember(tx, secret, previous.parent_node_run_id, previous.node_run_id)) continue
    if (previous.node_type === 'branch' && selectedBranchTarget(tx, previous.node_run_id) !== nodeId) continue
    if (previous.node_type === 'parallel' && previous.status === 'waiting') {
      const member = tx.get<{ node_run_id: string }>('SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id=? ORDER BY attempt DESC,seq DESC LIMIT 1', [runId,nodeId])
      if (!member || !isVerifiedParallelMembership(tx, secret, previous.node_run_id, member.node_run_id)) {
        throw new OrchError('VERDICT_UNSUPPORTED', '规则节点缺少已核验的并行成员输入')
      }
      payloads.push([predecessor.from, parallelOpening(tx, previous.node_run_id)?.input ?? {}])
      continue
    }
    if (previous.status !== 'done') throw new OrchError('VERDICT_UNSUPPORTED', '规则节点缺少上游完成事实')
    if (previous.node_type === 'subworkflow') {
      const role = definition.nodes.find(node => node.node_id === resolvePinnedNodeId(tx, previous.node_run_id))
      payloads.push([predecessor.from, verifiedSubworkflowOutput(tx, secret, runId, previous.node_run_id, role?.subworkflow)])
      continue
    }
    if (previous.node_type === 'wait') {
      const waited = tx.get<{ matched_payload_json: string | null }>(
        "SELECT matched_payload_json FROM wait_registrations WHERE node_run_id=? AND state='woken' ORDER BY registration_id DESC LIMIT 1", [previous.node_run_id],
      )
      payloads.push([predecessor.from, waited?.matched_payload_json ? JSON.parse(waited.matched_payload_json) as unknown : {}])
      continue
    }
    if (previous.node_type === 'branch') {
      payloads.push([predecessor.from, {}])
      continue
    }
    const type = previous.node_type === 'policy' ? 'policy.evaluated' : previous.node_type === 'approval' ? 'approval.completed' : 'workflow.output'
    const output = tx.get<{ payload: string }>(
      'SELECT payload FROM node_run_events WHERE node_run_id=? AND type=? ORDER BY seq DESC LIMIT 1', [previous.node_run_id, type],
    )
    if (!output) throw new OrchError('VERDICT_UNSUPPORTED', '规则节点缺少已核验的上游输出', { upstream: predecessor.from })
    payloads.push([predecessor.from, JSON.parse(output.payload) as unknown])
  }
  return payloads.length === 1 ? payloads[0]![1] : Object.fromEntries(payloads)
}

function verifiedSubworkflowOutput(tx: Tx, secret: string, runId: string, nodeRunId: string,
  pinned: { workflow_id: string; pinned_version: number } | undefined): unknown {
  const unavailable = () => new OrchError('VERDICT_UNSUPPORTED', '缺少与固定子运行绑定的完成收据', { nodeRunId })
  const childRun = readBoundSubworkflowRun(tx, secret, runId, nodeRunId)
  if (!pinned || !childRun || childRun.workflow_id !== pinned.workflow_id || childRun.version !== String(pinned.pinned_version)
      || !['succeeded','succeeded_with_unverified'].includes(childRun.status)) throw unavailable()
  const finished = tx.get<{ payload: string }>(`SELECT payload FROM (
    SELECT payload FROM node_run_events WHERE node_run_id=? AND type='subworkflow.finished' ORDER BY seq DESC LIMIT 1
    ) WHERE json_extract(payload,'$.child_run_id')=?
      AND json_extract(payload,'$.parent_status')='done' AND json_extract(payload,'$.child_status')=?
      AND EXISTS(SELECT 1 FROM events t WHERE t.run_id=? AND t.type='run.terminal' AND json_extract(t.payload_redacted,'$.status')=?)`,
    [nodeRunId, childRun.id, childRun.status, childRun.id, childRun.status])
  if (!finished) throw unavailable()
  const children = tx.all<{ node_run_id: string }>('SELECT node_run_id FROM node_runs WHERE run_id=?', [childRun.id])
  if (!children.length || children.some(child => !intactBranchChain(tx, secret, child.node_run_id))) throw unavailable()
  return JSON.parse(finished.payload) as unknown
}

export function readBoundSubworkflowRun(tx: ReadTx, secret: string, runId: string, nodeRunId: string) {
  if (!intactBranchChain(tx, secret, nodeRunId)) return undefined
  return tx.get<{ id: string; workflow_id: string; version: string; status: string; cancel_requested_at: string | null }>(`SELECT c.run_id AS id,
    c.workflow_id,CAST(c.workflow_version AS TEXT) AS version,c.status,c.cancel_requested_at
    FROM (SELECT node_run_id,payload FROM node_run_events WHERE node_run_id=? AND type='subworkflow.waiting' ORDER BY seq DESC LIMIT 1) e
    JOIN runs c ON c.run_id=json_extract(e.payload,'$.child_run_id') AND c.parent_node_run_id=e.node_run_id
    WHERE c.parent_run_id=?
      AND json_extract(e.payload,'$.workflow_id')=c.workflow_id
      AND CAST(json_extract(e.payload,'$.workflow_version') AS TEXT)=CAST(c.workflow_version AS TEXT)`, [nodeRunId,runId])
}

export function selectedBranchTarget(tx: ReadTx, nodeRunId: string): string | undefined {
  return tx.get<{ target: string }>(`SELECT json_extract(payload,'$.target_node_id') AS target
    FROM node_run_events WHERE node_run_id=? AND type='branch.selected' ORDER BY seq DESC LIMIT 1`, [nodeRunId])?.target
}

export function branchSkipped(tx: ReadTx, nodeRunId: string): boolean {
  return tx.get("SELECT 1 FROM node_run_events WHERE node_run_id=? AND type='branch.skipped' LIMIT 1", [nodeRunId]) !== undefined
}

export function intactBranchChain(tx: ReadTx, secret: string, nodeRunId: string): boolean {
  return chainIsIntact(secret, readChain(tx, nodeRunId), readChainHead(tx, nodeRunId), true)
}

/** A skipped prerequisite is neutral only while both its ledger and its source route are intact. */
export function verifiedBranchSkip(tx: ReadTx, secret: string, runId: string, nodeRunId: string): boolean {
  if (!intactBranchChain(tx, secret, nodeRunId)) return false
  const source = tx.get<{ branch_id: string; target_id: string }>(`SELECT json_extract(e.payload,'$.branch_node_run_id') AS branch_id,
      json_extract(e.payload,'$.target_node_id') AS target_id FROM node_run_events e JOIN node_runs n
      ON n.node_run_id=json_extract(e.payload,'$.branch_node_run_id') AND n.run_id=? AND n.node_type='branch' AND n.status='done'
      WHERE e.type='branch.skipped' AND e.node_run_id=? ORDER BY e.seq DESC LIMIT 1`, [runId,nodeRunId])
  return !!source && intactBranchChain(tx, secret, source.branch_id) && selectedBranchTarget(tx, source.branch_id) === source.target_id
}

/** A single write commits route authority and prevents every unreachable node from taking a lease. */
export function persistBranchSelection(tx: Tx, secret: string, definition: WorkflowDefinition, p: {
  runId: string; nodeRunId: string; branchId: string; targetId: string; now: string; decisionId?: string
}): void {
  if (!branchEdgesOf(definition, p.branchId).some(edge => edge.to === p.targetId)) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '所选分支不在已发布的工作流中')
  }
  const branches = new Set(definition.nodes.filter(node => node.type === 'branch').map(node => node.node_id))
  const nodes = tx.all<{ node_run_id: string; node_id: string; status: string; attempt: number; side_effect_policy: string }>(
    'SELECT node_run_id,node_id,status,attempt,side_effect_policy FROM node_runs WHERE run_id=? ORDER BY attempt ASC,seq ASC', [p.runId],
  )
  const current = new Map(nodes.map(node => [node.node_id, node]))
  if (!current.has(p.targetId)) throw new OrchError('RESOLUTION_NOT_AVAILABLE', '所选分支未包含在当前运行中')
  const immutable = new Set((definition.edges ?? []).map(edge => JSON.stringify([edge.from, edge.to])))
  const edges = runtimeEdges(tx, p.runId, definition.edges ?? [])
  const forward = new Map<string,string[]>()
  const backward = new Map<string,string[]>()
  for (const edge of edges) {
    const next = forward.get(edge.from) ?? []
    next.push(edge.to)
    forward.set(edge.from, next)
    const prior = backward.get(edge.to) ?? []
    prior.push(edge.from)
    backward.set(edge.to, prior)
  }
  const affected = closure(forward, forward.get(p.branchId) ?? [])
  const relevant = closure(backward, [p.branchId, ...affected])
  if (edges.some(edge => relevant.has(edge.from) && branches.has(edge.from) && !immutable.has(JSON.stringify([edge.from, edge.to])))) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '分支出边必须来自已发布工作流')
  }
  const selected = new Map<string,string>([[p.branchId, p.targetId]])
  for (const node of current.values()) {
    if (node.node_id === p.branchId || !relevant.has(node.node_id) || !branches.has(node.node_id) || node.status !== 'done') continue
    if (!intactBranchChain(tx, secret, node.node_run_id)) throw new OrchError('FORBIDDEN', '相交分支的选择证据已断链', { nodeId: node.node_id })
    const target = selectedBranchTarget(tx, node.node_run_id)
    if (!target) throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '已完成的分支缺少选路记录', { nodeId: node.node_id })
    selected.set(node.node_id, target)
  }
  const inbound = new Set(edges.map(edge => edge.to))
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (selected.has(edge.from) && selected.get(edge.from) !== edge.to) continue
    const next = adjacency.get(edge.from) ?? []
    next.push(edge.to)
    adjacency.set(edge.from, next)
  }
  const reachable = new Set<string>()
  const pending = [...current.keys()].filter(nodeId => !inbound.has(nodeId))
  while (pending.length) {
    const nodeId = pending.pop()!
    if (reachable.has(nodeId) || !current.has(nodeId)) continue
    reachable.add(nodeId)
    pending.push(...(adjacency.get(nodeId) ?? []))
  }
  appendNodeRunEvent(tx, secret, p.nodeRunId, 'branch.selected', { target_node_id: p.targetId, ...(p.decisionId ? { decision_ref: p.decisionId } : {}) })
  for (const node of current.values()) {
    if (!affected.has(node.node_id) || reachable.has(node.node_id)) continue
    if (node.status === 'superseded' && branchSkipped(tx, node.node_run_id)) continue
    if (node.status !== 'queued') throw new OrchError('STALE_GENERATION', '未选中的分支已经开始，不能更改执行路径', { nodeId: node.node_id })
    applyTransition(tx, secret, {
      nodeRunId: node.node_run_id, from: ['queued'], to: 'superseded', ruleId: 'M-62', attempt: node.attempt, now: p.now,
      patch: { side_effect_policy: 'pure', side_effect_verified_none: 1 },
    })
    appendNodeRunEvent(tx, secret, node.node_run_id, 'branch.skipped', {
      branch_node_run_id: p.nodeRunId, target_node_id: p.targetId, previous_side_effect_policy: node.side_effect_policy,
    })
  }
}

function closure(adjacency: Map<string,string[]>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>()
  const pending = [...roots]
  while (pending.length) {
    const node = pending.pop()!
    if (seen.has(node)) continue
    seen.add(node)
    for (const next of adjacency.get(node) ?? []) pending.push(next)
  }
  return seen
}

/** The authenticated decision command calls this in the decision's own transaction. */
export function resolveWorkflowBranch(tx: Tx, secret: string, catalog: WorkflowCatalog, p: {
  decisionId: string; resolution: string; targetId: unknown; now: string
}): string | undefined {
  const row = tx.get<{ node_run_id: string; node_id: string; run_id: string; attempt: number; status: string;
    workflow_id: string; workflow_version: string; workflow_definition_hash: string | null; cancel_requested_at: string | null;
    decision_status: string; closed_reason: string | null; blocked_decision_id: string | null;
  }>(`SELECT n.node_run_id,n.node_id,n.run_id,n.attempt,n.status,n.blocked_decision_id,r.workflow_id,r.workflow_version,
      r.workflow_definition_hash,r.cancel_requested_at,d.status AS decision_status,d.closed_reason
    FROM decisions d JOIN node_runs n ON n.node_run_id=d.node_run_id AND n.run_id=d.run_id
    JOIN runs r ON r.run_id=n.run_id WHERE d.decision_id=? AND d.kind='rule_ambiguous' AND n.node_type='branch'`, [p.decisionId])
  if (!row) return undefined
  if (row.status !== 'blocked_post' || row.blocked_decision_id !== p.decisionId || row.cancel_requested_at
      || row.decision_status !== 'resolved' || row.closed_reason !== p.resolution || !['approved','rejected'].includes(p.resolution)) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '分支卡不再绑定到可处理的工作流节点')
  }
  const approved = p.resolution === 'approved'
  if (approved) {
    if (typeof p.targetId !== 'string') throw new OrchError('PAYLOAD_SCHEMA_INVALID', '批准时必须选择一条已发布的分支')
    const definition = catalog.get(row.workflow_id, row.workflow_version)
    if (!row.workflow_definition_hash || definitionHashOf(definition) !== row.workflow_definition_hash) {
      throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '运行绑定的工作流定义已变化')
    }
    persistBranchSelection(tx, secret, definition, { runId: row.run_id, nodeRunId: row.node_run_id, branchId: row.node_id,
      targetId: p.targetId, now: p.now, decisionId: p.decisionId })
  }
  const status = approved ? 'done' : 'failed'
  applyTransition(tx, secret, { nodeRunId: row.node_run_id, from: ['blocked_post'], to: status, ruleId: 'M-43', attempt: row.attempt, now: p.now,
    patch: { blocked_decision_id: null, side_effect_policy: 'pure', side_effect_verified_none: 1 } })
  appendNodeRunEvent(tx, secret, row.node_run_id, 'status_changed', {
    from: 'blocked_post', to: status, decision_id: p.decisionId, reason: approved ? 'branch_selected' : 'branch_rejected',
  })
  return row.run_id
}
