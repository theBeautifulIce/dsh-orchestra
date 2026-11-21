import { deadlineFromAnchors, deadlineFromSample, type ClockProvider } from '../core/clock.ts'
import { OrchError } from '../core/errors.ts'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { uuidv7 } from '../core/ids.ts'
import { isTerminal } from '../core/state-machine.ts'
import { parallelMemberIds, type WorkflowDefinition, type WorkflowNodeDef } from '../core/workflow-def.ts'
import { appendEvent, appendNodeRunEvent, chainIsIntact, readChain, readChainHead } from '../infra/db/ledger.ts'
import type { Tx } from '../infra/sqlite/driver.ts'
import { cancelDecision, openDecision } from './commands/decisions.ts'
import { loadNodeRun, releaseLease } from './commands/lease.ts'
import { applyTransition, enterBlockedPre } from './commands/nodes.ts'
import { assertIrreversibleChildrenAllowed, cancelDisposition, deriveGroupState, type ParallelGroup, type SideEffectPolicy } from './commands/parallel.ts'
import { cancelWait } from './commands/wait.ts'
import { definitionHashOf, type WorkflowCatalog } from './workflows.ts'
import { readBoundSubworkflowRun, verifiedBranchSkip } from './branch-routing.ts'
import { closeRun, isRunTerminal } from './commands/run-close.ts'
import { finishSubworkflowChild, propagateRunCancellation } from './commands/subworkflow.ts'
import type { ReadTx } from './queries/read-tx.ts'
import { pruneInactiveParallelPaths } from './run-readiness.ts'

type Member = { node_run_id: string; node_id: string; attempt: number; status: string; node_type: string; side_effect_policy: SideEffectPolicy; blocked_decision_id: string | null }
type OpeningMember = Pick<Member, 'node_run_id' | 'node_id' | 'attempt'> & { minimum_effect: SideEffectPolicy; approval?: { id: string; content_hash: string } }
type GroupOpening = { mode: ParallelGroup['mode']; quorum?: number; allow_irreversible_children: boolean; members: OpeningMember[]; input: unknown }
export type GroupStop = { nodeRunId: string; attempt: number; groupId: string }
const EFFECT_RANK = { pure: 0, compensable: 1, irreversible: 2 } as const
const TOLERABLE_FAILURE = new Set(['failed','timeout','superseded','orphaned'])

function staticEffect(catalog: WorkflowCatalog, definition: WorkflowDefinition, role: WorkflowNodeDef, active = new Set<WorkflowNodeDef>()): SideEffectPolicy {
  if (active.has(role)) throw new OrchError('WORKFLOW_GRAPH_CYCLE', '并行组的成员定义形成循环')
  if (role.type === 'agent') return catalog.initialAgentEffect(role)
  if (!role.subworkflow && !role.parallel) return 'pure'
  active.add(role)
  const childDefinition = role.subworkflow ? catalog.getImmutable(role.subworkflow.workflow_id, role.subworkflow.pinned_version) : definition
  const members = new Set(parallelMemberIds(definition.edges ?? [], role.node_id))
  const children = role.subworkflow ? childDefinition.nodes : childDefinition.nodes.filter(node => members.has(node.node_id))
  let maximum: SideEffectPolicy = 'pure'
  for (const child of children) {
    const effect = staticEffect(catalog, childDefinition, child, active)
    if (EFFECT_RANK[effect] > EFFECT_RANK[maximum]) maximum = effect
  }
  active.delete(role)
  return maximum
}

