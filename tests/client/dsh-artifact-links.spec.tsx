// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { act } from 'react'
import { sha256Hex } from '../../src/core/canonical.ts'
import type { ChatArtifactLink } from '../../src/core/receipt-location.ts'
import { createArtifactBrowserReader } from '../../src/service/artifact-browser.ts'
import { ArtifactLinks, downloadChatArtifact, openChatArtifact } from '../../src/client/dsh-artifact-links.tsx'
import type { DshLocalPanelSources } from '../../src/client/dsh-local-panel.tsx'
import { deferred, renderPanel } from './harness.ts'

const artifact: ChatArtifactLink = { title: '完整简报', fileName: '简报.md', location: {
  kind: 'artifact', workspaceId: 'workspace', sessionId: 'session', taskId: 'task', runId: 'run',
  artifactId: 'artifact', sha256: 'a'.repeat(64),
} }
function sources() {
  let active = 'session'
  const value: DshLocalPanelSources = {
    sessions: { list: { getSnapshot: () => ({ byId: { [active]: { id: active, retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'workspace', sessionIds: ['session', 'other'] }], archivedSessionIds: [] }), subscribe: () => () => {} } },
  }
  return { value, select: (next: string) => { active = next } }
}

it('uses the public native Browser API with a live loopback URL whose complete ending is readable', async () => {
  const realFetch = globalThis.fetch.bind(globalThis)
  const body = '# 简报\n\n' + '完整内容。\n'.repeat(3000) + '\n完整文档末尾：VERIFIED-LAST-BYTES'
  const bytes = Buffer.from(body)
  const sha256 = sha256Hex(bytes)
  const target = { ...artifact, location: { ...artifact.location, sha256 } }
  const reader = createArtifactBrowserReader({ read: async () => ({ fileName: target.fileName, bytes, sha256 }) })
  const host = sources()
  const calls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.href)
    expect(url.pathname).toBe('/api/orchestra.request')
    expect(url.searchParams.get('path')).toBe('/v1/artifacts/open-browser')
    expect(url.searchParams.get('workspaceId')).toBe('workspace')
    expect(url.searchParams.get('sessionId')).toBe('session')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' })
    expect(new Headers(init?.headers).get('x-orchestra-request')).toBe('1')
    expect(JSON.parse(String(init?.body))).toEqual(target.location)
    return Response.json({ ok: true, schema_version: 1, as_of_seq: 0, data: await reader.open(target.location, 'local-bound-source') })
  })
  vi.stubGlobal('fetch', calls)
  let navigatedText = ''
  const browser = { sidebarRightTabs: { get: () => ({ id: 'browser' }) }, sidebarRight: {
    openTab: vi.fn(async (name: string, options: { params: { url: string } }) => {
      expect(name).toBe('browser')
      // A real HTTP navigation proves this is not a virtual dsh.internal API URL.
      const response = await realFetch(options.params.url)
      expect(response.status).toBe(200)
      navigatedText = await response.text()
    }),
  } }
  const view = await renderPanel(<ArtifactLinks artifacts={[target]} openArtifact={(link, signal) => openChatArtifact(link, host.value, browser, signal)} />)
  try {
    expect(view.text()).toContain('完整成果完整简报')
    await act(async () => {
      await view.click(view.findAll('a')[0]!)
      await expect.poll(() => navigatedText).toContain('完整文档末尾：VERIFIED-LAST-BYTES')
    })
    await view.flush()
    expect(navigatedText.split('完整内容。')).toHaveLength(3001)
    expect(browser.sidebarRight.openTab).toHaveBeenCalledTimes(1)
    expect(view.byRole('alert')).toHaveLength(0)
    expect(view.findAll('a')[0]!.getAttribute('href')).not.toContain('http:')
    expect(view.container.innerHTML).not.toContain('/artifacts/')
    // The original, durable link mints a fresh URL on every later click.
    await act(async () => {
      await view.click(view.findAll('a')[0]!)
      await expect.poll(() => browser.sidebarRight.openTab.mock.calls.length).toBe(2)
    })
    expect(browser.sidebarRight.openTab.mock.calls[1]![1].params.url).not.toBe(browser.sidebarRight.openTab.mock.calls[0]![1].params.url)
  } finally { view.unmount(); vi.unstubAllGlobals(); await reader.close() }
})

