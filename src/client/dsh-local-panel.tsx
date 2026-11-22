import { useMemo, useSyncExternalStore } from 'react'
import type { FetchLike } from './api/client.ts'
import { PanelHost } from './panel-host.tsx'

const route = '/api/orchestra.request'
// PanelHost resolves paths as URLs. This routing base never leaves the renderer.
export const localPanelBase = 'http://orchestra.invalid/'
const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]'])

type Store<T> = {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

type SessionList = {
  byId: Readonly<Record<string, { id: string; retainedBy: { mainView?: number } }>>
}
type WorkspaceList = {
  items: readonly { workspaceId: string; sessionIds: readonly string[] }[]
  archivedSessionIds: readonly string[]
}

export type DshLocalPanelSources = {
  sessions: { list: Store<SessionList> }
  workspaces: { list: Store<WorkspaceList> }
}

export function isDshLocalShell(href: string): boolean {
  const url = new URL(href)
  if (url.username || url.password) return false
  if (url.protocol === 'dsh-app:') return url.host === 'app'
  return (url.protocol === 'http:' || url.protocol === 'https:') && loopbackNames.has(url.hostname)
}

export function workspaceForSession(sessionId: string | undefined, workspaces: WorkspaceList): string | undefined {
  if (!sessionId || workspaces.archivedSessionIds.includes(sessionId)) return undefined
  const matches = workspaces.items.filter(workspace => workspace.sessionIds.includes(sessionId))
  return matches.length === 1 ? matches[0]?.workspaceId : undefined
}

function selectedSession(sessions: SessionList): string | undefined {
  const selected = Object.values(sessions.byId).filter(row => (row.retainedBy?.mainView ?? 0) > 0)
  return selected.length === 1 ? selected[0]?.id : undefined
}

function createLocalFetcher(
  workspaceId: string,
  sessionId: string,
  isCurrent: () => boolean,
): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const isRead = request.method === 'GET'
    const isCommand = request.method === 'POST' && url.pathname.startsWith('/v1/')
    const isApiPath = url.pathname === '/health' || url.pathname.startsWith('/v1/')
    if (url.origin !== new URL(localPanelBase).origin || !isApiPath || (!isRead && !isCommand)) {
      throw new TypeError('Invalid Orchestra panel request')
    }
    const query = new URLSearchParams({ workspaceId, sessionId, path: url.pathname + url.search })
    const headers = new Headers()
    const accept = request.headers.get('accept')
    if (accept) headers.set('accept', accept)
    if (isCommand) {
      headers.set('content-type', 'application/json')
      headers.set('x-orchestra-request', '1')
    }
    const body = isCommand ? await request.text() : undefined
    if (!isCurrent()) throw new DOMException('DSH workspace selection changed', 'AbortError')
    return window.fetch(`${route}?${query}`, {
      method: request.method,
      body,
      headers,
      signal: request.signal,
      credentials: 'same-origin',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    })
  }
}

export function createLocalSessionFetcher(sources: DshLocalPanelSources, workspaceId: string, sessionId: string) {
  return createLocalFetcher(workspaceId, sessionId, () =>
    selectedSession(sources.sessions.list.getSnapshot()) === sessionId
    && workspaceForSession(sessionId, sources.workspaces.list.getSnapshot()) === workspaceId)
}

export function DshLocalPanel({ sessions, workspaces }: DshLocalPanelSources) {
  const sessionList = useSyncExternalStore(
    listener => sessions.list.subscribe(listener), () => sessions.list.getSnapshot(),
  )
  const workspaceList = useSyncExternalStore(
    listener => workspaces.list.subscribe(listener), () => workspaces.list.getSnapshot(),
  )
  const sessionId = selectedSession(sessionList)
  const workspaceId = workspaceForSession(sessionId, workspaceList)
  const fetcher = useMemo(() => {
    if (!workspaceId || !sessionId) return undefined
    return createLocalSessionFetcher({ sessions, workspaces }, workspaceId, sessionId)
  }, [sessionId, workspaceId, sessions, workspaces])

  if (!fetcher) return <main style={{ padding: 24 }}>
    <h1>Orchestra</h1>
    <p role="status">请在 DSH 的工作区中打开一个会话，再返回 Orchestra。</p>
  </main>
  return <PanelHost key={JSON.stringify([workspaceId, sessionId])} baseUrl={localPanelBase} fetcher={fetcher} workflowLaunchRequiresPlan />
}
