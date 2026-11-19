import { useEffect, useState } from 'react'
import type { ActivityItem, ResourcesApi } from '../api/resources.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { EventDetails } from './execution-history.tsx'

const LABELS: Readonly<Record<string, string>> = {
  'task.created': '创建任务', 'task.reserved': '预留任务', 'task.archived': '归档任务', 'task.restored': '取回任务',
  'run.created': '创建运行', 'run.closed': '结束运行', 'decision.created': '创建审批', 'decision.resolved': '记录审批结果',
  'artifact.registered': '登记交付产物',
  'task_plan.proposed': '生成待确认任务计划',
  'workflow.draft_tested': '完成 Workflow 快速测试', 'workflow.published': '发布 Workflow 版本',
  'workflow.status_changed': '变更 Workflow 启用状态',
  'run.terminal': '结束运行', 'task.run_started': '任务启动运行', 'task.trigger_created': '配置任务触发器',
  'task.trigger_enabled': '启用任务触发器', 'task.trigger_paused': '暂停任务触发器',
  'task.trigger_fired': '触发任务运行', 'task.trigger_skipped': '跳过这次触发',
  'effect.resolved': '核实外部操作', 'memory.apply.outcome_unknown': '记忆写入结果待核对',
  'executor.model_selected': '选定执行模型', 'executor.model_confirmed': '宿主确认执行模型', 'executor.model_rejected': '宿主未确认指定模型',
  'executor.model_used': '记录实际执行模型',
  'model_routing.updated': '更新模型分配',
  'collaboration.finding_reported': '提交核验发现',
  'collaboration.proposed': '请求独立核验',
  'collaboration.authorized': '授权独立核验',
  'collaboration.delivered': '核验请求已送达',
  'collaboration.accepted': '接收方已接手',
  'collaboration.completed': '独立核验完成',
  'collaboration.adopted': '主理人采纳核验结论',
}

export function ActivityScreen({ api, reloadVersion, onSnapshot }: { api: ResourcesApi; reloadVersion: number; onSnapshot: (seq: number) => void }) {
  return <section aria-labelledby="activity-title" className="ops-page">
    <header className="ops-page-header"><h1 id="activity-title">事件日志</h1></header>
    <ActivityList api={api} reloadVersion={reloadVersion} onSnapshot={onSnapshot} />
  </section>
}

export function ActivityList({ api, runId, taskId, reloadVersion, onSnapshot, compact = false }: {
  api: ResourcesApi; runId?: string; taskId?: string; reloadVersion: number; onSnapshot?: (seq: number) => void; compact?: boolean
}) {
  const [items, setItems] = useState<ActivityItem[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [before, setBefore] = useState<number>()
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setBefore(undefined) }, [reloadVersion])
  useEffect(() => {
    let current = true
    setLoading(true)
    setFailed(false)
    void api.listActivity({ before_seq: before, run_id: runId, task_id: taskId, limit: compact ? 5 : undefined }).then(({ data, as_of_seq }) => {
      if (!current) return
      setItems((previous) => before === undefined ? data.items : [...previous, ...data.items.filter((entry) => !previous.some((old) => old.seq === entry.seq))])
      setNext(data.next_before_seq)
      onSnapshot?.(as_of_seq)
    }).catch(() => { if (current) setFailed(true) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, before, runId, taskId, retry, reloadVersion, onSnapshot, compact])
  return <section aria-label="账本活动" style={{ display: 'grid', gap: 9 }}>
    {loading && <p role="status" style={muted}>正在读取活动…</p>}
    {failed && <p role="alert">活动记录读取失败。 <button type="button" onClick={() => { setBefore(undefined); setRetry((value) => value + 1) }}>重试</button></p>}
    {!loading && !failed && items.length === 0 && <p style={muted}>当前没有活动记录。</p>}
    {items.length > 0 && <ol style={timeline}>{items.map((event) => <li key={event.seq} style={row}>
      <div><strong>{LABELS[event.type] ?? event.type}</strong><p style={muted}>
        {[event.run_id, event.node_run_id, event.decision_id].filter(Boolean).join(' · ') || `事件 #${event.seq}`}</p>
        {!compact && <EventDetails entries={event.details} />}</div>
      <time dateTime={event.occurred_at} style={muted}>{new Date(event.occurred_at).toLocaleString()}</time>
    </li>)}</ol>}
    {!compact && next !== null && !failed && <button type="button" disabled={loading} onClick={() => setBefore(next)} style={{ justifySelf: 'start' }}>加载更早活动</button>}
  </section>
}

const muted = { color: COLOR.inkMuted, fontSize: FONT_PX.helper, margin: '4px 0' }
const timeline = { display: 'grid', gap: 0, padding: 0, margin: 0, listStyle: 'none', border: `1px solid ${COLOR.line}`, borderRadius: 8, background: COLOR.surface } as const
const row = { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, padding: '7px 11px', borderBottom: `1px solid ${COLOR.line}`, overflowWrap: 'anywhere', minWidth: 0 } as const
