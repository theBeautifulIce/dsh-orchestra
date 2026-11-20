import { z } from 'zod'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { uuidv7 } from '../core/ids.ts'
import { MODEL_COMPLEXITIES, selectExecutionModel, type ModelAssignment, type ModelProfile } from '../executor/model-routing.ts'
import { appendEvent, appendNodeRunEvent, chainBreakOf, readChain } from '../infra/db/ledger.ts'
import { withTx, type Db, type Tx } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand } from './commands/idempotency.ts'
import type { NodeRunRow } from './commands/lease.ts'
import { requireReviewOperator, reviewOwnership } from './delivery-review.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'
import { readModelRoutingSettings } from './model-routing-settings.ts'
import { callBoundedPlanner, type ReworkPlanner } from './rework-planning.ts'

const opinionSchema = z.strictObject({
  classification: z.enum(['model_capability', 'model_efficiency', 'waiting_external', 'other', 'insufficient']),
  reason: z.string().trim().min(1).max(240),
  evidence_ids: z.array(z.string()).min(1).max(8),
  model_ref: z.string().regex(/^[\w./:@+-]{1,128}$/).optional(),
})
export const modelEscalationInput = z.strictObject({
  operation_id: z.uuidv7(), run_id: z.string().min(1).max(128), node_run_id: z.string().min(1).max(128),
  expected_attempt: z.number().int().positive(), expected_action_generation: z.number().int().nonnegative(),
})
type Input = z.infer<typeof modelEscalationInput>
type Profile = ModelProfile & { provider?: string; model?: string }
type Node = NodeRunRow & { started_at: string | null; updated_at: string; replacement_node_run_id: string | null; recovery_uncertain: string | null }
type Trigger = 'prolonged_runtime' | 'execution_blocked' | 'repeated_rework'
export type ModelEscalationAssessment = z.infer<typeof opinionSchema> & {
  attempt: number; action_generation: number; previous_model_ref: string; decided_at: string;
  expires_at: string; fingerprint: string; outcome: 'recommended' | 'kept' | 'no_higher_model';
  previous_profile: Profile; recommended_profile?: Profile;
  trigger: Trigger; actor: string
}
type Assessment = ModelEscalationAssessment
const assessmentEvent = 'executor.model_assessed'
const stopEvent = 'executor.agent_stopped'
const prolongedMs = 60_000
const assessmentTtlMs = 30 * 60_000
const blockedReasons = "('action_timeout','agent_execution_failed','report_invalid','verdict_unmet')"
const rank = (profile: ModelProfile) => MODEL_COMPLEXITIES.indexOf(profile.capacity)
const isModelIssue = (value: string) => value === 'model_capability' || value === 'model_efficiency'
const sameModel = (left: Profile, right: Profile) => left.ref === right.ref
  || Boolean(left.provider && left.model && left.provider === right.provider && left.model === right.model)

function modelObservation(tx: ReadTx, node: NodeRunRow) {
  return tx.get<{ seq: number; type: string; model_ref: string; provider: string | null; model: string | null }>(
    "SELECT seq,type,json_extract(payload,'$.model_ref') AS model_ref,json_extract(payload,'$.usage.provider') AS provider,"
    + "json_extract(payload,'$.usage.model') AS model FROM node_run_events WHERE node_run_id=?"
    + " AND type IN ('executor.model_selected','executor.model_confirmed','executor.model_used','executor.model_rejected')"
    + " AND json_extract(payload,'$.attempt')=? AND json_extract(payload,'$.action_generation')=? ORDER BY seq DESC LIMIT 1",
    [node.node_run_id, node.attempt, node.action_generation])
}

function latestAssessment(tx: ReadTx, nodeRunId: string) {
  const entry = tx.get<{ payload: string }>('SELECT payload FROM node_run_events WHERE node_run_id=? AND type=? ORDER BY seq DESC LIMIT 1',
    [nodeRunId, assessmentEvent])
  return entry ? JSON.parse(entry.payload) as Assessment : undefined
}

