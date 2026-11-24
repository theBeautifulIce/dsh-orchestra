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
    <div className="ops-inset ops-setting-body">
      <p id="execution-permissions-scope" className="ops-setting-help">对本机 DSH 用户的新执行尝试生效。正在执行的任务保持原设置。</p>
      <div className="ops-setting-row">
        <div className="ops-setting-copy">
          <label className="ops-setting-label" htmlFor="execution-permission-mode">执行权限模式</label>
          <p id="execution-permissions-description" className="ops-setting-help" role="status">{view
            ? choices.find(choice => choice.mode === view.mode)?.description : '选择执行工具时使用的权限与审批方式。'}</p>
        </div>
        <div className="ops-setting-control">
          {busy ? <p className="ops-setting-feedback" role="status">正在确认执行权限设置是否已保存…</p> : error ? <>
            <p className="ops-setting-feedback" role="alert">{error}</p>
            <button className="ops-button" type="button" onClick={() => setReload(value => value + 1)}>重新读取执行权限设置</button>
          </> : view ? <select id="execution-permission-mode" className="ops-field" aria-label="执行权限模式"
            aria-describedby="execution-permissions-scope execution-permissions-description execution-permissions-boundary" value={view.mode}
            disabled={!writable} onChange={event => { void change(event.currentTarget.value as ExecutionPermissionMode) }}>
            {choices.map(choice => <option key={choice.mode} value={choice.mode}>{choice.label}</option>)}
          </select> : <p className="ops-setting-feedback" role="status">正在读取执行权限设置…</p>}
        </div>
      </div>
      <p id="execution-permissions-boundary" className="ops-setting-note">全权限设置不会绕过节点限制。普通节点仅执行已确认的只读工具，其他能力会提示缺口。</p>
    </div>
  </section>
}
