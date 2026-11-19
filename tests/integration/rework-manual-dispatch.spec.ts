import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openServiceOrchestra } from '../../src/index.ts'
import { sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { freshLedger } from '../fixtures/ledger.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { createReworkHost } from '../../src/service/rework-coordinator.ts'
import { createReworkPlanningHost } from '../../src/service/rework-planning.ts'
import { createTriggerDispatchPump } from '../../src/service/task-trigger-dispatch.ts'
import { resolveManualReworkSpecs, rememberManualDispatchSpecs } from '../../src/service/rework-dispatch-specs.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { fakeAgentBridge, type FakeAgentBridge } from '../fixtures/agent-bridge.ts'
const secret='manual-dispatch-restart'
const owner='service:'+sha256Hex(secret).slice(0,8)
const cleanups:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup()})
it('continues an authenticated manual run after restart using the same dispatch pump and immutable original specs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'manual-rework-'));const file=join(dir,'orchestra.db');const now=new Date().toISOString()
 const registry=new ToolRegistry();registry.register({name:'ro.echo',capability:'read_only',command:{bin:'echo',args:['ok']}})
 const makeExecutor=()=>{
  let sequence=0;const agents=new Map<string,FakeAgentBridge>();const inputs:unknown[]=[]
  const bridge=new BridgeClient({
   request:async<T>(method:string,params:unknown):Promise<T>=>{const p=params as {executorAgentId:string};const agent=agents.get(p.executorAgentId);if(!agent)throw new Error('missing session');return agent.request<T>(method,params)},
   listen:(params,signal)=>{const agent=agents.get(params.executorAgentId)!;return(async function*(){for await(const event of agent.listen(params,signal))yield {...event,attempt:params.attempt}})()},
  })
  return {inputs,registry,bridge,runner:new ReadOnlyToolRunner(registry,{readonlyAvailable:()=>true,run:async()=>({exitCode:0,stdout:'ok\n',stderr:''})},dir),agents:{create:async(input:{input:unknown})=>{inputs.push(input.input);const agentId='agent_'+(++sequence);agents.set(agentId,fakeAgentBridge({agentId,steps:[{tool:'ro.echo'}],at:now}));return {agentId,sessionId:'session_'+agentId}}}}
 }
 const first=await openServiceOrchestra({dbFile:file,secret,phase:'S5',executor:makeExecutor()})
 let second:Awaited<ReturnType<typeof openServiceOrchestra>>|undefined
 cleanups.push(async()=>{if(second)await second.release();else try{await first.release()}catch{};rmSync(dir,{recursive:true,force:true})})
 const {db,catalog,commands}=first.orchestra
 catalog.load({workflow_id:'manual',workflow_version:'1',pass_conditions:[{path:'evidence.exitCode',op:'eq',value:0}],nodes:[{node_id:'A',type:'agent',side_effect_policy:'pure',tools:{allow:['ro.echo'],deny:[]}},{node_id:'B',type:'agent',side_effect_policy:'pure',tools:{allow:['ro.echo'],deny:[]}}],edges:[{from:'A',to:'B'}]})
 withTx(db,tx=>{
  tx.run("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','manual','running',?,?)",[now,now])
  tx.run("INSERT INTO runs(run_id,task_id,status,workflow_id,workflow_version,workflow_definition_hash,created_at,updated_at) VALUES('r','t','running','manual','1',?,?,?)",[catalog.definitionHash('manual','1'),now,now])
  for(const[id,node,status,seq]of[['a','A','done',1],['b','B','queued',2]]as const)tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,attempt,status,revision,side_effect_policy,created_at,updated_at) VALUES(?,'r',?,?,'agent',1,?,1,'pure',?,?)",[id,node,seq,status,now,now])
 })
 registerRunArtifact(db,{artifactId:'v1',runId:'r',nodeRunId:'a',fileName:'data.txt',bytes:Buffer.from('v1')})
 const feedback=createReworkHost(db,secret)
 const request=feedback.request({operation_id:uuidv7(),run_id:'r',target_node_run_id:'a',expected_revision:1,source_artifact_id:'v1',source_artifact_hash:sha256Hex('v1'),reason:'Fix input',expected_result:'v2',suggested_scope:'replan_subgraph'},owner,now)
 const tools=[{command:'ro.echo',args:[],cwd:'.',timeoutMs:5000}]
 const nodes={A:{input:{goal:'original collect'},tools},B:{input:{goal:'original analyze'},tools}}
 expect(await commands.dispatch({runId:'r',nodes,now})).toEqual([])
 expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_dispatch_specs').get()?.n).toBe(2)
 await expect(commands.dispatch({runId:'r',nodes:{B:{...nodes.B,input:{goal:'changed'}}},now})).rejects.toThrow(/original authorized inputs/)
 const planning=createReworkPlanningHost(db,secret,async()=>({reason:'Correct collector',changes:[{node_id:'A',instruction:'Correct the missing field'}],preserved_node_ids:['B']}))
 const body={operation_id:uuidv7(),request_id:request.request_id,expected_revision:request.revision}
 const proposed=await planning.propose(body,owner,now)
 const scheduled=planning.approve({...body,operation_id:uuidv7(),plan_hash:proposed.plan_hash},owner,now)
 await first.release()
 const executor=makeExecutor();second=await openServiceOrchestra({dbFile:file,secret,phase:'S5',executor})
 const restored=second.orchestra;const errors:unknown[]=[]
 const ready={run_id:'r',task_id:'t',workflow_id:'manual',workflow_version:'1'}
 withTx(restored.db,tx=>tx.run("UPDATE runs SET status='paused' WHERE run_id='r'"))
 expect(resolveManualReworkSpecs(restored.db,secret,restored.catalog,registry,ready)).toBeUndefined()
 withTx(restored.db,tx=>tx.run("UPDATE runs SET status='running' WHERE run_id='r'"))
 expect(()=>resolveManualReworkSpecs({...restored.db,epoch:restored.db.epoch-1},secret,restored.catalog,registry,ready)).toThrow(/epoch/)
 expect(()=>resolveManualReworkSpecs(restored.db,'wrong-secret',restored.catalog,registry,ready)).toThrow(/authority hash/)
 registry.register({name:'ro.echo',capability:'mutating',command:{bin:'echo',args:['ok']}})
 expect(()=>resolveManualReworkSpecs(restored.db,secret,restored.catalog,registry,ready)).toThrow()
 registry.register({name:'ro.echo',capability:'read_only',command:{bin:'echo',args:['ok']}})
 expect(Object.keys(resolveManualReworkSpecs(restored.db,secret,restored.catalog,registry,ready)??{})).toEqual(['A'])
 const pump=createTriggerDispatchPump(restored.db,undefined,(run,specs)=>restored.commands.dispatch({runId:run.run_id,nodes:specs,now:new Date().toISOString()}),error=>errors.push(error),undefined,{secret,resolveManual:run=>resolveManualReworkSpecs(restored.db,secret,restored.catalog,registry,run)})
 try {
  pump.tick()
  await expect.poll(()=>restored.db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id=?').get(scheduled.new_node_run_id)?.status).toBe('done')
  expect(executor.inputs[0]).toEqual(nodes.A.input)
  registerRunArtifact(restored.db,{artifactId:'v2',runId:'r',nodeRunId:scheduled.new_node_run_id!,fileName:'data.txt',bytes:Buffer.from('v2')})
  const recovered=createReworkHost(restored.db,secret);recovered.recover(new Date().toISOString());const review=recovered.get(request.request_id,owner).item.request
  recovered.review({operation_id:uuidv7(),request_id:request.request_id,expected_revision:review.revision,action:'accept',note:'v2 accepted',artifact_id:'v2',artifact_hash:sha256Hex('v2')},owner,new Date().toISOString())
  expect(Object.keys(resolveManualReworkSpecs(restored.db,secret,restored.catalog,registry,ready)??{})).toEqual(['B'])
  pump.tick()
  await expect.poll(()=>restored.db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='b'").get()?.status).toBe('done')
  expect(executor.inputs[1]).toEqual(nodes.B.input)
  expect(restored.db.raw.prepare("SELECT artifact_id FROM artifact_consumptions WHERE consumer_node_run_id='b'").all().map(row=>row.artifact_id)).toEqual(['v2'])
  expect(errors).toEqual([])
 } finally {await pump.close()}
})

