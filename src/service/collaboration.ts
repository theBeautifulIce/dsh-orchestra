import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import { uuidv7 } from '../core/ids.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand, UUID_V7_RE } from './commands/idempotency.ts'
import { readStrongEvidence } from './queries/evidence.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'

export type CollaborationBinding = { node_run_id: string; attempt: number; action_generation: number }
type ActiveNode = CollaborationBinding & { status: string; run_id: string }
type Scope = { scope_id: string; title: string; owner_actor: string; created_at: string; expires_at: string }
type Member = { node_run_id: string; run_id: string; task_id: string; node_id: string }
type Finding = {
  finding_id: string; scope_id: string; source_node_run_id: string; source_attempt: number; source_generation: number
  title: string; summary: string; evidence_id: string; created_at: string
}
type Status = 'proposed' | 'authorized' | 'delivered' | 'accepted' | 'completed' | 'rejected' | 'denied' | 'expired'
export type VerificationVerdict = 'confirmed' | 'refuted' | 'inconclusive'
type Verification = {
  request_id: string; scope_id: string; finding_id: string; target_node_run_id: string; status: Status; revision: number
  target_attempt: number | null; target_generation: number | null; question: string; authorization_note: string | null
  delivered_at: string | null; accepted_at: string | null; accepted_chain_seq: number | null; result: string | null; evidence_id: string | null
  verdict: VerificationVerdict | null; adoption: 'adopted' | 'dismissed' | null; adoption_note: string | null
  expires_at: string; created_at: string; updated_at: string
}
const ID = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/)
const OPERATION = z.string().regex(UUID_V7_RE)
export const collaborationScopeSchema = z.strictObject({
  operation_id: OPERATION, title: z.string().trim().min(1).max(200),
  node_run_ids: z.array(ID).min(2).max(16), ttl_minutes: z.number().int().min(1).max(10_080),
})
export const collaborationReviewSchema = z.strictObject({
  operation_id: OPERATION, request_id: ID, expected_revision: z.number().int().positive(),
  action: z.enum(['authorize', 'deny', 'adopt', 'dismiss']), note: z.string().trim().min(1).max(1000),
})
export const collaborationFindingSchema = z.strictObject({
  scope_id: ID, title: z.string().trim().min(1).max(200), summary: z.string().trim().min(1).max(2500), evidence_id: ID,
})
export const collaborationRequestSchema = z.strictObject({
  finding_id: ID, target_node_run_id: ID, question: z.string().trim().min(1).max(1500), ttl_minutes: z.number().int().min(1).max(1440),
})
const HANDLE = { operation_id: OPERATION, request_id: ID, expected_revision: z.number().int().positive() }
export const collaborationHandleSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...HANDLE, action: z.enum(['delivered', 'accept', 'reject']) }),
  z.strictObject({ ...HANDLE, action: z.literal('complete'), result: z.string().trim().min(1).max(2500),
    verdict: z.enum(['confirmed', 'refuted', 'inconclusive']), evidence_id: ID }),
])
const FINDING_FIELDS = 'finding_id,scope_id,source_node_run_id,source_attempt,source_generation,title,summary,evidence_id,created_at'
const ACTIVE = "status IN ('proposed','authorized','delivered','accepted')"
const MAX_FINDINGS = 64
const MAX_REQUESTS = 64
const MAX_ACTIVE_REQUESTS = 8
const ACTIVE_NODE_STATES = new Set(['started', 'verifying'])
const TERMINAL_NODE_STATES = new Set(['done', 'failed', 'timeout', 'abandoned_unverified', 'failed_with_unverified', 'orphaned', 'superseded'])

function boundNode(tx: ReadTx, binding: CollaborationBinding): ActiveNode {
  const row = tx.get<ActiveNode>('SELECT node_run_id,attempt,action_generation,status,run_id FROM node_runs WHERE node_run_id = ?', [binding.node_run_id])
  if (!row || row.attempt !== binding.attempt || row.action_generation !== binding.action_generation || !ACTIVE_NODE_STATES.has(row.status)) {
    throw new OrchError('FORBIDDEN', '核验工具只能由当前执行主体调用')
  }
  return row
}

