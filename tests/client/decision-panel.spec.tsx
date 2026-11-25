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
  it.each([['uphold_report', '采纳回报'], ['uphold_decision', '保留原处理决定']])(
    'WF-52 / F8 冲突卡使用当前修订提交 %s', async (resolution, label) => {
    const item = decisionView({ decision_id: 'd-report', kind: 'report_contradicted', status: 'blocked_for_human',
      current_revision: 3, approver: 'human', allowed_resolutions: [resolution],
      payload: { report_id: 'r-original', report_status: 'done', report_attempt: 2 } })
    const { api, commands, posts } = panelService(({ path }) => path === '/v1/decisions/resolve'
      ? { ok: true, data: { decisionId: item.decision_id, revision: 4 } }
      : { ok: true, data: page([item]) })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    expect(view.text()).toContain('r-original')
    expect(view.text()).toContain('第 2 次')
    await view.click(view.findAll('button').find(button => button.textContent === label)!)
    expect(posts).toEqual([{ path: '/v1/decisions/resolve', body: {
      decisionId: 'd-report', revision: 3, resolution, contentHash: item.content_hash,
      operation_id: expect.any(String),
    } }])
    view.unmount()
  })

  it('Q-10 结果不一致只由人工处理，即使旧记录有截止时间也不显示自动收口时间', async () => {
    const { api } = panelService(() => ({ ok: true, data: page([decisionView({ kind: 'report_contradicted',
      expires_at: '2026-11-21T00:00:00.000Z', expiry_effect: 'auto_resolve', allowed_resolutions: [] })]) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    expect(view.text()).toContain('仅由人工处理，系统不会自动结束本项')
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

describe('待你决定屏的处理说明', () => {
  it('字段缺失时给出核对指引，不编造证据、期限或处理选项', async () => {
    const { api } = panelService(() => ({ ok: true, data: page([decisionView({
      priority_reason: null,
      allowed_resolutions: null,
      required_evidence: null,
      expires_at: null,
    })]) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    const text = view.text()
    expect(text).toContain('处理原因')
    expect(text).toContain('如何核对')
    expect(text).toContain('处理期限')
    expect(text).toContain('本项未设置自动处理期限')
    expect(text).toContain('当前没有可从这里执行的处理选项')
    expect(text).not.toContain('服务端未提供')
    expect(view.findAll('.ops-decision-option button')).toHaveLength(0)
    view.unmount()
  })

  it('已开始但超时的旧恢复卡说明真实原因、所属任务与按钮后果，仍要求人工明确确认', async () => {
    const item = decisionView({ kind: 'startup_unknown', task_title: '整理数据清单', step_title: '读取本地记录', attempt: 2,
      target_summary: '这次执行的启动状态有待确认。', priority_reason: '按常规审批流程处理。',
      allowed_resolutions: ['confirm_started_attested', 'continue_tracking', 'abandon'], required_evidence: [],
      execution_observation: { reason: 'action_timeout', timeout_ms: 120_000, observed_running: true, has_tool_call: true } })
    const { api, commands, posts } = panelService(() => ({ ok: true, data: page([item]) }))
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    try {
      expect(view.text()).toContain('执行超时，等待处理')
      expect(view.text()).toContain('120 秒执行时限')
      expect(view.text()).toContain('记录显示本次执行已开始')
      expect(view.text()).toContain('整理数据清单')
      expect(view.text()).toContain('读取本地记录 · 第 2 次尝试')
      expect(view.text()).toContain('不会重新执行任务，也不会恢复已停止的工具调用')
      expect(view.text()).toContain('此操作不能证明执行已停止或外部操作未发生')
      expect(view.text()).not.toContain('启动状态有待确认')
      expect(view.text()).not.toContain('按常规审批流程处理')
      expect(view.text()).not.toContain('服务端未提供')
      expect((view.findAll('button').find(button => button.textContent === '人工确认已启动') as HTMLButtonElement).disabled).toBe(true)
      expect(posts).toHaveLength(0)
    } finally { view.unmount() }
  })

  it('没有启动依据时不宣称未启动或已经启动，也不提供服务端未允许的续等', async () => {
    const { api, commands } = panelService(() => ({ ok: true, data: page([decisionView({ kind: 'startup_unknown',
      target_summary: null, required_evidence: [], allowed_resolutions: ['abandon'] })]) }))
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    try {
      expect(view.text()).toContain('现有记录还不能确认这一步是否已启动')
      expect(view.text()).toContain('无法核实时不要勾选')
      expect(view.findAll('.ops-decision-option button').map(button => button.textContent)).toEqual(['停止跟踪'])
      expect(view.text()).not.toContain('记录显示本次执行已开始')
    } finally { view.unmount() }
  })

  it('把审批依据、缺少的资料和处理选项显示为中文，保留追溯编号', async () => {
    const { api } = panelService(() => ({ ok: true, data: page([decisionView({
      decision_id: 'dec-private',
      kind: 'future_decision_kind',
      status: 'future_decision_status',
      priority: 'urgent',
      priority_reason: 'evidence_missing',
      required_evidence: ['tool_evidence_missing', '请核对材料来源。'],
      resolution_unavailable_reason: '{"reason":"raw_parameters"}',
      allowed_resolutions: ['future_resolution'],
      projection_missing: ['allowed_resolutions'],
    })]) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    try {
      const text = view.text()
      expect(text).toContain('待确认事项')
      expect(text).toContain('当前状态未确认')
      expect(text).toContain('优先级：紧急')
      expect(text).toContain('缺少完成核验所需的执行证据')
      expect(text).toContain('没有找到验收指定步骤的工具执行记录')
      expect(text).toContain('请核对材料来源。')
      expect(text).toContain('现有记录未能说明具体原因')
      expect(text).toContain('当前记录缺少：处理选项')
      expect(text).not.toMatch(/future_|raw_parameters|dec-private|allowed_resolutions/)
      await view.click(view.findAll('input[aria-label="开发者视图"]')[0]!)
      expect(view.text()).toContain('dec-private')
      expect(view.text()).toContain('allowed_resolutions')
    } finally { view.unmount() }
  })
})

describe('待你决定屏的交互', () => {
  it('默认读人工待办，普通自主决定仍可从全部进行中处理', async () => {
    const ordinary = decisionView({ decision_id: 'ordinary', kind: 'audit_result', target_summary: '普通自主决定',
      allowed_resolutions: ['approved'] })
    const auditOnly = decisionView({ decision_id: 'audit-only', kind: 'audit_result', target_summary: '审计专属决定',
      status: 'blocked_for_human', approver: 'agent:auditor', allowed_resolutions: [] })
    const { api, commands } = panelService(({ params }) => ({ ok: true, data: page(params.get('inbox') === 'human'
      ? [] : params.get('status') === 'resolved' ? [] : [ordinary, auditOnly]) }))
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    try {
      expect(view.text()).not.toContain('普通自主决定')
      await view.click(view.findAll('button').find((button) => button.textContent === '全部进行中')!)
      expect(view.text()).toContain('普通自主决定')
      expect(view.findAll('button').some((button) => button.textContent === '批准执行')).toBe(true)
      const auditCard = view.findAll('article').find((element) => element.textContent?.includes('审计专属决定'))!
      expect(auditCard.textContent).toContain('由授权核验主体处理')
      expect(auditCard.textContent).not.toContain('等你处理')
      expect(auditCard.querySelector('button')).toBeNull()
      await view.click(view.findAll('button').find((button) => button.textContent === '已处理')!)
      expect(view.text()).not.toContain('普通自主决定')
    } finally { view.unmount() }
  })

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
    const resolveButton = view.findAll('article button').find((button) => button.textContent === '继续执行'
      && button.closest('article')?.textContent?.includes('执行前确认'))
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

  it('服务端没给可选项时不提供处理按钮，并说明缺哪些字段', async () => {
    const { api } = panelService(() => ({ ok: true, data: page([decisionView({
      allowed_resolutions: null,
      projection_missing: ['allowed_resolutions', 'priority'],
    })]) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    expect(view.text()).toContain('当前记录缺少：处理选项、优先级')
    expect(view.text()).not.toContain('allowed_resolutions')
    expect(view.findAll('.ops-decision-option button')).toHaveLength(0)
    expect(view.text()).toContain('当前没有可从这里执行的处理选项')
    expect(view.findAll('article button').some((button) => button.textContent === '继续执行')).toBe(false)
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
      { code: 'RESOLUTION_NOT_AVAILABLE', text: '当前状态下无法执行这项处理' },
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

  it('接手失败的未知错误使用中文提示，避免回显原始参数', async () => {
    const { api, commands } = panelService(({ path }) => path === '/v1/decisions'
      ? { ok: true, data: page([decisionView()]) }
      : { ok: false, error: { code: 'FUTURE_ERROR', message: '{"private_parameter":"test-secret"}', retryable: false } })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    try {
      await view.click(view.findAll('button').find((button) => button.textContent === '接手')!)
      expect(view.text()).toContain('现有记录未能说明具体原因')
      expect(view.text()).not.toMatch(/FUTURE_ERROR|private_parameter|test-secret/)
    } finally { view.unmount() }
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
  it('只显示宿主可用的同次执行操作，签认提交独立编号', async () => {
    let item = decisionView({ decision_id: 'd-start', kind: 'startup_unknown', current_revision: 4,
      allowed_resolutions: ['confirm_started_attested', 'continue_tracking', 'abandon'] })
    const { api, commands, posts } = panelService(({ path }) => {
      if (path !== '/v1/decisions/resolve') return { ok: true, data: page([item]) }
      item = { ...item, current_revision: 5, allowed_resolutions: ['abandon'] }
      return { ok: true, data: { decisionId: item.decision_id, revision: 5 } }
    })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    const button = (label: string) => view.findAll('button').find(candidate => candidate.textContent === label) as HTMLButtonElement | undefined
    const checkbox = view.findAll('input[type=checkbox]').find(input => input.parentElement?.textContent?.includes('我已核对本次执行'))
    expect(button('按系统凭据确认已启动')).toBeUndefined()
    expect(button('延长等待')).toBeUndefined()
    expect(button('再观察 120 秒')).toBeDefined()
    expect(view.text()).toContain('再观察原执行 120 秒')
    expect(button('人工确认已启动')?.disabled).toBe(true)
    await view.click(checkbox!)
    expect(button('人工确认已启动')?.disabled).toBe(false)
    await view.click(button('人工确认已启动')!)
    await view.flush()
    expect(posts).toEqual([{ path: '/v1/decisions/resolve', body: expect.objectContaining({ decisionId: 'd-start', revision: 4,
      resolution: 'confirm_started_attested', payload: { attestation_id: expect.stringMatching(/^att_/) } }) }])
    expect(button('人工确认已启动')).toBeUndefined()
    expect(button('再观察 120 秒')).toBeUndefined()
    view.unmount()
  })

  it('仅在审批卡允许时显示驳回放弃和重新观察', async () => {
    const restored = decisionView({ decision_id: 'restore', kind: 'abandon_ack', allowed_resolutions: ['approved', 'rejected'] })
    const terminal = decisionView({ decision_id: 'terminal', kind: 'abandon_ack', allowed_resolutions: ['approved'] })
    const { api, commands, posts } = panelService(({ path }) => path === '/v1/decisions/resolve'
      ? { ok: true, data: { decisionId: restored.decision_id, revision: 2 } }
      : { ok: true, data: page([restored, terminal]) })
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    const buttons = view.findAll('button').filter(button => button.textContent === '恢复跟踪')
    expect(buttons).toHaveLength(1)
    await view.click(buttons[0]!)
    expect(posts[0]?.body).toMatchObject({ decisionId: restored.decision_id, resolution: 'rejected' })
    view.unmount()
  })

  it('按钮在提交前说明会重试还是结束步骤', async () => {
    const retry = decisionView({ decision_id: 'retry', kind: 'startup_unknown', allowed_resolutions: ['confirm_not_started'],
      available_recovery_outcomes: { confirm_not_started: 'retry' } })
    const failed = decisionView({ decision_id: 'failed', kind: 'verify_human', allowed_resolutions: ['confirm_not_applied'],
      available_effect_evidence: { not_applied: 'proof' }, available_recovery_outcomes: { confirm_not_applied: 'failed' } })
    const { api, commands } = panelService(() => ({ ok: true, data: page([retry, failed]) }))
    const view = await renderPanel(<DecisionInbox api={api} commands={commands} />)
    const labels = view.findAll('button').map(button => button.textContent)
    expect(labels).toContain('确认未启动并发起新尝试')
    expect(labels).toContain('确认外部操作未发生并将此步骤记为失败')
    view.unmount()
  })

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
