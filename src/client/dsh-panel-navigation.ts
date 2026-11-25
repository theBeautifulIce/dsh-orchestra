import { panelReceiptLocation, type PanelReceiptLocation } from '../core/receipt-location.ts'
import { createApiClient } from './api/client.ts'
import { createResourcesApi } from './api/resources.ts'
import { createLocalSessionFetcher, localPanelBase, selectedSession, workspaceForSession,
  type DshLocalPanelSources } from './dsh-local-panel.tsx'

export type OpenPanelReceipt = (location: PanelReceiptLocation, signal?: AbortSignal) => Promise<void>
export type PanelNavigationHost = {
  layout: { beginNavigation(): AbortSignal; selectPanel(panelId: string | null): void }
}

/** Re-read ownership before a read-only navigation. A persisted link never grants permission. */
export async function openPanelReceipt(location: PanelReceiptLocation, sources: DshLocalPanelSources | undefined,
  host: PanelNavigationHost | undefined, open: (location: PanelReceiptLocation) => void, signal?: AbortSignal) {
  const target = panelReceiptLocation.parse(location)
  if (!sources || !host) throw new Error('Orchestra 面板暂不可用。请在侧栏打开 Orchestra 后重试。')
  const current = () => selectedSession(sources.sessions.list.getSnapshot()) === target.sessionId
    && workspaceForSession(target.sessionId, sources.workspaces.list.getSnapshot()) === target.workspaceId
  if (!current()) throw new Error('请先切回这项任务的来源会话。')
  const navigation = host.layout.beginNavigation()
  const active = signal ? AbortSignal.any([signal, navigation]) : navigation
  const api = createResourcesApi(createApiClient(localPanelBase,
    createLocalSessionFetcher(sources, target.workspaceId, target.sessionId)))
  const { data: run } = await api.getRun(target.runId, active)
  if (run.run_id !== target.runId || run.task_id !== target.taskId) throw new Error('这项通知与当前任务不匹配。请刷新任务状态。')
  if (target.kind === 'decision') {
    const { data: decision } = await api.getDecision(target.decisionId, active)
    if (decision.decision_id !== target.decisionId || decision.run_id !== target.runId) {
      throw new Error('待处理事项的归属已变化。请刷新任务状态。')
    }
  }
  active.throwIfAborted()
  if (!current()) throw new Error('当前会话已切换。请回到来源会话后重试。')
  open(target)
  host.layout.selectPanel('dsh-orchestra')
}