function loadScope(tx: ReadTx, scopeId: string, actor?: string): Scope {
  const scope = tx.get<Scope>('SELECT * FROM collaboration_scopes WHERE scope_id = ?', [scopeId])
  if (!scope || (actor !== undefined && scope.owner_actor !== actor)) throw new OrchError('NOT_FOUND', '协作范围不存在')
  return scope
}
function loadFinding(tx: ReadTx, findingId: string): Finding {
  const row = tx.get<Finding>('SELECT ' + FINDING_FIELDS + ' FROM collaboration_findings WHERE finding_id = ?', [findingId])
  if (!row) throw new OrchError('NOT_FOUND', '找不到原始发现')
  return row
}
function loadRequest(tx: ReadTx, requestId: string): Verification {
  const row = tx.get<Verification>('SELECT * FROM collaboration_requests WHERE request_id = ?', [requestId])
  if (!row) throw new OrchError('NOT_FOUND', '找不到核验请求')
  return row
}
function requireMember(tx: ReadTx, scopeId: string, nodeRunId: string): void {
  if (!tx.get('SELECT 1 FROM collaboration_members WHERE scope_id = ? AND node_run_id = ?', [scopeId, nodeRunId])) {
    throw new OrchError('FORBIDDEN', '该执行主体未加入本次协作范围')
  }
}
function readMembers(tx: ReadTx, scopeId: string): Member[] {
  return tx.all<Member>(
    'SELECT m.node_run_id,n.run_id,r.task_id,n.node_id FROM collaboration_members m JOIN node_runs n ON n.node_run_id = m.node_run_id '
    + 'JOIN runs r ON r.run_id = n.run_id WHERE m.scope_id = ? ORDER BY m.node_run_id', [scopeId],
  )
}
function expiry(now: string, minutes: number): string {
  return new Date(Date.parse(now) + minutes * 60_000).toISOString()
}
function assertBefore(now: string, expiresAt: string): void {
  if (now >= expiresAt) throw new OrchError('CONFIRMATION_EXPIRED', '协作核验已超过时限')
}
function requireEvidence(tx: ReadTx, secret: string, binding: CollaborationBinding, id: string, accepted?: { at: string; chainSeq: number }) {
  const { item: evidence, completed_seq } = readStrongEvidence(tx, secret, id)
  const observedAt = Date.parse(evidence.observed_at)
  if (evidence.node_run_id !== binding.node_run_id || evidence.attempt !== binding.attempt
    || !Number.isFinite(observedAt) || (accepted && (observedAt < Date.parse(accepted.at) || completed_seq <= accepted.chainSeq))) {
    throw new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '需提交当前执行主体独立执行产生的系统证据')
  }
}
function requestEvent(tx: Tx, request: Verification, state: string, node: ActiveNode | null = null): void {
  appendEvent(tx, { type: 'collaboration.' + state, runId: node?.run_id, nodeRunId: node?.node_run_id, payload: {
    scope_id: request.scope_id, request_id: request.request_id, finding_id: request.finding_id,
    target_node_run_id: request.target_node_run_id, revision: request.revision, status: request.status,
  } })
}

const RECEIVER_STATE = {
  delivered: { current: 'authorized', next: 'delivered' },
  accept: { current: 'delivered', next: 'accepted' },
  reject: { current: 'delivered', next: 'rejected' },
  complete: { current: 'accepted', next: 'completed' },
} as const

