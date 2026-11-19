import { expect, it, vi } from 'vitest'
import { sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { createReworkHost } from '../../src/service/rework-coordinator.ts'
import { createReworkInspectionHost } from '../../src/service/rework-inspection.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'

const owner = 'service:' + sha256Hex(TEST_SECRET).slice(0,8)
function setup(bytes = Buffer.from('Report without timestamp')) {
  const {db}=freshLedger()
  seed(db)
  const now=new Date().toISOString()
  const catalog=new WorkflowCatalog('S5',db)
  catalog.load({workflow_id:'inspection',workflow_version:'1',nodes:[{node_id:'n1',type:'agent'}]})
  withTx(db,tx=>{
    tx.run("UPDATE runs SET workflow_id='inspection',workflow_version='1',workflow_definition_hash=? WHERE run_id='r1'",[catalog.definitionHash('inspection','1')])
    tx.run("UPDATE node_runs SET status='done',side_effect_policy='pure' WHERE node_run_id='nr1'")
  })
  registerRunArtifact(db,{artifactId:'old',runId:'r1',nodeRunId:'nr1',bytes,fileName:'report.md'})
  const body={operation_id:uuidv7(),run_id:'r1',target_node_run_id:'nr1',source_artifact_id:'old',source_artifact_hash:sha256Hex(bytes),expected_revision:1,criteria:'Every sample must include a timestamp'}
  const rework=createReworkHost(db,TEST_SECRET)
  return {db,now,body,rework}
}

it('PASS pins the precise version and saves an immutable opinion without accepting or restarting the node',async()=>{
  const {db,now,body,rework}=setup()
  try {
    let received: unknown
    let calls=0
    const inspection=createReworkInspectionHost(db,TEST_SECRET,rework,async state=>{received=state;calls++;return {verdict:'pass',reason:'Report meets the stated criteria'}})
    const result=await inspection.inspect(body,owner,now)
    expect(result).toMatchObject({verdict:'pass',request:null,request_id:null,artifact_id:'old',artifact_hash:body.source_artifact_hash,reviewer_actor:'planner:'+owner})
    expect(received).toMatchObject({purpose:'inspect',artifact_id:'old',artifact_hash:body.source_artifact_hash,text:'Report without timestamp',criteria:body.criteria,node:{node_run_id:'nr1',attempt:1}})
    expect(await inspection.inspect(body,owner,now)).toEqual(result)
    expect(calls).toBe(1)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_requests').get()).toMatchObject({n:0})
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM node_runs').get()).toMatchObject({n:1})
    expect(db.raw.prepare("SELECT status FROM runs WHERE run_id='r1'").get()).toMatchObject({status:'running'})
    expect(inspection.list('r1',owner).items).toHaveLength(1)
    expect(()=>inspection.list('r1','human:other')).toThrow(/权限/)
    expect(()=>withTx(db,tx=>tx.run("UPDATE rework_inspections SET summary='overwritten'"))).toThrow(/immutable/)
  } finally {db.raw.close()}
})

it('a planner defect creates feedback and inspection in one actor-bound command receipt',async()=>{
  const {db,now,body,rework}=setup()
  try {
    const planner=vi.fn(async()=>({verdict:'changes',reason:'Missing timestamp',expected_result:'Every row includes time',preserve_requirements:['Keep measured values'],suggested_scope:'targeted_revision'}))
    const inspection=createReworkInspectionHost(db,TEST_SECRET,rework,planner)
    const result=await inspection.inspect(body,owner,now)
    expect(result).toMatchObject({verdict:'request_changes',request:{status:'scheduled',requester_actor:'planner:'+owner,source_artifact_hash:body.source_artifact_hash}})
    expect(result.request_id).toBe(result.request?.request_id)
    expect(await inspection.inspect(body,owner,now)).toEqual(result)
    expect(planner).toHaveBeenCalledTimes(1)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_inspections').get()).toMatchObject({n:1})
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_requests').get()).toMatchObject({n:1})
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM inbox WHERE operation_id=?').get(body.operation_id)).toMatchObject({n:1})
    await expect(inspection.inspect(body,'human:other',now)).rejects.toThrow(/operation_id/)
  } finally {db.raw.close()}
})

it('rejects unauthorized actors, source mismatches, and tampered content before invoking a model',async()=>{
  const {db,now,body,rework}=setup()
  try {
    const planner=vi.fn(async()=>({verdict:'pass',reason:'Fine'}))
    const inspection=createReworkInspectionHost(db,TEST_SECRET,rework,planner)
    await expect(inspection.inspect(body,'human:other',now)).rejects.toThrow(/权限/)
    await expect(inspection.inspect({...body,source_artifact_hash:'0'.repeat(64)},owner,now)).rejects.toThrow(/哈希/)
    await expect(inspection.inspect({...body,expected_revision:0},owner,now)).rejects.toThrow(/当前已完成/)
    withTx(db,tx=>tx.run("UPDATE artifact_contents SET bytes=? WHERE artifact_id='old'",[Buffer.from('tampered')]))
    await expect(inspection.inspect(body,owner,now)).rejects.toThrow(/哈希/)
    expect(planner).not.toHaveBeenCalled()
    expect(inspection.list('r1',owner).items).toEqual([])
  } finally {db.raw.close()}
})

it('model output has no write authority when schema, tool scope or a concurrent snapshot is invalid',async()=>{
  const {db,now,body,rework}=setup()
  try {
    let output:unknown={verdict:'pass',reason:'Fine',tools:['write']}
    const inspection=createReworkInspectionHost(db,TEST_SECRET,rework,async()=>output)
    await expect(inspection.inspect(body,owner,now)).rejects.toThrow(/契约/)
    output={verdict:'changes',reason:'Bad',expected_result:'Fix',preserve_requirements:[],actor:'human:owner'}
    await expect(inspection.inspect(body,owner,now)).rejects.toThrow(/契约/)
    const concurrent=createReworkInspectionHost(db,TEST_SECRET,rework,async()=>{
      withTx(db,tx=>tx.run("UPDATE runs SET revision=revision+1 WHERE run_id='r1'"))
      return {verdict:'changes',reason:'Bad',expected_result:'Fix',preserve_requirements:[]}
    })
    await expect(concurrent.inspect(body,owner,now)).rejects.toThrow(/快照/)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_requests').get()).toMatchObject({n:0})
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_inspections').get()).toMatchObject({n:0})
    expect(db.raw.prepare('SELECT 1 FROM inbox WHERE operation_id=?').get(body.operation_id)).toBeUndefined()
  } finally {db.raw.close()}
})

it('the text boundary validates full UTF8 bytes and refuses truncation or binary input',async()=>{
  for (const bytes of [Buffer.from('中'.repeat(22000)),Buffer.from([0xc3,0x28]),Buffer.from([0x61,0,0x62])]) {
    const {db,now,body,rework}=setup(bytes)
    try {
      const planner=vi.fn(async()=>({verdict:'pass',reason:'Fine'}))
      await expect(createReworkInspectionHost(db,TEST_SECRET,rework,planner).inspect(body,owner,now)).rejects.toThrow()
      expect(planner).not.toHaveBeenCalled()
    } finally {db.raw.close()}
  }
})

it('failed defect submission rolls back the opinion and receipt together',async()=>{
  const {db,now,body,rework}=setup()
  try {
    const {criteria: _criteria,...feedback}=body
    rework.request({...feedback,operation_id:uuidv7(),reason:'Other feedback',expected_result:'Fix',suggested_scope:'rerun_node'},owner,now)
    const inspection=createReworkInspectionHost(db,TEST_SECRET,rework,async()=>({verdict:'changes',reason:'Missing timestamp',expected_result:'Add timestamp',preserve_requirements:[]}))
    await expect(inspection.inspect(body,owner,now)).rejects.toThrow(/未完成返工/)
    expect(inspection.list('r1',owner).items).toEqual([])
    expect(db.raw.prepare('SELECT 1 FROM inbox WHERE operation_id=?').get(body.operation_id)).toBeUndefined()
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM rework_requests').get()).toMatchObject({n:1})
  } finally {db.raw.close()}
})

it('an unavailable model is diagnosable and never creates feedback',async()=>{
  const {db,now,body,rework}=setup()
  try {
    const inspection=createReworkInspectionHost(db,TEST_SECRET,rework)
    expect(inspection.enabled).toBe(false)
    await expect(inspection.inspect(body,owner,now)).rejects.toThrow(/未配置/)
    expect(inspection.list('r1',owner).items).toEqual([])
  } finally {db.raw.close()}
})

it('a bounded timeout frees the inspection slot without persisting a partial command',async()=>{
  const {db,now,body,rework}=setup()
  const controller=new AbortController()
  const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal)
  try {
    let hang=true
    const inspection=createReworkInspectionHost(db,TEST_SECRET,rework,async()=>hang?new Promise(()=>{}):{verdict:'pass',reason:'Checked'})
    const pending=inspection.inspect(body,owner,now)
    const failure=expect(pending).rejects.toThrow(/超时/)
    controller.abort()
    await failure
    expect(db.raw.prepare('SELECT 1 FROM inbox WHERE operation_id=?').get(body.operation_id)).toBeUndefined()
    timeout.mockRestore()
    hang=false
    expect((await inspection.inspect(body,owner,now)).verdict).toBe('pass')
  } finally {timeout.mockRestore();db.raw.close()}
})

