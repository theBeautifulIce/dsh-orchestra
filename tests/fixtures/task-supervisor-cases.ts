import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { appendEvent, appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { openDb, onLedgerCommit, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { createRunCoordination, type CoordinationBinding, type CoordinationItem } from '../../src/service/run-coordination.ts'
import { createTaskSupervisor } from '../../src/service/task-supervisor.ts'
import { createChatReportPump } from '../../src/service/chat-report-pump.ts'
import { coordinationMessages } from '../../src/executor/coordination-message.ts'
import { uuidv7 } from '../../src/core/ids.ts'
const SECRET='fixture-secret', OWNER='human:owner'
const initial=Date.parse('2026-11-25T10:00:00.000Z')
function setup() {
  const db=openDb(':memory:')
  try { applySteps(db,loadSteps(defaultMigrationsDir())) } catch(e){db.raw.close();throw e}
  let now=initial
  const coordinator=createRunCoordination(db,SECRET,(_tx,actor,run)=>{if(actor!==OWNER||run!=='run1')throw Error('not owner')},()=>now)
  function seedRun(run:string, nodes:string[]) {
    const stamp=new Date(initial).toISOString()
    withTx(db,tx=>{
      tx.run('INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?)',[run+'t',run,'running',stamp,stamp])
      tx.run('INSERT INTO runs(run_id,task_id,status,created_at,updated_at) VALUES (?,?,?,?,?)',[run,run+'t','running',stamp,stamp])
      for (const [seq,id] of nodes.entries()) {
        tx.run(`INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,attempt,action_generation,side_effect_policy,owner_epoch,executor_session_id,lease_expires_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,run,id,seq+1,'agent','started',1,1,'pure',db.epoch,id+':session',new Date(initial+600_000).toISOString(),stamp,stamp])
        appendNodeRunEvent(tx,SECRET,id,'executor.model_confirmed',{state:'confirmed',attempt:1,action_generation:1})
      }
    })
  }
  seedRun('run1',['a','b','c']);seedRun('run2',['other'])
  const binding=(node_run_id:string):CoordinationBinding=>({node_run_id,attempt:1,action_generation:1,executor_session_id:node_run_id+':session'})
  const call=(from:string,input:unknown)=>coordinator.call(binding(from),input)
  const send=(from:string,to:string,body='核对事实',kind='request')=>call(from,{action:'send',kind,body,target_node_run_id:to}) as CoordinationItem
  const report=(from:string,body='需要确认范围')=>call(from,{action:'send',kind:'blocker',body}) as CoordinationItem
  const reply=(from:string,row:CoordinationItem,body='已核对')=>call(from,{action:'reply',id:row.id,revision:row.revision,body}) as CoordinationItem
  const inbox=(from:string)=>call(from,{action:'inbox'}) as {peers:{node_run_id:string}[];items:CoordinationItem[]}
  const list=()=>coordinator.listHuman('run1',OWNER).items
  return {db,coordinator,binding,call,send,reply,report,inbox,list,time:(ms:number)=>{now=initial+ms},close:()=>db.raw.close()}
}
function scenario(fn:(f:ReturnType<typeof setup>)=>void|Promise<void>) { return async()=>{const f=setup();try{await fn(f)}finally{f.close()}} }
function code(expected:string){return (error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code===expected}
function n(db:Db,table:string){return Number(db.raw.prepare('SELECT count(*) n FROM '+table).get()?.n)}

function finishSender(db: Db, signed = true) {
  const finished = new Date(initial + 1_000).toISOString()
  withTx(db, tx => {
    tx.run("UPDATE node_runs SET status='done',lease_expires_at=NULL,updated_at=? WHERE node_run_id='a'", [finished])
    if (!signed) return
    const reportId = uuidv7()
    tx.run(`INSERT INTO report_registry (report_id,node_run_id,attempt,report_seq,state,created_at,updated_at)
      VALUES (?,'a',1,1,'applied',?,?)`, [reportId, finished, finished])
    appendNodeRunEvent(tx, SECRET, 'a', 'report_applied', {
      report_id: reportId, report_seq: 1, next_status: 'done', attempt: 1, action_generation: 1, evidence_digest: null,
    })
  })
}

export const supervisorCases: [string,()=>void|Promise<void>][] = [
 ['migration preserves history and appends only 080',scenario(({db})=>{assert.equal(n(db,'schema_migrations'),80);assert.deepEqual(applySteps(db,loadSteps(defaultMigrationsDir())),[])})],
 ['same-run request, nonblocking reply, duplicate retries and reference-only result',scenario(f=>{
   assert.deepEqual(f.inbox('a').peers.map(p=>p.node_run_id),['b','c']);const r=f.send('a','b');assert.equal(r.state,'pending');assert.equal(f.send('a','b').id,r.id);assert.equal(f.coordinator.updates(f.binding('b'))[0]?.id,r.id);assert.equal(f.coordinator.updates(f.binding('c')).length,0)
   const a=f.reply('b',r);assert.equal(a.state,'answered');assert.equal(a.evidence_strength,'none');assert.deepEqual(f.reply('b',r),a)
   assert.equal(f.coordinator.updates(f.binding('a'))[0]?.reply,'已核对');assert.equal(f.coordinator.updates(f.binding('b')).length,0)
   assert.equal(n(f.db,'run_coordination'),1);assert.equal(f.db.raw.prepare("SELECT status FROM runs WHERE run_id='run1'").get()?.status,'running');assert.equal(f.db.raw.prepare("SELECT status FROM node_runs WHERE node_run_id='a'").get()?.status,'started')
 })],
 ['cross-run, self, third-party and forged executor identity denied',scenario(f=>{
   assert.throws(()=>f.send('a','other'),code('FORBIDDEN'));assert.throws(()=>f.send('a','a'),code('FORBIDDEN'));const r=f.send('a','b');assert.throws(()=>f.reply('c',r),code('FORBIDDEN'))
   assert.throws(()=>f.coordinator.call({...f.binding('a'),executor_session_id:'forged'},{action:'inbox'}),code('FORBIDDEN'))
   assert.throws(()=>f.coordinator.listHuman('run1','human:intruder'));assert.throws(()=>f.coordinator.acknowledge('run1','human:intruder',{id:r.id,revision:r.revision}));assert.throws(()=>f.coordinator.listHuman('run2',OWNER))
 })],
 ['signed attempt still needs a corroborated pure policy; non-pure nodes cannot send or receive coordination',scenario(f=>{
   for(const policy of ['compensable','irreversible']) {
     f.db.raw.prepare("UPDATE node_runs SET side_effect_policy=? WHERE node_run_id='b'").run(policy)
     assert.throws(()=>f.call('b',{action:'inbox'}),code('FORBIDDEN'));assert.throws(()=>f.report('b'),code('FORBIDDEN'));assert.throws(()=>f.send('a','b'),code('FORBIDDEN'))
     assert.ok(!f.inbox('a').peers.some(p=>p.node_run_id==='b'));assert.equal(n(f.db,'run_coordination'),0)
   }
   f.db.raw.prepare("UPDATE node_runs SET side_effect_policy='pure' WHERE node_run_id='b'").run();assert.equal(f.send('a','b').state,'pending')
 })],
 ['scope restrictions block peer forwarding but preserve owner reports',scenario(f=>{
   const r=f.send('a','b');f.db.raw.prepare("INSERT INTO plan_materials(id,scope,actor,draft,name,digest,body,expires_ms,run_id) VALUES('m','node',?,'d','private','digest','private',?,'run1')").run(OWNER,initial+600000)
   assert.deepEqual(f.inbox('a').peers,[]);assert.equal(f.coordinator.updates(f.binding('b')).length,0);assert.throws(()=>f.send('a','c'),code('FORBIDDEN'));assert.throws(()=>f.reply('b',r),code('FORBIDDEN'));assert.equal(f.report('a').state,'reported');assert.equal(f.coordinator.sweep(),1);assert.equal(f.list().find(x=>x.id===r.id)?.state,'unavailable')
 })],
 ['cycle is rejected; closing an edge allows new communication',scenario(f=>{
   const ab=f.send('a','b'),bc=f.send('b','c');assert.throws(()=>f.send('c','a'),code('RESOLUTION_NOT_AVAILABLE'));f.reply('b',ab);assert.equal(f.send('c','a').state,'pending');assert.throws(()=>f.send('c','b'),code('RESOLUTION_NOT_AVAILABLE'));assert.equal(f.reply('c',bc).state,'answered')
 })],
 ['expiry, operator awareness and exact acknowledgement replay',scenario(f=>{
   const r=f.send('a','b');f.time(120001);assert.equal(f.list()[0]?.state,'expired');assert.equal(f.coordinator.updates(f.binding('b')).length,0)
   assert.equal(f.coordinator.sweep(),1);assert.equal(f.coordinator.sweep(),0);const expired=f.list()[0]!;assert.equal(expired.id,r.id)
   assert.equal(f.coordinator.attention('run1',OWNER).length,1);const ack=f.coordinator.acknowledge('run1',OWNER,{id:r.id,revision:expired.revision});assert.equal(ack.state,'acknowledged');assert.deepEqual(f.coordinator.acknowledge('run1',OWNER,{id:r.id,revision:expired.revision}),ack);assert.deepEqual(f.coordinator.attention('run1',OWNER),[])
 })],
 ['acknowledgement before sweep still idempotent',scenario(f=>{
   const r=f.send('a','b');f.time(120001);const ack=f.coordinator.acknowledge('run1',OWNER,{id:r.id,revision:r.revision});assert.equal(ack.state,'acknowledged');assert.deepEqual(f.coordinator.acknowledge('run1',OWNER,{id:r.id,revision:r.revision}),ack)
 })],
 ['recipient termination or replacement settles request without redispatch',scenario(f=>{
   const r=f.send('a','b');f.db.raw.prepare("UPDATE node_runs SET status='done' WHERE node_run_id='b'").run();assert.equal(f.coordinator.sweep(),1);assert.equal(f.list()[0]?.state,'unavailable');assert.equal(f.coordinator.updates(f.binding('a'))[0]?.id,r.id);assert.throws(()=>f.reply('b',r),code('FORBIDDEN'))
 })],
 ['the active recipient can answer once after a signed sender completion without reopening the sender', scenario(f => {
   const request = f.send('a', 'b')
   finishSender(f.db)
   f.time(5_000)
   const nodeStates = () => f.db.raw.prepare("SELECT node_run_id,status,attempt,action_generation FROM node_runs WHERE run_id='run1' ORDER BY seq").all()
   const before = nodeStates()
   assert.equal(f.coordinator.sweep(), 0)
   assert.deepEqual(f.inbox('b').peers.map(peer => peer.node_run_id), ['c'])
   assert.equal(f.inbox('b').items[0]?.id, request.id)
   assert.throws(() => f.inbox('a'), code('FORBIDDEN'))
   assert.throws(() => f.send('c', 'a'), code('FORBIDDEN'))
   const answered = f.reply('b', request)
   assert.equal(answered.state, 'answered')
   assert.equal(answered.revision, request.revision + 1)
   assert.equal(answered.evidence_strength, 'none')
   assert.deepEqual(f.reply('b', request), answered)
   assert.throws(() => f.reply('b', request, '另一份答复'), code('OPERATION_ID_CONFLICT'))
   assert.equal(f.list().find(item => item.id === request.id)?.reply, '已核对')
   assert.deepEqual(nodeStates(), before)
 })],
 ['terminal-sender allowance preserves expiry, withdrawal, cancellation and fenced attempts', scenario(f => {
   const expires = f.call('a', { action: 'send', kind: 'request', target_node_run_id: 'b', ttl_seconds: 30,
     body: '到期的核对' }) as CoordinationItem
   const withdrawn = f.send('a', 'b', '先撤回')
   f.call('a', { action: 'withdraw', id: withdrawn.id, revision: withdrawn.revision })
   const cancelled = f.send('a', 'b', '取消的核对')
   finishSender(f.db)
   f.time(30_001)
   assert.equal(f.reply('b', expires).state, 'expired')
   assert.throws(() => f.reply('b', withdrawn), code('OPERATION_ID_CONFLICT'))
   f.db.raw.prepare("UPDATE runs SET cancel_requested_at=? WHERE run_id='run1'").run(new Date(initial + 30_001).toISOString())
   assert.throws(() => f.reply('b', cancelled), code('FORBIDDEN'))
   assert.equal(f.list().find(item => item.id === cancelled.id)?.state, 'unavailable')
 })],
 ...(['unsigned', 'changed generation', 'replaced', 'fenced'] as const).map<[string, () => void | Promise<void>]>(condition => [
   'terminal-sender allowance cannot use a ' + condition + ' attempt',
   scenario(f => {
     const request = f.send('a', 'b')
     finishSender(f.db, condition !== 'unsigned')
     if (condition === 'changed generation') f.db.raw.prepare("UPDATE node_runs SET action_generation=2 WHERE node_run_id='a'").run()
     if (condition === 'replaced') f.db.raw.prepare("UPDATE node_runs SET replacement_node_run_id='c' WHERE node_run_id='a'").run()
     if (condition === 'fenced') f.db.raw.prepare("UPDATE node_runs SET fence_state='armed' WHERE node_run_id='a'").run()
     f.time(5_000)
     assert.equal(f.inbox('b').items.length, 0)
     assert.equal(f.reply('b', request).state, 'unavailable')
     assert.equal(f.list()[0]?.reply, null)
   }),
 ]),
 ['stale generation, expired lease, cancel and fence reject tool calls',scenario(f=>{
   const r=f.send('a','b');f.db.raw.prepare("UPDATE node_runs SET action_generation=2 WHERE node_run_id='b'").run();assert.throws(()=>f.reply('b',r),code('FORBIDDEN'));assert.equal(f.coordinator.sweep(),1)
   f.db.raw.prepare("UPDATE node_runs SET fence_state='armed' WHERE node_run_id='a'").run();assert.throws(()=>f.report('a'),code('FORBIDDEN'))
   f.db.raw.prepare("UPDATE runs SET cancel_requested_at=? WHERE run_id='run1'").run(new Date(initial).toISOString());assert.throws(()=>f.report('c'),code('FORBIDDEN'));f.time(600001);assert.throws(()=>f.call('other',{action:'inbox'}),code('FORBIDDEN'))
 })],
 ['answered reply remains available after target exits; no new attempt inherits message',scenario(f=>{
   const r=f.send('a','b');f.reply('b',r);f.db.raw.prepare("UPDATE node_runs SET status='done',executor_session_id=NULL WHERE node_run_id='b'").run();assert.equal(f.coordinator.updates(f.binding('a'))[0]?.reply,'已核对');f.db.raw.prepare("UPDATE node_runs SET action_generation=2 WHERE node_run_id='a'").run();assert.throws(()=>f.coordinator.updates(f.binding('a')),code('FORBIDDEN'))
 })],
 ['message bodies stay out of general events; tampering and replay of old rows fail closed',scenario(f=>{
   const r=f.send('a','b','private-canary');const old=f.db.raw.prepare('SELECT * FROM run_coordination WHERE id=?').get(r.id)!;assert.equal(f.db.raw.prepare("SELECT 1 FROM events WHERE payload_redacted LIKE '%private-canary%'").get(),undefined)
   f.reply('b',r);f.db.raw.prepare('UPDATE run_coordination SET state=?,reply=?,reason=?,revision=?,updated_ms=?,mac=? WHERE id=?').run(old.state!,old.reply!,old.reason!,old.revision!,old.updated_ms!,old.mac!,r.id);assert.equal(f.list().length,0);assert.throws(()=>f.reply('b',r),code('FORBIDDEN'))
   const report=f.report('c','sensitive');f.db.raw.prepare('UPDATE run_coordination SET body=? WHERE id=?').run('tampered',report.id);assert.equal(f.coordinator.attention('run1',OWNER).length,0)
 })],
 ['bounded input, source quota, withdrawal and no untrusted fields',scenario(f=>{
   assert.throws(()=>f.report('a','😀'.repeat(501)),code('PAYLOAD_SCHEMA_INVALID'));assert.throws(()=>f.call('a',{action:'send',kind:'finding',body:'x',run_id:'run2'}),code('PAYLOAD_SCHEMA_INVALID'));const r=f.send('a','b');assert.equal((f.call('a',{action:'withdraw',id:r.id,revision:r.revision}) as CoordinationItem).state,'withdrawn');assert.throws(()=>f.reply('b',r),code('OPERATION_ID_CONFLICT'))
   for(let i=0;i<11;i++)f.report('a','issue '+i);assert.throws(()=>f.report('a','overflow'),code('RANGE_TOO_LARGE'));assert.equal(f.report('a','issue 1').state,'reported')
 })],
 ['rollback emits no wake; successful commit emits one hint; callbacks cannot undo commits',scenario(f=>{
   let calls=0;const off=onLedgerCommit(f.db,()=>{calls++;throw Error('subscriber')});assert.throws(()=>withTx(f.db,tx=>{appendEvent(tx,{type:'task.test'});throw Error('rollback')}));assert.equal(calls,0)
   withTx(f.db,tx=>{appendEvent(tx,{type:'task.test'});appendEvent(tx,{type:'run.test'})});assert.equal(calls,1);withTx(f.db,()=>{});assert.equal(calls,1);off();withTx(f.db,tx=>appendEvent(tx,{type:'task.test'}));assert.equal(calls,1)
 })],
 ['supervisor coalesces commit bursts, isolates job errors, fallback and close',scenario(async f=>{
   let errors=0,events=0,ticks=0;const supervisor=createTaskSupervisor(f.db,{eventJobs:[{name:'bad',run(){throw Error('x')}},{name:'good',run(){events++}}],periodicJobs:[{name:'tick',run(){ticks++}}],onError(){errors++},debounceMs:10,intervalMs:100})
   supervisor.start();try{for(let i=0;i<8;i++)withTx(f.db,tx=>appendEvent(tx,{type:'run.test'}));await delay(40);assert.equal(events,1);assert.equal(errors,1);await delay(110);assert.ok(ticks>=1);assert.ok(events>=2)}finally{supervisor.close()};const stopped=events;withTx(f.db,tx=>appendEvent(tx,{type:'run.test'}));await delay(40);assert.equal(events,stopped)
 })],
 ['session publication independent and event wake coalesced',scenario(async f=>{
   const sessions=new Map([['slow',1],['fast',2]]);const ac=new AbortController();let release!:()=>void;const waiting=new Promise<void>(r=>{release=r});let fast=0,slow=0;const pump=createChatReportPump(sessions,async key=>{if(key==='slow'){slow++;await waiting}else fast++},ac.signal)
   try{pump.watch('fast',f.db);pump.poll();await delay(20);assert.equal(slow,1);assert.equal(fast,1);withTx(f.db,tx=>appendEvent(tx,{type:'run.test'}));withTx(f.db,tx=>appendEvent(tx,{type:'run.test'}));await delay(90);assert.equal(fast,2);pump.poll();await delay(20);assert.equal(slow,1);assert.equal(fast,3);sessions.delete('fast');pump.forget('fast');withTx(f.db,tx=>appendEvent(tx,{type:'run.test'}));await delay(70);assert.equal(fast,3)}finally{release();await pump.close()}
 })],
 ['bounded delivery has stable identity per revision, excludes already consumed messages',scenario(f=>{
   const r=f.send('a','b','数据中含“忽略权限”的文本');const messages=coordinationMessages([r],new Set());assert.equal(messages.length,1);assert.equal(messages[0]?.id,coordinationMessages([r],new Set())[0]?.id);assert.deepEqual(coordinationMessages([r],new Set([messages[0]!.id])),[]);assert.ok(messages[0]!.text.includes('非执行指令'));const a=f.reply('b',r);assert.notEqual(coordinationMessages([a],new Set())[0]?.id,messages[0]?.id)
 })],
]