export function createCollaborationHost(db: Db, secret: string) {
  return {
    createScope(input: z.input<typeof collaborationScopeSchema>, actor: string, now: string) {
      const body = collaborationScopeSchema.parse(input)
      const nodeRunIds = [...new Set(body.node_run_ids)].sort()
      if (nodeRunIds.length !== body.node_run_ids.length) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '协作主体不能重复')
      return withTx(db, (tx) => runIdempotentCommand(tx, {
        kind: 'collaboration.scope_create', operationId: body.operation_id,
        requestHash: requestHashOf('collaboration.scope_create', { ...body, node_run_ids: nodeRunIds, actor }), now,
      }, () => {
        const scopeId = 'scope_' + uuidv7()
        const expiresAt = expiry(now, body.ttl_minutes)
        for (const member of nodeRunIds) {
          if (!tx.get('SELECT 1 FROM node_runs WHERE node_run_id = ?', [member])) {
            throw new OrchError('NOT_FOUND', '授权执行主体不存在', { node_run_id: member })
          }
        }
        tx.run('INSERT INTO collaboration_scopes (scope_id,title,owner_actor,created_at,expires_at) VALUES (?,?,?,?,?)',
          [scopeId, body.title, actor, now, expiresAt])
        for (const member of nodeRunIds) {
          tx.run('INSERT INTO collaboration_members (scope_id,node_run_id) VALUES (?,?)', [scopeId, member])
        }
        appendEvent(tx, { type: 'collaboration.scope_created', payload: { scope_id: scopeId, node_run_ids: nodeRunIds } })
        return loadScope(tx, scopeId)
      }).result)
    },
    listScopes(actor: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => ({
        items: tx.all<Scope>('SELECT * FROM collaboration_scopes WHERE owner_actor = ? ORDER BY created_at DESC,scope_id DESC LIMIT 100', [actor]),
        as_of_seq,
      }))
    },
    getScope(scopeId: string, actor: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        const scope = loadScope(tx, scopeId, actor)
        return { item: {
          scope, members: readMembers(tx, scopeId),
          findings: tx.all<Finding>('SELECT ' + FINDING_FIELDS + ' FROM collaboration_findings WHERE scope_id = ? ORDER BY created_at DESC,finding_id DESC', [scopeId]),
          requests: tx.all<Verification>('SELECT * FROM collaboration_requests WHERE scope_id = ? ORDER BY created_at DESC,request_id DESC', [scopeId]),
        }, as_of_seq }
      })
    },
    reportFinding(binding: CollaborationBinding, input: z.input<typeof collaborationFindingSchema>, now: string) {
      const body = collaborationFindingSchema.parse(input)
      return withTx(db, (tx) => {
        const node = boundNode(tx, binding)
        requireMember(tx, body.scope_id, node.node_run_id)
        assertBefore(now, loadScope(tx, body.scope_id).expires_at)
        requireEvidence(tx, secret, binding, body.evidence_id)
        const fingerprint = requestHashOf('collaboration.finding_fingerprint', { ...body, ...binding })
        const prior = tx.get<{ finding_id: string }>('SELECT finding_id FROM collaboration_findings WHERE scope_id = ? AND fingerprint = ?', [body.scope_id, fingerprint])
        if (prior) return loadFinding(tx, prior.finding_id)
        const count = tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM collaboration_findings WHERE scope_id = ?', [body.scope_id])
        if ((count?.count ?? 0) >= MAX_FINDINGS) throw new OrchError('RANGE_TOO_LARGE', '本次协作已达到发现数量上限')
        const findingId = 'finding_' + uuidv7()
        tx.run(`INSERT INTO collaboration_findings
          (finding_id,scope_id,source_node_run_id,source_attempt,source_generation,title,summary,evidence_id,fingerprint,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, [
          findingId, body.scope_id, node.node_run_id, node.attempt, node.action_generation, body.title, body.summary, body.evidence_id, fingerprint, now,
        ])
        appendEvent(tx, { type: 'collaboration.finding_reported', runId: node.run_id, nodeRunId: node.node_run_id,
          payload: { scope_id: body.scope_id, finding_id: findingId, evidence_id: body.evidence_id } })
        return loadFinding(tx, findingId)
      })
    },
    requestVerification(binding: CollaborationBinding, input: z.input<typeof collaborationRequestSchema>, now: string) {
      const body = collaborationRequestSchema.parse(input)
      return withTx(db, (tx) => {
        const node = boundNode(tx, binding)
        const finding = loadFinding(tx, body.finding_id)
        if (finding.source_node_run_id !== node.node_run_id || finding.source_attempt !== node.attempt || finding.source_generation !== node.action_generation
          || node.node_run_id === body.target_node_run_id) {
          throw new OrchError('FORBIDDEN', '仅原发现执行主体可向独立接收方提出核验')
        }
        const scope = loadScope(tx, finding.scope_id)
        requireMember(tx, scope.scope_id, body.target_node_run_id)
        assertBefore(now, scope.expires_at)
        const prior = tx.get<Verification>('SELECT * FROM collaboration_requests WHERE finding_id = ? AND target_node_run_id = ?',
          [finding.finding_id, body.target_node_run_id])
        if (prior) return prior
        const counts = tx.get<{ total: number; active: number }>(
          'SELECT COUNT(*) AS total, SUM(CASE WHEN ' + ACTIVE + ' AND expires_at > ? THEN 1 ELSE 0 END) AS active '
          + 'FROM collaboration_requests WHERE scope_id = ?', [now, scope.scope_id],
        )
        if ((counts?.total ?? 0) >= MAX_REQUESTS || (counts?.active ?? 0) >= MAX_ACTIVE_REQUESTS) {
          throw new OrchError('RANGE_TOO_LARGE', '本次协作已达到核验请求上限')
        }
        const requestId = 'verification_' + uuidv7()
        const expiresAt = [scope.expires_at, expiry(now, body.ttl_minutes)].sort()[0]!
        tx.run(`INSERT INTO collaboration_requests
          (request_id,scope_id,finding_id,target_node_run_id,question,status,expires_at,created_at,updated_at)
          VALUES (?,?,?,?,?,'proposed',?,?,?)`,
        [requestId, scope.scope_id, finding.finding_id, body.target_node_run_id, body.question, expiresAt, now, now])
        const created = loadRequest(tx, requestId)
        requestEvent(tx, created, 'proposed', node)
        return created
      })
    },
    review(input: z.input<typeof collaborationReviewSchema>, actor: string, now: string) {
      const body = collaborationReviewSchema.parse(input)
      return withTx(db, (tx) => runIdempotentCommand(tx, {
        kind: 'collaboration.review', operationId: body.operation_id, requestHash: requestHashOf('collaboration.review', { ...body, actor }), now,
      }, () => {
        const request = loadRequest(tx, body.request_id)
        loadScope(tx, request.scope_id, actor)
        if (request.revision !== body.expected_revision) throw new OrchError('STALE_GENERATION', '核验请求已有新状态，请刷新')
        if (body.action === 'authorize' || body.action === 'deny') {
          assertBefore(now, request.expires_at)
          if (request.status !== 'proposed') throw new OrchError('RESOLUTION_NOT_AVAILABLE', '当前请求不能再决定是否派发')
          if (body.action === 'authorize') {
            const target = tx.get<{ status: string }>('SELECT status FROM node_runs WHERE node_run_id = ?', [request.target_node_run_id])
            if (!target || TERMINAL_NODE_STATES.has(target.status)) {
              throw new OrchError('RESOLUTION_NOT_AVAILABLE', '接收节点已收口，请核对范围后重新安排核验')
            }
          }
          tx.run('UPDATE collaboration_requests SET status = ?, authorization_note = ?, updated_at = ?, revision = revision + 1 WHERE request_id = ?',
            [body.action === 'authorize' ? 'authorized' : 'denied', body.note, now, request.request_id])
        } else {
          if (request.status !== 'completed' || request.adoption !== null) throw new OrchError('RESOLUTION_NOT_AVAILABLE', '核验结果尚不能作出采纳决定')
          tx.run('UPDATE collaboration_requests SET adoption = ?, adoption_note = ?, updated_at = ?, revision = revision + 1 WHERE request_id = ?',
            [body.action === 'adopt' ? 'adopted' : 'dismissed', body.note, now, request.request_id])
        }
        const updated = loadRequest(tx, request.request_id)
        requestEvent(tx, updated, updated.adoption ?? updated.status)
        return updated
      }).result)
    },
    listMemberships(binding: CollaborationBinding, now: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        const node = boundNode(tx, binding)
        const scopes = tx.all<Pick<Scope, 'scope_id' | 'title' | 'expires_at'>>(
          'SELECT s.scope_id,s.title,s.expires_at FROM collaboration_members m JOIN collaboration_scopes s ON s.scope_id = m.scope_id '
          + 'WHERE m.node_run_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC,s.scope_id DESC LIMIT 100',
          [node.node_run_id, now],
        )
        return { items: scopes.map((scope) => ({ ...scope, members: readMembers(tx, scope.scope_id) })), as_of_seq }
      })
    },
    listInbox(binding: CollaborationBinding, now: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        const node = boundNode(tx, binding)
        const requests = tx.all<Verification>(
          "SELECT * FROM collaboration_requests WHERE target_node_run_id = ? AND expires_at > ? AND status IN ('authorized','delivered','accepted') "
          + "AND (status <> 'accepted' OR (target_attempt = ? AND target_generation = ?)) ORDER BY created_at,request_id LIMIT 100",
          [node.node_run_id, now, node.attempt, node.action_generation],
        )
        return { items: requests.map((request) => ({ request, finding: loadFinding(tx, request.finding_id) })), as_of_seq }
      })
    },
    listOutgoing(binding: CollaborationBinding) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        const node = boundNode(tx, binding)
        const findings = tx.all<Finding>('SELECT ' + FINDING_FIELDS + ' FROM collaboration_findings '
          + 'WHERE source_node_run_id = ? AND source_attempt = ? AND source_generation = ? ORDER BY created_at DESC,finding_id DESC LIMIT 100',
        [node.node_run_id, node.attempt, node.action_generation])
        return { items: findings.map((finding) => ({
          finding,
          requests: tx.all<Verification>('SELECT * FROM collaboration_requests WHERE finding_id = ? ORDER BY created_at,request_id', [finding.finding_id]),
        })), as_of_seq }
      })
    },
    handle(binding: CollaborationBinding, input: z.input<typeof collaborationHandleSchema>, now: string) {
      const body = collaborationHandleSchema.parse(input)
      return withTx(db, (tx) => {
        const node = boundNode(tx, binding)
        return runIdempotentCommand(tx, {
          kind: 'collaboration.' + body.action, operationId: body.operation_id,
          requestHash: requestHashOf('collaboration.' + body.action, { body, binding }), now,
        }, () => {
          const request = loadRequest(tx, body.request_id)
          const redelivery = body.action === 'delivered' && request.status === 'delivered'
          const currentBinding = request.target_attempt === null
            || (request.target_attempt === node.attempt && request.target_generation === node.action_generation)
          if (request.target_node_run_id !== node.node_run_id || (!currentBinding && !redelivery)) {
            throw new OrchError('FORBIDDEN', '当前执行主体与请求绑定的接收方不一致')
          }
          requireMember(tx, request.scope_id, node.node_run_id)
          assertBefore(now, request.expires_at)
          if (redelivery && currentBinding && (request.revision === body.expected_revision || request.revision === body.expected_revision + 1)) {
            return request
          }
          if (request.revision !== body.expected_revision) throw new OrchError('STALE_GENERATION', '核验请求已有新状态，请刷新')
          const transition = RECEIVER_STATE[body.action]
          if (!redelivery && request.status !== transition.current) {
            throw new OrchError('RESOLUTION_NOT_AVAILABLE', '当前业务处理步骤不适用于此请求状态')
          }
          if (body.action === 'complete') {
            requireEvidence(tx, secret, binding, body.evidence_id, { at: request.accepted_at!, chainSeq: request.accepted_chain_seq! })
          }
          const acceptedSeq = body.action === 'accept'
            ? (tx.get<{ seq: number }>('SELECT COALESCE(MAX(seq),0) AS seq FROM node_run_events WHERE node_run_id = ?', [node.node_run_id])?.seq ?? 0)
            : request.accepted_chain_seq
          tx.run(`UPDATE collaboration_requests SET
            status = ?, target_attempt = ?, target_generation = ?, delivered_at = ?, accepted_at = ?, accepted_chain_seq = ?, result = ?, evidence_id = ?, verdict = ?,
            revision = revision + 1, updated_at = ? WHERE request_id = ?`, [
            transition.next, node.attempt, node.action_generation, body.action === 'delivered' ? now : request.delivered_at,
            body.action === 'accept' ? now : request.accepted_at, acceptedSeq, body.action === 'complete' ? body.result : null,
            body.action === 'complete' ? body.evidence_id : null, body.action === 'complete' ? body.verdict : null, now, request.request_id,
          ])
          const updated = loadRequest(tx, request.request_id)
          requestEvent(tx, updated, redelivery ? 'redelivered' : updated.status, node)
          return updated
        }).result
      })
    },
    sweep(now: string) {
      return withTx(db, (tx) => {
        const due = tx.all<Verification>('SELECT * FROM collaboration_requests WHERE ' + ACTIVE + ' AND expires_at <= ? ORDER BY expires_at,request_id LIMIT 64', [now])
        for (const request of due) {
          tx.run("UPDATE collaboration_requests SET status = 'expired', revision = revision + 1, updated_at = ? WHERE request_id = ?", [now, request.request_id])
          requestEvent(tx, { ...request, status: 'expired', revision: request.revision + 1 }, 'expired')
        }
        return due.length
      })
    },
  }
}

export type CollaborationHost = ReturnType<typeof createCollaborationHost>
