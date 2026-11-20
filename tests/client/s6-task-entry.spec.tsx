// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { createTaskCommands } from '../../src/client/api/task-commands.ts'
import { CollaborationScreen } from '../../src/client/panel/collaboration-screen.tsx'
import { PanelApp } from '../../src/client/panel/app.tsx'
import { TaskStartForm } from '../../src/client/panel/task-start-form.tsx'
import { TaskPlanForm } from '../../src/client/panel/task-plan-form.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { createFakeService, deferred, nodeRunView, page, renderPanel, runSummary, workflowItem, type FakeReply } from './harness.ts'

async function change(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

it('explains three approval modes and submits the selected mode separately from collaboration', async () => {
  const service = createFakeService(() => ({ ok: true, data: page([workflowItem()]) }))
  const client = createApiClient('http://panel.test', service.fetcher)
  const start = vi.fn().mockResolvedValue({ task_id: 'new-task', run_id: 'new-run' })
  const view = await renderPanel(<PanelShell activeRoute="tasks" serviceConnected onNavigate={() => {}}>
    <TaskStartForm api={createResourcesApi(client)} commands={{ ...createTaskCommands(client), start }} onCreated={() => {}}
      collaborationEnabled />
  </PanelShell>)
  try {
    await view.flush()
    const select = view.container.querySelector<HTMLSelectElement>('select[aria-describedby]')!
    const help = view.container.querySelector<HTMLElement>(`[id="${select.getAttribute('aria-describedby')}"]`)!
    expect(select.value).toBe('autonomous')
    expect(help.textContent).toContain('只有必须人工处理或你点名的事项')
    await change(select, 'supervised')
    expect(help.textContent).toContain('超时仍等待获授权的处理')
    await change(select, 'assisted')
    expect(help.textContent).toContain('普通决定也会进入')
    expect(help.textContent).toContain('超时按默认规则处理')
    expect(help.textContent).not.toContain('协作核验')
    expect(view.text()).toContain('两个步骤互相检查')
    await change(view.container.querySelector('input')!, '月报')
    await change(view.container.querySelector('select')!, 'wf1')
    await view.click(view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!)
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ title: '月报', autonomy: 'assisted' }))
  } finally { view.unmount() }
})

it('selects two named agent attempts and only creates a scope', async () => {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const service = createFakeService(({ path }) => {
    if (path === '/v1/runs') return { ok: true, data: page([runSummary({ task_title: '月报' })]) }
    if (path === '/v1/node-runs') return { ok: true, data: page([
      nodeRunView({ node_type: 'agent', node_run_id: 'nr-a', title: '整理金额' }),
      nodeRunView({ node_type: 'agent', node_run_id: 'nr-b', title: '独立重算' }),
      nodeRunView({ node_type: 'wait', node_run_id: 'nr-c', title: '等待事件' }),
    ]) }
    if (path === '/v1/collaboration/scopes') return { ok: true, data: page([]) }
    throw new Error(path)
  })
  const client = createApiClient('http://panel.test', async (url, init) => {
    if (init?.method === 'POST') posts.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init.body)) })
    return service.fetcher(url, init)
  })
  const view = await renderPanel(<PanelShell activeRoute="collaboration" serviceConnected onNavigate={() => {}}>
    <CollaborationScreen client={client} onSnapshot={() => {}} onOpenRun={() => {}} reloadVersion={0} />
  </PanelShell>)
  try {
    await view.click(view.findAll('summary')[0]!)
    await view.flush()
    await change(view.container.querySelector('input[maxlength="200"]')!, '复核汇总')
    await change(view.container.querySelector('fieldset select')!, 'r1')
    await view.flush()
    expect(view.text()).toContain('独立重算')
    const boxes = view.findAll('fieldset input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    const save = view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!
    await view.click(boxes[0]!)
    expect(save.disabled).toBe(true)
    await view.click(boxes[1]!)
    expect(save.disabled).toBe(false)
    await view.click(save)
    expect(posts).toEqual([{ path: '/v1/collaboration/scopes', body: {
      operation_id: expect.any(String), title: '复核汇总', node_run_ids: ['nr-a', 'nr-b'], ttl_minutes: 60,
    } }])
  } finally { view.unmount() }
})

