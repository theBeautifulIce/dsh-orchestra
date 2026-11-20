// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { createTaskCommands } from '../../src/client/api/task-commands.ts'
import { CollaborationScreen } from '../../src/client/panel/collaboration-screen.tsx'
import { TaskStartForm } from '../../src/client/panel/task-start-form.tsx'
import { TaskPlanForm } from '../../src/client/panel/task-plan-form.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { createFakeService, nodeRunView, page, renderPanel, runSummary, workflowItem } from './harness.ts'

async function change(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

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