it('parallel inspection of one version is bounded and snapshot mutation during a call prevents persistence',async()=>{
  const {db,now,body,rework}=setup()
  try {
    let finish!:(value:unknown)=>void
    const inspection=createReworkInspectionHost(db,TEST_SECRET,rework,()=>new Promise(resolve=>{finish=resolve}))
    const pending=inspection.inspect(body,owner,now)
    await expect(inspection.inspect({...body,operation_id:uuidv7()},owner,now)).rejects.toThrow(/正在检查/)
    withTx(db,tx=>tx.run("UPDATE artifact_contents SET bytes=? WHERE artifact_id='old'",[Buffer.from('changed while inspecting')]))
    finish({verdict:'pass',reason:'Outdated opinion'})
    await expect(pending).rejects.toThrow(/哈希/)
    expect(inspection.list('r1',owner).items).toHaveLength(0)
  } finally {db.raw.close()}
})

it('a child run inspection inherits the current root task plan owner and rejects stale task roots',async()=>{
  const {db,now,body,rework}=setup()
  try {
    const launch=uuidv7()
    withTx(db,tx=>{
      tx.run("UPDATE tasks SET current_run_id='r1' WHERE task_id='t1'")
      tx.run('INSERT INTO start_run_operations VALUES(?,?,?,?)',[launch,'t1','r1',now])
      tx.run('INSERT INTO task_plans(plan_id,created_by,input_json,proposal_json,quality_json,content_hash,launch_operation_id,created_at) VALUES(?,?,\'{}\',\'{}\',\'{}\',?,?,?)',['plan','human:task-owner','hash',launch,now])
      tx.run("INSERT INTO runs(run_id,task_id,status,revision,parent_run_id,parent_node_run_id,root_run_id,workflow_id,workflow_version,created_at,updated_at) VALUES('child','t1','running',1,'r1','parent-control','r1','inspection','1',?,?)",[now,now])
      tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,revision,side_effect_policy,created_at,updated_at) VALUES('child-node','child','n1',1,'agent','done',1,'pure',?,?)",[now,now])
    })
    const bytes=Buffer.from('Child report')
    registerRunArtifact(db,{artifactId:'child-output',runId:'child',nodeRunId:'child-node',bytes,fileName:'child.md'})
    const childBody={...body,run_id:'child',target_node_run_id:'child-node',source_artifact_id:'child-output',source_artifact_hash:sha256Hex(bytes)}
    const inspection=createReworkInspectionHost(db,TEST_SECRET,rework,async()=>({verdict:'pass',reason:'Child report meets requirements'}))
    await expect(inspection.inspect(childBody,owner,now)).rejects.toThrow(/权限/)
    expect((await inspection.inspect(childBody,'human:task-owner',now)).verdict).toBe('pass')
    expect(inspection.list('child','human:task-owner').items).toHaveLength(1)
    withTx(db,tx=>tx.run("UPDATE tasks SET current_run_id='another-root' WHERE task_id='t1'"))
    await expect(inspection.inspect({...childBody,operation_id:uuidv7()},'human:task-owner',now)).rejects.toThrow(/活动运行/)
  } finally {db.raw.close()}
})
