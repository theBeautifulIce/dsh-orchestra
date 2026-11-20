import { useEffect, useId, useRef, useState } from 'react'
import type { ActivityItem, ResourcesApi } from '../api/resources.ts'
import type { ExecutionEntry } from '../../service/queries/execution-history.ts'
import { activityTitle } from './activity-screen.tsx'
import { EventDetails } from './execution-history.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

type Scope = { taskId: string; runId?: never } | { runId: string; taskId?: never }
type Props = { api: ResourcesApi; scope: Scope; reloadVersion: number }
type Source = 'activity' | 'execution'
type Filter = 'all' | 'attention' | 'tool' | 'report' | 'model'
type Event = { id: number; time: string; title: string; type: string; context?: string; attention?: boolean; details: NonNullable<ActivityItem['details']> }
type Page = { key: string; events: Event[]; next: number | null }

const PAGE_SIZE = 5
const attentionOptions = [
  ['all', '全部记录'], ['attention', '异常与需留意'],
] as const
const executionOptions = [...attentionOptions, ['tool', '工具调用'], ['report', '执行报告'], ['model', '模型派发']] as const
const progressTitles: Record<string, string> = {
  'decision.acknowledged': '已查看审批', 'decision.blocked': '审批暂无法推进',
  'rework.plan_proposed': '已提出返工方案', 'rework.plan_approved': '已批准返工方案',
  'rework.authorization_deferred': '返工授权延后', 'rework.recovery_blocked': '返工恢复受阻',
  'rework.dispatch_blocked': '返工派发受阻', 'rework.dispatch_unblocked': '返工派发限制已解除',
}
const executionTitles: Record<string, string> = { lease_acquired: '已取得执行租约', fence_armed: '已记录停止请求' }
const statusTitles: Record<string, string> = {
  blocked_pre: '执行前已阻塞', blocked_post: '执行后待人工处理', indeterminate_side_effect: '副作用待核实',
  startup_unknown: '启动结果未知', paused_bridge_missing: '执行桥连接缺失', failed: '执行失败',
  timeout: '执行超时', orphaned: '执行会话已失联', failed_with_unverified: '执行失败，有影响待核实',
  succeeded_with_unverified: '运行已结束，有影响待核实', abandoned_unverified: '已停止，影响待核实',
  cancelled: '运行已取消', succeeded: '运行成功', done: '步骤完成', started: '步骤开始',
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' })
function eventTime(value: string) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? dateFormat.format(time) : '时间未记录'
}
function statusTitle(status: string | undefined) {
  return status && Object.hasOwn(statusTitles, status) ? statusTitles[status] : undefined
}

function ledgerEvent(row: ActivityItem): Event {
  const details = row.details ?? []
  const label = Object.hasOwn(progressTitles, row.type) ? progressTitles[row.type]! : activityTitle(row.type)
  const status = row.type === 'run.terminal' ? details.find((detail) => detail.label === '状态')?.value : undefined
  const outcome = details.find((detail) => detail.label === '业务结果')?.value
  const title = status === 'cancelled' && row.attention && statusTitle(outcome)
    ? `运行已取消 · ${statusTitle(outcome)}` : statusTitle(status) ?? (label === row.type ? '其他账本记录' : label)
  return { id: row.seq, title,
    type: row.type, time: row.occurred_at, attention: row.attention, details: [
      ...details,
      ...[row.run_id, row.node_run_id, row.decision_id].flatMap((value, index) =>
        value ? [{ label: ['运行 ID', '节点运行 ID', '审批 ID'][index]!, value }] : []),
    ] }
}

function executionEvent(row: ExecutionEntry): Event {
  const status = row.type === 'status_changed' ? row.details.find((detail) => detail.label === '新状态')?.value : undefined
  const exitCode = row.type === 'tool_finished' ? row.details.find((detail) => detail.label === '退出码')?.value : undefined
  const label = Object.hasOwn(executionTitles, row.type) ? executionTitles[row.type] : row.title
  const title = statusTitle(status) ?? (row.attention && exitCode !== undefined
    ? `工具调用结束（退出码 ${exitCode}）` : label && label !== row.type ? label : '其他执行记录')
  return { id: row.id, title, type: row.type, time: row.created_at, attention: row.attention, context: row.node_id, details: [
    ...row.details, { label: '运行 ID', value: row.run_id }, { label: '节点运行 ID', value: row.node_run_id },
  ] }
}

