import { useEffect, useState, type CSSProperties } from 'react'
import { ApiError } from '../api/client.ts'
import { usePanelCommandsEnabled } from './shell.tsx'
import type { ResourcesApi } from '../api/resources.ts'
import type { ReworkApi, ReworkScope, ReworkPlan, ReviewHold, ReworkItem, ReworkDetail } from '../api/rework.ts'
import type { NodeRunView, RunArtifact } from '../api/types.ts'
import type { ReworkInspection } from '../../service/rework-inspection.ts'
import { ArtifactContent, artifactContentKey, matchesArtifactContent, useArtifactRetention } from './artifact-content.tsx'
import { COLOR, FONT_PX } from './tokens.ts'
import { operatorReason, operatorStatus } from '../../core/operator-language.ts'
import { nodeExecutionLabel } from './task-node-status.ts'

const labels: Record<string, string> = { proposed: '等待授权', evaluating: '正在评估', needs_human_approval: '等待人工授权', authorized: '已授权', scheduled: '等待返工', executing: '正在返工', awaiting_review: '等待重新验收', accepted: '验收通过', closed: '已完成', declined: '未批准', escalated: '等待人工处理', cancelled: '已取消' }
const scopes: Record<string, string> = { targeted_revision: '针对性修改', rerun_node: '重新执行当前节点', replan_subgraph: '局部重规划' }

// 运行已到终态时再提交修改只会得到 STALE_GENERATION：先把入口关掉并说明下一步（D10）。
const RUN_ENDED = new Set(['succeeded', 'succeeded_with_unverified', 'failed', 'failed_with_unverified', 'orphaned', 'cancelled'])
export function ReworkPanel({ api, commands, runId, runStatus, reloadVersion = 0, plannerEnabled = false, onSnapshot, compact = false }: {
  api: ResourcesApi; commands?: ReworkApi; runId?: string; runStatus?: string | null; reloadVersion?: number; plannerEnabled?: boolean
  onSnapshot?: (seq: number) => void; compact?: boolean
}) {
  const [items, setItems] = useState<ReworkItem[]>([])
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    setLoading(true); setFailed(false)
    void api.listRework(runId).then(({ data, as_of_seq }) => { if (current) { setItems(data.items); onSnapshot?.(as_of_seq) } })
      .catch(() => { if (current) setFailed(true) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, runId, reloadVersion, retry, onSnapshot])
  return <section aria-label="成果审核与返工" style={box}>
    <h2 style={{ fontSize: FONT_PX.section, margin: '0 0 8px' }}>成果审核与返工</h2>
    {loading && <p role="status">正在读取返工记录…</p>}
    {failed && <p role="alert">返工记录读取失败。<button type="button" onClick={() => setRetry(n => n + 1)}>重试</button></p>}
    {!loading && !failed && items.length === 0 && <p>暂无返工记录。</p>}
    {items.filter(item => !runId || item.run_id === runId).map(item => compact ? <p key={item.request_id}>{labels[item.status] ?? operatorStatus(item.status)} · 第 {item.round_no} 轮 · {item.reason}</p>
      : <ReworkCard key={item.request_id + ':' + item.revision} api={api} item={item} commands={commands} plannerEnabled={plannerEnabled} onChanged={() => setRetry(n => n + 1)} />)}
    {runId && commands && !compact && <ReworkRequestForm key={runId} api={api} runId={runId} commands={commands}
      plannerEnabled={plannerEnabled} runEnded={Boolean(runStatus && RUN_ENDED.has(runStatus))}
      onChanged={() => setRetry(n => n + 1)} />}
  </section>
}

function errorText(error: unknown): string {
  return error instanceof Error ? operatorReason(error.message) : '操作未完成'
}

function artifactVersionLabel(artifact: RunArtifact, index: number): string {
  return `${artifact.file_name || '未命名产物'} · 登记记录 ${index + 1} · ${new Date(artifact.created_at).toLocaleString()}`
}

function receiptStatus(status: string): string {
  if (status === 'applied') return '操作已生效'
  if (status === 'received') return '已收件，等待处理'
  return operatorStatus(status)
}

type Comparison = {
  key: string
  pending?: boolean
  result?: { before: string; after: string; truncated: boolean }
  notice?: string
}

