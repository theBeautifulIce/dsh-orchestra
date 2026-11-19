import { runtimeCanvasDoc, useRunTopology } from './runtime-topology.ts'
import { ReworkPanel } from './rework-panel.tsx'
import type { ReworkApi } from '../api/rework.ts'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client.ts'
import type { TaskCommands } from '../api/task-commands.ts'
import type { createTaskTriggerCommands } from '../api/task-trigger-commands.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import type { TaskTriggerView } from '../../core/task-trigger.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { NodeRunView, RunSummary, TaskSummary } from '../api/types.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { PanelCommandButton, UnknownState } from './shell.tsx'
import { taskAutonomyLabel, taskCardStatus, taskOriginLabel, taskStatusView } from './tasks-screen.tsx'
import { TASK_INSPECTOR_CSS } from './task-workspace-styles.ts'
import { ActivityList } from './activity-screen.tsx'
import { ExecutionHistory } from './execution-history.tsx'
import { ArtifactContent } from './artifact-content.tsx'
import { TaskPlanBrief } from './task-plan-form.tsx'
import { TaskRunSteps, formatTaskDate, runDuration, usePinnedWorkflow } from './task-run-steps.tsx'
import { NodeEffectFacts, NodeEvidence } from './task-run-evidence.tsx'
import { WorkflowCanvasView } from './workflow-canvas-view.tsx'

export type TaskDetailScreenProps = {
  api: ResourcesApi
  taskId: string
  initialRunId?: string
  onBack: () => void
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
  rework?: ReworkApi
  reworkPlannerEnabled?: boolean
  taskCommands?: TaskCommands
  triggerCommands?: Pick<ReturnType<typeof createTaskTriggerCommands>, 'setEnabled'>
  onArchiveChanged?: () => void
  onOpenMemory?: () => void
  onOpenDecision?: (id: string) => void
}
type DetailData = { task: TaskSummary; runs: RunSummary[]; next: string | null }
const TASK_TABS = ['概览', '运行', '编排', '事件'] as const
const RUN_TABS = ['步骤', '结果', '证据', '事件'] as const
type TaskTab = (typeof TASK_TABS)[number]
type RunTab = (typeof RUN_TABS)[number]

/** 心跳超过这个秒数就提示「心跳已停 X 秒」；只影响显示，不改节点状态。 */
const HEARTBEAT_STALE_SECONDS = 30

/** 收口后的节点不再提示心跳：已结束的事实优先，状态文字保持原样。 */
const NODE_TERMINAL_STATUSES = new Set([
  'done', 'failed', 'timeout', 'abandoned_unverified', 'failed_with_unverified', 'orphaned', 'superseded',
])

