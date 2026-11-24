// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { createTaskCommands } from '../../src/client/api/task-commands.ts'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { TaskPlanForm } from '../../src/client/panel/task-plan-form.tsx'
import { createFakeService, page, renderPanel } from './harness.ts'

function draft(id: string, title: string) {
  return { plan_id: id, content_hash: id + '-hash', brief: { goal: title, requirements: [], workflow_id: 'wf1', workflow_version: '2' },
    proposal: { title, workflow_id: 'wf1', workflow_version: '2', steps: [], deliverables: [], risks: [] },
    quality: { ready: true, checks: [] }, launch: null, created_at: '2026-11-24T01:00:00.000Z' }
}

it('loads older drafts, revises the selected version and persists discard through the command API', async () => {
  const current = draft('recent', '最近的计划')
  const older = draft('older', '更早的计划')
  const revised = draft('revised', '修订后的计划')
  const writes: { path: string; body: Record<string, unknown> }[] = []
  let stage: 'initial' | 'revised' | 'discarded' = 'initial'
  const service = createFakeService(({ path, params }) => {
    if (path === '/v1/task-plans/capability') return { ok: true, data: { enabled: true } }
    if (path === '/v1/task-plans/drafts') return { ok: true, data: stage === 'initial'
      ? params.get('cursor') === 'page-2' ? page([older]) : page([current], 'page-2')
      : page(stage === 'revised' ? [current, revised] : [current]) }
    if (path === '/v1/task-plans') { stage = 'revised'; return { ok: true, data: revised } }
    if (path === '/v1/task-plans/discard') { stage = 'discarded'; return { ok: true, data: { discarded: true } } }
    throw new Error(path)
  })
  const client = createApiClient('http://panel.test', async (url, init) => {
    if (init?.method === 'POST') writes.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init.body)) })
    return service.fetcher(url, init)
  })
  const view = await renderPanel(<PanelShell activeRoute="tasks" serviceConnected onNavigate={() => {}}><TaskPlanForm api={createResourcesApi(client)} commands={createTaskCommands(client)} /></PanelShell>)
  const button = (label: string) => view.findAll('button').find(item => item.textContent === label)!
  try {
    await view.click(view.container.querySelector('summary')!)
    await view.flush()
    expect(button('更早的计划')).toBeUndefined()
    await view.click(button('加载更早的计划'))
    await view.flush()
    expect(button('最近的计划')).toBeDefined()
    await view.click(button('更早的计划'))
    await view.click(button('调整目标并重新规划'))
    const goal = view.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(goal, '补齐报告的附录')
      goal.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await view.click(button('生成计划'))
    await view.flush()
    expect(writes, view.text()).toHaveLength(1)
    expect(writes[0]).toEqual({ path: '/v1/task-plans', body: {
      goal: '补齐报告的附录', requirements: [], workflow_id: 'wf1', workflow_version: '2',
      revises: { plan_id: older.plan_id, content_hash: older.content_hash },
    } })
    expect(view.container.querySelector('[aria-label="计划复核"] h2')?.textContent).toBe('修订后的计划')
    expect(button('更早的计划')).toBeUndefined()
    await view.click(button('放弃这份计划'))
    await view.flush()
    expect(writes[1]).toEqual({ path: '/v1/task-plans/discard', body: {
      plan_id: revised.plan_id, content_hash: revised.content_hash,
    } })
    expect(view.container.querySelector('[aria-label="计划复核"]')).toBeNull()
    expect(button('修订后的计划')).toBeUndefined()
    expect(button('最近的计划')).toBeDefined()
  } finally { view.unmount() }
})
