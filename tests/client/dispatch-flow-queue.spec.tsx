// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { TaskFlowView } from '../../src/client/panel/task-flow-view.tsx'
import { createFakeService, deferred, nodeRunView, renderPanel, runSummary, taskSummary, type FakeReply } from './harness.ts'

type Edge = { from: string; to: string }
const nodeNames: Record<string, string> = {
  start: '启动检查', fork: '分派核对', orders: '核对订单', totals: '核对总额', inventory: '核对库存',
  second: '分派库存复核', actual: '抽查实物', records: '比对库存台账', join: '合并订单与总额',
  approval: '审核合并稿', filing: '单独归档库存', notify: '通知仓库', obsolete: '重做库存汇总',
}
const from = (source: string, ...targets: string[]): Edge[] => targets.map((to) => ({ from: source, to }))
const canvas = '[data-canvas-id="task-run-flow"]'
const graph = '[aria-label="流程步骤依赖"]'

it.each([
  {
    name: '两路任务专属流程', workflowId: 'task_orders', scope: 'task_local', layered: [['start'], ['orders', 'totals'], ['join']],
    edges: [...from('start', 'orders', 'totals'), ...from('orders', 'join'), ...from('totals', 'join')],
  },
  {
    name: '三路可复用流程', workflowId: 'shared_review', scope: 'reusable', layered: [['start'], ['fork'], ['orders', 'totals', 'inventory'], ['join']],
    edges: [...from('start', 'fork'), ...from('fork', 'orders', 'totals', 'inventory'), ...from('orders', 'join'), ...from('totals', 'join'), ...from('inventory', 'join')],
  },
  {
    name: '部分汇合、二次分叉、串行后继与独立终点', workflowId: 'task_stock', scope: 'task_local',
    layered: [['start'], ['orders', 'totals', 'inventory', 'filing', 'notify'], ['join', 'second'], ['approval', 'actual', 'records']],
    edges: [
      ...from('start', 'orders', 'totals', 'inventory', 'filing', 'notify'),
      ...from('orders', 'join'), ...from('totals', 'join'), ...from('join', 'approval'),
      ...from('inventory', 'second'), ...from('second', 'actual', 'records'),
    ],
  },
])('renders the pinned DAG with separated cards for $name', async ({ name, workflowId, scope, layered, edges }) => {
  const authored = scope === 'reusable'
  const nodeIds = layered.flat()
  const definition = { name, scope, nodes: layered.flatMap((layer, col) => layer.map((node_id, row) => ({
    node_id, title: nodeNames[node_id], type: node_id === 'start' ? 'trigger' : ['fork', 'second'].includes(node_id) ? 'parallel' : 'agent',
    position: authored ? { x: 12 + col * 255, y: 35 + row * 95 } : { x: 100 * nodeIds.indexOf(node_id), y: 0 },
  }))), edges }
  const shared = taskSummary({ workflow_id: 'next_workflow', workflow_version: 9 })
  const service = createFakeService(({ path }) => {
    if (path === '/v1/runs/get') return { ok: true, data: runSummary({ workflow_id: workflowId, workflow_version: 2 }) }
    if (path === '/v1/workflows/versions/get') return { ok: true, data: { workflow_id: workflowId, version: 2, definition } }
    if (path === '/v1/node-runs') return { ok: true, data: { items: [] } }
    throw new Error(path)
  })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const view = await renderPanel(<TaskFlowView api={api} tasks={[shared]} onOpenTask={() => {}} reloadVersion={0} />)
  try {
    await view.flush()
    await view.click(view.findAll('.task-flow-graph summary')[0]!)
    const node = (id: string) => view.container.querySelector<HTMLElement>(`${canvas} [data-node-id="${id}"]`)!
    const coord = (id: string, axis: 'x' | 'y') => Number(node(id).getAttribute(`data-node-${axis}`))
    expect(view.findAll(`${canvas} [data-edge-from]`).map((line) =>
      [line.getAttribute('data-edge-from'), line.getAttribute('data-edge-to')])).toEqual(edges.map(({ from, to }) => [from, to]))
    const groups = view.findAll(`${graph} ol > li`)
    expect(groups.map((group) => [...group.querySelectorAll('strong')].map((title) => title.textContent)))
      .toEqual(layered.map((layer) => layer.map((id) => nodeNames[id])))
    for (const layer of layered) {
      expect(new Set(layer.map((id) => coord(id, 'x'))).size).toBe(1)
      layer.slice(1).forEach((id, row) => expect(coord(id, 'y') - coord(layer[row]!, 'y')).toBeGreaterThanOrEqual(56))
    }
    for (const { from, to } of edges) expect(coord(to, 'x') - coord(from, 'x')).toBeGreaterThanOrEqual(160)
    expect(view.container.querySelector(graph)?.textContent).toContain('汇合，依赖 ' + edges.filter((e) => e.to === 'join').map((e) => nodeNames[e.from]).join('、'))
    expect(view.findAll(`${graph} li > small`).filter((item) => item.textContent === '流程终点').map((item) =>
      item.parentElement?.querySelector('strong')?.textContent)).toEqual(nodeIds.filter((id) => !edges.some((edge) => edge.from === id))
      .map((id) => nodeNames[id]))
    if (authored) {
      expect(coord('start', 'x')).toBe(12)
      expect(coord('orders', 'y')).toBe(35)
    }
    const versionQuery = service.calls.find(({ path }) => path === '/v1/workflows/versions/get')!.params
    expect([versionQuery.get('workflow_id'), versionQuery.get('version')]).toEqual([workflowId, '2'])
    expect(definition.nodes[0]?.position).toEqual(authored ? { x: 12, y: 35 } : { x: 0, y: 0 })
  } finally { view.unmount() }
})

