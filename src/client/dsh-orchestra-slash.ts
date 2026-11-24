import { workspaceForSession, type DshLocalPanelSources } from './dsh-local-panel.tsx'
import { validateTaskCommandView } from './api/task-command.ts'
import { DEFAULT_TASK_COMMAND, type TaskCommandView } from '../core/task-command.ts'
import type { ClientCommandReservations } from './dsh-command-reservations.ts'
import type { FetchLike } from './api/client.ts'

const hint = '任务内容'
type Candidate = { name: string; description: string; hint: string }
type Session = { sessionId: string }
type SlashSource = {
  name: string
  trigger: '/'
  showGroupTitle: false
  candidates(session: Session, query: { query: string; position: string; signal: AbortSignal }): Promise<readonly Candidate[]>
  onPick(pick: { session: Session; candidate: { name: string }; position: string }): { text: string } | undefined
  matchEnter(session: Session, line: string, signal: AbortSignal): Promise<{
    claim: { name: string; token: string; hint: string; submit(): { kind: 'success'; text: string } }
  } | undefined>
}

export type NativeOrchestraSlashContext = DshLocalPanelSources & {
  sessions: { subagentAddress?(sessionId: string): unknown }
  inputTriggers: { registerSource(source: SlashSource): () => void }
}

export function registerNativeOrchestraSlash(ctx: NativeOrchestraSlashContext, fetcher: FetchLike, clientCommands?: ClientCommandReservations) {
  const lifetime = new AbortController()
  const current = new Map<string, { workspaceId: string; view: TaskCommandView }>()
  const workspaceOf = (sessionId: string) => {
    if (lifetime.signal.aborted || !ctx.sessions.subagentAddress || ctx.sessions.subagentAddress(sessionId) !== undefined) return undefined
    return workspaceForSession(sessionId, ctx.workspaces.list.getSnapshot())
  }
  async function configuration({ sessionId }: Session, signal: AbortSignal) {
    const workspaceId = workspaceOf(sessionId)
    if (!workspaceId || signal.aborted) return undefined
    const query = new URLSearchParams({ workspaceId, sessionId, path: '/v1/settings/task-command' })
    try {
      // Profile settings and public command catalogs only; no task ledger is opened.
      const response = await fetcher('/api/orchestra.request?' + query, {
        signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(5_000)]),
        credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      })
      if (!response.ok) return undefined
      const body = await response.json() as { ok?: unknown; data: TaskCommandView }
      if (body.ok !== true) return undefined
      const view = validateTaskCommandView(body.data)
      if (signal.aborted || workspaceOf(sessionId) !== workspaceId) return undefined
      // A stale concurrent lookup cannot restore a previous profile command.
      if ((current.get(sessionId)?.view.revision ?? -1) > view.revision) return current.get(sessionId)?.view
      current.set(sessionId, { workspaceId, view })
      const local = clientCommands?.activate(view.name, view.revision)
      return local && !local.available ? { ...view, check: local } : view
    } catch { return undefined }
  }
  const dispose = ctx.inputTriggers.registerSource({
    name: 'dsh-orchestra', trigger: '/', showGroupTitle: false,
    async candidates(session, { query, position, signal }) {
      if (position !== 'leading') return []
      const view = await configuration(session, signal)
      if (!view?.check.available || !view.name.startsWith(query.trim().toLowerCase())) return []
      return [{ name: view.name, description: '在当前工作区交给 Orchestra 执行一次任务', hint }]
    },
    onPick({ session, candidate: picked, position }) {
      const saved = current.get(session.sessionId)
      if (position === 'leading' && saved?.view.check.available && saved.view.name === picked.name
        && workspaceOf(session.sessionId) === saved.workspaceId && (!clientCommands || clientCommands.check(picked.name).available)) {
        return { text: '/' + picked.name + ' ' }
      }
      return undefined
    },
    async matchEnter(session, line, signal) {
      const token = line.trim().split(/\s/u, 1)[0]
      if (!token?.startsWith('/') || !workspaceOf(session.sessionId)) return undefined
      const view = await configuration(session, signal)
      if (!view) {
        if (token === '/' + (current.get(session.sessionId)?.view.name ?? DEFAULT_TASK_COMMAND) && !signal.aborted) {
          throw new Error('暂时无法检查 Orchestra 任务命令，请稍后重试或在设置中重新读取。')
        }
        return undefined
      }
      if (token !== '/' + view.name) return undefined
      if (!view.check.available) throw new Error(`/${view.name} 与已有命令冲突，请在 Orchestra 设置中更换任务命令。`)
      // Preserve the original native draft and request identity for typed admission.
      if (line.trim() !== token) return undefined
      return { claim: { name: view.name, token: token + ' ', hint,
        submit: () => ({ kind: 'success', text: `用法：${token} 任务内容` }) } }
    },
  })
  return () => { lifetime.abort(); current.clear(); dispose() }
}
