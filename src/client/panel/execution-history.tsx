import { useEffect, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { ExecutionEntry } from '../../service/queries/execution-history.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { operatorReason, operatorStatus } from '../../core/operator-language.ts'

const statusFields = new Set(['原状态', '新状态', '状态', '报告状态', '记录状态', '业务结果'])
const reasonFields = new Set(['原因', '错误代码', '处理结论'])
const plainFields = new Set(['工具', '退出码', '摘要', '报告摘要', '模型配置', '提供方', '实际模型', '文件名称', '节点数量',
  '计划时间', '计划触发时间', '开始时间', '完成时间', '尝试次数', 'Workflow 版本'])

function Fields({ entries }: { entries: ExecutionEntry['details'] }) {
  return <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(72px, max-content) minmax(0, 1fr)', gap: '4px 10px',
    margin: '8px 0 0', fontSize: FONT_PX.helper, overflowWrap: 'anywhere' }}>
    {entries.map(({ label, value }, index) => <div key={label + index} style={{ display: 'contents' }}>
      <dt style={{ color: COLOR.inkMuted }}>{label}</dt><dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{value}</dd>
    </div>)}
  </dl>
}

export function EventDetails({ entries }: { entries?: ExecutionEntry['details'] }) {
  if (!entries?.length) return null
  const readable = entries.flatMap(({ label, value }) => {
    if (statusFields.has(label)) return [{ label, value: operatorStatus(value) }]
    if (reasonFields.has(label)) return [{ label: label === '错误代码' ? '错误说明' : label, value: operatorReason(value) }]
    return plainFields.has(label) ? [{ label, value }] : []
  })
  return <>
    {readable.length > 0 && <Fields entries={readable} />}
    <details><summary>查看技术记录</summary><Fields entries={entries} /></details>
  </>
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
    {!nodeId && <label>筛选已加载记录 <select className="ops-field" value={category} onChange={(event) => setCategory(event.target.value)}>
      <option value="">全部</option><option value="tool">工具调用</option><option value="report">执行报告</option><option value="model">模型派发</option>
    </select></label>}
    {loading && <p role="status">正在读取执行日志…</p>}
    {failed && <p role="alert">执行日志读取失败。 <button type="button" className="ops-button" onClick={() => refresh((value) => value + 1)}>重试</button></p>}
    {!failed && !loading && items?.length === 0 && <p>此范围内没有已保存的节点日志。</p>}
    {!failed && !loading && items?.length && shown?.length === 0 ? <p>已加载的记录没有符合筛选条件的事件。</p> : null}
    {shown?.length ? <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {shown.map((item, index) => <li key={item.id} style={{ padding: '9px 0', borderTop: `1px solid ${COLOR.line}` }}>
        <details open={nodeId && index < 3 ? true : undefined}>
          <summary><strong>{item.title === item.type ? '其他执行记录' : item.title}</strong> <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></summary>
          <EventDetails entries={[...item.details, { label: '事件类型', value: item.type }, { label: '步骤 ID', value: item.node_id }, { label: '运行 ID', value: item.run_id }]} />
        </details>
      </li>)}
    </ol> : null}
    {next !== null && !failed && <button type="button" className="ops-button" disabled={loading} style={{ justifySelf: 'start' }}
      onClick={() => { setPageGeneration(reloadVersion); setRequested(next) }}>加载更早的日志</button>}
  </section>
}
