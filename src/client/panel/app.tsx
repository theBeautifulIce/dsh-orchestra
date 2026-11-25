import { createReworkApi } from '../api/rework.ts'
import { createModelEscalationApi } from '../api/model-escalation.ts'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, type ApiClient } from '../api/client.ts'
import { createResourcesApi } from '../api/resources.ts'
import { createDecisionCommandsApi } from '../api/decision-commands.ts'
import { createMemoryRecoveryApi } from '../api/memory-recovery.ts'
import { createTaskCommands } from '../api/task-commands.ts'
import { createTaskTriggerCommands } from '../api/task-trigger-commands.ts'
import { createWorkflowCommandsApi } from '../api/workflow-commands.ts'
import type { EventStream, StreamStatus } from '../api/sse.ts'
import { PanelShell, type PanelRoute } from './shell.tsx'
import { DecisionInbox } from './decision-inbox.tsx'
import { ActivityScreen } from './activity-screen.tsx'
import { CollaborationScreen } from './collaboration-screen.tsx'
import { OverviewScreen } from './overview-screen.tsx'
import { MemoryPanel } from './memory-panel.tsx'
import { SettingsScreen } from './settings-screen.tsx'
import { ModelRoutingSettings } from './model-routing-settings.tsx'
import { PlanningTimeoutSettings } from './planning-timeout-settings.tsx'
import { ChatRoutingSettings } from './chat-routing-settings.tsx'
import { CommandSettings } from './command-settings.tsx'
import type { ClientCommandReservations } from '../dsh-command-reservations.ts'
import { ExecutionPermissionSettings } from './execution-permission-settings.tsx'
import { DisplayPreferenceSettings } from './display-preference-settings.tsx'
import { ExecutionCapacitySettings } from './execution-capacity-settings.tsx'
import { WorkflowConcurrencySettings } from './workflow-concurrency-settings.tsx'
import { UnverifiedEffects } from './unverified-effects.tsx'
import { WorkflowCanvas } from './workflow-canvas.tsx'
import { WorkflowListScreen } from './workflow-list.tsx'
import { TaskDetailScreen, type TaskDetailScreenProps } from './task-detail-screen.tsx'
import { TaskListScreen, type TaskListScreenProps } from './tasks-screen.tsx'
import { TaskTriggerManager } from './task-trigger-manager.tsx'
import { COLOR, FONT_PX } from './tokens.ts'
import type { PanelReceiptLocation } from '../../core/receipt-location.ts'

export type PanelAppProps = {
  client: ApiClient
  serviceConnected: boolean
  protocolMismatch?: boolean
  snapshotStale?: boolean
  memoryEnabled?: boolean
  memoryProposalOnly?: boolean
  modelRoutingEnabled?: boolean
  planningTimeoutsEnabled?: boolean
  nativeChatRoutingEnabled?: boolean
  nativeCommandSettingsEnabled?: boolean
  clientCommands?: ClientCommandReservations
  nativeExecutionPermissionsEnabled?: boolean
  executionCapacityEnabled?: boolean
  workflowConcurrencyEnabled?: boolean
  modelEscalationEnabled?: boolean
  servicePhase?: string
  panelVersion?: string
  refreshServiceStatus?: () => Promise<boolean>
  collaborationEnabled?: boolean
  reworkEnabled?: boolean
  taskTriggersEnabled?: boolean
  reworkPlannerEnabled?: boolean
  initialRoute?: PanelRoute
  initialLocation?: PanelReceiptLocation
  workflowLaunchRequiresPlan?: boolean
  scopeLabel?: string
  runNotesEnabled?: boolean
  createEventStream?: (onInvalidate: (type: string) => void, onStatus: (status: StreamStatus) => void) => EventStream
  additionalScreens?: Partial<Record<Exclude<PanelRoute, 'tasks'>, ReactNode>>
}

