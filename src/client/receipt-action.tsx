import { useMemo, useState, useSyncExternalStore } from 'react'
import { createApiClient } from './api/client.ts'
import { createResourcesApi } from './api/resources.ts'
import { createLocalSessionFetcher, localPanelBase, selectedSession, workspaceForSession,
  type DshLocalPanelSources } from './dsh-local-panel.tsx'
import type { ReceiptLocation } from '../core/receipt-location.ts'

type Resources = ReturnType<typeof createResourcesApi>

/**
 * 打开回执指向的对象（T16）。元数据只用于导航：这里按当前会话重新读一遍，
 * 归属、版本或权限变了就明确拒绝，绝不打开另一个任务的文件。
 */
async function readReceiptTarget(api: Resources, ref: ReceiptLocation) {
  const { data: run } = await api.getRun(ref.runId)
  if (run.task_id !== ref.taskId || run.run_id !== ref.runId) throw new Error('此回执与当前任务不匹配')
  if (ref.kind === 'decision') {
    const { data } = await api.getDecision(ref.decisionId)
    if (data.run_id !== run.run_id || data.decision_id !== ref.decisionId) throw new Error('待办归属已变化')
    return { title: '本次待办', body: data.target_summary ?? '请打开待办详情核对。' }
  }
  if (ref.kind === 'artifact') {
    const { data: file } = await api.getArtifact(ref.artifactId)
    if (file.run_id !== run.run_id || file.sha256 !== ref.sha256 || file.expired) throw new Error('本版本成果不可用')
    const { data: preview } = await api.getArtifactContent(run.run_id, file.artifact_id, 'preview')
    if (preview.kind !== 'preview' || preview.sha256 !== ref.sha256) throw new Error('成果版本已变化')
    return { title: preview.file_name, body: preview.text + (preview.truncated ? '\n（预览已截断，完整内容请下载）' : '') }
  }
  return { title: run.task_title || '本次任务', body: '状态：' + run.status }
}

export function ReceiptAction({ location, sources }: { location: ReceiptLocation; sources: DshLocalPanelSources }) {
  const sessions = useSyncExternalStore((cb) => sources.sessions.list.subscribe(cb), () => sources.sessions.list.getSnapshot())
  const workspaces = useSyncExternalStore((cb) => sources.workspaces.list.subscribe(cb), () => sources.workspaces.list.getSnapshot())
  // 切换会话/工作区后旧回执不再展示，晚到的结果也不会落到新会话（T16）。
  if (selectedSession(sessions) !== location.sessionId
    || workspaceForSession(location.sessionId, workspaces) !== location.workspaceId) return null
  return <ScopedReceipt key={JSON.stringify(location)} location={location} sources={sources} />
}

function ScopedReceipt({ location, sources }: { location: ReceiptLocation; sources: DshLocalPanelSources }) {
  const api = useMemo(() => createResourcesApi(createApiClient(localPanelBase,
    createLocalSessionFetcher(sources, location.workspaceId, location.sessionId))),
  [sources, location.workspaceId, location.sessionId])
  const [panel, setPanel] = useState<{ title: string; body: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const label = location.kind === 'artifact' ? '打开这份成果' : location.kind === 'decision' ? '查看这项待办' : '查看任务状态'
  async function show() {
    setBusy(true)
    setError('')
    try { setPanel(await readReceiptTarget(api, location)) }
    catch { setError('暂时无法打开。可在当前会话的任务页搜索任务编号：' + location.taskId) }
    finally { setBusy(false) }
  }
  return <section aria-label="回执详情" style={{ marginTop: 6 }}>
    <button type="button" aria-expanded={panel !== undefined} disabled={busy}
      onClick={() => panel ? setPanel(undefined) : void show()}>{panel ? '收起' : busy ? '正在读取…' : label}</button>
    {error && <p role="alert" style={{ margin: '4px 0', color: '#b42318' }}>{error}</p>}
    {panel && <div style={{ marginTop: 4 }}>
      <strong>{panel.title}</strong>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto', margin: '4px 0' }}>{panel.body}</pre>
    </div>}
  </section>
}
