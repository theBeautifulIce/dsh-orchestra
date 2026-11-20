import { currentAttempts, runtimeCanvasDoc, useRunTopology } from './runtime-topology.ts'
import { ReworkPanel } from './rework-panel.tsx'
import type { ReworkApi } from '../api/rework.ts'
import type { ModelEscalationApi } from '../api/model-escalation.ts'
import { ModelEscalation } from './model-escalation.tsx'
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
import { TaskEventTimeline } from './task-event-timeline.tsx'
import { ExecutionHistory } from './execution-history.tsx'
import { ArtifactContent } from './artifact-content.tsx'
import { TaskPlanBrief } from './task-plan-form.tsx'
import { TaskRunSteps, formatTaskDate, runDuration, usePinnedWorkflow } from './task-run-steps.tsx'
import { NodeEffectFacts, NodeEvidence } from './task-run-evidence.tsx'
import { WorkflowCanvasView } from './workflow-canvas-view.tsx'
import { operatorReason } from '../../core/operator-language.ts'
import { nodeExecutionLabel } from './task-node-status.ts'

export type TaskDetailScreenProps = {
  api: ResourcesApi
  taskId: string
  initialRunId?: string
  onBack: () => void
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
  rework?: ReworkApi
  modelEscalation?: ModelEscalationApi
  reworkPlannerEnabled?: boolean
  taskCommands?: TaskCommands
  triggerCommands?: Pick<ReturnType<typeof createTaskTriggerCommands>, 'setEnabled'>
  onArchiveChanged?: () => void
  onOpenMemory?: () => void
  onOpenDecision?: (id: string) => void
}
type DetailData = { task: TaskSummary; runs: RunSummary[]; next: string | null }
type RunRead = { api: ResourcesApi; taskId: string; runId: string; revision: number; retry: number; run?: RunSummary; failed?: boolean }
const TASK_TABS = ['概览', '运行', '编排', '事件'] as const
const RUN_TABS = ['步骤', '结果', '证据', '事件'] as const
type TaskTab = (typeof TASK_TABS)[number]
type RunTab = (typeof RUN_TABS)[number]

