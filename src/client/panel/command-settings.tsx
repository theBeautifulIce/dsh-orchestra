import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_TASK_COMMAND, normalizeTaskCommandName, type TaskCommandCheck, type TaskCommandView } from '../../core/task-command.ts'
import { createTaskCommandApi } from '../api/task-command.ts'
import { ApiError, type ApiClient } from '../api/client.ts'
import type { ClientCommandReservations } from '../dsh-command-reservations.ts'

const formatHelp = '1–32 位字母、数字、连字符或下划线，以字母开头。可带 / 输入。'
export function CommandSettings({ client, reloadVersion = 0, writable = true, clientCommands }: {
  client: ApiClient; reloadVersion?: number; writable?: boolean; clientCommands?: ClientCommandReservations
}) {
  const api = useMemo(() => createTaskCommandApi(client), [client])
  const [reload, setReload] = useState(0)
  const [view, setView] = useState<TaskCommandView>()
  const [draft, setDraft] = useState('')
  const [check, setCheck] = useState<TaskCommandCheck>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)
  const pending = useRef<AbortController>()
  const savePending = useRef<AbortController>()
  const name = normalizeTaskCommandName(draft)
  useEffect(() => {
    const signal = new AbortController()
    const version = ++generation.current
    pending.current?.abort()
    savePending.current?.abort()
    setView(undefined); setCheck(undefined); setError(undefined); setNotice(undefined); setDraft(''); setSaving(false)
    void api.read(signal.signal).then(data => {
      if (signal.signal.aborted || version !== generation.current) return
      setView(data); setDraft('/' + data.name)
      const local = clientCommands?.activate(data.name, data.revision)
      setCheck(local && !local.available ? local : data.check)
    }).catch(() => { if (!signal.signal.aborted) setError('暂时无法读取任务命令。请重新读取。') })
    return () => { signal.abort(); pending.current?.abort(); savePending.current?.abort(); generation.current += 1 }
  }, [api, reloadVersion, reload, clientCommands])

  useEffect(() => {
    pending.current?.abort()
    if (!view || !name || !writable || saving) { setChecking(false); return }
    const request = new AbortController()
    pending.current = request
    setChecking(true); setCheck(undefined)
    const timer = setTimeout(() => {
      void api.check(name, request.signal).then(remote => {
        if (request.signal.aborted) return
        const local = clientCommands?.check(name)
        setCheck(local && !local.available ? local : remote)
      }).catch(() => { if (!request.signal.aborted) setError('暂时无法检查命令冲突。请重试。') })
        .finally(() => { if (!request.signal.aborted) setChecking(false) })
    }, 350)
    return () => { clearTimeout(timer); request.abort() }
  }, [api, name, view, writable, saving, clientCommands])

  async function save() {
    if (!view || !name || !writable || saving || !clientCommands) return
    const version = generation.current
    const request = new AbortController()
    pending.current?.abort(); savePending.current = request
    setSaving(true); setNotice(undefined); setError(undefined)
    let reservation: ReturnType<ClientCommandReservations['hold']> | undefined
    let committed = false
    try {
      reservation = clientCommands.hold(name)
      const saved = await api.save(name, view.revision, request.signal)
      if (request.signal.aborted || version !== generation.current) return
      reservation.commit(saved.revision); committed = true
      setView(saved); setDraft('/' + saved.name); setCheck(saved.check)
      setNotice(`已保存。现在使用 /${saved.name} 任务内容。`)
    } catch (failure) {
      if (request.signal.aborted || version !== generation.current) return
      setError(failure instanceof ApiError || failure instanceof Error ? failure.message : '暂时无法确认任务命令是否已保存。请重新读取。')
      setCheck(undefined)
    } finally {
      if (!committed) reservation?.release()
      if (version === generation.current) setSaving(false)
    }
  }
  const conflicts = check && check.name === name && !check.available ? check.conflicts.map(row => row.label).join('；') : undefined
  const valid = name && check?.name === name && check.available
  return <section className="ops-surface" aria-labelledby="task-command-title">
    <header className="ops-surface-head"><h2 id="task-command-title" className="ops-settings-anchor" tabIndex={-1}>任务命令</h2></header>
    <div className="ops-inset ops-setting-body">
      <div className="ops-setting-row">
        <div className="ops-setting-copy"><label htmlFor="task-command-input" className="ops-setting-label">手动启动任务</label>
          <p className="ops-setting-help">输入命令和任务内容，将本次请求交给 Orchestra。</p>
          <p id="task-command-help" className="ops-setting-help">{formatHelp}</p>
        </div>
        <div className="ops-setting-control"><input id="task-command-input" className="ops-field" value={draft} placeholder="/orchestra"
          spellCheck={false} autoCapitalize="none" autoComplete="off" aria-describedby="task-command-help task-command-feedback"
          aria-invalid={Boolean(draft && !name || conflicts)} disabled={!view || !writable || saving}
          onChange={event => { setDraft(event.currentTarget.value); setNotice(undefined); setError(undefined) }}
          onBlur={() => { if (name) setDraft('/' + name) }} />
        </div>
      </div>
      <p id="task-command-feedback" className="ops-setting-feedback" role={error || conflicts || draft && !name ? 'alert' : 'status'}>
        {error ?? (draft && !name ? formatHelp : conflicts ? `/${name} 不可用：${conflicts}。请换一个名称。`
          : saving ? '正在保存并再次检查冲突…' : !view ? '正在读取任务命令…' : checking ? '正在检查命令冲突…'
            : notice ?? (!clientCommands ? '等待 Desktop 命令目录，暂不能保存。' : valid ? `/${name} 可用。` : '输入完成后自动检查冲突。'))}
      </p>
      <div className="ops-actions"><button type="button" className="ops-button ops-button--primary" disabled={!writable || saving || checking || !valid || !clientCommands || Boolean(error) || name === view?.name}
        onClick={() => { void save() }}>保存命令</button>
        <button type="button" className="ops-button" disabled={!view || !writable || saving || draft === '/' + DEFAULT_TASK_COMMAND}
          onClick={() => { setDraft('/' + DEFAULT_TASK_COMMAND); setNotice(undefined); setError(undefined) }}>恢复默认</button>
        {error && <button type="button" className="ops-button" disabled={saving} onClick={() => setReload(value => value + 1)}>重新读取</button>}
      </div>
      <p className="ops-setting-note">适用于此 Desktop 用户。保存后从下一条消息生效，原命令停用。检查当前会话的宿主命令、用户技能和客户端命令；其他会话在使用前再次检查。启停插件后请重新打开设置检查。</p>
    </div>
  </section>
}