export function TaskDetailScreen({
  api, taskId, initialRunId, onBack, reloadVersion = 0, onSnapshot, rework, reworkPlannerEnabled, taskCommands, triggerCommands, onArchiveChanged, onOpenMemory, onOpenDecision,
}: TaskDetailScreenProps) {
  const [data, setData] = useState<DetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [taskTab, setTaskTab] = useState<TaskTab>('概览')
  const [runTab, setRunTab] = useState<RunTab>('步骤')
  const [runSelection, setRunSelection] = useState<RunSummary>()
  const [showRun, setShowRun] = useState(Boolean(initialRunId))
  const close = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    close.current?.focus({ preventScroll: true })
    return () => { if (element.open && typeof element.close === 'function') element.close() }
  }, [])
  useEffect(() => {
    setShowRun(Boolean(initialRunId))
    setRunSelection(undefined)
    setRunTab('步骤')
  }, [initialRunId, taskId])

  useEffect(() => {
    let current = true
    setLoading(true)
    setFailed(false)
    void Promise.all([api.getTask(taskId), api.listRuns({ task_id: taskId, limit: 50 }),
      initialRunId ? api.getRun(initialRunId) : null]).then(([taskResult, runsResult, pinned]) => {
      if (!current) return
      if (pinned && pinned.data.task_id !== taskId) throw new Error('运行归属已变化')
      setData({ task: taskResult.data, runs: runsResult.data.items, next: runsResult.data.next_cursor ?? null })
      if (pinned) setRunSelection((selection) => !selection || selection.run_id === pinned.data.run_id ? pinned.data : selection)
      onSnapshot?.(Math.max(taskResult.as_of_seq, runsResult.as_of_seq, pinned?.as_of_seq ?? 0))
    }).catch(() => {
      if (current) setFailed(true)
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [api, taskId, initialRunId, reload, reloadVersion, onSnapshot])

  const task = data?.task
  const taskState = task ? taskCardStatus(task) : null
  const latest = data?.runs.find((item) => item.run_id === task?.current_run_id) ?? data?.runs[0]
  const run = data?.runs.find((item) => item.run_id === runSelection?.run_id) ?? runSelection
  const resetScroll = () => { if (body.current) body.current.scrollTop = 0 }
  const closeDetail = () => { dialog.current?.close?.(); onBack() }
  const returnToTask = () => { setShowRun(false); resetScroll() }
  const openRun = (selected: RunSummary) => {
    setRunSelection(selected)
    setRunTab('步骤')
    setShowRun(true)
    resetScroll()
  }
  return <dialog ref={dialog} id="task-inspector" className="task-inspector" aria-labelledby="task-detail-title"
    onCancel={(event) => { event.preventDefault(); closeDetail() }}>
    <style>{TASK_INSPECTOR_CSS}</style>
    <header className="task-inspector-top">
      <div className="task-inspector-heading">
        <div><p className="task-inspector-kicker">{showRun ? '这次运行' : '任务'}</p>
          <h2 id="task-detail-title" style={titleStyle}>{task?.title || '任务详情'}</h2></div>
        <button ref={close} type="button" onClick={closeDetail} style={quietButtonStyle} aria-label="关闭任务详情">关闭</button>
      </div>
      {task && <div className="task-inspector-badges">
        <span className="task-type-badge">{taskOriginLabel(showRun && run ? run : task)}</span>
        {showRun && run ? <RunStatusLabel status={run.status} displayStatus={run.display_status} />
          : taskState?.label ? <span style={{ color: taskState.tone }}>{taskState.label}</span>
            : <UnknownState value={task.display_status || task.status} />}
        <span>{showRun && run ? formatTaskDate(run.started_at ?? run.created_at) : taskAutonomyLabel(task)}</span>
        {task.archived_at && <span className="task-type-badge">已归档</span>}
      </div>}
      {showRun ? <div className="task-inspector-tabs" role="group" aria-label="运行详情视图">
        {RUN_TABS.map((label) => <button key={label} type="button" aria-pressed={runTab === label} onClick={() => { setRunTab(label); resetScroll() }}>{label}</button>)}
      </div> : <div className="task-inspector-tabs" role="group" aria-label="任务详情视图">
        {TASK_TABS.map((label) => <button key={label} type="button" aria-pressed={taskTab === label} onClick={() => { setTaskTab(label); resetScroll() }}>
          {label}{label === '运行' && task && <span aria-hidden="true"> · {task.run_count}</span>}
        </button>)}
      </div>}
    </header>
    <div className="task-inspector-content" ref={body}>
      {loading && !data && <p role="status" style={mutedStyle}>正在读取任务详情…</p>}
      {failed && <ReadError onRetry={() => setReload((n) => n + 1)} />}
      {showRun && <div className="task-inspector-back"><button className="task-quiet-button" type="button" onClick={returnToTask}>返回任务</button></div>}
      {showRun && task && run && <>
        {rework && <ReworkPanel api={api} commands={rework} runId={run.run_id} plannerEnabled={reworkPlannerEnabled} reloadVersion={reloadVersion} onSnapshot={onSnapshot} />}
        <RunDetails key={run.run_id} run={run} task={task} api={api} tab={runTab} reloadVersion={reloadVersion} onSnapshot={onSnapshot} onOpenDecision={onOpenDecision} />
        {runTab === '结果' && run.status === 'succeeded' && run.run_id === task.current_run_id && taskCommands && onOpenMemory
          && <StartMemory key={run.run_id} runId={run.run_id} commands={taskCommands} onOpenMemory={onOpenMemory} />}
      </>}
      {!showRun && data && <>
        {taskTab === '概览' && latest && rework && <ReworkPanel api={api} commands={rework} runId={latest.run_id} plannerEnabled={reworkPlannerEnabled} reloadVersion={reloadVersion} onSnapshot={onSnapshot} />}
        {taskTab === '概览' && <TaskOverview data={data} latest={latest} api={api} reloadVersion={reloadVersion} commands={taskCommands}
          triggerCommands={triggerCommands} onArchiveChanged={onArchiveChanged} onOpenRun={openRun} />}
        {taskTab === '编排' && <TaskOrchestration reworkEnabled={Boolean(rework)} api={api} task={data.task} run={latest} reloadVersion={reloadVersion}
          onOpenDecision={onOpenDecision} />}
        {taskTab === '事件' && <><h3>任务事件</h3><ActivityList api={api} taskId={taskId} reloadVersion={reloadVersion} />
          <ExecutionHistory api={api} taskId={taskId} reloadVersion={reloadVersion} /></>}
      </>}
      {data && taskTab === '运行' && <div hidden={showRun}><RunHistory data={data} api={api} selectedRunId={run?.run_id} onOpenRun={openRun} /></div>}
    </div>
  </dialog>
}

function TaskOverview({ data, latest, api, reloadVersion, commands, triggerCommands, onArchiveChanged, onOpenRun }: {
  data: DetailData; latest?: RunSummary; api: ResourcesApi; reloadVersion: number; commands?: TaskCommands
  triggerCommands?: TaskDetailScreenProps['triggerCommands']; onArchiveChanged?: () => void; onOpenRun: (run: RunSummary) => void
}) {
  const { task, runs } = data
  const workflow = usePinnedWorkflow(api, latest ? latest.workflow_id : task.workflow_id, latest ? latest.workflow_version : task.workflow_version)
  const nextVersion = latest ? latest.workflow_version : task.workflow_version
  return <>
    <section className="task-drawer-section" aria-label="任务概况">
      <header><h3>目标与验收</h3></header>
      <div className="task-drawer-card">
        <strong>{task.title || '未命名任务'}</strong>
        <TaskPlanBrief api={api} taskId={task.task_id} />
        {task.attention_reason && <p style={mutedStyle}>{task.attention_reason}</p>}
        {workflow?.doc && <p style={mutedStyle}>按固定流程 {workflow.doc.name} v{nextVersion} 执行。</p>}
        <PendingNotices task={task} />
      </div>
    </section>
    {(task.trigger_kind === 'scheduled' || task.trigger_kind === 'event') && <section className="task-drawer-section">
      <header><h3>{task.trigger_kind === 'scheduled' ? '排期与历史运行' : '触发条件与历史运行'}</h3><span className="task-type-badge">一条任务 · 多次运行</span></header>
      <TaskTriggerCard api={api} task={task} commands={triggerCommands} reloadVersion={reloadVersion} />
      {runs.length > 0 && <><p style={mutedStyle}>最近 {Math.min(runs.length, 4)} 次运行</p><RunRows runs={runs.slice(0, 4)} onOpenRun={onOpenRun} /></>}
    </section>}
    <section className="task-drawer-section">
      <header><h3>最近一次运行</h3>{latest && <button className="task-quiet-button" type="button" onClick={() => onOpenRun(latest)}>完整运行</button>}</header>
      <div className="task-drawer-card">
        {latest
          ? <><div><RunStatusLabel status={latest.status} displayStatus={latest.display_status} />{latest.settling ? ' · 正在收尾' : ''}</div>
              <p style={mutedStyle}>{formatTaskDate(latest.started_at ?? latest.created_at)} · {taskOriginLabel(latest)}{durationSuffix(latest)}</p>
              <p style={mutedStyle}>{doneCount(latest)} / {latest.total} 个步骤已完成</p></>
          : <p style={mutedStyle}>这项任务还没有运行记录。</p>}
      </div>
    </section>
    <section className="task-drawer-section">
      <header><h3>编排与资源</h3></header>
      <div className="task-drawer-card">
        <dl className="task-run-facts">
          <div><dt>工作流</dt><dd>{workflow?.doc?.name || latest?.workflow_id || task.workflow_id || '未关联'}</dd></div>
          <div><dt>固定版本</dt><dd>{nextVersion != null ? `v${nextVersion}` : '未记录'}</dd></div>
          <div><dt>自治档位</dt><dd>{taskAutonomyLabel(task)}</dd></div>
        </dl>
      </div>
    </section>
    {(commands || task.archived_at) && <section className="task-drawer-section">
      <header><h3>归档</h3></header>
      <div className="task-drawer-card">
        {task.archived_at && <p style={mutedStyle}>归档于 {formatTaskDate(task.archived_at)}</p>}
        {commands && <ArchiveAction task={task} commands={commands} onChange={onArchiveChanged} />}
      </div>
    </section>}
  </>
}

function TaskTriggerCard({ api, task, commands, reloadVersion }: {
  api: ResourcesApi; task: TaskSummary; commands?: TaskDetailScreenProps['triggerCommands']; reloadVersion: number
}) {
  const [trigger, setTrigger] = useState<TaskTriggerView | null>()
  const [retry, setRetry] = useState(0)
  const [readError, setReadError] = useState(false)
  const [writing, setWriting] = useState(false)
  const [writeError, setWriteError] = useState('')
  const operation = useRef<{ revision: number; id: string }>(undefined)
  useEffect(() => {
    let current = true
    setReadError(false)
    void api.listTaskTriggers({ task_id: task.task_id }).then(({ data }) => {
      if (current) setTrigger(data.items.find((item) => item.task_id === task.task_id) ?? null)
    }).catch(() => { if (current) setReadError(true) })
    return () => { current = false }
  }, [api, reloadVersion, retry, task.task_id])

  async function toggle(item: TaskTriggerView) {
    if (!commands || writing) return
    if (operation.current?.revision !== item.revision) operation.current = { revision: item.revision, id: newOperationId() }
    setWriting(true)
    setWriteError('')
    try {
      await commands.setEnabled(item, !item.enabled, operation.current.id)
      operation.current = undefined
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'OPERATION_OUTCOME_UNKNOWN') operation.current = undefined
      setWriteError(error instanceof Error ? error.message : '触发器状态更新失败。')
    } finally {
      setWriting(false)
      setRetry((count) => count + 1)
    }
  }

  if (readError) return <ReadError onRetry={() => setRetry((count) => count + 1)} />
  if (trigger === undefined) return <p role="status" style={mutedStyle}>正在读取触发配置…</p>
  if (!trigger) return <div className="task-drawer-card task-schedule-card">此任务没有已登记的触发配置。</div>
  const scheduled = trigger.kind === 'scheduled'
  const zone = trigger.time_zone ?? undefined
  return <div className="task-drawer-card task-schedule-card">
    <dl className="task-run-facts">
      <div><dt>{scheduled ? '排期' : '事件类型'}</dt><dd>{scheduled ? `每天 ${trigger.daily_time}` : trigger.event_type}</dd></div>
      <div><dt>{scheduled ? '下次触发' : '触发器状态'}</dt><dd>{!trigger.enabled ? '已暂停'
        : scheduled ? (trigger.next_fire_at ? formatTaskDate(trigger.next_fire_at, zone) : '暂无排期') : '等待匹配事件'}</dd></div>
      {zone && <div><dt>时区</dt><dd>{zone}</dd></div>}
      {trigger.last_fired_at && <div><dt>上次触发</dt><dd>{formatTaskDate(trigger.last_fired_at, zone)}</dd></div>}
    </dl>
    {commands && <PanelCommandButton disabled={writing} style={{ ...quietButtonStyle, marginTop: 9 }} onClick={() => { void toggle(trigger) }}>
      {writing ? '正在更新…' : trigger.enabled ? '暂停触发' : '恢复触发'}
    </PanelCommandButton>}
    {writeError && <p role="alert" style={mutedStyle}>{writeError}</p>}
  </div>
}

function RunHistory({ data, api, selectedRunId, onOpenRun }: {
  data: DetailData; api: ResourcesApi; selectedRunId?: string; onOpenRun: (run: RunSummary) => void
}) {
  const [more, setMore] = useState<RunSummary[]>([])
  const [next, setNext] = useState<string | null>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>()
  const cursor = next === undefined ? data.next : next
  const runs = [...data.runs, ...more.filter((run) => !data.runs.some((recent) => recent.run_id === run.run_id))]
  async function loadMore() {
    if (loading || !cursor) return
    setError(undefined)
    setLoading(true)
    try {
      const { data: page } = await api.listRuns({ task_id: data.task.task_id, limit: 50, cursor })
      setMore((previous) => [...previous, ...page.items])
      setNext(page.next_cursor ?? null)
    } catch (cause) { setError(cause) }
    finally { setLoading(false) }
  }
  return <section className="task-drawer-section">
    <header><h3>全部运行</h3><span className="task-type-badge">同一任务 · {data.task.run_count} 次</span></header>
    {runs.length > 0 ? <RunRows runs={runs} selectedRunId={selectedRunId} onOpenRun={onOpenRun} />
      : <p style={mutedStyle}>这项任务还没有运行记录。</p>}
    {cursor && <button type="button" className="task-quiet-button" disabled={loading} onClick={() => { void loadMore() }}>
      {loading ? '正在读取…' : '加载更早的运行'}
    </button>}
    {error instanceof ApiError && error.code === 'CURSOR_EXPIRED'
      ? <p role="alert">翻页位置已过期。<button type="button" className="task-quiet-button" onClick={() => { setMore([]); setNext(undefined); setError(undefined) }}>返回最近运行</button></p>
      : Boolean(error) && <p role="alert" style={mutedStyle}>读取失败，请重试。</p>}
  </section>
}

function RunRows({ runs, selectedRunId, onOpenRun }: { runs: readonly RunSummary[]; selectedRunId?: string; onOpenRun: (run: RunSummary) => void }) {
  return <div className="task-run-history">{runs.map((run) => <button type="button" key={run.run_id} aria-current={selectedRunId === run.run_id}
    onClick={() => onOpenRun(run)}>
    <span>{formatTaskDate(run.started_at ?? run.created_at)}<small>{taskOriginLabel(run)}</small></span>
    <span><RunStatusLabel status={run.status} displayStatus={run.display_status} /></span>
    <span>{runDuration(run.started_at, run.ended_at) ?? '—'}</span>
  </button>)}</div>
}

function TaskOrchestration({ api, task, run, reloadVersion, reworkEnabled, onOpenDecision }: {
  api: ResourcesApi; task: TaskSummary; run?: RunSummary; reloadVersion: number; reworkEnabled?: boolean; onOpenDecision?: (id: string) => void
}) {
  const workflow = usePinnedWorkflow(api, run ? run.workflow_id : task.workflow_id, run ? run.workflow_version : task.workflow_version)
  const [nodes, setNodes] = useState<NodeRunView[]>()
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!run) return
    let current = true
    setFailed(false)
    void api.listNodes(run.run_id, 200).then(({ data }) => { if (current) setNodes(data.items) })
      .catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [api, run?.run_id, reloadVersion, retry])
  const topology = useRunTopology(api, run?.run_id, Boolean(reworkEnabled), reloadVersion + retry)
  const runtimeDoc = runtimeCanvasDoc(workflow?.definition, topology.data)
  return <section className="task-drawer-section">
    <header><h3>运行拓扑与步骤</h3><span className="task-type-badge">{taskAutonomyLabel(task)}</span></header>
    {failed && <ReadError onRetry={() => setRetry((n) => n + 1)} />}
    {!failed && run && !nodes && <p role="status" style={mutedStyle}>正在读取执行步骤…</p>}
    {workflow?.error && <p role="status" style={mutedStyle}>固定版本流程定义暂时不可读取。</p>}
    {(nodes || !run) && <TaskRunSteps key={run?.run_id ?? 'planned'} nodes={nodes ?? []} doc={runtimeDoc} run={run}
      renderEvidence={(node) => <><ExecutionHistory key={node.node_run_id} api={api} nodeId={node.node_run_id} reloadVersion={reloadVersion} />
        <section><h4>执行证据</h4><NodeEvidence key={node.node_run_id} api={api} node={node} reloadVersion={reloadVersion} onOpenDecision={onOpenDecision} /></section></>} />}
    {topology.loading && <p role="status">正在读取本次运行拓扑…</p>}
    {topology.failed && <p role="alert">运行拓扑读取失败，请刷新后重试。</p>}
    {workflow?.doc && !topology.failed && !topology.loading && <details className="task-flow-graph">
      <summary>{reworkEnabled && run ? '查看本次运行流程图' : '查看固定流程图'} · {workflow.doc.name}</summary>
      <WorkflowCanvasView definition={workflow.definition} readOnly runtimeCompact inspectNodes runtimeTopology={topology.data} canvasId="task-drawer-flow" runtimeNodes={nodes} />
    </details>}
  </section>
}