it('shows saved steps in run order with titles and distinct fallbacks', async () => {
  const scope = { scope_id: 'scope', title: '月报复核', expires_at: '2026-11-20T18:00:00Z' }
  const members = [
    { node_run_id: 'z-first', node_id: 'analyse', task_id: 't1', run_id: 'r1', title: '汇总分析' },
    { node_run_id: 'y-second', node_id: 'verify', task_id: 't1', run_id: 'r1', title: '独立复核' },
    { node_run_id: 'b-third', node_id: 'repeat', task_id: 't2', run_id: 'r2', title: '独立复核' },
    { node_run_id: 'a-legacy', node_id: 'old', task_id: 't3', run_id: 'r3' },
  ]
  const service = createFakeService(({ path }) => {
    if (path === '/v1/collaboration/scopes') return { ok: true, data: page([scope]) }
    if (path === '/v1/collaboration/scopes/get') return { ok: true, data: { scope, members, findings: [], requests: [] } }
    throw new Error(path)
  })
  const open = vi.fn()
  const view = await renderPanel(<CollaborationScreen client={createApiClient('http://panel.test', service.fetcher)}
    onSnapshot={() => {}} onOpenRun={open} reloadVersion={0} />)
  try {
    await view.flush()
    const buttons = view.findAll('button.ops-button--link')
    expect(buttons.map((button) => button.textContent)).toEqual(['汇总分析', '独立复核 · y-second', '独立复核 · b-third', '步骤 old'])
    await view.click(buttons[2]!)
    expect(open).toHaveBeenCalledWith('t2', 'r2')
  } finally { view.unmount() }
})

it.each(['workflow', 'goal'])('opens only the confirmed task and run after a %s launch', async (origin) => {
  const launch = { task_id: 'new-task', run_id: 'new-run' }
  let confirmed = false
  const service = createFakeService(({ path }) => {
    if (path === '/v1/workflows') return { ok: true, data: page([workflowItem()]) }
    if (path === '/v1/task-plans/capability') return { ok: true, data: { enabled: true } }
    if (path === '/v1/task-plans') return { ok: true, data: {
      plan_id: 'p', content_hash: 'hash', brief: { goal: '同名任务', requirements: [] },
      proposal: { title: '同名任务', workflow_id: 'wf1', workflow_version: 3, steps: [], deliverables: [], risks: [] },
      quality: { ready: true, checks: [] }, launch: null,
    } }
    if (['/v1/task-plans/confirm', '/v1/runs/start'].includes(path)) { confirmed = true; return { ok: true, data: launch } }
    throw new Error(path)
  })
  const client = createApiClient('http://panel.test', service.fetcher)
  const props = { api: createResourcesApi(client), commands: createTaskCommands(client), onOpenRun: vi.fn() }
  const view = await renderPanel(<PanelShell activeRoute="tasks" serviceConnected onNavigate={() => {}}>
    {origin === 'workflow' ? <TaskStartForm {...props} onCreated={() => {}} /> : <TaskPlanForm {...props} />}
  </PanelShell>)
  const button = (label: string) => view.findAll('button').find((item) => item.textContent === label)
  try {
    await view.flush()
    if (origin === 'workflow') {
      await change(view.container.querySelector('input')!, '同名任务')
      await change(view.container.querySelector('select')!, 'wf1')
      expect(button('查看本次运行')).toBeUndefined()
      await view.click(button('创建并排队')!)
    } else {
      await view.click(view.container.querySelector('summary')!)
      await view.flush()
      await change(view.container.querySelector('textarea')!, '同名任务')
      await view.click(button('生成计划')!)
      expect(button('查看本次运行')).toBeUndefined()
      await view.click(view.container.querySelector('input[type="checkbox"]')!)
      await view.click(button('确认后启动任务')!)
    }
    await view.flush()
    expect(confirmed).toBe(true)
    const link = button('查看本次运行')!
    await view.click(link)
    expect(props.onOpenRun).toHaveBeenCalledWith(launch.task_id, link, launch.run_id)
  } finally { view.unmount() }
})

