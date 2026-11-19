// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi, type ResourcesApi } from '../../src/client/api/resources.ts'
import { COPY } from '../../src/client/panel/copy.ts'
import { PanelApp } from '../../src/client/panel/app.tsx'
import { DecisionInbox } from '../../src/client/panel/decision-inbox.tsx'
import { PanelCommandButton, PanelShell } from '../../src/client/panel/shell.tsx'
import { TaskListScreen } from '../../src/client/panel/tasks-screen.tsx'
import { UnverifiedEffects } from '../../src/client/panel/unverified-effects.tsx'
import { WorkflowListScreen } from '../../src/client/panel/workflow-list.tsx'
import {
  createFakeService,
  decisionView,
  deferred,
  effectView,
  nodeRunView,
  page,
  renderPanel,
  runSummary,
  taskSummary,
  workflowItem,
  type FakeQuery,
  type FakeReply,
  type FakeService,
} from './harness.ts'

const noop = () => {}

function apiFrom(handler: (query: FakeQuery) => FakeReply | Promise<FakeReply>): { api: ResourcesApi; service: FakeService } {
  const service = createFakeService(handler)
  return { api: createResourcesApi(createApiClient('http://panel.test', service.fetcher)), service }
}

describe('任务列表页', () => {
  it('读取过程中显示正在读取，读完后显示任务行', async () => {
    const gate = deferred<FakeReply>()
    const { api } = apiFrom(() => gate.promise)
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    expect(view.byRole('status').length).toBeGreaterThan(0)
    expect(view.text()).toContain('正在读取任务…')
    expect(view.text()).not.toContain(COPY.emptyTasks)

    gate.resolve({ ok: true, data: page([taskSummary()]) })
    await view.flush()
    expect(view.text()).not.toContain('正在读取任务…')
    expect(view.findAll('article').length).toBe(1)
    expect(view.text()).toContain('任务一')
    view.unmount()
  })

  it('没有任务时显示空态提示而不是空白', async () => {
    const { api } = apiFrom(() => ({ ok: true, data: page([]) }))
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()
    expect(view.text()).toContain(COPY.emptyTasks)
    expect(view.findAll('article').length).toBe(0)
    expect(view.byRole('alert').length).toBe(0)
    view.unmount()
  })

  it('查询失败时显示错误提示和重试入口', async () => {
    const { api } = apiFrom(() => { throw new Error('服务没起来') })
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()
    expect(view.byRole('alert').length).toBe(1)
    expect(view.text()).toContain(COPY.queryFailed)
    expect(view.findAll('button').some((button) => button.textContent === COPY.retry)).toBe(true)
    view.unmount()
  })

  it('服务端给了不认得的状态时显示未知提示而不是空白', async () => {
    const { api } = apiFrom(() => ({
      ok: true,
      data: page([taskSummary({ status: 'future-status', display_status: 'future-status' })]),
    }))
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()
    expect(view.text()).toContain(COPY.oldPanel)
    expect(view.text()).toContain('future-status')
    expect(view.byRole('status').length).toBeGreaterThan(0)
    view.unmount()
  })

  it('真实数据把运行次数、待决定和待核实数量显示出来', async () => {
    const { api } = apiFrom(() => ({
      ok: true,
      data: page([taskSummary({
        run_count: 3,
        open_decision_count: 2,
        unverified_count: 5,
        attention: 'unverified',
        attention_reason: '有 5 笔副作用待核实',
        max_side_effect_level: 'irreversible',
      })]),
    }))
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()
    expect(view.text()).toContain('3 次运行')
    expect(view.text()).toContain('2 项待审批')
    expect(view.text()).toContain('5 项待核实')
    expect(view.text()).toContain('涉及不可逆操作')
    expect(view.text()).toContain('有 5 笔副作用待核实')
    expect(view.text()).toContain('待核实')
    view.unmount()
  })

  it('把真实状态分到四列，已收尾但待核实的任务仍在需要你', async () => {
    const { api } = apiFrom(() => ({ ok: true, data: page([
      taskSummary({ task_id: 'q', title: '下一项', status: 'queued', display_status: 'queued' }),
      taskSummary({ task_id: 'r', title: '正在跑' }),
      taskSummary({ task_id: 'u', title: '仍待核实', status: 'succeeded_with_unverified', unverified_count: 1, attention: 'unverified' }),
      taskSummary({ task_id: 's', title: '已交付', status: 'succeeded', display_status: 'succeeded', attention: 'none' }),
    ]) }))
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()
    expect(view.findAll('[data-task-column]').map((column) => [column.getAttribute('data-task-column'), column.querySelector('button')?.textContent])).toEqual([
      ['upcoming', '下一项'], ['running', '正在跑'], ['attention', '仍待核实'], ['finished', '已交付'],
    ])
    view.unmount()
  })

  it('详情保留看板，按运行加载产物并核对对应节点的系统证据', async () => {
    const task = taskSummary({ title: '交付复核', run_count: 2 })
    const service = createFakeService(({ path, params }) => {
      if (path === '/v1/tasks') return { ok: true, data: page([task]) }
      if (path === '/v1/tasks/get') return { ok: true, data: task }
      if (path === '/v1/runs') return { ok: true, data: { items: [runSummary({ total: 1 }), runSummary({ run_id: 'r2' })] } }
      if (path === '/v1/node-runs' && params.get('run_id') === 'r1') return { ok: true, data: { items: [
        nodeRunView({ node_id: '核对清单', execution_ids: ['ev1', 'wrong'], execution_count: 2 }),
      ] } }
      if (path === '/v1/artifacts' && params.get('run_id') === 'r1') return { ok: true, data: {
        items: [{ artifact_id: '交付清单', sha256: 'hash', created_at: task.updated_at }], has_more: false,
      } }
      if (path === '/v1/evidence/get') return { ok: true, data: {
        evidence_id: params.get('evidence_id'), node_run_id: 'nr1', run_id: params.get('evidence_id') === 'ev1' ? 'r1' : 'r2',
        attempt: 1, strength: 'strong', source: 'run_tool', tool: 'ro.verify', exit_code: 0, observed_at: task.updated_at,
      } }
      return { ok: false, error: { code: 'NOT_FOUND', message: 'missing', retryable: false } }
    })
    const view = await renderPanel(<PanelApp client={createApiClient('http://panel.test', service.fetcher)} serviceConnected />)
    await view.flush()
    const card = view.findAll('button').find((button) => button.textContent === task.title) as HTMLButtonElement
    card.focus()
    await view.click(card)
    await view.flush()
    const inspector = view.container.querySelector('#task-inspector')!
    expect(view.container.contains(card)).toBe(true)
    expect(card.getAttribute('aria-expanded')).toBe('true')
    const tab = (label: string) => Array.from(inspector.querySelectorAll('button')).find((button) => button.textContent === label)!
    await view.click(tab('完整运行'))
    await view.flush()
    expect(inspector.textContent).toContain('核对清单')
    await view.click(tab('结果'))
    await view.flush()
    expect(inspector.textContent).toContain('交付清单')
    await view.click(tab('证据'))
    expect(service.calls.some((call) => call.path === '/v1/evidence/get')).toBe(false)
    const summaries = inspector.querySelectorAll('summary')
    await view.click(summaries[0]!)
    await view.click(summaries[1]!)
    await view.flush()
    expect(inspector.textContent).toContain('系统证据（账本已核验）· ro.verify · 退出码 0')
    expect(inspector.textContent).toContain('暂时无法确认这条系统证据')
    await view.click(tab('关闭'))
    expect(view.container.querySelector('#task-inspector')).toBeNull()
    expect(document.activeElement).toBe(card)
    expect(service.calls.filter((call) => call.path === '/v1/tasks')).toHaveLength(1)
    view.unmount()
  })
})