export function openWorkflowParallel(tx: Tx, secret: string, catalog: WorkflowCatalog, clock: ClockProvider, p: {
  runId: string; nodeRunId: string; definition: WorkflowDefinition; role: WorkflowNodeDef; input: unknown; now: string
}): void {
  const parent = loadNodeRun(tx, p.nodeRunId)
  const config = p.role.parallel!
  const memberIds = parallelMemberIds(p.definition.edges ?? [], p.role.node_id)
  const roles = new Map(p.definition.nodes.map(role => [role.node_id, role]))
  const members = memberIds.map(nodeId => {
    const row = tx.get<Member & { parent_node_run_id: string | null }>(
      'SELECT * FROM node_runs WHERE run_id=? AND node_id=? ORDER BY attempt DESC,seq DESC LIMIT 1', [p.runId, nodeId],
    )
    if (!row || row.status !== 'queued' || row.parent_node_run_id !== null || !roles.has(nodeId) || roles.get(nodeId)?.type !== row.node_type) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '并行组成员缺失、类型不符或已经取得运行授权', { nodeId })
    }
    const pinnedEffect = staticEffect(catalog, p.definition, roles.get(nodeId)!)
    return { ...row, side_effect_policy: EFFECT_RANK[pinnedEffect] > EFFECT_RANK[row.side_effect_policy] ? pinnedEffect : row.side_effect_policy }
  })
  const group = { nodeRunId: p.nodeRunId, mode: config.join, quorum: config.quorum, allowIrreversibleChildren: config.allow_irreversible_children === true,
    childNodeRunIds: members.map(child => child.node_run_id) }
  assertIrreversibleChildrenAllowed(group, members.map(toChild))
  const openingMembers: OpeningMember[] = []
  for (const member of members) {
    const changed = tx.run('UPDATE node_runs SET parent_node_run_id=?,side_effect_policy=?,revision=revision+1 WHERE node_run_id=? AND status=\'queued\' AND parent_node_run_id IS NULL',
      [parent.node_run_id, member.side_effect_policy, member.node_run_id])
    if (changed.changes !== 1) throw new OrchError('STALE_GENERATION', '并行组成员状态已变化')
    const binding: OpeningMember = { node_run_id: member.node_run_id, node_id: member.node_id, attempt: member.attempt, minimum_effect: member.side_effect_policy }
    if (member.side_effect_policy === 'irreversible') {
      const decisionId = 'dec_' + uuidv7()
      const contentHash = sha256Hex(canonicalJson({ ...binding, group_id: p.nodeRunId, definition_hash: definitionHashOf(p.definition) }))
      openDecision(tx, { decisionId, runId: p.runId, nodeRunId: member.node_run_id, kind: 'pre_execution', approver: 'human', contentHash,
        payload: { node_type: member.node_type, action_category: 'irreversible', target_summary: `确认并行组成员 ${member.node_id} 的执行授权` }, createdAt: p.now })
      enterBlockedPre(tx, secret, { nodeRunId: member.node_run_id, attempt: member.attempt, decisionId,
        actionGeneration: loadNodeRun(tx, member.node_run_id).action_generation, now: p.now })
      appendEvent(tx, { type: 'decision.created', runId: p.runId, nodeRunId: member.node_run_id, decisionId, payload: { kind: 'pre_execution' } })
      binding.approval = { id: decisionId, content_hash: contentHash }
    }
    openingMembers.push(binding)
  }
  const deadline = config.timeout_ms && members.some(member => member.side_effect_policy !== 'irreversible')
    ? deadlineFromSample(clock, config.timeout_ms) : null
  applyTransition(tx, secret, { nodeRunId: p.nodeRunId, from: ['started'], to: 'waiting', ruleId: 'M-20', attempt: parent.attempt, now: p.now,
    patch: { wait_started_at: p.now, wait_remaining_ns: config.timeout_ms ? config.timeout_ms * 1e6 : null,
      ...(deadline ? { wait_deadline_at: new Date(deadline.wallClockMs).toISOString(), wait_deadline_boot_id: deadline.bootId,
        wait_deadline_monotonic_ns: deadline.monotonicNs } : {}),
    } })
  releaseLease(tx, { nodeRunId: p.nodeRunId, now: p.now })
  const opening: GroupOpening = { mode: config.join, quorum: config.quorum, allow_irreversible_children: group.allowIrreversibleChildren,
    members: openingMembers, input: p.input }
  appendNodeRunEvent(tx, secret, p.nodeRunId, 'parallel.opened', opening)
}

function toChild(child: Member) { return { nodeRunId: child.node_run_id, status: child.status, sideEffectPolicy: child.side_effect_policy } }

function intact(tx: ReadTx, secret: string, nodeRunId: string, needsEvents: boolean): boolean {
  return chainIsIntact(secret, readChain(tx, nodeRunId), readChainHead(tx, nodeRunId), needsEvents)
}

export function parallelOpening(tx: ReadTx, nodeRunId: string): GroupOpening | undefined {
  const opened = tx.get<{ payload: string }>("SELECT payload FROM node_run_events WHERE node_run_id=? AND type='parallel.opened' ORDER BY seq DESC LIMIT 1", [nodeRunId])
  return opened ? JSON.parse(opened.payload) as GroupOpening : undefined
}

