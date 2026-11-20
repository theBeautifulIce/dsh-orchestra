import { currentAttempts } from './runtime-topology.ts'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { NodeRunView, RunSummary } from '../api/types.ts'
import { readCanvasDoc, NODE_TYPE_LABEL, topologicalOrder, type CanvasDoc, type CanvasNode } from './workflow-canvas-nodes.tsx'
import { ACTIVE_NODE_STATES, BLOCKED_NODE_STATES, nodeExecutionLabel, nodeExecutionPhase, waitingFor } from './task-node-status.ts'

type Step = { id: string; nodeId: string; title: string; type: string; attempt: NodeRunView | null; definition?: CanvasNode }

function stepsFor(nodes: readonly NodeRunView[], doc?: CanvasDoc | null): Step[] {
  const actual = currentAttempts(nodes)
  const documented = new Map(doc?.nodes.map((node) => [node.node_id, node]))
  if (actual.size) {
    const order = doc ? topologicalOrder(doc) : null
    const rank = new Map(order?.ok ? order.order.map((id, index) => [id, index]) : [])
    const ordered = Array.from(actual.values()).sort((a, b) => (rank.get(a.node_id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.node_id) ?? Number.MAX_SAFE_INTEGER))
    return ordered.map((node) => ({
      id: node.node_run_id, nodeId: node.node_id, title: node.title || documented.get(node.node_id)?.title || node.node_id,
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

export function TaskRunSteps({ nodes, doc, run, compact = false, onOpenRun, renderEvidence }: {
  nodes: readonly NodeRunView[]; doc?: CanvasDoc | null; compact?: boolean
  run?: RunSummary
  onOpenRun?: (trigger: HTMLButtonElement) => void
  renderEvidence?: (node: NodeRunView) => ReactNode
}) {
  const steps = useMemo(() => stepsFor(nodes, doc), [nodes, doc])
  const titles = useMemo(() => new Map([...(doc?.nodes ?? []).map((node) => [node.node_id, node.title] as const),
    ...steps.map((step) => [step.nodeId, step.title] as const)]), [steps, doc])
  const [selectedId, setSelectedId] = useState<string>()
  const active = steps.find((step) => step.attempt && (ACTIVE_NODE_STATES.has(step.attempt.status) || BLOCKED_NODE_STATES.has(step.attempt.status)))
  const selected = steps.find((step) => step.nodeId === selectedId) ?? active ?? steps[0]
  const done = steps.filter((step) => step.attempt?.status === 'done').length

  return <div className={compact ? 'task-run-grid task-run-grid--compact' : 'task-run-grid'}>
    <section className="task-flow-steps" aria-label="执行步骤">
      <header className="task-flow-section-head">
        <strong>执行步骤</strong>
        <span>{nodes.length ? `${done} / ${steps.length} 步完成` : steps.length ? `${steps.length} 个计划步骤` : '暂无步骤'}</span>
      </header>
      {run?.scheduled_for && <div className="task-flow-trigger-record">
        <span className="task-type-badge">触发</span>
        <div><strong>定时触发</strong><p>计划时间 <time dateTime={run.scheduled_for}>{formatTaskDate(run.scheduled_for)}</time></p></div>
        <span>已记录</span>
      </div>}
      {active && <p className="task-flow-current">当前关注 · {active.title}</p>}
      {steps.length === 0 && <p className="task-flow-empty">执行步骤会在运行排入后出现在这里。</p>}
      <ol>
        {steps.map((step, index) => {
          const phase = nodeExecutionPhase(step.attempt)
          const type = NODE_TYPE_LABEL[step.type] ?? step.type
          return <li key={step.id}>
            <button className="task-flow-step" type="button" data-tone={phase.tone} aria-pressed={selected === step} onClick={() => setSelectedId(step.nodeId)}>
              <span className="task-flow-step-mark"><span className="task-flow-step-number">{String(index + 1).padStart(2, '0')}</span></span>
              <span className="task-flow-step-content"><strong>{step.title}</strong>
                <span>{type}{step.attempt ? ` · 第 ${step.attempt.attempt} 次尝试` : ' · 固定流程定义'}</span>
                {step.attempt?.started_at && <time dateTime={step.attempt.started_at}>开始于 {formatTaskDate(step.attempt.started_at)}</time>}
              </span>
              <span className="task-flow-step-result">{step.attempt ? nodeExecutionLabel(step.attempt) : '尚无执行记录'}</span>
            </button>
          </li>
        })}
      </ol>
    </section>
    <aside className="task-step-inspector" aria-label="步骤执行详情">
      <header className="task-flow-section-head"><strong>步骤执行详情</strong>
        {selected && <span>{steps.indexOf(selected) + 1} / {steps.length}</span>}
      </header>
      {selected
        ? <StepInspection step={selected} doc={doc} titles={titles} renderEvidence={renderEvidence} onOpenRun={onOpenRun} />
        : <p className="task-flow-empty">选择一个执行步骤，查看其依赖、结果和证据。</p>}
    </aside>
  </div>
}

function StepInspection({ step, doc, titles, onOpenRun, renderEvidence }: {
  step: Step; doc?: CanvasDoc | null; onOpenRun?: (trigger: HTMLButtonElement) => void
  titles: ReadonlyMap<string, string>
  renderEvidence?: (node: NodeRunView) => ReactNode
}) {
  const node = step.attempt
  const name = (id: string) => titles.get(id) || id
  const incoming = node?.depends_on?.map(name) ?? doc?.edges.filter((edge) => edge.to === step.nodeId).map((edge) => name(edge.from))
  const outgoing = doc?.edges.filter((edge) => edge.from === step.nodeId).map((edge) => name(edge.to))
  const assignment = node?.model_assignment
  const model = assignment?.usage
  const contract = step.definition?.raw.contract as { description?: unknown } | undefined
  const waiting = node && waitingFor(node, titles)
  return <div className="task-step-inspect-body">
    <h3>{step.title}</h3>
    <p>{NODE_TYPE_LABEL[step.type] ?? step.type} · {nodeExecutionPhase(node).label}{node && ` · 第 ${node.attempt} 次尝试`}</p>
    {node?.started_at && <p>开始于 <time dateTime={node.started_at}>{formatTaskDate(node.started_at)}</time></p>}
    {step.definition?.raw.runtime_step != null && <p>运行中新增 · 来源角色：{String((step.definition.raw.runtime_step as { source_title: string }).source_title)}</p>}
    {typeof contract?.description === 'string' && <section><h4>步骤职责</h4><p>{contract.description}</p></section>}
    <section><h4>状态与结果</h4><p>{node ? nodeExecutionLabel(node) : '尚无执行记录'}</p>
      {waiting && <p>{waiting}</p>}
      {node?.hang_reason && <p>{node.hang_reason}</p>}
      {node && node.active_decision_ids.length > 0 && <p>{node.active_decision_ids.length} 项待审批</p>}
    </section>
    {(incoming || outgoing) && <section><h4>节点依赖</h4><dl className="task-step-dependencies">
      {incoming && <><dt>上游</dt><dd>{incoming.join('、') || '无上游步骤'}</dd></>}
      {outgoing && <><dt>下游</dt><dd>{outgoing.join('、') || '无后续节点'}</dd></>}
    </dl></section>}
    {assignment && <section>
      <h4>{model ? '实际执行模型' : assignment.state === 'confirmed' ? '宿主确认模型' : assignment.state === 'rejected' ? '模型未获宿主确认' : '拟用模型'}</h4>
      <p>{model ? `${model.provider} / ${model.model}` : assignment.provider && assignment.model
        ? `${assignment.provider} / ${assignment.model}` : assignment.model_ref}</p><p>{assignment.reason}</p>
      {assignment.reasoning_effort !== undefined && <p>派发思考深度 · {assignment.reasoning_effort ?? '模型默认'}</p>}
      {model?.reasoning_effort && <p>实际请求思考深度 · {model.reasoning_effort}</p>}
      {assignment.settings_revision != null && <p>按用户配置 · 修订 {assignment.settings_revision}</p>}
    </section>}
    {node && renderEvidence?.(node)}
    {onOpenRun && node && <button type="button" className="task-quiet-button" onClick={(event) => onOpenRun(event.currentTarget)}>查看这次运行</button>}
  </div>
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
