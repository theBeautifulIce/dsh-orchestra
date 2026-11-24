import { useEffect, useRef, useState } from 'react'
import { artifactVersionKey, type ChatArtifactLink } from '../core/receipt-location.ts'
import { ApiError, createApiClient } from './api/client.ts'
import type { ArtifactContentView } from './api/types.ts'
import { saveArtifact } from './panel/artifact-content.tsx'
import { createLocalSessionFetcher, isDshLocalShell, localPanelBase, selectedSession, workspaceForSession,
  type DshLocalPanelSources } from './dsh-local-panel.tsx'

export type ArtifactBrowser = {
  sidebarRight: { openTab(name: 'browser', options: { params: { url: string } }): unknown }
  sidebarRightTabs: { get(name: 'browser'): unknown }
}
export type OpenChatArtifact = (artifact: ChatArtifactLink, signal?: AbortSignal) => Promise<void>

export async function downloadChatArtifact(artifact: ChatArtifactLink, sources: DshLocalPanelSources | undefined,
  signal?: AbortSignal): Promise<void> {
  const { location } = artifact
  const current = () => sources && selectedSession(sources.sessions.list.getSnapshot()) === location.sessionId
    && workspaceForSession(location.sessionId, sources.workspaces.list.getSnapshot()) === location.workspaceId
  if (typeof window === 'undefined' || !isDshLocalShell(window.location.href) || !sources || !current())
    throw new Error('请在成果所属的原会话中下载此成果。')
  const api = createApiClient(localPanelBase, createLocalSessionFetcher(sources, location.workspaceId, location.sessionId))
  let content: ArtifactContentView
  try { content = (await api.post<ArtifactContentView>('/v1/artifacts/download', location, signal)).data } catch (error) {
    if (signal?.aborted) throw new Error('成果下载已取消，请再次点击“下载原件”。')
    if (error instanceof ApiError && ['OPERATION_EXPIRED', 'NOT_FOUND', 'FORBIDDEN', 'CONFIRMATION_MISMATCH', 'RANGE_TOO_LARGE'].includes(error.code))
      throw new Error(error.message)
    throw new Error('暂时无法连接成果服务。请确认 Orchestra 已启动，再次点击“下载原件”。')
  }
  signal?.throwIfAborted()
  if (!current()) throw new Error('当前会话已改变。请回到成果所属的原会话重新下载。')
  if (!content || typeof content !== 'object' || content.kind !== 'download' || content.sha256 !== location.sha256 || content.file_name !== artifact.fileName
    || !Number.isSafeInteger(content.size_bytes) || content.size_bytes < 0 || content.size_bytes > 8 * 1024 * 1024)
    throw new Error('返回文件与此成果版本不一致，已取消下载。')
  try { saveArtifact(content) } catch { throw new Error('原件下载未能发起，请稍后重试。') }
}

