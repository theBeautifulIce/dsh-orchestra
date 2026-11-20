// @vitest-environment jsdom
// WP-A：面板侧 G5 门禁的断言用例。用例名以门禁 id 开头，方便逐条复跑。
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi, type ResourcesApi } from '../../src/client/api/resources.ts'
import { COPY } from '../../src/client/panel/copy.ts'
import { TaskDetailScreen } from '../../src/client/panel/task-detail-screen.tsx'
import { TaskListScreen } from '../../src/client/panel/tasks-screen.tsx'
import { COLOR } from '../../src/client/panel/tokens.ts'
import { NODE_STATUS_LABELS } from '../fixtures/node-status-labels.ts'
import {
  createFakeService,
  nodeRunView,
  page,
  renderPanel,
  runSummary,
  taskSummary,
  type FakeQuery,
  type FakeReply,
  type FakeService,
} from './harness.ts'

const noop = () => {}

function apiFrom(handler: (query: FakeQuery) => FakeReply | Promise<FakeReply>): { api: ResourcesApi; service: FakeService } {
  const service = createFakeService(handler)
  return { api: createResourcesApi(createApiClient('http://panel.test', service.fetcher)), service }
}

/** 浏览器会把颜色归一化成 rgb()，比较前先做同样的归一化。 */
function expectedColor(token: string): string {
  const probe = document.createElement('div')
  probe.style.color = token
  return probe.style.color
}

function colorOf(element: Element | undefined | null): string {
  return element ? (element as HTMLElement).style.color : ''
}

function spanWithText(view: { findAll: (selector: string) => Element[] }, text: string): Element | undefined {
  return view.findAll('span').find((element) => element.textContent === text)
}

function hasSpanWithText(view: { findAll: (selector: string) => Element[] }, text: string): boolean {
  return view.findAll('span').some((element) => element.textContent === text)
}

