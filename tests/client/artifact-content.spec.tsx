// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import type { RunArtifact } from '../../src/client/api/types.ts'
import { ArtifactContent } from '../../src/client/panel/artifact-content.tsx'
import { createFakeService, deferred, renderPanel, type FakeReply } from './harness.ts'

const artifact: RunArtifact = {
  artifact_id: 'deliverable-1', run_id: 'r1', sha256: 'expected-sha', retain_until: null,
  created_at: '2026-11-18T01:00:00.000Z', expired: false, file_name: '交付产物.html', size_bytes: 3,
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function preview(text: string, version = artifact): FakeReply {
  return { ok: true, data: { kind: 'preview', file_name: version.file_name, sha256: version.sha256, text, truncated: false } }
}

it.each<Partial<RunArtifact>>([{ run_id: 'r2' }, { artifact_id: 'deliverable-2' }, { sha256: 'updated-sha' }])(
  'resets a same-name preview when any identity field changes (%j)',
  async (change) => {
    const next = { ...artifact, ...change }
    const service = createFakeService(vi.fn()
      .mockReturnValueOnce(preview('第一版'))
      .mockReturnValueOnce(preview('当前版', next)))
    const api = createResourcesApi(createApiClient('http://artifact.test', service.fetcher))
    const view = await renderPanel(<ArtifactContent api={api} artifact={artifact} />)
    try {
      await view.click(view.findAll('button')[0]!)
      expect(view.findAll('pre')[0]?.textContent).toBe('第一版')
      await view.rerender(<ArtifactContent api={api} artifact={next} />)
      expect(view.findAll('pre')).toHaveLength(0)
      await view.click(view.findAll('button')[0]!)
      expect(view.findAll('pre')[0]?.textContent).toBe('当前版')
      expect(service.calls.map(({ params }) => [params.get('run_id'), params.get('artifact_id')]))
        .toEqual([[artifact.run_id, artifact.artifact_id], [next.run_id, next.artifact_id]])
    } finally { view.unmount() }
  },
)

it('ignores the first A errors and results while the current A loads after A → B → A', async () => {
  const first = deferred<FakeReply>()
  const second = deferred<FakeReply>()
  const current = deferred<FakeReply>()
  const other = { ...artifact, artifact_id: 'other', sha256: 'other-sha' }
  const service = createFakeService(vi.fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(current.promise))
  const api = createResourcesApi(createApiClient('http://artifact.test', service.fetcher))
  const view = await renderPanel(<ArtifactContent api={api} artifact={artifact} />)
  try {
    await view.click(view.findAll('button')[0]!)
    await view.rerender(<ArtifactContent api={api} artifact={other} />)
    await view.click(view.findAll('button')[0]!)
    await view.rerender(<ArtifactContent api={api} artifact={artifact} />)
    expect(view.byRole('status')).toHaveLength(0)
    await view.click(view.findAll('button')[0]!)
    first.resolve(preview('第一次选择的 A'))
    second.resolve({ ok: false, error: { code: 'NOT_FOUND', message: '上一份成果不存在', retryable: false } })
    await view.flush()
    expect(view.findAll('pre')).toHaveLength(0)
    expect(view.byRole('alert')).toHaveLength(0)
    expect(view.byRole('status')).toHaveLength(1)
    current.resolve(preview('再次选择的 A'))
    await view.flush()
    expect(view.findAll('pre')[0]?.textContent).toBe('再次选择的 A')
    expect(service.calls.map(({ params }) => params.get('artifact_id'))).toEqual([artifact.artifact_id, other.artifact_id, artifact.artifact_id])
  } finally { view.unmount() }
})

it.each([
  [{ expired: true }, '已超过保留期限'],
  [{ retain_until: 'invalid old timestamp' }, '保留期限未通过校验'],
  [{ file_name: undefined }, '仅有登记记录'],
] as const)('keeps the artifact content unavailable for %j', async (change, message) => {
  const pending = deferred<FakeReply>()
  const service = createFakeService(() => pending.promise)
  const api = createResourcesApi(createApiClient('http://artifact.test', service.fetcher))
  const view = await renderPanel(<ArtifactContent api={api} artifact={artifact} />)
  try {
    await view.click(view.findAll('button')[0]!)
    await view.rerender(<ArtifactContent api={api} artifact={{ ...artifact, ...change }} />)
    pending.resolve(preview('先前结果'))
    await view.flush()
    expect(view.text()).toContain(message)
    expect(view.findAll('button, pre')).toHaveLength(0)
    expect(service.calls).toHaveLength(1)
    await view.rerender(<ArtifactContent api={api} artifact={artifact} />)
    expect(view.findAll('pre')).toHaveLength(0)
  } finally { view.unmount() }
})

it('removes downloaded preview text and actions at the deadline even without a new metadata response', async () => {
  const now = Date.parse('2026-11-19T01:00:00.000Z')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const timers = vi.spyOn(window, 'setTimeout')
  const expiring = { ...artifact, retain_until: new Date(now + 5_000).toISOString() }
  const service = createFakeService(() => preview('到期后应从界面移除'))
  const api = createResourcesApi(createApiClient('http://artifact.test', service.fetcher))
  const view = await renderPanel(<ArtifactContent api={api} artifact={expiring} />)
  try {
    await view.click(view.findAll('button')[0]!)
    expect(view.findAll('pre')[0]?.textContent).toContain('到期后应从界面移除')
    const index = timers.mock.calls.findIndex(([, ms]) => ms === 5_000)
    const tick = timers.mock.calls[index]?.[0]
    if (typeof tick !== 'function') throw new Error('Expiry timer was not scheduled')
    clock.mockReturnValue(now + 5_000)
    tick()
    await view.flush()
    expect(view.findAll('button, pre')).toHaveLength(0)
    expect(view.text()).toContain('已超过保留期限')
    expect(service.calls).toHaveLength(1)
  } finally { view.unmount() }
})

it('以纯文本显示主动内容，下载生成带正确文件名的二进制附件', async () => {
  const script = '<script>window.malformedContentRan = true</script>'
  const service = createFakeService(({ params }) => ({
    ok: true,
    data: params.get('mode') === 'preview'
      ? { kind: 'preview', file_name: artifact.file_name, sha256: artifact.sha256, text: script, truncated: false }
      : { kind: 'download', file_name: artifact.file_name, sha256: artifact.sha256, size_bytes: 3, base64: 'AAEC' },
  }))
  const api = createResourcesApi(createApiClient('http://artifact.test', service.fetcher))
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:artifact')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = createObjectURL
    static revokeObjectURL = revokeObjectURL
  })
  const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const cleanup = vi.spyOn(window, 'setTimeout')
  const view = await renderPanel(<ArtifactContent api={api} artifact={artifact} />)
  try {
    await view.click(view.findAll('button')[0]!)
    expect(view.findAll('pre')[0]?.textContent).toBe(script)
    expect(view.findAll('script')).toHaveLength(0)
    await view.click(view.findAll('button')[1]!)
    expect(service.calls.map(({ params }) => [params.get('run_id'), params.get('artifact_id'), params.get('mode')]))
      .toEqual([['r1', 'deliverable-1', 'preview'], ['r1', 'deliverable-1', 'download']])
    expect(createObjectURL.mock.calls[0]?.[0]).toMatchObject({ size: 3, type: 'application/octet-stream' })
    expect(saved.mock.instances[0]).toMatchObject({ download: artifact.file_name, href: 'blob:artifact' })
    const timerIndex = cleanup.mock.calls.findIndex(([, ms]) => ms === 1000)
    const release = cleanup.mock.calls[timerIndex]?.[0]
    window.clearTimeout(cleanup.mock.results[timerIndex]?.value)
    if (typeof release === 'function') release()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:artifact')
  } finally { view.unmount() }
})
