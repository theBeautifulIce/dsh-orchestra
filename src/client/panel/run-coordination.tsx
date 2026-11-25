import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../api/client.ts'
import type { CoordinationItem } from '../../service/run-coordination.ts'
import { PanelCommandButton, usePanelCommandsEnabled } from './shell.tsx'
import { COLOR, FONT_PX } from './tokens.ts'
const kinds = {request:'求助',finding:'发现',handoff:'交接',blocker:'问题上报'}
const states = {pending:'待回应',recorded:'已记录',reported:'待主脑关注',answered:'已回应',expired:'等待超时',unavailable:'对方不可用',withdrawn:'已撤回',acknowledged:'操作人已知悉'}
export function RunCoordination(props:{client:ApiClient;runId:string;reloadVersion:number}) {
  const [scope,setScope]=useState({client:props.client,runId:props.runId,epoch:0})
  if(scope.client!==props.client||scope.runId!==props.runId){setScope({client:props.client,runId:props.runId,epoch:scope.epoch+1});return null}
  return <CoordinationBody key={scope.epoch} {...props}/>
}
function CoordinationBody({client,runId,reloadVersion}:{client:ApiClient;runId:string;reloadVersion:number}) {
  const [items,setItems]=useState<CoordinationItem[]>()
  const [refresh,setRefresh]=useState(0)
  const [error,setError]=useState(false)
  const [writeError,setWriteError]=useState('')
  const [busy,setBusy]=useState<string>()
  const current=useRef(true), inFlight=useRef(false)
  const writable=usePanelCommandsEnabled()
  useEffect(()=>{current.current=true;return()=>{current.current=false}},[])
  useEffect(()=>{
    let active=true
    setError(false)
    void client.get<{items:CoordinationItem[]}>('/v1/run-coordination',{run_id:runId})
      .then(({data})=>{if(active)setItems(data.items)})
      .catch(()=>{if(active)setError(true)})
    return()=>{active=false}
  },[client,runId,reloadVersion,refresh])
  const pending=items?.filter(row=>['reported','expired','unavailable'].includes(row.state))??[]
  async function acknowledge(row:CoordinationItem) {
    if(!writable||inFlight.current)return
    inFlight.current=true;setBusy(row.id);setWriteError('')
    try {
      await client.post('/v1/run-coordination?run_id='+encodeURIComponent(runId),{id:row.id,revision:row.revision})
      if(current.current)setRefresh(value=>value+1)
    } catch {if(current.current){setWriteError('暂未确认知悉结果，请刷新后重试。');setRefresh(value=>value+1)}}
    finally{inFlight.current=false;if(current.current)setBusy(undefined)}
  }
  return <section className="task-drawer-card ops-run-coordination" aria-label="运行协作">
    <style>{css}</style>
    <header><h3>运行协作</h3><p>查看代理之间的求助、交接和问题上报。协作不会阻塞任务，也不能替代授权或验收。</p></header>
    <div className="coord-head"><strong>{items ? `${pending.length} 项待关注 · ${items.length} 条协作记录`:'正在读取协作记录…'}</strong><button type="button" className="ops-button" onClick={()=>setRefresh(value=>value+1)}>刷新</button></div>
    {error&&<p role="alert">无法读取当前协作记录。请刷新。{items?'以下为上次读取内容。':''}</p>}
    {writeError&&<p role="alert">{writeError}</p>}
    {items?.length===0&&<p className="coord-empty">本次运行暂无协作记录。发现问题的代理可主动提交，不需要你手动协调。</p>}
    {items&&items.length>0&&<ul>{[...items].sort((a,b)=>Number(pending.includes(b))-Number(pending.includes(a))||b.created_ms-a.created_ms).map(row=><li key={row.id}>
      <div className="coord-head"><strong>{kinds[row.kind]} · {states[row.state]}</strong><span>{new Date(row.created_ms).toLocaleString()}</span></div>
      <p className="coord-meta">{row.source} → {row.target??'主脑 / 操作人'}</p>
      <p className="coord-text">{row.body}</p>
      {row.reply&&<p className="coord-text"><strong>回应：</strong>{row.reply}</p>}
      {row.reason&&<p className="coord-meta">{row.reason}</p>}
      {row.state==='pending'&&<p className="coord-meta">最晚回应：{new Date(row.expires_ms).toLocaleTimeString()}；不影响原任务推进。</p>}
      {pending.includes(row)&&<div className="coord-head"><span>知悉只记录你已查看，不代表问题已解决。</span><PanelCommandButton disabled={!!busy||error} onClick={()=>void acknowledge(row)}>{busy===row.id?'正在记录…':'标记已知悉'}</PanelCommandButton></div>}
    </li>)}</ul>}
  </section>
}
const css=`
.ops-run-coordination{display:grid;gap:16px;min-width:0;overflow-wrap:anywhere}
.ops-run-coordination h3,.ops-run-coordination p{margin:0}
.ops-run-coordination header{display:grid;gap:7px}
.ops-run-coordination h3{font-size:${FONT_PX.section}px}
.ops-run-coordination header p,.ops-run-coordination .coord-meta,.ops-run-coordination .coord-head span{color:${COLOR.inkMuted};font-size:${FONT_PX.helper}px;line-height:1.6}
.ops-run-coordination .coord-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
.ops-run-coordination ul{display:grid;gap:8px;list-style:none;padding:0;margin:0}
.ops-run-coordination li,.ops-run-coordination .coord-empty{border:1px solid ${COLOR.line};border-radius:8px;padding:12px;min-width:0;display:grid;gap:7px}
.ops-run-coordination .coord-empty{background:${COLOR.sidebar};color:${COLOR.inkMuted}}
.ops-run-coordination .coord-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}
`