const doneCount = (run: RunSummary) => run.counts?.find((count) => count.status === 'done')?.count ?? 0
const durationSuffix = (run: RunSummary) => {
  const duration = runDuration(run.started_at, run.ended_at)
  return duration ? ` · 用时 ${duration}` : ''
}

function StartMemory({ runId, commands, onOpenMemory }: { runId: string; commands: TaskCommands; onOpenMemory: () => void }) {
  const [reason, setReason] = useState('')
  const [operationId, setOperationId] = useState<string>()
  const [state, setState] = useState<'idle' | 'busy' | 'unknown' | 'done' | 'error'>('idle')
  const [errorText, setErrorText] = useState('')

  async function submit() {
    const id = operationId ?? newOperationId()
    setOperationId(id)
    setState('busy')
    try {
      await commands.startMemory(runId, reason.trim(), id)
      setState('done')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'OPERATION_OUTCOME_UNKNOWN') {
        setState('unknown')
      } else {
        setOperationId(undefined)
        setState('error')
        setErrorText(error instanceof Error ? error.message : '暂时无法发起记忆整理。')
      }
    }
  }

  return <details style={{ marginTop: 18 }}>
    <summary>整理为记忆</summary>
    {state === 'done'
      ? <><p role="status">已取得整理回执，可在记忆页查看批次状态。</p><button type="button" style={quietButtonStyle} onClick={onOpenMemory}>查看记忆批次</button></>
      : <form onSubmit={(event) => { event.preventDefault(); void submit() }} style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        <label>整理理由 <textarea value={reason} required maxLength={500} disabled={state === 'busy' || state === 'unknown'} onChange={(event) => setReason(event.target.value)} /></label>
        <p style={mutedStyle}>整理结果会进入评估和审批流程。</p>
        {state === 'error' && <p role="alert">{errorText}</p>}
        {state === 'unknown' && <p role="status">结果暂不可确认。再次查询会保留原回执编号。</p>}
        <PanelCommandButton type="submit" disabled={state === 'busy' || !reason.trim()}>{state === 'unknown' ? '查询或重试' : '发起整理'}</PanelCommandButton>
      </form>}
  </details>
}