function factsFor(tx: ReadTx, secret: string, input: Input, actor: string, now: string, profiles: readonly Profile[], successorId?: string) {
  const ownership = requireReviewOperator(tx, secret, actor, input.run_id)
  const node = tx.get<Node>('SELECT n.* FROM node_runs n JOIN runs r USING(run_id) JOIN tasks t USING(task_id)'
    + " JOIN runs root ON root.run_id=? WHERE n.node_run_id=? AND n.run_id=? AND n.node_type='agent'"
    + ' AND n.replacement_node_run_id IS ? AND n.attempt=? AND n.action_generation=?'
    + " AND r.status='running' AND r.cancel_requested_at IS NULL AND root.status='running' AND root.cancel_requested_at IS NULL"
    + ' AND (t.current_run_id IS NULL OR t.current_run_id=root.run_id)',
  [ownership.rootRunId, input.node_run_id, input.run_id, successorId ?? null, input.expected_attempt, input.expected_action_generation])
  if (!node) throw new OrchError('STALE_GENERATION', '模型诊断对应的运行或尝试已变化')
  if (node.side_effect_policy !== 'pure' || node.recovery_uncertain || node.hang_reason
    || !['started', 'blocked_post', 'failed', 'timeout', 'done', 'superseded'].includes(node.status)
    || tx.get("SELECT 1 FROM wait_registrations WHERE node_run_id=? AND state='active'", [node.node_run_id])
    || tx.get("SELECT 1 FROM bridge_tool_outbox WHERE node_run_id=? AND attempt=? AND status='pending'", [node.node_run_id, node.attempt])
    || tx.get("SELECT 1 FROM decisions WHERE run_id=? AND status IN ('pending','acknowledged','blocked_for_human')"
      + " AND (node_run_id=? OR node_run_id IS NULL) AND kind NOT IN ('action_overrun')",
      [node.run_id, node.node_run_id])) return null
  const observed = modelObservation(tx, node)
  const profile = profiles.find((item) => item.ref === observed?.model_ref)
  if (!profile || rank(profile) < 0 || !observed || !['executor.model_confirmed','executor.model_used'].includes(observed.type)) return null
  const reviews = tx.all<{ id: string; note: string; reviewed_at: string }>(
    'SELECT v.review_id AS id,substr(v.note,1,750) AS note,a.reviewed_at'
    + ' FROM rework_attempts a JOIN node_runs n ON n.node_run_id=a.new_node_run_id'
    + " JOIN rework_reviews v ON v.request_id=a.request_id AND v.round_no=a.round_no AND v.action='request_changes'"
    + " WHERE n.run_id=? AND n.node_id=? AND n.attempt<=? AND a.status='request_changes'"
    + ' AND a.result_artifact_id=v.artifact_id AND a.result_artifact_hash=v.artifact_hash ORDER BY n.attempt DESC,v.review_id LIMIT 8',
  [node.run_id, node.node_id, node.attempt])
  const block = tx.get<{ seq: number; reason: string }>("SELECT seq,json_extract(payload,'$.reason') AS reason"
    + " FROM node_run_events WHERE node_run_id=? AND type='verify_human' ORDER BY seq DESC LIMIT 1", [node.node_run_id])
  const durationMs = node.started_at ? Date.parse(now) - Date.parse(node.started_at) : 0
  const blocked = block && ['action_timeout', 'agent_execution_failed', 'report_invalid', 'verdict_unmet'].includes(block.reason)
  const trigger: Trigger | null = node.status === 'done' && reviews.length >= 2 ? 'repeated_rework'
    : ['blocked_post', 'failed', 'timeout', 'superseded'].includes(node.status) && blocked ? 'execution_blocked'
    : node.status === 'started' && durationMs >= prolongedMs ? 'prolonged_runtime' : null
  if (!trigger) return null
  const tools = tx.all<{ execution_id: string; tool: string; exit_code: number }>(
    'SELECT execution_id,tool,exit_code FROM tool_executions WHERE node_run_id=? AND attempt=? ORDER BY tool_seq DESC LIMIT 8',
  [node.node_run_id, node.attempt])
  const notes = new Map(readModelRoutingSettings(tx).model_notes.map(({ ref, note }) => [ref, note]))
  const choices = profiles.filter((item) => rank(item) > rank(profile) && !sameModel(profile, item))
    .map(({ ref, capacity, provider, model }) => ({ ref, capacity, ...(provider ? { provider } : {}), ...(model ? { model } : {}),
      ...(notes.has(ref) ? { user_note: notes.get(ref) } : {}) }))
  const facts = [
    { id: 'model:' + observed.seq, kind: observed.type, detail: { ref: profile.ref, capacity: profile.capacity,
      provider: observed.provider, model: observed.model } },
    ...(block ? [{ id: 'node:' + block.seq, kind: 'execution_block', detail: block.reason }] : []),
    ...reviews.map(({ id, note, reviewed_at }) => ({ id, kind: 'artifact_rejected', detail: { note, reviewed_at } })),
    ...tools.map(({ execution_id, ...result }) => ({ id: execution_id, kind: 'tool_result', detail: result })),
  ]
  const fingerprint = sha256Hex(canonicalJson({ attempt: node.attempt, generation: node.action_generation, trigger, facts, choices }))
  return { profile, fingerprint, input: { purpose: 'model_escalation', trigger, node_id: node.node_id, attempt: node.attempt,
    facts: [{ id: 'clock', kind: 'runtime', detail: { status: node.status, elapsed_ms: node.status === 'started' ? durationMs : null } }, ...facts],
    available_upgrades: choices } }
}

