// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { TaskListScreen } from '../../src/client/panel/tasks-screen.tsx'
import { createFakeService, deferred, nodeRunView, page, renderPanel, taskSummary, type FakeReply } from './harness.ts'

const task = taskSummary({ task_id: 'board-task', title: '运行复核', current_run_id: 'board-run', workflow_version: 9 })
const step = (node_id: string, title: string, depends_on?: string[]) => nodeRunView({
  node_id, node_run_id: node_id, run_id: 'board-run', title, depends_on,
})
const groupSelector = '.task-card-steps details'

it('groups actual siblings beneath one card and keeps partial joins and separate parents distinct', async () => {
  const nodes = [
    step('join', '部分汇合', ['one', 'two']),
    step('independent', '独立终点', ['other']),
    step('nested-second', '补充核对', ['one']),
    step('two', '复核', ['start']),
    { ...step('one', '旧名称', ['start']), replacement_node_run_id: 'one-2' },
    { ...step('one', '复核', ['start']), node_run_id: 'one-2', attempt: 2 },
    step('nested-first', '现场核对', ['one']),
    step('other', '独立准备', []),
    step('start', '收集资料', []),
  ]
  const service = createFakeService(({ path, params }) => {
    if (path === '/v1/tasks') return { ok: true, data: page([task]) }
    if (path === '/v1/node-runs' && params.get('run_id') === task.current_run_id) return { ok: true, data: { items: nodes } }
    throw new Error(path)
  })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const view = await renderPanel(<TaskListScreen api={api} onSelectTask={() => {}} />)
  try {
    expect(service.calls.map(({ path }) => path)).toEqual(['/v1/tasks'])
    await view.click(view.container.querySelector('[aria-label="展开步骤：运行复核"]')!)
    await view.flush()
    expect(view.findAll('article.task-card')).toHaveLength(1)
    const groups = view.findAll(groupSelector) as HTMLDetailsElement[]
    const titles = (group: Element) => Array.from(group.querySelectorAll('li strong'), ({ textContent }) => textContent)
    expect(groups.map(titles)).toEqual([['独立准备', '收集资料'], ['复核', '复核'], ['补充核对', '现场核对']])
    expect(groups[0]?.querySelector('summary')?.textContent).toContain('运行起点')
    expect(groups[1]?.querySelector('summary')?.textContent).toContain('收集资料')
    expect(groups[2]?.querySelector('summary')?.textContent).toContain('复核')
    expect(groups[2]?.querySelector('summary')?.textContent).toContain('同名步骤 1')
    expect(groups[1]?.open).toBe(false)
    await view.click(groups[1]!.querySelector('summary')!)
    expect(groups[1]?.open).toBe(true)
    expect(groups[0]?.open).toBe(false)
    expect(groups[1]?.textContent).toContain('第 2 次尝试')
    expect(view.text()).not.toContain('旧名称')
    for (const title of ['部分汇合', '独立终点']) {
      const row = view.findAll('.task-card-steps li').find((item) => item.querySelector('strong')?.textContent === title)
      expect(row).toBeDefined()
      expect(row?.closest('details')).toBeNull()
      if (title === '部分汇合') expect(row?.textContent).toContain('汇合 · 依赖 复核（同名步骤 1）、复核（同名步骤 2）')
    }
    expect(service.calls.map(({ path }) => path)).toEqual(['/v1/tasks', '/v1/node-runs'])
  } finally { view.unmount() }
})