function ArchiveAction({ task, commands, onChange }: { task: TaskSummary; commands: TaskCommands; onChange?: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const archived = Boolean(task.archived_at)
  async function submit() {
    setBusy(true)
    setNotice('')
    try {
      await commands.setArchived(task.task_id, !archived, task.archived_at ?? null)
      setConfirm(false)
      setNotice(archived ? '已取回任务。' : '已归档，运行记录仍可查看。')
      onChange?.()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '暂时无法确认归档操作。')
      onChange?.()
    } finally { setBusy(false) }
  }
  return <div className="task-archive-actions">
    {!archived && !confirm && <PanelCommandButton style={quietButtonStyle} disabled={busy} onClick={() => setConfirm(true)}>归档任务</PanelCommandButton>}
    {confirm && <p>任务会移入归档箱。已有运行与历史记录会保留。</p>}
    {(archived || confirm) && <PanelCommandButton style={quietButtonStyle} disabled={busy} onClick={() => { void submit() }}>{archived ? '取回任务' : '确认归档'}</PanelCommandButton>}
    {confirm && <button type="button" disabled={busy} style={quietButtonStyle} onClick={() => setConfirm(false)}>取消</button>}
    {notice && <p role="status">{notice}</p>}
  </div>
}

type RunDetailsProps = Pick<TaskDetailScreenProps, 'api' | 'onSnapshot' | 'onOpenDecision'> & {
  run: RunSummary; task: TaskSummary; tab: RunTab; reloadVersion: number
}

