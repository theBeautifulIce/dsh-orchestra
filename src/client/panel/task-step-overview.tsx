import { useEffect, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { NodeRunView } from '../api/types.ts'
import { currentAttempts } from './runtime-topology.ts'
import { ACTIVE_NODE_STATES, executionState, nodeExecutionLabel, nodeExecutionPhase, waitingFor } from './task-node-status.ts'

const PAGE_LIMIT = 200
type StepRead = {
  api: ResourcesApi
  runId: string
  reloadVersion: number
  retry: number
  failed: boolean
  data?: { nodes: NodeRunView[]; partial: boolean }
}

export function useRunStepSnapshot(api: ResourcesApi, runId: string | null, reloadVersion: number, retainPrevious = false) {
  const [snapshot, setSnapshot] = useState<StepRead>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!runId) return
    let active = true
    const key = { api, runId, reloadVersion, retry }
    void api.listNodes(runId, PAGE_LIMIT).then(({ data }) => {
      if (data.items.some((node) => node.run_id !== runId)) throw new Error('步骤归属与当前运行不符')
      if (active) setSnapshot({ ...key, data: { nodes: data.items, partial: data.has_more ?? data.items.length >= PAGE_LIMIT }, failed: false })
    }).catch(() => {
      if (active) setSnapshot((previous) => ({
        ...key, failed: true, data: previous?.api === api && previous.runId === runId ? previous.data : undefined,
      }))
    })
    return () => { active = false }
  }, [api, runId, reloadVersion, retry])
  const sameRun = snapshot?.api === api && snapshot.runId === runId ? snapshot : undefined
  const current = sameRun?.reloadVersion === reloadVersion && sameRun.retry === retry ? sameRun : undefined
  const data = retainPrevious ? sameRun?.data : current?.failed ? undefined : current?.data
  return { nodes: data?.nodes, partial: data?.partial, failed: current?.failed, refresh: () => setRetry((value) => value + 1) }
}

const GROUPS = [
  { id: 'active', title: '进行中' },
  { id: 'capacity', title: '等待执行位' },
  { id: 'dependencies', title: '等待上游完成' },
  { id: 'ready', title: '就绪待派发' },
  { id: 'attention', title: '暂停、重试与异常' },
  { id: 'finished', title: '已结束' },
] as const
type QueueGroup = (typeof GROUPS)[number]['id']

function queueGroup(node: NodeRunView): QueueGroup {
  const state = executionState(node)
  if (ACTIVE_NODE_STATES.has(state)) return 'active'
  if (state === 'waiting_capacity') return 'capacity'
  if (state === 'waiting_dependencies') return 'dependencies'
  if (state === 'ready') return 'ready'
  if (state === 'done' || state === 'cancelled' || state === 'superseded') return 'finished'
  return 'attention'
}

type StepLabels = {
  titles: ReadonlyMap<string, string>
  namesakes: ReadonlyMap<string, string>
  references: ReadonlyMap<string, string>
}

function StepRows({ nodes, labels, groupTitle, joinParents }: {
  nodes: readonly NodeRunView[]; labels: StepLabels; groupTitle?: string; joinParents?: readonly string[]
}) {
  return <ul className="task-step-overview">
    {nodes.map((node) => {
      const waiting = waitingFor(node, labels.references)
      const label = groupTitle && executionState(node) === 'queued' ? '排队原因未记录' : nodeExecutionLabel(node)
      return <li key={node.node_id} data-tone={nodeExecutionPhase(node).tone}>
        <strong>{labels.titles.get(node.node_id)}</strong>
        {labels.namesakes.has(node.node_id) && <small>{labels.namesakes.get(node.node_id)}</small>}
        {label !== groupTitle && <span className="task-step-overview-status">{label}</span>}
        {node.attempt > 1 && <small>第 {node.attempt} 次尝试</small>}
        {joinParents && joinParents.length > 1 && <small className="task-step-waiting">汇合 · 依赖 {parentTitle(joinParents, labels)}</small>}
        {waiting && <small className="task-step-waiting">{waiting}</small>}
      </li>
    })}
  </ul>
}

type ParallelGroup = { key: string; parents: string[]; steps: NodeRunView[] }

function parentTitle(ids: readonly string[], labels: StepLabels) {
  return ids.map((id) => labels.references.get(id)).join('、')
}

