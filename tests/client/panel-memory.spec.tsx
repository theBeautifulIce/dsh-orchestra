// @vitest-environment jsdom
// 面板侧 S5-I 的行为测试：记忆屏四问、十二句状态文案、记忆审批卡、开发者视图与只读边界。
import { describe, expect, it } from 'vitest'
import { createApiClient, type FetchLike } from '../../src/client/api/client.ts'
import { createDecisionCommandsApi } from '../../src/client/api/decision-commands.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import type { MemoryBatchView, MemoryItemView } from '../../src/client/api/types.ts'
import { PanelApp } from '../../src/client/panel/app.tsx'
import { DecisionInbox } from '../../src/client/panel/decision-inbox.tsx'
import { MemoryPanel, memoryCopy } from '../../src/client/panel/memory-panel.tsx'
import { createFakeService, decisionView, page, renderPanel, type FakeQuery, type FakeReply } from './harness.ts'

type RecordedPost = { path: string; body: Record<string, unknown> }

/** 假服务外面再包一层：harness 只记路径，这里把请求体也记下来。 */
function panelService(handler: (query: FakeQuery) => FakeReply) {
  const posts: RecordedPost[] = []
  const service = createFakeService(handler)
  const fetcher: FetchLike = async (input, init) => {
    if (init?.method === 'POST') {
      posts.push({
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
      })
    }
    return service.fetcher(input)
  }
  const client = createApiClient('http://panel.test', fetcher)
  return { posts, calls: service.calls, client, api: createResourcesApi(client), commands: createDecisionCommandsApi(client) }
}

function memoryItem(over: Partial<MemoryItemView> = {}): MemoryItemView {
  return {
    client_key: 'item-1',
    layer: 'L4',
    title: '面板测试用 Vitest',
    digest: '这次面板的测试用 Vitest 跑。',
    content: '这次面板的测试用 Vitest 跑，不用别的跑法。',
    source: '来自这次运行的对话',
    status: 'applied',
    verdict: 'approve',
    judge_reason: '这次反复提到，值得记下。',
    ...over,
  }
}

function memoryBatch(over: Partial<MemoryBatchView> = {}): MemoryBatchView {
  return {
    batch_id: 'batch-77',
    task_id: 'task-77',
    status: 'applied',
    attempt: 1,
    outcome: null,
    total_count: 1,
    pending_count: 0,
    applied_count: 1,
    skipped_count: 0,
    items: [memoryItem()],
    evaluation_id: 'eval-77',
    proposal_hash: 'hash-77',
    decision_id: 'dec-77',
    decision_revision: 3,
    allowed_resolutions: null,
    error_message: null,
    created_at: '2026-11-17T10:00:00.000Z',
    updated_at: '2026-11-17T10:05:00.000Z',
    ...over,
  }
}

/** 只回记忆批次的假服务；决定接口给空列表，除非用例自己指定。 */
function memoryService(batches: MemoryBatchView[]) {
  return panelService((query) => {
    if (query.path === '/v1/memory/batches') return { ok: true, data: page(batches) }
    if (query.path === '/v1/decisions') return { ok: true, data: page([]) }
    if (query.path === '/v1/decisions/resolve') return { ok: true, data: { decisionId: 'dec', revision: 4 } }
    if (query.path === '/v1/memory/recovery/inspect') return { ok: true, data: {
      batch_id: 'batch-77', decision_id: 'dec-mid', revision: 4, evidence_id: 'proof-mid',
      stopped_at: '2026-11-17T10:05:00.000Z', written_count: 1, missing_count: 1, allowed_resolutions: ['abandon'],
    } }
    if (query.path === '/v1/memory/recovery/resolve') return { ok: true, data: { status: 'abandoned' } }
    return { ok: false, error: { code: 'NOT_FOUND', message: '没有这条接口', retryable: false } }
  })
}

/** 服务端 buildApprovalCard 落到决定 payload 里的审批卡。 */
function approvalCardPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'audit_result',
    title: '这几条要写进记忆，你看看',
    summary_line: '这次整理出 3 条 / 建议写入 2 条 / 不写 1 条',
    items: [
      { layer: 'L4', title: '面板测试用 Vitest', digest: '这次面板的测试用 Vitest 跑。', judge_reason: '这次反复提到，值得记下。' },
      { layer: 'L2', title: '当前这次任务', digest: '这次任务在改记忆面板。', judge_reason: '任务还在进行，下次再记。' },
    ],
    buttons: [
      { label: '按这个方案写入', resolution: 'approved' },
      { label: '这次不写', resolution: 'rejected' },
    ],
    allowed_resolutions: [],
    resolve_payload: {},
    expand_label: '为什么记这条',
    ...over,
  }
}