function RunDetails({ api, run, task, tab, reloadVersion, onSnapshot, onOpenDecision }: RunDetailsProps) {
  const [nodes, setNodes] = useState<NodeRunView[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    setFailed(false)
    void api.listNodes(run.run_id, 200).then(({ data, as_of_seq }) => {
      if (!current) return
      setNodes(data.items)
      onSnapshot?.(as_of_seq)
    }).catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [api, run.run_id, reloadVersion, onSnapshot, retry])
  return <>
    {run.run_id === task.current_run_id && <PendingNotices task={task} />}
    {tab === '步骤' && <div className="task-drawer-card task-schedule-card">
      <dl className="task-run-facts">
        <div><dt>触发来源</dt><dd>{taskOriginLabel(run)}</dd></div>
        {run.scheduled_for && <div><dt>计划时间</dt><dd>{formatTaskDate(run.scheduled_for)}</dd></div>}
        {run.started_at && <div><dt>开始时间</dt><dd>{formatTaskDate(run.started_at)}</dd></div>}
        {run.ended_at && <div><dt>结束时间</dt><dd>{formatTaskDate(run.ended_at)}</dd></div>}
        <div><dt>运行用时</dt><dd>{runDuration(run.started_at, run.ended_at) ?? '未记录'}</dd></div>
        {run.workflow_version != null && <div><dt>流程版本</dt><dd>v{run.workflow_version}</dd></div>}
      </dl>
    </div>}
    {tab === '结果' && <RunResult api={api} run={run} reloadVersion={reloadVersion} />}
    {tab === '事件' && <><ActivityList api={api} runId={run.run_id} reloadVersion={reloadVersion} />
      <ExecutionHistory api={api} runId={run.run_id} reloadVersion={reloadVersion} /></>}
    {(tab === '步骤' || tab === '证据') && <>
      {failed && <ReadError onRetry={() => setRetry((value) => value + 1)} />}
      {!failed && !nodes && <p role="status" style={mutedStyle}>正在读取执行步骤…</p>}
      {nodes && tab === '步骤' && <section>
        <h3 style={sectionTitleStyle}>执行步骤 · {run.total}</h3>
        <p style={mutedStyle}><RunStatusLabel status={run.status} displayStatus={run.display_status} />{run.settling ? ' · 正在收尾' : ''}</p>
        {nodes.length ? <ol style={stepListStyle}>{nodes.map((node) => <li key={node.node_run_id}><NodeRow node={node} onOpenDecision={onOpenDecision} />
          <NodeHistoryDisclosure api={api} nodeId={node.node_run_id} reloadVersion={reloadVersion} /></li>)}</ol>
          : <p style={mutedStyle}>这次运行没有执行步骤。</p>}
      </section>}
      {nodes && tab === '证据' && <EvidenceList api={api} nodes={nodes} reloadVersion={reloadVersion} onOpenDecision={onOpenDecision} />}
      {nodes && run.total > nodes.length && <p style={mutedStyle}>显示 {nodes.length} / {run.total} 个步骤</p>}
    </>}
  </>
}

