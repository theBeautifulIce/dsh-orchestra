import { useEffect, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { ExecutionEntry } from '../../service/queries/execution-history.ts'
import { COLOR, FONT_PX } from './tokens.ts'

export function EventDetails({ entries }: { entries?: ExecutionEntry['details'] }) {
  if (!entries?.length) return null
  return <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(72px, max-content) minmax(0, 1fr)', gap: '4px 10px',
    margin: '8px 0 0', fontSize: FONT_PX.helper, overflowWrap: 'anywhere' }}>
    {entries.map(({ label, value }, index) => <div key={label + index} style={{ display: 'contents' }}>
      <dt style={{ color: COLOR.inkMuted }}>{label}</dt><dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{value}</dd>
    </div>)}
  </dl>
}

export function ExecutionHistory({ api, taskId, runId, nodeId, reloadVersion }: {
  api: ResourcesApi; taskId?: string; runId?: string; nodeId?: string; reloadVersion: number
}) {
  const [items, setItems] = useState<ExecutionEntry[]>()
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [retry, refresh] = useState(0)
  const [requested, setRequested] = useState<number>()
  const [category, setCategory] = useState('')
  const [pageGeneration, setPageGeneration] = useState(reloadVersion)
  const before = pageGeneration === reloadVersion ? requested : undefined
  useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    void api.listExecutionHistory({ task_id: taskId, run_id: runId, node_run_id: nodeId, before }).then(({ data }) => {
      if (!active) return
      setItems((previous) => before === undefined ? data.items : [...previous ?? [], ...data.items])
      setNext(data.next_before)
    }).catch(() => { if (active) setFailed(true) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api, taskId, runId, nodeId, before, retry, reloadVersion])

  const shown = items?.filter((item) => category === '' || (category === 'tool' ? item.type.includes('tool')
    : category === 'report' ? item.type.includes('report') || item.type === 'bridge.turn' : item.type.startsWith('executor.')))
  const latestReport = nodeId ? items?.find((item) => item.type === 'bridge.turn') : undefined
  const summary = latestReport?.details.find((detail) => detail.label === '报告摘要')?.value
  return <section aria-label="执行日志" style={{ display: 'grid', gap: 8 }}>
    <h4 style={{ fontSize: FONT_PX.section, margin: '4px 0' }}>执行日志</h4>
    {summary && <div style={{ background: COLOR.sidebar, border: `1px solid ${COLOR.line}`, borderRadius: 6, padding: '8px 10px' }}>
      <strong>智能体报告摘要</strong>
      <p style={{ margin: '5px 0 0', whiteSpace: 'pre-wrap' }}>{summary}</p>
    </div>}
    {!nodeId && <label>筛选已加载记录 <select value={category} onChange={(event) => setCategory(event.target.value)}>
      <option value="">全部</option><option value="tool">工具调用</option><option value="report">执行报告</option><option value="model">模型派发</option>
    </select></label>}
    {loading && <p role="status">正在读取执行日志…</p>}
    {failed && <p role="alert">执行日志读取失败。 <button type="button" onClick={() => refresh((value) => value + 1)}>重试</button></p>}
    {!failed && !loading && items?.length === 0 && <p>此范围内没有已保存的节点日志。</p>}
    {!failed && !loading && items?.length && shown?.length === 0 ? <p>已加载的记录没有符合筛选条件的事件。</p> : null}
    {shown?.length ? <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {shown.map((item, index) => <li key={item.id} style={{ padding: '9px 0', borderTop: `1px solid ${COLOR.line}` }}>
        <details open={nodeId && index < 3 ? true : undefined}>
          <summary><strong>{item.title}</strong> <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></summary>
          {!nodeId && <p style={{ margin: '4px 0', fontSize: FONT_PX.helper }}>节点 {item.node_id} · 运行 <code>{item.run_id}</code></p>}
          <EventDetails entries={item.details} />
          {item.details.length === 0 && <p style={{ margin: '4px 0', color: COLOR.inkMuted }}>账本已记录此事件的类型与时间。</p>}
        </details>
      </li>)}
    </ol> : null}
    {next !== null && !failed && <button type="button" disabled={loading} style={{ justifySelf: 'start' }}
      onClick={() => { setPageGeneration(reloadVersion); setRequested(next) }}>加载更早的日志</button>}
  </section>
}
