import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra, type TaskPlanProposal } from '../../src/index.ts'
import { createApiClient } from '../../src/client/api/client.ts'
import { createTaskCommands } from '../../src/client/api/task-commands.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { BridgeClient, type SpawnParams } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { loadNodeRun } from '../../src/service/commands/lease.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { callDshRework } from '../../src/service/dsh-rework.ts'
import { fakeAgentBridge } from '../fixtures/agent-bridge.ts'

it('material authorization flows through HTTP, immutable plan confirmation and the actual execution binding', async () => {
  const directory=mkdtempSync(join(tmpdir(),'orchestra-material-contract-'))
  const secret='material-contract-secret'
  const registry=new ToolRegistry()
  const agents=new Map<string,ReturnType<typeof fakeAgentBridge>>()
  const calls:string[]=[]
  let service:Awaited<ReturnType<typeof serveOrchestra>>
  let selected:{id:string;digest:string}
  const ready=Promise.withResolvers<void>()
  const proceed=Promise.withResolvers<void>()
  const bridge=new BridgeClient({
    async request<T>(method:string,params:unknown):Promise<T>{
      if(method==='executor.spawn'){
        const input=params as SpawnParams
        const agentId='agent_'+input.nodeRunId
        const node=service.orchestra.db.raw.prepare('SELECT node_id FROM node_runs WHERE node_run_id=?').get(input.nodeRunId)!
        const materialInput=(input.input as {materials:unknown[]}).materials
        if(node.node_id==='read') expect(materialInput).toHaveLength(1)
        else expect(materialInput).toEqual([])
        agents.set(agentId,fakeAgentBridge({agentId,steps:[],report:{status:'done',output:{summary:'已核对'}},at:new Date().toISOString()}))
        return agents.get(agentId)!.request<T>(method,params)
      }
      const {executorAgentId} = params as {executorAgentId:string}
      if(method==='executor.send'){
        const id=executorAgentId.slice('agent_'.length)
        const node=withTx(service.orchestra.db,tx=>loadNodeRun(tx,id))
        const binding={node_run_id:id,attempt:node.attempt,action_generation:node.action_generation}
        const read=()=>callDshRework(service.orchestra.db,service.rework!,binding,
          {action:'read_material',material_id:selected.id,digest:selected.digest})
        if(node.node_id==='read'){
          expect(read()).toMatchObject({name:'收入.csv',text:'月份,收入\n一月,100'})
          expect(()=>callDshRework(service.orchestra.db,service.rework!,{...binding,attempt:binding.attempt+1},
            {action:'read_material',material_id:selected.id,digest:selected.digest})).toThrow()
          ready.resolve()
          await proceed.promise
          expect(read).toThrow(/有效的材料授权/u)
          calls.push('read')
        } else {
          expect(read).toThrow(/没有该材料的授权/u)
          calls.push('other')
        }
        callDshRework(service.orchestra.db,service.rework!,binding,{action:'publish',operation_id:uuidv7(),
          file_name:node.node_id+'.md',text:'这份成果已经生成'},undefined,secret)
      }
      return agents.get(executorAgentId)!.request<T>(method,params)
    },
    async *listen(params,signal){for await(const event of agents.get(params.executorAgentId)!.listen(params,signal))yield{...event,attempt:params.attempt}},
  })
  const plan:TaskPlanProposal={title:'核对收入',workflow_id:'income',workflow_version:'1',steps:[
    {node_id:'read',description:'读取已授权收入表',goal_ids:['goal'],depends_on:[],tools:[],complexity:'routine',model_reason:'按表核对'},
    {node_id:'other',description:'生成补充说明',goal_ids:['goal'],depends_on:['read'],tools:[],complexity:'routine',model_reason:'补充说明'},
  ],deliverables:['read','other'].map(node_id=>({title:node_id+'报告',node_id,goal_ids:['goal'],
    acceptance:{kind:'artifact' as const,file_name:node_id+'.md',minimum_bytes:1}})),risks:[]}
  service=await serveOrchestra({dbFile:join(directory,'db.sqlite'),secret,phase:'S6',
    resolveHttpHuman:req=>req.headers['x-fixture-user']==='owner'?{id:'owner'}:{id:'other'},
    planning:{propose:async()=>plan},executor:{registry,bridge,runner:new ReadOnlyToolRunner(registry,
      {readonlyAvailable:()=>true,run:async()=>{throw new Error('no tool execution')}},directory)},
    asOfSeq:()=>0,listTasks:()=>[],listEvents:()=>[],appendLedgerEvent:()=>({seq:0,event_id:'unused'})})
  const apiFor=(actor:string)=>createApiClient(service.endpoint,(url,init)=>fetch(url,{...init,
    headers:{...Object.fromEntries(new Headers(init?.headers)),'x-orchestra-secret':secret,'x-fixture-user':actor}}))
  try {
    const now=new Date().toISOString()
    const commands=service.orchestra.commands
    const definition={name:'收入复核',nodes:[{node_id:'trigger',type:'trigger',title:'开始',position:{x:0,y:0}},
      {node_id:'read',type:'agent',config:{side_effect_policy:'pure'},title:'核对',position:{x:100,y:0}},
      {node_id:'other',type:'agent',config:{side_effect_policy:'pure'},title:'说明',position:{x:200,y:0}}],edges:[{from:'trigger',to:'read'},{from:'read',to:'other'}]}
    commands.createWorkflow({workflowId:'income',name:definition.name,definition,actor:'host',now,operationId:uuidv7()})
    expect(commands.testWorkflowDraft({workflowId:'income',revision:1,now}).passed).toBe(true)
    commands.publishWorkflow({workflowId:'income',revision:1,baseVersion:0,note:'test',actor:'host',now,operationId:uuidv7()})
    const api=apiFor('owner'),reader=createResourcesApi(api),writer=createTaskCommands(api)
    const original=await writer.proposeTaskPlan('核对收入',[])
    const op=uuidv7()
    const grant=()=>writer.grantPlanMaterials(original.plan_id,original.content_hash,['read'],[{name:'收入.csv',body:'月份,收入\n一月,100'}],op)
    await expect(createTaskCommands(apiFor('other')).grantPlanMaterials(original.plan_id,original.content_hash,['read'],[{name:'收入.csv',body:'秘密'}],uuidv7())).rejects.toMatchObject({code:'NOT_FOUND'})
    const revised=await grant()
    expect(revised.plan_id).not.toBe(original.plan_id)
    expect(revised.content_hash).not.toBe(original.content_hash)
    expect(JSON.stringify(revised)).not.toContain('一月,100')
    expect((await grant()).plan_id).toBe(revised.plan_id)
    await expect(writer.confirmTaskPlan(original.plan_id,original.content_hash)).rejects.toMatchObject({code:'CONFIRMATION_MISMATCH'})
    expect((await reader.listPlanDrafts()).data.items.map(item=>item.plan_id)).toEqual([revised.plan_id])
    selected=revised.brief.materials![0]!
    const launch=await writer.confirmTaskPlan(revised.plan_id,revised.content_hash)
    expect((await writer.confirmTaskPlan(revised.plan_id,revised.content_hash)).run_id).toBe(launch.run_id)
    await ready.promise
    await reader.revokePlanMaterial(revised.plan_id,revised.content_hash,selected.id)
    expect((await reader.getTaskPlan(revised.plan_id)).data.material_states).toMatchObject([{ id: selected.id, state: 'revoked' }])
    proceed.resolve()
    await expect.poll(()=>calls,{timeout:6000}).toEqual(['read','other'])
    expect(service.orchestra.db.raw.prepare('SELECT body FROM plan_materials WHERE id=?').get(selected.id)?.body).toBe('')
  } finally {proceed.resolve();await service.close();await rm(directory,{recursive:true,force:true})}
}, 15_000)
