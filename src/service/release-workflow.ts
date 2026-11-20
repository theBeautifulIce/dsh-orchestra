import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import type { ClockProvider } from '../core/clock.ts'
import type { WorkflowDefinition } from '../core/workflow-def.ts'
import {
  judgeReleaseEvidence, normalizeReleaseManifest, RELEASE_CHECK_WORKFLOW_ID, RELEASE_COORDINATOR_ID, RELEASE_GROUPS,
  RELEASE_VERSION, RELEASE_WORKFLOW_ID, releaseHash, type ReleaseEvidenceReader,
  type ReleaseGroup, type ReleasePolicyResult,
} from '../core/wf-release-v1.ts'
import { appendEvent, appendNodeRunEvent, assertChainIntact } from '../infra/db/ledger.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { acquireLease, loadNodeRun, releaseLease } from './commands/lease.ts'
import { applyTransition } from './commands/nodes.ts'
import { closeRun } from './commands/run-close.ts'
import { finishSubworkflowChild, startSubworkflowNode } from './commands/subworkflow.ts'
import { enterWaiting, getWaitRegistration, timeoutWaiting, wakeOnEvent } from './commands/wait.ts'
import { requestHashOf, runIdempotentCommand } from './commands/idempotency.ts'
import { createRunInTx } from './runs.ts'
import { releaseRunAuthority } from './release-authority.ts'
import { definitionHashOf, type WorkflowCatalog } from './workflows.ts'
import type { ReadTx } from './queries/read-tx.ts'

const groups = Object.keys(RELEASE_GROUPS) as ReleaseGroup[]
const COLLECTION_EVENT = 'release.groups_complete'
const cohort = { wait_kind: 'event' as const, match: { type: COLLECTION_EVENT }, max_wait_ms: 20 * 60_000 }
export const releaseCheckDefinition: WorkflowDefinition = {
  workflow_id: RELEASE_CHECK_WORKFLOW_ID, workflow_version: RELEASE_VERSION,
  nodes: [{ node_id: 'check', type: 'agent', side_effect_policy: 'pure', tools: { allow: [RELEASE_CHECK_WORKFLOW_ID] },
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }] }],
}
export const releaseWorkflowDefinition: WorkflowDefinition = {
  workflow_id: RELEASE_WORKFLOW_ID, workflow_version: RELEASE_VERSION,
  nodes: [
    { node_id: 'arrange', type: 'decision' },
    ...groups.map((node_id) => ({ node_id, type: 'subworkflow' as const,
      subworkflow: { workflow_id: RELEASE_CHECK_WORKFLOW_ID, pinned_version: 1 } })),
    { node_id: 'collect', type: 'wait', wait: cohort },
    { node_id: RELEASE_COORDINATOR_ID, type: 'decision' },
  ],
  edges: [
    ...groups.map((to) => ({ from: 'arrange', to })),
    { from: 'arrange', to: 'collect' },
    { from: 'collect', to: RELEASE_COORDINATOR_ID },
  ],
}
export const releaseDefinitionHash = definitionHashOf(releaseWorkflowDefinition)
const releaseCheckHash = definitionHashOf(releaseCheckDefinition)
export type ReleaseGateCardState = 'idle' | 'checking' | 'approval' | 'blocked' | 'failed' | 'confirmed'

