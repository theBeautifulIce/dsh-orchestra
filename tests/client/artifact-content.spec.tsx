// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import type { RunArtifact } from '../../src/client/api/types.ts'
import { ArtifactContent } from '../../src/client/panel/artifact-content.tsx'
import { createFakeService, renderPanel } from './harness.ts'

const artifact: RunArtifact = {
  artifact_id: 'deliverable-1', run_id: 'r1', sha256: 'expected-sha', retain_until: null,
  created_at: '2026-11-18T01:00:00.000Z', expired: false, file_name: '交付产物.html', size_bytes: 3,
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
