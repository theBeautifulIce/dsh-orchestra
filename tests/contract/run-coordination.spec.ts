import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { ToolRegistry } from '../../src/executor/tools.ts'
import { startRun } from '../../src/service/commands/start-run.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import type { CoordinationItem } from '../../src/service/run-coordination.ts'

it('exposes authenticated operator coordination, idempotent awareness, and no mutation of execution state', async () => {
  const dir = mkdtempSync(join(tmpdir(),'orchestra-coordination-http-'))
  const secret = 'coordination-http-fixture', owner = 'human:fixture-owner', intruder = 'human:fixture-other'
  let service: Awaited<ReturnType<typeof serveOrchestra>> | undefined
  try {
    service = await serveOrchestra({dbFile:join(dir,'fixture.sqlite'),phase:'S6',secret,
      asOfSeq:()=>0,listEvents:()=>[],listTasks:()=>[],appendLedgerEvent:()=>{throw Error('unexpected raw append')},
      resolveHttpHuman:req=>req.headers.authorization==='Bearer fixture-owner'?{id:owner}:req.headers.authorization==='Bearer fixture-other'?{id:intruder}:null})
    const db=service.orchestra.db, now=new Date().toISOString()
    // The fixture permits no external tools. Supply the same registry-backed
    // capability check as production; a pure declaration alone is not authority.
    const registry=new ToolRegistry()
    const catalog=new WorkflowCatalog('S6',db,name=>registry.lookup(name)?.capability==='read_only',registry)
    const source={node_id:'source',type:'agent' as const,side_effect_policy:'pure' as const,tools:{allow:[],deny:[]}}
    expect(new WorkflowCatalog('S6',db).initialAgentEffect(source)).toBe('compensable')
    expect(catalog.initialAgentEffect(source)).toBe('pure')
    catalog.load({workflow_id:'coordination_fixture',workflow_version:'1',nodes:[source],edges:[]})
    const run=startRun(db,catalog,{workflowId:'coordination_fixture',workflowVersion:'1',taskTitle:'Coordination',startedBy:owner,operationId:uuidv7(),now})
    const node=db.raw.prepare('SELECT node_run_id,attempt,action_generation,side_effect_policy FROM node_runs WHERE run_id=?').get(run.run_id)!
    expect(node.side_effect_policy).toBe('pure')
    const binding={node_run_id:String(node.node_run_id),attempt:Number(node.attempt),action_generation:Number(node.action_generation),executor_session_id:'fixture:coordination'}
    withTx(db,tx=>{
      tx.run("UPDATE node_runs SET status='started',executor_session_id=?,lease_expires_at=?,owner_epoch=? WHERE node_run_id=?",[binding.executor_session_id,new Date(Date.now()+600000).toISOString(),db.epoch,binding.node_run_id])
      appendNodeRunEvent(tx,secret,binding.node_run_id,'executor.model_confirmed',{state:'confirmed',attempt:binding.attempt,action_generation:binding.action_generation})
    })
    const before=()=>db.raw.prepare('SELECT node_run_id,status,revision FROM node_runs WHERE run_id=?').all(run.run_id)
    const states=before()
    const row=service.coordination!.call(binding,{action:'send',kind:'blocker',body:'fixture private issue'}) as CoordinationItem
    const url=service.endpoint+'/v1/run-coordination?run_id='+encodeURIComponent(run.run_id)
    const headers={'x-orchestra-secret':secret,authorization:'Bearer fixture-owner','content-type':'application/json'}
    const data=async(response:Response)=>{expect(response.status).toBe(200);return (await response.json()).data}
    expect(await data(await fetch(url,{headers}))).toMatchObject({items:[{id:row.id,state:'reported',body:'fixture private issue',evidence_strength:'none'}]})
    for(const authorization of ['', 'Bearer fixture-other']) {
      expect((await fetch(url,{headers:{...headers,authorization}})).status).toBe(403)
      expect((await fetch(url,{method:'POST',headers:{...headers,authorization},body:JSON.stringify({id:row.id,revision:row.revision})})).status).toBe(403)
    }
    const ack=()=>fetch(url,{method:'POST',headers,body:JSON.stringify({id:row.id,revision:row.revision})}).then(data)
    const replies=await Promise.all([ack(),ack()])
    expect(replies[0]).toMatchObject({id:row.id,state:'acknowledged',evidence_strength:'none'})
    expect(replies[1]).toEqual(replies[0])
    expect(before()).toEqual(states)
    const events=db.raw.prepare("SELECT payload_redacted FROM events WHERE type='run.coordination'").all()
    expect(events).toHaveLength(2)
    expect(JSON.stringify(events)).not.toContain('fixture private issue')
  } finally { await service?.close();rmSync(dir,{recursive:true,force:true}) }
},30000)
