// @vitest-environment jsdom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ApiError, createApiClient, type ApiClient } from '../../src/client/api/client.ts'
import { createReworkApi, type ReworkItem } from '../../src/client/api/rework.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import type { ArtifactContentView, RunArtifact } from '../../src/client/api/types.ts'
import { ReworkPanel, LineComparison } from '../../src/client/panel/rework-panel.tsx'
import { deferred, renderPanel, nodeRunView, type PanelView } from './harness.ts'

const oldHash = 'a'.repeat(64), newHash = 'b'.repeat(64)
const request = { request_id: 'rw1', run_id: 'r1', requester_actor: 'human', target_node_run_id: 'old', target_attempt: 1, source_artifact_id: 'v1', source_artifact_hash: oldHash, reason: '缺少时间字段', expected_result: '补充真实采集时间', suggested_scope: 'targeted_revision', status: 'awaiting_review', revision: 3, round_no: 1, max_rounds: 3, new_node_run_id: 'new', updated_at: '2026-11-19' } as ReworkItem
const artifacts = [{ artifact_id: 'v1', run_id: 'r1', sha256: oldHash, expired: false, retain_until: null, source_node_run_id: 'old', created_at: '2026-11-19' }, { artifact_id: 'v2', run_id: 'r1', sha256: newHash, expired: false, retain_until: null, source_node_run_id: 'new', created_at: '2026-11-19' }]
function clientFor(item: ReworkItem = request) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const client: ApiClient = {
    async get<T>(path: string) {
      const data = path === '/v1/rework' ? { items: [item] } : path === '/v1/rework/get' ? { item: { request: item, attempts: [], dispatch_blocks: [{ node_id: 'audit', node_run_id: 'a2', reason: 'TOOL_NOT_ALLOWED', message: '核验工具授权已变化', resolved_at: null }], reviews: [{ review_id: 'review1', round_no: 1, reviewer_actor: 'human', action: 'authorize', note: '允许补齐数据', created_at: '2026-11-19' }] } }
        : path === '/v1/artifacts' ? { items: artifacts, has_more: false }
        : path === '/v1/node-runs' ? { items: [nodeRunView({ node_run_id: 'old', node_type: 'agent', status: 'done', revision: 7, replacement_node_run_id: null })] }
        : path === '/v1/rework/holds' ? { items: [] } : { plan: null }
      return { data: data as T, as_of_seq: 9 }
    },
    async post<T>(path: string, payload: unknown) { posts.push({ path, body: payload as Record<string, unknown> }); return { data: {} as T, as_of_seq: 10 } },
  }
  return { client, posts }
}
async function fill(element: Element, value: string) {
  await act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element.tagName === 'TEXTAREA' ? 'input' : 'change', { bubbles: true }))
  })
}

function version(artifact_id: string, source_node_run_id: string, text: string) {
  const metadata: RunArtifact = {
    artifact_id, run_id: 'r1', source_node_run_id, sha256: createHash('sha256').update(text).digest('hex'),
    expired: false, retain_until: null, file_name: 'report.txt', size_bytes: Buffer.byteLength(text), created_at: '2026-11-19',
  }
  return { metadata, text }
}

const source = version('source', 'old', '原始成果')
const revisionA = version('A', 'new', '内容 A')
const revisionB = version('B', 'new', '内容 B')
const updateSource = version('source', 'old', '更新后的原始成果')
type Version = ReturnType<typeof version>
function content({ metadata, text }: Version, mode: string | number | undefined = 'preview'): ArtifactContentView {
  const identity = { file_name: metadata.file_name!, sha256: metadata.sha256, size_bytes: metadata.size_bytes! }
  return mode === 'download'
    ? { ...identity, kind: 'download', base64: Buffer.from(text).toString('base64') }
    : { ...identity, kind: 'preview', text, truncated: false }
}

