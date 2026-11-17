// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi, type ResourcesApi } from '../../src/client/api/resources.ts'
import { COPY } from '../../src/client/panel/copy.ts'
import { DecisionInbox } from '../../src/client/panel/decision-inbox.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { TaskListScreen } from '../../src/client/panel/tasks-screen.tsx'
import { UnverifiedEffects } from '../../src/client/panel/unverified-effects.tsx'
import { WorkflowListScreen } from '../../src/client/panel/workflow-list.tsx'
import {
  createFakeService,
  decisionView,
  deferred,
  effectView,
  page,
  renderPanel,
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
      data: page([taskSummary({ status: 'paused', display_status: 'paused' })]),
    }))
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()
    expect(view.text()).toContain(COPY.oldPanel)
    expect(view.text()).toContain('paused')
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
    expect(view.text()).toContain('2 项等你决定')
    expect(view.text()).toContain('5 项待核实')
    expect(view.text()).toContain('涉及不可逆操作')
    expect(view.text()).toContain('有 5 笔副作用待核实')
    expect(view.text()).toContain('待核实')
    view.unmount()
  })
})

describe('流程列表页', () => {
  it('读取过程中显示正在读取，读完后显示流程卡片', async () => {
    const gate = deferred<FakeReply>()
    const { api } = apiFrom(() => gate.promise)
    const view = await renderPanel(<WorkflowListScreen api={api} onSelectWorkflow={noop} />)
    expect(view.text()).toContain('正在读取流程…')
    expect(view.text()).not.toContain('当前没有已保存的流程')

    gate.resolve({ ok: true, data: page([workflowItem()]) })
    await view.flush()
    expect(view.text()).not.toContain('正在读取流程…')
    expect(view.findAll('article').length).toBe(1)
    expect(view.text()).toContain('流程一')
    view.unmount()
  })

  it('没有流程时显示空态提示', async () => {
    const { api } = apiFrom(() => ({ ok: true, data: page([]) }))
    const view = await renderPanel(<WorkflowListScreen api={api} onSelectWorkflow={noop} />)
    await view.flush()
    expect(view.text()).toContain('当前没有已保存的流程')
    expect(view.findAll('article').length).toBe(0)
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
    const { api } = apiFrom(() => ({ ok: true, data: page([workflowItem()]) }))
    const view = await renderPanel(<WorkflowListScreen api={api} onSelectWorkflow={noop} />)
    await view.flush()
    expect(view.text()).toContain('可复用流程')
    expect(view.text()).toContain('v3')
    expect(view.text()).toContain('4 个步骤')
    expect(view.text()).toContain('2 个任务')
    expect(view.text()).toContain('可使用')
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
