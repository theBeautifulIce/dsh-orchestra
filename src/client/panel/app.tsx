import { useMemo, useState, type ReactNode } from 'react'
import type { ApiClient } from '../api/client.ts'
import { createResourcesApi } from '../api/resources.ts'
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
  additionalScreens?: Partial<Record<Exclude<PanelRoute, 'tasks'>, ReactNode>>
}

export function PanelApp(props: PanelAppProps) {
  const api = useMemo(() => createResourcesApi(props.client), [props.client])
  const [route, setRoute] = useState<PanelRoute>(props.initialRoute ?? 'tasks')
  const [taskId, setTaskId] = useState<string | null>(null)

  let screen: ReactNode
  if (route === 'tasks') {
    screen = taskId
      ? <TaskDetailScreen api={api} taskId={taskId} onBack={() => setTaskId(null)} />
      : <TaskListScreen api={api} onSelectTask={setTaskId} />
  } else {
    screen = props.additionalScreens?.[route] ?? <div role="status" style={pendingStyle}>此页面尚未接入真实数据。</div>
  }

  return <PanelShell
    activeRoute={route}
    onNavigate={(next) => { setRoute(next); if (next !== 'tasks') setTaskId(null) }}
    serviceConnected={props.serviceConnected}
    protocolMismatch={props.protocolMismatch}
    snapshotStale={props.snapshotStale}
  >{screen}</PanelShell>
}

const pendingStyle = { padding: 24, border: `1px solid ${COLOR.line}`, borderRadius: 9, color: COLOR.inkMuted, fontSize: FONT_PX.body }