it.each([
  ['inactivity', '等待可用的规划回复超时'],
  ['maximum', '规划已达到服务的处理时限'],
])('announces planning, retains the form on %s timeout, and replaces the wait state on retry', async (boundary, message) => {
  const first = deferred<FakeReply>()
  const second = deferred<FakeReply>()
  const submissions: unknown[] = []
  const service = createFakeService(({ path }) => {
    if (path === '/v1/task-plans/capability') return { ok: true, data: { enabled: true } }
    if (path === '/v1/task-plans') return submissions.length === 1 ? first.promise : second.promise
    throw new Error(path)
  })
  const client = createApiClient('http://panel.test', (input, init) => {
    if (init?.method === 'POST') submissions.push(JSON.parse(String(init.body)))
    return service.fetcher(input, init)
  })
  const view = await renderPanel(<PanelShell activeRoute="tasks" serviceConnected onNavigate={() => {}}>
    <TaskPlanForm api={createResourcesApi(client)} commands={createTaskCommands(client)} />
  </PanelShell>)
  try {
    await view.click(view.container.querySelector('summary')!)
    await view.flush()
    const [goal, criteria] = view.container.querySelectorAll<HTMLTextAreaElement>('textarea')
    await change(goal!, '汇总本周项目')
    await change(criteria!, '列出缺项\n整理成复核清单')
    const form = view.container.querySelector('form')!
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    const status = view.container.querySelector('details [role="status"]')!

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(submissions).toHaveLength(1)
    expect(form.getAttribute('aria-busy')).toBe('true')
    expect(status.textContent).toContain('正在生成计划')
    expect(status.textContent).toContain('可能会先生成流程，再编排步骤')
    expect(form.contains(status)).toBe(false)
    expect(submit.disabled && goal!.disabled && criteria!.disabled).toBe(true)

    await act(async () => first.resolve({ ok: false, error: {
      code: 'OPERATION_TIMEOUT', message: '主脑规划超时', retryable: true, details: { boundary },
    } }))
    expect(form.getAttribute('aria-busy')).toBe('false')
    expect(status.textContent).toBe('')
    expect(view.byRole('alert')[0]?.textContent).toContain(message)
    expect(view.byRole('alert')[0]?.textContent).toContain('已保留输入，可以重试')
    expect([goal!.value, criteria!.value]).toEqual(['汇总本周项目', '列出缺项\n整理成复核清单'])
    expect(submit.disabled || goal!.disabled || criteria!.disabled).toBe(false)

    await view.click(submit)
    expect(submissions).toEqual(Array.from({ length: 2 }, () => ({
      goal: '汇总本周项目', requirements: ['列出缺项', '整理成复核清单'],
    })))
    expect(view.byRole('alert')).toEqual([])
    expect(status.textContent).toContain('正在生成计划')
    await act(async () => second.resolve({ ok: true, data: {
      plan_id: 'p', content_hash: 'hash', brief: { goal: '汇总本周项目', requirements: [] },
      proposal: { title: '复核计划', workflow_id: 'wf1', workflow_version: '3', steps: [], deliverables: [], risks: [] },
      quality: { ready: true, checks: [] }, launch: null,
    } }))
    expect(view.container.querySelector('[aria-label="计划复核"] h2')?.textContent).toBe('复核计划')
    expect(view.text()).not.toContain('正在生成计划')
    expect(view.byRole('alert')).toEqual([])
  } finally { view.unmount() }
})