export function isVerifiedParallelMembership(tx: ReadTx, secret: string | undefined, parentId: string, childId: string): boolean {
  if (secret && !intact(tx, secret, parentId, true)) return false
  return parallelOpening(tx, parentId)?.members.some(member => member.node_run_id === childId) === true
}

export function parallelMemberMayStart(tx: ReadTx, secret: string | undefined, parentId: string, childId: string): boolean {
  if (secret && !intact(tx, secret, parentId, true)) return false
  const member = parallelOpening(tx, parentId)?.members.find(candidate => candidate.node_run_id === childId)
  if (!member) return false
  const seen = new Set<string>()
  let groupId = parentId
  for (;;) {
    if (seen.has(groupId)) return false
    seen.add(groupId)
    const group = tx.get<{ run_id: string; parent_node_run_id: string | null }>(
      "SELECT run_id,parent_node_run_id FROM node_runs WHERE node_run_id=? AND node_type='parallel' AND status='waiting'", [groupId])
    if (!group) return false
    if (!group.parent_node_run_id) break
    const ancestorId: string = group.parent_node_run_id
    if (!tx.get("SELECT 1 FROM node_runs WHERE node_run_id=? AND run_id=?", [ancestorId,group.run_id])
        || !isVerifiedParallelMembership(tx, secret, ancestorId, groupId) || groupStopIntent(tx, groupId, ancestorId)) return false
    groupId = ancestorId
  }
  if (!member.approval) return member.minimum_effect !== 'irreversible'
  return !!tx.get(`SELECT 1 FROM decisions WHERE decision_id=? AND node_run_id=? AND kind='pre_execution'
    AND status='resolved' AND closed_reason='approved' AND approver='human' AND content_hash=?`, [member.approval.id,childId,member.approval.content_hash])
}

export function parallelToleratesMember(tx: ReadTx, secret: string | undefined, parentId: string, memberId: string): boolean {
  const member = tx.get<{ run_id: string; status: string; side_effect_policy: SideEffectPolicy }>(
    'SELECT run_id,status,side_effect_policy FROM node_runs WHERE node_run_id=? AND parent_node_run_id=?', [memberId,parentId])
  return !!member && member.side_effect_policy === 'pure' && TOLERABLE_FAILURE.has(member.status)
    && parallelMemberPath(tx, secret, member.run_id, memberId, parentId) === 'inactive'
}

export function parallelSuccess(tx: ReadTx, secret: string | undefined, parentId: string): { tolerated_member_ids: string[] } | undefined {
  if (secret && !intact(tx, secret, parentId, true)) return undefined
  const result = tx.get<{ payload: string }>("SELECT payload FROM node_run_events WHERE node_run_id=? AND type='parallel.result' ORDER BY seq DESC LIMIT 1", [parentId])
  if (!result) return undefined
  const payload = JSON.parse(result.payload) as { status: string; tolerated_member_ids: string[] }
  return payload.status === 'done' ? payload : undefined
}

/** External edges wait for the entire membership ancestry, including a nested group's owner. */
export function parallelMemberPath(tx: ReadTx, secret: string | undefined, runId: string, memberId: string,
  directParentId: string | null): 'active' | 'inactive' | 'waiting' | 'failed' {
  const seen = new Set([memberId])
  let childId = memberId
  let parentId = directParentId
  let state: ReturnType<typeof parallelMemberPath> = 'active'
  while (parentId) {
    if (seen.has(parentId) || !isVerifiedParallelMembership(tx, secret, parentId, childId)) return 'waiting'
    seen.add(parentId)
    const parent: { status: string; parent_node_run_id: string | null } | undefined = tx.get(
      "SELECT status,parent_node_run_id FROM node_runs WHERE node_run_id=? AND run_id=? AND node_type='parallel'", [parentId,runId])
    if (!parent) return 'waiting'
    if (parent.status === 'done') {
      const result = parallelSuccess(tx, secret, parentId)
      if (!result) return 'waiting'
      if (result.tolerated_member_ids.includes(childId)) state = 'inactive'
    } else if (parent.status === 'waiting') {
      return 'waiting'
    } else {
      if (!isTerminal(parent.status)) return 'waiting'
      state = 'failed'
    }
    childId = parentId
    parentId = parent.parent_node_run_id
  }
  return state === 'inactive' && secret && !intact(tx, secret, memberId, true) ? 'waiting' : state
}

