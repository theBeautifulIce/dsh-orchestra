// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { TaskListScreen } from '../../src/client/panel/tasks-screen.tsx'
import { TaskDetailScreen } from '../../src/client/panel/task-detail-screen.tsx'
import { createFakeService, deferred, nodeRunView, page, renderPanel, runSummary, taskSummary, type FakeReply } from './harness.ts'

const names = ['销售复核', '成本核对', '库存抽样', '客户反馈', '合规检查', '交付时效', '合同抽查', '付款汇总', '异常排查', '证据整理']
const branches = names.map((title, index) => nodeRunView({
  node_id: `branch-${index + 1}`, node_run_id: `attempt-${index + 1}`, run_id: 'main-run', title, node_type: 'agent',
  status: index < 3 ? 'started' : 'queued', status_label: index < 3 ? '执行中' : '笼统排队标签',
  execution_state: index < 3 ? 'started' : 'waiting_capacity', depends_on: [], waiting_on: [],
}))
const join = nodeRunView({
  node_id: 'join', node_run_id: 'join-attempt', run_id: 'main-run', title: '汇总审核', status: 'queued',
  execution_state: 'waiting_dependencies', depends_on: branches.map(({ node_id }) => node_id),
  waiting_on: branches.map(({ node_id }) => node_id),
})
const main = taskSummary({ task_id: 'main', title: '办公核验', current_run_id: 'main-run', lane: 'running', workflow_version: 3 })
const other = taskSummary({ task_id: 'other', title: '普通任务', current_run_id: 'other-run', lane: 'upcoming' })
const outline = {
  name: '十路复核',
  nodes: [
    { node_id: 'trigger', title: '开始核验', type: 'trigger' },
    ...branches.map(({ node_id, title }, index) => ({ node_id, title, type: 'agent', position: { x: 250, y: index * 90 } })),
    { node_id: 'join', title: join.title, type: 'agent', position: { x: 520, y: 220 } },
  ],
  edges: branches.flatMap(({ node_id }) => [{ from: 'trigger', to: node_id }, { from: node_id, to: 'join' }]),
}

it('expands one card lazily and refreshes ten named steps without duplicating old attempts or tasks', async () => {
  let nodes = branches
  const service = createFakeService(({ path, params }) => {
    if (path === '/v1/tasks') return { ok: true, data: page([main, other, main]) }
    if (path === '/v1/node-runs' && params.get('run_id') === main.current_run_id) return { ok: true, data: { items: nodes } }
    throw new Error(path)
  })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const select = vi.fn()
  const screen = (reloadVersion: number) => <TaskListScreen api={api} onSelectTask={select} reloadVersion={reloadVersion} />
  const view = await renderPanel(screen(0))
  try {
    await view.flush()
    expect(view.findAll('article.task-card')).toHaveLength(2)
    expect(service.calls.filter(({ path }) => path === '/v1/node-runs')).toEqual([])
    const expand = view.container.querySelector<HTMLButtonElement>('button[aria-label="展开步骤：办公核验"]')!
    expand.focus()
    expect(document.activeElement).toBe(expand)
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    await view.click(expand)
    const shown = document.getElementById(expand.getAttribute('aria-controls')!)!
    expect(expand.getAttribute('aria-expanded')).toBe('true')
    expect(shown.hidden).toBe(false)
    expect(view.findAll('.task-card-steps li strong').map(({ textContent }) => textContent)).toEqual(names)
    expect(shown.querySelectorAll('li[data-tone="active"]')).toHaveLength(3)
    expect([...shown.querySelectorAll('li')].filter((item) => item.textContent?.includes('等待执行位'))).toHaveLength(7)
    expect(service.calls.filter(({ path }) => path === '/v1/node-runs').map(({ params }) => params.get('run_id'))).toEqual(['main-run'])
    expect(select).not.toHaveBeenCalled()

    const replacement = { ...branches[0]!, node_run_id: 'retry-attempt', attempt: 2, status: 'queued', execution_state: 'ready' }
    nodes = [{ ...branches[0]!, title: '旧执行名称', status: 'failed', replacement_node_run_id: replacement.node_run_id }, replacement, ...branches.slice(1)]
    await view.rerender(screen(1))
    await view.flush()
    expect(view.findAll('.task-card-steps li strong').map(({ textContent }) => textContent)).toEqual(names)
    expect(shown.textContent).toContain('就绪待派发')
    expect(shown.textContent).toContain('第 2 次尝试')
    expect(shown.textContent).not.toContain('旧执行名称')
    expect(service.calls.filter(({ path }) => path === '/v1/node-runs')).toHaveLength(2)
    await view.click(expand)
    expect(shown.hidden).toBe(true)
    expect(view.findAll('.task-card-steps li')).toHaveLength(0)
    const ordinary = view.findAll('article.task-card h3 button').find((item) => item.textContent === other.title)
    await view.click(ordinary!)
    expect(select).toHaveBeenCalledWith('other', ordinary)
  } finally { view.unmount() }
})