it.each(['collapse', 'leave tasks'])('cancels an outstanding planning POST on %s and ignores its late response', async (action) => {
  const first = deferred<FakeReply>()
  const second = deferred<FakeReply>()
  const signals: AbortSignal[] = []
  const service = createFakeService(({ path }) => {
    if (path === '/v1/task-plans/capability') return { ok: true, data: { enabled: true } }
    if (path === '/v1/task-plans') return signals.length === 1 ? first.promise : second.promise
    return { ok: true, data: page([]) }
  })
  const client = createApiClient('http://panel.test', (input, init) => {
    if (init?.method === 'POST') signals.push(init.signal!)
    return service.fetcher(input, init)
  })
  const plan = (title: string): FakeReply => ({ ok: true, data: {
    plan_id: 'p', content_hash: 'hash', brief: { goal: title, requirements: [] },
    proposal: { title, workflow_id: 'wf1', workflow_version: '1', steps: [], deliverables: [], risks: [] },
    quality: { ready: true, checks: [] }, launch: null,
  } })
  const view = await renderPanel(<PanelApp client={client} serviceConnected initialRoute="tasks" />)
  const button = (label: string) => view.findAll('button').find((item) => item.textContent === label)!
  const summary = () => view.findAll('summary').find((item) => item.textContent === '用自然语言规划任务')!
  try {
    await view.click(summary())
    await view.flush()
    await change(view.container.querySelector('textarea')!, '用户输入')
    await view.click(button('生成计划'))
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
    if (action === 'collapse') {
      await view.click(summary())
      await view.flush()
    } else {
      await view.click(button('设置'))
    }
    expect(signals[0]?.aborted).toBe(true)
    if (action !== 'collapse') await view.click(button('任务'))
    await view.click(summary())
    await view.flush()
    const goal = view.container.querySelector('textarea')!
    if (action === 'collapse') {
      expect(goal.value).toBe('用户输入')
      expect(view.text()).toContain('已取消生成，输入已保留')
    } else {
      await change(goal, '用户新输入')
    }
    await view.click(button('生成计划'))
    expect(signals).toHaveLength(2)
    expect(signals[1]?.aborted).toBe(false)
    await act(async () => first.resolve(plan('晚到旧计划')))
    expect(view.text()).not.toContain('晚到旧计划')
    expect(view.text()).toContain('正在生成计划')
    expect(view.byRole('alert')).toEqual([])
    await act(async () => second.resolve(plan('新计划')))
    expect(view.container.querySelector('[aria-label="计划复核"] h2')?.textContent).toBe('新计划')
    expect(view.text()).not.toContain('已取消生成')
  } finally { view.unmount() }
})

it('reuses the same manual operation after a lost response and offers no run until the receipt arrives', async () => {
  const ids: string[] = []
  const service = createFakeService(({ path }) => {
    if (path === '/v1/workflows') return { ok: true, data: page([workflowItem()]) }
    if (ids.length === 1) return { ok: false, error: { code: 'OPERATION_TIMEOUT', message: '连接中断', retryable: true } }
    return { ok: true, data: { task_id: 'committed-task', run_id: 'committed-run' } }
  })
  const client = createApiClient('http://panel.test', async (input, init) => {
    if (init?.method === 'POST') ids.push(JSON.parse(String(init.body)).operationId)
    return service.fetcher(input, init)
  })
  const open = vi.fn()
  const view = await renderPanel(<PanelShell activeRoute="tasks" serviceConnected onNavigate={() => {}}>
    <TaskStartForm api={createResourcesApi(client)} commands={createTaskCommands(client)} onCreated={() => {}} onOpenRun={open} />
  </PanelShell>)
  const button = (label: string) => view.findAll('button').find((item) => item.textContent === label)
  try {
    await view.flush()
    await change(view.container.querySelector('input')!, '同名任务')
    await change(view.container.querySelector('select')!, 'wf1')
    await view.click(button('创建并排队')!)
    expect(button('查看本次运行')).toBeUndefined()
    await view.click(button('查询或重试')!)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    const link = button('查看本次运行')!
    await view.click(link)
    expect(open).toHaveBeenCalledWith('committed-task', link, 'committed-run')
  } finally { view.unmount() }
})