describe('流程列表页', () => {
  it('读取过程中显示正在读取，读完后显示流程表格', async () => {
    const gate = deferred<FakeReply>()
    const { api } = apiFrom(() => gate.promise)
    const view = await renderPanel(<WorkflowListScreen api={api} onSelectWorkflow={noop} />)
    expect(view.text()).toContain('正在读取流程…')
    expect(view.text()).not.toContain('当前没有已保存的流程')

    gate.resolve({ ok: true, data: page([workflowItem()]) })
    await view.flush()
    expect(view.text()).not.toContain('正在读取流程…')
    expect(view.findAll('table tbody tr').length).toBe(1)
    expect(view.text()).toContain('流程一')
    view.unmount()
  })

  it('没有流程时显示空态提示', async () => {
    const { api } = apiFrom(() => ({ ok: true, data: page([]) }))
    const view = await renderPanel(<WorkflowListScreen api={api} onSelectWorkflow={noop} />)
    await view.flush()
    expect(view.text()).toContain('当前没有已保存的流程')
    expect(view.findAll('table tbody tr').length).toBe(0)
    view.unmount()
  })

  it('查询失败时显示错误提示和重试入口', async () => {
    const { api } = apiFrom(() => { throw new Error('服务没起来') })
    const view = await renderPanel(<WorkflowListScreen api={api} onSelectWorkflow={noop} />)
    await view.flush()
    expect(view.byRole('alert').length).toBe(1)
    expect(view.text()).toContain(COPY.queryFailed)
    view.unmount()
  })

  it('不认识的流程范围显示未知提示', async () => {
    const { api } = apiFrom(() => ({ ok: true, data: page([workflowItem({ scope: 'weird_scope' })]) }))
    const view = await renderPanel(<WorkflowListScreen api={api} onSelectWorkflow={noop} />)
    await view.flush()
    expect(view.text()).toContain(COPY.oldPanel)
    expect(view.text()).toContain('weird_scope')
    view.unmount()
  })

  it('真实数据把版本、步骤数和正在使用的任务数显示出来', async () => {
    const { api } = apiFrom(() => ({ ok: true, data: page([workflowItem(), workflowItem({ workflow_id: 'disabled', status: 'disabled' })]) }))
    const view = await renderPanel(<WorkflowListScreen api={api} onSelectWorkflow={noop} />)
    await view.flush()
    expect(view.text()).toContain('可复用')
    expect(view.text()).toContain('v3')
    expect(view.findAll('tbody tr:first-child td').map((cell) => cell.textContent?.trim())).toEqual(expect.arrayContaining(['4', '2', '已启用']))
    expect(view.text()).toContain('已停用')
    view.unmount()
  })
})

