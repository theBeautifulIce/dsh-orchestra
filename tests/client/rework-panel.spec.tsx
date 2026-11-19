// @vitest-environment jsdom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, createApiClient, type ApiClient } from '../../src/client/api/client.ts'
import { createReworkApi, type ReworkItem } from '../../src/client/api/rework.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { ReworkPanel, LineComparison } from '../../src/client/panel/rework-panel.tsx'
import { renderPanel, nodeRunView } from './harness.ts'

const oldHash = 'a'.repeat(64), newHash = 'b'.repeat(64)
const request = { request_id: 'rw1', run_id: 'r1', requester_actor: 'human', target_node_run_id: 'old', target_attempt: 1, source_artifact_id: 'v1', source_artifact_hash: oldHash, reason: '缺少时间字段', expected_result: '补充真实采集时间', suggested_scope: 'targeted_revision', status: 'awaiting_review', revision: 3, round_no: 1, max_rounds: 3, new_node_run_id: 'new', updated_at: '2026-11-19' } as ReworkItem
const artifacts = [{ artifact_id: 'v1', run_id: 'r1', sha256: oldHash, expired: false, retain_until: null, source_node_run_id: 'old', created_at: '2026-11-19' }, { artifact_id: 'v2', run_id: 'r1', sha256: newHash, expired: false, retain_until: null, source_node_run_id: 'new', created_at: '2026-11-19' }]
function clientFor(item: ReworkItem = request) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const client: ApiClient = {
    async get<T>(path: string) {
      const data = path === '/v1/rework' ? { items: [item] } : path === '/v1/rework/get' ? { item: { request: item, attempts: [], reviews: [{ review_id: 'review1', round_no: 1, reviewer_actor: 'human', action: 'authorize', note: '允许补齐数据', created_at: '2026-11-19' }] } }
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

describe('成果审核与返工', () => {
  it('separates quality acceptance and pins the revised artifact and CAS revision', async () => {
    const { client, posts } = clientFor()
    const view = await renderPanel(<ReworkPanel api={createResourcesApi(client)} commands={createReworkApi(client)} />)
    await view.flush()
    expect(view.text()).toContain('第 1 / 3 轮')
    expect(view.text()).toContain('允许补齐数据')
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