function RunResult({ api, run, reloadVersion }: { api: ResourcesApi; run: RunSummary; reloadVersion: number }) {
  const [artifacts, setArtifacts] = useState<Awaited<ReturnType<ResourcesApi['listRunArtifacts']>>['data'] | null>(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    setFailed(false)
    void api.listRunArtifacts(run.run_id).then(({ data }) => { if (current) setArtifacts(data) })
      .catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [api, run.run_id, reloadVersion, retry])
  return <>
    <section style={cardStyle}>
      <h3 style={sectionTitleStyle}>运行结果</h3>
      <div><RunStatusLabel status={run.status} displayStatus={run.display_status} />{run.settling ? ' · 正在收尾' : ''}</div>
      <p style={mutedStyle}>{doneCount(run)} / {run.total} 个步骤已完成</p>
    </section>
    <section>
      <h3 style={sectionTitleStyle}>交付产物</h3>
      {failed && <ReadError onRetry={() => setRetry((value) => value + 1)} />}
      {!failed && !artifacts && <p role="status" style={mutedStyle}>正在读取产物…</p>}
      {artifacts?.items.length === 0 && <p style={mutedStyle}>这次运行尚无产物记录。</p>}
      {artifacts?.items.map((artifact) => <details key={artifact.artifact_id} style={cardStyle}>
        <summary>{artifact.file_name || artifact.artifact_id}{artifact.expired ? ' · 已超过保留期限' : ''}</summary>
        <p style={mutedStyle}>记录于 {formatDate(artifact.created_at)}</p>
        {artifact.retain_until && <p style={mutedStyle}>保留至 {formatDate(artifact.retain_until)}</p>}
        <p style={mutedStyle}>SHA-256 <code>{artifact.sha256}</code></p>
        <ArtifactContent api={api} artifact={artifact} />
      </details>)}
      {artifacts?.has_more && <p style={mutedStyle}>显示最近 50 份产物。</p>}
    </section>
  </>
}

