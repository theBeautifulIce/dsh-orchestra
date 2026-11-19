import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { ListTasksParams, ResourcesApi } from '../api/resources.ts'
import type { TaskSummary } from '../api/types.ts'
import { TASK_LANES, type TaskLane } from '../../core/task-workspace.ts'
import { TaskFlowView } from './task-flow-view.tsx'
import { TaskPlanForm } from './task-plan-form.tsx'
import { TaskStartForm } from './task-start-form.tsx'
import type { TaskCommands } from '../api/task-commands.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { UnknownState } from './shell.tsx'
import { TASK_WORKSPACE_CSS } from './task-workspace-styles.ts'

const ATTENTION_LABEL: Record<string, string> = {
  decision: '待审批', unverified: '待核验', failed: '执行失败', orphaned: '待接管', running: '执行中', none: '无待处理事项',
}
const STATUS_LABEL: Record<string, string> = {
  reserved: '已接收', queued: '排队中', running: '进行中', waiting: '等待中', succeeded: '已完成', failed: '未成功', cancelled: '已取消',
  paused: '已暂停', settling: '正在收尾', orphaned: '等待接手',
}
const EFFECT_LABEL: Record<string, string> = { pure: '只读步骤', compensable: '可能需要补偿', irreversible: '涉及不可逆操作' }

/** 未验证终态是独立状态：自己的中文文案与色板，不折叠进「已完成」或「未成功」。 */
const UNVERIFIED_STATUS: Record<string, { label: string; tone: string }> = {
  succeeded_with_unverified: { label: COPY.succeededWithUnverified, tone: COLOR.warning },
  failed_with_unverified: { label: COPY.failedWithUnverified, tone: COLOR.danger },
}

/** 交付验收结论的独立文案与色板：验收没过就不算目标达成，不能显示成「已完成」。 */
const ACCEPTANCE_STATUS: Record<string, { label: string; tone: string }> = {
  failed: { label: COPY.deliveryAcceptanceFailed, tone: COLOR.danger },
  unverifiable: { label: COPY.deliveryAcceptanceUnverifiable, tone: COLOR.warning },
}

/** 未验证终态的独立文案与色板：面板各处共用一份，不各写各的。 */
export function unverifiedStatusView(status: string): { label: string; tone: string } | undefined {
  return UNVERIFIED_STATUS[status]
}

export type TaskListScreenProps = {
  api: ResourcesApi
  onSelectTask: (taskId: string, trigger: HTMLButtonElement, runId?: string) => void
  selectedTaskId?: string | null
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
  commands?: TaskCommands
  triggerManager?: ReactNode
  reworkEnabled?: boolean
}

/** 任务状态文案与色板：display_status 优先，未验证终态走独立文案。 */
export function taskStatusView(status: string, displayStatus = status): { label: string | undefined; tone: string | undefined } {
  const unverified = UNVERIFIED_STATUS[status] ?? UNVERIFIED_STATUS[displayStatus]
  if (unverified) return { label: unverified.label, tone: unverified.tone }
  return { label: STATUS_LABEL[displayStatus] ?? STATUS_LABEL[status], tone: undefined }
}

export function taskCardStatus(task: TaskSummary) {
  if (task.lane === 'upcoming' && task.trigger_enabled === true) {
    return { label: task.trigger_kind === 'scheduled' ? '已排期' : '等待事件', tone: COLOR.link }
  }
  // 执行完成不等于目标达成：验收没过时把验收结论接在执行状态后面，别折叠成「已完成」
  const acceptance = task.delivery_acceptance ? ACCEPTANCE_STATUS[task.delivery_acceptance] : undefined
  if (acceptance) {
    const execution = taskStatusView(task.status, task.display_status).label ?? task.status
    return { label: `${execution} · ${acceptance.label}`, tone: acceptance.tone }
  }
  return taskStatusView(task.status, task.display_status)
}