describe('记忆面板的十二句状态文案', () => {
  it('AC1 十二句状态文案与规格逐字相等', () => {
    expect(memoryCopy(memoryBatch({ status: 'draft' })).text).toBe('正在整理')
    expect(memoryCopy(memoryBatch({ status: 'evaluating' })).text).toBe('管家在看有没有重复')
    expect(memoryCopy(memoryBatch({ status: 'awaiting_human', pending_count: 3 })).text).toBe('有 3 条等你确认')
    expect(memoryCopy(memoryBatch({ status: 'approved' })).text).toBe('开始写入')
    expect(memoryCopy(memoryBatch({ status: 'applying' })).text).toBe('正在写入')
    expect(memoryCopy(memoryBatch({ status: 'applied', applied_count: 2 })).text).toBe('写了 2 条')
    expect(memoryCopy(memoryBatch({ status: 'empty' })).text).toBe('这次没有需要写的')
    expect(memoryCopy(memoryBatch({ status: 'blocked' })).text).toBe('有 1 条拿不准，这次没写')
    expect(memoryCopy(memoryBatch({ status: 'declined' })).text).toBe('你选择先不写')
    expect(memoryCopy(memoryBatch({ status: 'expired' })).text).toBe('超过 24 小时没确认，这次没写')
    expect(memoryCopy(memoryBatch({ status: 'failed' })).text).toBe('没写成：裁判没给出结果')
    expect(memoryCopy(memoryBatch({ status: 'indeterminate' })).text).toBe('写到一半，等你确认')
  })

  it('AC1 面板上显示的状态句与同一句映射一致', async () => {
    const { api } = memoryService([memoryBatch({ status: 'applied', applied_count: 2 })])
    const view = await renderPanel(<MemoryPanel api={api} />)
    await view.flush()
    expect(view.text()).toContain('最近批次 · 写了 2 条')
    view.unmount()
  })
})