it('keeps capacity, dependency waits, upstream failure and unknown queue reasons distinct across run changes', async () => {
  const stale = deferred<FakeReply>()
  const latest = deferred<FakeReply>()
  const task = taskSummary({ title: '采购核对' })
  const row = (node_id: string, state: string, overrides?: Parameters<typeof nodeRunView>[0]) => nodeRunView({
    node_id, node_run_id: node_id, title: nodeNames[node_id], status: 'queued', execution_state: state, ...overrides,
  })
  const initial = [
    row('orders', 'started', { status: 'started' }),
    row('totals', 'waiting_capacity', { node_run_id: 'totals-2', attempt: 2 }),
    row('totals', 'failed', { title: '旧的总额尝试', status: 'failed', replacement_node_run_id: 'totals-2' }),
    row('inventory', 'blocked_post', { status: 'blocked_post' }),
    row('records', 'failed', { status: 'failed', status_label: '核查失败' }),
    row('join', 'waiting_dependencies', { depends_on: ['orders', 'inventory'], waiting_on: ['orders', 'inventory'] }),
    row('approval', 'blocked_dependencies', { depends_on: ['join', 'records'], waiting_on: ['records'] }),
    row('filing', 'queued_unknown'),
    row('obsolete', 'cancelled', { status: 'superseded', status_label: '已被新 attempt 取代' }),
  ]
  let reread = false
  const service = createFakeService(({ path, params }) => {
    if (path !== '/v1/node-runs') throw new Error(path)
    if (params.get('run_id') === 'r2') return latest.promise
    return reread ? stale.promise : { ok: true, data: { items: initial } }
  })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const render = (runId: string, reloadVersion: number) => <TaskFlowView api={api} tasks={[{ ...task, current_run_id: runId }]}
    onOpenTask={() => {}} reloadVersion={reloadVersion} queue />
  const view = await renderPanel(render('r1', 0))
  const queue = (group: string) => view.container.querySelector(`[aria-label="任务队列"] section[aria-label="${group}"]`)
  try {
    await view.flush()
    expect(queue('等待执行位')?.querySelectorAll('li strong')).toHaveLength(1)
    expect(queue('等待执行位')?.textContent).toContain('核对总额第 2 次尝试')
    expect(queue('等待上游完成')?.querySelectorAll('li')).toHaveLength(1)
    expect(queue('等待上游完成')?.textContent).toContain('等待：核对订单、核对库存')
    const attention = queue('暂停、重试与异常')!
    expect(attention.querySelectorAll('li[data-tone="blocked"]')).toHaveLength(2)
    expect(attention.textContent).toContain('审核合并稿上游失败，步骤受阻上游未成功：比对库存台账')
    expect(attention.textContent).toContain('单独归档库存排队原因未知')
    expect(queue('已结束')?.textContent).toContain('重做库存汇总已取消')
    expect(view.text()).not.toContain('旧的总额尝试')

    reread = true
    await view.rerender(render('r1', 1))
    await view.rerender(render('r2', 1))
    expect(view.text()).toContain('正在读取队列')
    expect(view.text()).not.toContain('核对总额')
    await act(async () => latest.resolve({ ok: true, data: { items: [
      row('notify', 'ready', { run_id: 'r2' }),
    ], has_more: true } }))
    await act(async () => stale.resolve({ ok: true, data: { items: initial } }))
    expect(queue('就绪待派发')?.textContent).toContain('通知仓库')
    expect(view.text()).toContain('可能还有步骤或较新的尝试未显示')
    expect(view.text()).not.toContain('核对总额')
    expect(service.calls.map(({ params }) => params.get('run_id'))).toEqual(['r1', 'r1', 'r2'])
  } finally { view.unmount() }
})