function ReworkCard({ api, item, commands, plannerEnabled, onChanged }: {
  api: ResourcesApi; item: ReworkItem; commands?: ReworkApi; plannerEnabled: boolean; onChanged: () => void
}) {
  const canWrite = usePanelCommandsEnabled(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [unknownOperation, setUnknownOperation] = useState<string>()
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([])
  const [history, setHistory] = useState<ReworkDetail>()
  const [plan, setPlan] = useState<ReworkPlan | null>(null)
  const [terminationConfirm, setTerminationConfirm] = useState(false)
  useEffect(() => {
    let live = true
    void api.listRunArtifacts(item.run_id).then(({ data }) => { if (live) setArtifacts(data.items) }).catch(() => { if (live) setNotice('成果列表读取失败，可刷新后重试') })
    void api.getRework(item.request_id).then(({ data }) => { if (live) setHistory(data.item) }).catch(() => { if (live) setNotice('审核历史读取失败，可刷新后重试') })
    if (plannerEnabled && commands) void commands.getPlan(item.request_id).then(({ data }) => { if (live) setPlan(data.plan) }).catch(() => {})
    return () => { live = false }
  }, [api, item.request_id, item.run_id, commands, plannerEnabled])
  const old = artifacts.find(a => a.run_id === item.run_id && a.artifact_id === item.source_artifact_id && a.sha256 === item.source_artifact_hash)
  const currentAttempt = history?.attempts.find(a => a.round_no === item.round_no)
  const review = item.status === 'awaiting_review'
  const candidates = review && !history ? [] : artifacts.filter(a =>
    a.run_id === item.run_id && a.source_node_run_id === item.new_node_run_id
    && (!currentAttempt?.result_artifact_id || (a.artifact_id === currentAttempt.result_artifact_id && a.sha256 === currentAttempt.result_artifact_hash)))
  const [selected, setSelected] = useState('')
  const revised = candidates.find(a => a.artifact_id === selected) ?? candidates[0]
  const oldRetention = useArtifactRetention(old)
  const revisedRetention = useArtifactRetention(revised)
  const left = old && oldRetention === 'available' && old.file_name ? old : undefined
  const right = revised && revisedRetention === 'available' && revised.file_name ? revised : undefined
  const comparisonKey = JSON.stringify([left && artifactContentKey(left), right && artifactContentKey(right)])
  const [comparison, setComparison] = useState<Comparison>({ key: comparisonKey })
  if (comparison.key !== comparisonKey) setComparison({ key: comparisonKey })
  const interactionBusy = busy || comparison.pending
  async function act(action: 'authorize' | 'reject' | 'reject_final' | 'accept' | 'request_changes' | 'escalate') {
    if (!canWrite || !commands) return
    setBusy(true); setNotice('')
    try {
      await commands.review({ request_id: item.request_id, expected_revision: item.revision, action, note: note.trim() || '人工验收通过',
        ...(revised ? { artifact_id: revised.artifact_id, artifact_hash: revised.sha256 } : {}) })
      setNotice(action==='reject_final'?'已记录终止请求；未确认的执行和副作用继续按原协议核实。':'已记录处理结果'); onChanged()
    } catch (error) {
      setNotice(errorText(error))
      if (error instanceof ApiError && error.code === 'OPERATION_OUTCOME_UNKNOWN') setUnknownOperation((error.details as { operation_id: string }).operation_id)
    } finally { setBusy(false) }
  }
  async function planAction(approve = false) {
    if (!canWrite || !commands) return
    setBusy(true)
    try {
      if (approve && plan) await commands.approvePlan({ request_id: item.request_id, expected_revision: item.revision, plan_hash: plan.plan_hash })
      else await commands.plan({ request_id: item.request_id, expected_revision: item.revision })
      setPlan((await commands.getPlan(item.request_id)).data.plan); onChanged()
    } catch (error) { setNotice(errorText(error)); if (error instanceof ApiError && error.code === 'OPERATION_OUTCOME_UNKNOWN') setUnknownOperation((error.details as { operation_id: string }).operation_id) }
    finally { setBusy(false) }
  }
  async function compare() {
    if (!left || !right) return
    // Returning to the same pair must not reactivate its earlier request.
    const reading = { key: comparisonKey, pending: true }
    setComparison(reading)
    try {
      const [{ data: before }, { data: after }] = await Promise.all([
        api.getArtifactContent(left.run_id, left.artifact_id, 'preview'),
        api.getArtifactContent(right.run_id, right.artifact_id, 'preview'),
      ])
      if (before.kind !== 'preview' || after.kind !== 'preview'
        || !matchesArtifactContent(before, left) || !matchesArtifactContent(after, right)) throw new Error('成果版本已变化，请刷新')
      const result = { before: before.text, after: after.text, truncated: before.truncated || after.truncated }
      setComparison(current => current === reading ? { key: comparisonKey, result } : current)
    } catch (error) {
      setComparison(current => current === reading ? { key: comparisonKey, notice: errorText(error) } : current)
    }
  }
  const pending = ['proposed', 'needs_human_approval'].includes(item.status)
  const escalated = item.status === 'escalated'
  const mayDecline = (pending || escalated) && history?.attempts.length === 0
  return <article style={box} aria-label={`第 ${item.round_no} 轮返工`}>
    <h3>{labels[item.status] ?? operatorStatus(item.status)} · 第 {item.round_no} / {item.max_rounds} 轮</h3>
    <p>原步骤的第 {item.target_attempt} 次尝试{old?.file_name && <> · {old.file_name}</>}</p>
    <p>{item.reason}</p><p>期望结果：{item.expected_result}</p>
    <p>范围：{scopes[item.suggested_scope] ?? '范围未确认'}</p>
    {history?.dispatch_blocks?.filter(block => !block.resolved_at).map(block =>
      <section key={block.node_run_id} aria-label="自动派发受阻">
        <h4>{block.node_id} 的自动派发已暂停</h4>
        <p>{operatorReason(block.message || block.reason)}</p>
        <details><summary>查看暂停记录</summary><p>原因代码 <code>{block.reason}</code></p></details>
      </section>
    )}
    <details><summary>修改前后成果与版本</summary>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
        <section><h4>修改前</h4><p>{old?.file_name ?? '原成果记录'}</p>{old && <ArtifactContent api={api} artifact={old} />}</section>
        <section><h4>修订成果</h4>{candidates.length > 1 && <label>选择修订成果<select value={revised?.artifact_id ?? ''} onChange={e => setSelected(e.target.value)}>{candidates.map((a, index) => <option key={a.artifact_id} value={a.artifact_id}>{artifactVersionLabel(a, index)}</option>)}</select></label>}
          {revised ? <><p>{revised.file_name || '未命名产物'}</p><ArtifactContent api={api} artifact={revised} /></> : <p>尚无修订成果。</p>}</section>
      </div><p>请核对选中的修订文件。本次验收会对应这一份文件。</p>
      <details><summary>查看成果版本记录</summary>
        <p>原成果编号 <code>{item.source_artifact_id}</code> · SHA-256 <code>{item.source_artifact_hash}</code></p>
        {revised && <p>修订成果编号 <code>{revised.artifact_id}</code> · SHA-256 <code>{revised.sha256}</code></p>}
      </details>
      <button type="button" disabled={interactionBusy || !left || !right} onClick={() => void compare()}>逐行对比修改</button>
      {comparison.key === comparisonKey && comparison.notice && <p role="status">{comparison.notice}</p>}
      {left && right && comparison.key === comparisonKey && comparison.result && <>{comparison.result.truncated && <p>仅对比内容预览，完整成果请分别下载核对。</p>}<LineComparison before={comparison.result.before} after={comparison.result.after} /></>}
    </details>
    {history?.impacts && history.impacts.length > 0 && <section><h4>受影响步骤</h4><ul>{history.impacts.map(i => <li key={i.node_run_id}>{i.node_id} · {i.released_at ? '已恢复' : '等待返工或验收'}{i.replacement_node_run_id && ' · 已有后续执行'}</li>)}</ul></section>}
    <details><summary>返工与验收历史</summary>{history ? <><ol>{history.attempts.map(a => <li key={a.attempt_id}>第 {a.round_no} 轮 · {labels[a.status] ?? a.status}<p>{a.feedback}</p><p>{a.source_artifact_id} → {a.result_artifact_id ?? '等待修订成果'}</p><p>{a.created_at}</p></li>)}</ol><ol>{history.reviews.map(r => <li key={r.review_id}>第 {r.round_no} 轮 · {r.reviewer_actor} · {r.action === 'accept' ? '验收通过' : r.action === 'request_changes' ? '要求修改' : r.action === 'authorize' ? '授权返工' : r.action === 'reject' ? '不批准' : '升级处理'}<p>{r.note}</p>{r.artifact_id && <p>验收版本 {r.artifact_id} · {r.artifact_hash}</p>}<p>{r.created_at}</p></li>)}</ol></> : <p>尚未读取历史。</p>}</details>
    {commands && (pending || review || escalated) && <fieldset disabled={!canWrite || interactionBusy || Boolean(unknownOperation)} style={{ border: 0, padding: 0 }}>
      <label style={field}>具体修改意见或处理说明<textarea value={note} onChange={e => setNote(e.target.value)} rows={3} /></label>
      <div style={actions}>{pending && <button type="button" disabled={!note.trim() || item.suggested_scope === 'replan_subgraph'} onClick={() => void act('authorize')}>授权返工</button>}
        {review && <><button type="button" disabled={!revised || !note.trim()} onClick={() => void act('accept')}>通过验收</button><button type="button" disabled={!note.trim()} onClick={() => void act('request_changes')}>要求修改</button></>}
        {!escalated && <button type="button" disabled={!note.trim()} onClick={() => void act('escalate')}>升级处理</button>}{mayDecline && <button type="button" disabled={!note.trim()} onClick={() => void act('reject')}>不批准返工</button>}
        <button type="button" disabled={!note.trim()} onClick={()=>setTerminationConfirm(true)}>终止本次运行</button></div>
      {terminationConfirm && <div role="group" aria-label="确认终止运行"><p>此操作终止整个当前运行，并保留全部成果及未确认副作用。确定继续？</p><button type="button" disabled={!note.trim()} onClick={()=>void act('reject_final')}>确认终止运行</button><button type="button" onClick={()=>setTerminationConfirm(false)}>继续审核</button></div>}
      {escalated && <p>此反馈等待人工处理。未启动返工可不批准；已执行的返工保留依赖保护，可明确终止当前运行。</p>}
      {plannerEnabled && pending && <button type="button" onClick={() => void planAction()}>请主脑提出局部方案</button>}
      {plan && <section>
        <h4>主脑候选方案</h4><p>{plan.proposal.reason}</p>
        <ul>{plan.proposal.changes.map(c => <li key={c.node_id}>{c.node_id}：{c.instruction}</li>)}</ul>
        <p>保留节点：{plan.proposal.preserved_node_ids.join('、') || '无'}</p>
        {Boolean(plan.proposal.additional_edges?.length) && <div>新增执行依赖<ul>{plan.proposal.additional_edges?.map(e =>
          <li key={e.from + '/' + e.to}>{e.from} 完成后执行 {e.to}</li>)}</ul></div>}
        {Boolean(plan.proposal.insert_steps?.length) && <section aria-label="候选新增步骤"><h4>新增步骤（授权后执行）</h4><ul>{plan.proposal.insert_steps?.map(step => <li key={step.node_id}>{step.node_id} · 插入 {step.before_node_id} 之前 · 来源角色：{step.before_node_id}<p>{step.instruction}</p></li>)}</ul></section>}
        <details><summary>查看方案版本记录</summary><code style={hash}>{plan.plan_hash}</code></details>
        <button type="button" disabled={plan.revision !== item.revision} onClick={() => void planAction(true)}>授权此方案</button>
      </section>}
    </fieldset>}
    {notice && <p role="status">{notice}</p>}
    <details><summary>查看返工登记明细</summary><p>请求编号 <code>{item.request_id}</code> · 原步骤尝试编号 <code>{item.target_node_run_id}</code> · 提出方 <code>{item.requester_actor}</code></p>
      {unknownOperation && <p>回执编号 <code>{unknownOperation}</code></p>}
    </details>
    {unknownOperation && commands && <button type="button" disabled={interactionBusy} onClick={async () => { setBusy(true); try { const { data } = await commands.getOperation(unknownOperation); setNotice(`回执状态：${receiptStatus(data.status)}`); if (data.status === 'applied') { setUnknownOperation(undefined); onChanged() } } catch (e) { setNotice(errorText(e)) } finally { setBusy(false) } }}>查询原操作回执</button>}
  </article>
}

function ReworkRequestForm({ api, commands, runId, onChanged, plannerEnabled, runEnded = false }: {
  api: ResourcesApi; commands: ReworkApi; runId: string; onChanged: () => void; plannerEnabled: boolean; runEnded?: boolean
}) {
  const canWrite = usePanelCommandsEnabled(true)
  const [nodes, setNodes] = useState<NodeRunView[]>([])
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([])
  const [holds, setHolds] = useState<ReviewHold[]>([])
  const [refresh, setRefresh] = useState(0)
  const [nodeId, setNodeId] = useState('')
  const [artifactId, setArtifactId] = useState('')
  const [reason, setReason] = useState('')
  const [expected, setExpected] = useState('')
  const [preserve, setPreserve] = useState('')
  const [scope, setScope] = useState<ReworkScope>('targeted_revision')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [unknownOperation, setUnknownOperation] = useState<string>()
  const [inspectionCriteria, setInspectionCriteria] = useState('')
  const [inspections, setInspections] = useState<ReworkInspection[]>([])
  useEffect(() => {
    let live = true
    void Promise.all([api.listNodes(runId, 200), api.listRunArtifacts(runId), commands.listHolds(runId)]).then(([n, a, h]) => { if (live) { setNodes(n.data.items.filter(node => node.node_type === 'agent' && !node.replacement_node_run_id)); setArtifacts(a.data.items); setHolds(h.data.items) } }).catch(e => { if (live) setNotice(errorText(e)) })
    if (plannerEnabled) void commands.listInspections(runId).then(({data})=>{if(live)setInspections(data.items ?? [])}).catch(e=>{if(live)setNotice(errorText(e))})
    return () => { live = false }
  }, [api, commands, runId, refresh, plannerEnabled])
  const node = nodes.find(n => n.node_run_id === nodeId)
  const artifact = artifacts.find(a => a.artifact_id === artifactId && a.source_node_run_id === nodeId)
  const held = holds.some(h => h.node_id === node?.node_id && h.status === 'held')
  async function inspect() {
    if (!canWrite || !node || !artifact) return
    setBusy(true); setNotice('')
    try {
      const result = await commands.inspect({run_id:runId,target_node_run_id:node.node_run_id,source_artifact_id:artifact.artifact_id,source_artifact_hash:artifact.sha256,expected_revision:node.revision,criteria:inspectionCriteria.trim()})
      setNotice((result.verdict === 'pass' ? '主脑检查意见：' : '已建立主脑反馈：') + result.summary)
      setRefresh(n=>n+1); onChanged()
    } catch(e) {setNotice(errorText(e)); if(e instanceof ApiError && e.code==='OPERATION_OUTCOME_UNKNOWN')setUnknownOperation((e.details as {operation_id:string}).operation_id)}
    finally {setBusy(false)}
  }
  async function submit(action: 'request' | 'hold' | 'accept' | 'withdraw') {
    if (!canWrite || !node) return
    setBusy(true); setNotice('')
    try {
      if (action === 'request' && artifact) await commands.request({ run_id: runId, target_node_run_id: nodeId, source_artifact_id: artifact.artifact_id, source_artifact_hash: artifact.sha256, expected_revision: node.revision, reason: reason.trim(), expected_result: expected.trim(), preserve_requirements: preserve.split('\n').map(s => s.trim()).filter(Boolean), suggested_scope: scope, evidence_ids: [] })
      else if (action !== 'request') await commands.hold({ run_id: runId, node_run_id: nodeId, action, ...(action === 'accept' && artifact ? { artifact_id: artifact.artifact_id, sha256: artifact.sha256 } : {}) })
      setNotice('已保存'); setRefresh(n => n + 1); setHolds((await commands.listHolds(runId)).data.items); onChanged()
    } catch (e) { setNotice(errorText(e)); if (e instanceof ApiError && e.code === 'OPERATION_OUTCOME_UNKNOWN') setUnknownOperation((e.details as { operation_id: string }).operation_id) }
    finally { setBusy(false) }
  }
  return <details><summary>审核成果或提出修改</summary><fieldset disabled={busy || Boolean(unknownOperation)} style={{ border: 0, padding: 0 }}>
    <label style={field}>来源节点<select value={nodeId} onChange={e => { setNodeId(e.target.value); setArtifactId('') }}><option value="">选择节点</option>{nodes.map(n => <option key={n.node_run_id} value={n.node_run_id}>{n.title || n.node_id} · 第 {n.attempt} 次 · {nodeExecutionLabel(n)}</option>)}</select></label>
    <label style={field}>成果版本<select value={artifactId} onChange={e => setArtifactId(e.target.value)}><option value="">选择成果</option>{artifacts.filter(a => a.source_node_run_id === nodeId).map((a, index) => <option key={a.artifact_id} value={a.artifact_id}>{artifactVersionLabel(a, index)}</option>)}</select></label>
    {artifact && <ArtifactContent api={api} artifact={artifact} />}
    {artifact && <details><summary>查看所选成果版本记录</summary>
      <p>成果编号 <code>{artifact.artifact_id}</code> · SHA-256 <code>{artifact.sha256}</code></p>
    </details>}
    <div style={actions}><button type="button" disabled={!canWrite || !node || held} onClick={() => void submit('hold')}>等待人工验收后结束</button><button type="button" disabled={!canWrite || !held || !artifact} onClick={() => void submit('accept')}>通过成果验收</button><button type="button" disabled={!canWrite || !held} onClick={() => void submit('withdraw')}>撤销留验</button></div>
    {held && <p role="status">此节点等待人工验收，运行暂不结束。</p>}
    {plannerEnabled && <section aria-label="主脑成果检查">
      <label style={field}>主脑检查标准<textarea value={inspectionCriteria} onChange={e=>setInspectionCriteria(e.target.value)} rows={2} maxLength={2500} /></label>
      <button type="button" disabled={!canWrite || !artifact || !node || node.status !== 'done' || !inspectionCriteria.trim()} onClick={()=>void inspect()}>请主脑检查成果</button>
      <p>主脑通过意见只留存记录；发现缺陷后按返工策略建立反馈。检查完整 UTF-8 文本，最大 64 KiB。</p>
      {inspections.length > 0 && <details><summary>主脑检查记录</summary>{inspections.map(item=><article key={item.inspection_id}><p>{item.verdict==='pass'?'通过意见':'要求修改'} · {item.created_at} · {item.artifact_id}</p><code style={hash}>{item.artifact_hash}</code><p>{item.summary}</p>{item.request_id&&<p>反馈编号：{item.request_id}</p>}</article>)}</details>}
    </section>}
    <label style={field}>具体修改意见<textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} /></label>
    <label style={field}>期望结果<textarea value={expected} onChange={e => setExpected(e.target.value)} rows={2} /></label>
    <label style={field}>保留要求（每行一条）<textarea value={preserve} onChange={e => setPreserve(e.target.value)} rows={2} /></label>
    <label style={field}>修改方式<select value={scope} onChange={e => setScope(e.target.value as ReworkScope)}><option value="targeted_revision">针对性修改</option><option value="rerun_node">重新执行当前节点</option><option value="replan_subgraph">提交局部重规划需求</option></select></label>
    <button type="button" disabled={!canWrite || runEnded || !artifact || !node || node.status !== 'done' || !reason.trim() || !expected.trim()} onClick={() => void submit('request')}>要求修改</button>
    <p>{runEnded ? '本次运行已经结束，不能再提交修改意见。已交付的文件仍可在结果里打开；需要改稿时请新建一项任务并附上这份成果。' : '意见提交后等待授权，旧成果与执行记录保留。'}</p>
  </fieldset>{notice && <p role="status">{notice}</p>}{unknownOperation && <button type="button" onClick={async () => { try { const { data } = await commands.getOperation(unknownOperation); setNotice(`回执状态：${receiptStatus(data.status)}`); if (data.status === 'applied') { setUnknownOperation(undefined); onChanged() } } catch (e) { setNotice(errorText(e)) } }}>查询原操作回执</button>}</details>
}
export function LineComparison({ before, after }: { before: string; after: string }) {
  const oldLines = before.split('\n'), newLines = after.split('\n')
  return <div style={{ overflowX: 'auto', maxHeight: 360 }}><table aria-label="修改前后逐行对比" style={{ width: '100%', borderCollapse: 'collapse' }}>
    <thead><tr><th scope="col">行</th><th scope="col">修改前</th><th scope="col">修订后</th></tr></thead>
    <tbody>{Array.from({ length: Math.max(oldLines.length, newLines.length) }, (_, index) => <tr key={index}>
      <th scope="row">{index + 1}</th><td style={{ whiteSpace: 'pre-wrap', background: oldLines[index] !== newLines[index] ? '#fff0ed' : undefined }}>{oldLines[index] ?? ''}</td>
      <td style={{ whiteSpace: 'pre-wrap', background: oldLines[index] !== newLines[index] ? '#edf8ee' : undefined }}>{newLines[index] ?? ''}</td>
    </tr>)}</tbody></table></div>
}
const box: CSSProperties = { padding: 14, margin: '12px 0', border: `1px solid ${COLOR.line}`, borderRadius: 8, overflowWrap: 'anywhere' }
const field: CSSProperties = { display: 'grid', gap: 5, margin: '10px 0' }
const actions: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, margin: '10px 0' }
const hash: CSSProperties = { display: 'block', overflowWrap: 'anywhere', fontSize: FONT_PX.helper }
