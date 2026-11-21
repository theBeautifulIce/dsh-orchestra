import { currentAttempts } from './runtime-topology.ts'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { NodeRunView, RunSummary } from '../api/types.ts'
import { readCanvasDoc, NODE_TYPE_LABEL, topologicalOrder, type CanvasDoc, type CanvasNode } from './workflow-canvas-nodes.tsx'
import { MODEL_LEVELS } from '../../executor/model-routing.ts'
import { COPY } from './copy.ts'
import { operatorReason } from '../../core/operator-language.ts'
import { nodeExecutionLabel, nodeExecutionPhase, waitingFor } from './task-node-status.ts'
import { TASK_RUN_STEPS_CSS } from './task-workspace-styles.ts'

type Step = { id: string; nodeId: string; title: string; type: string; attempt: NodeRunView | null; definition?: CanvasNode }

function stepsFor(nodes: readonly NodeRunView[], doc?: CanvasDoc | null): Step[] {
  const actual = currentAttempts(nodes)
  const documented = new Map(doc?.nodes.map((node) => [node.node_id, node]))
  if (actual.size) {
    const order = doc ? topologicalOrder(doc) : null
    const rank = new Map(order?.ok ? order.order.map((id, index) => [id, index]) : [])
    const ordered = Array.from(actual.values()).sort((a, b) => (rank.get(a.node_id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.node_id) ?? Number.MAX_SAFE_INTEGER))
    return ordered.map((node, index) => ({
      id: node.node_run_id, nodeId: node.node_id, title: node.title || documented.get(node.node_id)?.title || `未命名步骤 ${index + 1}`,
      type: node.node_type, attempt: node, definition: documented.get(node.node_id),
    }))
  }
  return (doc?.nodes ?? []).filter((node) => node.type !== 'trigger').map((node) => ({
    id: node.node_id, nodeId: node.node_id, title: node.title, type: node.type, attempt: null, definition: node,
  }))
}

export function usePinnedWorkflow(api: ResourcesApi, workflowId: string | null | undefined, version: number | null | undefined) {
  const [loaded, setLoaded] = useState<{ key: string; doc: CanvasDoc | null; definition: unknown; error: boolean }>()
  const key = workflowId && version != null ? `${workflowId}:${version}` : null
  useEffect(() => {
    if (!workflowId || version == null || !key) return
    let active = true
    void api.getWorkflowVersion(workflowId, version).then(({ data }) => {
      if (active) setLoaded({ key, doc: readCanvasDoc(data.definition), definition: data.definition, error: false })
    }).catch(() => {
      if (active) setLoaded({ key, doc: null, definition: null, error: true })
    })
    return () => { active = false }
  }, [api, key, version, workflowId])
  return key === loaded?.key ? loaded : undefined
}