function groupClockExpired(tx: Tx, parent: { node_run_id: string; wait_remaining_ns: number | null; wait_deadline_at: string | null;
  wait_deadline_boot_id: string | null; wait_deadline_monotonic_ns: number | null }, members: Member[], clock?: ClockProvider): boolean {
  if (!clock || parent.wait_remaining_ns === null) return false
  const pending = members.filter(member => !isTerminal(member.status))
  if (!pending.length) return false
  const waitingForDecision = pending.every(member => member.status === 'blocked_pre' || member.status === 'blocked_post')
  const current = deadlineFromAnchors({ deadlineAt: parent.wait_deadline_at, bootId: parent.wait_deadline_boot_id, monotonicNs: parent.wait_deadline_monotonic_ns })
  const verdict = current ? clock.decide(current) : null
  if (waitingForDecision) {
    if (verdict && verdict.kind !== 'uncertain') {
      tx.run('UPDATE node_runs SET wait_deadline_at=NULL,wait_deadline_boot_id=NULL,wait_deadline_monotonic_ns=NULL,wait_remaining_ns=? WHERE node_run_id=?',
        [verdict.kind === 'pending' ? Math.max(1, Math.round(verdict.remainingMs * 1e6)) : parent.wait_remaining_ns, parent.node_run_id])
    }
    return false
  }
  if (!current) {
    const deadline = deadlineFromSample(clock, parent.wait_remaining_ns / 1e6)
    tx.run('UPDATE node_runs SET wait_deadline_at=?,wait_deadline_boot_id=?,wait_deadline_monotonic_ns=? WHERE node_run_id=?',
      [new Date(deadline.wallClockMs).toISOString(), deadline.bootId, deadline.monotonicNs, parent.node_run_id])
    return false
  }
  return verdict?.kind === 'expired'
}