function safeOrigin(tx: ReadTx, nodeRunId: string, now: string, successorGeneration?: number): Node | undefined {
  const origin = tx.get<Node>('SELECT old.* FROM node_runs fresh JOIN node_runs old ON fresh.origin_node_run_id=old.node_run_id'
    + ' JOIN runs r ON r.run_id=fresh.run_id JOIN runs root ON root.run_id=COALESCE(r.root_run_id,r.run_id)'
    + ' JOIN tasks t ON t.task_id=r.task_id'
    + ' WHERE fresh.node_run_id=? AND old.replacement_node_run_id=fresh.node_run_id AND old.run_id=fresh.run_id'
    + " AND old.node_id=fresh.node_id AND old.attempt+1=fresh.attempt AND fresh.side_effect_policy='pure'"
    + " AND fresh.status='dispatched' AND fresh.lease_id IS NOT NULL AND fresh.lease_expires_at>?"
    + " AND r.status='running' AND r.cancel_requested_at IS NULL AND root.status='running' AND root.cancel_requested_at IS NULL"
    + ' AND (t.current_run_id IS NULL OR t.current_run_id=root.run_id)'
    + " AND (? IS NULL OR fresh.action_generation=?)", [nodeRunId, now, successorGeneration ?? null, successorGeneration ?? null])
  if (!origin || origin.side_effect_policy !== 'pure'
    || (origin.lease_id && (!origin.lease_expires_at || origin.lease_expires_at > now))
    || origin.hang_reason || origin.recovery_uncertain || !['done', 'superseded', 'failed', 'timeout'].includes(origin.status)) return
  if (!tx.get("SELECT 1 FROM node_run_events WHERE node_run_id=? AND type=?"
    + " AND json_extract(payload,'$.attempt')=? AND json_extract(payload,'$.action_generation')=?",
  [origin.node_run_id, stopEvent, origin.attempt, origin.action_generation])) return
  if (tx.get('SELECT 1 FROM leases WHERE node_run_id=? AND expires_at>?', [origin.node_run_id, now])
    || tx.get("SELECT 1 FROM bridge_tool_outbox WHERE node_run_id=? AND attempt=? AND status='pending'", [origin.node_run_id, origin.attempt])) return
  return origin
}

