import { useEffect, useState } from 'react'
import type { TaskTriggerCreate, TaskTriggerOccurrence } from '../../core/task-trigger.ts'
import { ApiError } from '../api/client.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { createTaskTriggerCommands } from '../api/task-trigger-commands.ts'
import type { WorkflowListItem } from '../api/types.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import { PanelCommandButton } from './shell.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

const REASON_LABEL: Record<NonNullable<TaskTriggerOccurrence['reason']>, string> = {
  task_archived: '任务已归档',
  previous_run_active: '上次运行还未结束',
  unresolved_effects: '有待核实的历史副作用',
  workflow_inactive: '绑定的流程目前不可用',
}

export function TaskTriggerManager({ api, commands, onChanged }: {
  api: ResourcesApi; commands: ReturnType<typeof createTaskTriggerCommands>; onChanged: () => void
}) {
  const [view, setView] = useState<'rules' | 'event' | null>(null)
  const [workflows, setWorkflows] = useState<WorkflowListItem[] | null>(null)
  const [readError, setReadError] = useState(false)
  const [retry, retryWorkflows] = useState(0)
  const [kind, setKind] = useState<TaskTriggerCreate['kind']>('scheduled')
  const [title, setTitle] = useState('')
  const [workflowId, setWorkflowId] = useState('')
  const [dailyTime, setDailyTime] = useState('09:00')
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [eventType, setEventType] = useState('')
  const [eventId, setEventId] = useState('')
  const [notice, setNotice] = useState('')
  const [fault, setFault] = useState(false)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<TaskTriggerCreate | null>(null)
  const [emitted, setEmitted] = useState<TaskTriggerOccurrence[] | null>(null)

  useEffect(() => {
    if (view !== 'rules') return
    let active = true
    setReadError(false)
    void api.listWorkflows({ status: 'active', limit: 100 }).then(({ data }) => {
      if (active) setWorkflows(data.items.filter((workflow) => workflow.scope === 'reusable' && workflow.current_version !== null))
    }).catch(() => { if (active) setReadError(true) })
    return () => { active = false }
  }, [api, view, retry])

  async function submitRule() {
    const workflow = workflows?.find((item) => item.workflow_id === workflowId)
    if (busy || (!receipt && (!workflow || workflow.current_version === null || !title.trim()))) return
    const base = { title: title.trim(), workflow_id: workflowId, workflow_version: String(workflow?.current_version), operation_id: newOperationId() }
    const input = receipt ?? (kind === 'scheduled'
      ? { ...base, kind, daily_time: dailyTime, time_zone: timeZone.trim() }
      : { ...base, kind, event_type: eventType.trim() })
    setBusy(true)
    setNotice('')
    setFault(false)
    try {
      await commands.create(input)
      setReceipt(null)
      setTitle('')
      setNotice('已登记触发任务。可在任务详情查看下一次触发与运行历史。')
      onChanged()
    } catch (error) {
      setFault(true)
      if (error instanceof ApiError && error.code === 'OPERATION_OUTCOME_UNKNOWN') setReceipt(input)
      else setReceipt(null)
      setNotice(error instanceof Error ? error.message : '无法确认触发规则是否已登记。')
    } finally {
      setBusy(false)
    }
  }

  async function submitEvent() {
    if (busy || !eventType.trim() || !eventId.trim()) return
    setBusy(true)
    setNotice('')
    setEmitted(null)
    setFault(false)
    try {
      const result = await commands.emit(eventType.trim(), eventId.trim())
      setEmitted(result.items)
      setNotice(result.replayed ? '已查到历史事件的触发结果。' : '事件已登记。')
      onChanged()
    } catch (error) {
      setFault(true)
      setNotice(error instanceof ApiError && ['SERVICE_UNAVAILABLE', 'OPERATION_TIMEOUT'].includes(error.code)
        ? '暂未确认收件结果。用同一事件编号可查询或重试。'
        : error instanceof Error ? error.message : '事件提交失败。')
    } finally {
      setBusy(false)
    }
  }

  const switchView = (next: 'rules' | 'event') => {
    if (busy || receipt) return
    setNotice('')
    setEmitted(null)
    setView(view === next ? null : next)
  }
  return <div style={wrapper}>
    <div role="group" aria-label="任务触发操作" style={actions}>
      <button type="button" style={buttonStyle} disabled={busy || Boolean(receipt)} aria-expanded={view === 'rules'}
        onClick={() => switchView('rules')}>新建触发任务</button>
      <button type="button" style={buttonStyle} disabled={busy || Boolean(receipt)} aria-expanded={view === 'event'}
        onClick={() => switchView('event')}>提交触发事件</button>
    </div>
    {view === 'rules' && <form aria-label="新建触发任务" style={formStyle} onSubmit={(event) => { event.preventDefault(); void submitRule() }}>
      {readError && <p role="alert">无法读取已发布流程。 <button type="button" onClick={() => retryWorkflows((value) => value + 1)}>重试</button></p>}
      {!readError && !workflows && <p role="status">正在读取已发布流程…</p>}
      {!readError && workflows?.length === 0 && <p>发布一个可复用流程后即可登记触发任务。</p>}
      {Boolean(workflows?.length) && <>
        <label>任务标题 <input required maxLength={200} value={title} disabled={busy || Boolean(receipt)} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>已发布流程 <select required value={workflowId} disabled={busy || Boolean(receipt)} onChange={(event) => setWorkflowId(event.target.value)}>
          <option value="">选择流程</option>
          {workflows?.map((workflow) => <option key={workflow.workflow_id} value={workflow.workflow_id}>{workflow.name} · v{workflow.current_version}</option>)}
        </select></label>
        <label>触发方式 <select value={kind} disabled={busy || Boolean(receipt)} onChange={(event) => setKind(event.target.value === 'event' ? 'event' : 'scheduled')}>
          <option value="scheduled">每日定时</option><option value="event">接收事件</option>
        </select></label>
        {kind === 'scheduled' ? <>
          <label>每天 <input type="time" required value={dailyTime} disabled={busy || Boolean(receipt)} onChange={(event) => setDailyTime(event.target.value)} /></label>
          <label>时区 <input required maxLength={100} placeholder="Asia/Shanghai" value={timeZone} disabled={busy || Boolean(receipt)} onChange={(event) => setTimeZone(event.target.value)} /></label>
        </> : <label>事件类型 <input required maxLength={128} placeholder="project.ready" value={eventType} disabled={busy || Boolean(receipt)} onChange={(event) => setEventType(event.target.value)} /></label>}
        <PanelCommandButton style={buttonStyle} type="submit" disabled={busy}>{receipt ? '查询或重试' : '登记任务'}</PanelCommandButton>
      </>}
    </form>}
    {view === 'event' && <form aria-label="提交触发事件" style={formStyle} onSubmit={(event) => { event.preventDefault(); void submitEvent() }}>
      <label>事件类型 <input required maxLength={128} placeholder="project.ready" value={eventType} disabled={busy} onChange={(event) => setEventType(event.target.value)} /></label>
      <label>事件编号 <input required maxLength={128} placeholder="project-ready-001" value={eventId} disabled={busy} onChange={(event) => setEventId(event.target.value)} /></label>
      <PanelCommandButton style={buttonStyle} type="submit" disabled={busy}>提交事件</PanelCommandButton>
    </form>}
    {notice && <p role={fault ? 'alert' : 'status'} style={noticeStyle}>{notice}</p>}
    {emitted && (emitted.length === 0 ? <p style={noticeStyle}>当时没有匹配的启用规则。</p> : <ul style={noticeStyle}>
      {emitted.map((occurrence) => <li key={occurrence.trigger_id}>{occurrence.reason
        ? `已跳过 · ${REASON_LABEL[occurrence.reason]}`
        : `已创建运行 · ${occurrence.run_id}`}</li>)}
    </ul>)}
  </div>
}

const wrapper = { display: 'grid', gap: 8, fontSize: FONT_PX.body }
const actions = { display: 'flex', gap: 8, flexWrap: 'wrap' } as const
const formStyle = { display: 'grid', gap: 8, padding: 12, border: `1px solid ${COLOR.line}`, borderRadius: 8 }
const buttonStyle = { padding: '5px 10px', minHeight: 34, border: `1px solid ${COLOR.line}`, borderRadius: 6, color: COLOR.ink, background: COLOR.surface, alignSelf: 'start' } as const
const noticeStyle = { margin: 0, color: COLOR.ink, fontSize: FONT_PX.helper }