describe('等你决定页', () => {
  it('读取过程中显示正在读取，读完后显示决定卡片', async () => {
    const gate = deferred<FakeReply>()
    const { api } = apiFrom(() => gate.promise)
    const view = await renderPanel(<DecisionInbox api={api} />)
    expect(view.text()).toContain('正在读取决定事项…')
    expect(view.text()).not.toContain(COPY.emptyDecisions)

    gate.resolve({ ok: true, data: page([decisionView()]) })
    await view.flush()
    expect(view.text()).not.toContain('正在读取决定事项…')
    expect(view.findAll('article').length).toBe(1)
    view.unmount()
  })

  it('没有待处理决定时显示空态提示', async () => {
    const { api } = apiFrom(() => ({ ok: true, data: page([]) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    expect(view.text()).toContain(COPY.emptyDecisions)
    expect(view.findAll('article').length).toBe(0)
    view.unmount()
  })

  it('查询失败时显示错误提示和重试入口', async () => {
    const { api } = apiFrom(() => { throw new Error('服务没起来') })
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    expect(view.byRole('alert').length).toBe(1)
    expect(view.text()).toContain(COPY.queryFailed)
    view.unmount()
  })

  it('不认识的决定种类显示未知提示', async () => {
    const { api } = apiFrom(() => ({ ok: true, data: page([decisionView({ kind: 'weird_kind', status: 'weird_status' })]) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    expect(view.text()).toContain(COPY.oldPanel)
    expect(view.text()).toContain('weird_kind')
    expect(view.text()).toContain('weird_status')
    view.unmount()
  })

  it('真实数据把说明、可选处理和需要的证据显示出来', async () => {
    const { api } = apiFrom(() => ({ ok: true, data: page([decisionView()]) }))
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    expect(view.text()).toContain('执行前确认')
    expect(view.text()).toContain('待处理')
    expect(view.text()).toContain('确认这一步要不要执行')
    expect(view.text()).toContain('动手前要先确认')
    expect(view.text()).toContain('continue / abort')
    expect(view.text()).toContain('命令清单')
    view.unmount()
  })
})

describe('待核实页', () => {
  it('读取过程中显示正在读取，读完后显示待核实卡片', async () => {
    const gate = deferred<FakeReply>()
    const { api } = apiFrom(() => gate.promise)
    const view = await renderPanel(<UnverifiedEffects api={api} />)
    expect(view.text()).toContain('正在读取待核实事项…')
    expect(view.text()).not.toContain(COPY.emptyEffects)

    gate.resolve({ ok: true, data: page([effectView()]) })
    await view.flush()
    expect(view.text()).not.toContain('正在读取待核实事项…')
    expect(view.findAll('article').length).toBe(1)
    view.unmount()
  })

  it('没有待核实操作时显示空态提示', async () => {
    const { api } = apiFrom(() => ({ ok: true, data: page([]) }))
    const view = await renderPanel(<UnverifiedEffects api={api} />)
    await view.flush()
    expect(view.text()).toContain(COPY.emptyEffects)
    expect(view.findAll('article').length).toBe(0)
    view.unmount()
  })

  it('查询失败时显示错误提示和重试入口', async () => {
    const { api } = apiFrom(() => { throw new Error('服务没起来') })
    const view = await renderPanel(<UnverifiedEffects api={api} />)
    await view.flush()
    expect(view.byRole('alert').length).toBe(1)
    expect(view.text()).toContain(COPY.queryFailed)
    view.unmount()
  })

  it('不认识的副作用级别显示未知提示', async () => {
    const { api } = apiFrom(() => ({
      ok: true,
      data: page([effectView({ side_effect_policy: 'weird_policy', status: 'weird_status' })]),
    }))
    const view = await renderPanel(<UnverifiedEffects api={api} />)
    await view.flush()
    expect(view.text()).toContain(COPY.oldPanel)
    expect(view.text()).toContain('weird_policy')
    expect(view.text()).toContain('weird_status')
    view.unmount()
  })

  it('真实数据把副作用级别、等待时长和停止记录显示出来', async () => {
    const { api } = apiFrom(() => ({ ok: true, data: page([effectView()]) }))
    const view = await renderPanel(<UnverifiedEffects api={api} />)
    await view.flush()
    expect(view.text()).toContain('n1')
    expect(view.text()).toContain('可补偿')
    expect(view.text()).toContain('已完成')
    expect(view.text()).toContain('未验证')
    expect(view.text()).toContain('120 秒')
    expect(view.text()).toContain('没有记录停止证据')
    view.unmount()
  })
})

describe('面板外壳', () => {
  it('服务已连接且事件流实时时不显示过期提示', async () => {
    const view = await renderPanel(
      <PanelShell activeRoute="tasks" onNavigate={noop} serviceConnected streamStatus="live">
        <div>任务内容</div>
      </PanelShell>,
    )
    expect(view.text()).toContain('实时更新')
    expect(view.text()).not.toContain(COPY.staleNotice)
    expect(view.byRole('alert').length).toBe(0)
    view.unmount()
  })

  it('事件流退到轮询时显示轮询更新', async () => {
    const view = await renderPanel(
      <PanelShell activeRoute="tasks" onNavigate={noop} serviceConnected streamStatus="polling">
        <div>任务内容</div>
      </PanelShell>,
    )
    expect(view.text()).toContain('轮询更新')
    view.unmount()
  })

  it('事件流过期时显示过期提示条', async () => {
    const view = await renderPanel(
      <PanelShell activeRoute="tasks" onNavigate={noop} serviceConnected streamStatus="stale">
        <div>任务内容</div>
      </PanelShell>,
    )
    expect(view.text()).toContain('数据可能已过期')
    expect(view.text()).toContain(COPY.staleNotice)
    view.unmount()
  })

  it('服务没连上时显示未连接并保留过期提示', async () => {
    const view = await renderPanel(
      <PanelShell activeRoute="tasks" onNavigate={noop} serviceConnected={false}>
        <div>任务内容</div>
      </PanelShell>,
    )
    expect(view.text()).toContain(COPY.serviceDown)
    expect(view.text()).toContain(COPY.staleNotice)
    view.unmount()
  })

  it('Q-20 服务停止后保留最后一次快照并标 stale，命令按钮禁用', async () => {
    const view = await renderPanel(
      <PanelShell activeRoute="tasks" onNavigate={noop} serviceConnected={false} streamStatus="stale">
        <div>上一次拿到的任务内容</div>
        <PanelCommandButton>执行命令</PanelCommandButton>
      </PanelShell>,
    )
    // 最后一次快照还在屏上，不显示空白。
    expect(view.text()).toContain('上一次拿到的任务内容')
    // stale 标记与提示都在。
    expect(view.text()).toContain(COPY.staleNotice)
    expect(view.text()).toContain(COPY.serviceDown)
    // 命令按钮禁用。
    const button = view.findAll('button').find((item) => item.textContent === '执行命令') as HTMLButtonElement | undefined
    expect(button).toBeDefined()
    expect(button?.disabled).toBe(true)
    view.unmount()

    // 事件流也过期时，面板把 stale 写在状态位上，命令按钮同样禁用。
    const stale = await renderPanel(
      <PanelShell activeRoute="tasks" onNavigate={noop} serviceConnected streamStatus="stale">
        <div>上一次拿到的任务内容</div>
        <PanelCommandButton>执行命令</PanelCommandButton>
      </PanelShell>,
    )
    expect(stale.text()).toContain('数据可能已过期')
    expect(stale.text()).toContain(COPY.staleNotice)
    const staleButton = stale.findAll('button').find((item) => item.textContent === '执行命令') as HTMLButtonElement | undefined
    expect(staleButton?.disabled).toBe(true)
    stale.unmount()

    // 服务正常时命令按钮可用（禁用确实来自服务停止，不是常灰）。
    const live = await renderPanel(
      <PanelShell activeRoute="tasks" onNavigate={noop} serviceConnected streamStatus="live">
        <PanelCommandButton>执行命令</PanelCommandButton>
      </PanelShell>,
    )
    const liveButton = live.findAll('button').find((item) => item.textContent === '执行命令') as HTMLButtonElement | undefined
    expect(liveButton).toBeDefined()
    expect(liveButton?.disabled).toBe(false)
    live.unmount()
  })

  it('协议版本不一致时整页提示并停用面板', async () => {
    const view = await renderPanel(
      <PanelShell activeRoute="tasks" onNavigate={noop} serviceConnected protocolMismatch>
        <div>任务内容</div>
      </PanelShell>,
    )
    expect(view.byRole('alert').length).toBe(1)
    expect(view.text()).toContain(COPY.protocolMismatch)
    expect(view.text()).not.toContain('任务内容')
    view.unmount()
  })
})
