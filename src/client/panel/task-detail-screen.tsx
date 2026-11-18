import { useEffect, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { NodeRunView, RunSummary, TaskSummary } from '../api/types.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { UnknownState } from './shell.tsx'
import { unverifiedStatusView } from './tasks-screen.tsx'

export type TaskDetailScreenProps = {
  api: ResourcesApi
  taskId: string
  onBack: () => void
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
}
type DetailData = { task: TaskSummary; runs: RunSummary[]; nodes: NodeRunView[]; selectedRun: RunSummary | null }

/** 心跳超过这个秒数就提示「心跳已停 X 秒」；只影响显示，不改节点状态。 */
const HEARTBEAT_STALE_SECONDS = 30

/** 收口后的节点不再提示心跳：已结束的事实优先，状态文字保持原样。 */
const NODE_TERMINAL_STATUSES = new Set([
  'done', 'failed', 'timeout', 'abandoned_unverified', 'failed_with_unverified', 'orphaned', 'superseded',
])

export function TaskDetailScreen({ api, taskId, onBack, reloadVersion = 0, onSnapshot }: TaskDetailScreenProps) {
  const [data, setData] = useState<DetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let current = true
    setLoading(true)
    setFailed(false)
    void Promise.all([api.getTask(taskId), api.listRuns({ task_id: taskId, limit: 50 })]).then(async ([taskResult, runsResult]) => {
      const task = taskResult.data
      const runs = runsResult.data.items
      const selectedRun = runs.find((run) => run.run_id === task.current_run_id) ?? runs[0] ?? null
      const nodesResult = selectedRun ? await api.listNodes(selectedRun.run_id, 200) : null
      const nodes = nodesResult?.data.items ?? []
      onSnapshot?.(Math.max(taskResult.as_of_seq, runsResult.as_of_seq, nodesResult?.as_of_seq ?? 0))
      if (current) setData({ task, runs, nodes, selectedRun })
    }).catch(() => {
      if (current) setFailed(true)
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [api, taskId, reload, reloadVersion, onSnapshot])

  return <section aria-labelledby="task-detail-title" style={{ display: 'grid', gap: 20 }}>
    <button type="button" onClick={onBack} style={quietButtonStyle}>← 返回任务</button>
    {loading && <p role="status" style={mutedStyle}>正在读取任务详情…</p>}
    {failed && <div role="alert" style={errorStyle}><span>{COPY.queryFailed}</span><button type="button" onClick={() => setReload((n) => n + 1)} style={quietButtonStyle}>{COPY.retry}</button></div>}
    {!loading && !failed && data && <>
      <header>
        <p style={kickerStyle}>任务详情</p>
        <h1 id="task-detail-title" title={data.task.title} style={titleStyle}>{data.task.title || '未命名任务'}</h1>
        <p style={mutedStyle}>{data.task.display_status || data.task.status} · {data.runs.length} 次运行</p>
        {data.task.attention_reason && <p style={attentionStyle}>{data.task.attention_reason}</p>}
      </header>
      <section aria-labelledby="current-run-title" style={cardStyle}>
        <h2 id="current-run-title" style={sectionTitleStyle}>最近一次运行</h2>
        {!data.selectedRun && <p style={mutedStyle}>这项任务还没有运行记录。</p>}
        {data.selectedRun && <>
          <p style={mutedStyle}>
            <RunStatusLabel status={data.selectedRun.display_status} unverifiedCount={data.task.unverified_count} />
            {' · '}{data.selectedRun.total} 个执行步骤{data.selectedRun.settling ? ' · 正在收尾' : ''}
          </p>
          <PendingNotices task={data.task} />
          <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
            {data.nodes.map((node) => <NodeRow key={node.node_run_id} node={node} />)}
          </div>
          {data.nodes.length === 0 && <p style={mutedStyle}>当前运行没有执行步骤。</p>}
        </>}
      </section>
      <section aria-labelledby="runs-title" style={cardStyle}>
        <h2 id="runs-title" style={sectionTitleStyle}>运行记录</h2>
        {data.runs.length === 0 ? <p style={mutedStyle}>尚无运行记录。</p> : <ol style={{ margin: 0, paddingLeft: 22 }}>
          {data.runs.map((run) => <li key={run.run_id} style={{ padding: '7px 0', color: COLOR.inkMuted }}>
            {run.display_status} · {run.total} 个步骤 · {formatDate(run.created_at)}
          </li>)}
        </ol>}
      </section>
    </>}
  </section>
}

/** 未验证终态是独立状态：自己的中文文案与色板，不折叠进「已完成」或「未成功」。 */
function RunStatusLabel({ status, unverifiedCount }: { status: string; unverifiedCount: number }) {
  const unverified = unverifiedStatusView(status)
  if (!unverified) return <span>{status}</span>
  return <>
    <span style={{ color: unverified.tone }}>{unverified.label}</span>
    {unverifiedCount > 0 && <span style={{ color: unverified.tone, border: `1px solid ${unverified.tone}`, borderRadius: 999, padding: '0 6px', marginLeft: 6 }}>{unverifiedCount} {COPY.unverifiedBadge}</span>}
  </>
}

/** 待裁决与未结算动作同时说清：光说 blocked 让人以为没有要处理的事。 */
function PendingNotices({ task }: { task: TaskSummary }) {
  const parts: string[] = []
  if (task.open_decision_count > 0) parts.push(`${task.open_decision_count} 项${COPY.awaitingDecision}`)
  if (task.unverified_count > 0) parts.push(`${COPY.pendingIrreversible}（${task.unverified_count} ${COPY.unverifiedBadge}）`)
  if (parts.length === 0) return null
  return <p style={attentionStyle}>{parts.join(' · ')}</p>
}

function NodeRow({ node }: { node: NodeRunView }) {
  const heartbeat = heartbeatNotice(node)
  return <article style={nodeStyle}>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
      <strong title={node.node_id}>{node.node_id}</strong>
      <span>{node.status_label || <UnknownState value={node.status} />}</span>
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 8, color: COLOR.inkMuted, fontSize: FONT_PX.helper }}>
      <span>第 {node.attempt} 次尝试</span>
      {node.execution_count > 0 && <span>{node.execution_count} 条工具执行记录（未验证）</span>}
      {node.active_decision_ids.length > 0 && <span>{node.active_decision_ids.length} 项{COPY.awaitingDecision}</span>}
      {heartbeat && <span style={{ color: COLOR.warning }}>{heartbeat}</span>}
      {node.projection_missing.length > 0 && <span>部分信息暂不可用</span>}
    </div>
    {node.hang_reason && <p style={{ margin: '8px 0 0', fontSize: FONT_PX.body }}>{node.hang_reason}</p>}
  </article>
}