function versionsFixture({ before = source, a = revisionA, b = revisionB, form = false, locked = false } = {}) {
  const versions = [before, a, b]
  const item = { ...request, source_artifact_id: before.metadata.artifact_id, source_artifact_hash: before.metadata.sha256 }
  const history = {
    request: item, attempts: locked ? [{ attempt_id: 'attempt1', round_no: 1, result_artifact_id: a.metadata.artifact_id,
      result_artifact_hash: a.metadata.sha256, source_artifact_id: before.metadata.artifact_id }] : [],
    reviews: [],
  }
  const { client, posts } = clientFor(item)
  const get = client.get
  const read = vi.fn(async (selected: Version, mode: string | number | undefined) => content(selected, mode))
  const reads: unknown[] = []
  client.get = async <T,>(path: string, query?: Record<string, string | number | undefined>) => {
    let data: unknown
    switch (path) {
      case '/v1/rework/get': data = { item: history }; break
      case '/v1/artifacts': data = { items: versions.map(v => v.metadata), has_more: false }; break
      case '/v1/rework/holds': data = { items: [{ run_id: 'r1', node_id: 'n1', node_run_id: 'old', status: 'held' }] }; break
      case '/v1/artifacts/content': {
        reads.push(query)
        const selected = versions.find(v => v.metadata.artifact_id === query?.artifact_id && v.metadata.run_id === query?.run_id)
        if (!selected) throw new Error('没有对应的产物')
        data = await read(selected, query?.mode)
        break
      }
      default: return get<T>(path, query)
    }
    return { data: data as T, as_of_seq: 9 }
  }
  const panel = <ReworkPanel api={createResourcesApi(client)} commands={createReworkApi(client)} runId={form ? 'r1' : undefined} plannerEnabled={form} />
  return { panel, posts, read, reads }
}

function openDetails(view: PanelView, title: string) {
  const summary = view.findAll('summary').find(el => el.textContent === title)!
  const details = summary.parentElement as HTMLDetailsElement
  details.open = true
  return details
}

function button(inElement: ParentNode, label: string) {
  return Array.from(inElement.querySelectorAll('button')).find(el => el.textContent === label)!
}

async function selectFormArtifact(details: HTMLDetailsElement, artifactId: string) {
  const [node, artifact] = details.querySelectorAll('select')
  if (node!.value !== 'old') await fill(node!, 'old')
  await fill(artifact!, artifactId)
  return artifact!
}

