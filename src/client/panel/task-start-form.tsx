import { useEffect, useState, type FormEvent } from 'react'
import { ApiError } from '../api/client.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { TaskCommands } from '../api/task-commands.ts'
import type { WorkflowListItem } from '../api/types.ts'
import { PanelCommandButton } from './shell.tsx'

type LaunchInput = Parameters<TaskCommands['start']>[0]

export function TaskStartForm({ api, commands, onCreated }: { api: ResourcesApi; commands: TaskCommands; onCreated: () => void }) {
  const [workflows, setWorkflows] = useState<WorkflowListItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [title, setTitle] = useState('')
  const [selected, setSelected] = useState('')
  const [autonomy, setAutonomy] = useState('assisted')
  const [pending, setPending] = useState<LaunchInput | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    void api.listWorkflows({ status: 'active', limit: 100 }).then(({ data }) => {
      if (current) setWorkflows(data.items.filter((item) => item.scope === 'reusable' && item.current_version !== null))
    }).catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [api])
  async function submit(event: FormEvent) {
    event.preventDefault()
    const workflow = workflows?.find((item) => item.workflow_id === selected)
    const input = pending ?? (workflow && workflow.current_version !== null && title.trim() ? {
      operationId: newOperationId(), title: title.trim(), workflowId: workflow.workflow_id, version: String(workflow.current_version), autonomy,
    } : null)
    if (!input || busy) return
    setBusy(true)
    setNotice('')
    try {
      await commands.start(input)
      setTitle('')
      setPending(null)
      setNotice('任务已创建，执行步骤已入队。')
      onCreated()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'OPERATION_OUTCOME_UNKNOWN') setPending(input)
      else setPending(null)
      setNotice(error instanceof Error ? error.message : '任务创建暂不可确认。')
    } finally { setBusy(false) }
  }
  return <form className="task-launch-form" onSubmit={(event) => { void submit(event) }} aria-label="从已发布流程创建任务">
    {failed && <p role="alert">暂时无法读取已发布流程。关闭后重新打开可再试。</p>}
    {!workflows && !failed && <p role="status">正在读取已发布流程…</p>}
    {workflows?.length === 0 && <p>发布一个可复用流程后，就可以从这里创建任务。</p>}
    {workflows && workflows.length > 0 && <>
      <label>任务标题 <input value={title} maxLength={200} disabled={busy || Boolean(pending)} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>已发布流程 <select value={selected} disabled={busy || Boolean(pending)} onChange={(event) => setSelected(event.target.value)}>
        <option value="">选择流程</option>{workflows.map((item) => <option key={item.workflow_id} value={item.workflow_id}>{item.name} · v{item.current_version}</option>)}
      </select></label>
      <label>自治档位 <select value={autonomy} disabled={busy || Boolean(pending)} onChange={(event) => setAutonomy(event.target.value)}>
        <option value="assisted">协助执行</option><option value="autonomous">自主执行</option><option value="supervised">人工监督</option>
      </select></label>
      <PanelCommandButton type="submit" disabled={busy || (!pending && (!title.trim() || !selected))}>{pending ? '查询或重试' : '创建并排队'}</PanelCommandButton>
    </>}
    {notice && <p role="status">{notice}</p>}
  </form>
}
