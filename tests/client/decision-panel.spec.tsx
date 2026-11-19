// @vitest-environment jsdom
// 面板侧 S5-C 的行为测试：待你决定屏的排序与交互、待核实屏的十列、决定命令客户端的两条命令。
import { describe, expect, it } from 'vitest'
import { createApiClient, type FetchLike } from '../../src/client/api/client.ts'
import { createDecisionCommandsApi, DECISION_COMMAND_KINDS } from '../../src/client/api/decision-commands.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { DecisionInbox, sortDecisions } from '../../src/client/panel/decision-inbox.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { UnverifiedEffects, VERIFY_BANNER } from '../../src/client/panel/unverified-effects.tsx'
import { createFakeService, decisionView, effectView, page, renderPanel, type FakeQuery, type FakeReply } from './harness.ts'

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
  return { posts, api: createResourcesApi(client), commands: createDecisionCommandsApi(client) }
}

describe('待你决定屏的排序', () => {
  it('Q-10 结果不一致只由人工处理，即使旧记录有截止时间也不显示自动收口时间', async () => {
    const { api } = panelService(() => ({ ok: true, data: page([decisionView({ kind: 'report_contradicted',
      expires_at: '2026-11-21T00:00:00.000Z', expiry_effect: 'auto_resolve', allowed_resolutions: [] })]) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    expect(view.text()).toContain('仅由人工处理，系统不会自动收口')
    expect(view.text()).not.toContain('按已记录的规则自动处理')
    view.unmount()
  })
  it('按服务端给的 priority 降序排决定，同 priority 先显示等待较久的', async () => {
    const items = [
      decisionView({ decision_id: 'd-low', kind: 'audit_result', priority: 'low', created_at: '2026-11-17T12:00:00.000Z' }),
      decisionView({ decision_id: 'd-old', kind: 'verify_human', priority: 'high', created_at: '2026-11-17T09:00:00.000Z' }),
      decisionView({ decision_id: 'd-new', kind: 'pre_execution', priority: 'high', created_at: '2026-11-17T11:00:00.000Z' }),
    ]
    expect(sortDecisions(items).map((item) => item.decision_id)).toEqual(['d-old', 'd-new', 'd-low'])

    const { api } = panelService(() => ({ ok: true, data: page(items) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    expect(view.findAll('article h2').map((node) => node.textContent)).toEqual(['人工核验', '执行前确认', '结果复核'])
  })

  it('服务端没给 priority 时先显示等待较久的，界面上不显示编造的优先级', async () => {
    const items = [
      decisionView({ decision_id: 'd-old', kind: 'verify_human', priority: null, created_at: '2026-11-17T09:00:00.000Z' }),
      decisionView({ decision_id: 'd-new', kind: 'pre_execution', priority: null, created_at: '2026-11-17T11:00:00.000Z' }),
    ]
    expect(sortDecisions(items).map((item) => item.decision_id)).toEqual(['d-old', 'd-new'])

    const { api } = panelService(() => ({ ok: true, data: page(items) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    expect(view.text()).not.toContain('优先级')
    expect(view.findAll('article h2').map((node) => node.textContent)).toEqual(['人工核验', '执行前确认'])
  })
})

describe('待你决定屏的四问', () => {
  it('每张卡给出四问，字段缺失时写明服务端未提供', async () => {
    const { api } = panelService(() => ({ ok: true, data: page([decisionView({
      priority_reason: null,
      allowed_resolutions: null,
      required_evidence: null,
      expires_at: null,
    })]) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    const text = view.text()
    expect(text).toContain('为什么卡')
    expect(text).toContain('你能选什么')
    expect(text).toContain('需要什么证据')
    expect(text).toContain('过期会怎样')
    expect(text).toContain('服务端未提供')
  })
})

describe('待你决定屏的交互', () => {
  it('批量只接手：批量只发接手请求，界面上没有忽略入口', async () => {
    const { api, commands, posts } = panelService((query) => {
      if (query.path === '/v1/decisions') {
        return { ok: true, data: page([
          decisionView({ decision_id: 'd1' }),
          decisionView({ decision_id: 'd2', kind: 'verify_human' }),
        ]) }
      }
      if (query.path === '/v1/decisions/acknowledge') {
        return { ok: true, data: { decisionId: 'd1', revision: 2, status: 'acknowledged' } }
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: '没有这条接口', retryable: false } }
    })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    await view.flush()
    const boxes = view.findAll('input[aria-label="选择这条决定"]')
    expect(boxes.length).toBe(2)
    await view.click(boxes[0]!)
    await view.click(boxes[1]!)
    const batch = view.findAll('button').find((button) => button.textContent === '批量接手')
    expect(batch).toBeDefined()
    await view.click(batch!)
    await view.flush()
    expect(posts.filter((post) => post.path === '/v1/decisions/acknowledge').length).toBe(2)
    expect(posts.filter((post) => post.path === '/v1/decisions/resolve').length).toBe(0)
    expect(view.text()).not.toContain('忽略')
  })

  it('处理一次一条：点哪张卡就收哪张', async () => {
    const { api, commands, posts } = panelService((query) => {
      if (query.path === '/v1/decisions') {
        return { ok: true, data: page([
          decisionView({ decision_id: 'd1', created_at: '2026-11-17T12:00:00.000Z' }),
          decisionView({ decision_id: 'd2', kind: 'verify_human', created_at: '2026-11-17T09:00:00.000Z' }),
        ]) }
      }
      if (query.path === '/v1/decisions/resolve') return { ok: true, data: { decisionId: 'd1', revision: 2 } }
      return { ok: false, error: { code: 'NOT_FOUND', message: '没有这条接口', retryable: false } }
    })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    await view.flush()
    const resolveButton = view.findAll('button[aria-label="按 continue 处理"]').find((button) => button.closest('article')?.textContent?.includes('执行前确认'))
    expect(resolveButton).toBeDefined()
    await view.click(resolveButton!)
    await view.flush()
    const resolves = posts.filter((post) => post.path === '/v1/decisions/resolve')
    expect(resolves.length).toBe(1)
    expect(resolves[0]!.body).toMatchObject({
      decisionId: 'd1',
      revision: 1,
      resolution: 'continue',
    })
    expect(resolves[0]!.body).not.toHaveProperty('actor')
  })

  it('Q-15 / Q-20 高风险点选先取得挑战，连接过期禁发确认，恢复后只用原请求编号确认', async () => {
    let readFails = false
    const { api, commands, posts } = panelService(({ path }) => {
      if (path === '/v1/decisions') {
        if (readFails) throw new Error('lost connection')
        return { ok: true, data: page([decisionView({ decision_id: 'high', kind: 'pre_execution',
          allowed_resolutions: ['approved'], content_hash: 'original-content', confirm_required: true })]) }
      }
      if (posts.length === 1) return { ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: '请确认',
        retryable: false, details: { confirm_challenge: 'challenge-token' } } }
      return { ok: true, data: { decisionId: 'high', revision: 2 } }
    })
    const render = (connected: boolean, snapshotStale: boolean) => <PanelShell activeRoute="decisions" onNavigate={() => {}}
      serviceConnected={connected} snapshotStale={snapshotStale}><DecisionInbox api={api} commands={commands} /></PanelShell>
    const view = await renderPanel(render(true, false))
    const find = (label: string) => view.findAll('button').find((button) => button.textContent === label) as HTMLButtonElement
    await view.click(find('批准执行'))
    expect(posts).toHaveLength(1)
    const preflight = posts[0]!.body
    expect(preflight).toMatchObject({ decisionId: 'high', revision: 1, resolution: 'approved', contentHash: 'original-content' })
    expect(preflight).not.toHaveProperty('confirm_challenge')
    expect(view.text()).toContain('确认批准执行？')

    readFails = true
    await view.rerender(render(false, true))
    await view.click(find('刷新'))
    expect(view.text()).toContain('执行前确认')
    expect(find('批准执行').disabled).toBe(true)
    expect(find('确认处理').disabled).toBe(true)
    await view.click(find('确认处理'))
    expect(posts).toHaveLength(1)

    readFails = false
    await view.rerender(render(true, false))
    await view.click(find('刷新'))
    expect(find('确认处理').disabled).toBe(false)
    await view.click(find('确认处理'))
    expect(posts).toHaveLength(2)
    expect(posts[1]!.body).toEqual({ ...preflight, confirm_challenge: 'challenge-token' })
    view.unmount()
  })

  it('服务端没给可选项时处理按钮禁用，并说明缺哪些字段', async () => {
    const { api } = panelService(() => ({ ok: true, data: page([decisionView({
      allowed_resolutions: null,
      projection_missing: ['allowed_resolutions', 'priority'],
    })]) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    expect(view.text()).toContain('服务端未持久化的字段')
    expect(view.text()).toContain('allowed_resolutions')
    const processButton = view.findAll('button').find((button) => button.textContent === '处理')
    expect(processButton).toBeDefined()
    expect((processButton as HTMLButtonElement).disabled).toBe(true)
    expect(view.findAll('button[aria-label^="按 "]').length).toBe(0)
  })
})

describe('决定命令的错误提示', () => {
  it('冲突、忙、过期、无权限等失败各自给出可辨识的中文提示', async () => {
    const cases: { code: string; text: string }[] = [
      { code: 'DECISION_REVISION_CONFLICT', text: '状态已变，请刷新后重试' },
      { code: 'COMMAND_BUSY', text: '命令正在处理中，请稍后再试' },
      { code: 'OPERATION_ID_CONFLICT', text: '命令编号冲突，请稍后重试' },
      { code: 'OPERATION_EXPIRED', text: '命令已过期，请重新发起' },
      { code: 'FORBIDDEN', text: '没有权限处理这条决定' },
      { code: 'RESOLUTION_NOT_AVAILABLE', text: '同一 kind 已有活跃 decision' },
      { code: 'NOT_FOUND', text: '找不到这条决定，可能已被处理' },
    ]
    for (const item of cases) {
      const { api, commands } = panelService((query) => {
        if (query.path === '/v1/decisions') return { ok: true, data: page([decisionView()]) }
        return { ok: false, error: { code: item.code, message: '服务端拒绝了', retryable: false } }
      })
      const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
      await view.flush()
      const button = view.findAll('button').find((candidate) => candidate.textContent === '接手')
      expect(button).toBeDefined()
      await view.click(button!)
      await view.flush()
      expect(view.text()).toContain(item.text)
      view.unmount()
    }
  })

  it('结果不明时只查回执，不重发', async () => {
    const { api, commands, posts } = panelService((query) => {
      if (query.path === '/v1/decisions') return { ok: true, data: page([decisionView()]) }
      if (query.path === '/v1/decisions/acknowledge') {
        return { ok: false, error: { code: 'OPERATION_OUTCOME_UNKNOWN', message: '结果不明', retryable: true } }
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: '没有回执', retryable: false } }
    })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    await view.flush()
    const button = view.findAll('button').find((candidate) => candidate.textContent === '接手')
    await view.click(button!)
    await view.flush()
    expect(posts.filter((post) => post.path === '/v1/decisions/acknowledge').length).toBe(1)
    expect(view.text()).toContain('结果未知，正在查回执')
  })
})

describe('待核实屏的十列', () => {
  it('每行按规格列齐十列，没有来源的三列显示未知', async () => {
    const { api } = panelService((query) => {
      if (query.path === '/v1/effects/unverified') return { ok: true, data: page([effectView()]) }
      return { ok: true, data: page([]) }
    })
    const view = await renderPanel(<UnverifiedEffects api={api} />)
    await view.flush()
    expect(view.findAll('th')).toHaveLength(0)
    await view.click(view.findAll('input[aria-label="开发者视图"]')[0]!)
    await view.flush()
    const headers = view.findAll('th').map((cell) => cell.textContent ?? '')
    expect(headers.length).toBe(10)
    expect(headers.join(' ')).toContain('stopped_at')
    expect(headers.join(' ')).toContain('最后已知阶段')
    const cells = view.findAll('tbody td').map((cell) => cell.textContent ?? '')
    expect(cells.length).toBe(10)
    expect(cells[2]).toContain('未知')
    expect(cells[4]).toContain('未知')
    expect(cells[5]).toContain('未知')
    expect(cells[7]).toContain('未知')
    // started_at 不许出现在 stopped_at 列。
    expect(cells[4]).not.toContain('2026')
  })
})

describe('开发者视图', () => {
  it('待核实屏默认不显示 node_run_id，开发者视图才显示', async () => {
    const { api } = panelService((query) => {
      if (query.path === '/v1/effects/unverified') return { ok: true, data: page([effectView()]) }
      return { ok: true, data: page([]) }
    })
    const view = await renderPanel(<UnverifiedEffects api={api} />)
    await view.flush()
    expect(view.text()).not.toContain('nr1')
    const toggle = view.findAll('input[aria-label="开发者视图"]')[0]
    expect(toggle).toBeDefined()
    await view.click(toggle!)
    await view.flush()
    expect(view.text()).toContain('nr1')
  })

  it('决定屏默认不显示 node_run_id，开发者视图才显示', async () => {
    const { api } = panelService(() => ({ ok: true, data: page([decisionView()]) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    expect(view.text()).not.toContain('nr1')
    const toggle = view.findAll('input[aria-label="开发者视图"]')[0]
    expect(toggle).toBeDefined()
    await view.click(toggle!)
    await view.flush()
    expect(view.text()).toContain('nr1')
  })
})

describe('决定命令客户端', () => {
  it('只暴露接手与处理两条命令', () => {
    const { commands } = panelService(() => ({ ok: true, data: page([]) }))
    expect(Object.keys(commands).sort()).toEqual(['acknowledgeDecision', 'resolveDecision'])
    expect(DECISION_COMMAND_KINDS).toEqual(['decision.acknowledge', 'decision.resolve'])
  })

  it('接手请求体不带副作用核实字段，核实横幅逐字不变', async () => {
    const { api, commands, posts } = panelService((query) => {
      if (query.path === '/v1/decisions') return { ok: true, data: page([decisionView()]) }
      if (query.path === '/v1/decisions/acknowledge') {
        return { ok: true, data: { decisionId: 'd1', revision: 2, status: 'acknowledged' } }
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: '没有这条接口', retryable: false } }
    })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    await view.flush()
    const button = view.findAll('button').find((candidate) => candidate.textContent === '接手')
    expect(button).toBeDefined()
    await view.click(button!)
    await view.flush()
    const posted = posts.find((post) => post.path === '/v1/decisions/acknowledge')
    expect(posted).toBeDefined()
    expect(Object.keys(posted!.body)).not.toContain('side_effect_verified_none')
    expect(posted!.body).toMatchObject({ decisionId: 'd1', revision: 1 })
    expect(VERIFY_BANNER).toBe('人工签认记录责任接管。外部操作是否发生仍以核验证据为准。')
  })
})