describe('WP-A 面板侧 G5 门禁', () => {
  it('Q-02 分页途中插入新任务时按 task_id 去重，后页覆盖前页', async () => {
    const first = taskSummary({ task_id: 't1', title: '任务一', status: 'running', display_status: 'running' })
    const staleSecond = taskSummary({ task_id: 't2', title: '任务二（旧）', status: 'running', display_status: 'running' })
    const freshSecond = taskSummary({ task_id: 't2', title: '任务二（已更新）', status: 'succeeded', display_status: 'succeeded', attention: 'none' })
    const third = taskSummary({ task_id: 't3', title: '任务三', status: 'running', display_status: 'running' })
    const { api } = apiFrom((query) => {
      const cursor = query.params.get('cursor')
      return { ok: true, data: cursor ? page([freshSecond, third]) : page([first, staleSecond], 'cursor-2') }
    })
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()
    expect(view.findAll('article').length).toBe(2)

    const loadMore = view.findAll('button').find((button) => button.textContent === '加载更多')
    expect(loadMore).toBeTruthy()
    await view.click(loadMore as Element)
    await view.flush()

    const rows = view.findAll('article')
    expect(rows.length).toBe(3)
    // 同 task_id 不重复。后页提供的终态会把任务移到最近完成，运行列中的其他任务仍保持顺序。
    expect(rows.map((row) => row.textContent ?? '').filter((text) => text.includes('任务二')).length).toBe(1)
    expect(view.text()).toContain('任务二（已更新）')
    expect(view.text()).not.toContain('任务二（旧）')
    expect(view.findAll('[data-task-column="running"] article h3').map((row) => row.textContent)).toEqual(['任务一', '任务三'])
    expect(view.findAll('[data-task-column="finished"] article h3').map((row) => row.textContent)).toEqual(['任务二（已更新）'])
    view.unmount()
  })

  it('Q-05 succeeded_with_unverified 在面板是独立黄色状态并带未验证数量', async () => {
    const { api } = apiFrom(() => ({
      ok: true,
      data: page([taskSummary({
        status: 'succeeded_with_unverified',
        display_status: 'succeeded_with_unverified',
        unverified_count: 3,
        attention: 'unverified',
        attention_reason: '有 3 笔副作用待核实',
      })]),
    }))
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()

    const label = spanWithText(view, COPY.succeededWithUnverified)
    expect(label).toBeDefined()
    // 独立状态：自己的中文文案 + 黄色（COLOR.warning），不折叠进「已完成」。
    expect(hasSpanWithText(view, '已完成')).toBe(false)
    expect(colorOf(label)).toBe(expectedColor(COLOR.warning))
    const badge = spanWithText(view, `3 ${COPY.unverifiedBadge}`)
    expect(badge).toBeDefined()
    expect(colorOf(badge)).toBe(expectedColor(COLOR.warning))
    view.unmount()
  })

  it('Q-06 failed_with_unverified 深红显示并带未验证角标', async () => {
    const { api } = apiFrom(() => ({
      ok: true,
      data: page([taskSummary({
        status: 'failed_with_unverified',
        display_status: 'failed_with_unverified',
        unverified_count: 2,
        attention: 'failed',
        attention_reason: '最近一次运行未成功',
      })]),
    }))
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()

    const label = spanWithText(view, COPY.failedWithUnverified)
    expect(label).toBeDefined()
    // 深红（COLOR.danger），不折叠进「未成功」。
    expect(colorOf(label)).toBe(expectedColor(COLOR.danger))
    const badge = spanWithText(view, `2 ${COPY.unverifiedBadge}`)
    expect(badge).toBeDefined()
    expect(colorOf(badge)).toBe(expectedColor(COLOR.danger))
    expect(hasSpanWithText(view, '未成功')).toBe(false)
    view.unmount()
  })

  it('Q-07 blocked 且 settling 时同时显示「等你决定」与「仍有未结算不可逆动作」', async () => {
    const task = taskSummary({
      status: 'running',
      display_status: 'running',
      open_decision_count: 2,
      unverified_count: 3,
      attention: 'decision',
      attention_reason: '有 2 个决定等你处理',
    })
    const run = runSummary({ run_id: 'r1', status: 'blocked_pre', display_status: 'blocked', settling: true, total: 2 })
    const { api } = apiFrom((query) => {
      if (query.path === '/v1/tasks/get') return { ok: true, data: task }
      if (query.path === '/v1/runs') return { ok: true, data: { items: [run] } }
      if (query.path === '/v1/node-runs') {
        return { ok: true, data: { items: [nodeRunView({ status: 'blocked_pre', status_label: '执行前被挡住，等人处理', active_decision_ids: ['d1'] })] } }
      }
      return { ok: true, data: {} }
    })
    const view = await renderPanel(<TaskDetailScreen api={api} taskId="t1" onBack={noop} />)
    await view.flush()

    // blocked 与 settling 都还在屏上。
    expect(view.text()).toContain('blocked')
    expect(view.text()).toContain('正在收尾')
    // 两条提醒同时出现，不只显示 blocked。
    expect(view.text()).toContain(COPY.awaitingDecision)
    expect(view.text()).toContain(COPY.pendingIrreversible)
    view.unmount()
  })

  it('Q-19 心跳超 30 秒显示「心跳已停 X 秒」，节点状态保持原值', async () => {
    const staleHeartbeat = new Date(Date.now() - 45_000).toISOString()
    const task = taskSummary({ status: 'running', display_status: 'running' })
    const run = runSummary({ run_id: 'r1', status: 'running', display_status: 'running', total: 1 })
    const { api } = apiFrom((query) => {
      if (query.path === '/v1/tasks/get') return { ok: true, data: task }
      if (query.path === '/v1/runs') return { ok: true, data: { items: [run] } }
      if (query.path === '/v1/node-runs') {
        return { ok: true, data: { items: [nodeRunView({ status: 'started', status_label: '已开跑，等回写', heartbeat_at: staleHeartbeat })] } }
      }
      return { ok: true, data: {} }
    })
    const view = await renderPanel(<TaskDetailScreen api={api} taskId="t1" onBack={noop} />)
    await view.flush()

    await view.click(view.findAll('button').find((button) => button.textContent === '完整运行')!)
    await view.flush()
    const notice = /心跳已停 (\d+) 秒/.exec(view.text())
    expect(notice).not.toBeNull()
    const seconds = Number(notice?.[1] ?? '0')
    expect(seconds).toBeGreaterThanOrEqual(45)
    expect(seconds).toBeLessThan(60)
    // 只影响显示：节点状态文字一个字不改，也不自行改成 failed / orphaned。
    expect(view.text()).toContain('已开跑，等回写')
    expect(view.text()).not.toContain('没做成')
    expect(view.text()).not.toContain('没有新 attempt 接手')
    view.unmount()

    // 心跳还新鲜时不提示。
    const freshHeartbeat = new Date(Date.now() - 5_000).toISOString()
    const fresh = apiFrom((query) => {
      if (query.path === '/v1/tasks/get') return { ok: true, data: task }
      if (query.path === '/v1/runs') return { ok: true, data: { items: [run] } }
      if (query.path === '/v1/node-runs') {
        return { ok: true, data: { items: [nodeRunView({ status: 'started', status_label: '已开跑，等回写', heartbeat_at: freshHeartbeat })] } }
      }
      return { ok: true, data: {} }
    })
    const freshView = await renderPanel(<TaskDetailScreen api={fresh.api} taskId="t1" onBack={noop} />)
    await freshView.flush()
    await freshView.click(freshView.findAll('button').find((button) => button.textContent === '完整运行')!)
    await freshView.flush()
    expect(freshView.text()).not.toContain('心跳已停')
    freshView.unmount()
  })

  it('Q-23 任务标题里的 HTML 按纯文本显示', async () => {
    const rawTitle = '<img src=x onerror="alert(1)"><b>粗体</b><script>alert(2)</script>'
    const { api } = apiFrom(() => ({ ok: true, data: page([taskSummary({ title: rawTitle })]) }))
    const view = await renderPanel(<TaskListScreen api={api} onSelectTask={noop} />)
    await view.flush()

    // 没有生成任何 img / script 元素。
    expect(view.findAll('img').length).toBe(0)
    expect(view.findAll('script').length).toBe(0)
    expect(view.container.innerHTML).not.toContain('<img')
    expect(view.container.innerHTML).not.toContain('<script')
    // 标题按纯文本呈现。
    expect(view.text()).toContain(rawTitle)
    const title = view.findAll('button').find((button) => button.textContent === rawTitle)
    expect(title).toBeDefined()
    expect(title?.getAttribute('title')).toBe(rawTitle)
    view.unmount()
  })

  it('Q-31 完整运行逐行显示 20 种节点状态文案，并保留运行状态文案', async () => {
    const task = taskSummary({ current_run_id: 'r1', status: 'running', display_status: 'running', run_count: 3 })
    const run = runSummary({ run_id: 'r1', status: 'running', display_status: 'running', total: NODE_STATUS_LABELS.length })
    const succeeded = runSummary({ run_id: 'r2', status: 'succeeded', display_status: 'succeeded' })
    const failed = runSummary({ run_id: 'r3', status: 'failed', display_status: 'failed' })
    const nodes = NODE_STATUS_LABELS.map(({ status, status_label }) =>
      nodeRunView({ node_run_id: 'nr-' + status, node_id: 'node-' + status, title: '步骤 ' + status, status, status_label }),
    )
    const { api } = apiFrom((query) => {
      if (query.path === '/v1/tasks/get') return { ok: true, data: task }
      if (query.path === '/v1/runs') return { ok: true, data: { items: [run, succeeded, failed] } }
      if (query.path === '/v1/node-runs') return { ok: true, data: { items: nodes } }
      return { ok: true, data: {} }
    })
    const view = await renderPanel(<TaskDetailScreen api={api} taskId="t1" onBack={noop} />)
    await view.flush()
    await view.click(view.findAll('button').find((button) => button.textContent === '完整运行')!)
    await view.flush()

    const heading = view.findAll('h3').find((element) => element.textContent === '执行步骤 · 20')
    const steps = heading?.closest('section')
    expect([...view.container.querySelectorAll('.task-inspector-badges span')].some((badge) => badge.textContent === '进行中')).toBe(true)
    const rows = [...(steps?.querySelectorAll('.task-flow-step') ?? [])]
    expect(rows.map((row) => [row.querySelector('strong')?.textContent, row.querySelector('.task-flow-step-result')?.textContent]))
      .toEqual(NODE_STATUS_LABELS.map(({ status, status_label }) => ['步骤 ' + status, status_label]))
    expect(new Set(rows.map((row) => row.querySelector('.task-flow-step-result')?.textContent)).size).toBe(20)
    await view.click(view.findAll('button').find((button) => button.textContent === '返回任务')!)
    await view.click(view.findAll('button').find((button) => button.textContent === '运行 · 3')!)
    expect(view.findAll('.task-run-history button > span:nth-child(2)').map((element) => element.textContent))
      .toEqual(['进行中', '已完成', '未成功'])
    view.unmount()
  })
})
