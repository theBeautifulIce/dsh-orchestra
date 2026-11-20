import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { applySteps, loadSteps, defaultMigrationsDir } from '../../src/infra/db/migrate.ts'
import { authorizeReworkRuntime, acceptReworkRuntime, snapshotArtifactInputs, prepareReworkReviewer, assertReworkExecutionAllowed } from '../../src/service/rework-runtime.ts'
import { transitionNode } from '../../src/service/commands/node-state.ts'
import { acquireLease } from '../../src/service/commands/lease.ts'
import { SystemClock } from '../../src/core/clock.ts'
import { runtimeEdges } from '../../src/service/rework-edges.ts'
import { dispatchRun, type DispatchDeps } from '../../src/service/dispatcher.ts'
import { WorkflowCatalog, definitionHashOf } from '../../src/service/workflows.ts'
import { previewReworkImpact } from '../../src/service/rework-runtime.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { getNodeSnapshot, listNodes } from '../../src/service/queries/nodes.ts'
const now = '2026-11-19T00:00:00.000Z'
const secret = 'rework-runtime-test'
const cleanup: Array<() => void> = []
afterEach(() => { for (const c of cleanup.splice(0)) c() })
function setup() {
 const dir = mkdtempSync(join(tmpdir(),'rework-runtime-'))
 const db = openDb(join(dir,'db.sqlite'))
 cleanup.push(() => { db.raw.close(); rmSync(dir,{recursive:true,force:true}) })
 applySteps(db,loadSteps(defaultMigrationsDir()))
 withTx(db, tx => {
  tx.run("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',?,?)",[now,now])
  tx.run("INSERT INTO runs(run_id,task_id,status,workflow_id,workflow_version,created_at,updated_at) VALUES('r','t','running','w','1',?,?)",[now,now])
  tx.run('INSERT INTO workflow_versions(workflow_id,version,content_hash,definition_json,created_at) VALUES(?,?,?,?,?)',['w','1','h',JSON.stringify({edges:[{from:'a',to:'b'},{from:'a',to:'c'},{from:'b',to:'d'},{from:'c',to:'d'}]}),now])
  for (const [idx,id] of ['a','b','c','d','unrelated'].entries()) tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,attempt,status,side_effect_policy,created_at,updated_at) VALUES(?,'r',?,?,'agent',1,'done','pure',?,?)",[id,id,idx,now,now])
  for (const id of ['a','b','c']) artifact(tx,id,id+'-v1')
 })
 return db
}
function artifact(tx: Parameters<Parameters<typeof withTx>[1]>[0], n: string, id: string) {
 tx.run("INSERT INTO artifacts(artifact_id,run_id,uri,sha256,created_at) VALUES(?,'r',?,'hash',?)",[id,id,now])
 tx.run('INSERT INTO artifact_contents(artifact_id,file_name,node_run_id,bytes) VALUES(?,?,?,?)',[id,'result.txt',n,Buffer.from(id)])
}
function request(db: Db, requester: string | null = null) {
 withTx(db,tx => tx.run("INSERT INTO rework_requests(request_id,run_id,requester_node_run_id,requester_actor,owner_actor,target_node_run_id,target_attempt,source_artifact_id,source_artifact_hash,reason,expected_result,preserve_requirements_json,suggested_scope,status,evidence_ids_json,expires_at,created_at,updated_at) VALUES('q','r',?,'human','owner','a',1,'a-v1','hash','fix','fixed','[]','targeted_revision','authorized','[]','2099-01-01',?,?)",[requester,now,now]))
 return {request_id:'q',run_id:'r',target_node_run_id:'a',requester_node_run_id:requester}
}
describe('version-bound rework runtime',() => {
 it('projects only known run dependencies and distinguishes failed predecessors from waiting ones', () => {
  const db = setup()
  request(db)
  const catalog = new WorkflowCatalog('S2', db)
  const nodes = ['a', 'b', 'c', 'd', 'unrelated'].map(node_id => ({ node_id, type: 'agent' as const }))
  catalog.load({ workflow_id: 'w', workflow_version: '2', nodes, edges: [{ from: 'b', to: 'd' }] })
  catalog.load({ workflow_id: 'w', workflow_version: '3', nodes, edges: [{ from: 'a', to: 'd' }] })
  const hash = definitionHashOf(catalog.get('w', '2'))
  withTx(db, tx => {
   tx.run("UPDATE runs SET workflow_version='2',workflow_definition_hash=? WHERE run_id='r'", [hash])
   tx.run("UPDATE node_runs SET status='queued' WHERE node_run_id IN ('d','b')")
   tx.run("UPDATE node_runs SET status='failed' WHERE node_run_id='unrelated'")
   tx.run("INSERT INTO rework_local_plans(request_id,revision,plan_hash,proposal_json,snapshot_json,created_at,approved_by) VALUES('q',1,'approved-plan','{}','{}',?,'owner')", [now])
   tx.run("INSERT INTO rework_plan_edges VALUES('q','approved-plan','r','unrelated','d')")
  })
  const full = listNodes(db, 'r', 5)
  expect(full.has_more).toBe(false)
  expect(listNodes(db, 'r', 4)).toMatchObject({ items: full.items.slice(0, 4), has_more: true })
  expect(full.items.find(node => node.node_id === 'a')?.depends_on).toEqual([])
  expect(full.items.find(node => node.node_id === 'd')).toMatchObject({
   execution_state: 'blocked_dependencies', depends_on: ['b', 'unrelated'], waiting_on: ['unrelated'],
  })
  withTx(db, tx => tx.run("UPDATE runs SET workflow_definition_hash='missing-definition' WHERE run_id='r'"))
  expect(listNodes(db, 'r').items.every(node => !Object.hasOwn(node, 'depends_on'))).toBe(true)
  expect(getNodeSnapshot(db, 'd').item).toMatchObject({ execution_state: 'queued_unknown' })
  withTx(db, tx => tx.run("UPDATE runs SET workflow_definition_hash=NULL,workflow_version='99' WHERE run_id='r'"))
  expect(getNodeSnapshot(db, 'a').item).not.toHaveProperty('depends_on')
 })

 it('preserves done history, invalidates the diamond and leaves unrelated attempts intact',() => {
  const db=setup(); const req=request(db)
  const fresh=withTx(db,tx=>authorizeReworkRuntime(tx,secret,req,now))
  expect(db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='a'").get()?.status).toBe('done')
  expect(db.raw.prepare('SELECT count(*) n FROM rework_impacts').get()?.n).toBe(3)
  expect(()=>withTx(db,tx=>authorizeReworkRuntime(tx,secret,req,now))).toThrow()
  expect(withTx(db,tx=>closeRun(tx,secret,'r',now))).toBeNull()
  withTx(db,tx=>{tx.run("UPDATE node_runs SET status='done' WHERE node_run_id=?",[fresh]); artifact(tx,fresh,'a-v2'); tx.run("UPDATE rework_requests SET status='awaiting_review',new_node_run_id=? WHERE request_id='q'",[fresh])})
  expect(()=>withTx(db,tx=>snapshotArtifactInputs(tx,'unrelated',[fresh],now))).toThrow()
  withTx(db,tx=>{acceptReworkRuntime(tx,secret,{...req,new_node_run_id:fresh},now);tx.run("UPDATE rework_requests SET status='closed' WHERE request_id='q'")})
  expect(db.raw.prepare("SELECT count(*) n FROM node_runs WHERE node_id='unrelated'").get()?.n).toBe(1)
  expect(db.raw.prepare("SELECT count(*) n FROM node_runs WHERE node_id IN ('b','c','d') AND attempt=2").get()?.n).toBe(3)
 })
 it('fences stale running completion and resumes the requester in a fresh candidate-review session',()=>{
  const db=setup()
  withTx(db,tx=>{ tx.run("UPDATE node_runs SET status='queued' WHERE node_run_id='b'");snapshotArtifactInputs(tx,'b',['a'],now);acquireLease(tx,secret,{nodeRunId:'b',ownerEpoch:0,leaseTtlMs:100000,now});const b=tx.get<{revision:number}>("SELECT revision FROM node_runs WHERE node_run_id='b'")!;transitionNode(tx,secret,{nodeRunId:'b',from:'dispatched',to:'started',attempt:1,revision:b.revision,now,reason:'test'}) })
  const req=request(db,'b'); const fresh=withTx(db,tx=>authorizeReworkRuntime(tx,secret,req,now))
  expect(db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='b'").get()?.status).toBe('superseded')
  expect(getNodeSnapshot(db, 'b').item).toMatchObject({
   execution_state: 'superseded', status_label: '本次尝试已停止', replacement_node_run_id: null,
  })
  expect(()=>withTx(db,tx=>assertReworkExecutionAllowed(tx,'b',true))).toThrow()
  withTx(db,tx=>{tx.run("UPDATE node_runs SET status='done' WHERE node_run_id=?",[fresh]);artifact(tx,fresh,'a-v2');tx.run("UPDATE rework_requests SET status='awaiting_review',new_node_run_id=? WHERE request_id='q'",[fresh])})
  const review=withTx(db,tx=>prepareReworkReviewer(tx,secret,{...req,new_node_run_id:fresh},now))!
  const inputs=withTx(db,tx=>snapshotArtifactInputs(tx,review,[fresh],now))
  expect(inputs.map(x=>x.artifact_id)).toEqual(['a-v2'])
  expect(()=>withTx(db,tx=>assertReworkExecutionAllowed(tx,review,true))).toThrow()
  withTx(db,tx=>{acceptReworkRuntime(tx,secret,{...req,new_node_run_id:fresh},now);tx.run("UPDATE rework_requests SET status='closed' WHERE request_id='q'")})
  expect(()=>withTx(db,tx=>assertReworkExecutionAllowed(tx,review,true))).not.toThrow()
  expect(db.raw.prepare("SELECT count(*) n FROM node_runs WHERE node_id='b'").get()?.n).toBe(2)
 })
 it('cancellation blocks authorizing and direct lease acquisition',()=>{
  const db=setup();const req=request(db)
  withTx(db,tx=>{tx.run("UPDATE runs SET cancel_requested_at=? WHERE run_id='r'",[now]);tx.run("UPDATE node_runs SET status='queued' WHERE node_run_id='unrelated'")})
  expect(()=>withTx(db,tx=>authorizeReworkRuntime(tx,secret,req,now))).toThrow()
  expect(()=>withTx(db,tx=>acquireLease(tx,secret,{nodeRunId:'unrelated',ownerEpoch:0,leaseTtlMs:1000,now}))).toThrow()
 })
 it('keeps immutable actual snapshots across replay and protects legacy unknown consumers',()=>{
  const db=setup()
  withTx(db,tx=>{tx.run("UPDATE node_runs SET status='queued' WHERE node_run_id='b'");snapshotArtifactInputs(tx,'b',[],now);tx.run("UPDATE node_runs SET status='done' WHERE node_run_id='b'")})
  const req=request(db)
  withTx(db,tx=>authorizeReworkRuntime(tx,secret,req,now))
  expect(db.raw.prepare("SELECT count(*) n FROM rework_impacts WHERE node_run_id='b'").get()?.n).toBe(0)
  expect(db.raw.prepare("SELECT count(*) n FROM rework_impacts WHERE node_run_id='c'").get()?.n).toBe(1)
 })
 it('recovers on a second connection without duplicating an authorized successor',()=>{
  const db=setup();const req=request(db)
  const fresh=withTx(db,tx=>authorizeReworkRuntime(tx,secret,req,now))
  const reopened=openDb(db.file)
  try {
   expect(()=>withTx(reopened,tx=>authorizeReworkRuntime(tx,secret,req,now))).toThrow()
   expect(reopened.raw.prepare("SELECT replacement_node_run_id FROM node_runs WHERE node_run_id='a'").get()?.replacement_node_run_id).toBe(fresh)
   expect(reopened.raw.prepare("SELECT count(*) n FROM node_runs WHERE node_id='a'").get()?.n).toBe(2)
  } finally {reopened.raw.close()}
 })
 it('creates a new reviewer per revision round without reusing the invalidated session',()=>{
  const db=setup();const req=request(db,'b')
  const a2=withTx(db,tx=>authorizeReworkRuntime(tx,secret,req,now))
  withTx(db,tx=>{tx.run("UPDATE node_runs SET status='done' WHERE node_run_id=?",[a2]);artifact(tx,a2,'a-v2');tx.run("UPDATE rework_requests SET status='awaiting_review',new_node_run_id=? WHERE request_id='q'",[a2])})
  const b2=withTx(db,tx=>prepareReworkReviewer(tx,secret,{...req,new_node_run_id:a2},now))!
  withTx(db,tx=>{snapshotArtifactInputs(tx,b2,[a2],now);acquireLease(tx,secret,{nodeRunId:b2,ownerEpoch:0,leaseTtlMs:10000,now});tx.run("UPDATE node_runs SET status='started' WHERE node_run_id=?",[b2]);tx.run("UPDATE rework_requests SET target_node_run_id=?,status='authorized',new_node_run_id=NULL,round_no=2 WHERE request_id='q'",[a2])})
  const nextReq={...req,target_node_run_id:a2}
  const a3=withTx(db,tx=>authorizeReworkRuntime(tx,secret,nextReq,now))
  withTx(db,tx=>{tx.run("UPDATE node_runs SET status='done' WHERE node_run_id=?",[a3]);artifact(tx,a3,'a-v3');tx.run("UPDATE rework_requests SET status='awaiting_review',new_node_run_id=? WHERE request_id='q'",[a3])})
  const b3=withTx(db,tx=>prepareReworkReviewer(tx,secret,{...nextReq,new_node_run_id:a3},now))!
  expect(b3).not.toBe(b2)
  expect(db.raw.prepare('SELECT status FROM node_runs WHERE node_run_id=?').get(b2)?.status).toBe('superseded')
  expect(withTx(db,tx=>snapshotArtifactInputs(tx,b3,[a3],now)).map(x=>x.artifact_id)).toEqual(['a-v3'])
  expect(withTx(db,tx=>prepareReworkReviewer(tx,secret,{...nextReq,new_node_run_id:a3},now))).toBe(b3)
  expect(()=>withTx(db,tx=>tx.run('UPDATE artifact_consumptions SET artifact_hash=? WHERE consumer_node_run_id=?',['mutated',b3]))).toThrow(/immutable/)
  expect(()=>withTx(db,tx=>tx.run('DELETE FROM input_snapshots WHERE consumer_node_run_id=?',[b3]))).toThrow(/immutable/)
 })

 it('holds known and legacy consumers before authorization, including direct lease calls',()=>{
  const db=setup()
  withTx(db,tx=>{tx.run("UPDATE node_runs SET status='queued' WHERE node_run_id='b'");snapshotArtifactInputs(tx,'b',['a'],now);tx.run("UPDATE node_runs SET status='started' WHERE node_run_id='b'");tx.run("UPDATE node_runs SET status='queued' WHERE node_run_id='c'")})
  request(db)
  for(const status of ['proposed','escalated']) {
   withTx(db,tx=>tx.run("UPDATE rework_requests SET status=? WHERE request_id='q'",[status]))
   expect(()=>withTx(db,tx=>assertReworkExecutionAllowed(tx,'b',true))).toThrow()
   expect(()=>withTx(db,tx=>acquireLease(tx,secret,{nodeRunId:'c',ownerEpoch:0,leaseTtlMs:1000,now}))).toThrow()
  }
 })
 it('refuses unbounded legacy topology and preserves multi-artifact sources',()=>{
  const db=setup();const req=request(db)
  withTx(db,tx=>tx.run("UPDATE runs SET workflow_version='missing' WHERE run_id='r'"))
  expect(()=>withTx(db,tx=>authorizeReworkRuntime(tx,secret,req,now))).toThrow(/persisted topology/)
  expect(db.raw.prepare("SELECT count(*) n FROM node_runs WHERE node_id='a'").get()?.n).toBe(1)
  const second=setup(); const secondReq=request(second)
  withTx(second,tx=>artifact(tx,'a','sibling-v1'))
  expect(()=>withTx(second,tx=>authorizeReworkRuntime(tx,secret,secondReq,now))).toThrow(/preservation/)
  expect(second.raw.prepare('SELECT count(*) n FROM artifact_contents WHERE node_run_id=?').get('a')?.n).toBe(2)
 })
 it('never releases authorized collateral merely because the request is declined',()=>{
  const db=setup();const req=request(db)
  withTx(db,tx=>{tx.run("UPDATE node_runs SET status='queued' WHERE node_run_id='b'");authorizeReworkRuntime(tx,secret,req,now);tx.run("UPDATE rework_requests SET status='declined' WHERE request_id='q'")})
  expect(()=>withTx(db,tx=>acquireLease(tx,secret,{nodeRunId:'b',ownerEpoch:0,leaseTtlMs:1000,now}))).toThrow()
  expect(db.raw.prepare("SELECT count(*) n FROM rework_impacts WHERE released_at IS NULL").get()?.n).toBe(3)
 })

 it('enforces approved extra dependencies in dispatch, direct lease, immutable snapshots and impact analysis',async()=>{
  const db=setup();const req=request(db)
  const catalog=new WorkflowCatalog('S2')
  const base=[{from:'a',to:'b'},{from:'a',to:'c'},{from:'b',to:'d'},{from:'c',to:'d'}]
  catalog.load({workflow_id:'w',workflow_version:'1',nodes:['a','b','c','d','unrelated'].map(node_id=>({node_id,type:'agent' as const})),edges:base})
  withTx(db,tx=>{
   tx.run("UPDATE runs SET workflow_definition_hash=? WHERE run_id='r'",[definitionHashOf(catalog.get('w','1'))])
   tx.run("UPDATE rework_requests SET status='closed' WHERE request_id='q'")
   tx.run("UPDATE node_runs SET status='queued' WHERE node_run_id IN ('d','unrelated')")
   tx.run("INSERT INTO rework_local_plans(request_id,revision,plan_hash,proposal_json,snapshot_json,created_at) VALUES('q',1,'approved-plan','{}','{}',?)",[now])
  })
  const add=(run='r')=>withTx(db,tx=>tx.run("INSERT INTO rework_plan_edges VALUES('q','approved-plan',?,'unrelated','d')",[run]))
  expect(()=>add()).toThrow(/matching approved/)
  withTx(db,tx=>tx.run("UPDATE rework_local_plans SET approved_by='owner' WHERE plan_hash='approved-plan'"))
  expect(()=>add('different-run')).toThrow(/matching approved/)
  add()
  expect(withTx(db,tx=>runtimeEdges(tx,'r',base))).toEqual([...base,{from:'unrelated',to:'d'}])
  expect(withTx(db,tx=>runtimeEdges(tx,'different-run',base))).toEqual(base)
  expect(()=>withTx(db,tx=>acquireLease(tx,secret,{nodeRunId:'d',ownerEpoch:0,leaseTtlMs:1000,now}))).toThrow(/dependency/)
  expect(()=>withTx(db,tx=>snapshotArtifactInputs(tx,'d',['b','c'],now))).toThrow(/dependency/)
  const dispatched:string[]=[]
  const deps: DispatchDeps={db,secret,catalog,runtime:{db,secret,catalog,phase:'S2',clock:new SystemClock('rework-test')},executeNode:async(p:{nodeRunId:string})=>{dispatched.push(p.nodeRunId);return {node_run_id:p.nodeRunId,final_status:'done',agent_id:'agent',evidence:null}}}
  const params={runId:'r',nodes:{d:{tools:[]}},now}
  await dispatchRun(deps,params)
  expect(dispatched).toEqual([])
  withTx(db,tx=>{tx.run("UPDATE node_runs SET status='done' WHERE node_run_id='unrelated'");artifact(tx,'unrelated','extra-input')})
  const bound=withTx(db,tx=>snapshotArtifactInputs(tx,'d',['b','c'],now))
  expect(bound.map(i=>i.artifact_id).sort()).toEqual(['b-v1','c-v1','extra-input'])
  await dispatchRun(deps,params)
  expect(dispatched).toEqual(['d'])
  expect(withTx(db,tx=>previewReworkImpact(tx,{...req,target_node_run_id:'unrelated'})).map(n=>n.node_run_id)).toEqual(['d'])
  expect(()=>withTx(db,tx=>tx.run("DELETE FROM rework_plan_edges WHERE run_id='r'"))).toThrow(/immutable/)
 })

})