export function TaskRunSteps({ nodes, doc, run, runDetails = false, onOpenRun, onOpenResult, onOpenDecision, renderEvidence }: {
  nodes: readonly NodeRunView[]; doc?: CanvasDoc | null
  run?: RunSummary; runDetails?: boolean
  onOpenRun?: (trigger: HTMLButtonElement) => void
  onOpenResult?: () => void
  onOpenDecision?: (id: string) => void
  renderEvidence?: (node: NodeRunView) => ReactNode
}) {
  const steps = useMemo(() => stepsFor(nodes, doc), [nodes, doc])
  const titles = useMemo(() => new Map([...(doc?.nodes ?? []).map((node) => [node.node_id, node.title] as const),
    ...steps.map((step) => [step.nodeId, step.title] as const)]), [steps, doc])
  const [selectedId, setSelectedId] = useState<string>()
  const attention = steps.filter(({ attempt }) => needsAttention(attempt))
  const active = steps.filter(({ attempt }) => nodeExecutionPhase(attempt).tone === 'active')
  const waiting = steps.filter(({ attempt }) => attempt?.execution_state === 'waiting_capacity' || attempt?.execution_state === 'waiting_dependencies')
  const selected = steps.find((step) => step.nodeId === selectedId) ?? attention[0] ?? active[0] ?? waiting[0] ?? steps[0]
  const done = steps.filter((step) => step.attempt?.status === 'done').length
  const parallel = useMemo(() => sameLayerWidth(doc, steps), [doc, steps])
  const progress = steps.length > 1 ? nodes.length ? `${done} / ${steps.length} 步完成` : `${steps.length} 个计划步骤` : null
  const picker = useRef<HTMLOListElement>(null)
  const selectedNodeId = selected?.nodeId
  useLayoutEffect(() => {
    const list = picker.current
    const button = list?.querySelector('[aria-pressed=true]')
    if (!list || !button) return
    const box = list.getBoundingClientRect()
    const row = button.getBoundingClientRect()
    if (row.top < box.top) list.scrollTop -= box.top - row.top
    else if (row.bottom > box.bottom) list.scrollTop += row.bottom - box.bottom
  }, [selectedNodeId])

  return <section className="task-run-steps" aria-label="执行步骤">
    <style>{TASK_RUN_STEPS_CSS}</style>
    <header className="task-run-steps-head">
      <h3>执行步骤{runDetails && ` · ${steps.length}`}</h3>
      {runDetails && run?.settling && <p>正在收尾</p>}
      {progress && <span>{progress}</span>}
    </header>
    {(attention.length > 0 || active.length > 1 || waiting.length > 0 || parallel > 1) && steps.length > 1 &&
      <ul className="task-step-totals" aria-label="步骤状态概况">
        {attention.length > 0 && <li data-tone="blocked">{attention.length} 步需关注</li>}
        {active.length > 0 && <li data-tone="active">{active.length} 步执行中</li>}
        {waiting.length > 0 && <li>{waiting.length} 步等待</li>}
        {parallel > 1 && <li>同层最多 {parallel} 步</li>}
      </ul>}
    {!runDetails && run?.scheduled_for && <p className="task-flow-trigger-record">定时触发 · 计划时间 <time dateTime={run.scheduled_for}>{formatTaskDate(run.scheduled_for)}</time></p>}
    {steps.length === 0 ? <p className="task-flow-empty">{runDetails ? '这次运行没有执行步骤。' : '执行步骤会在运行排入后出现在这里。'}</p>
      : <div className="task-run-grid" data-single={steps.length === 1}>
      {steps.length > 1 && <ol className="task-flow-steps" ref={picker} aria-label="选择执行步骤">
        {steps.map((step, index) => {
          const phase = nodeExecutionPhase(step.attempt)
          const type = NODE_TYPE_LABEL[step.type] ?? '步骤类型未记录'
          return <li key={step.id}>
            <button className="task-flow-step" type="button" data-tone={phase.tone} aria-pressed={selected === step} onClick={() => setSelectedId(step.nodeId)}>
              <span className="task-flow-step-number" aria-hidden="true">{index + 1}</span>
              <strong title={type}>{step.title}</strong>
              <span className="task-flow-step-result">{step.attempt ? nodeExecutionLabel(step.attempt) : '尚无执行记录'}</span>
            </button>
          </li>
        })}
      </ol>}
      <aside className="task-step-inspector" aria-label="步骤执行详情">
        {selected && <StepInspection key={selected.id} step={selected} steps={steps} doc={doc} titles={titles} renderEvidence={renderEvidence}
          onOpenRun={onOpenRun} onOpenResult={onOpenResult} onOpenDecision={onOpenDecision} />}
      </aside>
    </div>}
  </section>
}

function sameLayerWidth(doc: CanvasDoc | null | undefined, steps: readonly Step[]) {
  const topology = doc && steps.length > 1 ? topologicalOrder(doc) : null
  if (!topology?.ok) return 0
  const counts = new Map<number, number>()
  for (const { nodeId } of steps) {
    const layer = topology.layer.get(nodeId)
    if (layer !== undefined) counts.set(layer, (counts.get(layer) ?? 0) + 1)
  }
  return Math.max(0, ...counts.values())
}

