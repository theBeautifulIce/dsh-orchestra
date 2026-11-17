import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApiClient } from '../api/client.ts'
import { createResourcesApi } from '../api/resources.ts'
import type { EventStream, StreamStatus } from '../api/sse.ts'
import { PanelShell, type PanelRoute } from './shell.tsx'
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
  const [route, setRoute] = useState<PanelRoute>(props.initialRoute ?? 'tasks')
  const [taskId, setTaskId] = useState<string | null>(null)
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
  } else {
    screen = props.additionalScreens?.[route] ?? <div role="status" style={pendingStyle}>此页面尚未接入真实数据。</div>
  }

  return <PanelShell
    activeRoute={route}
    onNavigate={(next) => { setRoute(next); if (next !== 'tasks') setTaskId(null) }}
    serviceConnected={props.serviceConnected}
    protocolMismatch={props.protocolMismatch}
    snapshotStale={props.snapshotStale || streamStatus === 'stale'}
    streamStatus={streamStatus}
  >{screen}</PanelShell>
}

const pendingStyle = { padding: 24, border: `1px solid ${COLOR.line}`, borderRadius: 9, color: COLOR.inkMuted, fontSize: FONT_PX.body }