/** The same-origin host route authorizes each click. Its short-lived URL is never stored in chat. */
export async function openChatArtifact(artifact: ChatArtifactLink, sources: DshLocalPanelSources | undefined,
  browser: ArtifactBrowser | undefined, signal?: AbortSignal): Promise<void> {
  const { location } = artifact
  const current = () => sources && selectedSession(sources.sessions.list.getSnapshot()) === location.sessionId
    && workspaceForSession(location.sessionId, sources.workspaces.list.getSnapshot()) === location.workspaceId
  if (typeof window === 'undefined' || !isDshLocalShell(window.location.href) || !sources || !current())
    throw new Error('请在成果所属的原会话中打开此成果。')
  if (!browser?.sidebarRightTabs.get('browser')) throw new Error('DSH 内置浏览器未启用。请启用浏览器后再次点击成果名称。')
  const api = createApiClient(localPanelBase, createLocalSessionFetcher(sources, location.workspaceId, location.sessionId))
  let result: { url: string; expiresAt: string }
  try { result = (await api.post<{ url: string; expiresAt: string }>('/v1/artifacts/open-browser', location, signal)).data } catch (error) {
    if (signal?.aborted) throw new Error('成果打开已取消，请再次点击成果名称。')
    if (error instanceof ApiError && ['OPERATION_EXPIRED', 'NOT_FOUND', 'FORBIDDEN', 'CONFIRMATION_MISMATCH', 'RANGE_TOO_LARGE'].includes(error.code))
      throw new Error(error.message)
    throw new Error('暂时无法连接成果服务。请确认 Orchestra 已启动，再次点击成果名称。')
  }
  signal?.throwIfAborted()
  if (!current()) throw new Error('当前会话已改变。请回到成果所属的原会话重新打开。')
  let url: URL
  try { url = new URL(result.url) } catch { throw new Error('成果阅读地址无效，请重新打开。') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.search || url.hash || !/^\/artifacts\/[a-f0-9]{64}$/u.test(url.pathname)
    || url.origin === window.location.origin || !(Date.parse(result.expiresAt) > Date.now()))
    throw new Error('成果阅读地址已失效，请再次点击成果名称。')
  // rc.5 Browser is a sandboxed webview, so use its public tab API with a real HTTP URL.
  try { await browser.sidebarRight.openTab('browser', { params: { url: url.href } }) } catch {
    throw new Error('DSH 内置浏览器暂时无法打开。请稍后再次点击成果名称。')
  }
}

export function ArtifactLinks({ artifacts, openArtifact, downloadArtifact }: {
  artifacts: readonly ChatArtifactLink[]; openArtifact?: OpenChatArtifact; downloadArtifact?: OpenChatArtifact
}) {
  const [opening, setOpening] = useState<string>()
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const pending = useRef<AbortController>()
  useEffect(() => () => pending.current?.abort(), [])
  const unique = [...new Map(artifacts.map(item => [artifactVersionKey(item.location), item])).values()]
  if (!unique.length) return null
  const open = async (artifact: ChatArtifactLink, download = false) => {
    if (pending.current) return
    const action = download ? downloadArtifact : openArtifact
    if (!action) { setError('请在 DSH 原会话中打开此成果。'); return }
    const controller = new AbortController()
    pending.current = controller
    setOpening(artifactVersionKey(artifact.location)); setError(''); setMessage('')
    try {
      await action(artifact, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
      if (download && !controller.signal.aborted) setMessage('已发起「' + artifact.fileName + '」的原件下载。')
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '暂时无法打开成果，请稍后重试。')
    } finally {
      pending.current = undefined
      if (!controller.signal.aborted) setOpening(undefined)
    }
  }
  return <section data-orchestra-artifacts aria-label="完整成果" style={{ marginBlock: 12 }}>
    <strong style={{ fontSize: '0.95em' }}>完整成果</strong>
    <ul style={{ marginBlock: 8, paddingLeft: 20 }}>
      {unique.map(artifact => <li key={artifactVersionKey(artifact.location)} style={{ marginBlock: 6 }}>
        <a href={'#orchestra-artifact-' + encodeURIComponent(artifact.location.artifactId)}
          title={'在 DSH 浏览器打开 ' + artifact.fileName} aria-disabled={Boolean(opening)}
          style={{ color: 'var(--color-primary, #3779d8)', textDecoration: 'underline', textUnderlineOffset: 3, overflowWrap: 'anywhere' }}
          onClick={event => { event.preventDefault(); void open(artifact) }}>{artifact.title}</a>
        <button type="button" disabled={Boolean(opening)} onClick={() => { void open(artifact, true) }}
          style={{ marginLeft: 12, border: 0, padding: 0, background: 'none', color: 'inherit', font: 'inherit',
            fontSize: '0.85em', textDecoration: 'underline', textUnderlineOffset: 3, cursor: 'pointer', opacity: 0.75 }}>下载原件</button>
        {opening === artifactVersionKey(artifact.location) && <span role="status"> · 正在读取…</span>}
      </li>)}
    </ul>
    {error && <p role="alert" style={{ marginBlock: 8 }}>{error}</p>}
    {message && <p role="status" style={{ marginBlock: 8 }}>{message}</p>}
  </section>
}