const VIEWS = [{ id: 'board', label: '看板' }, { id: 'flow', label: '流程' }, { id: 'list', label: '列表' }] as const
const ORIGINS = { manual: '人工', scheduled: '定时', event: '事件触发', continuous: '持续' } as const
const AUTONOMY = { autonomous: '自主执行', assisted: '协助执行', supervised: '人工监督' } as const
const ABSOLUTE_STATUSES = ['reserved', 'queued', 'running', 'waiting', 'paused', 'succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'cancelled']

export const taskOriginLabel = ({ trigger_kind }: { trigger_kind?: TaskSummary['trigger_kind'] }) => trigger_kind ? ORIGINS[trigger_kind] : '来源未记录'
export const taskAutonomyLabel = (task: TaskSummary) => AUTONOMY[task.autonomy] ?? '自治档位未知'

function taskColumn(task: TaskSummary): TaskLane {
  if (task.lane) return task.lane
  if (task.open_decision_count > 0 || task.unverified_count > 0
    || ['decision', 'unverified', 'failed', 'orphaned'].includes(task.attention)
    || ['paused', 'orphaned', 'failed', 'failed_with_unverified'].includes(task.status)) return 'attention'
  if (['succeeded', 'succeeded_with_unverified', 'cancelled'].includes(task.status)) return 'finished'
  if (['reserved', 'queued'].includes(task.status)) return 'upcoming'
  if (task.attention === 'running' || ['running', 'settling', 'waiting'].includes(task.status)) return 'running'
  return 'upcoming'
}

export function TaskListScreen({ api, onSelectTask, selectedTaskId, reloadVersion = 0, onSnapshot, commands, triggerManager, reworkEnabled }: TaskListScreenProps) {
  const [search, setSearch] = useState('')
  const [view, setView] = useState<(typeof VIEWS)[number]['id']>('board')
  const [filter, setFilter] = useState<Omit<ListTasksParams, 'cursor' | 'limit'>>({})
  const [status, setStatus] = useState('')
  const [period, setPeriod] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateInvalid, setDateInvalid] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const [cursor, setCursor] = useState<string | undefined>()
  const [items, setItems] = useState<TaskSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)
  const lastReloadVersion = useRef(reloadVersion)

  useEffect(() => {
    if (lastReloadVersion.current === reloadVersion) return
    lastReloadVersion.current = reloadVersion
    setCursor(undefined)
    setNextCursor(null)
    setReload((value) => value + 1)
  }, [reloadVersion])

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(false)
    void api.listTasks({ limit: 50, cursor, ...filter }).then((result) => {
      if (!current) return
      setItems((previous) => cursor ? mergeByTaskId(previous, result.data.items) : result.data.items)
      setNextCursor(result.data.next_cursor)
      onSnapshot?.(result.as_of_seq)
    }).catch(() => {
      if (!current) return
      setError(true)
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [api, cursor, filter, reload, onSnapshot])

  function updateFilter(next: Partial<ListTasksParams>) {
    setCursor(undefined)
    setNextCursor(null)
    setItems([])
    setLoading(true)
    setFilter((current) => ({ ...current, ...next }))
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    updateFilter({ query: search.trim() || undefined })
  }

  function changePeriod(value: string, from = dateFrom, to = dateTo) {
    setPeriod(value)
    const invalid = value === 'custom' && Boolean(from && to && from > to)
    setDateInvalid(invalid)
    if (!invalid) updateFilter(dateBounds(value, from, to))
  }

  function refresh() {
    setCursor(undefined)
    setReload((n) => n + 1)
  }

  const grouped: Record<TaskLane, TaskSummary[]> = { upcoming: [], running: [], attention: [], finished: [] }
  for (const task of items) grouped[taskColumn(task)].push(task)
  return <section className="task-list" aria-labelledby="tasks-title">
    <style>{TASK_WORKSPACE_CSS}</style>
    <header className="task-page-header">
      <div>
      <h1 id="tasks-title" style={titleStyle}>{filter.archived ? '归档箱' : '任务'}</h1>
      <p style={mutedStyle}>{filter.archived ? '归档任务仍可查看运行记录、结果与证据，也可以取回。' : '点开任务，在右侧查看步骤、结果和证据。'}</p>
      </div>
      {!filter.archived && <div className="task-page-actions">
        {commands && <button type="button" aria-expanded={startOpen} onClick={() => setStartOpen(!startOpen)} style={buttonStyle}>从流程新建任务</button>}
        {triggerManager}
      </div>}
    </header>
    {!filter.archived && commands && startOpen && <TaskStartForm api={api} commands={commands} onCreated={refresh} />}
    {!filter.archived && commands && <div className="task-plan-entry"><TaskPlanForm api={api} commands={commands} onStarted={refresh} /></div>}
    <div className="task-toolbar">
      <label>状态 <select value={status} onChange={(event) => {
        const value = event.target.value
        setStatus(value)
        updateFilter({ lane: value.startsWith('lane:') ? value.slice(5) as TaskLane : undefined,
          status: value && !value.startsWith('lane:') ? value : undefined })
      }}>
        <option value="">全部状态</option>
        <optgroup label="看板分组">{TASK_LANES.map(({ id, label }) => <option key={id} value={`lane:${id}`}>{label}</option>)}</optgroup>
        <optgroup label="执行状态">{ABSOLUTE_STATUSES.map((id) => <option key={id} value={id}>{taskStatusView(id).label}</option>)}</optgroup>
      </select></label>
      <label>更新时间 <select value={period} onChange={(event) => changePeriod(event.target.value)}>
        <option value="">全部时间</option><option value="today">今天</option><option value="7">近 7 天</option>
        <option value="30">近 30 天</option><option value="custom">自选时间段</option>
      </select></label>
      {period === 'custom' && <div className="task-date-range">
        <label>从 <input type="date" aria-label="开始日期" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); changePeriod('custom', event.target.value, dateTo) }} /></label>
        <label>至 <input type="date" aria-label="结束日期" value={dateTo} onChange={(event) => { setDateTo(event.target.value); changePeriod('custom', dateFrom, event.target.value) }} /></label>
      </div>}
      <button type="button" className="task-archive-toggle" style={quietButtonStyle}
        onClick={() => updateFilter({ archived: filter.archived ? undefined : '1' })}>{filter.archived ? '返回任务' : '归档箱'}</button>
    </div>
    {dateInvalid && <p role="alert" style={mutedStyle}>开始日期应早于或等于结束日期。</p>}
    <div className="task-toolbar task-viewbar">
      <label>类型 <select value={filter.trigger_kind ?? ''} onChange={(event) => updateFilter({ trigger_kind: (event.target.value || undefined) as ListTasksParams['trigger_kind'] })}>
        <option value="">全部类型</option>{Object.entries(ORIGINS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        <option value="unknown">来源未记录</option>
      </select></label>
      <span>{filter.query ? `“${filter.query}”` : '已加载'} · {items.length} 项任务</span>
      <form onSubmit={submitSearch} className="task-search" role="search">
        <label style={visuallyHidden} htmlFor="task-search">搜索任务</label>
        <input id="task-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索任务名称" style={searchInputStyle} />
        <button type="submit" style={buttonStyle}>搜索</button>
      </form>
      <button type="button" onClick={refresh} disabled={loading} style={quietButtonStyle}>{loading ? '正在更新…' : '刷新'}</button>
      {!filter.archived && <div className="task-view-group" role="group" aria-label="任务视图">
        {VIEWS.map(({ id, label }) => <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}
      </div>}
    </div>

    {error && <div role="alert" style={errorStyle}>
      <span>{COPY.queryFailed}</span>
      <button type="button" onClick={refresh} style={quietButtonStyle}>{COPY.retry}</button>
    </div>}
    {loading && <p role="status" style={mutedStyle}>正在读取任务…</p>}
    {!loading && !error && items.length === 0 && <div style={emptyStyle}>{filter.archived ? '归档箱没有符合条件的任务。' : Object.values(filter).some(Boolean) ? '没有符合筛选条件的任务。' : COPY.emptyTasks}</div>}
    {(!loading || items.length > 0) && !filter.archived && view === 'board' && <div className="task-board-scroll"><div className="task-board">
      {TASK_LANES.map(({ id, label }) => <section key={id} className="task-column" data-task-column={id} aria-labelledby={`tasks-${id}`}>
        <h2 id={`tasks-${id}`} className="task-column-title">{label}<span>{grouped[id].length}</span></h2>
        {grouped[id].length === 0 && <p className="task-column-empty">暂无任务</p>}
        {grouped[id].map((task) => <TaskCard key={task.task_id} task={task} selected={task.task_id === selectedTaskId} compact={Boolean(selectedTaskId)}
          onSelect={(trigger) => onSelectTask(task.task_id, trigger)} />)}
      </section>)}
    </div></div>}
    {items.length > 0 && (filter.archived || view === 'list') && <TaskTable tasks={items} archived={Boolean(filter.archived)} selectedTaskId={selectedTaskId} onSelect={onSelectTask} />}
    {items.length > 0 && !filter.archived && view === 'flow' && <TaskFlowView reworkEnabled={reworkEnabled} api={api} tasks={items} onOpenTask={onSelectTask} reloadVersion={reloadVersion + reload} />}
    {nextCursor && !error && <div style={{ display: 'flex', justifyContent: 'center' }}>
      <button type="button" disabled={loading} onClick={() => setCursor(nextCursor)} style={buttonStyle}>加载更多</button>
    </div>}
  </section>
}

function dateBounds(period: string, from: string, to: string): Pick<ListTasksParams, 'updated_from' | 'updated_before'> {
  if (period === 'custom') {
    const end = to ? new Date(`${to}T00:00:00`) : null
    if (end) end.setDate(end.getDate() + 1)
    return { updated_from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined, updated_before: end?.toISOString() }
  }
  if (!period) return { updated_from: undefined, updated_before: undefined }
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  start.setDate(start.getDate() - (period === 'today' ? 0 : Number(period) - 1))
  return { updated_from: start.toISOString(), updated_before: end.toISOString() }
}

function TaskTable({ tasks, archived, selectedTaskId, onSelect }: { tasks: TaskSummary[]; archived: boolean; selectedTaskId?: string | null; onSelect: TaskListScreenProps['onSelectTask'] }) {
  return <div className="task-table-scroll"><table className="task-table" aria-label={archived ? '归档任务' : '任务列表'}>
    <thead><tr><th scope="col">任务</th><th scope="col">状态</th><th scope="col">关注事项</th><th scope="col">运行</th><th scope="col">{archived ? '归档时间' : '更新时间'}</th></tr></thead>
    <tbody>{tasks.map((task) => <tr key={task.task_id} data-selected={selectedTaskId === task.task_id || undefined}>
      <td><button className="task-link" type="button" onClick={(event) => onSelect(task.task_id, event.currentTarget)}>{task.title || '未命名任务'}</button>
        <small>{taskOriginLabel(task)} · {taskAutonomyLabel(task)}</small></td>
      <td>{taskCardStatus(task).label ?? <UnknownState value={task.status} />}</td>
      <td>{task.attention_reason ?? '—'}
        <small>{task.open_decision_count} 项{COPY.awaitingDecision}</small>
        <small><TaskWaitAndHeartbeat task={task} /></small>
        <small><TaskRisk level={task.max_side_effect_level} /></small>
      </td><td>{task.run_count} 次</td>
      <td>{archived && task.archived_at ? new Date(task.archived_at).toLocaleString() : formatDate(task.updated_at)}</td>
    </tr>)}</tbody>
  </table></div>
}

/**
 * 分页途中插入新任务时按 task_id 去重：同 task_id 后页整条覆盖前页，
 * 首次出现的位置不动（不重复行，也不把旧行挪到末尾）。
 */
function mergeByTaskId(previous: TaskSummary[], incoming: TaskSummary[]): TaskSummary[] {
  const merged = [...previous]
  const position = new Map<string, number>()
  merged.forEach((task, index) => {
    if (!position.has(task.task_id)) position.set(task.task_id, index)
  })
  for (const task of incoming) {
    const at = position.get(task.task_id)
    if (at === undefined) {
      position.set(task.task_id, merged.length)
      merged.push(task)
    } else {
      merged[at] = task
    }
  }
  return merged
}

function TaskCard({ task, selected, compact, onSelect }: {
  task: TaskSummary; selected: boolean; compact: boolean; onSelect: (trigger: HTMLButtonElement) => void
}) {
  const attention = ATTENTION_LABEL[task.attention]
  const { label: status, tone } = taskCardStatus(task)
  const hasUnverified = task.unverified_count > 0
  const actionable = task.open_decision_count > 0 || hasUnverified || taskColumn(task) === 'attention'
  return <article className="task-card" data-selected={selected || undefined}>
    <div className="task-card-status">
      <span style={tone ? { color: tone } : undefined}>{status ?? <UnknownState value={task.display_status || task.status} />}</span>
      {task.workflow_version !== null && <span>v{task.workflow_version}</span>}
    </div>
    <h3 className="task-card-title"><button type="button" onClick={(event) => onSelect(event.currentTarget)} title={task.title} style={compact ? compactTitleStyle : taskTitleStyle}
      aria-expanded={selected} aria-controls={selected ? 'task-inspector' : undefined}>{task.title || '未命名任务'}</button></h3>
    <p className="task-card-type">{taskOriginLabel(task)} · {taskAutonomyLabel(task)}</p>
    {task.attention_reason && <p className="task-card-reason">{task.attention_reason}</p>}
    {actionable && <div className="task-card-attention">
      {task.open_decision_count > 0 && <strong>{task.open_decision_count} 项{COPY.awaitingDecision}</strong>}
      {hasUnverified && <strong><span style={{ color: tone }}>{task.unverified_count} {tone ? COPY.unverifiedBadge : '项待核实'}</span></strong>}
      {!task.open_decision_count && !hasUnverified && attention && <strong>{attention}</strong>}
      {hasUnverified && <span>{COPY.pendingIrreversible}</span>}
    </div>}
    <div className="task-card-meta">
      <span>{task.run_count} 次运行</span>
      <TaskRisk level={task.max_side_effect_level} />
      <TaskWaitAndHeartbeat task={task} />
      <time dateTime={task.updated_at} title={formatDate(task.updated_at)}>{formatDate(task.updated_at)}</time>
    </div>
  </article>
}

function TaskRisk({ level }: { level: TaskSummary['max_side_effect_level'] }) {
  if (!level) return null
  return <span style={{ color: level === 'irreversible' ? COLOR.danger : COLOR.inkMuted }}>
    {EFFECT_LABEL[level] ?? <UnknownState value={level} />}
  </span>
}

function TaskWaitAndHeartbeat({ task }: { task: TaskSummary }) {
  const { oldest_open_decision_age_seconds: wait, max_heartbeat_age_ms: heartbeat } = task
  return <>
    {wait != null && <span>最长等待 {formatAge(wait)}</span>}
    {heartbeat != null && <span>{wait != null && ' · '}最久未更新的心跳 {formatAge(heartbeat / 1000)}前</span>}
  </>
}

function formatAge(seconds: number): string {
  if (seconds > 0 && seconds < 1) return '不足 1 秒'
  if (seconds < 60) return `${Math.floor(seconds)} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds / 60) % 60} 分`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '更新时间未知' : `更新于 ${date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

const titleStyle = { margin: 0, fontSize: FONT_PX.title, lineHeight: 1.3 } as const
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body } as const
const taskTitleStyle = { display: 'block', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  padding: 0, border: 0, background: 'transparent', color: COLOR.ink, fontSize: FONT_PX.body, fontWeight: 650,
  lineHeight: 1.5, textAlign: 'left' as const, cursor: 'pointer' }
const compactTitleStyle = { ...taskTitleStyle, display: '-webkit-box', whiteSpace: 'normal' as const,
  WebkitBoxOrient: 'vertical' as const, WebkitLineClamp: 2 }
const searchInputStyle = { minWidth: 0, width: 240, height: 38, padding: '0 11px', border: `1px solid ${COLOR.line}`, borderRadius: 7, color: COLOR.ink, fontSize: FONT_PX.body }
const buttonStyle = { minHeight: 38, padding: '0 14px', border: 0, borderRadius: 7, background: COLOR.ink, color: '#ffffff', fontSize: FONT_PX.menu, cursor: 'pointer' } as const
const quietButtonStyle = { minHeight: 36, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' } as const
const emptyStyle = { border: `1px dashed ${COLOR.line}`, borderRadius: 9, padding: 36, textAlign: 'center' as const, color: COLOR.inkMuted, fontSize: FONT_PX.body }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, borderRadius: 8, background: '#fff1f0', color: COLOR.danger, fontSize: FONT_PX.body } as const
const visuallyHidden = { position: 'absolute' as const, width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden' as const, clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' as const, border: 0 }
