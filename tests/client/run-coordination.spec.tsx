// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { RunCoordination } from '../../src/client/panel/run-coordination.tsx'
import { renderPanel } from './harness.ts'

it('shows literal coordination text, uses the shared buttons, and scopes acknowledgement to the visible run',async()=>{
  const writes:{run:string|null;body:unknown}[]=[]
  const acknowledged=new Set<string>()
  const client=createApiClient('http://panel.test',async(input,init)=>{
    const url=new URL(String(input));expect(url.pathname).toBe('/v1/run-coordination')
    const run=url.searchParams.get('run_id')!
    if(init?.method==='POST'){writes.push({run,body:JSON.parse(String(init.body))});acknowledged.add(run)}
    const data={items:[{id:'row-'+run,kind:'blocker',state:acknowledged.has(run)?'acknowledged':'reported',revision:acknowledged.has(run)?2:1,
      source:'source',target:null,body:run+' <img src=x onerror=alert(1)>',reply:null,reason:null,created_ms:0,expires_ms:120000,evidence_strength:'none'}]}
    return {ok:true,status:200,json:async()=>({ok:true,schema_version:1,as_of_seq:1,data})} as Response
  })
  const panel=(runId:string,connected=true)=><PanelShell activeRoute="tasks" onNavigate={()=>undefined} serviceConnected={connected}><RunCoordination client={client} runId={runId} reloadVersion={0}/></PanelShell>
  const view=await renderPanel(panel('first'))
  const ack=()=>view.findAll('button').find(b=>b.textContent==='标记已知悉') as HTMLButtonElement|undefined
  try{
    await view.flush();expect(view.text()).toContain('first <img src=x onerror=alert(1)>');expect(view.findAll('img')).toHaveLength(0)
    expect(ack()?.classList.contains('ops-button')).toBe(true)
    await view.rerender(panel('first',false));expect(ack()?.disabled).toBe(true);expect(writes).toEqual([])
    await view.rerender(panel('second'));await view.flush();expect(view.text()).not.toContain('first <img');expect(view.text()).toContain('second <img')
    expect(ack()?.disabled).toBe(false);await view.click(ack()!);await view.flush()
    expect(writes).toEqual([{run:'second',body:{id:'row-second',revision:1}}]);expect(view.text()).toContain('操作人已知悉');expect(ack()).toBeUndefined()
  }finally{view.unmount()}
})