it('does not open a result after the selected session changes, and explains browser and transport failures', async () => {
  const host = sources()
  const reply = deferred<Response>()
  const fetcher = vi.fn(() => reply.promise)
  vi.stubGlobal('fetch', fetcher)
  const browser = { sidebarRightTabs: { get: () => ({}) }, sidebarRight: { openTab: vi.fn() } }
  try {
    await expect(openChatArtifact(artifact, host.value, undefined)).rejects.toThrow('内置浏览器未启用')
    expect(fetcher).not.toHaveBeenCalled()
    const pending = openChatArtifact(artifact, host.value, browser)
    await expect.poll(() => fetcher.mock.calls.length).toBe(1)
    host.select('other')
    reply.resolve(Response.json({ ok: true, schema_version: 1, as_of_seq: 0, data: {
      url: 'http://127.0.0.1:4444/artifacts/' + 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } }))
    await expect(pending).rejects.toThrow('当前会话已改变')
    expect(browser.sidebarRight.openTab).not.toHaveBeenCalled()
    host.select('session')
    fetcher.mockRejectedValueOnce(new Error('network diagnostic containing private URL'))
    const view = await renderPanel(<ArtifactLinks artifacts={[artifact]} openArtifact={link => openChatArtifact(link, host.value, browser)} />)
    try {
      await view.click(view.findAll('a')[0]!); await view.flush()
      expect(view.byRole('alert')[0]?.textContent).toContain('暂时无法连接成果服务')
      expect(view.text()).not.toContain('private URL')
    } finally { view.unmount() }
  } finally { vi.unstubAllGlobals() }
})

it.each(['file:///secret', 'data:text/html,bad', 'http://dsh.internal/api/orchestra.request', 'http://remote.invalid/artifacts/' + 'a'.repeat(64)])(
  'rejects an unexpected browser address %s', async url => {
    const host = sources()
    const browser = { sidebarRightTabs: { get: () => ({}) }, sidebarRight: { openTab: vi.fn() } }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, schema_version: 1, as_of_seq: 0,
      data: { url, expiresAt: new Date(Date.now() + 60_000).toISOString() } })))
    try {
      await expect(openChatArtifact(artifact, host.value, browser)).rejects.toThrow('成果阅读地址已失效')
      expect(browser.sidebarRight.openTab).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  },
)

it('downloads the original binary from the same verified receipt without entering a Browser guest and releases its Blob URL', async () => {
  const bytes = Buffer.from([0, 255, 1, 254, 2, 253, 3, 252])
  const target = { ...artifact, title: '原始附件', fileName: '附件.pdf', location: { ...artifact.location, sha256: sha256Hex(bytes) } }
  const host = sources()
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:original-artifact')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL })
  const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const cleanup = vi.spyOn(window, 'setTimeout')
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.href)
    expect(url.searchParams.get('path')).toBe('/v1/artifacts/download')
    expect(JSON.parse(String(init?.body))).toEqual(target.location)
    return Response.json({ ok: true, schema_version: 1, as_of_seq: 0, data: {
      kind: 'download', file_name: target.fileName, sha256: target.location.sha256, size_bytes: bytes.length, base64: bytes.toString('base64'),
    } })
  })
  vi.stubGlobal('fetch', fetcher)
  const view = await renderPanel(<ArtifactLinks artifacts={[target]} downloadArtifact={(link, signal) => downloadChatArtifact(link, host.value, signal)} />)
  try {
    await view.click(view.findAll('button')[0]!); await view.flush()
    expect(view.text()).toContain('已发起「附件.pdf」的原件下载')
    expect(saved.mock.instances[0]).toMatchObject({ download: '附件.pdf', href: 'blob:original-artifact' })
    const blob = createObjectURL.mock.calls[0]![0]
    const actual = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = reject
      reader.readAsArrayBuffer(blob)
    })
    expect(Buffer.from(actual)).toEqual(bytes)
    const timerIndex = cleanup.mock.calls.findIndex(([, ms]) => ms === 1000)
    const release = cleanup.mock.calls[timerIndex]?.[0]
    window.clearTimeout(cleanup.mock.results[timerIndex]?.value)
    if (typeof release === 'function') release()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:original-artifact')
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, schema_version: 1, as_of_seq: 0, data: {
      kind: 'download', file_name: target.fileName, sha256: 'd'.repeat(64), size_bytes: bytes.length, base64: bytes.toString('base64'),
    } }))
    await expect(downloadChatArtifact(target, host.value)).rejects.toThrow('返回文件与此成果版本不一致')
    expect(saved).toHaveBeenCalledTimes(1)
  } finally { view.unmount(); vi.unstubAllGlobals(); saved.mockRestore(); cleanup.mockRestore() }
})
