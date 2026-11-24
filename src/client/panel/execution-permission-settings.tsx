import { useEffect, useMemo, useRef, useState } from 'react'
import { type ExecutionPermissionMode, type ExecutionPermissionView } from '../../core/execution-permissions.ts'
import { createExecutionPermissionsApi } from '../api/execution-permissions.ts'
import type { ApiClient } from '../api/client.ts'

const choices: Array<{ mode: ExecutionPermissionMode; label: string; description: string }> = [
  { mode: 'full', label: '全部宿主权限（默认）', description: '使用宿主提供的全权限预设，访问已注册的插件、技能和工具。' },
  { mode: 'inherit', label: '跟随来源会话', description: '创建执行尝试时，继承来源会话的文件权限和审批策略。' },
  { mode: 'brain', label: '主脑审批，必要时问我', description: '主脑逐次审核原生工具调用。范围不明或高风险操作交给你确认。' },
  { mode: 'user', label: '由我审批', description: '每次原生工具调用都通过 DSH 审批。任务会话会提示等待审批。' },
]

export function ExecutionPermissionSettings({ client, reloadVersion, writable }: {
  client: ApiClient; reloadVersion: number; writable: boolean
}) {
  const api = useMemo(() => createExecutionPermissionsApi(client), [client])
  const [reload, setReload] = useState(0)
  const [saved, setSaved] = useState<{ version: string; view: ExecutionPermissionView }>()
  const [failure, setFailure] = useState<{ version: string; message: string }>()
  const [busy, setBusy] = useState(false)
  const version = `${reloadVersion}:${reload}`
  const currentVersion = useRef(version)
  currentVersion.current = version
  const view = saved?.version === version ? saved.view : undefined
  const error = failure?.version === version ? failure.message : undefined
  useEffect(() => {
    let active = true
    void api.read().then(data => { if (active) setSaved({ version, view: data }) })
      .catch(() => { if (active) setFailure({ version, message: '暂时无法读取执行权限设置。' }) })
    return () => { active = false }
  }, [api, version])
  async function change(mode: ExecutionPermissionMode) {
    if (!view || busy || !writable || error || mode === view.mode) return
    setBusy(true)
    try {
      const confirmed = await api.save(mode, view.revision)
      if (version === currentVersion.current) setSaved({ version, view: confirmed })
    } catch { setFailure({ version, message: '暂时无法确认设置是否已保存。请重新读取。' }) }
    finally {
      if (version !== currentVersion.current) setReload(value => value + 1)
      setBusy(false)
    }
  }
  return <section className="ops-surface" aria-labelledby="execution-permissions-title">
    <header className="ops-surface-head"><h2 id="execution-permissions-title" className="ops-settings-anchor" tabIndex={-1}>执行权限</h2></header>
    <div className="ops-inset ops-stack">
      <p id="execution-permissions-scope">适用于此 Desktop 用户的新执行尝试。以宿主和任务约束为上限；设置不会修改在途尝试。</p>
      <p>当前普通节点只执行已确认的只读原生工具。未知或有副作用的工具会说明缺口；全权限设置不会绕过节点限制。</p>
      {busy ? <p role="status">正在确认执行权限设置是否已保存…</p> : error ? <>
        <p role="alert">{error}</p><button className="ops-button" type="button" onClick={() => setReload(value => value + 1)}>重新读取执行权限设置</button>
      </> : view ? <>
        <label>执行权限模式 <select aria-label="执行权限模式" aria-describedby="execution-permissions-scope" value={view.mode}
          disabled={!writable} onChange={event => { void change(event.currentTarget.value as ExecutionPermissionMode) }}>
          {choices.map(choice => <option key={choice.mode} value={choice.mode}>{choice.label}</option>)}
        </select></label>
        <p role="status">{choices.find(choice => choice.mode === view.mode)?.description}</p>
      </> : <p role="status">正在读取执行权限设置…</p>}
    </div>
  </section>
}