export function readReleaseGateCard(tx: ReadTx): ReleaseGateCardState {
  const row = tx.get<{ status: string; run_id: string }>(
    'SELECT status,run_id FROM runs WHERE workflow_id=? AND workflow_definition_hash=? AND parent_run_id IS NULL'
    + ' ORDER BY created_at DESC,run_id DESC LIMIT 1', [RELEASE_WORKFLOW_ID, releaseDefinitionHash])
  if (!row) return 'idle'
  if (row.status === 'succeeded') return 'confirmed'
  if (row.status === 'paused') return 'blocked'
  if (row.status !== 'running') return 'failed'
  const pending = tx.get("SELECT 1 FROM node_runs n JOIN node_run_events e USING(node_run_id) WHERE n.run_id=?"
    + " AND n.node_id=? AND n.status='queued' AND e.type='release.policy' AND json_extract(e.payload,'$.conclusion')='pass'",
  [row.run_id, RELEASE_COORDINATOR_ID])
  return pending ? 'approval' : 'checking'
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/).refine((value) => !/^0+$/.test(value))
const id = z.string().trim().min(1).max(128)
const principal = z.string().regex(/^human:\S.*$/)
const approvedReceipt = z.strictObject({ principal, approval_id: id, confirmation_id: id, confirmed_at: z.iso.datetime(), expires_at: z.iso.datetime() })
const toolReceipt = z.strictObject({ execution_id: id, command_hash: hex64, stdout_hash: hex64, exit_code: z.literal(0) })
type ToolReceipt = z.infer<typeof toolReceipt>
type BoundEvidence = Pick<ReleasePolicyResult, 'manifest_hash' | 'candidate_hash' | 'evidence_index_hash'>
type ReleaseRun = { run_id: string; status: string; cancel_requested_at: string | null }

/** Only a server-owned isolated workspace can install these ports. No HTTP payload supplies a principal, command, reader, or receipt. */
export type ReleaseWorkspace = {
  authorizeStart(credential: unknown): unknown
  frozenEvidence(): { manifest: unknown; reader: ReleaseEvidenceReader }
  runGroup(request: BoundEvidence & { group: ReleaseGroup; child_run_id: string; check_node_run_id: string }): Promise<void>
  verifyGroup(request: BoundEvidence & { group: ReleaseGroup; child_run_id: string; execution: ToolReceipt }): boolean
  verifyApproval(credential: unknown, challenge: BoundEvidence & { run_id: string; judgement_hash: string }): unknown
}

function deny(message: string): never {
  throw new OrchError('FORBIDDEN', message)
}

function eventData<T>(tx: Pick<Tx, 'get'>, nodeRunId: string, kind: string): T | undefined {
  const event = tx.get<{ payload: string }>('SELECT payload FROM node_run_events WHERE node_run_id=? AND type=? ORDER BY seq DESC LIMIT 1', [nodeRunId, kind])
  return event && JSON.parse(event.payload) as T
}

