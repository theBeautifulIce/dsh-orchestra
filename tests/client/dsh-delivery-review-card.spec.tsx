// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { DshDeliveryReviewCard, type DshDeliveryReview } from '../../src/client/dsh-delivery-review-card.tsx'
import { renderPanel } from './harness.ts'

it.each(['accept', 'request_changes'] as const)('allows a human to inspect and %s the exact result from chat', async (action) => {
  const sessionId = 'source-session'
  const workspaceId = 'workspace'
  const artifact = {
    run_id: 'run-fixture', artifact_id: 'report-version', sha256: 'a'.repeat(64),
    file_name: 'sample.md', created_at: '2026-11-21T01:00:00Z', retain_until: null, expired: false,
  }
  const scope: DshDeliveryReview = { sessionId, workspaceId, reviews: [{
    title: '报表复核', step: '计算净额', criteria: ['复核两位小数'], artifact, runId: 'run-fixture',
    nodeRunId: 'current-attempt', nodeRevision: 5, hold:{hold_id:'shown-hold',expected_revision:3}, otherArtifacts: false, preview: '计算数据',
  }] }
  const sources = {
    sessions: { list: { getSnapshot: () => ({ byId: { [sessionId]: { id: sessionId, retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId, sessionIds: [sessionId] }], archivedSessionIds: [] }), subscribe: () => () => {} } },
  }
  const fetcher = vi.fn(async (target: string, init: RequestInit) => {
    const url = new URL(target, 'dsh-app://app')
    expect(url.searchParams.get('sessionId')).toBe(sessionId)
    expect(url.searchParams.get('workspaceId')).toBe(workspaceId)
    const path = new URL(url.searchParams.get('path')!, 'http://fixture.test').pathname
    const data = path === '/v1/rework/holds' ? { items: [{ node_run_id: 'current-attempt', status: 'held' }] } : { status: 'proposed' }
    if (init.method === 'POST') {
      expect(path).toBe(action === 'accept' ? '/v1/rework/hold' : '/v1/rework/request')
      expect(new Headers(init.headers).get('x-orchestra-request')).toBe('1')
    }
    return Response.json({ ok: true, schema_version: 1, as_of_seq: 1, data })
  })
  vi.stubGlobal('fetch', fetcher)
  const view = await renderPanel(<DshDeliveryReviewCard scope={scope} sources={sources} />)
  const button = (text: string) => view.findAll('button').find(element => element.textContent === text)!
  try {
    expect(view.findAll('pre')[0]?.textContent).toBe('计算数据')
    expect(button('下载产物')).toBeDefined()
    expect(fetcher).not.toHaveBeenCalled()
    if (action === 'request_changes') {
      await view.click(button('要求修改'))
      expect((button('提交修改意见') as HTMLButtonElement).disabled).toBe(true)
      const [reason, expected] = view.findAll('textarea') as HTMLTextAreaElement[]
      for (const [input, value] of [[reason!, '请更正退款'], [expected!, '补充计算过程']] as const) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
      }
    }
    await view.click(button(action === 'accept' ? '通过验收' : '提交修改意见'))
    await view.flush()
    const post = fetcher.mock.calls.find(([, init]) => init.method === 'POST')!
    expect(JSON.parse(String(post[1].body))).toMatchObject(action === 'accept' ? {
      action, hold_id:'shown-hold',expected_revision:3,node_run_id: 'current-attempt', artifact_id: artifact.artifact_id, sha256: artifact.sha256,
    } : {
      target_node_run_id: 'current-attempt', expected_revision: 5, source_artifact_id: artifact.artifact_id,
      source_artifact_hash: artifact.sha256, reason: '请更正退款', expected_result: '补充计算过程',
    })
    expect(view.text()).toContain(action === 'accept' ? '通过此版本' : '已登记修改意见')
    expect(fetcher.mock.calls.every(([,init])=>init.method==='POST')).toBe(true)
  } finally {
    view.unmount()
    vi.unstubAllGlobals()
  }
})