function EvidenceList({ api, nodes, reloadVersion, onOpenDecision }: {
  api: ResourcesApi; nodes: NodeRunView[]; reloadVersion: number; onOpenDecision?: (id: string) => void
}) {
  const evidenced = nodes.filter((node) => node.status === 'done' || node.verified_effect || node.execution_ids?.length || node.attestation_id)
  return <section>
    <h3 style={sectionTitleStyle}>证据记录</h3>
    {evidenced.length === 0 && <p style={mutedStyle}>这次运行尚无关联证据。</p>}
    {evidenced.map((node) => <section key={node.node_run_id} style={cardStyle}>
      <h4 style={evidenceHeadingStyle}>{node.title || node.node_id} · 第 {node.attempt} 次尝试</h4>
      <NodeEvidence api={api} node={node} reloadVersion={reloadVersion} onOpenDecision={onOpenDecision} />
    </section>)}
  </section>
}

function ReadError({ onRetry }: { onRetry: () => void }) {
  return <div role="alert" style={errorStyle}><span>{COPY.queryFailed}</span><button type="button" onClick={onRetry} style={quietButtonStyle}>{COPY.retry}</button></div>
}

function RunStatusLabel({ status, displayStatus }: { status: string; displayStatus: string }) {
  const view = taskStatusView(status, displayStatus)
  return view.label ? <span style={{ color: view.tone }}>{view.label}</span> : <UnknownState value={displayStatus || status} />
}