/** 心跳超阈值只加提示，不动节点状态：状态文字一个字不改。 */
function heartbeatNotice(node: NodeRunView): string | null {
  if (!node.heartbeat_at) return null
  if (NODE_TERMINAL_STATUSES.has(node.status)) return null
  const at = Date.parse(node.heartbeat_at)
  if (Number.isNaN(at)) return null
  const seconds = Math.floor((Date.now() - at) / 1000)
  if (seconds <= HEARTBEAT_STALE_SECONDS) return null
  return `${COPY.heartbeatStopped} ${seconds} 秒`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString()
}

const titleStyle = { margin: 0, fontSize: FONT_PX.title, overflowWrap: 'anywhere' as const }
const kickerStyle = { margin: '0 0 5px', color: COLOR.inkMuted, fontSize: FONT_PX.helper }
const sectionTitleStyle = { margin: '0 0 10px', fontSize: 16 }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
const attentionStyle = { padding: 12, borderRadius: 8, background: '#fff8e9', color: COLOR.warning, fontSize: FONT_PX.body }
const cardStyle = { minWidth: 0, padding: 18, border: `1px solid ${COLOR.line}`, borderRadius: 9, background: COLOR.surface }
const nodeStyle = { minWidth: 0, padding: 12, border: `1px solid ${COLOR.line}`, borderRadius: 7 }
const quietButtonStyle = { minHeight: 36, justifySelf: 'start' as const, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, borderRadius: 8, background: '#fff1f0', color: COLOR.danger, fontSize: FONT_PX.body } as const