it.each([
  { condition: '串行', nodes: [step('a', '甲', []), step('b', '乙', ['a']), step('c', '丙', ['b'])] },
  { condition: '缺少依赖字段', nodes: [step('a', '甲', []), step('b', '乙', []), step('c', '丙')] },
  { condition: '缺少依赖端点', nodes: [step('a', '甲', []), step('b', '乙', []), step('c', '丙', ['missing'])] },
  { condition: '依赖成环', nodes: [step('a', '甲', []), step('b', '乙', []), step('c', '丙', ['c'])] },
])('在 $condition 时保留平铺步骤', async ({ nodes }) => {
  const service = createFakeService(({ path }) => path === '/v1/tasks'
    ? { ok: true, data: page([task]) } : { ok: true, data: { items: nodes } })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const view = await renderPanel(<TaskListScreen api={api} onSelectTask={() => {}} />)
  try {
    await view.click(view.container.querySelector('[aria-label="展开步骤：运行复核"]')!)
    await view.flush()
    expect(view.findAll(groupSelector)).toHaveLength(0)
    expect(view.findAll('.task-card-steps li strong').map(({ textContent }) => textContent)).toEqual(['甲', '乙', '丙'])
  } finally { view.unmount() }
})

it.each([false, true, undefined])('handles 200 records with has_more=%s', async (has_more) => {
  const nodes = Array.from({ length: 200 }, (_, index) => step(`step-${index}`, `核对 ${index}`, []))
  const service = createFakeService(({ path }) => path === '/v1/tasks'
    ? { ok: true, data: page([task]) } : { ok: true, data: { items: nodes, has_more } })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const view = await renderPanel(<TaskListScreen api={api} onSelectTask={() => {}} />)
  try {
    await view.click(view.container.querySelector('[aria-label="展开步骤：运行复核"]')!)
    await view.flush()
    expect(view.findAll(groupSelector)).toHaveLength(has_more === false ? 1 : 0)
    expect(view.findAll('.task-card-steps li strong')).toHaveLength(200)
    expect(view.text().includes('本次最多读取 200 条')).toBe(has_more !== false)
  } finally { view.unmount() }
})

it('replaces loading and failed reads without displaying another run’s topology', async () => {
  const first = deferred<FakeReply>()
  const second = deferred<FakeReply>()
  let run = task.current_run_id
  let retry = false
  const service = createFakeService(({ path, params }) => {
    if (path === '/v1/tasks') return { ok: true, data: page([{ ...task, current_run_id: run }]) }
    if (params.get('run_id') === 'board-run') return first.promise
    if (!retry) return second.promise
    return { ok: true, data: { items: [step('foreign', '错误运行的步骤', [])] } }
  })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const screen = (reloadVersion: number) => <TaskListScreen api={api} onSelectTask={() => {}} reloadVersion={reloadVersion} />
  const view = await renderPanel(screen(0))
  try {
    await view.click(view.container.querySelector('[aria-label="展开步骤：运行复核"]')!)
    expect(view.text()).toContain('正在读取步骤')
    run = 'new-run'
    await view.rerender(screen(1))
    await view.flush()
    await act(async () => first.resolve({ ok: true, data: { items: [step('a', '旧分支一', []), step('b', '旧分支二', [])] } }))
    expect(view.text()).toContain('正在读取步骤')
    expect(view.text()).not.toContain('旧分支')
    await act(async () => second.resolve({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'fixture', retryable: true } }))
    expect(view.text()).toContain('步骤读取失败')
    expect(view.findAll(groupSelector)).toHaveLength(0)
    retry = true
    await view.click(view.container.querySelector('.task-card-steps [role="alert"] button')!)
    await view.flush()
    expect(view.text()).toContain('步骤读取失败')
    expect(view.text()).not.toContain('错误运行的步骤')
  } finally { view.unmount() }
})