/** 待裁决与未结算动作同时说清：光说 blocked 让人以为没有要处理的事。 */
function PendingNotices({ task }: { task: TaskSummary }) {
  const parts: string[] = []
  if (task.open_decision_count > 0) parts.push(`${task.open_decision_count} 项${COPY.awaitingDecision}`)
  if (task.unverified_count > 0) parts.push(`${COPY.pendingIrreversible}（${task.unverified_count} ${COPY.unverifiedBadge}）`)
  if (parts.length === 0) return null
  return <p style={attentionStyle}>{parts.join(' · ')}</p>
}

function NodeRow({ node, onOpenDecision }: { node: NodeRunView; onOpenDecision?: (id: string) => void }) {
  const heartbeat = heartbeatNotice(node)
  const assignment = node.model_assignment
  const model = assignment?.usage
  return <article style={nodeStyle}>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
      <strong title={node.node_id}>{node.title || node.node_id}</strong>
      <span>{node.status_label || <UnknownState value={node.status} />}</span>
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 8, color: COLOR.inkMuted, fontSize: FONT_PX.helper }}>
      <span>第 {node.attempt} 次尝试</span>
      {node.execution_count > 0 && <span>{node.execution_count} 条工具执行记录</span>}
      {node.active_decision_ids.length > 0 && <span>{node.active_decision_ids.length} 项{COPY.awaitingDecision}</span>}
      {heartbeat && <span style={{ color: COLOR.warning }}>{heartbeat}</span>}
      {node.projection_missing.length > 0 && <span>部分信息暂不可用</span>}
    </div>
    {(node.declared_effect || node.verified_effect || node.status === 'done') &&
      <NodeEffectFacts node={node} onOpenDecision={onOpenDecision} />}
    {node.hang_reason && <p style={{ margin: '8px 0 0', fontSize: FONT_PX.body }}>{node.hang_reason}</p>}
    {assignment && <div style={mutedStyle}>
      <strong>{model ? '实际执行模型' : assignment.state === 'confirmed' ? '宿主确认模型' : assignment.state === 'rejected' ? '模型未获宿主确认' : '拟用模型'} · {model ? `${model.provider} / ${model.model}` : assignment.model_ref}</strong>
      <p style={mutedStyle}>{({ routine: '常规', standard: '中等', complex: '复杂' })[assignment.complexity]} · {assignment.reason}</p>
      {assignment.settings_revision != null && <p style={mutedStyle}>按用户配置 · 修订 {assignment.settings_revision}</p>}
    </div>}
  </article>
}

function NodeHistoryDisclosure(props: { api: ResourcesApi; nodeId: string; reloadVersion: number }) {
  const [open, setOpen] = useState(false)
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>查看智能体执行日志</summary>
    {open && <ExecutionHistory {...props} />}
  </details>
}

/** 心跳超阈值只加提示，不动节点状态：状态文字一个字不改。 */
function heartbeatNotice(node: NodeRunView): string | null {
  if (!node.heartbeat_at) return null
  if (NODE_TERMINAL_STATUSES.has(node.status)) return null
  const at = Date.parse(node.heartbeat_at)
  if (Number.isNaN(at)) return null
  const seconds = Math.floor((Date.now() - at) / 1000)
  if (seconds <= HEARTBEAT_STALE_SECONDS) return null
  return `${COPY.heartbeatStopped} ${seconds} 秒`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString()
}

const titleStyle = { margin: 0, fontSize: FONT_PX.title, overflowWrap: 'anywhere' as const }
const sectionTitleStyle = { margin: '0 0 8px', fontSize: FONT_PX.body }
const evidenceHeadingStyle = { margin: '0 0 6px', fontSize: FONT_PX.body }
const stepListStyle = { display: 'grid', gap: 8, margin: '9px 0 0', paddingLeft: 23 }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
const attentionStyle = { margin: 0, padding: 9, borderRadius: 8, background: '#fff8e9', color: COLOR.warning, fontSize: FONT_PX.body }
const cardStyle = { minWidth: 0, padding: 11, marginBottom: 6, border: `1px solid ${COLOR.line}`, borderRadius: 8, background: COLOR.surface }
const nodeStyle = { minWidth: 0, padding: 9, border: `1px solid ${COLOR.line}`, borderRadius: 7 }
const quietButtonStyle = { minHeight: 36, justifySelf: 'start' as const, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, borderRadius: 8, background: '#fff1f0', color: COLOR.danger, fontSize: FONT_PX.body } as const