function StepInspection({ step, steps, doc, titles, onOpenRun, onOpenResult, onOpenDecision, renderEvidence }: {
  step: Step; steps: readonly Step[]; doc?: CanvasDoc | null; onOpenRun?: (trigger: HTMLButtonElement) => void
  titles: ReadonlyMap<string, string>
  renderEvidence?: (node: NodeRunView) => ReactNode
  onOpenResult?: () => void
  onOpenDecision?: (id: string) => void
}) {
  const node = step.attempt
  const name = (id: string) => titles.get(id) || '未命名步骤'
  const incomingIds = node?.depends_on ?? doc?.edges.filter((edge) => edge.to === step.nodeId).map((edge) => edge.from)
  const incoming = incomingIds?.map(name)
  const downstream = new Set(doc?.edges.filter((edge) => edge.from === step.nodeId).map((edge) => edge.to))
  for (const { nodeId, attempt } of steps) {
    if (attempt?.depends_on?.includes(step.nodeId)) downstream.add(nodeId)
    else if (attempt?.depends_on) downstream.delete(nodeId)
  }
  const outgoing = [...downstream].map(name)
  const assignment = node?.model_assignment
  const model = assignment?.usage
  const metering = model?.metering
  const contract = step.definition?.raw.contract as { description?: unknown } | undefined
  const description = typeof contract?.description === 'string' ? contract.description : null
  const waiting = node && waitingFor(node, titles)
  const allUpstreamWaiting = waiting && incomingIds?.length && incomingIds.length === node?.waiting_on?.length
    && node.waiting_on.every((id) => incomingIds.includes(id))
  const heartbeat = node && heartbeatNotice(node)
  const phase = nodeExecutionPhase(node)
  const status = node ? nodeExecutionLabel(node) : '尚无执行记录'
  const decisions = node?.active_decision_ids ?? []
  const verifying = node?.status === 'verifying'
  const waitingReview = node?.status === 'blocked_post'
  const modelLabel = model ? '实际执行模型' : assignment?.state === 'confirmed' ? '宿主确认模型'
    : assignment?.state === 'rejected' ? '模型未获宿主确认' : '拟用模型'
  const modelName = assignment && (model ? `${model.provider} / ${model.model}`
    : assignment.provider && assignment.model ? `${assignment.provider} / ${assignment.model}` : assignment.model_ref)
  const [open, setOpen] = useState(false)
  return <div className="task-step-inspect-body">
    <header className="task-step-head"><h4>{step.title}</h4><span data-tone={phase.tone}>{status}</span></header>
    <p className="task-step-meta">{NODE_TYPE_LABEL[step.type] ?? '步骤类型未记录'}{node && ` · 第 ${node.attempt} 次尝试`}
      {node?.started_at && <> · 开始于 <time dateTime={node.started_at}>{formatTaskDate(node.started_at)}</time></>}
      {node && node.execution_count > 0 && ` · ${node.execution_count} 条工具执行记录`}
      {node && Boolean(node.projection_missing?.length) && ' · 部分信息暂不可用'}
    </p>
    {(waiting || verifying || waitingReview || node?.hang_reason || heartbeat || decisions.length > 0) && <div className="task-step-attention" data-tone={phase.tone}>
      {waiting && <p>{waiting}</p>}
      {verifying && <p>系统正在核验这一步的执行结果，核验结束后会更新步骤状态。已登记的产物可在运行的「结果」中查看。</p>}
      {waitingReview && <p>{decisions.length ? '这一步正在等待人工处理，打开审批可查看需要核对的内容。' : '这一步的结果仍待人工处理，可在运行的「证据」中查看现有记录。'}</p>}
      {node?.hang_reason && <p>{operatorReason(node.hang_reason)}</p>}
      {heartbeat && <p>{heartbeat}</p>}
      {decisions.length > 0 && <p>{decisions.length} 项{COPY.awaitingDecision}</p>}
      {decisions.map((id, index) => onOpenDecision && <button key={id} type="button" className="task-quiet-button" onClick={() => onOpenDecision(id)}>
        {decisions.length === 1 ? '查看待处理审批' : `查看第 ${index + 1} 项审批`}
      </button>)}
      {verifying && onOpenResult && <button type="button" className="task-quiet-button" onClick={onOpenResult}>查看已登记产物</button>}
    </div>}
    {((!allUpstreamWaiting && !!incoming?.length) || outgoing.length > 0) && <dl className="task-step-dependencies">
      {!allUpstreamWaiting && !!incoming?.length && <><dt>上游</dt><dd>{incoming.join('、')}</dd></>}
      {outgoing.length > 0 && <><dt>下游</dt><dd>{outgoing.join('、')}</dd></>}
    </dl>}
    {(assignment || node?.node_type === 'agent') && <div className="task-step-model">
      {assignment && <p><strong>{modelLabel}</strong> · {modelName}</p>}
      {assignment?.reasoning_effort !== undefined && <span>派发思考深度 · {assignment.reasoning_effort ?? '模型默认'}</span>}
      {model?.reasoning_effort && <span>实际请求思考深度 · {model.reasoning_effort}</span>}
      {metering?.settlement_incomplete && <p>执行提前结束，仅显示模型已报告的用量。</p>}
      <p>本次尝试模型用量（Token）{metering
        ? <> · 输入（未缓存）{metering.tokens.uncached_input_tokens ?? '不可用'} · 输出{metering.tokens.output_tokens ?? '不可用'}
          {' · 缓存读取'}{metering.tokens.cache_read_tokens ?? '不可用'} · 缓存写入{metering.tokens.cache_write_tokens ?? '不可用'}</>
        : ' · 不可用'}</p>
      <p>上下文压缩{metering?.context_compactions
        ? <> · 摘要 {metering.context_compactions.summaries} 次 · 工具结果裁剪 {metering.context_compactions.tool_result_prunes} 次</>
        : ' · 不可用'}</p>
    </div>}
    {(assignment || description || step.definition?.raw.runtime_step != null || node) && <details className="task-step-more"
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{node && renderEvidence ? '更多详情与执行日志' : '更多步骤详情'}</summary>
      {open && <div className="task-step-more-body">
        {step.definition?.raw.runtime_step != null && <p>运行中新增 · 来源角色：{String((step.definition.raw.runtime_step as { source_title: string }).source_title)}</p>}
        {description && <section><h5>步骤职责</h5><p>{description}</p></section>}
        {assignment && <section><h5>模型诊断</h5>
          <p>{MODEL_LEVELS[assignment.complexity]?.label} · {assignment.reason}</p>
          {assignment.settings_revision != null && <p>按用户配置 · 修订 {assignment.settings_revision}</p>}
        </section>}
        {node && renderEvidence?.(node)}
        {node && <details>
          <summary>查看技术记录</summary>
          <p>步骤编号 <code>{node.node_id}</code> · 尝试编号 <code>{node.node_run_id}</code></p>
          <p>状态 <code>{node.status}</code>{node.hang_reason && <> · 原因 <code>{node.hang_reason}</code></>}</p>
        </details>}
      </div>}
    </details>}
    {onOpenRun && node && <button type="button" className="task-quiet-button" onClick={(event) => onOpenRun(event.currentTarget)}>查看这次运行</button>}
  </div>
}

const terminal = new Set(['done', 'failed', 'timeout', 'abandoned_unverified', 'failed_with_unverified', 'orphaned', 'superseded'])

function heartbeatNotice(node: NodeRunView): string | null {
  if (!node.heartbeat_at || terminal.has(node.status)) return null
  const seconds = Math.floor((Date.now() - Date.parse(node.heartbeat_at)) / 1000)
  return seconds > 30 ? `${COPY.heartbeatStopped} ${seconds} 秒` : null
}

function needsAttention(node: NodeRunView | null) {
  if (!node) return false
  const { tone } = nodeExecutionPhase(node)
  return tone === 'blocked' || tone === 'failed' || Boolean(node.hang_reason || node.active_decision_ids.length || heartbeatNotice(node))
}

export function formatTaskDate(value: string, timeZone?: string): string {
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
  }).format(at)
}

export function runDuration(start: string | null | undefined, end: string | null | undefined): string | null {
  const ms = Date.parse(end ?? '') - Date.parse(start ?? '')
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${ms} 毫秒`
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`
}