/** Refresh one run from durable membership and receipts. Captured stop intents are delivered separately. */
export function refreshWorkflowParallelGroups(tx: Tx, secret: string, runId: string, now: string, clock?: ClockProvider): GroupStop[] {
  const parents = tx.all<{ node_run_id: string; parent_node_run_id: string | null; attempt: number; wait_deadline_at: string | null;
    wait_deadline_boot_id: string | null; wait_deadline_monotonic_ns: number | null; wait_remaining_ns: number | null }>(
    "SELECT node_run_id,parent_node_run_id,attempt,wait_deadline_at,wait_deadline_boot_id,wait_deadline_monotonic_ns,wait_remaining_ns FROM node_runs WHERE run_id=? AND node_type='parallel' AND status='waiting' ORDER BY seq DESC",
    [runId],
  )
  const waitingGroups = new Map(parents.map(parent => [parent.node_run_id,parent]))
  const stop: GroupStop[] = []
  for (const parent of parents) {
    const groupId = parent.node_run_id
    if (!waitingGroups.has(groupId)) continue
    if (!intact(tx, secret, groupId, true)) continue
    const opened = parallelOpening(tx, groupId)
    if (!opened) continue
    const members = tx.all<Member>('SELECT * FROM node_runs WHERE run_id=? AND parent_node_run_id=? ORDER BY seq', [runId, groupId])
    const byId = new Map(members.map(child => [child.node_run_id, child]))
    if (opened.members.length !== members.length || !opened.members.every(member => {
      const actual = byId.get(member.node_run_id)
      return actual?.node_id === member.node_id && actual.attempt === member.attempt && intact(tx, secret, member.node_run_id, isTerminal(actual.status))
    })) continue
    for (const authorized of opened.members) {
      const member = byId.get(authorized.node_run_id)!
      if (member.side_effect_policy !== authorized.minimum_effect && EFFECT_RANK[authorized.minimum_effect] > EFFECT_RANK[member.side_effect_policy]
          && authorized.minimum_effect === 'irreversible') member.side_effect_policy = authorized.minimum_effect
    }
    const group: ParallelGroup = { nodeRunId: groupId, mode: opened.mode, quorum: opened.quorum, allowIrreversibleChildren: opened.allow_irreversible_children,
      childNodeRunIds: opened.members.map(member => member.node_run_id) }
    const state = deriveGroupState(group, members.map(toChild))
    const previousTimeout = tx.get("SELECT 1 FROM node_run_events WHERE node_run_id=? AND type='parallel.timeout'", [groupId])
    const timeout = Boolean(previousTimeout || groupClockExpired(tx, parent, members, clock))
    const inherited = parent.parent_node_run_id && isVerifiedParallelMembership(tx, secret, parent.parent_node_run_id, groupId)
      ? groupStopIntent(tx, groupId, parent.parent_node_run_id) : undefined
    if (timeout && !previousTimeout) appendNodeRunEvent(tx, secret, groupId, 'parallel.timeout', { pending_children: members.filter(child => !isTerminal(child.status)).map(child => child.node_run_id) })
    const successful = opened.mode === 'all'
      ? state.settled && members.every(child => child.status === 'done' || (child.status === 'superseded' && verifiedBranchSkip(tx, secret, runId, child.node_run_id)))
      : state.settled
    if (timeout || inherited || (successful && opened.mode !== 'all')) {
      const reason = inherited?.reason ?? (timeout ? 'group_timeout' : 'join_satisfied')
      for (const member of members) {
        if (!cancelDisposition(toChild(member)).cancel) continue
        const cancelled = cancelUnstartedMember(tx, secret, member, groupId, now, reason)
        if (cancelled) {
          member.status = cancelled
          member.side_effect_policy = 'pure'
        }
        else if (member.status === 'waiting' && member.node_type === 'subworkflow') {
          stop.push(...stopSubworkflowMember(tx, secret, runId, groupId, member, now, reason, clock))
        } else if (member.status === 'waiting' && member.node_type === 'parallel') {
          const nested = waitingGroups.get(member.node_run_id)
          if (recordGroupStop(tx, secret, member.node_run_id, groupId, reason) && nested) parents.push(nested)
        } else if (['dispatched','started','verifying'].includes(member.status)) {
          recordGroupStop(tx, secret, member.node_run_id, groupId, reason)
          stop.push({ nodeRunId: member.node_run_id, attempt: member.attempt, groupId })
        }
      }
    }
    const pending = members.filter(child => !isTerminal(child.status))
    if ((successful || timeout || inherited) && pending.length > 0) {
      const projection = { pending_children: pending.map(member => member.node_run_id), pending_irreversible_children: state.pendingIrreversible }
      const prior = tx.get<{ payload: string }>("SELECT payload FROM node_run_events WHERE node_run_id=? AND type='parallel.progress' ORDER BY seq DESC LIMIT 1", [groupId])
      if (prior?.payload !== JSON.stringify(projection)) appendNodeRunEvent(tx, secret, groupId, 'parallel.progress', projection)
    }
    if (state.settling || pending.length > 0) continue
    const tolerableFailure = (member: Member) => member.side_effect_policy === 'pure'
      && TOLERABLE_FAILURE.has(member.status)
    const tolerable = members.every(member => member.status === 'done' || tolerableFailure(member)
      || (member.status === 'superseded' && verifiedBranchSkip(tx, secret, runId, member.node_run_id)))
    const status = inherited ? 'superseded' : timeout ? 'timeout' : successful && tolerable ? 'done' : 'failed'
    const tolerated = status === 'done' && opened.mode !== 'all' ? members.filter(tolerableFailure).map(member => member.node_run_id) : []
    const children = members.map(member => ({ node_run_id: member.node_run_id, node_id: member.node_id, status: member.status,
      cancel_reason: stoppedByGroup(tx, member.node_run_id, groupId),
      partial_artifact: tx.get<{ artifact_id: string }>('SELECT artifact_id FROM artifact_contents WHERE node_run_id=? ORDER BY artifact_id LIMIT 1', [member.node_run_id])?.artifact_id ?? null,
    }))
    const effect = parent.parent_node_run_id ? members.reduce<SideEffectPolicy>((highest, member) =>
      EFFECT_RANK[member.side_effect_policy] > EFFECT_RANK[highest] ? member.side_effect_policy : highest, 'pure') : 'pure'
    applyTransition(tx, secret, { nodeRunId: groupId, from: ['waiting'], to: status,
      ruleId: status === 'done' ? 'M-63' : status === 'failed' ? 'M-64' : status === 'superseded' ? 'M-65' : 'M-22', attempt: parent.attempt, now,
      context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true, controlCompletion: true },
      patch: { wait_started_at: null, wait_deadline_at: null, wait_deadline_boot_id: null, wait_deadline_monotonic_ns: null,
        wait_remaining_ns: null, side_effect_policy: effect, side_effect_verified_none: 1 },
    })
    const output = { status, join: opened.mode, children, pending_children: [], tolerated_member_ids: tolerated }
    appendNodeRunEvent(tx, secret, groupId, 'parallel.result', output)
    appendNodeRunEvent(tx, secret, groupId, 'workflow.output', output)
    if (inherited) appendNodeRunEvent(tx, secret, groupId, 'parallel.member_cancelled', { group_id: parent.parent_node_run_id, reason: inherited.reason, from: 'waiting', to: status })
    waitingGroups.delete(groupId)
    const owner = parent.parent_node_run_id ? waitingGroups.get(parent.parent_node_run_id) : undefined
    if (owner) parents.push(owner)
  }
  pruneInactiveParallelPaths(tx, secret, runId, now)
  return [...new Map(stop.map(intent => [intent.nodeRunId,intent])).values()]
}

