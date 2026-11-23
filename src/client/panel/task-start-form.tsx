import { useEffect, useId, useState, type FormEvent } from 'react'
import { ApiError } from '../api/client.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { TaskCommands } from '../api/task-commands.ts'
import type { WorkflowListItem } from '../api/types.ts'
import type { Autonomy } from '../../service/runs.ts'
import { PanelCommandButton } from './shell.tsx'

type LaunchInput = Parameters<TaskCommands['start']>[0]
const AUTONOMY_HELP: Record<Autonomy, string> = {
  autonomous: '只有必须人工处理或你点名的事项会进入「审批中心 → 待处理」。普通决定可在「全部进行中」查看，超时按默认规则处理。',
  assisted: '普通决定也会进入「审批中心 → 待处理」，你可按权限提前处理。审计专属决定可在「全部进行中」查看。普通决定超时按默认规则处理。',
  supervised: '你可处理的决定会进入「审批中心 → 待处理」。超时仍等待获授权的处理。',
}

export function TaskStartForm({ api, commands, onCreated, onOpenRun, collaborationEnabled, onPlanWorkflow }: {
  api: ResourcesApi; commands: TaskCommands; onCreated: () => void
  collaborationEnabled?: boolean
  onOpenRun?: (taskId: string, trigger: HTMLButtonElement, runId: string) => void
  onPlanWorkflow?: (workflow: WorkflowListItem & { current_version: number }, title: string) => void
}) {
  const [workflows, setWorkflows] = useState<WorkflowListItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [title, setTitle] = useState('')
  const [selected, setSelected] = useState('')
  const [autonomy, setAutonomy] = useState<Autonomy>('autonomous')
  const autonomyHelpId = useId()
  const [pending, setPending] = useState<LaunchInput | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<{ taskId: string; runId: string } | null>(null)
  useEffect(() => {
    let current = true
    // 服务端按 reusable 过滤后再分页，第 100 条之后的可用流程也能选到（P03）。
    void api.listWorkflows({ status: 'active', scope: 'reusable', limit: 100 }).then(({ data }) => {
      if (current) setWorkflows(data.items.filter((item) => item.current_version !== null))
    }).catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [api])
  async function submit(event: FormEvent) {
    event.preventDefault()
    const workflow = workflows?.find((item) => item.workflow_id === selected)
    const trimmedTitle = title.trim()
    if (onPlanWorkflow) {
      if (workflow && workflow.current_version !== null && trimmedTitle) {
        onPlanWorkflow({ ...workflow, current_version: workflow.current_version }, trimmedTitle)
      }
      return
    }
    const input = pending ?? (workflow && workflow.current_version !== null && trimmedTitle ? {
      operationId: newOperationId(), title: trimmedTitle, workflowId: workflow.workflow_id, version: String(workflow.current_version), autonomy,
    } : null)
    if (!input || busy) return
    setBusy(true)
    setReceipt(null)
    setNotice('')
    try {
      const result = await commands.start(input)
      if (result.task_id && result.run_id) setReceipt({ taskId: result.task_id, runId: result.run_id })
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
      {onPlanWorkflow ? <p>补充本次的交付物和验收条件，确认固定流程版本后再启动。</p> : <>
        <label>审批提醒与等待方式 <select value={autonomy} aria-describedby={autonomyHelpId} disabled={busy || Boolean(pending)}
          onChange={(event) => setAutonomy(event.target.value as Autonomy)}>
          <option value="autonomous">自主执行（默认）</option><option value="assisted">协助执行</option><option value="supervised">人工监督</option>
        </select></label>
        <p id={autonomyHelpId}>{AUTONOMY_HELP[autonomy]}</p>
        {collaborationEnabled && <p>需要两个步骤互相检查时，可在「协作核验」选择参与步骤。</p>}
      </>}
      <PanelCommandButton type="submit" disabled={busy || (!pending && (!title.trim() || !selected))}>
        {onPlanWorkflow ? '用此流程规划任务' : pending ? '查询或重试' : '创建并排队'}
      </PanelCommandButton>
    </>}
    {notice && <p role="status">{notice}</p>}
    {receipt && onOpenRun && <button type="button" onClick={(event) => onOpenRun(receipt.taskId, event.currentTarget, receipt.runId)}>查看本次运行</button>}
  </form>
}
