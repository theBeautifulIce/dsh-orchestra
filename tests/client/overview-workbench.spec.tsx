// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import type { TaskNextAction } from '../../src/client/api/types.ts'
import { OverviewScreen } from '../../src/client/panel/overview-screen.tsx'
import { COPY } from '../../src/client/panel/copy.ts'
import { createFakeService, deferred, page, renderPanel, taskSummary, workflowItem,
  type FakeReply, type PanelView } from './harness.ts'

const views: PanelView[] = []
afterEach(() => { views.splice(0).forEach((view) => view.unmount()) })
const summary = { lanes: { upcoming: 1, running: 1, attention: 2, finished: 1 }, open_decisions: 2, unverified_effects: 1 }
const baseReply = (path: string): FakeReply => {
  if (path === '/v1/workspace/overview') return { ok: true, data: summary, asOfSeq: 10 }
  if (path === '/v1/workflows') return { ok: true, data: page([workflowItem()]), asOfSeq: 12 }
  if (path === '/v1/activity') return { ok: true, data: { items: [], next_before_seq: null }, asOfSeq: 99 }
  throw new Error(`Unexpected request: ${path}`)
}

describe('A 版总览工作台', () => {
  it('只取各分组的首屏，以最旧的完整读水位确认快照，并保留任务真实结束结论', async () => {
    const service = createFakeService(({ path, params }) => {
      if (path !== '/v1/tasks') return baseReply(path)
      if (params.get('lane') === 'attention') return { ok: true, asOfSeq: 11, data: page([
        taskSummary({ task_id: 'needs-review', title: '验收未通过', status: 'succeeded', display_status: 'succeeded',
          lane: 'attention', delivery_acceptance: 'failed' }),
        taskSummary({ task_id: 'uncertain', title: '操作仍待核实', status: 'succeeded_with_unverified',
          display_status: 'succeeded_with_unverified', lane: 'attention', unverified_count: 1 }),
      ]) }
      if (params.get('lane') === 'finished') return { ok: true, asOfSeq: 9, data: page([
        taskSummary({ task_id: 'canceled', title: '取消的任务', status: 'cancelled', display_status: 'cancelled', lane: 'finished' }),
      ]) }
      return { ok: true, asOfSeq: 13, data: page([
        taskSummary({ task_id: 'running', title: '推进中的任务', lane: 'running', step_total: 6, step_done: 2 }),
      ]) }
    })
    const onSnapshot = vi.fn()
    const view = await renderPanel(<OverviewScreen api={createResourcesApi(createApiClient('http://panel.test', service.fetcher))}
      reloadVersion={0} onSnapshot={onSnapshot} onNavigate={vi.fn()} />)
    views.push(view)
    await view.flush()

    expect(service.calls.filter(({ path }) => path === '/v1/tasks').map(({ params }) => [params.get('lane'), params.get('limit')]))
      .toEqual([['attention', '4'], ['finished', '4'], ['running', '4']])
    expect(onSnapshot.mock.calls).toEqual([[9]])
    expect(view.container.querySelector('[data-task-id="canceled"]')?.textContent).toContain('已取消')
    expect(view.container.querySelector('[data-task-id="canceled"]')?.textContent).not.toContain('已完成')
    expect(view.container.querySelector('[data-task-id="needs-review"]')?.textContent).toContain(COPY.deliveryAcceptanceFailed)
    expect(view.container.querySelector('[data-task-id="uncertain"]')?.textContent).toContain(COPY.succeededWithUnverified)
    expect(view.container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('2')
    expect(view.container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuemax')).toBe('6')
  })

  it('主操作原样传递服务端 action 和运行目标，标题只打开任务当前运行', async () => {
    const action: TaskNextAction = { kind: 'decision', label: '审阅待授权步骤', decision_id: 'decision-exact', run_id: 'run-action' }
    const service = createFakeService(({ path, params }) => path === '/v1/tasks'
      ? { ok: true, data: page(params.get('lane') === 'attention'
        ? [taskSummary({ task_id: 'task-exact', current_run_id: 'run-current', next_action: action, lane: 'attention' })] : []) }
      : baseReply(path))
    const onSelect = vi.fn()
    const view = await renderPanel(<OverviewScreen api={createResourcesApi(createApiClient('http://panel.test', service.fetcher))}
      reloadVersion={0} onSnapshot={vi.fn()} onNavigate={vi.fn()} onSelectTask={onSelect} />)
    views.push(view)
    await view.flush()
    const actionButton = view.container.querySelector('[data-task-primary-action="decision"]')!
    await view.click(actionButton)
    expect(onSelect).toHaveBeenLastCalledWith('task-exact', actionButton, 'run-action', action)
    const titleButton = view.container.querySelector('.ops-overview-task-title')!
    await view.click(titleButton)
    expect(onSelect).toHaveBeenLastCalledWith('task-exact', titleButton, 'run-current', undefined)
  })

  it('任务读组失败时，活动加载成功也不确认快照；重试完整成功后才恢复', async () => {
    let failed = true
    const service = createFakeService(({ path, params }) => {
      if (path !== '/v1/tasks') return baseReply(path)
      if (failed && params.get('lane') === 'attention') throw new Error('task list unavailable')
      return { ok: true, data: page([]), asOfSeq: 20 }
    })
    const onSnapshot = vi.fn()
    const view = await renderPanel(<OverviewScreen api={createResourcesApi(createApiClient('http://panel.test', service.fetcher))}
      reloadVersion={0} onSnapshot={onSnapshot} onNavigate={vi.fn()} />)
    views.push(view)
    await view.flush()
    expect(view.text()).toContain('总览读取失败。')
    expect(view.text()).toContain('当前没有活动记录。')
    expect(onSnapshot).not.toHaveBeenCalled()
    failed = false
    await view.click(view.findAll('button').find((button) => button.textContent === '重试')!)
    await view.flush()
    expect(view.text()).not.toContain('总览读取失败。')
    expect(onSnapshot.mock.calls).toEqual([[10]])
  })

  it('刷新后迟到的旧请求不能替换新总览或确认旧快照', async () => {
    const previous = deferred<FakeReply>()
    let generation = 0
    const service = createFakeService(({ path, params }) => {
      if (path !== '/v1/tasks') return baseReply(path)
      if (params.get('lane') === 'attention') {
        if (generation === 0) return previous.promise
        return { ok: true, data: page([taskSummary({ title: '新一轮任务', lane: 'attention' })]), asOfSeq: 30 }
      }
      return { ok: true, data: page([]), asOfSeq: 30 }
    })
    const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
    const onSnapshot = vi.fn()
    const onNavigate = vi.fn()
    const view = await renderPanel(<OverviewScreen api={api} reloadVersion={0} onSnapshot={onSnapshot} onNavigate={onNavigate} />)
    views.push(view)
    generation = 1
    await view.rerender(<OverviewScreen api={api} reloadVersion={1} onSnapshot={onSnapshot} onNavigate={onNavigate} />)
    await view.flush()
    expect(view.text()).toContain('新一轮任务')
    previous.resolve({ ok: true, data: page([taskSummary({ title: '旧一轮任务', lane: 'attention' })]), asOfSeq: 1 })
    await view.flush()
    expect(view.text()).not.toContain('旧一轮任务')
    expect(onSnapshot.mock.calls).toEqual([[10]])
  })
})