function requireFilter<T extends { attention?: boolean }>(items: T[], filter: Filter) {
  if (filter !== 'all' && items.some(({ attention }) => attention === undefined || (filter === 'attention' && !attention))) {
    throw new Error('Host did not confirm the event filter')
  }
  return items
}

export function TaskEventTimeline(props: Props) {
  const { taskId, runId } = props.scope
  return <Timeline key={taskId ? `task:${taskId}` : `run:${runId}`} {...props} />
}

function Timeline({ api, scope, reloadVersion }: Props) {
  const heading = useId()
  const pageHeading = useRef<HTMLParagraphElement>(null)
  const head = useRef<Page>(undefined)
  const [source, setSource] = useState<Source>('activity')
  const [filter, setFilter] = useState<Filter>('all')
  const [trail, setTrail] = useState<{ headVersion?: number; cursors: number[] }>({ cursors: [] })
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [refresh, setRefresh] = useState(0)
  const [retry, setRetry] = useState(0)
  const [page, setPage] = useState<Page>()
  const [failed, setFailed] = useState<string>()
  const [latestAttention, setLatestAttention] = useState<{ key: string; event?: Event }>()
  const { runId, taskId } = scope
  const { cursors } = trail
  const before = cursors.at(-1)
  const pageVersion = trail.headVersion ?? reloadVersion
  const requestKey = JSON.stringify([source, filter, before, pageVersion, refresh])
  const current = page?.key === requestKey ? page : undefined
  const loadFailed = !current && failed === requestKey
  const loading = !current && !loadFailed
  const attentionKey = JSON.stringify([pageVersion, refresh])
  const attention = latestAttention?.key === attentionKey ? latestAttention.event : undefined

  useEffect(() => {
    let active = true
    if (before === undefined && head.current?.key === requestKey) {
      setPage(head.current)
      return
    }
    const reqScope = { run_id: runId, task_id: taskId, limit: PAGE_SIZE }
    const load = source === 'activity'
      ? api.listActivity({ ...reqScope, before_seq: before, filter: filter === 'attention' ? filter : 'all' }).then(({ data }) =>
        ({ events: requireFilter(data.items, filter).map(ledgerEvent), next: data.next_before_seq }))
      : api.listExecutionHistory({ ...reqScope, before, filter }).then(({ data }) =>
        ({ events: requireFilter(data.items, filter).map(executionEvent), next: data.next_before }))
    void load.then((result) => {
      if (!active) return
      const loaded = { key: requestKey, ...result }
      if (before === undefined) head.current = loaded
      setPage(loaded)
    }).catch(() => { if (active) setFailed(requestKey) })
    return () => { active = false }
  }, [api, before, filter, requestKey, retry, runId, source, taskId])

  useEffect(() => {
    if (source !== 'activity') return
    let active = true
    void api.listExecutionHistory({ run_id: runId, task_id: taskId, limit: 1, filter: 'attention' }).then(({ data }) => {
      if (active) {
        const newest = data.items[0]
        setLatestAttention({ key: attentionKey, event: newest?.attention === true ? executionEvent(newest) : undefined })
      }
    }).catch(() => { if (active) setLatestAttention({ key: attentionKey }) })
    return () => { active = false }
  }, [api, attentionKey, runId, source, taskId])

  function move(next: number[]) {
    // Keep the same first page while paging back and forth, even when fresh events arrive.
    setTrail({ headVersion: pageVersion, cursors: next })
    pageHeading.current?.focus()
  }
  function reset() {
    head.current = undefined
    setTrail({ cursors: [] })
    setExpanded(new Set())
    setRefresh((value) => value + 1)
  }
  function show(nextSource: Source, nextFilter: Filter) {
    if (nextSource === source && nextFilter === filter) return
    setSource(nextSource)
    setFilter(nextFilter)
    reset()
  }
  function toggle(id: number, open: boolean) {
    setExpanded((previous) => {
      if (previous.has(id) === open) return previous
      const next = new Set(previous)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  }

  return <section className="ops-surface" aria-labelledby={heading} style={surface}>
    <header style={header}>
      <div>
        <h3 id={heading} style={title}>{taskId ? '任务事件' : '运行事件'}</h3>
        <p className="ops-meta" style={caption}>最新入账在前，每页最多 {PAGE_SIZE} 条。展开记录可查看技术详情。</p>
      </div>
      <button type="button" className="ops-button" onClick={reset}>刷新到最新</button>
    </header>
    <div style={toolbar}>
      <div style={toolbar} role="group" aria-label="事件来源">
        <button type="button" className={source === 'activity' ? 'ops-button ops-button--primary' : 'ops-button'}
          aria-pressed={source === 'activity'} onClick={() => show('activity', 'all')}>近期进展</button>
        <button type="button" className={source === 'execution' ? 'ops-button ops-button--primary' : 'ops-button'}
          aria-pressed={source === 'execution'} onClick={() => show('execution', 'all')}>执行明细</button>
      </div>
      <label style={toolbar}>筛选
        <select className="ops-field" value={filter} onChange={(event) => show(source, event.target.value as Filter)}>
          {(source === 'activity' ? attentionOptions : executionOptions).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
    </div>
    {source === 'activity' && attention && <aside style={notice} aria-label="最近记录的执行异常">
      <div><strong>最近记录的执行异常</strong><p style={caption}>{attention.title} · {eventTime(attention.time)}</p></div>
      <button type="button" className="ops-button" onClick={() => show('execution', 'attention')}>查看执行异常</button>
    </aside>}
    <p role="status" ref={pageHeading} tabIndex={-1} className="ops-meta" style={caption}>
      第 {cursors.length + 1} 页{loading ? ' · 正在读取…' : current ? ` · ${current.events.length} 条` : ''}
    </p>
    {loadFailed && <p role="alert" style={caption}>事件读取失败。 <button type="button" className="ops-button"
      onClick={() => { setFailed(undefined); setRetry((value) => value + 1) }}>重试本页</button></p>}
    {current?.events.length === 0 && <p className="ops-meta" style={caption}>
      {filter === 'all' ? '这个范围暂无已记录事件。' : '这个范围没有符合筛选的记录。'}
    </p>}
    {!!current?.events.length && <ol role="list" style={list}>
      {current.events.map((event) => <li key={event.id} style={row}>
        <details open={expanded.has(event.id)} onToggle={(change) => toggle(event.id, change.currentTarget.open)}>
          <summary style={summary}>
            <span style={eventHeader}>
              <span style={eventTitle}>
                <strong>{event.title}</strong>
                {event.attention && <span style={badge}>需留意</span>}
                {event.context && <span className="ops-meta">步骤 {event.context}</span>}
              </span>
              <time className="ops-meta" dateTime={event.time} style={timestamp}>{eventTime(event.time)}</time>
            </span>
          </summary>
          <EventDetails entries={[{ label: '事件类型', value: event.type }, { label: '账本位置', value: String(event.id) }, ...event.details]} />
        </details>
      </li>)}
    </ol>}
    {(cursors.length > 0 || current?.next != null) && <nav aria-label="事件分页" style={toolbar}>
      <button type="button" className="ops-button" disabled={cursors.length === 0} onClick={() => move(cursors.slice(0, -1))}>较新一页</button>
      <button type="button" className="ops-button" disabled={current?.next == null}
        onClick={() => { if (current?.next != null) move([...cursors, current.next]) }}>较早一页</button>
    </nav>}
  </section>
}

const surface = { display: 'grid', gap: 10, padding: 14 }
const header = { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' } as const
const title = { margin: 0, fontSize: FONT_PX.section }
const caption = { margin: '3px 0' }
const toolbar = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as const
const notice = { ...header, background: COLOR.sidebar, border: `1px solid ${COLOR.line}`, borderInlineStart: `3px solid ${COLOR.warning}`, borderRadius: 6, padding: 8 }
const list = { display: 'grid', listStyle: 'none', padding: 0, margin: 0, border: `1px solid ${COLOR.line}`, borderRadius: 8 } as const
const row = { display: 'grid', minWidth: 0, gap: 4, padding: '8px 11px', borderBottom: `1px solid ${COLOR.line}`, overflowWrap: 'anywhere' } as const
const summary = { cursor: 'pointer', paddingBlock: 3 }
const eventHeader = { display: 'inline-flex', width: 'calc(100% - 20px)', verticalAlign: 'middle', justifyContent: 'space-between',
  alignItems: 'baseline', flexWrap: 'wrap', gap: '3px 8px' } as const
const eventTitle = { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '3px 7px' } as const
const timestamp = { fontVariantNumeric: 'tabular-nums' }
const badge = { fontSize: FONT_PX.helper, color: COLOR.warning, padding: '1px 5px', border: `1px solid ${COLOR.warning}`, borderRadius: 4 }