it('keeps the flow pinned to the selected run through mismatched and partial responses', async () => {
  const nextRun = deferred<FakeReply>()
  const activeTask = taskSummary()
  let attempts = 0
  const service = createFakeService(({ path, params }) => {
    if (path === '/v1/runs/get') {
      if (params.get('run_id') === 'r1') return { ok: true, data: runSummary() }
      attempts++
      return attempts === 1 ? nextRun.promise : { ok: true, data: runSummary({ run_id: 'r2', workflow_id: 'wf2', workflow_version: 2 }) }
    }
    if (path === '/v1/workflows/versions/get') {
      const second = params.get('workflow_id') === 'wf2'
      return { ok: true, data: { definition: {
        name: second ? '第二次运行流程' : '第一次运行流程',
        nodes: [{ node_id: 'start', title: '开始', type: 'trigger' },
          { node_id: 'intake', title: '接收资料', type: 'agent' },
          { node_id: 'step', title: second ? '第二次运行步骤' : '第一次运行步骤', type: 'agent' }],
        edges: [...from('start', 'intake'), ...from('intake', 'step')],
      } } }
    }
    if (path === '/v1/node-runs') {
      const run_id = params.get('run_id')!
      return { ok: true, data: { items: [nodeRunView({ run_id, node_id: 'intake', title: '接收资料' })], has_more: run_id === 'r2' } }
    }
    throw new Error(path)
  })
  const api = createResourcesApi(createApiClient('http://panel.test', service.fetcher))
  const flow = (runId: string) => <TaskFlowView api={api} tasks={[{ ...activeTask, current_run_id: runId }]}
    onOpenTask={() => {}} reloadVersion={0} />
  const view = await renderPanel(flow('r1'))
  try {
    await view.flush()
    expect(view.text()).toContain('第一次运行流程')
    await view.rerender(flow('r2'))
    expect(view.text()).not.toContain('第一次运行流程')
    await act(async () => nextRun.resolve({ ok: true, data: runSummary() }))
    expect(view.byRole('alert')[0]?.textContent).toContain('运行信息读取失败')
    expect(view.findAll(canvas)).toHaveLength(0)
    await view.click(view.byRole('alert')[0]!.querySelector('button')!)
    await view.flush()
    expect(view.text()).toContain('第二次运行流程')
    expect(view.text()).toContain('部分步骤或较新的尝试未显示')
    expect(view.container.querySelector(`${canvas} [data-node-id="step"]`)?.textContent).toContain('执行状态暂不可用')
    expect(service.calls.filter(({ path }) => path === '/v1/workflows/versions/get').map(({ params }) =>
      [params.get('workflow_id'), params.get('version')])).toEqual([['wf1', '1'], ['wf2', '2']])
  } finally { view.unmount() }
})