export function PanelApp(props: PanelAppProps) {
  const [streamStatus, setStreamStatus] = useState<StreamStatus>()
  const [resyncRequest, setResyncRequest] = useState<number | null>(null)
  const writesEnabled = useRef(false)
  const snapshotStale = props.snapshotStale || streamStatus === 'stale' || resyncRequest !== null
  writesEnabled.current = props.serviceConnected && !props.protocolMismatch && !snapshotStale
  const client = useMemo<ApiClient>(() => ({
    get: (...args) => props.client.get(...args),
    async post<T>(path: string, payload: unknown, signal?: AbortSignal) {
      if (!writesEnabled.current) throw new ApiError('PANEL_WRITE_UNAVAILABLE', '当前为只读状态，刷新成功后再操作', false)
      return props.client.post<T>(path, payload, signal)
    },
  }), [props.client])
  const rework = useMemo(() => props.reworkEnabled ? createReworkApi(client) : undefined, [client, props.reworkEnabled])
  const modelEscalation = useMemo(() => props.modelEscalationEnabled ? createModelEscalationApi(client) : undefined, [client, props.modelEscalationEnabled])
  const api = useMemo(() => createResourcesApi(client), [client])
  // 控制面写命令客户端：流程新建、草稿保存、发布都走同一套命令与回执。
  const commands = useMemo(() => createWorkflowCommandsApi(client), [client])
  // 决定控制面写命令客户端：接手与处理走同一套命令与回执纪律。
  const decisionCommands = useMemo(() => createDecisionCommandsApi(client), [client])
  const memoryRecovery = useMemo(() => createMemoryRecoveryApi(client), [client])
  const taskCommands = useMemo(() => createTaskCommands(client), [client])
  const triggerCommands = useMemo(() => createTaskTriggerCommands(client), [client])
  const writableTriggers = props.taskTriggersEnabled === true ? triggerCommands : undefined
  const [route, setRoute] = useState<PanelRoute>(props.initialLocation?.kind === 'decision' ? 'decisions' : props.initialRoute ?? 'tasks')
  const [taskId, setTaskId] = useState<string | null>(props.initialLocation?.kind === 'task' ? props.initialLocation.taskId : null)
  const [taskRunId, setTaskRunId] = useState<string | undefined>(props.initialLocation?.kind === 'task' ? props.initialLocation.runId : undefined)
  const [taskAction, setTaskAction] = useState<TaskDetailScreenProps['initialAction']>()
  const taskTrigger = useRef<HTMLElement | null>(null)
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  const [decisionId, setDecisionId] = useState<string | undefined>(props.initialLocation?.kind === 'decision' ? props.initialLocation.decisionId : undefined)
  const [reloadVersion, setReloadVersion] = useState(0)
  const [settingsReloadVersion, setSettingsReloadVersion] = useState(0)
  const [plannerHeading, setPlannerHeading] = useState<HTMLHeadingElement | null>(null)
  const [submodelHeading, setSubmodelHeading] = useState<HTMLHeadingElement | null>(null)
  const streamStarted = useRef(false)
  const resyncGeneration = useRef(0)
  const resyncAnchor = useRef<{ generation: number; seq: number } | null>(null)
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const requestResync = useCallback(() => {
    writesEnabled.current = false
    resyncAnchor.current = null
    setResyncRequest(++resyncGeneration.current)
  }, [])
  const eventStream = useMemo(() => props.createEventStream?.(
    (type) => {
      if (type === 'resync_required') requestResync()
      else setReloadVersion((version) => version + 1)
    },
    (status) => {
      if (status === 'stale') writesEnabled.current = false
      setStreamStatus(status)
    },
  ) ?? null, [props.createEventStream, requestResync])

  useEffect(() => {
    streamStarted.current = false
    return () => {
      eventStream?.stop()
      streamStarted.current = false
    }
  }, [eventStream])

  const { refreshServiceStatus } = props
  useEffect(() => {
    if (!eventStream || resyncRequest === null) return
    const generation = resyncRequest
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const isCurrent = () => active && generation === resyncGeneration.current
    async function recover() {
      try {
        // Capture the ledger watermark before refreshing any views so later writes are replayed.
        const [{ as_of_seq }, health] = await Promise.all([api.listEvents({ limit: 1 }), refreshServiceStatus?.()])
        if (!isCurrent()) return
        if (health === false) throw new Error('Service health is unavailable')
        resyncAnchor.current = { generation, seq: as_of_seq }
        setRefreshGeneration(generation)
        setSettingsReloadVersion((version) => version + 1)
        setReloadVersion((version) => version + 1)
      } catch {
        if (isCurrent()) retry = setTimeout(() => { void recover() }, 5000)
      }
    }
    void recover()
    return () => { active = false; clearTimeout(retry) }
  }, [api, eventStream, refreshServiceStatus, resyncRequest])

  const finishResync = useCallback((asOfSeq?: number) => {
    const anchor = resyncAnchor.current
    if (!eventStream || !anchor || anchor.generation !== refreshGeneration || anchor.generation !== resyncGeneration.current
      || (asOfSeq !== undefined && asOfSeq < anchor.seq)) return
    resyncAnchor.current = null
    setResyncRequest(null)
    if (streamStarted.current) eventStream.setSnapshot(anchor.seq)
    else {
      streamStarted.current = true
      eventStream.start(anchor.seq)
    }
  }, [eventStream, refreshGeneration])

  const onSnapshot = useCallback((asOfSeq: number) => {
    // A query started before the stream found a gap cannot complete this resync.
    if (!eventStream || refreshGeneration !== resyncGeneration.current) return
    if (resyncAnchor.current) { finishResync(asOfSeq); return }
    if (!streamStarted.current) {
      eventStream.start(asOfSeq)
      streamStarted.current = true
    } else {
      eventStream.setSnapshot(asOfSeq)
    }
  }, [eventStream, finishResync, refreshGeneration])

  const canReadViewSnapshot = route === 'settings'
    ? props.modelRoutingEnabled === true || props.planningTimeoutsEnabled === true
      || props.executionCapacityEnabled === true || props.workflowConcurrencyEnabled === true
    : route === 'collaboration' ? props.collaborationEnabled === true
      : route !== 'memory' || !props.additionalScreens?.memory
  useEffect(() => {
    if (!canReadViewSnapshot) finishResync()
  }, [canReadViewSnapshot, finishResync])

  function refreshSettings() {
    if (resyncRequest !== null) requestResync()
    else void Promise.resolve(refreshServiceStatus?.()).then((healthy) => {
      if (healthy !== false) setSettingsReloadVersion((version) => version + 1)
    })
  }

  function openDecision(id: string) {
    setTaskId(null)
    setDecisionId(id)
    setRoute('decisions')
  }

  const openTask: TaskListScreenProps['onSelectTask'] = (id, trigger, runId, action) => {
    // 总览与任务页共用精确目标，审批始终进入原有审批中心。
    if (action?.kind === 'decision' && action.decision_id) { openDecision(action.decision_id); return }
    taskTrigger.current = trigger
    setTaskAction(action)
    setTaskRunId(runId)
    setTaskId(id)
  }

  const showServiceStatus = props.additionalScreens?.settings == null
  const settingsSections = [
    ...(props.nativeChatRoutingEnabled ? [{ id: 'chat-routing-title', label: '会话路由' }] : []),
    ...(props.nativeCommandSettingsEnabled ? [{ id: 'task-command-title', label: '任务命令' }] : []),
    ...(props.nativeExecutionPermissionsEnabled ? [{ id: 'execution-permissions-title', label: '执行权限' }] : []),
    ...(props.modelRoutingEnabled && plannerHeading ? [{ id: plannerHeading.id, label: '主脑模型' }] : []),
    ...(props.modelRoutingEnabled && submodelHeading ? [{ id: submodelHeading.id, label: '子模型及能力' }] : []),
    ...(props.planningTimeoutsEnabled ? [{ id: 'planning-timeouts-title', label: '规划时限' }] : []),
    ...(props.executionCapacityEnabled ? [{ id: 'execution-capacity-title', label: '执行与排队' }] : []),
    ...(props.workflowConcurrencyEnabled ? [{ id: 'workflow-concurrency-title', label: 'Workflow 并发' }] : []),
    { id: 'display-preferences-title', label: '显示偏好' },
    ...(showServiceStatus ? [{ id: 'settings-title', label: '服务状态' }] : []),
    { id: 'memory-capability-title', label: '任务记忆' },
  ]

  let screen: ReactNode
  if (route === 'overview') {
    screen = <OverviewScreen api={api} reloadVersion={reloadVersion} onSnapshot={onSnapshot} onNavigate={setRoute} onSelectTask={openTask} />
  } else if (route === 'tasks') {
    screen = <div className="task-workspace">
      <TaskListScreen reworkEnabled={props.reworkEnabled} collaborationEnabled={props.collaborationEnabled}
        workflowLaunchRequiresPlan={props.workflowLaunchRequiresPlan} scopeLabel={props.scopeLabel} api={api} commands={taskCommands} selectedTaskId={taskId}
        triggerManager={!writableTriggers ? undefined :
          <TaskTriggerManager api={api} commands={writableTriggers} onChanged={() => setReloadVersion((version) => version + 1)} />} onSelectTask={openTask}
      reloadVersion={reloadVersion} onSnapshot={onSnapshot} />
    </div>
  } else if (route === 'decisions') {
    screen = <DecisionInbox key={decisionId ?? 'all'} decisionId={decisionId} onShowAll={() => setDecisionId(undefined)}
      rework={rework} reworkPlannerEnabled={props.reworkPlannerEnabled} api={api} commands={decisionCommands} reloadVersion={reloadVersion} onSnapshot={onSnapshot} />
  } else if (route === 'effects') {
    screen = <UnverifiedEffects api={api} client={client} reloadVersion={reloadVersion} onSnapshot={onSnapshot} onOpenDecision={openDecision} />
  } else if (route === 'activity') {
    screen = <ActivityScreen api={api} reloadVersion={reloadVersion} onSnapshot={onSnapshot} />
  } else if (route === 'collaboration' && props.collaborationEnabled) {
    screen = <CollaborationScreen client={client} reloadVersion={reloadVersion} onSnapshot={onSnapshot}
      onOpenRun={(task, run) => { setTaskAction(undefined); setTaskId(task); setTaskRunId(run) }} />
  } else if (route === 'memory') {
    screen = props.additionalScreens?.memory
      ?? <MemoryPanel api={api} recovery={memoryRecovery} memoryEnabled={props.memoryEnabled} proposalOnly={props.memoryProposalOnly}
        reloadVersion={reloadVersion} onSnapshot={onSnapshot} onOpenDecisions={() => { setRoute('decisions') }} onOpenTasks={() => setRoute('tasks')} />
  } else if (route === 'settings') {
    screen = <section className="ops-page ops-settings-page"><header className="ops-page-header"><div>
      <h1>设置</h1><p className="ops-meta">管理会话、模型与执行方式，查看当前服务和记忆能力。</p>
    </div></header><div className="ops-settings-section">
      {props.nativeChatRoutingEnabled && <ChatRoutingSettings client={client} reloadVersion={settingsReloadVersion} writable={writesEnabled.current} />}
      {props.nativeCommandSettingsEnabled && <CommandSettings client={client} reloadVersion={settingsReloadVersion} writable={writesEnabled.current} clientCommands={props.clientCommands} />}
      {props.nativeExecutionPermissionsEnabled && <ExecutionPermissionSettings client={client} reloadVersion={settingsReloadVersion} writable={writesEnabled.current} />}
      {props.modelRoutingEnabled && <ModelRoutingSettings client={client} reloadVersion={settingsReloadVersion} onSnapshot={onSnapshot}
        plannerHeadingRef={setPlannerHeading} submodelHeadingRef={setSubmodelHeading} />}
      {props.planningTimeoutsEnabled && <PlanningTimeoutSettings client={client} reloadVersion={settingsReloadVersion} onSnapshot={onSnapshot} />}
      {props.executionCapacityEnabled && <ExecutionCapacitySettings client={client} reloadVersion={settingsReloadVersion} onSnapshot={onSnapshot} />}
      {props.workflowConcurrencyEnabled && <WorkflowConcurrencySettings client={client} reloadVersion={settingsReloadVersion} onSnapshot={onSnapshot} />}
      <DisplayPreferenceSettings />
      {props.additionalScreens?.settings
      ?? <SettingsScreen serviceConnected={props.serviceConnected} protocolMismatch={props.protocolMismatch} snapshotStale={snapshotStale} streamStatus={streamStatus}
        phase={props.servicePhase} panelVersion={props.panelVersion} onRefresh={refreshSettings} />}
      <section className="ops-surface" aria-labelledby="memory-capability-title">
        <header className="ops-surface-head"><h2 id="memory-capability-title" className="ops-settings-anchor" tabIndex={-1}>任务记忆</h2></header>
        <div className="ops-inset">
          <p>{!props.serviceConnected ? '服务未连接，记忆整理状态待确认。' : props.memoryEnabled === true ? '宿主已启用记忆整理。' : props.memoryEnabled === false ? '当前宿主未启用记忆整理。' : '宿主尚未报告记忆整理状态。'}</p>
          <p>{props.memoryProposalOnly ? '当前工作区开放记忆提议。你可以从成功任务的「结果」整理经验，在记忆页查看建议和来源。' : '在成功任务的「结果」中发起整理。你在审批中心确认条目后，可到记忆页查看实际写入的内容和来源。'}</p>
          <button type="button" className="ops-button" onClick={() => setRoute('memory')}>查看记忆与写入结果</button>
        </div>
      </section>
    </div></section>
  } else if (route === 'workflows') {
    screen = <>
      <div hidden={workflowId !== null}><WorkflowListScreen api={api} onSelectWorkflow={setWorkflowId} reloadVersion={reloadVersion} onSnapshot={onSnapshot} commands={commands} /></div>
      {workflowId && <WorkflowCanvas key={workflowId} api={api} workflowId={workflowId} onBack={() => setWorkflowId(null)}
          onOpenRun={(task, run) => { taskTrigger.current = null; setTaskAction(undefined); setTaskId(task); setTaskRunId(run) }}
          reloadVersion={reloadVersion} onSnapshot={onSnapshot} commands={commands} />}
    </>
  } else {
    screen = props.additionalScreens?.[route] ?? <div role="status" style={pendingStyle}>此页面尚未接入真实数据。</div>
  }

  return <PanelShell
    activeRoute={route}
    onNavigate={(next) => { setDecisionId(undefined); setRoute(next); if (next !== 'tasks') setTaskId(null); if (next !== 'workflows') setWorkflowId(null) }}
    serviceConnected={props.serviceConnected}
    protocolMismatch={props.protocolMismatch}
    snapshotStale={snapshotStale}
    streamStatus={streamStatus}
    collaborationEnabled={props.collaborationEnabled}
    settingsSections={settingsSections}
  >{screen}
    {taskId && <TaskDetailScreen rework={rework} modelEscalation={modelEscalation} reworkPlannerEnabled={props.reworkPlannerEnabled} key={taskId + ':' + (taskRunId ?? '')} api={api} taskId={taskId} initialRunId={taskRunId} initialAction={taskAction} onBack={() => {
      setTaskId(null)
      taskTrigger.current?.focus({ preventScroll: true })
    }} taskCommands={taskCommands} triggerCommands={writableTriggers} onArchiveChanged={() => setReloadVersion((version) => version + 1)}
      onOpenDecision={openDecision}
      notesClient={props.runNotesEnabled ? client : undefined}
      onOpenMemory={props.memoryEnabled ? () => { setTaskId(null); setRoute('memory') } : undefined}
      reloadVersion={reloadVersion} onSnapshot={onSnapshot} />}
  </PanelShell>
}

const pendingStyle = { padding: 24, border: `1px solid ${COLOR.line}`, borderRadius: 9, color: COLOR.inkMuted, fontSize: FONT_PX.body }
