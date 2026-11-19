import { z } from 'zod'
import { sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { uuidv7 } from '../core/ids.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand, UUID_V7_RE } from './commands/idempotency.ts'
import { readStrongEvidence } from './queries/evidence.ts'
import { closeRun, isRunTerminal } from './commands/run-close.ts'
import { reviewOwnership } from './delivery-review.ts'
import { runtimeEdges } from './rework-edges.ts'
import { propagateRunCancellation } from './commands/subworkflow.ts'
import type { ClockProvider } from '../core/clock.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'
import { authorizeReworkRuntime, acceptReworkRuntime, prepareReworkReviewer, previewReworkImpact } from './rework-runtime.ts'
export type ReworkBinding = {
  node_run_id: string
  attempt: number
  action_generation: number
}
export type ReworkActor = string | ReworkBinding
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const scope = z.enum(['targeted_revision', 'rerun_node', 'replan_subgraph'])
export const reworkRequestSchema = z.strictObject({
  operation_id: z.string().regex(UUID_V7_RE), run_id: id, target_node_run_id: id,
  source_artifact_id: id, source_artifact_hash: hash, expected_revision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(2500), expected_result: z.string().trim().min(1).max(2500),
  preserve_requirements: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  suggested_scope: scope.default('targeted_revision'), evidence_ids: z.array(id).max(20).default([]),
  verification_request_id: id.optional(),
})
export const reworkReviewSchema = z.strictObject({
  operation_id: z.string().regex(UUID_V7_RE), request_id: id, expected_revision: z.number().int().positive(),
  action: z.enum(['authorize', 'reject', 'reject_final', 'accept', 'request_changes', 'escalate']),
  note: z.string().trim().min(1).max(2500), artifact_id: id.optional(), artifact_hash: hash.optional(),
  evidence_ids: z.array(id).max(20).default([]),
})
export type ReworkRequest = {
  request_id: string
  run_id: string
  requester_node_run_id: string | null
  requester_actor: string
  owner_actor: string
  target_node_run_id: string
  target_attempt: number
  source_artifact_id: string
  source_artifact_hash: string
  reason: string
  expected_result: string
  preserve_requirements_json: string
  suggested_scope: string
  approved_scope: string | null
  status: string
  revision: number
  round_no: number
  max_rounds: number
  budget_remaining: number
  new_node_run_id: string | null
  evidence_ids_json: string
  verification_request_id: string | null
  expires_at: string
  created_at: string
  updated_at: string
}
export type ReworkAttempt = {
  attempt_id: string
  request_id: string
  round_no: number
  old_node_run_id: string
  new_node_run_id: string
  source_artifact_id: string
  source_artifact_hash: string
  result_artifact_id: string | null
  result_artifact_hash: string | null
  status: string
  feedback: string
  created_at: string
  reviewed_at: string | null
}
export type ReworkReview = {
  review_id: string
  request_id: string
  round_no: number
  reviewer_actor: string
  artifact_id: string | null
  artifact_hash: string | null
  action: string
  note: string
  evidence_ids_json: string
  created_at: string
}
type Node = ReworkBinding & {
  run_id: string
  node_id: string
  status: string
  revision: number
  replacement_node_run_id: string | null
  node_type: string
  side_effect_policy: string
}
const inactive = new Set(['closed', 'declined', 'cancelled'])
export function loadReworkRequest(tx: ReadTx, requestId: string): ReworkRequest {
  const row = tx.get<ReworkRequest>('SELECT * FROM rework_requests WHERE request_id=?', [requestId])
  if (!row)
    throw new OrchError('NOT_FOUND', '找不到返工请求')
  return row
}
function loadNode(tx: ReadTx, nodeId: string): Node {
  const row = tx.get<Node>('SELECT * FROM node_runs WHERE node_run_id=?', [nodeId])
  if (!row)
    throw new OrchError('NOT_FOUND', '找不到执行节点')
  return row
}
function bound(tx: ReadTx, actor: ReworkBinding): Node {
  const node = loadNode(tx, actor.node_run_id)
  if (node.attempt !== actor.attempt || node.action_generation !== actor.action_generation || !['started', 'verifying'].includes(node.status) || node.replacement_node_run_id)
    throw new OrchError('FORBIDDEN', '返工工具只能由当前执行主体调用')
  return node
}
function active(tx: ReadTx, runId: string) {
  const run = tx.get<{
    status: string
    cancel_requested_at: string | null
  }>('SELECT status,cancel_requested_at FROM runs WHERE run_id=?', [runId])
  if (run?.status !== 'running' || run.cancel_requested_at)
    throw new OrchError('STALE_GENERATION', '返工只允许操作活动运行')
}
function actorKey(actor: ReworkActor) { return typeof actor === 'string' ? actor : 'agent:' + actor.node_run_id + ':' + actor.attempt + ':' + actor.action_generation; }
export function assertReworkOwner(tx: ReadTx, request: ReworkRequest, actor: string) {
  if (request.owner_actor !== actor)
    throw new OrchError('FORBIDDEN', '只有任务宿主负责人可授权返工')
}
function access(tx: ReadTx, request: ReworkRequest, actor: ReworkActor, mutate = false) {
  if (typeof actor === 'string')
    return assertReworkOwner(tx, request, actor)
  const node = mutate ? bound(tx, actor) : loadNode(tx, actor.node_run_id)
  const requester = request.requester_node_run_id ? loadNode(tx, request.requester_node_run_id) : null
  const target = loadNode(tx, request.target_node_run_id)
  if (node.run_id !== request.run_id || (!requester || node.node_id !== requester.node_id) && node.node_id !== target.node_id)
    throw new OrchError('FORBIDDEN', '无权访问该返工请求')
}
function artifact(tx: ReadTx, runId: string, nodeId: string, artifactId: string, expectedHash: string, now?: string) {
  const row = tx.get<{
    sha256: string
    bytes: Uint8Array
  }>('SELECT a.sha256,c.bytes FROM artifacts a JOIN artifact_contents c ON c.artifact_id=a.artifact_id WHERE a.artifact_id=? AND a.run_id=? AND c.node_run_id=? AND (? IS NULL OR a.retain_until IS NULL OR a.retain_until>?)', [artifactId, runId, nodeId, now ?? null, now ?? null])
  if (!row || row.sha256 !== expectedHash || sha256Hex(Buffer.from(row.bytes)) !== expectedHash)
    throw new OrchError('STALE_GENERATION', '成果版本或实际内容哈希不匹配')
}
function evidence(tx: ReadTx, secret: string, actor: ReworkActor, ids: string[], after?: string) {
  if (typeof actor !== 'string' && ids.length === 0)
    throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', 'Agent 反馈必须提供可信执行证据')
  for (const id of ids) {
    const item = readStrongEvidence(tx, secret, id).item
    if (typeof actor !== 'string' && (item.node_run_id !== actor.node_run_id || item.attempt !== actor.attempt || (after && item.observed_at < after)))
      throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '证据必须由当前审核主体在修订后产生')
  }
}
function event(tx: Tx, row: ReworkRequest, action: string) { appendEvent(tx, { type: 'rework.' + action, runId: row.run_id, nodeRunId: row.new_node_run_id ?? row.target_node_run_id, payload: { request_id: row.request_id, status: row.status, revision: row.revision, round_no: row.round_no } }); }
function schedule(tx: Tx, secret: string, row: ReworkRequest, now: string, approvedPlan = false, workUnits = 1): ReworkRequest {
  if (row.suggested_scope === 'replan_subgraph' && !approvedPlan)
    throw new OrchError('FORBIDDEN', '局部重规划必须通过独立方案审核')
  if (row.budget_remaining <= 0 || row.round_no > row.max_rounds)
    throw new OrchError('FORBIDDEN', '返工预算或轮数已耗尽，需人工处理')
  if (!Number.isSafeInteger(workUnits) || workUnits < 1 || workUnits > row.budget_remaining) throw new OrchError('FORBIDDEN','局部方案的执行工作量超过剩余返工预算')
  artifact(tx, row.run_id, row.target_node_run_id, row.source_artifact_id, row.source_artifact_hash, now)
  if (row.suggested_scope === 'targeted_revision' && (tx.get<{
    n: number
  }>('SELECT COUNT(*) AS n FROM artifact_contents WHERE node_run_id=?', [row.target_node_run_id])?.n ?? 0) !== 1)
    throw new OrchError('FORBIDDEN', '多个原始成果需要明确保留方案，不能自动用单一修订成果替换')
  tx.run("UPDATE rework_requests SET status='authorized' WHERE request_id=? AND revision=?", [row.request_id, row.revision])
  const next = authorizeReworkRuntime(tx, secret, { ...row, status: 'authorized' }, now)
  tx.run('INSERT INTO rework_attempts (attempt_id,request_id,round_no,old_node_run_id,new_node_run_id,source_artifact_id,source_artifact_hash,status,feedback,created_at) VALUES (?,?,?,?,?,?,?,\'scheduled\',?,?)', [uuidv7(), row.request_id, row.round_no, row.target_node_run_id, next, row.source_artifact_id, row.source_artifact_hash, row.reason, now])
  tx.run("UPDATE rework_requests SET status='scheduled',approved_scope=suggested_scope,new_node_run_id=?,budget_remaining=budget_remaining-?,revision=revision+1,updated_at=? WHERE request_id=? AND revision=?", [next, workUnits, now, row.request_id, row.revision])
  return loadReworkRequest(tx, row.request_id)
}
/** Called only after the planner persisted its exact human-approved bounded proposal. */
export function authorizeReworkPlanInTx(tx: Tx, secret: string, row: ReworkRequest, actor: string, now: string, workUnits = 1): ReworkRequest {
  assertReworkOwner(tx, row, actor)
  active(tx, row.run_id)
  const current = loadReworkRequest(tx, row.request_id)
  if (current.revision !== row.revision || !['proposed', 'needs_human_approval'].includes(current.status) || now >= current.expires_at)
    throw new OrchError('STALE_GENERATION', '局部方案对应的返工状态已变化')
  if (!tx.get('SELECT 1 FROM rework_local_plans WHERE request_id=? AND revision=? AND approved_by=?', [row.request_id, row.revision, actor]))
    throw new OrchError('FORBIDDEN', '局部方案尚未获得当前负责人授权')
  const scheduled = schedule(tx, secret, { ...current, suggested_scope: 'replan_subgraph' }, now, true, workUnits)
  tx.run("UPDATE rework_requests SET approved_scope='replan_subgraph' WHERE request_id=?", [row.request_id])
  event(tx, scheduled, 'plan_authorized')
  return loadReworkRequest(tx, row.request_id)
}
export function createReworkHost(db: Db, secret: string, options: {clock?: ClockProvider} = {}) {
  const submitRequest = (tx: Tx, body: z.output<typeof reworkRequestSchema>, actor: ReworkActor, now: string, planner = false): ReworkRequest => {
    active(tx, body.run_id)
    const target = loadNode(tx, body.target_node_run_id)
    if (target.run_id !== body.run_id || target.status !== 'done' || target.replacement_node_run_id || target.revision !== body.expected_revision || target.node_type !== 'agent')
      throw new OrchError('STALE_GENERATION', '返工目标必须是当前已完成的 Agent 成果')
    const { owner } = reviewOwnership(tx, secret, body.run_id)
    if (typeof actor === 'string') {
      if (actor !== owner)
        throw new OrchError('FORBIDDEN', '只有任务宿主负责人可提出返工')
    }
    else {
      const source = bound(tx, actor)
      const def = tx.get<{
        definition_json: string
      }>('SELECT v.definition_json FROM workflow_versions v JOIN runs r ON r.workflow_id=v.workflow_id AND r.workflow_version=v.version WHERE r.run_id=?', [body.run_id])
      const pinnedEdges = def ? (JSON.parse(def.definition_json) as {
        edges?: Array<{
          from: string
          to: string
        }>
      }).edges ?? [] : []
      const edges = runtimeEdges(tx, body.run_id, pinnedEdges)
      const seen = new Set([target.node_id])
      for (let old = -1; old !== seen.size;) {
        old = seen.size
        for (const edge of edges)
          if (seen.has(edge.from))
            seen.add(edge.to)
      }
      if (source.run_id !== target.run_id || source.node_id === target.node_id || !seen.has(source.node_id))
        throw new OrchError('FORBIDDEN', 'Agent 只能反馈当前运行中有依赖关系的上游成果')
    }
    artifact(tx, body.run_id, target.node_run_id, body.source_artifact_id, body.source_artifact_hash, now)
    evidence(tx, secret, actor, body.evidence_ids)
    if (body.verification_request_id) {
      const verification = tx.get<{
        target_node_run_id: string
        target_attempt: number
        evidence_id: string
        source_node_run_id: string
      }>(`SELECT v.target_node_run_id,v.target_attempt,v.evidence_id,f.source_node_run_id
   FROM collaboration_requests v JOIN collaboration_findings f ON f.finding_id=v.finding_id
   JOIN collaboration_scopes s ON s.scope_id=v.scope_id
   WHERE v.request_id=? AND v.status='completed' AND v.verdict='confirmed' AND v.adoption='adopted' AND s.owner_actor=?`, [body.verification_request_id, owner])
      if (!verification)
        throw new OrchError('FORBIDDEN', '返工依据必须是已确认并采纳的独立核验')
      const findingSource = loadNode(tx, verification.source_node_run_id)
      const verifier = loadNode(tx, verification.target_node_run_id)
      const feedbackNode = typeof actor === 'string' ? null : loadNode(tx, actor.node_run_id)
      if (findingSource.run_id !== body.run_id || verifier.run_id !== body.run_id || (findingSource.node_id !== target.node_id && findingSource.node_id !== feedbackNode?.node_id))
        throw new OrchError('FORBIDDEN', '独立核验与当前成果或反馈主体无关')
      const verifiedEvidence = readStrongEvidence(tx, secret, verification.evidence_id).item
      if (verifiedEvidence.node_run_id !== verifier.node_run_id || verifiedEvidence.attempt !== verification.target_attempt)
        throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '独立核验的执行证据不可复用')
    }
    if (tx.get('SELECT 1 FROM rework_requests WHERE (target_node_run_id=? OR new_node_run_id=?) AND status NOT IN (\'closed\',\'declined\',\'cancelled\')', [target.node_run_id, target.node_run_id]) || tx.get('SELECT 1 FROM rework_impacts WHERE (node_run_id=? OR replacement_node_run_id=?) AND released_at IS NULL', [target.node_run_id, target.node_run_id]))
      throw new OrchError('COMMAND_BUSY', '该成果已有未完成返工请求或依赖保护')
    const requestId = 'rework_' + uuidv7()
    tx.run('INSERT INTO rework_requests (request_id,run_id,requester_node_run_id,requester_actor,owner_actor,target_node_run_id,target_attempt,source_artifact_id,source_artifact_hash,reason,expected_result,preserve_requirements_json,suggested_scope,status,evidence_ids_json,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [requestId, body.run_id, typeof actor === 'string' ? null : actor.node_run_id, planner ? 'planner:' + owner : actorKey(actor), owner, target.node_run_id, target.attempt, body.source_artifact_id, body.source_artifact_hash, body.reason, body.expected_result, JSON.stringify(body.preserve_requirements), body.suggested_scope, body.suggested_scope === 'replan_subgraph' ? 'needs_human_approval' : 'proposed', JSON.stringify(body.evidence_ids), new Date(Date.parse(now) + 86400000).toISOString(), now, now])
    if (body.verification_request_id)
      tx.run('UPDATE rework_requests SET verification_request_id=? WHERE request_id=?', [body.verification_request_id, requestId])
    let row = loadReworkRequest(tx, requestId)
    event(tx, row, 'proposed')
    if (body.suggested_scope === 'targeted_revision') {
      tx.exec('SAVEPOINT rework_auto_authorize')
      try {
        const impacts = previewReworkImpact(tx, row)
        if (impacts.some(node => node.status !== 'queued' && node.node_run_id !== row.requester_node_run_id))
          throw new OrchError('FORBIDDEN', '多个已执行步骤受到影响，需要局部方案或人工审核')
        row = schedule(tx, secret, row, now)
        tx.exec('RELEASE rework_auto_authorize')
        event(tx, row, 'authorized')
      }
      catch (error) {
        tx.exec('ROLLBACK TO rework_auto_authorize')
        tx.exec('RELEASE rework_auto_authorize')
        if (!(error instanceof OrchError) || !['FORBIDDEN', 'STALE_GENERATION'].includes(error.code))
          throw error
        tx.run("UPDATE rework_requests SET status='needs_human_approval',revision=revision+1,updated_at=? WHERE request_id=?", [now, requestId])
        row = loadReworkRequest(tx, requestId)
        event(tx, row, 'needs_human_approval')
        appendEvent(tx, { type: 'rework.authorization_deferred', runId: row.run_id, payload: { request_id: row.request_id, code: error.code, reason: error.message } })
      }
    }
    return row
  }
  return {
    request(input: z.input<typeof reworkRequestSchema>, actor: ReworkActor, now: string) {
      const body = reworkRequestSchema.parse(input)
      return withTx(db, tx => runIdempotentCommand(tx, { kind: 'rework.request', operationId: body.operation_id, requestHash: requestHashOf('rework.request', { ...body, actor }), now }, () => submitRequest(tx, body, actor, now)).result)
    },
    requestFromPlanner(input: z.input<typeof reworkRequestSchema>, supervisorOwner: string, now: string) {
      const body = reworkRequestSchema.parse(input)
      return withTx(db, tx => runIdempotentCommand(tx, { kind: 'rework.planner_request', operationId: body.operation_id, requestHash: requestHashOf('rework.planner_request', { ...body, supervisorOwner }), now }, () => submitRequest(tx, body, supervisorOwner, now, true)).result)
    },
    requestFromPlannerInTx(tx: Tx, input: z.input<typeof reworkRequestSchema>, supervisorOwner: string, now: string) {
      return submitRequest(tx, reworkRequestSchema.parse(input), supervisorOwner, now, true)
    },
    review(input: z.input<typeof reworkReviewSchema>, actor: ReworkActor, now: string) {
      const body = reworkReviewSchema.parse(input)
      return withTx(db, tx => runIdempotentCommand(tx, { kind: 'rework.review', operationId: body.operation_id, requestHash: requestHashOf('rework.review', { ...body, actor }), now }, () => {
        let row = loadReworkRequest(tx, body.request_id)
        const reviewedRound = row.round_no
        access(tx, row, actor, true)
        active(tx, row.run_id)
        if (row.revision !== body.expected_revision || inactive.has(row.status))
          throw new OrchError('STALE_GENERATION', '返工版本已变化或已结束')
        const unstartedDecline = body.action === 'reject' && typeof actor === 'string'
          && ['proposed','needs_human_approval','escalated'].includes(row.status)
          && !tx.get('SELECT 1 FROM rework_attempts WHERE request_id=?', [row.request_id])
        if (!['escalate','reject_final'].includes(body.action) && !unstartedDecline && now >= row.expires_at)
          throw new OrchError('CONFIRMATION_EXPIRED', '返工已超时，请升级人工处理')
        if (body.action === 'reject_final') {
          if (typeof actor !== 'string') throw new OrchError('FORBIDDEN','只有负责人可明确终止运行')
          if (!options.clock) throw new OrchError('SERVICE_UNAVAILABLE','宿主未提供取消时钟，无法可靠终止运行')
          const cancellation = propagateRunCancellation(tx,secret,{runId:row.run_id,cancelResult:'unknown',graceMs:5000,now,clock:options.clock})
          for (const pending of tx.all<ReworkRequest>("SELECT * FROM rework_requests WHERE run_id=? AND status NOT IN ('closed','declined','cancelled')",[row.run_id])) {
            tx.run("UPDATE rework_requests SET status='cancelled',revision=revision+1,updated_at=? WHERE request_id=?",[now,pending.request_id])
            event(tx,loadReworkRequest(tx,pending.request_id),'cancelled')
          }
          appendEvent(tx,{type:'rework.run_termination_requested',runId:row.run_id,payload:{actor,request_id:row.request_id,note:body.note,...cancellation}})
          closeRun(tx,secret,row.run_id,now)
          row=loadReworkRequest(tx,row.request_id)
        }
        else if (body.action === 'authorize') {
          if (typeof actor !== 'string')
            throw new OrchError('FORBIDDEN', 'Agent 反馈不代表返工授权')
          if (!['proposed', 'needs_human_approval'].includes(row.status))
            throw new OrchError('STALE_GENERATION', '当前状态不能授权')
          row = schedule(tx, secret, row, now)
        }
        else if (body.action === 'accept' || body.action === 'request_changes') {
          if (row.status !== 'awaiting_review' || !row.new_node_run_id)
            throw new OrchError('STALE_GENERATION', '修订尚未完成或不在验收阶段')
          if (typeof actor !== 'string') {
            const reviewer = bound(tx, actor), requester = row.requester_node_run_id ? loadNode(tx, row.requester_node_run_id) : null
            if (!requester || requester.node_id !== reviewer.node_id)
              throw new OrchError('FORBIDDEN', '只有原请求审核角色可验收')
          }
          const attempt = tx.get<ReworkAttempt>('SELECT * FROM rework_attempts WHERE request_id=? AND round_no=?', [row.request_id, row.round_no])!
          if (!body.artifact_id || !body.artifact_hash || body.artifact_id !== attempt.result_artifact_id || body.artifact_hash !== attempt.result_artifact_hash)
            throw new OrchError('STALE_GENERATION', '验收必须绑定本轮精确成果版本')
          artifact(tx, row.run_id, row.new_node_run_id, body.artifact_id, body.artifact_hash, now)
          evidence(tx, secret, actor, body.evidence_ids, row.updated_at)
          tx.run('UPDATE rework_attempts SET status=?,reviewed_at=? WHERE attempt_id=?', [body.action === 'accept' ? 'accepted' : 'request_changes', now, attempt.attempt_id])
          if (body.action === 'accept') {
            acceptReworkRuntime(tx, secret, row, now)
            tx.run("UPDATE rework_requests SET status='closed',revision=revision+1,updated_at=? WHERE request_id=?", [now, row.request_id])
            closeRun(tx, secret, row.run_id, now)
          }
          else {
            const exhausted = row.round_no >= row.max_rounds || row.budget_remaining <= 0
            tx.run('UPDATE rework_requests SET status=?,target_node_run_id=?,target_attempt=?,source_artifact_id=?,source_artifact_hash=?,new_node_run_id=NULL,round_no=round_no+?,reason=?,revision=revision+1,updated_at=? WHERE request_id=?', [exhausted ? 'escalated' : 'proposed', row.new_node_run_id, loadNode(tx, row.new_node_run_id).attempt, body.artifact_id, body.artifact_hash, exhausted ? 0 : 1, body.note, now, row.request_id])
          }
          row = loadReworkRequest(tx, row.request_id)
        }
        else {
          if (body.action === 'reject' && !unstartedDecline)
            throw new OrchError('FORBIDDEN', '已执行的返工只能升级处理，不能丢弃依赖保护')
          tx.run('UPDATE rework_requests SET status=?,revision=revision+1,updated_at=? WHERE request_id=?', [body.action === 'reject' ? 'declined' : 'escalated', now, row.request_id])
          row = loadReworkRequest(tx, row.request_id)
          if (body.action === 'reject') closeRun(tx,secret,row.run_id,now)
        }
        tx.run('INSERT INTO rework_reviews (review_id,request_id,round_no,reviewer_actor,artifact_id,artifact_hash,action,note,evidence_ids_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [uuidv7(), row.request_id, reviewedRound, actorKey(actor), body.artifact_id ?? null, body.artifact_hash ?? null, body.action, body.note, JSON.stringify(body.evidence_ids), now])
        event(tx, row, body.action)
        return row
      }).result)
    },
    list(actor: ReworkActor, runId?: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        if (typeof actor === 'string')
          return { items: tx.all<ReworkRequest>('SELECT * FROM rework_requests WHERE owner_actor=? AND (? IS NULL OR run_id=?) ORDER BY created_at DESC,request_id DESC LIMIT 100', [actor, runId ?? null, runId ?? null]), as_of_seq }
        const node = bound(tx, actor)
        return { items: tx.all<ReworkRequest>('SELECT r.* FROM rework_requests r LEFT JOIN node_runs q ON q.node_run_id=r.requester_node_run_id JOIN node_runs t ON t.node_run_id=r.target_node_run_id WHERE r.run_id=? AND (? IS NULL OR r.run_id=?) AND (q.node_id=? OR t.node_id=?) ORDER BY r.created_at DESC,r.request_id DESC LIMIT 100', [node.run_id, runId ?? null, runId ?? null, node.node_id, node.node_id]), as_of_seq }
      })
    },
    get(requestId: string, actor: ReworkActor) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        const request = loadReworkRequest(tx, requestId)
        access(tx, request, actor)
        return { item: { request, dispatch_blocks: tx.all<{node_id:string;node_run_id:string;reason:string;message:string;created_at:string;resolved_at:string|null}>('SELECT node_id,node_run_id,reason,message,created_at,resolved_at FROM rework_dispatch_blocks WHERE request_id=? ORDER BY created_at,node_run_id',[requestId]), attempts: tx.all<ReworkAttempt>('SELECT * FROM rework_attempts WHERE request_id=? ORDER BY round_no', [requestId]), reviews: tx.all<ReworkReview>('SELECT * FROM rework_reviews WHERE request_id=? ORDER BY created_at,review_id', [requestId]), impacts: tx.all<{
              node_id: string
              node_run_id: string
              replacement_node_run_id: string | null
              reason: string
              released_at: string | null
            }>('SELECT n.node_id,i.node_run_id,i.replacement_node_run_id,i.reason,i.released_at FROM rework_impacts i JOIN node_runs n ON n.node_run_id=i.node_run_id WHERE i.request_id=? ORDER BY n.seq,n.attempt', [requestId]) }, as_of_seq }
      })
    },
    context(nodeRunId: string) { return withReadTx(db, ({ tx }) => tx.get<ReworkRequest>('SELECT * FROM rework_requests WHERE new_node_run_id=? AND status=\'scheduled\'', [nodeRunId]) ?? null); },
    recover(now: string) {
      return withTx(db, tx => {
        for (const row of tx.all<ReworkRequest>("SELECT * FROM rework_requests WHERE status NOT IN ('closed','declined','cancelled')")) {
          tx.exec('SAVEPOINT rework_recover_one')
          try {
            const run = tx.get<{
              status: string
              cancel_requested_at: string | null
            }>('SELECT status,cancel_requested_at FROM runs WHERE run_id=?', [row.run_id])
            if (!run || run.cancel_requested_at || isRunTerminal(run.status)) {
              tx.run("UPDATE rework_requests SET status='cancelled',revision=revision+1,updated_at=? WHERE request_id=?", [now, row.request_id])
              event(tx, loadReworkRequest(tx, row.request_id), 'cancelled')
            }
            else if (run.status !== 'running')
              continue
            else if (now >= row.expires_at && row.status !== 'escalated') {
              tx.run("UPDATE rework_requests SET status='escalated',revision=revision+1,updated_at=? WHERE request_id=?", [now, row.request_id])
              event(tx, loadReworkRequest(tx, row.request_id), 'expired')
            }
            else if (row.status === 'scheduled' && row.new_node_run_id && loadNode(tx, row.new_node_run_id).status === 'done') {
              const results = tx.all<{
                artifact_id: string
                sha256: string
              }>('SELECT a.artifact_id,a.sha256 FROM artifacts a JOIN artifact_contents c ON c.artifact_id=a.artifact_id WHERE c.node_run_id=? AND a.run_id=?', [row.new_node_run_id, row.run_id])
              if (results.length === 1) {
                const result = results[0]!
                artifact(tx, row.run_id, row.new_node_run_id, result.artifact_id, result.sha256, now)
                tx.run("UPDATE rework_attempts SET status='awaiting_review',result_artifact_id=?,result_artifact_hash=? WHERE request_id=? AND round_no=?", [result.artifact_id, result.sha256, row.request_id, row.round_no])
                tx.run("UPDATE rework_requests SET status='awaiting_review',revision=revision+1,updated_at=? WHERE request_id=?", [now, row.request_id])
                const updated = loadReworkRequest(tx, row.request_id)
                prepareReworkReviewer(tx, secret, updated, now)
                event(tx, updated, 'awaiting_review')
              }
              else {
                tx.run("UPDATE rework_requests SET status='escalated',revision=revision+1,updated_at=? WHERE request_id=?", [now, row.request_id])
                appendEvent(tx, { type: 'rework.recovery_blocked', runId: row.run_id, nodeRunId: row.new_node_run_id,
                  payload: { request_id: row.request_id, reason: 'expected_one_revision_artifact', count: results.length } })
              }
            }
            else if (row.status === 'scheduled' && row.new_node_run_id && ['failed', 'timeout', 'orphaned', 'abandoned_unverified', 'failed_with_unverified', 'indeterminate_side_effect'].includes(loadNode(tx, row.new_node_run_id).status)) {
              tx.run("UPDATE rework_requests SET status='escalated',revision=revision+1,updated_at=? WHERE request_id=?", [now, row.request_id])
              event(tx, loadReworkRequest(tx, row.request_id), 'escalated')
            }
          }
          catch (error) {
            tx.exec('ROLLBACK TO rework_recover_one')
            if (!(error instanceof OrchError))
              throw error
            tx.run("UPDATE rework_requests SET status='escalated',revision=revision+1,updated_at=? WHERE request_id=?", [now, row.request_id])
            appendEvent(tx, { type: 'rework.recovery_blocked', runId: row.run_id, payload: { request_id: row.request_id, code: error.code, reason: error.message } })
          }
          finally {
            tx.exec('RELEASE rework_recover_one')
          }
        }
      })
    },
  }
}
export type ReworkHost = ReturnType<typeof createReworkHost>