it('keeps a focused and open branch mounted during a same-run refresh, failure and retry', async () => {
  const first = deferred<FakeReply>()
  const second = deferred<FakeReply>()
  const nodes = [step('a', '复核甲', []), step('b', '复核乙', [])]
  let reads = 0
  const service = createFakeService(({ path }) => {
    if (path === '/v1/tasks') return { ok: true, data: page([task]) }
    reads++
    return reads === 1 ? { ok: true, data: { items: nodes } } : reads === 2 ? first.promise : second.promise
  })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const screen = (reloadVersion: number) => <TaskListScreen api={api} onSelectTask={() => {}} reloadVersion={reloadVersion} />
  const view = await renderPanel(screen(0))
  try {
    await view.click(view.container.querySelector('[aria-label="展开步骤：运行复核"]')!)
    const summary = view.container.querySelector<HTMLElement>(`${groupSelector} summary`)!
    const branch = summary.closest('details')!
    summary.focus()
    await view.click(summary)
    await view.rerender(screen(1))
    await view.flush()
    expect(view.container.querySelector(`${groupSelector} summary`)).toBe(summary)
    expect(document.activeElement).toBe(summary)
    expect(branch.open).toBe(true)
    await act(async () => first.resolve({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'fixture', retryable: true } }))
    expect(view.container.querySelector('.task-card-steps [role="alert"]')?.textContent).toContain('仍显示上次读取结果')
    expect(document.activeElement).toBe(summary)
    expect(branch.open).toBe(true)
    await view.click(view.container.querySelector('.task-card-steps [role="alert"] button')!)
    await act(async () => second.resolve({ ok: true, data: { items: [{ ...nodes[0]!, title: '已更新的复核甲' }, nodes[1]] } }))
    expect(view.container.querySelector(`${groupSelector} summary`)).toBe(summary)
    expect(branch.open).toBe(true)
    expect(branch.textContent).toContain('已更新的复核甲')
    expect(view.container.querySelector('.task-card-steps [role="alert"]')).toBeNull()
  } finally { view.unmount() }
})

it.each(['other control', 'branch'] as const)('remembers the open branch and restores focus from %s on a column move', async (focus) => {
  const nodes = [step('a', '复核甲', []), step('b', '复核乙', [])]
  let finished = false
  const service = createFakeService(({ path }) => path === '/v1/tasks'
    ? { ok: true, data: page([{ ...task, lane: finished ? 'finished' : 'running' }]) }
    : { ok: true, data: { items: nodes } })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const screen = (reloadVersion: number) => <TaskListScreen api={api} onSelectTask={() => {}} reloadVersion={reloadVersion} />
  const view = await renderPanel(screen(0))
  try {
    await view.click(view.container.querySelector('[aria-label="展开步骤：运行复核"]')!)
    const before = view.container.querySelector<HTMLElement>(`${groupSelector} summary`)!
    await view.click(before)
    await view.flush()
    const search = view.container.querySelector<HTMLElement>('#task-search')!
    const focused = focus === 'branch' ? before : search
    focused.focus()
    finished = true
    await view.rerender(screen(1))
    await view.flush()
    const group = view.container.querySelector<HTMLDetailsElement>(`[data-task-column="finished"] ${groupSelector}`)
    expect(group?.open).toBe(true)
    expect(document.activeElement).toBe(focus === 'branch' ? group?.querySelector('summary') : search)
    expect(service.calls.filter(({ path }) => path === '/v1/node-runs')).toHaveLength(2)
  } finally { view.unmount() }
})

it('keeps focus on the board when the focused card leaves the active results', async () => {
  let visible = true
  const service = createFakeService(({ path }) => path === '/v1/tasks'
    ? { ok: true, data: page(visible ? [task] : []) }
    : { ok: true, data: { items: [step('a', '复核甲', []), step('b', '复核乙', [])] } })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const screen = (reloadVersion: number) => <TaskListScreen api={api} onSelectTask={() => {}} reloadVersion={reloadVersion} />
  const view = await renderPanel(screen(0))
  try {
    await view.click(view.container.querySelector('[aria-label="展开步骤：运行复核"]')!)
    view.container.querySelector<HTMLElement>(`${groupSelector} summary`)!.focus()
    visible = false
    await view.rerender(screen(1))
    await view.flush()
    expect(view.findAll('article.task-card')).toHaveLength(0)
    expect(document.activeElement).toBe(view.container.querySelector('[aria-label="任务看板"]'))
  } finally { view.unmount() }
})