describe('记忆屏的四问', () => {
  it('AC2 没有批次时四个问题都有回答，并提示这次可以记', async () => {
    const { api } = memoryService([])
    const view = await renderPanel(<MemoryPanel api={api} />)
    await view.flush()
    const text = view.text()
    expect(text).toContain('已写入条目')
    expect(text).toContain('审批与对账')
    expect(text).toContain('未写入条目')
    expect(text).toContain('整理状态')
    expect(text).toContain('没有待确认')
    expect(text).toContain('记录这次任务')
    view.unmount()
  })

  it('AC2 有待确认批次时显示有 N 条等你确认，并能跳到同一张审批卡', async () => {
    const { api } = memoryService([memoryBatch({ status: 'awaiting_human', pending_count: 3, applied_count: 0, items: [] })])
    let opened = 0
    const view = await renderPanel(<MemoryPanel api={api} onOpenDecisions={() => { opened += 1 }} />)
    await view.flush()
    const text = view.text()
    expect(text).toContain('有 3 条等你确认')
    expect(text).not.toContain('没有待确认')
    const link = view.findAll('button').find((button) => button.textContent === '查看审批')
    expect(link).toBeDefined()
    await view.click(link!)
    expect(opened).toBe(1)
    view.unmount()
  })

  it('AC2 批次失败时说明哪条没写成、为什么，并给出下一步', async () => {
    const { api } = memoryService([memoryBatch({
      status: 'failed',
      applied_count: 0,
      items: [memoryItem({ status: 'failed', title: '没写成的那条', judge_reason: '这次裁判没给出结果' })],
    })])
    const view = await renderPanel(<MemoryPanel api={api} />)
    await view.flush()
    const text = view.text()
    expect(text).toContain('没写成：裁判没给出结果')
    expect(text).toContain('可以让管家改一版，或者再试一次。')
    expect(text).toContain('没写成的那条')
    expect(text).toContain('这次裁判没给出结果')
    expect(text).toContain('让管家改一版')
    expect(text).toContain('再试一次')
    view.unmount()
  })

  it('AC2 批次被驳回时说明是你选择先不写，并给出下一步', async () => {
    const { api } = memoryService([memoryBatch({
      status: 'declined',
      applied_count: 0,
      items: [memoryItem({ status: 'skipped', title: '这次不写的那条', judge_reason: '这次不记了' })],
    })])
    const view = await renderPanel(<MemoryPanel api={api} />)
    await view.flush()
    const text = view.text()
    expect(text).toContain('你选择先不写')
    expect(text).toContain('想记的话，可以让管家改一版。')
    expect(text).toContain('这次不写的那条')
    expect(text).toContain('让管家改一版')
    expect(text).toContain('再试一次')
    view.unmount()
  })

  it('AC2 批次过期时说明超过 24 小时没确认，并给出下一步', async () => {
    const { api } = memoryService([memoryBatch({ status: 'expired', applied_count: 0, items: [] })])
    const view = await renderPanel(<MemoryPanel api={api} />)
    await view.flush()
    const text = view.text()
    expect(text).toContain('超过 24 小时没确认，这次没写')
    expect(text).toContain('可以让管家重新整理一批，这次重新确认。')
    view.unmount()
  })

  it('AC5 写到一半时只显示已写入的条目，唯一可选动作是放弃这次写入', async () => {
    const { client, posts } = memoryService([memoryBatch({
      status: 'indeterminate',
      applied_count: 1,
      allowed_resolutions: ['abandon'],
      recovery_available: true,
      decision_id: 'dec-mid',
      decision_revision: 4,
      items: [
        memoryItem({ client_key: 'written', status: 'applied', title: '已经写进去的一条' }),
        memoryItem({ client_key: 'pending', status: 'approved', title: '没写进去的那一条' }),
      ],
    })])
    const view = await renderPanel(<PanelApp client={client} serviceConnected initialRoute="memory" />)
    await view.flush()
    const text = view.text()
    expect(text).toContain('写到一半，等你确认')
    expect(text).toContain('已经写进去的一条')
    expect(text).not.toContain('没写进去的那一条')
    expect(view.findAll('button').some((button) => button.textContent === '放弃这次写入')).toBe(false)
    await view.click(view.findAll('button').find((button) => button.textContent === '核对记忆写入')!)
    await view.flush()
    expect(view.text()).toContain('已写入 1 条，未写入 1 条。')
    const labels = view.findAll('button').map((button) => button.textContent ?? '')
    expect(labels).toContain('放弃这次写入')
    expect(labels).not.toContain('按这个方案写入')
    expect(labels).not.toContain('这次不写')
    const abandon = view.findAll('button').find((button) => button.textContent === '放弃这次写入')
    expect(abandon).toBeDefined()
    await view.click(abandon!)
    await view.flush()
    const resolves = posts.filter((post) => post.path === '/v1/memory/recovery/resolve')
    expect(resolves.length).toBe(1)
    expect(resolves[0]!.body).toMatchObject({
      batch_id: 'batch-77', decision_id: 'dec-mid', revision: 4, resolution: 'abandon',
      evidence_id: 'proof-mid', stopped_at: '2026-11-17T10:05:00.000Z',
    })
    expect(posts.some((post) => post.path === '/v1/decisions/resolve')).toBe(false)
    view.unmount()
  })

  it('AC5 未装配恢复服务时不提供核对或放弃操作', async () => {
    const { client, posts } = memoryService([memoryBatch({
      status: 'indeterminate',
      applied_count: 1,
      allowed_resolutions: null,
      decision_id: 'dec-mid',
      decision_revision: 4,
      items: [memoryItem({ client_key: 'written', status: 'applied' })],
    })])
    const view = await renderPanel(<PanelApp client={client} serviceConnected initialRoute="memory" />)
    await view.flush()
    const abandon = view.findAll('button').find((button) => button.textContent === '放弃这次写入')
    expect(abandon).toBeUndefined()
    expect(view.findAll('button').some((button) => button.textContent === '核对记忆写入')).toBe(false)
    expect(posts).toHaveLength(0)
    view.unmount()
  })

  it('快照过期时不能从面板封锁旧写入尝试', async () => {
    const { client, posts } = memoryService([memoryBatch({ status: 'applying', recovery_available: true })])
    const view = await renderPanel(<PanelApp client={client} serviceConnected snapshotStale initialRoute="memory" />)
    await view.flush()
    expect(view.text()).toContain('写入结果待核对')
    const button = view.findAll('button').find((item) => item.textContent === '核对记忆写入') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await view.click(button)
    expect(posts).toHaveLength(0)
    view.unmount()
  })
})