describe('成果审核与返工', () => {
  it('invalidates a displayed same-name preview and binds the hold acceptance, feedback and inspection to B', async () => {
    const a = version('A', 'old', '内容 A')
    const b = version('B', 'old', '内容 B')
    const fixture = versionsFixture({ a, b, form: true })
    const view = await renderPanel(fixture.panel)
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:report')
    const cleanup = vi.spyOn(window, 'setTimeout')
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = vi.fn()
    })
    try {
      const form = openDetails(view, '审核成果或提出修改')
      await selectFormArtifact(form, 'A')
      await view.click(button(form, '预览内容'))
      expect(form.querySelector('pre')?.textContent).toBe('内容 A')
      const select = await selectFormArtifact(form, 'B')
      const observed = {
        title: form.querySelector('section')?.getAttribute('aria-label'),
        label: select.selectedOptions[0]?.textContent,
        text: form.querySelector('pre')?.textContent,
      }
      await view.click(button(form, '通过成果验收'))
      const [criteria, reason, expected] = form.querySelectorAll('textarea')
      await fill(criteria!, '核对 B 的内容')
      await view.click(button(form, '请主脑检查成果'))
      await fill(reason!, '记录对 B 的意见')
      await fill(expected!, '保留正确内容')
      await view.click(button(form, '要求修改'))
      expect(fixture.posts).toMatchObject([
        { path: '/v1/rework/hold', body: { action: 'accept', run_id: 'r1', node_run_id: 'old', artifact_id: 'B', sha256: b.metadata.sha256 } },
        { path: '/v1/rework/inspect', body: { run_id: 'r1', target_node_run_id: 'old', source_artifact_id: 'B', source_artifact_hash: b.metadata.sha256, expected_revision: 7, criteria: '核对 B 的内容' } },
        { path: '/v1/rework/request', body: { run_id: 'r1', target_node_run_id: 'old', source_artifact_id: 'B', source_artifact_hash: b.metadata.sha256, expected_revision: 7 } },
      ])
      expect(observed).toMatchObject({ title: 'report.txt的内容', text: undefined })
      expect(observed.label).toContain('B')
      expect(observed.label).toContain(b.metadata.sha256.slice(0, 12))
      await view.click(button(form, '预览内容'))
      expect(form.querySelector('pre')?.textContent).toBe('内容 B')
      await view.click(button(form, '下载产物'))
      expect(save.mock.instances[0]).toMatchObject({ download: 'report.txt', href: 'blob:report' })
      expect(createObjectURL.mock.calls[0]?.[0]).toMatchObject({ size: b.metadata.size_bytes })
      expect(fixture.reads).toEqual([
        { run_id: 'r1', artifact_id: 'A', mode: 'preview' },
        { run_id: 'r1', artifact_id: 'B', mode: 'preview' },
        { run_id: 'r1', artifact_id: 'B', mode: 'download' },
      ])
    } finally {
      const timerIndex = cleanup.mock.calls.findIndex(([, ms]) => ms === 1000)
      if (timerIndex >= 0) window.clearTimeout(cleanup.mock.results[timerIndex]?.value)
      cleanup.mockRestore()
      vi.unstubAllGlobals()
      save.mockRestore()
      view.unmount()
    }
  })

  it.each(['preview', 'error'] as const)('keeps B visible when the pending A %s arrives last', async (outcome) => {
    const a = version('A', 'old', '内容 A')
    const b = version('B', 'old', '内容 B')
    const fixture = versionsFixture({ a, b, form: true })
    const pendingA = deferred<ArtifactContentView>()
    fixture.read.mockReturnValueOnce(pendingA.promise)
    const view = await renderPanel(fixture.panel)
    try {
      const form = openDetails(view, '审核成果或提出修改')
      await selectFormArtifact(form, 'A')
      await view.click(button(form, '预览内容'))
      await selectFormArtifact(form, 'B')
      // Read B immediately, then let A finish after it.
      await view.click(button(form, '预览内容'))
      if (outcome === 'preview') pendingA.resolve(content(a))
      else pendingA.reject(new Error('仅 A 的错误'))
      await view.flush()
      expect(form.querySelector('[role="alert"]')).toBeNull()
      expect(form.querySelector('pre')?.textContent).toBe('内容 B')
      expect(fixture.reads).toEqual([
        { run_id: 'r1', artifact_id: 'A', mode: 'preview' },
        { run_id: 'r1', artifact_id: 'B', mode: 'preview' },
      ])
    } finally { view.unmount() }
  })

  it.each(['before', 'after'] as const)('removes a completed comparison when the %s side changes', async (side) => {
    const fixture = versionsFixture()
    const view = await renderPanel(fixture.panel)
    try {
      const details = openDetails(view, '修改前后成果与版本')
      await view.click(button(details, '逐行对比修改'))
      expect(details.querySelector('tbody')?.textContent).toContain('原始成果内容 A')
      const updated = side === 'before' ? versionsFixture({ before: updateSource }) : fixture
      if (side === 'before') {
        await view.rerender(updated.panel)
        await view.flush()
      } else {
        const select = details.querySelector('select')!
        await fill(select, 'B')
      }
      expect(details.querySelector('table')).toBeNull()
      await view.click(button(details, '逐行对比修改'))
      expect(details.querySelector('tbody')?.textContent).toContain(side === 'before' ? '更新后的原始成果内容 A' : '原始成果内容 B')
      if (side === 'after') {
        const select = details.querySelector('select')!
        expect(select.options[0]?.textContent).not.toBe(select.options[1]?.textContent)
        await fill(view.findAll('textarea')[0]!, '审核本轮 B')
        await view.click(button(view.container, '通过验收'))
        expect(fixture.posts[0]).toMatchObject({ path: '/v1/rework/review', body: {
          request_id: 'rw1', expected_revision: 3, action: 'accept', artifact_id: 'B', artifact_hash: revisionB.metadata.sha256,
        } })
      }
    } finally { view.unmount() }
  })

  it.each(['before', 'after'] as const)('ignores stale comparison results and failures when the %s side changes and changes back', async (side) => {
    const fixture = versionsFixture()
    const updated = versionsFixture({ before: updateSource })
    const first = deferred<ArtifactContentView>()
    const second = deferred<ArtifactContentView>()
    const current = deferred<ArtifactContentView>()
    // The baseline can prevent the second request from starting at all.
    void second.promise.catch(() => {})
    fixture.read.mockReturnValueOnce(first.promise)
    const view = await renderPanel(fixture.panel)
    try {
      const details = openDetails(view, '修改前后成果与版本')
      await view.click(button(details, '逐行对比修改'))
      if (side === 'before') {
        updated.read.mockReturnValueOnce(second.promise)
        await view.rerender(updated.panel)
        await view.flush()
      } else {
        fixture.read.mockReturnValueOnce(second.promise)
        await fill(details.querySelector('select')!, 'B')
      }
      // The abandoned comparison must not disable comparison of the current pair.
      await view.click(button(details, '逐行对比修改'))
      if (side === 'before') {
        await view.rerender(fixture.panel)
        await view.flush()
      } else {
        await fill(details.querySelector('select')!, 'A')
      }
      fixture.read.mockReturnValueOnce(current.promise)
      await view.click(button(details, '逐行对比修改'))
      first.resolve({ ...content(source), kind: 'preview', text: '第一次的旧对比', truncated: false })
      second.reject(new Error('被替换对比的错误'))
      await view.flush()
      expect(details.querySelector('table')).toBeNull()
      expect(view.text()).not.toContain('被替换对比的错误')
      expect(button(details, '逐行对比修改').disabled).toBe(true)
      current.resolve(content(source))
      await view.flush()
      expect(details.querySelector('tbody')?.textContent).toContain('原始成果内容 A')
      expect(button(details, '逐行对比修改').disabled).toBe(false)
      expect(fixture.reads).toHaveLength(side === 'before' ? 4 : 6)
      expect(updated.reads).toHaveLength(side === 'before' ? 2 : 0)
    } finally { view.unmount() }
  })

  it('checks the content filename on both sides of the comparison', async () => {
    const fixture = versionsFixture()
    fixture.read.mockResolvedValueOnce({ ...content(source), file_name: 'unexpected.txt' })
    const view = await renderPanel(fixture.panel)
    try {
      const details = openDetails(view, '修改前后成果与版本')
      await view.click(button(details, '逐行对比修改'))
      expect(details.querySelector('table')).toBeNull()
      expect(view.text()).toContain('成果版本已变化')
    } finally { view.unmount() }
  })

  it('preserves the single revised version bound by the service attempt', async () => {
    const fixture = versionsFixture({ locked: true })
    const view = await renderPanel(fixture.panel)
    try {
      const details = openDetails(view, '修改前后成果与版本')
      expect(details.querySelector('select')).toBeNull()
      expect(details.textContent).toContain(revisionA.metadata.sha256)
      expect(details.textContent).not.toContain(revisionB.metadata.sha256)
      await view.click(button(details, '逐行对比修改'))
      expect(fixture.reads).toEqual([
        { run_id: 'r1', artifact_id: 'source', mode: 'preview' },
        { run_id: 'r1', artifact_id: 'A', mode: 'preview' },
      ])
    } finally { view.unmount() }
  })

  it('separates quality acceptance and pins the revised artifact and CAS revision', async () => {
    const { client, posts } = clientFor()
    const view = await renderPanel(<ReworkPanel api={createResourcesApi(client)} commands={createReworkApi(client)} />)
    await view.flush()
    expect(view.text()).toContain('第 1 / 3 轮')
    expect(view.text()).toContain('允许补齐数据')
    expect(view.text()).toContain('核验工具授权已变化')
    expect(view.text()).toContain('v1')
    expect(view.text()).toContain('v2')
    expect(view.text()).not.toContain('拒绝执行')
    await fill(view.findAll('textarea')[0]!, '修订数据符合要求')
    await view.click(view.findAll('button').find(b => b.textContent === '通过验收')!)
    expect(posts[0]?.path).toBe('/v1/rework/review')
    expect(posts[0]?.body).toMatchObject({ request_id: 'rw1', expected_revision: 3, action: 'accept', artifact_id: 'v2', artifact_hash: newHash, note: '修订数据符合要求' })
    expect(posts[0]?.body).not.toHaveProperty('actor')
    view.unmount()
  })
  it('does not offer authorization of an unreviewed topology proposal', async () => {
    const { client } = clientFor({ ...request, status: 'needs_human_approval', suggested_scope: 'replan_subgraph' })
    const view = await renderPanel(<ReworkPanel api={createResourcesApi(client)} commands={createReworkApi(client)} plannerEnabled />)
    await view.flush()
    const authorize = view.findAll('button').find(b => b.textContent === '授权返工') as HTMLButtonElement
    expect(authorize.disabled).toBe(true)
    expect(view.text()).toContain('请主脑提出局部方案')
    view.unmount()
  })
  it('shows proposed inserted steps and their source role before explicit authorization', async () => {
    const { client, posts } = clientFor({ ...request, status: 'needs_human_approval', suggested_scope: 'replan_subgraph' })
    const originalGet = client.get
    client.get = async <T,>(path: string, query?: Record<string, string | number | undefined>) => path === '/v1/rework/plan'
      ? { data: { plan: { revision: 3, plan_hash: 'c'.repeat(64), proposal: { reason: '补齐检查', changes: [], preserved_node_ids: ['unrelated'], insert_steps: [{ node_id: 'rw_check', before_node_id: 'c', instruction: '先补充数据检查再写报告' }] } } } as T, as_of_seq: 9 }
      : originalGet<T>(path, query)
    const view = await renderPanel(<ReworkPanel api={createResourcesApi(client)} commands={createReworkApi(client)} plannerEnabled />)
    await view.flush()
    expect(view.text()).toContain('新增步骤（授权后执行）')
    expect(view.text()).toContain('rw_check · 插入 c 之前 · 来源角色：c')
    expect(view.text()).toContain('先补充数据检查再写报告')
    expect(posts).toHaveLength(0)
    view.unmount()
  })
  it('loads run-scoped form and records a human hold without accepting an artifact', async () => {
    const { client, posts } = clientFor()
    const view = await renderPanel(<ReworkPanel api={createResourcesApi(client)} commands={createReworkApi(client)} runId="r1" />)
    await view.flush()
    const select = view.findAll('select')[0]!
    await fill(select, 'old')
    await view.click(view.findAll('button').find(b => b.textContent === '等待人工验收后结束')!)
    expect(posts[0]?.body).toMatchObject({ run_id: 'r1', node_run_id: 'old', action: 'hold' })
    expect(posts[0]?.body).not.toHaveProperty('artifact_id')
    view.unmount()
  })
  it('shows actual changed lines and preserves unchanged content in comparison', async () => {
    const view = await renderPanel(<LineComparison before={'已通过\n缺时间'} after={'已通过\n2026-11-19'} />)
    expect(view.findAll('tbody tr')).toHaveLength(2)
    expect(view.findAll('tbody tr')[0]?.textContent).toBe('1已通过已通过')
    expect(view.findAll('tbody tr')[1]?.textContent).toContain('缺时间2026-11-19')
    view.unmount()
  })
  it('submits human feedback with exact source version and preserve requirements', async () => {
    const { client, posts } = clientFor()
    const view = await renderPanel(<ReworkPanel api={createResourcesApi(client)} commands={createReworkApi(client)} runId="r1" />)
    await view.flush()
    await fill(view.findAll('select')[0]!, 'old')
    await fill(view.findAll('select')[1]!, 'v1')
    const fields = view.findAll('textarea')
    await fill(fields[1]!, '第三章缺少数据')
    await fill(fields[2]!, '补充真实测试数据')
    await fill(fields[3]!, '保留其余章节')
    await view.click(view.findAll('button').filter(b => b.textContent === '要求修改').at(-1)!)
    expect(posts[0]?.body).toMatchObject({ run_id: 'r1', target_node_run_id: 'old', expected_revision: 7, source_artifact_id: 'v1', source_artifact_hash: oldHash, reason: '第三章缺少数据', expected_result: '补充真实测试数据', preserve_requirements: ['保留其余章节'], suggested_scope: 'targeted_revision' })
    view.unmount()
  })
  it('requests a master inspection of the exact artifact without accepting or releasing its hold', async () => {
    const { client, posts } = clientFor()
    const originalPost = client.post
    client.post = async <T,>(path: string, payload: unknown) => {
      await originalPost(path, payload)
      return { data: { verdict: 'pass', summary: '符合检查标准' } as T, as_of_seq: 10 }
    }
    const view = await renderPanel(<ReworkPanel api={createResourcesApi(client)} commands={createReworkApi(client)} runId="r1" plannerEnabled />)
    await view.flush()
    await fill(view.findAll('select')[0]!, 'old')
    await fill(view.findAll('select')[1]!, 'v1')
    await fill(view.findAll('section[aria-label="主脑成果检查"] textarea')[0]!, '确认每条性能数据含真实采集时间')
    await view.click(view.findAll('button').find(b => b.textContent === '请主脑检查成果')!)
    expect(posts).toHaveLength(1)
    expect(posts[0]?.path).toBe('/v1/rework/inspect')
    expect(posts[0]?.body).toMatchObject({ run_id: 'r1', target_node_run_id: 'old', expected_revision: 7, source_artifact_id: 'v1', source_artifact_hash: oldHash, criteria: '确认每条性能数据含真实采集时间' })
    expect(posts[0]?.body).not.toHaveProperty('action')
    expect(view.text()).toContain('主脑检查意见：符合检查标准')
    view.unmount()
  })
  it('recovers an applied receipt after one ambiguous POST without sending again', async () => {
    let operationId = ''
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { operationId = JSON.parse(String(init.body)).operation_id; throw new Error('lost response') }
      return { json: async () => ({ ok: true, schema_version: 1, as_of_seq: 1, data: { status: 'applied', receipt_json: JSON.stringify({ result: { request_id: 'recovered' } }) } }) } as Response
    })
    const result = await createReworkApi(createApiClient('http://test', fetcher)).review({ request_id: 'rw1', expected_revision: 3, action: 'accept', note: '符合要求', artifact_id: 'v2', artifact_hash: newHash })
    expect(result).toEqual({ request_id: 'recovered' })
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1)
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(operationId)
  })
  it('preserves the original operation ID when no applied receipt is available', async () => {
    const client: ApiClient = { post: async () => { throw new ApiError('OPERATION_TIMEOUT', 'timeout', true) }, get: async () => { throw new Error('offline') } }
    await expect(createReworkApi(client).review({ request_id: 'rw1', expected_revision: 3, action: 'accept', note: '符合要求' })).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN', details: { operation_id: expect.any(String) } })
  })
})
