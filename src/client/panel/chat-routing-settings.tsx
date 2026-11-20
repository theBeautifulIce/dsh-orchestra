import { useEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatRoutingView } from '../../service/native-chat-routing-settings.ts'
import { createChatRoutingApi } from '../api/chat-routing.ts'
import { type ApiClient } from '../api/client.ts'

export function ChatRoutingSettings({ client, reloadVersion, writable }: {
  client: ApiClient; reloadVersion: number; writable: boolean
}) {
  const api = useMemo(() => createChatRoutingApi(client), [client])
  const [reload, setReload] = useState(0)
  const [saved, setSaved] = useState<{ version: string; view: NativeChatRoutingView }>()
  const [failure, setFailure] = useState<{ version: string; message: string }>()
  const [busy, setBusy] = useState(false)
  const version = `${reloadVersion}:${reload}`
  const currentVersion = useRef(version)
  currentVersion.current = version
  const view = saved?.version === version ? saved.view : undefined
  const error = failure?.version === version ? failure.message : undefined

  useEffect(() => {
    let active = true
    void api.read().then((data) => { if (active) setSaved({ version, view: data }) })
      .catch(() => { if (active) setFailure({ version, message: '暂时无法读取自动接管设置。' }) })
    return () => { active = false }
  }, [api, version])

  async function change(enabled: boolean) {
    if (!view || busy || !writable || error) return
    setBusy(true)
    try {
      const confirmed = await api.save(enabled, view.revision)
      if (version === currentVersion.current) setSaved({ version, view: confirmed })
    } catch {
      setFailure({ version, message: '暂时无法确认设置是否已保存。请重新读取。' })
    } finally {
      if (version !== currentVersion.current) setReload((value) => value + 1)
      setBusy(false)
    }
  }

  return <section className="ops-surface" aria-labelledby="chat-routing-title">
    <header className="ops-surface-head"><h2 id="chat-routing-title">聊天任务自动接管</h2></header>
    <div className="ops-inset ops-stack">
      <p id="chat-routing-scope">适用于此 Desktop 用户的会话，从下一条消息生效。关闭后仍可用 <code>/orchestra 任务内容</code> 交给 Orchestra。</p>
      {busy ? <p role="status">正在确认设置是否已保存…</p> : error ? <>
        <p role="alert">{error}</p>
        <button className="ops-button" type="button" onClick={() => setReload((value) => value + 1)}>重新读取自动接管设置</button>
      </> : view ? <label>
        <input type="checkbox" role="switch" aria-label="聊天任务自动接管" aria-describedby="chat-routing-scope"
          checked={view.enabled} disabled={!writable} onChange={(event) => { void change(event.currentTarget.checked) }} />
        <span role="status">{view.enabled ? '已开启' : '已关闭'}</span>
      </label> : <p role="status">正在读取自动接管设置…</p>}
    </div>
  </section>
}
