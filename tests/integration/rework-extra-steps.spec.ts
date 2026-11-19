import { afterEach, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { SystemClock } from '../../src/core/clock.ts'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { createReworkHost } from '../../src/service/rework-coordinator.ts'
import { createReworkPlanningHost } from '../../src/service/rework-planning.ts'
import { extraStepInstruction, resolvePinnedNodeId } from '../../src/service/rework-extra-steps.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { startServer, type NodeCommands } from '../../src/service/server.ts'
import { dispatchRun } from '../../src/service/dispatcher.ts'
import { acquireLease } from '../../src/service/commands/lease.ts'
import { runNode, type RunNodeDeps } from '../../src/executor/run-node.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { fakeAgentClient } from '../fixtures/agent-bridge.ts'
import { freshLedger, TEST_SECRET } from '../fixtures/ledger.ts'
const owner='service:'+sha256Hex(TEST_SECRET).slice(0,8)
const cleanup:Array<()=>void>=[]
afterEach(()=>{for(const c of cleanup.splice(0))c()})
async function setup() {
 const {db,dir}=freshLedger()
 cleanup.push(()=>{db.raw.close();rmSync(dir,{recursive:true,force:true})})
 const now=new Date().toISOString()
 const catalog=new WorkflowCatalog('S5',db,name=>name==='ro.echo')
 catalog.load({workflow_id:'steps',workflow_version:'1',pass_conditions:[{path:'evidence.exitCode',op:'eq',value:0}],
  nodes:[{node_id:'A',type:'agent',side_effect_policy:'pure',tools:{allow:['ro.echo'],deny:[]}},{node_id:'B',type:'agent',side_effect_policy:'pure',tools:{allow:['ro.echo'],deny:[]}}],edges:[{from:'A',to:'B'}]})
 withTx(db,tx=>{
  tx.run("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',?,?)",[now,now])
  tx.run("INSERT INTO runs(run_id,task_id,status,workflow_id,workflow_version,workflow_definition_hash,created_at,updated_at) VALUES('r','t','running','steps','1',?,?,?)",[catalog.definitionHash('steps','1'),now,now])
  for(const [id,node,status,seq] of [['a','A','done',1],['b','B','queued',2]] as const)tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,attempt,status,revision,side_effect_policy,created_at,updated_at) VALUES(?,'r',?,?,'agent',1,?,1,'pure',?,?)",[id,node,seq,status,now,now])
 })
 registerRunArtifact(db,{artifactId:'v1',runId:'r',nodeRunId:'a',fileName:'data.txt',bytes:Buffer.from('v1')})
 const feedback=createReworkHost(db,TEST_SECRET)
 const request=feedback.request({operation_id:uuidv7(),run_id:'r',target_node_run_id:'a',expected_revision:1,source_artifact_id:'v1',source_artifact_hash:sha256Hex('v1'),reason:'Missing a verification step',expected_result:'Validate revised data first',suggested_scope:'replan_subgraph'},owner,now)
 const planning=createReworkPlanningHost(db,TEST_SECRET,async()=>({reason:'Insert read-only input validation',changes:[{node_id:'A',instruction:'Fix data'},{node_id:'B',instruction:'Use checked data'}],preserved_node_ids:[],insert_steps:[{node_id:'rw_validate',before_node_id:'B',instruction:'Check revised data without changing tools'}]}))
 const body={request_id:request.request_id,expected_revision:request.revision,operation_id:uuidv7()}
 const proposed=await planning.propose(body,owner,now)
 const approved=planning.approve({...body,operation_id:uuidv7(),plan_hash:proposed.plan_hash},owner,now)
 const clone=db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id='r' AND node_id='rw_validate'").get()?.node_run_id as string
 const accept=()=>{
  withTx(db,tx=>tx.run("UPDATE node_runs SET status='done',revision=revision+1 WHERE node_run_id=?",[approved.new_node_run_id]))
  registerRunArtifact(db,{artifactId:'v2',runId:'r',nodeRunId:approved.new_node_run_id!,fileName:'data.txt',bytes:Buffer.from('v2')})
  feedback.recover(now)
  const review=feedback.get(request.request_id,owner).item.request
  feedback.review({operation_id:uuidv7(),request_id:request.request_id,expected_revision:review.revision,action:'accept',note:'Confirmed revised data',artifact_id:'v2',artifact_hash:sha256Hex('v2')},owner,now)
 }
 const registry=new ToolRegistry()
 registry.register({name:'ro.echo',capability:'read_only',command:{bin:'echo',args:['ok']}})
 registry.register({name:'ro.secret',capability:'read_only',command:{bin:'secret',args:[]}})
 const runtime={db,secret:TEST_SECRET,catalog,phase:'S5' as const,clock:new SystemClock('extra-step')}
 const bridge=fakeAgentClient({agentId:'agent',steps:[{tool:'ro.echo'}],at:now})
 const modelRoles:string[]=[]
 const executor:RunNodeDeps={db,secret:TEST_SECRET,runtime,registry,bridge,runner:new ReadOnlyToolRunner(registry,{readonlyAvailable:()=>true,run:async()=>({exitCode:0,stdout:'ok\n',stderr:''})},dir),agents:{create:async()=>({agentId:'agent',sessionId:'session',effectiveModelRef:'approved/read'})},modelRouting:{profiles:[{ref:'approved/read',capacity:'routine'}],recommend:context=>{modelRoles.push(context.nodeId);return {complexity:'routine',reason:'Inherited original signed role'}}}}
 return {db,dir,now,catalog,runtime,executor,clone,approved,accept,bridge,modelRoles}
}
it('dispatches an actually approved inserted step through inherited signed tools and report verification',async()=>{
 const {db,now,catalog,runtime,executor,clone,accept,bridge,modelRoles}=await setup()
 expect(()=>withTx(db,tx=>acquireLease(tx,TEST_SECRET,{nodeRunId:clone,ownerEpoch:db.epoch,leaseTtlMs:30000,now}))).toThrow(/accepted/)
 accept()
 const dispatch: NodeCommands['dispatch']=body=>dispatchRun({db,secret:TEST_SECRET,runtime,catalog,executor},body)
 const server=await startServer({secret:TEST_SECRET,phase:'S5',epoch:db.epoch,asOfSeq:()=>0,listTasks:()=>[],listEvents:()=>[],appendLedgerEvent:()=>({seq:0,event_id:'unused'}),now:()=>now,commands:{dispatch} as NodeCommands})
 let result: Awaited<ReturnType<typeof dispatch>>
 try {
  const response=await fetch(server.endpoint+'/v1/runs/dispatch',{method:'POST',headers:{'content-type':'application/json','x-orchestra-secret':TEST_SECRET},body:JSON.stringify({runId:'r',nodes:{B:{tools:[{command:'ro.echo',args:[],cwd:'.',timeoutMs:5000}]}}})})
  expect(response.status).toBe(200)
  const payload=await response.json() as {data:Awaited<ReturnType<typeof dispatch>>}
  result=payload.data
 } finally {await server.close()}
 expect(result.find(row=>row.node_run_id===clone)?.status).toBe('done')
 expect(db.raw.prepare('SELECT status,attempt FROM node_runs WHERE node_run_id=?').get(clone)).toMatchObject({status:'done',attempt:1})
 expect(db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='b'").get()?.status).toBe('queued')
 expect(db.raw.prepare('SELECT COUNT(*) AS n FROM tool_executions WHERE node_run_id=?').get(clone)?.n).toBe(1)
 const instruction=bridge.calls.find(call=>call.method==='executor.send')?.params
 expect(JSON.stringify(instruction)).toContain('Check revised data')
 expect(JSON.stringify(instruction)).toContain('v2')
 expect(modelRoles).toEqual(['B'])
})
it('resolves persisted lineage after restart and refuses expanded direct tool or role authorization',async()=>{
 const {db,now,catalog,runtime,executor,clone,accept}=await setup()
 const reopened=openDb(db.file)
 try {
  const restored=new WorkflowCatalog('S5',reopened);restored.hydrate()
  expect(withTx(reopened,tx=>resolvePinnedNodeId(tx,clone))).toBe('B')
  expect(withTx(reopened,tx=>extraStepInstruction(tx,clone))?.instruction).toContain('Check revised data')
  expect(restored.toolPolicyFor('steps','1','B').allow).toEqual(['ro.echo'])
 } finally {reopened.raw.close()}
 accept()
 const base={nodeRunId:clone,nodeId:'rw_validate',attempt:1,input:{},outputSchema:{},now,ownerEpoch:db.epoch,leaseTtlMs:30000}
 await expect(runNode(executor,{...base,tools:[{command:'ro.secret',args:[],cwd:'.',timeoutMs:5000}]})).rejects.toThrow()
 await expect(runNode(executor,{...base,nodeId:'A',tools:[]})).rejects.toThrow(/node_id/)
 expect(db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id=?').get(clone)?.status).toBe('queued')
 withTx(db,tx=>tx.run("UPDATE rework_local_plans SET proposal_json=json_set(proposal_json,'$.insert_steps',json('[]')) WHERE approved_by IS NOT NULL"))
 expect(()=>withTx(db,tx=>extraStepInstruction(tx,clone))).toThrow(/claims/)
})