function stopSubworkflowMember(tx: Tx, secret: string, runId: string, groupId: string, member: Member,
  now: string, reason: string, clock?: ClockProvider): GroupStop[] {
  const bound = readBoundSubworkflowRun(tx, secret, runId, member.node_run_id)
  if (!bound) return []
  const descendants = tx.all<{ run_id: string; parent_run_id: string | null; parent_node_run_id: string | null }>(`WITH RECURSIVE scope(id) AS (
      SELECT ? UNION SELECT r.run_id FROM runs r JOIN scope s ON r.parent_run_id=s.id
    ) SELECT r.run_id,r.parent_run_id,r.parent_node_run_id FROM runs r JOIN scope s ON s.id=r.run_id`, [bound.id])
  if (descendants.some(run => !run.parent_run_id || !run.parent_node_run_id
      || readBoundSubworkflowRun(tx, secret, run.parent_run_id, run.parent_node_run_id)?.id !== run.run_id)) return []
  const subtree = tx.all<{ node_run_id: string; attempt: number; status: string; side_effect_policy: SideEffectPolicy; recovery_uncertain: string | null }>(`WITH RECURSIVE scope(id) AS (
      SELECT ? UNION SELECT r.run_id FROM runs r JOIN scope s ON r.parent_run_id=s.id
    ) SELECT n.node_run_id,n.attempt,n.status,n.side_effect_policy,n.recovery_uncertain FROM node_runs n JOIN scope s ON s.id=n.run_id`, [bound.id])
  if (subtree.some(node => node.recovery_uncertain !== null || (!isTerminal(node.status) && node.side_effect_policy === 'irreversible')
      || !intact(tx, secret, node.node_run_id, isTerminal(node.status)))) return []

  recordGroupStop(tx, secret, member.node_run_id, groupId, reason, { child_run_id: bound.id })
  if (clock && !bound.cancel_requested_at && !isRunTerminal(bound.status)) {
    const cancellation = propagateRunCancellation(tx, secret, { runId: bound.id, cancelResult: 'unknown', graceMs: 0, extendDeadlineMs: 30_000, now, clock })
    for (const nodeRunId of cancellation.cancelledNodes) {
      if (loadNodeRun(tx, nodeRunId).status === 'stopping') recordGroupStop(tx, secret, nodeRunId, groupId, reason, { member_id: member.node_run_id, child_run_id: bound.id })
    }
    closeRun(tx, secret, bound.id, now)
  }
  const child = tx.get<{ status: string }>('SELECT status FROM runs WHERE run_id=?', [bound.id])
  if (child && isRunTerminal(child.status)) {
    finishSubworkflowChild(tx, secret, { childRunId: bound.id, now, closeHealthyChild: true })
    const settled = loadNodeRun(tx, member.node_run_id)
    member.status = settled.status
    member.side_effect_policy = settled.side_effect_policy
  }
  return subtree.filter(node => requestedGroupStop(tx, node.node_run_id, groupId) && loadNodeRun(tx, node.node_run_id).status === 'stopping')
    .map(node => ({ nodeRunId: node.node_run_id, attempt: node.attempt, groupId }))
}

