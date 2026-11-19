import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { NodeRunView, RunSummary } from '../api/types.ts'
import { readCanvasDoc, NODE_TYPE_LABEL, type CanvasDoc, type CanvasNode } from './workflow-canvas-nodes.tsx'

type Step = { id: string; nodeId: string; title: string; type: string; attempt: NodeRunView | null; definition?: CanvasNode }

const BLOCKED = new Set(['blocked_pre', 'blocked_post', 'indeterminate_side_effect', 'startup_unknown', 'paused_bridge_missing'])
const EXECUTING = new Set(['leased', 'dispatched', 'started', 'verifying', 'stopping', 'timing_out'])
const FAILED = new Set(['failed', 'timeout', 'orphaned'])
const UNVERIFIED = new Set(['failed_with_unverified', 'abandoned_unverified'])

export function nodePhase(status: string | null): { label: string; tone: string } {
  if (status === null) return { label: '未运行', tone: 'waiting' }
  if (status === 'done') return { label: '已完成', tone: 'done' }
  if (BLOCKED.has(status)) return { label: '待处理', tone: 'blocked' }
  if (EXECUTING.has(status)) return { label: status === 'verifying' ? '核验中' : '进行中', tone: 'active' }
  if (UNVERIFIED.has(status)) return { label: '待核实', tone: 'blocked' }
  if (FAILED.has(status)) return { label: '未成功', tone: 'failed' }
  if (status === 'queued') return { label: '等待调度', tone: 'waiting' }
  if (status === 'waiting') return { label: '等待条件', tone: 'waiting' }
  if (status === 'superseded') return { label: '已被接替', tone: 'waiting' }
  return { label: status, tone: 'waiting' }
}

function newestAttempts(nodes: readonly NodeRunView[]) {
  const newest = new Map<string, NodeRunView>()
  for (const node of nodes) {
    const previous = newest.get(node.node_id)
    if (!previous || node.attempt > previous.attempt) newest.set(node.node_id, node)
  }
  return newest
}

function stepsFor(nodes: readonly NodeRunView[], doc?: CanvasDoc | null): Step[] {
  const actual = newestAttempts(nodes)
  const documented = new Map(doc?.nodes.map((node) => [node.node_id, node]))
  if (actual.size) {
    return Array.from(actual.values(), (node) => ({
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
  const [selectedId, setSelectedId] = useState<string>()
  const active = steps.find((step) => step.attempt && (EXECUTING.has(step.attempt.status) || BLOCKED.has(step.attempt.status)))
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
        <div><strong>定时唤醒</strong><p>计划时间 <time dateTime={run.scheduled_for}>{formatTaskDate(run.scheduled_for)}</time></p></div>
        <span>已记录</span>
      </div>}
      {active && <p className="task-flow-current">当前关注 · {active.title}</p>}
      {steps.length === 0 && <p className="task-flow-empty">执行步骤会在运行排入后出现在这里。</p>}
      <ol>
        {steps.map((step, index) => {
          const phase = nodePhase(step.attempt?.status ?? null)
          const type = NODE_TYPE_LABEL[step.type] ?? step.type
          return <li key={step.id}>
            <button className="task-flow-step" type="button" data-tone={phase.tone} aria-pressed={selected === step} onClick={() => setSelectedId(step.nodeId)}>
              <span className="task-flow-step-mark"><span className="task-flow-step-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="task-flow-step-state">{phase.label}</span>
              </span>
              <span className="task-flow-step-content"><strong>{step.title}</strong>
                <span>{type}{step.attempt ? ` · 第 ${step.attempt.attempt} 次尝试` : ' · 固定流程定义'}</span>
                {step.attempt?.started_at && <time dateTime={step.attempt.started_at}>开始于 {formatTaskDate(step.attempt.started_at)}</time>}
              </span>
              <span className="task-flow-step-result"><b>结果</b>{step.attempt?.status_label ?? '尚无执行记录'}</span>
            </button>
          </li>
        })}
      </ol>
    </section>
    <aside className="task-step-inspector" aria-label="这一步的现场">
      <header className="task-flow-section-head"><strong>这一步的现场</strong>
        {selected && <span>{steps.indexOf(selected) + 1} / {steps.length}</span>}
      </header>
      {selected
        ? <StepInspection step={selected} doc={doc} renderEvidence={renderEvidence} onOpenRun={onOpenRun} />
        : <p className="task-flow-empty">选择一个执行步骤，查看其依赖、结果和证据。</p>}
    </aside>
  </div>
}

function StepInspection({ step, doc, onOpenRun, renderEvidence }: {
  step: Step; doc?: CanvasDoc | null; onOpenRun?: (trigger: HTMLButtonElement) => void
  renderEvidence?: (node: NodeRunView) => ReactNode
}) {
  const node = step.attempt
  const name = (id: string) => doc?.nodes.find((item) => item.node_id === id)?.title ?? id
  const incoming = doc?.edges.filter((edge) => edge.to === step.nodeId).map((edge) => name(edge.from))
  const outgoing = doc?.edges.filter((edge) => edge.from === step.nodeId).map((edge) => name(edge.to))
  const assignment = node?.model_assignment
  const model = assignment?.usage
  return <div className="task-step-inspect-body">
    <h3>{step.title}</h3>
    <p>{NODE_TYPE_LABEL[step.type] ?? step.type} · {nodePhase(node?.status ?? null).label}{node && ` · 第 ${node.attempt} 次尝试`}</p>
    {node?.started_at && <p>开始于 <time dateTime={node.started_at}>{formatTaskDate(node.started_at)}</time></p>}
    <section><h4>结果</h4><p>{node?.status_label ?? '尚无执行记录'}</p>
      {node?.hang_reason && <p>{node.hang_reason}</p>}
      {node && node.active_decision_ids.length > 0 && <p>{node.active_decision_ids.length} 项决定待处理</p>}
    </section>
    {step.definition && <section><h4>输入与后续</h4><dl className="task-step-dependencies">
      <dt>上游</dt><dd>{incoming?.join('、') || '流程入口'}</dd>
      <dt>下游</dt><dd>{outgoing?.join('、') || '无后续节点'}</dd>
    </dl></section>}
    {assignment && <section>
      <h4>{model ? '实际执行模型' : assignment.state === 'confirmed' ? '宿主确认模型' : assignment.state === 'rejected' ? '模型未获宿主确认' : '拟用模型'}</h4>
      <p>{model ? `${model.provider} / ${model.model}` : assignment.model_ref}</p><p>{assignment.reason}</p>
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
