// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi, type ResourcesApi } from '../../src/client/api/resources.ts'
import { DecisionInbox } from '../../src/client/panel/decision-inbox.tsx'
import { TaskListScreen } from '../../src/client/panel/tasks-screen.tsx'
import { UnverifiedEffects } from '../../src/client/panel/unverified-effects.tsx'
import { WorkflowListScreen } from '../../src/client/panel/workflow-list.tsx'
import {
  createFakeService,
  decisionView,
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

function loadMore(view: { findAll: (selector: string) => Element[] }): Element {
  const button = view.findAll('button').find((item) => item.textContent === '加载更多')
  expect(button).toBeTruthy()
  return button as Element
}

describe('收到 reload 之后重新从第一页取数', () => {
  it('任务页在第二页收到 reload：从首页重建已加载窗口并移除已归档行', async () => {
    const first = taskSummary({ task_id: 't1', title: '任务一' })
    const second = taskSummary({ task_id: 't2', title: '任务二' })
    let refreshed = false
    const { api, service } = apiFrom((query) => {
      const cursor = query.params.get('cursor')
      if (refreshed) return { ok: true, data: cursor ? page([]) : page([{ ...first, title: '任务一更新' }], 'cursor-current') }
      return { ok: true, data: cursor ? page([second]) : page([first], 'cursor-2') }
    })
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()
    expect(view.findAll('article').length).toBe(1)
    expect(view.text()).toContain('任务一')

    await view.click(loadMore(view))
    await view.flush()
    expect(view.findAll('article').length).toBe(2)
    expect(view.text()).toContain('任务二')

    refreshed = true
    const before = service.calls.length
    await view.rerender(<TaskListScreen api={api} onSelectTask={noop} reloadVersion={1} />)
    await view.flush()

    expect(view.findAll('article')).toHaveLength(1)
    expect(view.text()).toContain('任务一更新')
    expect(view.text()).not.toContain('任务二')
    const after = service.calls.slice(before)
    expect(after.map(call => call.params.get('cursor'))).toEqual([null, 'cursor-current'])
    view.unmount()
  })

  it('流程页在第二页收到 reload：旧行不残留、不重复，请求回到第一页', async () => {
    const first = workflowItem({ workflow_id: 'wf1', name: '流程一' })
    const second = workflowItem({ workflow_id: 'wf2', name: '流程二' })
    const { api, service } = apiFrom((query) => {
      const cursor = query.params.get('cursor')
      return { ok: true, data: cursor ? page([second]) : page([first], 'cursor-2') }
    })
    const view = await renderPanel(<WorkflowListScreen api={api} onSelectWorkflow={noop} />)
    await view.flush()
    expect(view.findAll('tbody tr').length).toBe(1)
    expect(view.text()).toContain('流程一')

    await view.click(loadMore(view))
    await view.flush()
    expect(view.findAll('tbody tr').length).toBe(2)
    expect(view.text()).toContain('流程二')

    const before = service.calls.length
    await view.rerender(<WorkflowListScreen api={api} onSelectWorkflow={noop} reloadVersion={1} />)
    await view.flush()

    expect(view.findAll('tbody tr').length).toBe(1)
    expect(view.text()).toContain('流程一')
    expect(view.text()).not.toContain('流程二')
    const after = service.calls.slice(before)
    expect(after.length).toBeGreaterThan(0)
    for (const call of after) {
      expect(call.params.get('cursor')).toBeNull()
    }
    view.unmount()
  })

  it('等你决定页收到 reload：最后一次请求回到第一页，列表只剩第一页', async () => {
    const first = decisionView({ decision_id: 'd1', target_summary: '第一个决定' })
    const second = decisionView({ decision_id: 'd2', target_summary: '第二个决定' })
    const { api, service } = apiFrom((query) => {
      const cursor = query.params.get('cursor')
      return { ok: true, data: cursor ? page([second]) : page([first], 'cursor-2') }
    })
    const view = await renderPanel(<DecisionInbox api={api} />)
    await view.flush()
    expect(view.findAll('article').length).toBe(1)

    await view.click(loadMore(view))
    await view.flush()
    expect(view.findAll('article').length).toBe(2)
    expect(view.text()).toContain('第二个决定')

    const before = service.calls.length
    await view.rerender(<DecisionInbox api={api} reloadVersion={1} />)
    await view.flush()
    const after = service.calls.slice(before)
    expect(after.filter((call) => call.params.get('cursor') !== null).length).toBeLessThanOrEqual(1)
    expect(after[after.length - 1]?.params.get('cursor')).toBeNull()

    expect(view.findAll('article').length).toBe(1)
    expect(view.text()).toContain('第一个决定')
    expect(view.text()).not.toContain('第二个决定')
    expect(service.lastCall()?.params.get('cursor')).toBeNull()
    view.unmount()
  })

  it('待核实页收到 reload：最后一次请求回到第一页，列表只剩第一页', async () => {
    const first = effectView({ node_run_id: 'nr1', node_id: '步骤一' })
    const second = effectView({ node_run_id: 'nr2', node_id: '步骤二' })
    const { api, service } = apiFrom((query) => {
      const cursor = query.params.get('cursor')
      return { ok: true, data: cursor ? page([second]) : page([first], 'cursor-2') }
    })
    const view = await renderPanel(<UnverifiedEffects api={api} />)
    await view.flush()
    expect(view.findAll('article').length).toBe(1)

    await view.click(loadMore(view))
    await view.flush()
    expect(view.findAll('article').length).toBe(2)
    expect(view.text()).toContain('步骤二')

    const before = service.calls.length
    await view.rerender(<UnverifiedEffects api={api} reloadVersion={1} />)
    await view.flush()
    const after = service.calls.slice(before)
    expect(after.filter((call) => call.params.get('cursor') !== null).length).toBeLessThanOrEqual(1)
    expect(after[after.length - 1]?.params.get('cursor')).toBeNull()

    expect(view.findAll('article').length).toBe(1)
    expect(view.text()).toContain('步骤一')
    expect(view.text()).not.toContain('步骤二')
    expect(service.lastCall()?.params.get('cursor')).toBeNull()
    view.unmount()
  })
})