function cancelUnstartedMember(tx: Tx, secret: string, member: Member, groupId: string, now: string, reason: string): string | undefined {
  const before = member.status
  const isWaiting = before === 'waiting' && member.node_type === 'wait'
  const isApproval = before === 'blocked_pre' && !!member.blocked_decision_id && member.node_type === 'approval'
  const isBranch = before === 'blocked_post' && member.node_type === 'branch' && member.side_effect_policy === 'pure'
    && !!member.blocked_decision_id && !!tx.get("SELECT 1 FROM decisions WHERE decision_id=? AND node_run_id=? AND kind='rule_ambiguous'",
      [member.blocked_decision_id,member.node_run_id])
  if (!isWaiting && !isApproval && !isBranch && !['queued','leased'].includes(before)) return undefined
  const current = loadNodeRun(tx, member.node_run_id)
  if (isWaiting) cancelWait(tx, member.node_run_id, now)
  if ((isApproval || isBranch) && !cancelDecision(tx, secret, { decisionId: member.blocked_decision_id!, now, reason: 'cancelled' }).changed) return undefined
  const next = isApproval || isBranch ? 'failed' : 'superseded'
  applyTransition(tx, secret, { nodeRunId: member.node_run_id, from: [before as 'waiting' | 'blocked_pre' | 'blocked_post' | 'queued' | 'leased'], to: next,
    ruleId: isWaiting ? 'M-65' : isApproval ? 'M-41' : isBranch ? 'M-43' : 'M-62', attempt: member.attempt, expectedRevision: current.revision, now,
    context: { hasToolCall: false, cancelResult: null, hangReason: null, sideEffectVerifiedNone: true, controlCompletion: true },
    patch: { blocked_decision_id: null, wait_started_at: null, side_effect_policy: 'pure', side_effect_verified_none: 1 },
  })
  releaseLease(tx, { nodeRunId: member.node_run_id, now })
  appendNodeRunEvent(tx, secret, member.node_run_id, 'parallel.member_cancelled', { group_id: groupId, reason, from: before, to: next })
  return next
}

export function groupStopIntent(tx: ReadTx, memberId: string, groupId: string) {
  return tx.get<{ reason: string; member_id: string | null; child_run_id: string | null }>(`SELECT json_extract(payload,'$.reason') AS reason,
    json_extract(payload,'$.member_id') AS member_id,json_extract(payload,'$.child_run_id') AS child_run_id FROM node_run_events
    WHERE node_run_id=? AND type='parallel.cancel_requested' AND json_extract(payload,'$.group_id')=? ORDER BY seq DESC LIMIT 1`, [memberId,groupId])
}

function recordGroupStop(tx: Tx, secret: string, nodeRunId: string, groupId: string, reason: string, binding?: { member_id?: string; child_run_id: string }): boolean {
  if (groupStopIntent(tx, nodeRunId, groupId)) return false
  appendNodeRunEvent(tx, secret, nodeRunId, 'parallel.cancel_requested', { group_id: groupId, reason, ...binding })
  return true
}

export function requestedGroupStop(tx: ReadTx, memberId: string, groupId: string): boolean {
  return !!groupStopIntent(tx, memberId, groupId)
}

export function verifiedPropagatedGroupStop(tx: ReadTx, secret: string, groupId: string, targetRunId: string, memberId: string, childRunId: string): boolean {
  const owner = tx.get<{ run_id: string }>("SELECT run_id FROM node_runs WHERE node_run_id=? AND node_type='parallel' AND status='waiting'", [groupId])
  if (!owner || !isVerifiedParallelMembership(tx, secret, groupId, memberId)
      || readBoundSubworkflowRun(tx, secret, owner.run_id, memberId)?.id !== childRunId
      || groupStopIntent(tx, memberId, groupId)?.child_run_id !== childRunId) return false
  return !!tx.get(`WITH RECURSIVE scope(id) AS (SELECT ? UNION SELECT r.run_id FROM runs r JOIN scope s ON r.parent_run_id=s.id)
    SELECT 1 FROM scope WHERE id=?`, [childRunId,targetRunId])
}

function stoppedByGroup(tx: ReadTx, memberId: string, groupId: string): string | null {
  return tx.get<{ reason: string }>("SELECT json_extract(payload,'$.reason') AS reason FROM node_run_events WHERE node_run_id=? AND type='parallel.member_cancelled' AND json_extract(payload,'$.group_id')=? ORDER BY seq DESC LIMIT 1",
    [memberId,groupId])?.reason ?? null
}
