import { OrchError } from '../core/errors.ts'
import { uuidv7 } from '../core/ids.ts'
import { canonicalJson, sha256Hex } from '../core/canonical.ts'
import type { Tx } from '../infra/sqlite/driver.ts'
import type { ReadTx } from './queries/read-tx.ts'
import { appendNodeRunEvent } from '../infra/db/ledger.ts'
import { runtimeEdges } from './rework-edges.ts'

export type ExtraStep = { node_id: string; before_node_id: string; instruction: string }
type StepLineage = ExtraStep & { request_id: string; plan_hash: string; run_id: string; workflow_definition_hash: string; status: string }
type BoundNode = { node_run_id: string; node_id: string; run_id: string; node_type: string; side_effect_policy: string; workflow_definition_hash: string | null; definition_json: string | null; content_hash: string | null }
function boundNode(tx: ReadTx, nodeRunId: string): BoundNode {
  const node = tx.get<BoundNode>(`SELECT n.node_run_id,n.node_id,n.run_id,n.node_type,n.side_effect_policy,
    r.workflow_definition_hash,w.definition_json,w.content_hash FROM node_runs n JOIN runs r USING(run_id)
    LEFT JOIN workflow_versions w ON w.workflow_id=COALESCE(r.workflow_id,'default') AND w.version=r.workflow_version
    WHERE n.node_run_id=?`, [nodeRunId])
  if (!node) throw new OrchError('NOT_FOUND', 'extra step cannot resolve execution record')
  return node
}
function pinnedDefinition(node: BoundNode): { nodes: {node_id:string;type:string;side_effect_policy?:string}[]; edges?: {from:string;to:string}[] } {
  if (!node.definition_json || !node.workflow_definition_hash || node.content_hash !== node.workflow_definition_hash
    || sha256Hex(canonicalJson(JSON.parse(node.definition_json))) !== node.workflow_definition_hash) {
    throw new OrchError('WORKFLOW_VERSION_IMMUTABLE','extra step requires its unchanged persisted signed definition')
  }
  return JSON.parse(node.definition_json)
}
export function extraStepInstruction(tx: ReadTx, nodeRunId: string): StepLineage | null {
  const node = boundNode(tx,nodeRunId)
  const saved = tx.get<StepLineage>('SELECT e.*,q.status FROM rework_extra_steps e JOIN rework_requests q USING(request_id) WHERE e.run_id=? AND e.node_id=?',[node.run_id,node.node_id])
  if (!saved) return null
  const plan = tx.get<{proposal_json:string;approved_by:string;owner_actor:string}>(`SELECT p.proposal_json,p.approved_by,q.owner_actor
    FROM rework_local_plans p JOIN rework_requests q USING(request_id)
    WHERE p.plan_hash=? AND p.request_id=? AND q.run_id=? AND p.approved_by=q.owner_actor`,[saved.plan_hash,saved.request_id,node.run_id])
  const definition=pinnedDefinition(node)
  const original=definition.nodes.find(n=>n.node_id===saved.before_node_id)
  const claims = plan ? (JSON.parse(plan.proposal_json) as {insert_steps?:ExtraStep[]}).insert_steps : null
  if (!plan || node.node_type!=='agent' || node.side_effect_policy!=='pure' || (original?.type!=='agent' || original.side_effect_policy!=='pure')
    || saved.workflow_definition_hash!==node.workflow_definition_hash
    || !claims?.some(s=>canonicalJson(s)===canonicalJson({node_id:saved.node_id,before_node_id:saved.before_node_id,instruction:saved.instruction}))) {
    throw new OrchError('FORBIDDEN','extra step lineage or approved claims are missing')
  }
  return saved
}
/** Resolve a synthetic role only through its exact approved original signed role. */
export function resolvePinnedNodeId(tx: ReadTx, nodeRunId: string): string {
  const lineage=extraStepInstruction(tx,nodeRunId)
  return lineage?.before_node_id ?? boundNode(tx,nodeRunId).node_id
}
export function insertExtraSteps(tx: Tx, secret: string, input: {requestId:string;runId:string;planHash:string;steps:readonly ExtraStep[]}, now: string): {node_id:string;node_run_id:string;before_node_id:string}[] {
  if (input.steps.length===0) return []
  const plan=tx.get<{proposal_json:string;workflow_definition_hash:string}>(`SELECT p.proposal_json,r.workflow_definition_hash
    FROM rework_local_plans p JOIN rework_requests q USING(request_id) JOIN runs r ON r.run_id=q.run_id
    WHERE p.request_id=? AND p.plan_hash=? AND q.run_id=? AND p.approved_by=q.owner_actor
    AND q.approved_scope='replan_subgraph' AND q.status IN ('authorized','scheduled')
    AND r.status='running' AND r.cancel_requested_at IS NULL`,[input.requestId,input.planHash,input.runId])
  const claims=plan ? (JSON.parse(plan.proposal_json) as {insert_steps?:ExtraStep[]}).insert_steps : undefined
  if (!plan || !claims || canonicalJson(input.steps)!==canonicalJson(claims)) throw new OrchError('FORBIDDEN','inserted steps must exactly match the approved plan')
  const result: {node_id:string;node_run_id:string;before_node_id:string}[]=[]
  for (const step of input.steps) {
    if (Object.keys(step).some(key=>!['node_id','before_node_id','instruction'].includes(key))) throw new OrchError('FORBIDDEN','extra steps cannot override tools or models')
    const before=tx.get<{node_run_id:string;seq:number}>(`SELECT n.node_run_id,n.seq FROM node_runs n JOIN rework_impacts i ON i.node_run_id=n.node_run_id
      WHERE i.request_id=? AND i.released_at IS NULL AND n.run_id=? AND n.node_id=? AND n.status='queued'
      AND n.node_type='agent' AND n.side_effect_policy='pure' AND n.replacement_node_run_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM input_snapshots s WHERE s.consumer_node_run_id=n.node_run_id)`,[input.requestId,input.runId,step.before_node_id])
    if (!before) throw new OrchError('FORBIDDEN','extra step must precede an affected unbound queued pure original agent')
    const template=boundNode(tx,before.node_run_id)
    if (!pinnedDefinition(template).nodes.some(n=>n.node_id===step.before_node_id&&n.type==='agent'&&n.side_effect_policy==='pure')) throw new OrchError('FORBIDDEN','extra step template is absent from signed definition')
    if (tx.get('SELECT 1 FROM node_runs WHERE run_id=? AND node_id=?',[input.runId,step.node_id])) throw new OrchError('STALE_GENERATION','extra step ID is already used')
    const id='nrun_'+uuidv7()
    const seq=(tx.get<{seq:number}>('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM node_runs WHERE run_id=?',[input.runId])?.seq ?? before.seq+1)
    tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,attempt,status,revision,side_effect_policy,created_at,updated_at) VALUES(?,?,?,?,'agent',1,'queued',1,'pure',?,?)",[id,input.runId,step.node_id,seq,now,now])
    tx.run('INSERT INTO rework_extra_steps(run_id,node_id,node_run_id,request_id,plan_hash,before_node_id,instruction,workflow_definition_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[input.runId,step.node_id,id,input.requestId,input.planHash,step.before_node_id,step.instruction,plan.workflow_definition_hash,now])
    appendNodeRunEvent(tx,secret,id,'rework.step_inserted',{request_id:input.requestId,plan_hash:input.planHash,template_node_id:step.before_node_id})
    result.push({node_id:step.node_id,node_run_id:id,before_node_id:step.before_node_id})
  }
  return result
}
export function assertExtraStepExecutable(tx: ReadTx, nodeRunId: string): void {
  const step=extraStepInstruction(tx,nodeRunId)
  if (!step) return
  if (step.status!=='closed') throw new OrchError('STALE_GENERATION','inserted step waits for accepted rework')
  const node=boundNode(tx,nodeRunId)
  const base=pinnedDefinition(node).edges ?? []
  const edges=runtimeEdges(tx,step.run_id,base)
  if (!edges.some(e=>e.from===step.node_id&&e.to===step.before_node_id)
    || base.filter(e=>e.to===step.before_node_id).some(e=>!edges.some(actual=>actual.from===e.from&&actual.to===step.node_id))) {
    throw new OrchError('FORBIDDEN','inserted step dependency lineage is incomplete')
  }
}