/** A group has one exact set of direct predecessors. Traversal order expresses dependencies. */
function boardGroups(steps: readonly NodeRunView[]): ParallelGroup[] | undefined {
  const ids = new Set(steps.map(({ node_id }) => node_id))
  const pending = new Map<string, number>()
  const children = new Map<string, NodeRunView[]>()
  const groups = new Map<string, ParallelGroup>()
  const groupFor = new Map<string, ParallelGroup>()
  const ordered: NodeRunView[] = []
  for (const step of steps) {
    if (!step.node_id || !Array.isArray(step.depends_on) || step.depends_on.some((id) => !ids.has(id))) return undefined
    const parents = [...new Set(step.depends_on)].sort()
    const key = JSON.stringify(parents)
    let group = groups.get(key)
    if (!group) groups.set(key, group = { key, parents, steps: [] })
    group.steps.push(step)
    groupFor.set(step.node_id, group)
    pending.set(step.node_id, parents.length)
    if (parents.length === 0) ordered.push(step)
    for (const parent of parents) {
      const siblings = children.get(parent) ?? []
      siblings.push(step)
      children.set(parent, siblings)
    }
  }
  for (let index = 0; index < ordered.length; index++) {
    for (const child of children.get(ordered[index]!.node_id) ?? []) {
      const remaining = pending.get(child.node_id)! - 1
      pending.set(child.node_id, remaining)
      if (remaining === 0) ordered.push(child)
    }
  }
  if (ordered.length !== steps.length || groups.size === steps.length) return undefined
  return [...new Set(ordered.map(({ node_id }) => groupFor.get(node_id)!))]
}

function stepLabels(steps: readonly NodeRunView[]): StepLabels {
  const titles = new Map(steps.map((node, index) => [node.node_id, node.title || `未命名步骤 ${index + 1}`]))
  const byTitle = new Map<string, string[]>()
  for (const [id, title] of titles) {
    const matches = byTitle.get(title) ?? []
    matches.push(id)
    byTitle.set(title, matches)
  }
  const namesakes = new Map<string, string>()
  const references = new Map(titles)
  for (const matches of byTitle.values()) {
    if (matches.length < 2) continue
    matches.sort().forEach((id, index) => {
      const label = `同名步骤 ${index + 1}`
      namesakes.set(id, label)
      references.set(id, `${titles.get(id)}（${label}）`)
    })
  }
  return { titles, namesakes, references }
}

function BoardSteps({ steps, labels, partial }: { steps: NodeRunView[]; labels: StepLabels; partial: boolean }) {
  const groups = partial ? undefined : boardGroups(steps)
  if (!groups) return <StepRows nodes={steps} labels={labels} />
  return <div className="task-board-step-groups">
    {groups.map(({ key, parents, steps: group }) => {
      if (group.length === 1) return <StepRows key={key} nodes={group} labels={labels} joinParents={parents} />
      const active = group.filter((step) => ACTIVE_NODE_STATES.has(executionState(step))).length
      const done = group.filter((step) => executionState(step) === 'done').length
      const upstream = parentTitle(parents, labels)
      return <details key={key}>
        <summary><strong>{upstream ? `${upstream}之后` : '运行起点'} · {group.length} 个并行步骤</strong>
          <small>{done} / {group.length} 步完成{active > 0 && ` · ${active} 步执行中`}</small>
        </summary>
        <StepRows nodes={group} labels={labels} />
      </details>
    })}
  </div>
}

export function TaskStepOverview({ nodes, queue = false, partial = nodes.length >= PAGE_LIMIT }: {
  nodes: readonly NodeRunView[]; queue?: boolean; partial?: boolean
}) {
  const steps = [...currentAttempts(nodes).values()]
  const labels = stepLabels(steps)
  const groups = new Map<QueueGroup, NodeRunView[]>()
  if (queue) {
    for (const node of steps) {
      const id = queueGroup(node)
      const group = groups.get(id) ?? []
      group.push(node)
      groups.set(id, group)
    }
  }
  return <>
    {!steps.length ? <p className="task-flow-empty">{nodes.length ? '读取到的记录中没有当前尝试。' : '这次运行暂无步骤记录。'}</p>
      : queue ? <div className="task-queue-groups">
      {GROUPS.map(({ id, title }) => {
        const group = groups.get(id)
        return group && <section key={id} aria-label={title} className="task-flow-steps">
          <header className="task-flow-section-head"><h3>{title}</h3><span>{group.length} 步</span></header>
          <StepRows nodes={group} labels={labels} groupTitle={title} />
        </section>
      })}
    </div> : <BoardSteps steps={steps} labels={labels} partial={partial} />}
    {partial && <p className="task-flow-empty">本次最多读取 {PAGE_LIMIT} 条尝试记录，可能还有步骤或较新的尝试未显示。</p>}
  </>
}
