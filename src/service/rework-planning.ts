import { z } from 'zod'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { requestHashOf, runIdempotentCommand } from './commands/idempotency.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'
import { assertReworkOwner, authorizeReworkPlanInTx, loadReworkRequest } from './rework-coordinator.ts'
import { previewReworkImpact } from './rework-runtime.ts'
import { runtimeEdges } from './rework-edges.ts'
import { insertExtraSteps } from './rework-extra-steps.ts'
import { requireReviewOperator } from './delivery-review.ts'

const key = z.string().min(1).max(128)
export const localPlanInput = z.strictObject({ operation_id: z.uuidv7(), request_id: key, expected_revision: z.number().int().positive() })
export const localPlanApproval = localPlanInput.extend({ plan_hash: z.string().regex(/^[a-f0-9]{64}$/) })
const proposalSchema = z.strictObject({
  reason: z.string().trim().min(1).max(1200),
  changes: z.array(z.strictObject({ node_id: key, instruction: z.string().trim().min(1).max(1500) })).min(1).max(8),
  preserved_node_ids: z.array(key).max(200),
  additional_edges: z.array(z.strictObject({ from: key, to: key })).max(8).default([]),
  insert_steps: z.array(z.strictObject({ node_id: z.string().regex(/^rw_[a-z][a-z0-9_]{0,48}$/),
    before_node_id: key, instruction: z.string().trim().min(1).max(1500) })).max(2).default([]),
})
type Proposal = z.infer<typeof proposalSchema>
export type ReworkPlanner = (input: unknown, signal: AbortSignal) => Promise<unknown>
type PlanRow = { plan_hash: string; proposal_json: string; snapshot_json: string; revision: number; approved_by: string | null }
function view(row: PlanRow) {
  return { plan_hash: row.plan_hash, revision: row.revision, proposal: proposalSchema.parse(JSON.parse(row.proposal_json)), approved_by: row.approved_by }
}
function snapshot(tx: ReadTx, requestId: string, actor: string, revision: number, now: string) {
  const request = loadReworkRequest(tx, requestId)
  assertReworkOwner(tx, request, actor)
  if (request.revision !== revision || request.expires_at <= now || !['proposed', 'needs_human_approval'].includes(request.status)) {
    throw new OrchError('STALE_GENERATION', '反馈已变化，请重新查看当前请求')
  }
  if (!tx.get("SELECT 1 FROM runs WHERE run_id=? AND status='running' AND cancel_requested_at IS NULL", [request.run_id])) {
    throw new OrchError('STALE_GENERATION', '运行已暂停、终止或正在取消')
  }
  const nodes = tx.all<{ node_id: string; node_run_id: string; status: string; revision: number; node_type: string; side_effect_policy: string; has_inputs: number }>(
    `SELECT node_id,node_run_id,status,revision,node_type,side_effect_policy,
      EXISTS(SELECT 1 FROM input_snapshots s WHERE s.consumer_node_run_id=n.node_run_id) AS has_inputs
      FROM node_runs n WHERE run_id=? AND replacement_node_run_id IS NULL ORDER BY node_id`,
    [request.run_id])
  const target = nodes.find(n => n.node_run_id === request.target_node_run_id && n.status === 'done')
  if (!target) throw new OrchError('STALE_GENERATION', '原成果已被接班')
  const affected = previewReworkImpact(tx, request)
  const allowed = [target.node_id, ...affected.map(n => n.node_id)]
  const definition = tx.get<{ definition_json: string }>(`SELECT w.definition_json FROM runs r JOIN workflow_versions w
    ON w.workflow_id=COALESCE(r.workflow_id,'default') AND w.version=r.workflow_version WHERE r.run_id=?`, [request.run_id])
  if (!definition) throw new OrchError('WORKFLOW_VERSION_IMMUTABLE', '缺少用于校验局部规划的固定流程')
  const pinned = JSON.parse(definition.definition_json) as { nodes: {node_id:string}[]; edges?: {from:string;to:string}[] }
  const edges = runtimeEdges(tx, request.run_id, pinned.edges ?? [])
  const reviewer = nodes.find(n => n.node_run_id === request.requester_node_run_id)?.node_id ?? null
  return { request_id: requestId, revision, original_hash: request.source_artifact_hash, reason: request.reason,
    expected_result: request.expected_result, preserve: JSON.parse(request.preserve_requirements_json) as string[],
    budget: request.budget_remaining, target: target.node_id, allowed, nodes, edges, reviewer, pinned_node_ids: pinned.nodes.map(n => n.node_id) }
}
function approvedEdges(proposal: Proposal, state: ReturnType<typeof snapshot>) {
  const edges = [...state.edges]
  for (const edge of proposal.additional_edges) {
    const target = state.nodes.find(n => n.node_id === edge.to)
    if (!state.allowed.includes(edge.from) || !state.allowed.includes(edge.to)
      || target?.status !== 'queued' || target.has_inputs || target.node_type !== 'agent' || target.side_effect_policy !== 'pure'
      || !proposal.changes.some(c => c.node_id === edge.to)
      || edge.to === state.reviewer || edge.to === state.target || edge.from === edge.to
      || edges.some(e => e.from === edge.from && e.to === edge.to)) {
      throw new OrchError('FORBIDDEN', '新增依赖只能约束受影响范围内尚未执行的修订步骤')
    }
    edges.push(edge)
  }
  const inserted = new Set<string>()
  const before = new Set<string>()
  for (const step of proposal.insert_steps) {
    const anchor = state.nodes.find(n => n.node_id === step.before_node_id)
    if (!anchor || !state.allowed.includes(anchor.node_id) || !state.pinned_node_ids.includes(anchor.node_id)
      || anchor.status !== 'queued' || anchor.has_inputs || anchor.side_effect_policy !== 'pure' || anchor.node_type !== 'agent'
      || anchor.node_id === state.reviewer || anchor.node_id === state.target || before.has(anchor.node_id)
      || state.nodes.some(n => n.node_id === step.node_id) || state.pinned_node_ids.includes(step.node_id) || inserted.has(step.node_id)) {
      throw new OrchError('FORBIDDEN', '新增步骤需要唯一名称和未启动的受影响纯 Agent 角色')
    }
    before.add(anchor.node_id)
    inserted.add(step.node_id)
    const incoming = edges.filter(e => e.to === anchor.node_id)
    for (const edge of incoming) edges.push({ from: edge.from, to: step.node_id })
    edges.push({ from: step.node_id, to: anchor.node_id })
  }
  // Adding edges is monotone for prerequisites but can still introduce deadlocks.
  const remaining = new Set([...state.nodes.map(n => n.node_id), ...inserted])
  while (remaining.size) {
    const ready = [...remaining].filter(id => !edges.some(e => e.to === id && remaining.has(e.from)))
    if (!ready.length) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '局部调整在运行图中形成循环')
    for (const id of ready) remaining.delete(id)
  }
  return edges.slice(state.edges.length)
}
function planWorkUnits(p: Proposal, state: ReturnType<typeof snapshot>): number {
  const attempts = state.nodes.filter(n => state.allowed.includes(n.node_id) && n.status !== 'queued').length
  return Math.max(attempts, p.changes.length) + p.insert_steps.length
}
function validatePlan(raw: unknown, state: ReturnType<typeof snapshot>): Proposal {
  const parsed = proposalSchema.safeParse(raw)
  if (!parsed.success) throw new OrchError('PAYLOAD_SCHEMA_INVALID', '主脑返回的方案不符合局部重规划契约')
  const p = parsed.data
  const changes = p.changes.map(c => c.node_id)
  const all = [...changes, ...p.preserved_node_ids]
  if (new Set(all).size !== all.length || all.length !== state.nodes.length || !changes.includes(state.target)
    || state.nodes.some(n => !all.includes(n.node_id))
    || changes.some(id => !state.allowed.includes(id) || !state.nodes.some(n => n.node_id === id && n.node_type === 'agent' && n.side_effect_policy === 'pure'))) {
    throw new OrchError('FORBIDDEN', '局部方案越出依赖范围、遗漏保留节点或涉及非纯操作')
  }
  if (planWorkUnits(p, state) > state.budget) throw new OrchError('FORBIDDEN', '方案超过本次返工预算')
  approvedEdges(p, state)
  return p
}