describe('默认视图与开发者视图', () => {
  it('AC3 默认视图不出现内部编号与技术细节', async () => {
    const { api } = memoryService([memoryBatch({
      items: [memoryItem({
        content: '这条记忆的全文里有 SELECT 这样的字样。',
        source: 'C:\\Users\\tester\\plugins\\memory\\index.js',
      })],
    })])
    const view = await renderPanel(<MemoryPanel api={api} />)
    await view.flush()
    const text = view.text()
    expect(text).not.toContain('batch_id')
    expect(text).not.toContain('decision_id')
    expect(text).not.toContain('evaluation_id')
    expect(text).not.toContain('proposal_hash')
    expect(text).not.toContain('batch-77')
    expect(text).not.toContain('dec-77')
    expect(text).not.toContain('eval-77')
    expect(text).not.toContain('hash-77')
    expect(text).not.toContain('SELECT')
    expect(text).not.toContain('plugins')
    expect(text).not.toContain('token')
    view.unmount()
  })

  it('AC3 开发者视图默认折叠，展开后才出现 batch_id / evaluation_id / proposal_hash / decision_id', async () => {
    const { api } = memoryService([memoryBatch()])
    const view = await renderPanel(<MemoryPanel api={api} />)
    await view.flush()
    const toggle = view.findAll('input[aria-label="开发者视图"]')[0]
    expect(toggle).toBeDefined()
    expect((toggle as HTMLInputElement).checked).toBe(false)
    expect(view.text()).not.toContain('batch-77')
    await view.click(toggle!)
    await view.flush()
    const text = view.text()
    expect(text).toContain('batch_id: batch-77')
    expect(text).toContain('evaluation_id: eval-77')
    expect(text).toContain('proposal_hash: hash-77')
    expect(text).toContain('decision_id: dec-77')
    view.unmount()
  })

  it('AC3 已写入条目默认只给标题、层与一句话，展开才给全文与来源', async () => {
    const { api } = memoryService([memoryBatch()])
    const view = await renderPanel(<MemoryPanel api={api} />)
    await view.flush()
    expect(view.text()).toContain('面板测试用 Vitest')
    expect(view.text()).toContain('层：L4')
    expect(view.text()).not.toContain('这次面板的测试用 Vitest 跑，不用别的跑法。')
    expect(view.text()).not.toContain('来自这次运行的对话')
    const expand = view.findAll('button').find((button) => button.textContent === '展开看全文与来源')
    expect(expand).toBeDefined()
    await view.click(expand!)
    await view.flush()
    expect(view.text()).toContain('这次面板的测试用 Vitest 跑，不用别的跑法。')
    expect(view.text()).toContain('来自这次运行的对话')
    view.unmount()
  })
})