it('shows the real ten-way fan-out, join, and live queue with one selected run read per view', async () => {
  const unavailable = deferred<FakeReply>()
  const service = createFakeService(({ path, params }) => {
    if (path === '/v1/tasks') return { ok: true, data: page([main, other]) }
    if (path === '/v1/runs/get') return { ok: true, data: runSummary({ task_id: main.task_id, run_id: 'main-run', workflow_version: 2 }) }
    if (path === '/v1/workflows/versions/get') return { ok: true, data: { definition: outline } }
    if (path === '/v1/node-runs') return params.get('run_id') === 'other-run' ? unavailable.promise
      : { ok: true, data: { items: [...branches, join,
        nodeRunView({ run_id: 'main-run', node_run_id: 'paused', node_id: 'paused', title: '暂停步骤', status: 'queued', execution_state: 'paused', attempt: 2 }),
        nodeRunView({ run_id: 'main-run', node_run_id: 'ready', node_id: 'ready', title: '准备就绪', status: 'queued', execution_state: 'ready' }),
        nodeRunView({ run_id: 'main-run', node_run_id: 'legacy', node_id: 'legacy', title: '旧版记录', status: 'queued' }),
      ] } }
    throw new Error(path)
  })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const view = await renderPanel(<TaskListScreen api={api} onSelectTask={() => {}} />)
  const button = (label: string) => view.findAll('button').find((item) => item.textContent === label)!
  try {
    await view.flush()
    await view.click(button('流程'))
    await view.flush()
    const graph = view.container.querySelector('[aria-label="流程步骤依赖"]')!
    expect(graph.textContent).toContain('同层 10 步')
    expect(graph.textContent).toContain('分支至 ' + names.join('、'))
    expect(graph.textContent).toContain('汇合，依赖 ' + names.join('、'))
    expect(view.findAll('line[data-edge-to="join"]')).toHaveLength(10)
    expect(service.calls.find(({ path }) => path === '/v1/workflows/versions/get')?.params.get('version')).toBe('2')
    expect(service.calls.filter(({ path }) => path === '/v1/node-runs')).toHaveLength(1)

    await view.click(button('队列'))
    await view.flush()
    const queue = (label: string) => view.container.querySelector(`[aria-label="任务队列"] section[aria-label="${label}"]`)!
    expect(queue('进行中').querySelectorAll('li')).toHaveLength(3)
    expect(queue('等待执行位').querySelectorAll('li')).toHaveLength(7)
    expect(queue('等待上游完成').textContent).toContain('汇总审核')
    expect(queue('等待上游完成').textContent).toContain('等待：' + names.join('、'))
    expect(queue('就绪待派发').textContent).toContain('准备就绪')
    expect(queue('暂停、重试与异常').textContent).toContain('第 2 次尝试')
    expect(queue('暂停、重试与异常').textContent).toContain('排队原因未记录')
    expect(view.text()).not.toContain('笼统排队标签')
    expect(service.calls.filter(({ path }) => path === '/v1/node-runs').map(({ params }) => params.get('run_id'))).toEqual(['main-run', 'main-run'])
    expect(service.calls.filter(({ path }) => path === '/v1/runs/get')).toHaveLength(1)

    await view.click(view.findAll('nav[aria-label="选择任务查看队列"] button')[1]!)
    expect(view.text()).toContain('正在读取队列')
    expect(view.text()).not.toContain('汇总审核')
    await act(async () => unavailable.resolve({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'fixture', retryable: true } }))
    expect(view.byRole('alert')[0]?.textContent).toContain('队列读取失败')
    expect(view.text()).not.toContain('暂无步骤记录')
    expect(service.calls.filter(({ path }) => path === '/v1/node-runs').map(({ params }) => params.get('run_id')))
      .toEqual(['main-run', 'main-run', 'other-run'])
  } finally { view.unmount() }
})

it('keeps an older directly opened run mounted while refreshing its details', async () => {
  const run = runSummary({ task_id: main.task_id, run_id: 'older', project_context: {
    version: 'a'.repeat(64), as_of_seq: 9, sources: [{ path: 'README.md', status: 'available' }],
  } })
  const pending = deferred<FakeReply>()
  let refresh = false
  const service = createFakeService(({ path }) => {
    if (path === '/v1/tasks/get') return { ok: true, data: main }
    if (path === '/v1/runs/get') return refresh ? pending.promise : { ok: true, data: run }
    return { ok: true, data: page([]) }
  })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const screen = (reloadVersion: number) =>
    <TaskDetailScreen api={api} taskId={main.task_id} initialRunId="older" onBack={() => {}} reloadVersion={reloadVersion} />
  const view = await renderPanel(screen(0))
  try {
    await view.flush()
    const project = () => view.findAll('summary').find((el) => el.textContent?.startsWith('本次派单的项目资料'))?.closest('details')
    await view.click(project()!.querySelector('summary')!)
    refresh = true
    await view.rerender(screen(1))
    expect(project()?.open).toBe(true)
    await act(async () => pending.resolve({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'fixture', retryable: true } }))
    expect(project()?.open).toBe(true)
    expect(view.byRole('alert')).not.toHaveLength(0)
  } finally { view.unmount() }
})

