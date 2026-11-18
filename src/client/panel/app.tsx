import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApiClient } from '../api/client.ts'
import { createResourcesApi } from '../api/resources.ts'
import { createDecisionCommandsApi } from '../api/decision-commands.ts'
import { createWorkflowCommandsApi } from '../api/workflow-commands.ts'
import type { EventStream, StreamStatus } from '../api/sse.ts'
import { PanelShell, type PanelRoute } from './shell.tsx'
import { DecisionInbox } from './decision-inbox.tsx'
import { MemoryPanel } from './memory-panel.tsx'
import { SettingsScreen } from './settings-screen.tsx'
import { UnverifiedEffects } from './unverified-effects.tsx'
import { WorkflowCanvas } from './workflow-canvas.tsx'
import { WorkflowListScreen } from './workflow-list.tsx'
import { TaskDetailScreen } from './task-detail-screen.tsx'
import { TaskListScreen } from './tasks-screen.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

export type PanelAppProps = {
  client: ApiClient
  serviceConnected: boolean
  protocolMismatch?: boolean
  snapshotStale?: boolean
  initialRoute?: PanelRoute
  createEventStream?: (onInvalidate: (type: string) => void, onStatus: (status: StreamStatus) => void) => EventStream
  additionalScreens?: Partial<Record<Exclude<PanelRoute, 'tasks'>, ReactNode>>
}

export function PanelApp(props: PanelAppProps) {
  const api = useMemo(() => createResourcesApi(props.client), [props.client])
  // 控制面写命令客户端：流程新建、草稿保存、发布都走同一套命令与回执。
  const commands = useMemo(() => createWorkflowCommandsApi(props.client), [props.client])
  // 决定控制面写命令客户端：接手与处理走同一套命令与回执纪律。
  const decisionCommands = useMemo(() => createDecisionCommandsApi(props.client), [props.client])
  const [route, setRoute] = useState<PanelRoute>(props.initialRoute ?? 'tasks')
  const [taskId, setTaskId] = useState<string | null>(null)
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  const [reloadVersion, setReloadVersion] = useState(0)
  const [streamStatus, setStreamStatus] = useState<StreamStatus>()
  const streamStarted = useRef(false)
  const eventStream = useMemo(() => props.createEventStream?.(
    () => setReloadVersion((version) => version + 1),
    setStreamStatus,
  ) ?? null, [props.createEventStream])

  useEffect(() => {
    streamStarted.current = false
    return () => {
      eventStream?.stop()
      streamStarted.current = false
    }
  }, [eventStream])

  const onSnapshot = useCallback((asOfSeq: number) => {
    if (!eventStream) return
    if (!streamStarted.current) {
      eventStream.start(asOfSeq)
      streamStarted.current = true
    } else {
      eventStream.setSnapshot(asOfSeq)
    }
  }, [eventStream])

  let screen: ReactNode
  if (route === 'tasks') {
    screen = taskId
      ? <TaskDetailScreen api={api} taskId={taskId} onBack={() => setTaskId(null)} reloadVersion={reloadVersion} onSnapshot={onSnapshot} />
      : <TaskListScreen api={api} onSelectTask={setTaskId} reloadVersion={reloadVersion} onSnapshot={onSnapshot} />
  } else if (route === 'decisions') {
    screen = <DecisionInbox api={api} commands={decisionCommands} reloadVersion={reloadVersion} onSnapshot={onSnapshot} />
  } else if (route === 'effects') {
    screen = <UnverifiedEffects api={api} reloadVersion={reloadVersion} onSnapshot={onSnapshot} />
  } else if (route === 'memory') {
    screen = props.additionalScreens?.memory
      ?? <MemoryPanel api={api} commands={decisionCommands} reloadVersion={reloadVersion} onSnapshot={onSnapshot} onOpenDecisions={() => { setRoute('decisions') }} />
  } else if (route === 'settings') {
    screen = props.additionalScreens?.settings
    ?? <SettingsScreen serviceConnected={props.serviceConnected} protocolMismatch={props.protocolMismatch} snapshotStale={props.snapshotStale} streamStatus={streamStatus} />
  } else if (route === 'workflows') {
    screen = workflowId
      ? <WorkflowCanvas api={api} workflowId={workflowId} onBack={() => setWorkflowId(null)} reloadVersion={reloadVersion} onSnapshot={onSnapshot} commands={commands} />
      : <WorkflowListScreen api={api} onSelectWorkflow={setWorkflowId} reloadVersion={reloadVersion} onSnapshot={onSnapshot} commands={commands} />
  } else {
    screen = props.additionalScreens?.[route] ?? <div role="status" style={pendingStyle}>此页面尚未接入真实数据。</div>
  }

  return <PanelShell
    activeRoute={route}
    onNavigate={(next) => { setRoute(next); if (next !== 'tasks') setTaskId(null); if (next !== 'workflows') setWorkflowId(null) }}
    serviceConnected={props.serviceConnected}
    protocolMismatch={props.protocolMismatch}
    snapshotStale={props.snapshotStale || streamStatus === 'stale'}
    streamStatus={streamStatus}
  >{screen}</PanelShell>
}

const pendingStyle = { padding: 24, border: `1px solid ${COLOR.line}`, borderRadius: 9, color: COLOR.inkMuted, fontSize: FONT_PX.body }
