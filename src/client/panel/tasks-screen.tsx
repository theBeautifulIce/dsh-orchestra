import { useEffect, useState, type FormEvent } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { TaskSummary } from '../api/types.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { UnknownState } from './shell.tsx'

const ATTENTION_LABEL: Record<string, string> = {
  decision: '等你决定', unverified: '待核实', failed: '运行未成功', orphaned: '等待接手', running: '进行中', none: '无待处理事项',
}
const STATUS_LABEL: Record<string, string> = {
  reserved: '已接收', queued: '排队中', running: '进行中', waiting: '等待中', succeeded: '已完成', failed: '未成功', cancelled: '已取消',
}
const EFFECT_LABEL: Record<string, string> = { pure: '只读步骤', compensable: '可能需要补偿', irreversible: '涉及不可逆操作' }

export type TaskListScreenProps = {
  api: ResourcesApi
  onSelectTask: (taskId: string) => void
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
}

export function TaskListScreen({ api, onSelectTask, reloadVersion = 0, onSnapshot }: TaskListScreenProps) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState<string | undefined>()
  const [items, setItems] = useState<TaskSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(false)
    void api.listTasks({ limit: 50, cursor, query: query || undefined }).then((result) => {
      if (!current) return
      setItems((previous) => cursor ? [...previous, ...result.data.items] : result.data.items)
      setNextCursor(result.data.next_cursor)
      onSnapshot?.(result.as_of_seq)
    }).catch(() => {
      if (!current) return
      setError(true)
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [api, cursor, query, reload, reloadVersion, onSnapshot])

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCursor(undefined)
    const nextQuery = search.trim()
    if (nextQuery === query) setReload((n) => n + 1)
    setQuery(nextQuery)
  }

  function refresh() {
    setCursor(undefined)
    setReload((n) => n + 1)
  }

  const heading = query ? `“${query}”的任务` : '全部任务'
  return <section aria-labelledby="tasks-title" style={{ display: 'grid', gap: 20 }}>
    <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', justifyContent: 'space-between', gap: 16 }}>
      <div>
        <p style={kickerStyle}>工作区</p>
        <h1 id="tasks-title" style={titleStyle}>任务</h1>
        <p style={mutedStyle}>查看每项工作的进展、待处理事项和最近一次运行。</p>
      </div>
      <form onSubmit={submitSearch} style={{ display: 'flex', gap: 8 }} role="search">
        <label style={visuallyHidden} htmlFor="task-search">搜索任务</label>
        <input id="task-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索任务名称" style={searchInputStyle} />
        <button type="submit" style={buttonStyle}>搜索</button>
      </form>
    </header>

    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>{heading}</h2>
      <button type="button" onClick={refresh} disabled={loading} style={quietButtonStyle}>{loading ? '正在更新…' : '刷新'}</button>
    </div>

    {error && <div role="alert" style={errorStyle}>
      <span>{COPY.queryFailed}</span>
      <button type="button" onClick={refresh} style={quietButtonStyle}>{COPY.retry}</button>
    </div>}
    {loading && <p role="status" style={mutedStyle}>正在读取任务…</p>}
    {!loading && !error && items.length === 0 && <div style={emptyStyle}>{COPY.emptyTasks}</div>}
    {!error && items.length > 0 && <div style={{ display: 'grid', gap: 10 }}>
      {items.map((task) => <TaskRow key={task.task_id} task={task} onSelect={() => onSelectTask(task.task_id)} />)}
    </div>}
    {nextCursor && !error && <div style={{ display: 'flex', justifyContent: 'center' }}>
      <button type="button" disabled={loading} onClick={() => setCursor(nextCursor)} style={buttonStyle}>加载更多</button>
    </div>}
  </section>
}

function TaskRow({ task, onSelect }: { task: TaskSummary; onSelect: () => void }) {
  const attention = ATTENTION_LABEL[task.attention]
  const status = task.display_status !== task.status ? task.display_status : STATUS_LABEL[task.status]
  return <article style={rowStyle}>
    <button type="button" onClick={onSelect} title={task.title} style={taskTitleStyle}>{task.title || '未命名任务'}</button>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', color: COLOR.inkMuted, fontSize: FONT_PX.helper }}>
      <span>{status ?? <UnknownState value={task.status} />}</span>
      <span>{attention ? <strong style={{ color: task.attention === 'none' ? COLOR.inkMuted : COLOR.warning }}>{attention}</strong> : <UnknownState value={task.attention} />}</span>
      <span>{task.run_count} 次运行</span>
      {task.max_side_effect_level && <strong style={{ color: task.max_side_effect_level === 'irreversible' ? COLOR.danger : COLOR.inkMuted }}>
        {EFFECT_LABEL[task.max_side_effect_level] ?? <UnknownState value={task.max_side_effect_level} />}
      </strong>}
      {task.open_decision_count > 0 && <span>{task.open_decision_count} 项等你决定</span>}
      {task.unverified_count > 0 && <span>{task.unverified_count} 项待核实</span>}
      <time dateTime={task.updated_at}>{formatDate(task.updated_at)}</time>
    </div>
    {task.attention_reason && <p style={{ margin: '8px 0 0', fontSize: FONT_PX.body }}>{task.attention_reason}</p>}
  </article>
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '更新时间未知' : `更新于 ${date.toLocaleString()}`
}

const kickerStyle = { margin: '0 0 5px', color: COLOR.inkMuted, fontSize: FONT_PX.helper, letterSpacing: '.04em' } as const
const titleStyle = { margin: 0, fontSize: FONT_PX.title, lineHeight: 1.3 } as const
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body } as const
const rowStyle = { minWidth: 0, border: `1px solid ${COLOR.line}`, borderRadius: 9, padding: '16px 18px', background: COLOR.surface } as const
const taskTitleStyle = { display: 'block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, margin: '0 0 10px', padding: 0, border: 0, background: 'transparent', color: COLOR.link, font: `600 16px system-ui, sans-serif`, textAlign: 'left' as const, cursor: 'pointer' }
const searchInputStyle = { minWidth: 0, width: 240, height: 38, padding: '0 11px', border: `1px solid ${COLOR.line}`, borderRadius: 7, color: COLOR.ink, fontSize: FONT_PX.body }
const buttonStyle = { minHeight: 38, padding: '0 14px', border: 0, borderRadius: 7, background: COLOR.ink, color: '#ffffff', fontSize: FONT_PX.menu, cursor: 'pointer' } as const
const quietButtonStyle = { minHeight: 36, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' } as const
const emptyStyle = { border: `1px dashed ${COLOR.line}`, borderRadius: 9, padding: 36, textAlign: 'center' as const, color: COLOR.inkMuted, fontSize: FONT_PX.body }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, borderRadius: 8, background: '#fff1f0', color: COLOR.danger, fontSize: FONT_PX.body } as const
const visuallyHidden = { position: 'absolute' as const, width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden' as const, clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' as const, border: 0 }