describe('记忆审批卡', () => {
  it('AC4 审批卡标题、首行与两个按钮文案一字不差，卡片里没有内部编号', async () => {
    const { api, commands } = panelService((query) => {
      if (query.path === '/v1/decisions') {
        return { ok: true, data: page([decisionView({
          decision_id: 'dec-mem',
          kind: 'audit_result',
          payload: approvalCardPayload(),
          allowed_resolutions: null,
          projection_missing: ['allowed_resolutions'],
        })]) }
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: '没有这条接口', retryable: false } }
    })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    await view.flush()
    const text = view.text()
    expect(text).toContain('这几条要写进记忆，你看看')
    expect(text).toContain('这次整理出 3 条 / 建议写入 2 条 / 不写 1 条')
    expect(text).toContain('层：L4 · 面板测试用 Vitest')
    expect(text).toContain('理由：这次反复提到，值得记下。')
    const labels = view.findAll('button').map((button) => button.textContent ?? '')
    expect(labels).toContain('按这个方案写入')
    expect(labels).toContain('这次不写')
    expect(labels).toContain('为什么记这条')
    expect(labels).not.toContain('接手')
    expect(text).not.toContain('batch_id')
    expect(text).not.toContain('node_run_id')
    expect(text).not.toContain('dec-mem')
    expect(text).not.toContain('nr1')
    view.unmount()
  })

  it('AC4 「为什么记这条」展开后才给每条理由', async () => {
    const { api } = panelService((query) => {
      if (query.path === '/v1/decisions') {
        return { ok: true, data: page([decisionView({
          decision_id: 'dec-mem',
          kind: 'audit_result',
          payload: approvalCardPayload(),
        })]) }
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: '没有这条接口', retryable: false } }
    })
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    const expand = view.findAll('button').find((button) => button.textContent === '为什么记这条')
    expect(expand).toBeDefined()
    expect(expand!.getAttribute('aria-expanded')).toBe('false')
    await view.click(expand!)
    await view.flush()
    expect(expand!.getAttribute('aria-expanded')).toBe('true')
    expect(view.text()).toContain('面板测试用 Vitest：这次反复提到，值得记下。')
    view.unmount()
  })

  it('AC4 服务端没投影出按钮时两个按钮禁用，并说明缺哪些字段', async () => {
    const { api, commands } = panelService((query) => {
      if (query.path === '/v1/decisions') {
        return { ok: true, data: page([decisionView({
          decision_id: 'dec-mem',
          kind: 'audit_result',
          payload: approvalCardPayload({ buttons: [] }),
          allowed_resolutions: null,
          projection_missing: ['allowed_resolutions'],
        })]) }
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: '没有这条接口', retryable: false } }
    })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    await view.flush()
    const approve = view.findAll('button').find((button) => button.textContent === '按这个方案写入')
    const decline = view.findAll('button').find((button) => button.textContent === '这次不写')
    expect(approve).toBeDefined()
    expect(decline).toBeDefined()
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    expect((decline as HTMLButtonElement).disabled).toBe(true)
    expect(view.text()).toContain('部分决策信息尚未持久化，当前无法提供安全的处理选项。')
    expect(view.text()).toContain('服务端未持久化的字段：allowed_resolutions')
    view.unmount()
  })

  it('AC4 点「按这个方案写入」走 decision.resolve，resolution 用服务端给的值', async () => {
    const { api, commands, posts } = panelService((query) => {
      if (query.path === '/v1/decisions') {
        return { ok: true, data: page([decisionView({
          decision_id: 'dec-mem',
          kind: 'audit_result',
          payload: approvalCardPayload(),
          allowed_resolutions: ['approved', 'rejected'],
        })]) }
      }
      if (query.path === '/v1/decisions/resolve') return { ok: true, data: { decisionId: 'dec-mem', revision: 2 } }
      return { ok: false, error: { code: 'NOT_FOUND', message: '没有这条接口', retryable: false } }
    })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    await view.flush()
    const approve = view.findAll('button').find((button) => button.textContent === '按这个方案写入')
    expect(approve).toBeDefined()
    await view.click(approve!)
    await view.flush()
    const resolves = posts.filter((post) => post.path === '/v1/decisions/resolve')
    expect(resolves.length).toBe(1)
    expect(resolves[0]!.body).toMatchObject({
      decisionId: 'dec-mem',
      revision: 1,
      resolution: 'approved',
    })
    expect(resolves[0]!.body).not.toHaveProperty('actor')
    view.unmount()
  })

  it('AC4 点「这次不写」走 decision.resolve，resolution 用服务端给的值', async () => {
    const { api, commands, posts } = panelService((query) => {
      if (query.path === '/v1/decisions') {
        return { ok: true, data: page([decisionView({
          decision_id: 'dec-mem',
          kind: 'audit_result',
          payload: approvalCardPayload(),
          allowed_resolutions: ['approved', 'rejected'],
        })]) }
      }
      if (query.path === '/v1/decisions/resolve') return { ok: true, data: { decisionId: 'dec-mem', revision: 2 } }
      return { ok: false, error: { code: 'NOT_FOUND', message: '没有这条接口', retryable: false } }
    })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    await view.flush()
    const decline = view.findAll('button').find((button) => button.textContent === '这次不写')
    expect(decline).toBeDefined()
    await view.click(decline!)
    await view.flush()
    const resolves = posts.filter((post) => post.path === '/v1/decisions/resolve')
    expect(resolves.length).toBe(1)
    expect(resolves[0]!.body).toMatchObject({ decisionId: 'dec-mem', revision: 1, resolution: 'rejected' })
    view.unmount()
  })
})

describe('记忆屏只读', () => {
  it('AC3 记忆屏只发一次只读 GET，不发任何写请求', async () => {
    const { api, calls, posts } = memoryService([memoryBatch()])
    const view = await renderPanel(<MemoryPanel api={api} />)
    await view.flush()
    expect(calls.map((call) => call.path)).toEqual(['/v1/memory/batches'])
    expect(posts.length).toBe(0)
    view.unmount()
  })
})

describe('记忆路由', () => {
  it('AC6 记忆路由渲染记忆屏，不再是占位文案', async () => {
    const service = createFakeService((query) => {
      if (query.path === '/v1/memory/batches') return { ok: true, data: page([memoryBatch()]) }
      return { ok: true, data: page([]) }
    })
    const client = createApiClient('http://panel.test', service.fetcher)
    const view = await renderPanel(<PanelApp client={client} serviceConnected initialRoute="memory" />)
    await view.flush()
    const text = view.text()
    expect(text).not.toContain('此页面尚未接入真实数据。')
    expect(text).toContain('已写入条目')
    expect(text).toContain('最近批次 · 写了 1 条')
    view.unmount()
  })
})
