import { workspaceForSession, type DshLocalPanelSources } from './dsh-local-panel.tsx'
import type { FetchLike } from './api/client.ts'

const name = 'orchestra'
const token = '/orchestra'
const hint = '任务内容'
const usage = '用法：/orchestra 任务内容'
const candidate = { name, description: '在当前工作区交给 Orchestra 执行一次任务', hint }

type Session = { sessionId: string }
type SlashSource = {
  name: string
  trigger: '/'
  showGroupTitle: false
  candidates(session: Session, query: { query: string; position: string; signal: AbortSignal }): Promise<readonly typeof candidate[]>
  onPick(pick: { session: Session; candidate: { name: string }; position: string }): { text: string } | undefined
  matchEnter(session: Session, line: string, signal: AbortSignal): Promise<{
    claim: { name: string; token: string; hint: string; submit(): { kind: 'success'; text: string } }
  } | undefined>
}

export type NativeOrchestraSlashContext = DshLocalPanelSources & {
  sessions: { subagentAddress?(sessionId: string): unknown }
  inputTriggers: { registerSource(source: SlashSource): () => void }
}

export function registerNativeOrchestraSlash(ctx: NativeOrchestraSlashContext, fetcher: FetchLike) {
  const lifetime = new AbortController()
  const workspaceOf = (sessionId: string) => {
    if (lifetime.signal.aborted || !ctx.sessions.subagentAddress || ctx.sessions.subagentAddress(sessionId) !== undefined) return undefined
    return workspaceForSession(sessionId, ctx.workspaces.list.getSnapshot())
  }
  async function available({ sessionId }: Session, signal: AbortSignal) {
    const workspaceId = workspaceOf(sessionId)
    if (!workspaceId || signal.aborted) return false
    const query = new URLSearchParams({ workspaceId, sessionId, path: '/v1/settings/chat-routing' })
    try {
      // This local capability check reads only the profile setting. Its value
      // does not change command availability and it does not open a task ledger.
      const response = await fetcher('/api/orchestra.request?' + query, {
        signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(2_000)]),
        credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      })
      if (!response.ok) return false
      const body = await response.json() as { ok?: unknown; data?: { enabled?: unknown } }
      return !signal.aborted && workspaceOf(sessionId) === workspaceId && body.ok === true && typeof body.data?.enabled === 'boolean'
    } catch { return false }
  }
  const dispose = ctx.inputTriggers.registerSource({
    name: 'dsh-orchestra', trigger: '/', showGroupTitle: false,
    async candidates(session, { query, position, signal }) {
      if (position !== 'leading' || !name.startsWith(query.trim().toLowerCase())) return []
      return await available(session, signal) ? [candidate] : []
    },
    onPick({ session, candidate: picked, position }) {
      if (position === 'leading' && picked.name === name && workspaceOf(session.sessionId)) return { text: token + ' ' }
      return undefined
    },
    async matchEnter(session, line, signal) {
      // With arguments, the native composer sends the untouched draft via
      // Session.prompt. Only the empty usage request is handled in the editor.
      if (line.trim() !== token || !await available(session, signal)) return undefined
      return { claim: { name, token: token + ' ', hint, submit: () => ({ kind: 'success', text: usage }) } }
    },
  })
  return () => { lifetime.abort(); dispose() }
}
