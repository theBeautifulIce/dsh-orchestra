import { useEffect, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { TaskNextAction, TaskSummary, WorkflowListItem } from '../api/types.ts'
import type { WorkspaceOverview } from '../../service/queries/tasks.ts'
import { operatorReason } from '../../core/operator-language.ts'
import { ActivityList } from './activity-screen.tsx'
import type { PanelRoute } from './shell.tsx'
import { COLOR } from './tokens.ts'
import { COPY } from './copy.ts'
import { GateCard } from './gate-card.tsx'
import { taskCardStatus, taskOriginLabel } from './tasks-screen.tsx'
import { OVERVIEW_LAYOUT_CSS } from './overview-layout.ts'

type OverviewProps = {
  api: ResourcesApi
  reloadVersion: number
  onSnapshot: (seq: number) => void
  onNavigate: (route: PanelRoute) => void
  onSelectTask?: (taskId: string, trigger: HTMLButtonElement, runId?: string, action?: TaskNextAction) => void
}

type OverviewData = {
  summary: WorkspaceOverview
  workflows: WorkflowListItem[]
  attention: TaskSummary[]
  finished: TaskSummary[]
  running: TaskSummary[]
}

export function OverviewScreen({ api, reloadVersion, onSnapshot, onNavigate, onSelectTask }: OverviewProps) {
  const [data, setData] = useState<OverviewData | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [retry, refresh] = useState(0)
  useEffect(() => {
    let current = true
    setFailed(false)
    setLoading(true)
    // Only the complete read group can acknowledge this view's snapshot. A successful
    // activity request must not make a failed or older task summary look synchronized.
    void Promise.all([
      api.getWorkspaceOverview(),
      api.listWorkflows({ limit: 4 }),
      api.listTasks({ lane: 'attention', limit: 4 }),
      api.listTasks({ lane: 'finished', limit: 4 }),
      api.listTasks({ lane: 'running', limit: 4 }),
    ]).then(([overview, workflows, attention, finished, running]) => {
      if (!current) return
      setData({ summary: overview.data, workflows: workflows.data.items,
        attention: attention.data.items, finished: finished.data.items, running: running.data.items })
      onSnapshot(Math.min(overview.as_of_seq, workflows.as_of_seq, attention.as_of_seq, finished.as_of_seq, running.as_of_seq))
    }).catch(() => { if (current) setFailed(true) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, onSnapshot, reloadVersion, retry])

  const lanes = data?.summary.lanes
  const openTask: NonNullable<OverviewProps['onSelectTask']> = (taskId, trigger, runId, action) => {
    if (onSelectTask) onSelectTask(taskId, trigger, runId, action)
    else onNavigate('tasks')
  }

  return <section aria-labelledby="overview-title" className="ops-page ops-overview">
    <style>{OVERVIEW_LAYOUT_CSS}</style>
    <header className="ops-page-header">
      <div><p className="ops-overview-eyebrow">ORCHESTRA WORKSPACE</p><h1 id="overview-title">总览</h1>
        <p className="ops-overview-intro">从需要你确认的事项开始，查看任务进展和交付结果。</p></div>
      <button type="button" className="ops-button" onClick={() => onNavigate('tasks')}>打开任务工作台 <span aria-hidden="true">↗</span></button>
    </header>
    {failed && <div role="alert" className="ops-overview-notice">
      <span>{data ? '总览读取失败，以下内容可能不是最新状态。' : '总览读取失败。'}</span>
      <button type="button" className="ops-button" onClick={() => refresh((value) => value + 1)}>重试</button>
    </div>}
    {!failed && loading && <p role="status" className="ops-meta">{data ? '正在更新总览…' : '正在读取总览…'}</p>}
    {data?.summary.release_gate && <GateCard state={data.summary.release_gate} />}

    {data && lanes && <>
      <section aria-labelledby="overview-attention-title" className="ops-overview-section">
        <header className="ops-overview-section-head"><div><h2 id="overview-attention-title">需要你处理</h2>
          <p className="ops-meta">审批、操作核验与任务待办分别保留上下文。</p></div></header>
        <div className="ops-overview-signals">
          <AttentionSignal count={data.summary.open_decisions} label="待审批" hint="确认授权与下一步决定"
            tone="warning" onClick={() => onNavigate('decisions')} />
          <AttentionSignal count={data.summary.unverified_effects} label="待核实" hint="核对外部操作的实际结果"
            tone="warning" onClick={() => onNavigate('effects')} />
          <AttentionSignal count={lanes.attention} label="待处理任务" hint="查看验收、返工和执行异常"
            tone="blue" onClick={() => onNavigate('tasks')} />
        </div>
        <div className="ops-surface ops-overview-task-list" data-overview-lane="attention">
          {data.attention.length > 0 ? data.attention.map((task) => <OverviewTask key={task.task_id} task={task} onSelect={openTask} />)
            : <p className="ops-overview-empty">当前没有待处理任务。审批与操作核验事项可从上方入口查看。</p>}
        </div>
      </section>

      <div className="ops-overview-columns">
        <section className="ops-surface" aria-labelledby="overview-results-title" data-overview-lane="finished">
          <header className="ops-surface-head"><div><h2 id="overview-results-title">最近结束的任务</h2>
            <p className="ops-meta">查看各项任务的结束状态与实际成果。</p></div>
            <button type="button" className="ops-overview-link" onClick={() => onNavigate('tasks')}>全部任务 <span aria-hidden="true">→</span></button>
          </header>
          {data.finished.length > 0 ? data.finished.map((task) => <OverviewTask key={task.task_id} task={task} onSelect={openTask} />)
            : <p className="ops-overview-empty">还没有已结束的任务。</p>}
        </section>
        <section className="ops-surface" aria-labelledby="overview-running-title" data-overview-lane="running">
          <header className="ops-surface-head"><div><h2 id="overview-running-title">正在推进</h2>
            <p className="ops-meta">{lanes.running} 项执行中 · {lanes.upcoming} 项待执行</p></div>
            <span className="ops-status">执行中</span>
          </header>
          {data.running.length > 0 ? data.running.map((task) => <OverviewTask key={task.task_id} task={task} onSelect={openTask} />)
            : <p className="ops-overview-empty">当前没有执行中的任务。</p>}
        </section>
      </div>

      <section className="ops-overview-section" aria-labelledby="overview-workspace-title">
        <header className="ops-overview-section-head"><h2 id="overview-workspace-title">工作区</h2>
          <p className="ops-meta">{lanes.upcoming + lanes.running + lanes.attention + lanes.finished} 项未归档任务</p></header>
        <div className="ops-overview-shortcuts">
          <Shortcut title="Workflow 管理" description="维护流程草稿、校验与发布版本" onClick={() => onNavigate('workflows')} />
          <Shortcut title="任务记忆" description="查看经验提议、来源和写入结果" onClick={() => onNavigate('memory')} />
          <Shortcut title="设置" description="管理模型、执行与显示偏好" onClick={() => onNavigate('settings')} />
        </div>
      </section>
    </>}

    <div className="ops-overview-columns">
      <section className="ops-surface ops-overview-activity" aria-labelledby="overview-activity-title">
        <header className="ops-surface-head"><h2 id="overview-activity-title">近期事件</h2>
          <button type="button" className="ops-overview-link" onClick={() => onNavigate('activity')}>全部记录 <span aria-hidden="true">→</span></button></header>
        <div className="ops-inset"><ActivityList api={api} reloadVersion={reloadVersion} compact /></div>
      </section>
      <section className="ops-surface" aria-labelledby="overview-workflows-title">
        <header className="ops-surface-head"><h2 id="overview-workflows-title">Workflow</h2>
          <button type="button" className="ops-overview-link" onClick={() => onNavigate('workflows')}>查看全部 <span aria-hidden="true">→</span></button></header>
        {data?.workflows.length === 0 && <p className="ops-overview-empty">当前没有流程。</p>}
        {data?.workflows.map((workflow) => <div key={workflow.workflow_id} className="ops-overview-workflow">
          <div><strong>{workflow.name}</strong><p className="ops-meta">{workflow.node_count ?? '未知'} 个节点 · {workflow.active_task_count} 个活跃任务</p></div>
          <span className="ops-status">{workflow.current_version === null ? '待发布' : `v${workflow.current_version}`}</span>
        </div>)}
        {!data && <p className="ops-overview-empty">{failed ? '流程列表暂不可用，请重试总览。' : '正在读取流程…'}</p>}
      </section>
    </div>
  </section>
}

function AttentionSignal({ count, label, hint, tone, onClick }: {
  count: number; label: string; hint: string; tone: 'warning' | 'blue'; onClick: () => void
}) {
  return <button type="button" className="ops-overview-signal" data-tone={count > 0 ? tone : 'neutral'} onClick={onClick}>
    <span className="ops-overview-signal-top"><span>{label}</span><span aria-hidden="true">↗</span></span>
    <strong>{count}</strong><span className="ops-meta">{hint}</span>
  </button>
}

function Shortcut({ title, description, onClick }: { title: string; description: string; onClick: () => void }) {
  return <button type="button" className="ops-overview-shortcut" onClick={onClick}>
    <span><strong>{title}</strong><span className="ops-meta">{description}</span></span><span aria-hidden="true">→</span>
  </button>
}

function OverviewTask({ task, onSelect }: {
  task: TaskSummary; onSelect: NonNullable<OverviewProps['onSelectTask']>
}) {
  const status = taskCardStatus(task)
  const action = task.next_action
  const progress = typeof task.step_total === 'number' && task.step_total > 0
    && typeof task.step_done === 'number' && task.step_done >= 0 && task.step_done <= task.step_total
    ? { total: task.step_total, done: task.step_done } : null
  return <article className="ops-overview-task" data-task-id={task.task_id}>
    <div className="ops-overview-task-body">
      <div className="ops-overview-task-heading">
        <button type="button" className="ops-overview-task-title" onClick={(event) => onSelect(task.task_id, event.currentTarget, task.current_run_id ?? undefined)}>{task.title}</button>
        <span className="ops-status" style={{ color: status.tone ?? COLOR.inkMuted }}>{status.label ?? COPY.oldPanel}</span>
      </div>
      {task.attention_reason && <p className="ops-overview-task-reason">{operatorReason(task.attention_reason)}</p>}
      <div className="ops-overview-task-meta"><span>{taskOriginLabel(task)}</span>
        <time dateTime={task.updated_at}>{new Date(task.updated_at).toLocaleString()}</time>
        {progress && <span>{progress.done} / {progress.total} 步骤</span>}
      </div>
      {progress && task.lane === 'running' && <div className="ops-overview-progress" role="progressbar" aria-label={`${task.title}的步骤进度`}
        aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
        <span style={{ width: `${progress.done / progress.total * 100}%` }} />
      </div>}
    </div>
    {action && <button type="button" className="ops-button ops-overview-task-action" data-task-primary-action={action.kind}
      onClick={(event) => onSelect(task.task_id, event.currentTarget, action.run_id ?? undefined, action)}>{action.label} <span aria-hidden="true">→</span></button>}
  </article>
}
