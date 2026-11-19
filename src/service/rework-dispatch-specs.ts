import { canonicalJson, hmacSha256Hex, sha256Hex } from '../core/canonical.ts'
import { OrchError } from '../core/errors.ts'
import type { Db, Tx } from '../infra/sqlite/driver.ts'
import { withReadTx } from './queries/read-tx.ts'
import type { NodeSpec } from './dispatcher.ts'
import type { WorkflowCatalog } from './workflows.ts'
import { assertToolsAuthorized, type ToolRegistry } from '../executor/tools.ts'
import { checkToolPolicy } from '../executor/session.ts'
import type { TriggerRunReady } from './task-trigger-dispatch.ts'

type Grant = {run_id:string;node_id:string;workflow_definition_hash:string;spec_json:string;tool_bindings_json:string;spec_hash:string;authority_hash:string}
const trustedRun = `NOT EXISTS(SELECT 1 FROM start_run_operations o JOIN task_plans p ON p.launch_operation_id=o.operation_id WHERE o.run_id=r.run_id)
 AND NOT EXISTS(SELECT 1 FROM task_trigger_occurrences o WHERE o.run_id=COALESCE(r.root_run_id,r.run_id))`
/** Only the existing dispatch pump owns scheduling; this predicate selects authorized manual successors. */
const requestBackedNode = `(
  (q.new_node_run_id=n.node_run_id AND q.status='scheduled')
  OR EXISTS(SELECT 1 FROM rework_impacts i WHERE i.request_id=q.request_id AND
   ((i.replacement_node_run_id=n.node_run_id AND q.status IN ('closed','awaiting_review')) OR
    (i.node_run_id=n.node_run_id AND i.released_at IS NOT NULL AND q.status='closed')))
  OR EXISTS(SELECT 1 FROM rework_extra_steps e WHERE e.request_id=q.request_id AND e.run_id=n.run_id AND e.node_id=n.node_id AND q.status='closed')
 )`
export const MANUAL_REWORK_PENDING = `EXISTS(SELECT 1 FROM node_runs n JOIN rework_requests q ON q.run_id=n.run_id
 WHERE n.run_id=r.run_id AND n.status='queued' AND n.replacement_node_run_id IS NULL
 AND EXISTS(SELECT 1 FROM rework_dispatch_specs g WHERE g.run_id=n.run_id
 AND NOT EXISTS(SELECT 1 FROM rework_dispatch_invalidations v WHERE v.run_id=g.run_id AND v.node_id=g.node_id)
 AND (g.node_id=n.node_id OR EXISTS(SELECT 1 FROM rework_extra_steps e WHERE e.run_id=n.run_id AND e.node_id=n.node_id AND e.before_node_id=g.node_id))) AND ${requestBackedNode})`