/** Apply only after the established retry or rework path leases the direct successor. */
export function getEscalatedModel(tx: Tx, secret: string, node: NodeRunRow, profiles: readonly Profile[], base: ModelAssignment, now: string): ModelAssignment {
  const origin = safeOrigin(tx, node.node_run_id, now, node.action_generation)
  if (!origin || chainBreakOf(secret, readChain(tx, origin.node_run_id))) return base
  const opinion = latestAssessment(tx, origin.node_run_id)
  const observed = modelObservation(tx, origin)
  if (!opinion || opinion.outcome !== 'recommended' || !opinion.model_ref || !isModelIssue(opinion.classification)
    || opinion.attempt !== origin.attempt || opinion.action_generation !== origin.action_generation
    || opinion.decided_at > now || opinion.expires_at <= now || observed?.model_ref !== opinion.previous_model_ref
    || !['executor.model_used','executor.model_confirmed'].includes(observed.type)) return base
  const oldProfile = profiles.find((item) => item.ref === opinion.previous_model_ref)
  const normalProfile = profiles.find((item) => item.ref === base.model_ref)
  const target = profiles.find((item) => item.ref === opinion.model_ref)
  if (!oldProfile || !normalProfile || !target || sameModel(oldProfile, target)
    || !sameConfiguration(oldProfile, opinion.previous_profile) || !sameConfiguration(target, opinion.recommended_profile)
    || rank(target) <= rank(oldProfile) || rank(target) <= rank(normalProfile)) return base
  const result = selectExecutionModel(profiles, { complexity: target.capacity, preferredModel: target.ref, reason: opinion.reason })
  return Object.assign(result, { escalation_from: origin.node_run_id, escalation_decided_at: opinion.decided_at })
}

function sameConfiguration(actual: Profile, recorded: Profile | undefined) {
  return recorded && actual.ref === recorded.ref && actual.capacity === recorded.capacity
    && actual.provider === recorded.provider && actual.model === recorded.model
}

export function noteAgentStopped(tx: Tx, secret: string, node: NodeRunRow, attempt: number, generation: number) {
  if (node.attempt === attempt && node.action_generation === generation) {
    appendNodeRunEvent(tx, secret, node.node_run_id, stopEvent, { attempt, action_generation: generation })
  }
}