it('rechecks the selected run after refresh until its project sources are fixed, without losing model evidence', async () => {
  const run = runSummary({ task_id: main.task_id, run_id: 'main-run' })
  let pinned = false
  const service = createFakeService(({ path }) => {
    if (path === '/v1/tasks/get') return { ok: true, data: main }
    if (path === '/v1/runs') return { ok: true, data: page([run, runSummary({ task_id: main.task_id, run_id: 'other-run' })]) }
    if (path === '/v1/runs/get') return { ok: true, data: !pinned ? run : { ...run, project_context: {
      version: 'a123456789ab' + 'c'.repeat(52), as_of_seq: 42,
      sources: [
        { path: 'ORCHESTRA.md', status: 'missing' },
        { path: 'README.md', status: 'available', truncated: true, sha256_scope: 'excerpt', sha256: 'd'.repeat(64) },
        { path: '.', status: 'excluded', truncated: true },
      ],
    } } }
    if (path === '/v1/node-runs') return { ok: true, data: { items: [{
      ...branches[0],
      model_assignment: { state: 'confirmed', model_ref: 'test/model', reason: '需要独立重算', complexity: 'complex',
        reasoning_effort: 'high', settings_revision: 2,
        usage: { provider: 'test', model: 'model', observed_request_headers: 1, reasoning_effort: 'medium' } },
    }] } }
    return { ok: true, data: page([]) }
  })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const screen = (reloadVersion: number, source = api) =>
    <TaskDetailScreen api={source} taskId={main.task_id} onBack={() => {}} reloadVersion={reloadVersion} />
  const view = await renderPanel(screen(0))
  try {
    await view.flush()
    expect(view.text()).not.toContain('本次派单的项目资料')
    expect(service.calls.filter(({ path }) => path === '/v1/runs/get')).toEqual([])
    await view.click(view.findAll('button').find((item) => item.textContent === '完整运行')!)
    expect(view.text()).not.toContain('本次派单的项目资料')
    expect(view.text()).toContain('派发思考深度 · high')
    expect(service.calls.filter(({ path }) => path === '/v1/runs/get')).toHaveLength(1)
    pinned = true
    await view.rerender(screen(1))
    await view.flush()
    expect(view.text()).toContain('实际请求思考深度 · medium')
    const project = view.findAll('summary').find((node) => node.textContent?.startsWith('本次派单的项目资料'))!
    expect(project.textContent).toBe('本次派单的项目资料 · 已读取 1 项')
    expect(project.closest('details')?.open).toBe(false)
    await view.click(project)
    const disclosure = view.findAll('summary').find((node) => node.textContent === '查看项目资料记录明细')!
    expect(disclosure.closest('details')?.open).toBe(false)
    expect(project.closest('details')!.textContent).toContain('ORCHESTRA.md · 可选项目说明，未提供')
    expect(project.closest('details')!.textContent).toContain('README.md · 已读取 · 已截断')
    expect(project.closest('details')!.textContent).toContain('工作区目录索引 · 未纳入 · 超出读取范围')
    await view.click(disclosure)
    const expanded = disclosure.closest('details')!
    expect(expanded.open).toBe(true)
    expect(expanded.textContent).toContain('账本位置 42')
    expect(expanded.textContent).toContain('读取的片段')
    expect(expanded.querySelectorAll('code')).toHaveLength(2)
    await view.click(view.findAll('button').find((item) => item.textContent === '证据')!)
    await view.rerender(screen(2))
    await view.flush()
    expect(view.text()).toContain('本次派单的项目资料')
    expect(service.calls.filter(({ path }) => path === '/v1/runs/get').map(({ params }) => params.get('run_id')))
      .toEqual(['main-run', 'main-run', 'main-run'])

    const replacement = createFakeService(({ path }) => ({ ok: true, data: path === '/v1/tasks/get' ? main : page([run]) }))
    const replacementApi = createResourcesApi(createApiClient('http://another-source.test', replacement.fetcher))
    await view.rerender(screen(2, replacementApi))
    expect(view.text()).not.toContain('a123456789ab')
    expect(replacement.calls.filter(({ path }) => path === '/v1/runs/get')).toEqual([])
  } finally { view.unmount() }
})