it('grants only signed corroborated pure roles and preserves ordinary pre-feedback spec changes without replaying stale grants',()=>{
 const {db,dir}=freshLedger();cleanups.push(async()=>{db.raw.close();rmSync(dir,{recursive:true,force:true})})
 const registry=new ToolRegistry();const catalog=new WorkflowCatalog('S5',db,()=>true);const now=new Date().toISOString()
 catalog.load({workflow_id:'effects',workflow_version:'1',nodes:[
  {node_id:'pure',type:'agent',side_effect_policy:'pure',tools:{allow:[]}},
  {node_id:'irreversible',type:'agent',side_effect_policy:'irreversible',tools:{allow:[]}},
  {node_id:'compensable',type:'agent',side_effect_policy:'compensable',tools:{allow:[]}},
  {node_id:'legacy',type:'agent',tools:{allow:[]}},
 ]})
 withTx(db,tx=>{
  tx.run("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','ordinary','running',?,?)",[now,now])
  tx.run("INSERT INTO runs(run_id,task_id,status,workflow_id,workflow_version,workflow_definition_hash,created_at,updated_at) VALUES('r','t','running','effects','1',?,?,?)",[catalog.definitionHash('effects','1'),now,now])
  rememberManualDispatchSpecs(tx,secret,catalog,registry,'r',Object.fromEntries(['pure','irreversible','compensable','legacy'].map(role=>[role,{tools:[],input:{goal:'first'}}])),now)
 })
 expect(db.raw.prepare('SELECT node_id FROM rework_dispatch_specs').all().map(row=>row.node_id)).toEqual(['pure'])
 expect(()=>withTx(db,tx=>rememberManualDispatchSpecs(tx,secret,catalog,registry,'r',{pure:{tools:[],input:{goal:'ordinary change'}}},now))).not.toThrow()
 expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_dispatch_invalidations').get()?.n).toBe(1)
 expect(JSON.parse(String(db.raw.prepare("SELECT spec_json FROM rework_dispatch_specs WHERE node_id='pure'").get()?.spec_json)).input.goal).toBe('first')
})