export function createModelEscalationHost(db: Db, secret: string, profiles: readonly Profile[], planner?: ReworkPlanner,
  onError?: (error: unknown) => void, nowAt: () => string = () => new Date().toISOString()) {
  const inFlight = new Set<string>()
  const deferred = new Map<string, number>()
  let nextAutoAt = 0
  let cursor: Pick<Node, 'updated_at' | 'node_run_id'> | undefined
  async function assess(input: Input, actor: string, now: string, successor?: { id: string; generation: number }) {
    const body = modelEscalationInput.parse(input)
    const receipt = { kind: assessmentEvent, operationId: body.operation_id, requestHash: requestHashOf(assessmentEvent, { body, actor }), now }
    const previous = withReadTx(db, ({ tx }) => {
      requireReviewOperator(tx, secret, actor, body.run_id)
      return tx.get('SELECT 1 FROM inbox WHERE operation_id=?', [body.operation_id])
    })
    if (previous) return withTx(db, (tx) => runIdempotentCommand(tx, receipt, (): Assessment => {
      throw new OrchError('STALE_GENERATION', '模型诊断回执已失效')
    }).result)
    if (!planner) throw new OrchError('SERVICE_UNAVAILABLE', '当前宿主没有配置主脑模型诊断')
    const state = withReadTx(db, ({ tx }) => factsFor(tx, secret, body, actor, now, profiles, successor?.id))
    if (!state) throw new OrchError('FORBIDDEN', '当前尝试没有可诊断的执行阻塞、长耗时或两次有效打回')
    if (inFlight.has(body.node_run_id) || inFlight.size >= 2) throw new OrchError('COMMAND_BUSY', '主脑正在诊断模型，请稍后查看')
    inFlight.add(body.node_run_id)
    try {
      const prior = withReadTx(db, ({ tx }) => latestAssessment(tx, body.node_run_id))
      if (prior?.fingerprint === state.fingerprint && prior.expires_at > now) {
        return withTx(db, (tx) => runIdempotentCommand(tx, receipt, () => prior).result)
      }
      const parsed = opinionSchema.safeParse(await callBoundedPlanner(planner, state.input, successor ? 8_000 : 45_000))
      if (!parsed.success) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '主脑模型诊断不符合约定结构')
      const opinion = parsed.data
      const known = new Set(state.input.facts.map((item) => item.id))
      const supported = state.input.facts.some((fact) => opinion.evidence_ids.includes(fact.id)
        && (fact.kind === 'artifact_rejected' || fact.kind === 'tool_result'
          || (fact.kind === 'execution_block' && ['report_invalid','verdict_unmet'].includes(String(fact.detail)))))
      if (opinion.evidence_ids.some((id) => !known.has(id)) || new Set(opinion.evidence_ids).size !== opinion.evidence_ids.length
        || (isModelIssue(opinion.classification) && !supported)
        || (opinion.model_ref && (!isModelIssue(opinion.classification) || !state.input.available_upgrades.some((item) => item.ref === opinion.model_ref)))) {
        throw new OrchError('PAYLOAD_SCHEMA_INVALID', '主脑模型诊断引用了无效事实或不适用的模型')
      }
      return withTx(db, (tx) => runIdempotentCommand(tx, receipt, () => {
        const completedAt = nowAt()
        if (successor && safeOrigin(tx, successor.id, completedAt, successor.generation)?.node_run_id !== body.node_run_id) {
          throw new OrchError('STALE_GENERATION', '下一次执行尝试的租约或前序状态已变化')
        }
        const current = factsFor(tx, secret, body, actor, completedAt, profiles, successor?.id)
        if (current?.fingerprint !== state.fingerprint || chainBreakOf(secret, readChain(tx, body.node_run_id))) {
          throw new OrchError('STALE_GENERATION', '诊断期间执行事实已变化或节点账本损坏')
        }
        const outcome = !isModelIssue(opinion.classification) ? 'kept' : opinion.model_ref ? 'recommended'
          : state.input.available_upgrades.length === 0 ? 'no_higher_model' : 'kept'
        const result: Assessment = { ...opinion, outcome, attempt: body.expected_attempt, action_generation: body.expected_action_generation,
          previous_model_ref: state.profile.ref, previous_profile: {
            ref: state.profile.ref, capacity: state.profile.capacity, provider: state.profile.provider, model: state.profile.model,
          },
          ...(opinion.model_ref ? { recommended_profile: state.input.available_upgrades.find((profile) => profile.ref === opinion.model_ref) } : {}),
          decided_at: completedAt,
          expires_at: new Date(Date.parse(completedAt) + assessmentTtlMs).toISOString(),
          fingerprint: state.fingerprint, actor, trigger: state.input.trigger }
        appendNodeRunEvent(tx, secret, body.node_run_id, assessmentEvent, result)
        appendEvent(tx, { type: assessmentEvent, runId: body.run_id, nodeRunId: body.node_run_id,
          payload: { classification: result.classification, outcome, trigger: result.trigger } })
        return result
      }).result)
    } finally { inFlight.delete(body.node_run_id) }
  }
  return {
    enabled: Boolean(planner), assess,
    async prepare(nodeRunId: string, generation: number, now: string) {
      if (!planner) return
      const pending = withReadTx(db, ({ tx }) => {
        const origin = safeOrigin(tx, nodeRunId, now, generation)
        if (!origin) return
        const owner = reviewOwnership(tx, secret, origin.run_id).owner
        const body = { operation_id: uuidv7(), run_id: origin.run_id, node_run_id: origin.node_run_id,
          expected_attempt: origin.attempt, expected_action_generation: origin.action_generation }
        const state = factsFor(tx, secret, body, owner, now, profiles, nodeRunId)
        const previous = latestAssessment(tx, origin.node_run_id)
        if (!state || (previous?.fingerprint === state.fingerprint && previous.expires_at > now)) return
        return { body, owner }
      })
      if (pending) await assess(pending.body, pending.owner, now, { id: nodeRunId, generation }).catch(onError ?? (() => {}))
    },
    get(runId: string, nodeRunId: string, actor: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        requireReviewOperator(tx, secret, actor, runId)
        const node = tx.get<Node>('SELECT * FROM node_runs WHERE run_id=? AND node_run_id=?', [runId, nodeRunId])
        if (!node) {
          throw new OrchError('NOT_FOUND', '该运行没有此节点尝试')
        }
        const item = latestAssessment(tx, nodeRunId) ?? null
        const dispatch = node.replacement_node_run_id ? tx.get<{ model_ref: string; state: string; provider: string | null; model: string | null }>(
          "SELECT json_extract(payload,'$.model_ref') AS model_ref,json_extract(payload,'$.state') AS state,"
          + "json_extract(payload,'$.usage.provider') AS provider,json_extract(payload,'$.usage.model') AS model"
          + " FROM node_run_events WHERE node_run_id=? AND type IN ('executor.model_selected','executor.model_confirmed','executor.model_rejected','executor.model_used')"
          + " AND json_extract(payload,'$.escalation_from')=? AND json_extract(payload,'$.escalation_decided_at')=? ORDER BY seq DESC LIMIT 1",
          [node.replacement_node_run_id, nodeRunId, item?.decided_at ?? null]) : undefined
        const precondition = { run_id: runId, node_run_id: nodeRunId, expected_attempt: node.attempt, expected_action_generation: node.action_generation }
        let eligible = false
        if (planner && !node.replacement_node_run_id) {
          try {
            eligible = Boolean(factsFor(tx, secret, { ...precondition, operation_id: uuidv7() }, actor, nowAt(), profiles))
          } catch (error) {
            if (!(error instanceof OrchError && error.code === 'STALE_GENERATION')) throw error
          }
        }
        return { item, dispatch: dispatch ?? null, successor_node_run_id: node.replacement_node_run_id,
          precondition: eligible ? precondition : null, as_of_seq }
      })
    },
    tick(now: string) {
      const time = Date.parse(now)
      if (!planner || inFlight.size >= 2 || time < nextAutoAt) return
      nextAutoAt = time + 5_000
      for (const [id, until] of deferred) {
        if (until <= time) deferred.delete(id)
      }
      const cutoff = new Date(time - prolongedMs).toISOString()
      const pending = withReadTx(db, ({ tx }) => {
        const nodes = tx.all<Node>("SELECT n.* FROM runs r JOIN node_runs n USING(run_id)"
          + " WHERE r.status='running' AND r.cancel_requested_at IS NULL AND n.node_type='agent'"
          + " AND n.side_effect_policy='pure' AND n.replacement_node_run_id IS NULL AND n.recovery_uncertain IS NULL AND n.hang_reason IS NULL"
          + " AND (n.status='started' AND n.started_at<=? OR n.status IN ('blocked_post','failed','timeout')"
          + " AND EXISTS(SELECT 1 FROM node_run_events e WHERE e.node_run_id=n.node_run_id AND e.type='verify_human'"
          + " AND json_extract(e.payload,'$.reason') IN " + blockedReasons + ')'
          + " OR n.status='done' AND (SELECT COUNT(*) FROM rework_attempts a JOIN node_runs m ON m.node_run_id=a.new_node_run_id"
          + " WHERE m.run_id=n.run_id AND m.node_id=n.node_id AND a.status='request_changes')>=2)"
          + " AND NOT EXISTS(SELECT 1 FROM node_run_events e WHERE e.node_run_id=n.node_run_id AND e.type=?"
          + " AND json_extract(e.payload,'$.action_generation')=n.action_generation"
          + " AND json_extract(e.payload,'$.trigger')=CASE WHEN n.status='started' THEN 'prolonged_runtime'"
          + " WHEN n.status='done' THEN 'repeated_rework' ELSE 'execution_blocked' END)"
          + (cursor ? ' AND (n.updated_at,n.node_run_id)>(?,?)' : '')
          + ' ORDER BY n.updated_at,n.node_run_id LIMIT 20',
        cursor ? [cutoff, assessmentEvent, cursor.updated_at, cursor.node_run_id] : [cutoff, assessmentEvent])
        for (const node of nodes) {
          cursor = { updated_at: node.updated_at, node_run_id: node.node_run_id }
          if (inFlight.has(node.node_run_id) || deferred.has(node.node_run_id)) continue
          const body = { operation_id: uuidv7(), run_id: node.run_id, node_run_id: node.node_run_id,
            expected_attempt: node.attempt, expected_action_generation: node.action_generation }
          try {
            const owner = reviewOwnership(tx, secret, node.run_id).owner
            if (factsFor(tx, secret, body, owner, now, profiles)) return { body, owner }
          } catch (error) {
            if (!(error instanceof OrchError && ['STALE_GENERATION', 'FORBIDDEN'].includes(error.code))) throw error
          }
        }
        if (nodes.length < 20) cursor = undefined
      })
      if (pending) void assess(pending.body, pending.owner, now).catch((error) => {
        deferred.set(pending.body.node_run_id, time + 30_000)
        onError?.(error)
      })
    },
  }
}
