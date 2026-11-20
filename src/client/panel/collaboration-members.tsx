import { useEffect, useState } from 'react'
import type { ApiClient } from '../api/client.ts'
import type { NodeRunView, RunSummary } from '../api/types.ts'

export type SelectedMember = { id: string; label: string }

export function collaborationMemberNames(members: readonly Pick<NodeRunView, 'title' | 'node_id' | 'node_run_id'>[]) {
  const names = members.map((member) => member.title?.trim() || `步骤 ${member.node_id || member.node_run_id}`)
  return new Map(members.map((member, index) => {
    const name = names[index]!
    const duplicate = names.indexOf(name) !== names.lastIndexOf(name)
    return [member.node_run_id, duplicate ? `${name} · ${member.node_run_id}` : name]
  }))
}

export function CollaborationMembers({ client, selected, onChange, disabled }: {
  client: ApiClient; selected: SelectedMember[]; onChange: (members: SelectedMember[]) => void; disabled: boolean
}) {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [cursor, setCursor] = useState<string>()
  const [next, setNext] = useState<string | null>(null)
  const [run, setRun] = useState('')
  const [nodes, setNodes] = useState<NodeRunView[]>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const [manual, setManual] = useState('')

  useEffect(() => {
    let current = true
    setError(''); setLoading(true)
    void client.get<{ items: RunSummary[]; next_cursor?: string | null }>('/v1/runs', { limit: 50, cursor }).then(({ data }) => {
      if (!current) return
      setRuns((previous) => {
        const byId = new Map((cursor ? previous : []).map((item) => [item.run_id, item]))
        for (const item of data.items) byId.set(item.run_id, item)
        return [...byId.values()]
      })
      setNext(data.next_cursor ?? null)
    }).catch(() => { if (current) setError('运行列表读取失败。') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [client, cursor, retry])

  useEffect(() => {
    if (!run) return
    let current = true
    setNodes(undefined)
    void client.get<{ items: NodeRunView[] }>('/v1/node-runs', { run_id: run, limit: 200 }).then(({ data }) => {
      if (current) setNodes(data.items.filter((item) => item.run_id === run))
    }).catch(() => { if (current) setError('步骤读取失败。') })
    return () => { current = false }
  }, [client, run, retry])

  const remove = (id: string) => onChange(selected.filter((member) => member.id !== id))
  const eligible = nodes?.filter((item) => item.node_type === 'agent') ?? []
  const names = collaborationMemberNames(eligible)
  return <fieldset disabled={disabled} className="ops-stack">
    <legend>哪些执行步骤可以相互核验？</legend>
    <label>任务运行 <select className="ops-field" value={run} onChange={(event) => {
      setRun(event.target.value); setNodes(undefined); setError('')
    }}>
      <option value="">{loading ? '读取运行中…' : '选择任务的一次运行'}</option>
      {runs.map((item) => <option key={item.run_id} value={item.run_id}>
        {item.task_title || item.workflow_id || '任务'} · {new Date(item.created_at).toLocaleString()} · {item.run_id}
      </option>)}
    </select></label>
    {next && <button type="button" disabled={loading} onClick={() => setCursor(next!)}>更多运行</button>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>重新读取</button></p>}
    {run && !nodes && !error && <p role="status">正在读取本次运行的步骤…</p>}
    {run && nodes && eligible.length === 0 && <p>本页没有可选的智能体步骤。</p>}
    {run && nodes?.length === 200 && <p>当前列出前 200 条中的智能体步骤。后续步骤可通过下方的节点运行 ID 添加。</p>}
    {run && eligible.map((item) => {
      const checked = selected.some((member) => member.id === item.node_run_id)
      const name = names.get(item.node_run_id)!
      return <label key={item.node_run_id}><input type="checkbox" checked={checked} disabled={!checked && selected.length >= 16}
        onChange={() => checked ? remove(item.node_run_id) : onChange([...selected, {
          id: item.node_run_id, label: (runs.find((r) => r.run_id === run)?.task_title || run) + ' / ' + name + ' · 第 ' + item.attempt + ' 次',
        }])} /> {name} · 第 {item.attempt} 次 · {item.status_label}</label>
    })}
    <details><summary>通过节点运行 ID 添加其他步骤</summary>
      <label>节点运行 ID <input value={manual} onChange={(event) => setManual(event.target.value)} /></label>
      <button type="button" disabled={!manual.trim()} onClick={() => {
        const ids = [...new Set(manual.trim().split(/[\s,，]+/u))].filter((id) => !selected.some((member) => member.id === id))
        if (selected.length + ids.length > 16) { setError('每个范围最多包含 16 个步骤。'); return }
        onChange([...selected, ...ids.map((id) => ({ id, label: id }))]); setManual(''); setError('')
      }}>添加</button>
    </details>
    <span>已选 {selected.length} 个步骤，至少选择两个。</span>
    {selected.length > 0 && <ul>{selected.map((member) => <li key={member.id}>{member.label}{' '}
      <button type="button" aria-label={'移除 ' + member.label} onClick={() => remove(member.id)}>移除</button></li>)}</ul>}
  </fieldset>
}
