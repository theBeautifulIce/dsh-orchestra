import { useEffect, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { NodeRunView, RunSummary, TaskSummary } from '../api/types.ts'
import { TaskRunSteps, formatTaskDate, runDuration, usePinnedWorkflow } from './task-run-steps.tsx'
import { NodeEvidence } from './task-run-evidence.tsx'
import { taskAutonomyLabel, taskCardStatus, taskOriginLabel, taskStatusView } from './tasks-screen.tsx'
import { WorkflowCanvasView } from './workflow-canvas-view.tsx'

export function TaskFlowView({ api, tasks, onOpenTask, reloadVersion }: {
  api: ResourcesApi; tasks: TaskSummary[]; onOpenTask: (taskId: string, trigger: HTMLButtonElement, runId?: string) => void; reloadVersion: number
}) {
  const [selection, setSelection] = useState('')
  const selected = tasks.find((task) => task.task_id === selection)
    ?? tasks.find((task) => task.lane === 'running' || task.current_run_status === 'running')
    ?? tasks[0]
  if (!selected) return null
  return <div className="task-flow-view">
    <nav className="task-flow-picker" aria-label="选择任务流程">
      <header className="task-flow-section-head"><strong>任务</strong><span>{tasks.length} 项</span></header>
      {tasks.map((task) => <button key={task.task_id} className="task-flow-pick" type="button" aria-pressed={task === selected}
        onClick={() => setSelection(task.task_id)}>
        <span className="task-flow-pick-meta"><span className="task-type-badge">{taskOriginLabel(task)}</span>
          <span>{taskCardStatus(task).label ?? task.status}</span></span>
        <strong>{task.title || '未命名任务'}</strong>
        <span>{task.attention_reason || `${task.run_count} 次运行`}</span>
        {task.next_trigger_at && <span>下次 · {formatTaskDate(task.next_trigger_at)}</span>}
      </button>)}
    </nav>
    <TaskRunFlow key={`${selected.task_id}:${selected.current_run_id ?? ''}:${selected.workflow_version ?? ''}`}
      api={api} task={selected} reloadVersion={reloadVersion} onOpenTask={(trigger, runId) => onOpenTask(selected.task_id, trigger, runId)} />
  </div>
}

function TaskRunFlow({ api, task, reloadVersion, onOpenTask }: {
  api: ResourcesApi; task: TaskSummary; reloadVersion: number; onOpenTask: (trigger: HTMLButtonElement, runId?: string) => void
}) {
  const [run, setRun] = useState<RunSummary>()
  const [nodes, setNodes] = useState<NodeRunView[]>()
  const [nodeError, setNodeError] = useState(false)
  const [runError, setRunError] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!task.current_run_id) return
    let current = true
    setNodeError(false)
    setRunError(false)
    void api.getRun(task.current_run_id).then(({ data }) => {
      if (data.task_id !== task.task_id) throw new Error('运行归属已变化')
      if (current) setRun(data)
    }).catch(() => { if (current) setRunError(true) })
    void api.listNodes(task.current_run_id, 200).then(({ data }) => {
      if (current) setNodes(data.items)
    }).catch(() => { if (current) setNodeError(true) })
    return () => { current = false }
  }, [api, task.task_id, task.current_run_id, reloadVersion, retry])

  const workflow = usePinnedWorkflow(api, task.current_run_id ? run?.workflow_id : task.workflow_id,
    task.current_run_id ? run?.workflow_version : task.workflow_version)
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
        {task.next_trigger_at && <div><dt>下次唤醒</dt><dd>{formatTaskDate(task.next_trigger_at)}</dd></div>}
        {task.trigger_enabled === false && <div><dt>触发器</dt><dd>已暂停</dd></div>}
      </dl>}
      <button type="button" className="task-quiet-button" onClick={(event) => onOpenTask(event.currentTarget)}>打开任务详情</button>
    </header>
    {runError && <p role="alert" className="task-flow-empty">运行信息读取失败。<button className="task-quiet-button" type="button" onClick={() => setRetry((n) => n + 1)}>重试</button></p>}
    {nodeError && <p role="alert" className="task-flow-empty">执行步骤读取失败。<button className="task-quiet-button" type="button" onClick={() => setRetry((n) => n + 1)}>重试</button></p>}
    {hasRun && !nodes && !nodeError && <p role="status" className="task-flow-empty">正在读取执行步骤…</p>}
    {(!hasRun || nodes) && <TaskRunSteps nodes={nodes ?? []} doc={workflow?.doc} run={run}
      onOpenRun={run ? (trigger) => onOpenTask(trigger, run.run_id) : undefined}
      renderEvidence={(node) => <section>
        <h4>证据</h4>
        <NodeEvidence key={node.node_run_id} api={api} node={node} reloadVersion={reloadVersion} />
      </section>} />}
    {workflow?.error && <p className="task-flow-empty" role="status">当前固定版本的流程定义暂时不可读取。</p>}
    {workflow?.doc && <details className="task-flow-graph">
      <summary>查看固定流程图 · {workflow.doc.name || '流程'} v{run?.workflow_version ?? task.workflow_version}</summary>
      <WorkflowCanvasView definition={workflow.definition} readOnly runtimeCompact canvasId="task-run-flow" runtimeNodes={nodeError ? undefined : nodes} />
    </details>}
  </section>
}