export function createReleaseWorkflowHost(deps: { db: Db; secret: string; catalog: WorkflowCatalog; clock: ClockProvider; workspace: ReleaseWorkspace }) {
  const { db, secret, catalog, clock, workspace } = deps
  catalog.requireWorkflowCapability(RELEASE_WORKFLOW_ID)
  catalog.load(releaseCheckDefinition)
  catalog.load(releaseWorkflowDefinition)
  const runningGroups = new Set<string>()
  function frozen() {
    const source = workspace.frozenEvidence()
    const manifest = normalizeReleaseManifest(source.manifest)
    return { manifest, reader: source.reader, manifest_hash: releaseHash(manifest),
      candidate_hash: releaseHash(manifest.candidate),
      evidence_index_hash: releaseHash({ evidence_index: manifest.evidence.map(({ evidence_id, sha256, strength, source }) =>
        ({ evidence_id, sha256, strength, source })) }) }
  }
  function run(tx: Tx, runId: string): ReleaseRun {
    const root = tx.get<ReleaseRun>(
      "SELECT run_id,status,cancel_requested_at FROM runs WHERE run_id=? AND workflow_id=? AND CAST(workflow_version AS TEXT)=?"
      + ' AND workflow_definition_hash=? AND parent_run_id IS NULL',
    [runId, RELEASE_WORKFLOW_ID, RELEASE_VERSION, releaseDefinitionHash])
    if (!root) return deny('释放入口只接受固定注册的发布运行')
    return root
  }
  function node(tx: Tx, runId: string, role: string) {
    const item = tx.get<{ node_run_id: string }>('SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id=? AND replacement_node_run_id IS NULL', [runId, role])
    if (!item) return deny('发布运行的固定步骤缺失')
    return loadNodeRun(tx, item.node_run_id)
  }
  function startControl(tx: Tx, nodeId: string, now: string) {
    const row = loadNodeRun(tx, nodeId)
    if (row.node_type === 'decision') tx.run("UPDATE node_runs SET side_effect_policy='pure' WHERE node_run_id=?", [nodeId])
    acquireLease(tx, secret, { nodeRunId: nodeId, ownerEpoch: db.epoch, leaseTtlMs: 10_000, now })
    applyTransition(tx, secret, { nodeRunId: nodeId, attempt: row.attempt, from: ['dispatched'], to: 'started', ruleId: 'M-04', now })
  }
  function finishControl(tx: Tx, nodeId: string, now: string, passed = true) {
    const row = loadNodeRun(tx, nodeId)
    applyTransition(tx, secret, { nodeRunId: nodeId, attempt: row.attempt, from: ['started'], to: 'verifying', ruleId: 'M-15', now })
    applyTransition(tx, secret, { nodeRunId: nodeId, attempt: row.attempt, from: ['verifying'], to: passed ? 'done' : 'failed', ruleId: 'M-16', now })
    releaseLease(tx, { nodeRunId: nodeId, now })
  }
  function ensureFrozen(tx: Tx, runId: string, binding: BoundEvidence) {
    const arrange = node(tx, runId, 'arrange')
    assertChainIntact(tx, secret, arrange.node_run_id)
    const expected = eventData<BoundEvidence>(tx, arrange.node_run_id, 'release.frozen')
    if (!expected || expected.manifest_hash !== binding.manifest_hash || expected.candidate_hash !== binding.candidate_hash
      || expected.evidence_index_hash !== binding.evidence_index_hash) return deny('发布运行的候选与冻结证据已变化')
  }
  function childOf(tx: Tx, runId: string, group: ReleaseGroup) {
    return tx.get<{ run_id: string; status: string }>(
      'SELECT r.run_id,r.status FROM runs r JOIN node_runs parent ON parent.node_run_id=r.parent_node_run_id'
      + ' WHERE r.parent_run_id=? AND parent.run_id=? AND parent.node_id=? AND r.workflow_id=? AND r.workflow_definition_hash=?',
    [runId, runId, group, RELEASE_CHECK_WORKFLOW_ID, releaseCheckHash])
  }
  function inspectGroup(tx: Tx, runId: string, group: ReleaseGroup, binding: BoundEvidence, now: string) {
    const child = childOf(tx, runId, group)
    if (child?.status !== 'succeeded') return false
    const check = node(tx, child.run_id, 'check')
    if (check.status !== 'done') return false
    assertChainIntact(tx, secret, check.node_run_id)
    const executions = tx.all('SELECT execution_id,command_hash,stdout_hash,exit_code FROM tool_executions WHERE node_run_id=? AND attempt=? AND tool=?',
      [check.node_run_id, check.attempt, RELEASE_CHECK_WORKFLOW_ID])
    const evidence = toolReceipt.safeParse(executions[0])
    if (executions.length !== 1 || !evidence.success || !workspace.verifyGroup({ ...binding, group, child_run_id: child.run_id, execution: evidence.data })) return false
    const groupNode = node(tx, runId, group)
    if (groupNode.status === 'waiting') finishSubworkflowChild(tx, secret, { childRunId: child.run_id, now })
    if (!eventData(tx, groupNode.node_run_id, 'release.group_verified')) {
      appendNodeRunEvent(tx, secret, groupNode.node_run_id, 'release.group_verified', { ...binding, group, child_run_id: child.run_id, ...evidence.data })
    }
    return true
  }
  const bindingOnly = ({ manifest_hash, candidate_hash, evidence_index_hash }: BoundEvidence): BoundEvidence => ({ manifest_hash, candidate_hash, evidence_index_hash })
  return {
    start(input: { operation_id: string }, credential: unknown, now: string) {
      const actor = principal.safeParse(workspace.authorizeStart(credential))
      if (!actor.success) return deny('未认证的工作区主体不能启动发布运行')
      const observed = frozen()
      const binding = bindingOnly(observed)
      return withTx(db, (tx) => runIdempotentCommand(tx, { kind: 'release.start', operationId: input.operation_id, now,
        requestHash: requestHashOf('release.start', { actor: actor.data, ...binding }) }, () => {
        if (tx.get("SELECT 1 FROM runs WHERE workflow_id=? AND parent_run_id IS NULL AND status IN ('running','paused')", [RELEASE_WORKFLOW_ID])) {
          throw new OrchError('COMMAND_BUSY', '已有核验运行等待检查或处置')
        }
        const root = createRunInTx(tx, catalog, { taskTitle: 'G6 发布核验', workflowVersion: RELEASE_VERSION,
          workflowId: RELEASE_WORKFLOW_ID, now, autonomy: 'supervised' }, undefined, undefined, releaseRunAuthority)
        const arrange = node(tx, root.run_id, 'arrange')
        startControl(tx, arrange.node_run_id, now)
        appendNodeRunEvent(tx, secret, arrange.node_run_id, 'release.frozen', { ...binding, groups, principal: actor.data })
        finishControl(tx, arrange.node_run_id, now)
        const collect = node(tx, root.run_id, 'collect')
        startControl(tx, collect.node_run_id, now)
        enterWaiting(tx, secret, { nodeRunId: collect.node_run_id, attempt: collect.attempt, runId: root.run_id, waitKind: 'event',
          match: cohort.match, idempotencyKey: 'release-collection:' + root.run_id, maxWaitMs: cohort.max_wait_ms, now, clock })
        for (const group of groups) {
          const parent = node(tx, root.run_id, group)
          startControl(tx, parent.node_run_id, now)
          startSubworkflowNode(tx, secret, catalog, { nodeRunId: parent.node_run_id, attempt: parent.attempt,
            workflowId: RELEASE_CHECK_WORKFLOW_ID, workflowVersion: RELEASE_VERSION, now })
        }
        return { run_id: root.run_id, ...binding }
      }).result)
    },
    async advance(runId: string, now: string) {
      const observed = frozen()
      const binding = bindingOnly(observed)
      const ready = withTx(db, (tx) => {
        ensureFrozen(tx, runId, binding)
        const root = run(tx, runId)
        if (root.status !== 'running' || root.cancel_requested_at) return []
        return groups.flatMap((group) => {
          const child = childOf(tx, runId, group)
          if (!child || child.status !== 'running') return []
          const check = node(tx, child.run_id, 'check')
          return check.status === 'queued' ? [{ group, child_run_id: child.run_id, check_node_run_id: check.node_run_id }] : []
        })
      })
      await Promise.allSettled(ready.map(async (group) => {
        if (runningGroups.has(group.child_run_id)) return
        runningGroups.add(group.child_run_id)
        try {
          await workspace.runGroup({ ...binding, ...group })
          withTx(db, (tx) => {
            const root = run(tx, runId)
            const completed = new Date().toISOString()
            const collect = node(tx, runId, 'collect')
            if (root.status === 'running' && !root.cancel_requested_at && getWaitRegistration(tx, collect.node_run_id)?.state === 'active'
              && !timeoutWaiting(tx, secret, collect.node_run_id, completed, clock)) {
              inspectGroup(tx, runId, group.group, binding, completed)
            }
          })
        }
        finally { runningGroups.delete(group.child_run_id) }
      }))
      const fresh = frozen()
      const judged = judgeReleaseEvidence(fresh.manifest, fresh.reader)
      return withTx(db, (tx) => {
        ensureFrozen(tx, runId, judged)
        const root = run(tx, runId)
        if (root.status !== 'running' || root.cancel_requested_at) return { status: root.status }
        const collect = node(tx, runId, 'collect')
        if (getWaitRegistration(tx, collect.node_run_id)?.state === 'timed_out'
          || timeoutWaiting(tx, secret, collect.node_run_id, now, clock)) {
          const missing = groups.filter((group) => !eventData(tx, node(tx, runId, group).node_run_id, 'release.group_verified'))
          tx.run("UPDATE runs SET status='paused',display_status='blocked',revision=revision+1,updated_at=? WHERE run_id=? AND status='running'", [now, runId])
          appendEvent(tx, { type: 'release.groups_missing', runId, payload: { missing } })
          return { status: 'blocked', missing }
        }
        const missing = groups.filter((group) => !inspectGroup(tx, runId, group, binding, now))
        if (missing.length) return { status: 'waiting', missing }
        if (collect.status === 'waiting') wakeOnEvent(tx, secret, { runId, eventType: COLLECTION_EVENT, idempotencyKey: 'release-complete:' + runId, now })
        if (node(tx, runId, 'collect').status !== 'done') return deny('所有检查组尚未经收口等待确认')
        const coordinator = node(tx, runId, RELEASE_COORDINATOR_ID)
        const judgement_hash = releaseHash(judged)
        const existing = eventData<{ judgement_hash: string }>(tx, coordinator.node_run_id, 'release.policy')
        if (existing && existing.judgement_hash !== judgement_hash) return deny('发布判卷后的证据已改变')
        if (!existing) {
          appendNodeRunEvent(tx, secret, coordinator.node_run_id, 'release.policy', { manifest_hash: judged.manifest_hash, judgement_hash, conclusion: judged.conclusion })
          if (judged.conclusion === 'fail') {
            startControl(tx, coordinator.node_run_id, now)
            finishControl(tx, coordinator.node_run_id, now, false)
            closeRun(tx, secret, runId, now)
          }
        }
        return { status: judged.conclusion === 'pass' ? 'awaiting_approval' : 'failed', judgement_hash }
      })
    },
    approve(runId: string, credential: unknown, operationId: string, now: string) {
      const source = frozen()
      const judged = judgeReleaseEvidence(source.manifest, source.reader)
      const binding = bindingOnly(judged)
      const judgement_hash = releaseHash(judged)
      const authorised = approvedReceipt.safeParse(workspace.verifyApproval(credential, { ...binding, run_id: runId, judgement_hash }))
      if (!authorised.success || authorised.data.approval_id === authorised.data.confirmation_id
        || Date.parse(authorised.data.confirmed_at) > Date.parse(now) || Date.parse(authorised.data.expires_at) <= Date.parse(now)) {
        return deny('发布运行需要有效的实名二次确认')
      }
      const proof = authorised.data
      return withTx(db, (tx) => runIdempotentCommand(tx, { kind: 'release.approve', operationId, now,
        requestHash: requestHashOf('release.approve', { runId, ...binding, proof }) }, () => {
        const root = run(tx, runId)
        if (root.status !== 'running' || root.cancel_requested_at) return deny('发布运行已暂停或终止')
        ensureFrozen(tx, runId, binding)
        const coordinator = node(tx, runId, RELEASE_COORDINATOR_ID)
        const recorded = eventData<{ judgement_hash: string; conclusion: string }>(tx, coordinator.node_run_id, 'release.policy')
        if (judged.conclusion !== 'pass' || recorded?.judgement_hash !== judgement_hash || recorded.conclusion !== 'pass'
          || coordinator.status !== 'queued' || node(tx, runId, 'collect').status !== 'done') return deny('发布判卷或动态证据未满足审批条件')
        if (groups.some((group) => !inspectGroup(tx, runId, group, binding, now))) return deny('审批前需回读六组有效证据')
        for (const [kind, key] of [['approval', proof.approval_id], ['confirmation', proof.confirmation_id]]) {
          const idempotencyKey = 'release.' + kind + ':' + key
          if (tx.get('SELECT 1 FROM events WHERE idempotency_key=?', [idempotencyKey])) return deny('发布审批或二次确认已经使用')
          appendEvent(tx, { type: 'release.' + kind, runId, idempotencyKey, payload: { principal: proof.principal, judgement_hash } })
        }
        startControl(tx, coordinator.node_run_id, now)
        appendNodeRunEvent(tx, secret, coordinator.node_run_id, 'release.approved', { ...proof, ...binding, judgement_hash })
        appendNodeRunEvent(tx, secret, coordinator.node_run_id, 'release.branch', { manifest_hash: binding.manifest_hash, judgement_hash,
          approval_id: proof.approval_id, branch: 'eligible' })
        finishControl(tx, coordinator.node_run_id, now)
        const status = closeRun(tx, secret, runId, now)
        if (status !== 'succeeded') return deny('已判卷的发布运行未达严格成功终态')
        return { run_id: runId, status }
      }).result)
    },
  }
}
