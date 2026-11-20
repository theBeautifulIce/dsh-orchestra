import { runtimeCanvasDoc, useRunTopology } from './runtime-topology.ts'
import { ReworkPanel } from './rework-panel.tsx'
import { useEffect, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { RunSummary, TaskSummary } from '../api/types.ts'
import { TaskRunSteps, formatTaskDate, runDuration, usePinnedWorkflow } from './task-run-steps.tsx'
import { ExecutionHistory } from './execution-history.tsx'
import { NodeEvidence } from './task-run-evidence.tsx'
import { taskAutonomyLabel, taskCardStatus, taskOriginLabel, taskStatusView } from './tasks-screen.tsx'
import { WorkflowCanvasView } from './workflow-canvas-view.tsx'
import { WorkflowDependencyView } from './workflow-dependency-view.tsx'
import { TaskStepOverview, useRunStepSnapshot } from './task-step-overview.tsx'

export function TaskFlowView({ api, tasks, onOpenTask, reloadVersion, reworkEnabled, queue = false }: {
  api: ResourcesApi; tasks: TaskSummary[]; onOpenTask: (taskId: string, trigger: HTMLButtonElement, runId?: string) => void; reloadVersion: number; reworkEnabled?: boolean
  queue?: boolean
}) {
  const [selection, setSelection] = useState('')
  const available = queue ? tasks.filter((task) => task.current_run_id) : tasks
  const selected = available.find((task) => task.task_id === selection)
    ?? available.find((task) => task.lane === 'running' || task.current_run_status === 'running')
    ?? available[0]
  if (!selected) return queue ? <p className="task-flow-empty">当前列表中没有已创建运行的任务。</p> : null
  return <div className="task-flow-view">
    <nav className="task-flow-picker" aria-label={queue ? '选择任务查看队列' : '选择任务流程'}>
      <header className="task-flow-section-head"><strong>任务</strong><span>{tasks.length} 项</span></header>
      {available.map((task) => <button key={task.task_id} className="task-flow-pick" type="button" aria-pressed={task === selected}
        onClick={() => setSelection(task.task_id)}>
        <span className="task-flow-pick-meta"><span className="task-type-badge">{taskOriginLabel(task)}</span>
          <span>{taskCardStatus(task).label ?? task.status}</span></span>
        <strong>{task.title || '未命名任务'}</strong>
        <span>{task.attention_reason || `${task.run_count} 次运行`}</span>
        {task.next_trigger_at && <span>下次 · {formatTaskDate(task.next_trigger_at)}</span>}
      </button>)}
    </nav>
    {queue ? <TaskRunQueue api={api} task={selected} reloadVersion={reloadVersion} />
      : <TaskRunFlow key={`${selected.task_id}:${selected.current_run_id ?? ''}:${selected.workflow_version ?? ''}`}
        reworkEnabled={reworkEnabled} api={api} task={selected} reloadVersion={reloadVersion} onOpenTask={(trigger, runId) => onOpenTask(selected.task_id, trigger, runId)} />}
  </div>
}

function TaskRunQueue({ api, task, reloadVersion }: { api: ResourcesApi; task: TaskSummary; reloadVersion: number }) {
  const { nodes, failed, refresh } = useRunStepSnapshot(api, task.current_run_id, reloadVersion)
  return <section className="task-flow-main" aria-label="任务队列">
    <header className="task-flow-run-head">
      <h2>队列 · {task.title || '未命名任务'}</h2>
      <p>按所选任务的当前运行查看步骤。</p>
    </header>
    {failed ? <p role="alert" className="task-flow-empty">队列读取失败。<button className="task-quiet-button" type="button" onClick={refresh}>重试</button></p>
      : !nodes ? <p role="status" className="task-flow-empty">正在读取队列…</p>
        : <TaskStepOverview nodes={nodes} queue />}
  </section>
}

function TaskRunFlow({ api, task, reloadVersion, onOpenTask, reworkEnabled }: {
  api: ResourcesApi; task: TaskSummary; reworkEnabled?: boolean; reloadVersion: number; onOpenTask: (trigger: HTMLButtonElement, runId?: string) => void
}) {
  const [run, setRun] = useState<RunSummary>()
  const [runError, setRunError] = useState(false)
  const [retry, setRetry] = useState(0)
  const { nodes, failed: nodeError, refresh: refreshNodes } = useRunStepSnapshot(api, task.current_run_id, reloadVersion)
  useEffect(() => {
    if (!task.current_run_id) return
    let current = true
    setRunError(false)
    void api.getRun(task.current_run_id).then(({ data }) => {
      if (data.task_id !== task.task_id) throw new Error('运行归属已变化')
      if (current) setRun(data)
    }).catch(() => { if (current) setRunError(true) })
    return () => { current = false }
  }, [api, task.task_id, task.current_run_id, reloadVersion, retry])

  const workflow = usePinnedWorkflow(api, task.current_run_id ? run?.workflow_id : task.workflow_id,
    task.current_run_id ? run?.workflow_version : task.workflow_version)
  const topology = useRunTopology(api, task.current_run_id ?? undefined, Boolean(reworkEnabled), reloadVersion + retry)
  const runtimeDoc = runtimeCanvasDoc(workflow?.definition, topology.data)
  const outcome = run ? taskStatusView(run.status, run.display_status).label ?? run.status : null
  const duration = runDuration(run?.started_at, run?.ended_at)
  const hasRun = Boolean(task.current_run_id)
  return <section className="task-flow-main" aria-label="任务运行流程">
    <header className="task-flow-run-head">
      <div className="task-flow-pick-meta"><span className="task-type-badge">{taskOriginLabel(task)}</span>
        <span>{taskAutonomyLabel(task)} · {task.run_count} 次运行</span>
      </div>
      <h2>{task.title || '未命名任务'}</h2>
      <p>{task.attention_reason || (run ? '查看本次运行的步骤与证据。' : '还没有运行记录。')}</p>
      {(run || task.next_trigger_at || task.trigger_enabled === false) && <dl className="task-run-facts">
        {run && <div><dt>最近运行</dt><dd>{outcome}{run.settling ? ' · 正在收尾' : ''}</dd></div>}
        {run && <div><dt>开始时间</dt><dd>{run.started_at ? formatTaskDate(run.started_at) : '暂无开始记录'}</dd></div>}
        {duration && <div><dt>用时</dt><dd>{duration}</dd></div>}
        {task.next_trigger_at && <div><dt>下次触发</dt><dd>{formatTaskDate(task.next_trigger_at)}</dd></div>}
        {task.trigger_enabled === false && <div><dt>触发器</dt><dd>已暂停</dd></div>}
      </dl>}
      <button type="button" className="task-quiet-button" onClick={(event) => onOpenTask(event.currentTarget)}>打开任务详情</button>
    </header>
    {runError && <p role="alert" className="task-flow-empty">运行信息读取失败。<button className="task-quiet-button" type="button" onClick={() => setRetry((n) => n + 1)}>重试</button></p>}
    {nodeError && <p role="alert" className="task-flow-empty">执行步骤读取失败。<button className="task-quiet-button" type="button" onClick={refreshNodes}>重试</button></p>}
    {runtimeDoc && !topology.failed && !topology.loading && <WorkflowDependencyView doc={runtimeDoc} nodes={nodes} />}
    {hasRun && !nodes && !nodeError && <p role="status" className="task-flow-empty">正在读取执行步骤…</p>}
    {(!hasRun || nodes) && <TaskRunSteps nodes={nodes ?? []} doc={runtimeDoc} run={run}
      onOpenRun={run ? (trigger) => onOpenTask(trigger, run.run_id) : undefined}
      renderEvidence={(node) => <><ExecutionHistory key={node.node_run_id} api={api} nodeId={node.node_run_id} reloadVersion={reloadVersion} />
        <section><h4>执行证据</h4><NodeEvidence key={node.node_run_id} api={api} node={node} reloadVersion={reloadVersion} /></section></>} />}
    {reworkEnabled && task.current_run_id && <ReworkPanel api={api} runId={task.current_run_id} reloadVersion={reloadVersion} compact />}
    {workflow?.error && <p className="task-flow-empty" role="status">当前固定版本的流程定义暂时不可读取。</p>}
    {topology.loading && <p role="status">正在读取本次运行拓扑…</p>}
    {topology.failed && <p role="alert">运行拓扑读取失败，请刷新后重试。</p>}
    {workflow?.doc && !topology.failed && !topology.loading && <details className="task-flow-graph">
      <summary>{reworkEnabled ? '查看本次运行流程图' : '查看固定流程图'} · {workflow.doc.name || '流程'} v{run?.workflow_version ?? task.workflow_version}</summary>
      <WorkflowCanvasView definition={workflow.definition} readOnly runtimeCompact inspectNodes runtimeTopology={topology.data} canvasId="task-run-flow" runtimeNodes={nodeError ? undefined : nodes} />
    </details>}
  </section>
}