export function createReworkPlanningHost(db: Db, secret: string, planner?: ReworkPlanner) {
  // The planner has no write authority. CAS and a unique (request,revision) pin its reviewed output.
  const inFlight = new Set<string>()
  return {
    enabled: Boolean(planner),
    topology(runId: string, actor: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        requireReviewOperator(tx, secret, actor, runId)
        if (!tx.get('SELECT 1 FROM runs WHERE run_id=?', [runId])) throw new OrchError('NOT_FOUND', '运行不存在')
        const requests = tx.all(`SELECT q.request_id,n.node_id AS target_node_id,q.status,q.round_no
          FROM rework_requests q JOIN node_runs n ON n.node_run_id=q.target_node_run_id
          WHERE q.run_id=? ORDER BY q.created_at,q.request_id`, [runId])
        const steps = tx.all('SELECT node_id,before_node_id,instruction FROM rework_extra_steps WHERE run_id=? ORDER BY created_at,node_id', [runId])
        const held = tx.all<{ node_id: string }>(`SELECT DISTINCT n.node_id FROM rework_impacts i
          JOIN node_runs n ON n.node_run_id=i.node_run_id JOIN rework_requests q USING(request_id)
          WHERE q.run_id=? AND i.released_at IS NULL AND q.status NOT IN ('closed','declined','cancelled') ORDER BY n.node_id`, [runId])
        return { as_of_seq, edges: runtimeEdges(tx, runId, []), steps, requests, held_node_ids: held.map(n => n.node_id) }
      })
    },
    get(id: string, actor: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        assertReworkOwner(tx, loadReworkRequest(tx, id), actor)
        const plan = tx.get<PlanRow>('SELECT * FROM rework_local_plans WHERE request_id=? ORDER BY revision DESC LIMIT 1', [id])
        return { plan: plan ? view(plan) : null, as_of_seq }
      })
    },
    async propose(input: z.infer<typeof localPlanInput>, actor: string, now: string) {
      if (!planner) throw new OrchError('SERVICE_UNAVAILABLE', '该宿主未配置返工规划模型，可使用人工处理')
      const body = localPlanInput.parse(input)
      const receipt = { kind: 'rework.plan', operationId: body.operation_id, requestHash: requestHashOf('rework.plan', { body, actor }), now }
      const key = body.request_id + '/' + body.expected_revision
      if (db.raw.prepare('SELECT 1 FROM inbox WHERE operation_id=?').get(body.operation_id)) {
        return withTx(db, tx => runIdempotentCommand(tx, receipt, (): ReturnType<typeof view> => { throw new OrchError('STALE_GENERATION', '规划回执已变化') }).result)
      }
      if (inFlight.has(key) || inFlight.size >= 2) throw new OrchError('COMMAND_BUSY', '主脑正在规划，请稍后查看方案')
      inFlight.add(key)
      try {
        const state = withReadTx(db, ({ tx }) => snapshot(tx, body.request_id, actor, body.expected_revision, now))
        const existing = db.raw.prepare('SELECT * FROM rework_local_plans WHERE request_id=? AND revision=?').get(body.request_id, body.expected_revision) as PlanRow | undefined
        const unchanged = existing?.snapshot_json === canonicalJson(state)
        const proposal = unchanged ? view(existing).proposal : validatePlan(await callBoundedPlanner(planner, state), state)
        return withTx(db, tx => runIdempotentCommand(tx, receipt, () => {
          const current = snapshot(tx, body.request_id, actor, body.expected_revision, new Date().toISOString())
          const snapshotJson = canonicalJson(state)
          if (snapshotJson !== canonicalJson(current)) throw new OrchError('STALE_GENERATION', '规划期间执行状态发生变化')
          const hash = sha256Hex(canonicalJson({ state, proposal }))
          if (existing && existing.snapshot_json !== snapshotJson) {
            // Node revisions moved. Supersede only the unapproved proposal; a previous hash can never authorize this one.
            tx.run('DELETE FROM rework_local_plans WHERE request_id=? AND revision=? AND approved_by IS NULL', [body.request_id, body.expected_revision])
          }
          validatePlan(proposal, current)
          tx.run(`INSERT OR IGNORE INTO rework_local_plans(request_id,revision,plan_hash,proposal_json,snapshot_json,created_at)
            VALUES(?,?,?,?,?,?)`, [body.request_id, body.expected_revision, hash, canonicalJson(proposal), snapshotJson, now])
          const saved = tx.get<PlanRow>('SELECT * FROM rework_local_plans WHERE request_id=? AND revision=?', [body.request_id, body.expected_revision])!
          appendEvent(tx, { type: 'rework.plan_proposed', runId: loadReworkRequest(tx, body.request_id).run_id,
            payload: { request_id: body.request_id, plan_hash: saved.plan_hash, actor } })
          return view(saved)
        }).result)
      } finally { inFlight.delete(key) }
    },
    approve(input: z.infer<typeof localPlanApproval>, actor: string, now: string) {
      const body = localPlanApproval.parse(input)
      return withTx(db, tx => runIdempotentCommand(tx, { kind: 'rework.plan_approve', operationId: body.operation_id,
        requestHash: requestHashOf('rework.plan_approve', { body, actor }), now }, () => {
        const state = snapshot(tx, body.request_id, actor, body.expected_revision, now)
        const saved = tx.get<PlanRow>('SELECT * FROM rework_local_plans WHERE request_id=? AND revision=? AND plan_hash=? AND approved_by IS NULL',
          [body.request_id, body.expected_revision, body.plan_hash])
        if (!saved || saved.snapshot_json !== canonicalJson(state)) throw new OrchError('STALE_GENERATION', '批准的方案或依赖快照已变化')
        const proposal = validatePlan(view(saved).proposal, state)
        if (sha256Hex(canonicalJson({ state, proposal })) !== saved.plan_hash) throw new OrchError('CONFIRMATION_MISMATCH', '方案哈希校验失败')
        tx.run('UPDATE rework_local_plans SET approved_by=? WHERE plan_hash=?', [actor, saved.plan_hash])
        const request = authorizeReworkPlanInTx(tx, secret, loadReworkRequest(tx, body.request_id), actor, now, planWorkUnits(proposal, state))
        insertExtraSteps(tx, secret, { requestId: request.request_id, runId: request.run_id, planHash: saved.plan_hash, steps: proposal.insert_steps }, now)
        for (const edge of approvedEdges(proposal, state)) {
          tx.run('INSERT INTO rework_plan_edges(request_id,plan_hash,run_id,from_node_id,to_node_id) VALUES(?,?,?,?,?)',
            [request.request_id, saved.plan_hash, request.run_id, edge.from, edge.to])
        }
        appendEvent(tx, { type: 'rework.plan_approved', runId: request.run_id, payload: { actor, request_id: request.request_id, plan_hash: saved.plan_hash } })
        return request
      }).result)
    },
  }
}

/** Custom host adapters may ignore the abort signal; always free the service slot at the deadline. */
export async function callBoundedPlanner(planner: ReworkPlanner, state: unknown) {
  const abort = AbortSignal.timeout(45_000)
  let rejectTimeout: () => void = () => {}
  const deadline = new Promise<never>((_, reject) => {
    rejectTimeout = () => reject(new OrchError('OPERATION_TIMEOUT', '主脑规划超时，请稍后重试或人工处理'))
    abort.addEventListener('abort', rejectTimeout, { once: true })
  })
  try { return await Promise.race([planner(state, abort), deadline]) }
  finally { abort.removeEventListener('abort', rejectTimeout) }
}