it('requires taking a readable version before accepting a result that has no in-chat preview', async () => {
  const sessionId = 'source-session'
  const workspaceId = 'workspace'
  const artifact = {
    run_id: 'run-fixture', artifact_id: 'report-version', sha256: 'a'.repeat(64),
    file_name: 'big.md', created_at: '2026-11-21T01:00:00Z', retain_until: null, expired: false, size_bytes: 9000,
  }
  const scope: DshDeliveryReview = { sessionId, workspaceId, reviews: [{
    title: '报表复核', step: '计算净额', criteria: ['复核两位小数'], artifact, runId: 'run-fixture',
    nodeRunId: 'current-attempt', nodeRevision: 5, hold:{hold_id:'shown-hold',expected_revision:3}, otherArtifacts: false,
  }] }
  const sources = {
    sessions: { list: { getSnapshot: () => ({ byId: { [sessionId]: { id: sessionId, retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId, sessionIds: [sessionId] }], archivedSessionIds: [] }), subscribe: () => () => {} } },
  }
  vi.stubGlobal('fetch', vi.fn(async (target: string) => {
    const path = new URL(new URL(String(target), 'dsh-app://app').searchParams.get('path')!, 'http://fixture.test').pathname
    const data = path === '/v1/rework/holds' ? { items: [{ node_run_id: 'current-attempt', status: 'held', hold_id: 'h1', revision: 1 }] }
      : { kind: 'preview', file_name: artifact.file_name, sha256: artifact.sha256, text: '净额 109.50', truncated: false }
    return Response.json({ ok: true, schema_version: 1, as_of_seq: 1, data })
  }))
  const view = await renderPanel(<DshDeliveryReviewCard scope={scope} sources={sources} />)
  const button = (text: string) => view.findAll('button').find(element => element.textContent === text)!
  try {
    // 没有会话内全文：没读到这一版之前，勾选也不能通过（D08）。
    expect((button('通过验收') as HTMLButtonElement).disabled).toBe(true)
    const confirm = view.findAll('input').find(input => (input as HTMLInputElement).type === 'checkbox') as HTMLInputElement
    expect(confirm.disabled).toBe(true)
    await act(async () => { confirm.click() })
    expect((button('通过验收') as HTMLButtonElement).disabled).toBe(true)
    // 真正取得并核验这一版之后才能提交结论。
    await view.click(button('预览内容'))
    await view.flush()
    // Markdown 成果按阅读视图呈现，不再直接把原始标记塞进 pre（D11）。
    expect(view.text()).toContain('109.50')
    expect((button('通过验收') as HTMLButtonElement).disabled).toBe(false)
  } finally { view.unmount() }
})

it('offers withdraw, not acceptance, when a hold has no artifact yet', async () => {
  const sessionId = 'source-session'
  const workspaceId = 'workspace'
  const scope: DshDeliveryReview = { sessionId, workspaceId, reviews: [{
    title: '报表复核', step: '计算净额', criteria: ['复核两位小数'], artifact: null, runId: 'run-fixture',
    nodeRunId: 'current-attempt', nodeRevision: 5, hold:{hold_id:'shown-hold',expected_revision:3}, otherArtifacts: false,
  }] }
  const sources = {
    sessions: { list: { getSnapshot: () => ({ byId: { [sessionId]: { id: sessionId, retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId, sessionIds: [sessionId] }], archivedSessionIds: [] }), subscribe: () => () => {} } },
  }
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (target: string, init: RequestInit) => {
    const url = new URL(target, 'dsh-app://app')
    const path = new URL(url.searchParams.get('path')!, 'http://fixture.test').pathname
    if (init.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    return Response.json({ ok: true, schema_version: 1, as_of_seq: 1, data: { items: [] } })
  }))
  const view = await renderPanel(<DshDeliveryReviewCard scope={scope} sources={sources} />)
  const button = (text: string) => view.findAll('button').find(element => element.textContent === text)
  try {
    expect(view.text()).toContain('还没有登记任何成果文件')
    expect(button('通过验收')).toBeUndefined()
    await view.click(button('撤销留验')!)
    expect(posts[0]).toMatchObject({ path: '/v1/rework/hold', body: { run_id: 'run-fixture', action: 'withdraw',hold_id:'shown-hold',expected_revision:3 } })
  } finally { view.unmount() }
})
