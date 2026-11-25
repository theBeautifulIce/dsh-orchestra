import { onLedgerCommit, type Db } from '../infra/sqlite/driver.ts'
/** Independent per-source-session delivery: a slow model/session flush cannot stall other sessions. */
export function createChatReportPump<Key,Binding>(sessions: Map<Key,Binding>, publish: (key:Key,binding:Binding)=>Promise<void>, signal:AbortSignal) {
  type State = { db?:Db; unsubscribe?:()=>void; timer?:ReturnType<typeof setTimeout>; active?:Promise<void>; dirty:boolean; forgotten:boolean }
  const states=new Map<Key,State>()
  let closed=false
  const stopped=()=>closed||signal.aborted
  function stateOf(key:Key){let s=states.get(key);if(!s){s={dirty:false,forgotten:false};states.set(key,s)}return s}
  function launch(key:Key) {
    if(stopped())return
    const binding=sessions.get(key)
    if(!binding){forget(key);return}
    const s=stateOf(key)
    if(s.forgotten)return
    if(s.active)return
    clearTimeout(s.timer);s.timer=undefined;s.dirty=false
    s.active=Promise.resolve().then(()=>publish(key,binding)).catch(()=>{}).finally(()=>{
      s.active=undefined
      if(s.forgotten){if(states.get(key)===s)states.delete(key);return}
      if(s.dirty)schedule(key)
    })
  }
  function schedule(key:Key) {
    if(stopped()||!sessions.has(key))return
    const s=stateOf(key)
    if(s.forgotten)return
    if(s.active){s.dirty=true;return}
    if(s.timer)return
    s.timer=setTimeout(()=>{s.timer=undefined;launch(key)},50)
    s.timer.unref?.()
  }
  function forget(key:Key) {
    const s=states.get(key);if(!s)return
    s.forgotten=true;s.unsubscribe?.();clearTimeout(s.timer);s.timer=undefined
    if(!s.active)states.delete(key)
  }
  return {
    watch(key:Key,db:Db) {
      if(stopped()||!sessions.has(key))return
      const s=stateOf(key)
      if(s.forgotten||s.db===db)return
      s.unsubscribe?.();s.db=db;s.unsubscribe=onLedgerCommit(db,()=>schedule(key))
    },
    schedule,
    forget,
    poll() {
      if(stopped())return
      for(const key of states.keys())if(!sessions.has(key))forget(key)
      for(const key of sessions.keys())launch(key)
    },
    async close() {
      closed=true
      for(const key of states.keys())forget(key)
      await Promise.allSettled([...states.values()].flatMap(s=>s.active?[s.active]:[]))
      states.clear()
    },
  }
}