export const MANUAL_REWORK_ELIGIBLE = trustedRun + ' AND ' + MANUAL_REWORK_PENDING
function signature(secret:string, row:Omit<Grant,'authority_hash'>):string {return hmacSha256Hex(secret,canonicalJson(row))}
function bindings(registry:ToolRegistry,spec:NodeSpec):string {return canonicalJson(spec.tools.map(tool=>registry.require(tool.command)))}
function validateSpec(catalog:WorkflowCatalog,registry:ToolRegistry,run:TriggerRunReady,nodeId:string,spec:NodeSpec):void {
 const role=catalog.get(run.workflow_id,run.workflow_version).nodes.find(n=>n.node_id===nodeId)
 if (role?.type!=='agent' || catalog.initialAgentEffect(role)!=='pure' || Object.keys(spec).some(k=>!['tools','input','outputSchema'].includes(k)) || !Array.isArray(spec.tools)) throw new OrchError('FORBIDDEN','manual continuation requires a signed pure agent role')
 const policy={...catalog.toolPolicyFor(run.workflow_id,run.workflow_version,nodeId),declaredPolicy:'pure' as const}
 if(checkToolPolicy(registry,policy)!=='pure')throw new OrchError('FORBIDDEN','manual continuation cannot repeat side effects')
 assertToolsAuthorized(registry,policy,spec.tools)
 if(Buffer.byteLength(canonicalJson(spec))>262144)throw new OrchError('PAYLOAD_SCHEMA_INVALID','manual dispatch spec is too large to persist')
}
export function rememberManualDispatchSpecs(tx:Tx,secret:string,catalog:WorkflowCatalog,registry:ToolRegistry,runId:string,specs:Record<string,NodeSpec>,now:string):void {
 const run=tx.get<TriggerRunReady & {workflow_definition_hash:string}>(`SELECT r.run_id,r.task_id,r.workflow_id,CAST(r.workflow_version AS TEXT) AS workflow_version,r.workflow_definition_hash FROM runs r WHERE r.run_id=? AND r.status='running' AND r.cancel_requested_at IS NULL AND ${trustedRun}`,[runId])
 if(!run || !run.workflow_definition_hash || catalog.definitionHash(run.workflow_id,run.workflow_version)!==run.workflow_definition_hash)return
 for(const [nodeId,spec]of Object.entries(specs)) {
  // Explicit dispatch still validates invalid specs normally; only safe grants become restart authority.
  try{validateSpec(catalog,registry,run,nodeId,spec)}catch(error){if(error instanceof OrchError)continue;throw error}
  const specJson=canonicalJson(spec)
  const saved=tx.get<Grant>('SELECT * FROM rework_dispatch_specs WHERE run_id=? AND node_id=?',[runId,nodeId])
  if(saved){
   if(saved.spec_json!==specJson){
    if(tx.get('SELECT 1 FROM rework_requests WHERE run_id=? LIMIT 1',[runId]))throw new OrchError('CONFIRMATION_MISMATCH','manual continuation is bound to its original authorized inputs and tools')
    tx.run('INSERT OR IGNORE INTO rework_dispatch_invalidations VALUES(?,?,?,?)',[runId,nodeId,sha256Hex(specJson),now])
   }
   continue
  }
  const grant={run_id:runId,node_id:nodeId,workflow_definition_hash:run.workflow_definition_hash,spec_json:specJson,tool_bindings_json:bindings(registry,spec),spec_hash:sha256Hex(specJson)}
  tx.run('INSERT INTO rework_dispatch_specs VALUES(?,?,?,?,?,?,?,?)',[grant.run_id,grant.node_id,grant.workflow_definition_hash,grant.spec_json,grant.tool_bindings_json,grant.spec_hash,signature(secret,grant),now])
 }
}
export function resolveManualReworkSpecs(db:Db,secret:string,catalog:WorkflowCatalog,registry:ToolRegistry,run:TriggerRunReady):Record<string,NodeSpec>|undefined {
 return withReadTx(db,({tx})=>{
  const epoch=tx.get<{value:string}>("SELECT value FROM service_meta WHERE key='instance_epoch'")
  if(Number(epoch?.value??0)!==db.epoch)throw new OrchError('STALE_GENERATION','manual continuation belongs to an old service epoch')
  const current=tx.get<{workflow_definition_hash:string}>(`SELECT r.workflow_definition_hash FROM runs r WHERE r.run_id=? AND r.status='running' AND r.cancel_requested_at IS NULL AND ${MANUAL_REWORK_ELIGIBLE}`,[run.run_id])
  if(!current)return undefined
  if(current.workflow_definition_hash!==catalog.definitionHash(run.workflow_id,run.workflow_version))throw new OrchError('WORKFLOW_VERSION_IMMUTABLE','manual continuation definition changed')
  const specs:Record<string,NodeSpec>={}
  for(const row of tx.all<Grant>(`SELECT g.* FROM rework_dispatch_specs g WHERE g.run_id=?
   AND NOT EXISTS(SELECT 1 FROM rework_dispatch_invalidations v WHERE v.run_id=g.run_id AND v.node_id=g.node_id)
   AND EXISTS(SELECT 1 FROM node_runs n JOIN rework_requests q ON q.run_id=n.run_id
    WHERE n.run_id=g.run_id AND n.status='queued' AND n.replacement_node_run_id IS NULL
    AND (n.node_id=g.node_id OR EXISTS(SELECT 1 FROM rework_extra_steps e WHERE e.run_id=n.run_id AND e.node_id=n.node_id AND e.before_node_id=g.node_id))
    AND ${requestBackedNode})`,[run.run_id])) {
   const {authority_hash}=row
   // Explicit selection avoids binding the signature to unrelated projection columns.
   const signed={run_id:row.run_id,node_id:row.node_id,workflow_definition_hash:row.workflow_definition_hash,spec_json:row.spec_json,tool_bindings_json:row.tool_bindings_json,spec_hash:row.spec_hash}
   if(authority_hash!==signature(secret,signed)||sha256Hex(row.spec_json)!==row.spec_hash||row.workflow_definition_hash!==current.workflow_definition_hash)throw new OrchError('CONFIRMATION_MISMATCH','manual dispatch authority hash changed')
   const spec=JSON.parse(row.spec_json) as NodeSpec
   validateSpec(catalog,registry,run,row.node_id,spec)
   if(bindings(registry,spec)!==row.tool_bindings_json)throw new OrchError('TOOL_NOT_ALLOWED','manual continuation tool registration changed')
   specs[row.node_id]=spec
  }
  return Object.keys(specs).length?specs:undefined
 })
}