export function TaskDetailScreen({
  api, taskId, initialRunId, onBack, reloadVersion = 0, onSnapshot, rework, modelEscalation, reworkPlannerEnabled, taskCommands, triggerCommands, onArchiveChanged, onOpenMemory, onOpenDecision,
}: TaskDetailScreenProps) {
  const [loaded, setLoaded] = useState<{ api: ResourcesApi; taskId: string; data: DetailData }>()
  const data = loaded?.api === api && loaded.taskId === taskId ? loaded.data : undefined
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [taskTab, setTaskTab] = useState<TaskTab>('概览')
  const [runTab, setRunTab] = useState<RunTab>('步骤')
  const [reviewRunId, setReviewRunId] = useState<string>()
  const [runSelection, setRunSelection] = useState<{ api: ResourcesApi; taskId: string; run: RunSummary }>()
  const [runRead, setRunRead] = useState<RunRead>()
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
    void Promise.all([api.getTask(taskId), api.listRuns({ task_id: taskId, limit: 50 })]).then(([taskResult, runsResult]) => {
      if (!current) return
      setLoaded({ api, taskId, data: { task: taskResult.data, runs: runsResult.data.items, next: runsResult.data.next_cursor ?? null } })
      onSnapshot?.(Math.max(taskResult.as_of_seq, runsResult.as_of_seq))
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
  const selection = runSelection?.api === api && runSelection.taskId === taskId ? runSelection.run : undefined
  const selectedRunId = selection?.run_id ?? initialRunId
  const detail = runRead?.api === api && runRead.taskId === taskId && runRead.runId === selectedRunId ? runRead : undefined
  const detailFailed = detail?.failed && detail.revision === reloadVersion && detail.retry === reload
  const summary = data?.runs.find((item) => item.run_id === selectedRunId) ?? selection
  const run = detail?.run ?? summary
  useEffect(() => {
    if (!showRun || !selectedRunId) return
    let active = true
    const key = { api, taskId, runId: selectedRunId, revision: reloadVersion, retry: reload }
    void api.getRun(selectedRunId).then(({ data }) => {
      if (data.run_id !== selectedRunId || data.task_id !== taskId) throw new Error('运行归属已变化')
      if (active) setRunRead({ ...key, run: data })
    }).catch(() => {
      if (active) setRunRead((last) => ({ ...key, failed: true,
        run: last?.api === api && last.taskId === taskId && last.runId === selectedRunId ? last.run : undefined }))
    })
    return () => { active = false }
  }, [api, taskId, selectedRunId, showRun, reload, reloadVersion])
  const resetScroll = () => { if (body.current) body.current.scrollTop = 0 }
  const closeDetail = () => { dialog.current?.close?.(); onBack() }
  const returnToTask = () => { setShowRun(false); resetScroll() }
  const openRun = (selected: RunSummary) => {
    setRunSelection({ api, taskId, run: selected })
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
        {RUN_TABS.map((label) => <button key={label} type="button" aria-pressed={runTab === label} onClick={() => {
          if (label === '结果') setReviewRunId(selectedRunId)
          setRunTab(label)
          resetScroll()
        }}>{label}</button>)}
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
      {showRun && !failed && detailFailed && <ReadError onRetry={() => setReload((n) => n + 1)} />}
      {showRun && task && run && <>
        <RunDetails key={run.run_id} run={run} task={task} api={api} tab={runTab} reworkEnabled={Boolean(rework)} modelEscalation={modelEscalation}
          reloadVersion={reloadVersion} onSnapshot={onSnapshot} onOpenDecision={onOpenDecision}
          onOpenResult={() => { setReviewRunId(run.run_id); setRunTab('结果'); resetScroll() }} />
        {rework && reviewRunId === run.run_id && <div hidden={runTab !== '结果'}><ReworkPanel key={run.run_id} api={api} commands={rework} runId={run.run_id} plannerEnabled={reworkPlannerEnabled} reloadVersion={reloadVersion} onSnapshot={onSnapshot} /></div>}
        {runTab === '结果' && run.status === 'succeeded' && run.run_id === task.current_run_id && taskCommands && onOpenMemory
          && <StartMemory key={run.run_id} runId={run.run_id} commands={taskCommands} onOpenMemory={onOpenMemory} />}
      </>}
      {!showRun && data && <>
        {taskTab === '概览' && latest && rework && <ReworkPanel api={api} commands={rework} runId={latest.run_id} plannerEnabled={reworkPlannerEnabled} reloadVersion={reloadVersion} onSnapshot={onSnapshot} />}
        {taskTab === '概览' && <TaskOverview data={data} latest={latest} api={api} reloadVersion={reloadVersion} commands={taskCommands}
          triggerCommands={triggerCommands} onArchiveChanged={onArchiveChanged} onOpenRun={openRun} />}
        {taskTab === '编排' && <TaskOrchestration reworkEnabled={Boolean(rework)} api={api} task={data.task} run={latest} reloadVersion={reloadVersion}
          onOpenDecision={onOpenDecision} />}
        {taskTab === '事件' && <TaskEventTimeline api={api} scope={{ taskId }} reloadVersion={reloadVersion} />}
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
        {task.attention_reason && <p style={mutedStyle}>{operatorReason(task.attention_reason)}</p>}
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
          <div><dt>工作流</dt><dd>{workflow?.doc?.name || (latest?.workflow_id || task.workflow_id ? '已关联，名称暂不可用' : '未关联')}</dd></div>
          <div><dt>固定版本</dt><dd>{nextVersion != null ? `v${nextVersion}` : '未记录'}</dd></div>
          <div><dt>自治档位</dt><dd>{taskAutonomyLabel(task)}</dd></div>
        </dl>
        <details><summary>查看任务登记明细</summary>
          <p>任务编号 <code>{task.task_id}</code>{(latest?.workflow_id || task.workflow_id) && <> · 流程编号 <code>{latest?.workflow_id || task.workflow_id}</code></>}</p>
          <p>状态 <code>{task.status}</code>{task.attention_reason && <> · 原因 <code>{task.attention_reason}</code></>}</p>
        </details>
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
  const [snapshot, setSnapshot] = useState<{ runId: string; nodes: NodeRunView[] }>()
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [showGraph, setShowGraph] = useState(false)
  const nodes = snapshot?.runId === run?.run_id ? snapshot?.nodes : undefined
  useEffect(() => {
    if (!run) return
    let current = true
    setFailed(false)
    void api.listNodes(run.run_id, 200).then(({ data }) => { if (current) setSnapshot({ runId: run.run_id, nodes: data.items }) })
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
    {(nodes || !run) && <TaskRunSteps key={run?.run_id ?? 'planned'} nodes={nodes ?? []} doc={runtimeDoc} run={run} onOpenDecision={onOpenDecision}
      renderEvidence={(node) => <><ExecutionHistory key={node.node_run_id} api={api} nodeId={node.node_run_id} reloadVersion={reloadVersion} />
        <section><h4>执行证据</h4><NodeEvidence key={node.node_run_id} api={api} node={node} reloadVersion={reloadVersion} onOpenDecision={onOpenDecision} /></section></>} />}
    {topology.loading && <p role="status">正在读取本次运行拓扑…</p>}
    {topology.failed && <p role="alert">运行拓扑读取失败，请刷新后重试。</p>}
    {workflow?.doc && !topology.failed && !topology.loading && <details className="task-flow-graph" onToggle={(event) => setShowGraph(event.currentTarget.open)}>
      <summary>{reworkEnabled && run ? '查看本次运行流程图' : '查看固定流程图'} · {workflow.doc.name}</summary>
      {showGraph && <WorkflowCanvasView definition={workflow.definition} readOnly runtimeCompact inspectNodes runtimeTopology={topology.data} canvasId="task-drawer-flow" runtimeNodes={nodes} />}
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
        <label>希望下次复用什么？ <textarea value={reason} required maxLength={500} placeholder="例如：保留这次核对数据口径的步骤和验证依据" disabled={state === 'busy' || state === 'unknown'} onChange={(event) => setReason(event.target.value)} /></label>
        <p style={mutedStyle}>系统会从本次运行提议记忆条目。请在审批中心核对，获批条目的写入结果可在「记忆」中查看。</p>
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

type RunDetailsProps = Pick<TaskDetailScreenProps, 'api' | 'onSnapshot' | 'onOpenDecision' | 'modelEscalation'> & {
  run: RunSummary; task: TaskSummary; tab: RunTab; reloadVersion: number; reworkEnabled: boolean; onOpenResult: () => void
}

function RunDetails({ api, run, task, tab, reloadVersion, onSnapshot, onOpenDecision, onOpenResult, modelEscalation, reworkEnabled }: RunDetailsProps) {
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
  const stepsTab = tab === '步骤'
  const verificationStatuses = ['verifying', 'blocked_post']
  const verifying = Boolean(run.counts?.some((item) => item.count > 0 && verificationStatuses.includes(item.status))
    || nodes?.some((node) => verificationStatuses.includes(node.status)))
  const delivery = useRunDelivery(api, run, tab === '结果' || (stepsTab && verifying), verifying, reloadVersion)
  const workflow = usePinnedWorkflow(api, stepsTab ? run.workflow_id : undefined, run.workflow_version)
  const topology = useRunTopology(api, stepsTab ? run.run_id : undefined, reworkEnabled, reloadVersion + retry)
  return <>
    {run.run_id === task.current_run_id && <PendingNotices task={task} />}
    {tab === '步骤' && <div className="task-drawer-card">
      <dl className="task-run-facts">
        <div><dt>触发来源</dt><dd>{taskOriginLabel(run)}</dd></div>
        {run.scheduled_for && <div><dt>计划时间</dt><dd>{formatTaskDate(run.scheduled_for)}</dd></div>}
        {run.started_at && <div><dt>开始时间</dt><dd>{formatTaskDate(run.started_at)}</dd></div>}
        {run.ended_at && <div><dt>结束时间</dt><dd>{formatTaskDate(run.ended_at)}</dd></div>}
        <div><dt>运行用时</dt><dd>{runDuration(run.started_at, run.ended_at) ?? '未记录'}</dd></div>
        {run.workflow_version != null && <div><dt>流程版本</dt><dd>v{run.workflow_version}</dd></div>}
      </dl>
      <details><summary>查看运行登记明细</summary>
        <p>运行编号 <code>{run.run_id}</code> · 状态 <code>{run.status}</code></p>
      </details>
    </div>}
    {tab === '步骤' && verifying && delivery.artifacts && !delivery.failed && <section className="task-drawer-card">
      <h3 style={sectionTitleStyle}>交付进展</h3>
      <DeliveryProgress artifacts={delivery.artifacts} requirements={delivery.requirements} nodes={nodes} />
      <button type="button" className="task-quiet-button" onClick={onOpenResult}>查看交付产物</button>
    </section>}
    {tab === '结果' && <RunResult api={api} run={run} delivery={delivery} verifying={verifying} nodes={nodes} />}
    {tab === '事件' && <TaskEventTimeline api={api} scope={{ runId: run.run_id }} reloadVersion={reloadVersion} />}
    {(tab === '步骤' || tab === '证据') && <>
      {failed && <ReadError onRetry={() => setRetry((value) => value + 1)} />}
      {!failed && !nodes && <p role="status" style={mutedStyle}>正在读取执行步骤…</p>}
      {!failed && nodes && tab === '步骤' && <TaskRunSteps nodes={nodes} run={run} runDetails onOpenDecision={onOpenDecision} onOpenResult={onOpenResult}
        doc={!nodes.length || topology.failed || topology.loading ? null : runtimeCanvasDoc(workflow?.definition, topology.data)}
        renderEvidence={(node) => <>
          {(node.declared_effect || node.verified_effect || node.evidence_state_reason || node.status === 'done') && <NodeEffectFacts node={node} onOpenDecision={onOpenDecision} />}
          {modelEscalation && node.node_type === 'agent' && node.model_assignment && <ModelEscalation api={modelEscalation} node={node} reloadVersion={reloadVersion} />}
          <ExecutionHistory api={api} nodeId={node.node_run_id} reloadVersion={reloadVersion} />
        </>} />}
      {tab === '证据' && <DeliveryChecks checks={run.delivery_checks} />}
      {!failed && nodes && tab === '证据' && <EvidenceList api={api} nodes={nodes} reloadVersion={reloadVersion} onOpenDecision={onOpenDecision} />}
      {run.project_context && <RunProjectContext context={run.project_context} />}
      {!failed && nodes && run.total > nodes.length && <p style={mutedStyle}>仅显示本次读取到的 {nodes.length} 条尝试记录</p>}
    </>}
  </>
}

const PROJECT_SOURCE_STATE = {
  available: '已读取',
  missing: '缺失',
  unavailable: '暂不可读取',
  excluded: '未纳入',
}
const PROJECT_HASH_SCOPE = {
  read_text: '读取的文本',
  excerpt: '读取的片段',
  directory_index: '目录索引',
}

function RunProjectContext({ context }: { context: NonNullable<RunSummary['project_context']> }) {
  const readCount = context.sources.filter((source) => source.status === 'available').length
  const optionalBriefMissing = context.sources.some((source) => source.path === 'ORCHESTRA.md' && source.status === 'missing')
  return <details className="task-drawer-card">
    <summary>本次派单的项目资料{readCount ? ` · 已读取 ${readCount} 项` : optionalBriefMissing ? ' · 未提供可选项目说明' : ''}</summary>
    <p style={mutedStyle}>这些资料提供项目说明。任务指定文件的读取结果可在「执行证据」中查看。</p>
    <ul>
      {context.sources.map((source) => <li key={source.path} style={{ overflowWrap: 'anywhere' }}>
        <strong>{source.path === '.' ? '工作区目录索引' : source.path}</strong> · {source.path === 'ORCHESTRA.md' && source.status === 'missing'
          ? '可选项目说明，未提供' : PROJECT_SOURCE_STATE[source.status] ?? '状态未记录'}
        {source.truncated && (source.status === 'available' ? ' · 已截断' : ' · 超出读取范围')}
      </li>)}
    </ul>
    <details>
      <summary>查看项目资料记录明细</summary>
      <p style={mutedStyle}>资料版本 <code>{context.version}</code> · 账本位置 {context.as_of_seq}</p>
      {context.sources.filter((source) => source.status === 'available' && source.sha256).map((source) => <p key={source.path} style={mutedStyle}>
        {source.path === '.' ? '工作区目录索引' : source.path} · SHA-256{source.sha256_scope && ` · ${PROJECT_HASH_SCOPE[source.sha256_scope] ?? '范围未记录'}`} <code>{source.sha256}</code>
      </p>)}
    </details>
  </details>
}

type RunArtifacts = Awaited<ReturnType<ResourcesApi['listRunArtifacts']>>['data']
type ArtifactRequirement = { fileName: string; minimumBytes: number; nodeId: string }

function useRunDelivery(api: ResourcesApi, run: RunSummary, enabled: boolean, verifying: boolean, reloadVersion: number) {
  const [artifacts, setArtifacts] = useState<RunArtifacts | null>(null)
  const [requirements, setRequirements] = useState<ArtifactRequirement[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let current = true
    setFailed(false)
    setArtifacts(null)
    void api.listRunArtifacts(run.run_id).then(({ data }) => {
      if (!Array.isArray(data?.items) || data.items.some((artifact) => artifact.run_id !== run.run_id)) {
        throw new Error('未读取到本次运行的产物记录')
      }
      if (current) setArtifacts(data)
    })
      .catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [api, enabled, run.run_id, reloadVersion, retry])
  useEffect(() => {
    if (!enabled || !verifying) return
    let current = true
    void api.getTaskPlanForTask(run.task_id).then(({ data }) => {
      if (!current) return
      const matching = data?.launch?.task_id === run.task_id && data.launch.run_id === run.run_id
      setRequirements(matching && Array.isArray(data.proposal?.deliverables) ? data.proposal.deliverables.flatMap(({ acceptance, node_id }) =>
        acceptance.kind === 'artifact' ? [{ fileName: acceptance.file_name, minimumBytes: acceptance.minimum_bytes, nodeId: node_id }] : []) : null)
    }).catch(() => { if (current) setRequirements(null) })
    return () => { current = false }
  }, [api, enabled, verifying, run.task_id, run.run_id, reloadVersion])
  return { artifacts, requirements, failed, retry: () => setRetry((value) => value + 1) }
}

function DeliveryProgress({ artifacts, requirements, nodes }: { artifacts: RunArtifacts; requirements: ArtifactRequirement[] | null; nodes: NodeRunView[] | null }) {
  const files = [...new Set(artifacts.items.flatMap((item) => item.file_name ? [item.file_name] : []))]
  const canConfirmMissing = artifacts.has_more === false && artifacts.items.every((item) => item.file_name)
  const steps = currentAttempts(nodes ?? [])
  return <>
    {files.length > 0 && <p style={mutedStyle}>{artifacts.has_more ? '最近登记的文件' : '已登记的文件'}：{files.join('、')}</p>}
    {requirements?.map(({ fileName, minimumBytes, nodeId }, index) => {
      const step = steps.get(nodeId)
      const submittedByStep = step && artifacts.items.some((file) => file.file_name === fileName && file.source_node_run_id === step.node_run_id)
      const status = submittedByStep ? '指定步骤已登记此文件，验收仍待确认。'
        : files.includes(fileName) ? '已登记同名文件，提交步骤仍待确认。'
        : canConfirmMissing ? '尚未登记该文件。' : '本页未显示该文件。'
      return <div key={index} style={mutedStyle}>
        <p style={mutedStyle}>计划要求「{fileName}」{step?.title && <>由「{step.title}」提交</>}。{status}</p>
        <details><summary>查看文件验收要求</summary><p>至少 {minimumBytes} 字节，须由计划指定的步骤提交。</p></details>
      </div>
    })}
    {!files.length && !requirements?.length && <p style={mutedStyle}>暂无已登记文件可查看。</p>}
  </>
}

function RunResult({ api, run, delivery, verifying, nodes }: {
  api: ResourcesApi; run: RunSummary; delivery: ReturnType<typeof useRunDelivery>; verifying: boolean; nodes: NodeRunView[] | null
}) {
  const { artifacts, requirements, failed, retry } = delivery
  const issues = run.delivery_checks?.items.filter((check) => check.outcome !== 'passed')
  const sources = new Map(nodes?.map((node) => [node.node_run_id, node.title]))
  return <>
    <section style={cardStyle}>
      <h3 style={sectionTitleStyle}>运行结果</h3>
      <div><RunStatusLabel status={run.status} displayStatus={run.display_status} />{run.settling ? ' · 正在收尾' : ''}</div>
      <p style={mutedStyle}>{doneCount(run)} / {run.total} 个步骤已完成</p>
      {!failed && artifacts && verifying && <DeliveryProgress artifacts={artifacts} requirements={requirements} nodes={nodes} />}
      {!!issues?.length && <ul>
        {issues.map((check) => <li key={check.result_id}>{check.file_name ?? check.tool ?? '交付项'} · {DELIVERY_OUTCOME[check.outcome]}。{check.reason && deliveryReason(check.reason)}</li>)}
      </ul>}
    </section>
    <section>
      <h3 style={sectionTitleStyle}>交付产物</h3>
      {failed && <ReadError onRetry={retry} />}
      {!failed && !artifacts && <p role="status" style={mutedStyle}>正在读取产物…</p>}
      {artifacts?.items.length === 0 && <p style={mutedStyle}>这次运行尚无产物记录。</p>}
      {artifacts?.items.map((artifact) => <details key={artifact.artifact_id} style={cardStyle}>
        <summary>{artifact.file_name || '未命名产物'}{artifact.expired ? ' · 已超过保留期限' : ''}</summary>
        {artifact.source_node_run_id && <p style={mutedStyle}>提交步骤 · {sources.get(artifact.source_node_run_id) || '步骤名称暂不可用'}</p>}
        <p style={mutedStyle}>记录于 {formatDate(artifact.created_at)}</p>
        {artifact.retain_until && <p style={mutedStyle}>保留至 {formatDate(artifact.retain_until)}</p>}
        <ArtifactContent api={api} artifact={artifact} />
        <details>
          <summary>查看产物登记明细</summary>
          <p style={mutedStyle}>产物编号 <code>{artifact.artifact_id}</code> · SHA-256 <code>{artifact.sha256}</code></p>
          {artifact.source_node_run_id && <p style={mutedStyle}>提交步骤编号 <code>{artifact.source_node_run_id}</code></p>}
        </details>
      </details>)}
      {artifacts?.has_more && <p style={mutedStyle}>显示最近 50 份产物。</p>}
    </section>
  </>
}

const DELIVERY_OUTCOME = { passed: '通过', failed: '未通过', unverifiable: '待核验' } as const
const DELIVERY_REASON: Record<string, string> = {
  artifact_not_registered: '没有找到规则要求的产物。',
  artifact_source_node_unbound: '产物缺少可核验的步骤来源。',
  artifact_source_node_mismatch: '产物来源与规则指定的步骤不符。',
  artifact_below_minimum_bytes: '产物小于规则要求的最低字节数。',
  artifact_retain_until_expired: '产物在验收时已超过保留期限。',
  tool_evidence_missing: '没有找到指定步骤的工具执行记录。',
  tool_exit_code_mismatch: '工具实际退出码与验收规则不符。',
}

const deliveryReason = (reason: string) => Object.hasOwn(DELIVERY_REASON, reason) ? DELIVERY_REASON[reason] : operatorReason(reason)

function DeliveryChecks({ checks }: { checks: RunSummary['delivery_checks'] }) {
  return <section>
    <h3 style={sectionTitleStyle}>交付验收</h3>
    {!checks?.items.length && <p style={mutedStyle}>{checks ? '本次运行暂无已记录的交付验收。' : '未读取到本次运行的验收记录。'}</p>}
    {checks?.items.map((check) => <article key={check.result_id} style={cardStyle}>
      <h4 style={evidenceHeadingStyle}>{check.kind === 'artifact' ? '产物' : '工具验收'}
        {(check.file_name ?? check.tool) && ` · ${check.file_name ?? check.tool}`} · {DELIVERY_OUTCOME[check.outcome] ?? '结果未记录'}</h4>
      {check.kind === 'artifact' ? <>
        <p style={mutedStyle}>规则核对产物名称、来源步骤和文件大小。内容可在「结果」中查看。</p>
      </> : <>
        <p style={mutedStyle}>规则核对指定步骤的工具执行结果。</p>
      </>}
      {check.reason && <p>{deliveryReason(check.reason)}</p>}
      <details>
        <summary>查看验收记录明细</summary>
        {check.minimum_bytes !== undefined && <p style={mutedStyle}>要求至少 {check.minimum_bytes} 字节{check.bytes !== undefined && ` · 记录大小 ${check.bytes} 字节`}</p>}
        {check.expected_exit_code !== undefined && <p style={mutedStyle}>要求退出码 {check.expected_exit_code}{!!check.exit_codes?.length && ` · 记录退出码 ${check.exit_codes.join('、')}`}</p>}
        <p style={mutedStyle}>记录于 {formatDate(check.evaluated_at)}</p>
        <p style={mutedStyle}>规则版本 <code>{check.rule_version}</code></p>
        {check.reason && <p style={mutedStyle}>原因代码 <code>{check.reason}</code></p>}
      </details>
    </article>)}
    {checks?.has_more && <p style={mutedStyle}>仅显示 50 条验收记录。</p>}
  </section>
}

const EVIDENCE_ATTENTION_STATES = new Set([
  'failed', 'timeout', 'abandoned_unverified', 'failed_with_unverified', 'orphaned',
  'startup_unknown', 'indeterminate_side_effect', 'blocked_pre', 'blocked_post',
])

function EvidenceList({ api, nodes, reloadVersion, onOpenDecision }: {
  api: ResourcesApi; nodes: NodeRunView[]; reloadVersion: number; onOpenDecision?: (id: string) => void
}) {
  const [otherOpen, setOtherOpen] = useState(false)
  const visible = nodes.filter((node) => node.execution_ids?.length || node.attestation_id || node.evidence_state === 'unverified'
    || node.verified_effect || (node.status === 'done' && node.evidence_state !== 'not_required')
    || EVIDENCE_ATTENTION_STATES.has(node.status))
  const visibleIds = new Set(visible.map((node) => node.node_run_id))
  const remaining = nodes.filter((node) => !visibleIds.has(node.node_run_id))
  const positions = new Map([...new Set(nodes.map((node) => node.node_id))].map((id, index) => [id, index + 1]))
  const attempt = (node: NodeRunView) => <section key={node.node_run_id} style={cardStyle}>
    <h4 style={evidenceHeadingStyle}>{node.title || `未命名步骤 ${positions.get(node.node_id)}`} · 第 {node.attempt} 次尝试</h4>
    <p style={mutedStyle}>{nodeExecutionLabel(node)}</p>
    <NodeEvidence api={api} node={node} reloadVersion={reloadVersion} onOpenDecision={onOpenDecision} />
    <details><summary>查看步骤登记明细</summary><p>步骤编号 <code>{node.node_id}</code> · 尝试编号 <code>{node.node_run_id}</code></p></details>
  </section>
  return <section>
    <h3 style={sectionTitleStyle}>执行证据</h3>
    {nodes.length === 0 && <p style={mutedStyle}>这次运行尚无步骤记录。</p>}
    {visible.map(attempt)}
    {!!remaining.length && <details style={cardStyle} open={otherOpen} onToggle={(event) => setOtherOpen(event.currentTarget.open)}>
      <summary>未关联核验记录的其他尝试 · {remaining.length}</summary>
      {otherOpen && remaining.map(attempt)}
    </details>}
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

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString()
}

const titleStyle = { margin: 0, fontSize: FONT_PX.title, overflowWrap: 'anywhere' as const }
const sectionTitleStyle = { margin: '0 0 8px', fontSize: FONT_PX.body }
const evidenceHeadingStyle = { margin: '0 0 6px', fontSize: FONT_PX.body }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
const attentionStyle = { margin: 0, padding: 9, borderRadius: 8, background: '#fff8e9', color: COLOR.warning, fontSize: FONT_PX.body }
const cardStyle = { minWidth: 0, padding: 11, marginBottom: 6, border: `1px solid ${COLOR.line}`, borderRadius: 8, background: COLOR.surface }
const quietButtonStyle = { minHeight: 36, justifySelf: 'start' as const, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 14, borderRadius: 8, background: '#fff1f0', color: COLOR.danger, fontSize: FONT_PX.body } as const
