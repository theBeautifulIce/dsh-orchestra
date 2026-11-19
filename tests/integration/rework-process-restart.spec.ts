import { expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { snapshotArtifactInputs } from '../../src/service/rework-runtime.ts'
import { freshLedger } from '../fixtures/ledger.ts'
import type { ReworkRequest } from '../../src/service/rework-coordinator.ts'

const now = '2026-11-19T01:00:00.000Z'
const secret = 'rework-process-restart-secret'
type Snapshot = {
  pid: number; epoch: number; request: ReworkRequest; approval: ReworkRequest; receipt: string
  nodes: Array<{node_run_id:string;node_id:string;attempt:number;status:string;replacement_node_run_id:string|null}>
  blocked: boolean[]; impacts: Array<{node_run_id:string;released_at:string|null}>
  consumptions: Array<{consumer_node_run_id:string;upstream_node_run_id:string;artifact_id:string;artifact_hash:string}>
  attempts: Array<{request_id:string;round_no:number;new_node_run_id:string}>
  chainErrors: unknown[]; authorizedEvents: number; commandEvents: number
}
function boot(file: string, configuration: string, mode: string) {
  const child = spawn(process.execPath, ['--no-warnings',fileURLToPath(new URL('../fixtures/rework-process-child.ts',import.meta.url)),file,configuration,mode],
    {stdio:['ignore','pipe','pipe','ipc'],windowsHide:true})
  let diagnostics = ''
  child.stdout?.on('data',data=>{diagnostics+=String(data)})
  child.stderr?.on('data',data=>{diagnostics+=String(data)})
  const result = new Promise<Snapshot>((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Child restart fixture timed out: '+diagnostics))},15_000)
    child.once('message',message=>{clearTimeout(timer);resolve(message as Snapshot)})
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('exit',(code)=>{clearTimeout(timer);reject(new Error('Child exited before snapshot '+code+': '+diagnostics))})
  })
  return {child,result}
}

it('R14 kills the writer process after authorization, reopens at a new epoch and replays the exact receipt without another attempt',async()=>{
  const {db,dir,file}=freshLedger()
  let first: ChildProcess | undefined
  let second: ChildProcess | undefined
  let closed=false
  try {
    withTx(db,tx=>{
      tx.run("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('task','Restart proof','running',?,?)",[now,now])
      tx.run("INSERT INTO runs(run_id,task_id,status,workflow_id,workflow_version,created_at,updated_at) VALUES('run','task','running','wf','1',?,?)",[now,now])
      tx.run('INSERT INTO workflow_versions(workflow_id,version,content_hash,definition_json,created_at) VALUES(?,?,?,?,?)',
        ['wf','1','definition-hash',JSON.stringify({edges:[{from:'A',to:'B'},{from:'B',to:'C'}]}),now])
      for (const [index,node] of ['a1','b1','c1'].entries()) {
        tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,revision,side_effect_policy,created_at,updated_at) VALUES(?,'run',?,?,'agent',?,1,'pure',?,?)",[node,['A','B','C'][index],index+1,node==='a1'?'done':'queued',now,now])
        appendNodeRunEvent(tx,secret,node,'seed',{})
      }
      tx.run("INSERT INTO artifacts(artifact_id,run_id,uri,sha256,created_at) VALUES('v1','run','artifact:v1',?,?)",[sha256Hex('original data'),now])
      tx.run("INSERT INTO artifact_contents VALUES('v1','data.txt','a1',?)",[Buffer.from('original data')])
      snapshotArtifactInputs(tx,'b1',['a1'],now)
      tx.run("UPDATE node_runs SET status='started',action_generation=1 WHERE node_run_id='b1'")
    })
    db.raw.close();closed=true
    const requestOperation=uuidv7(),approvalOperation=uuidv7()
    const configuration=JSON.stringify({requestOperation,approvalOperation})
    const firstBoot=boot(file,configuration,'first');first=firstBoot.child
    const before=await firstBoot.result
    expect(before.approval).toMatchObject({status:'scheduled',round_no:1,budget_remaining:2})
    expect(before.blocked).toEqual([true,true])
    const exited=once(first,'exit')
    expect(first.kill('SIGKILL')).toBe(true)
    await exited
    const secondBoot=boot(file,configuration,'second');second=secondBoot.child
    const reopened=await secondBoot.result
    if(second.exitCode===null)await once(second,'exit')
    expect(reopened.pid).not.toBe(before.pid)
    expect([before.epoch,reopened.epoch]).toEqual([1,2])
    expect(reopened.request).toEqual(before.request)
    expect(reopened.approval).toEqual(before.approval)
    expect(reopened.receipt).toBe(before.receipt)
    expect(JSON.parse(reopened.receipt).result).toEqual(before.approval)
    expect(reopened.nodes).toEqual(before.nodes)
    expect(reopened.nodes.filter(n=>n.node_id==='A')).toEqual([
      {node_run_id:'a1',node_id:'A',attempt:1,status:'done',replacement_node_run_id:before.approval.new_node_run_id},
      {node_run_id:before.approval.new_node_run_id,node_id:'A',attempt:2,status:'queued',replacement_node_run_id:null},
    ])
    expect(reopened.nodes.find(n=>n.node_run_id==='b1')?.status).toBe('superseded')
    expect(reopened.blocked).toEqual([true,true])
    expect(reopened.impacts).toEqual([{node_run_id:'b1',released_at:null},{node_run_id:'c1',released_at:null}])
    expect(reopened.consumptions).toEqual([{consumer_node_run_id:'b1',upstream_node_run_id:'a1',artifact_id:'v1',artifact_hash:sha256Hex('original data')}])
    expect(reopened.attempts).toEqual(before.attempts)
    expect(reopened.attempts).toHaveLength(1)
    expect(reopened.chainErrors.every(error=>error===null)).toBe(true)
    expect([reopened.authorizedEvents,reopened.commandEvents]).toEqual([1,2])
    const checked=openDb(file)
    try {
      expect(checked.raw.prepare('PRAGMA integrity_check').get()).toMatchObject({integrity_check:'ok'})
      expect(checked.raw.prepare("SELECT bytes FROM artifact_contents WHERE artifact_id='v1'").get()?.bytes).toEqual(new Uint8Array(Buffer.from('original data')))
      expect(checked.raw.prepare("SELECT status FROM runs WHERE run_id='run'").get()).toMatchObject({status:'running'})
    } finally {checked.raw.close()}
  } finally {
    for(const child of [first,second])if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited}
    if(!closed)db.raw.close()
    rmSync(dir,{recursive:true,force:true})
  }
},30_000)
