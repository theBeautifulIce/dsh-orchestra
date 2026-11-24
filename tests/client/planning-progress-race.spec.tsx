// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { createTaskCommands } from '../../src/client/api/task-commands.ts'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { TaskPlanForm } from '../../src/client/panel/task-plan-form.tsx'
import type { TaskPlanView } from '../../src/service/task-planning.ts'
import { createFakeService, deferred, renderPanel, type FakeReply, type PanelView } from './harness.ts'

function plan(id: string, title: string, hash = 'a'): TaskPlanView {
  return {
    plan_id: id, content_hash: hash.repeat(64), created_at: '2026-11-24T12:00:00Z', launch: null,
    brief: { goal: title, requirements: [] }, quality: { ready: true, checks: [] }, material_recipients: ['read'],
    proposal: { title, workflow_id: 'review', workflow_version: '1', risks: [], steps: [
      { node_id: 'read', description: '核对材料', goal_ids: ['goal'], depends_on: [], tools: [],
        complexity: 'routine', model_reason: '整理材料' },
    ], deliverables: [{ title: '核对报告', node_id: 'read', goal_ids: ['goal'],
      acceptance: { kind: 'artifact', file_name: '核对.md', minimum_bytes: 1 } }] },
  }
}

const planA = plan('plan-a', '甲计划：整理材料')
const planB = plan('plan-b', '乙计划：整理记录', 'b')
const grantedA: TaskPlanView = {
  ...plan('plan-a-authorized', '甲计划：已授权材料', 'c'),
  brief: { goal: planA.brief.goal, requirements: [], materials: [
    { id: 'material-a', digest: 'd'.repeat(64), name: '补充材料.txt', nodes: ['read'],
      expires_ms: Date.now() + 30 * 60_000, draft: planA.plan_id },
  ] },
}
const progressB = { request_key: 'request-b', stage: 'approval', run_id: null,
  plan_id: planB.plan_id, title: planB.proposal.title, updated_ms: Date.now() }

function button(view: PanelView, text: string): HTMLButtonElement {
  const found = view.findAll('button').find(item => item.textContent?.trim() === text)
  expect(found, `Missing button: ${text}`).toBeDefined()
  return found as HTMLButtonElement
}
function progressButton(view: PanelView): HTMLButtonElement {
  const found = view.container.querySelector<HTMLButtonElement>('[aria-label="会话规划进度"] button')
  expect(found).not.toBeNull()
  return found!
}
function currentTitle(view: PanelView) {
  return view.container.querySelector('[aria-label="计划复核"] h2')?.textContent
}
async function fill(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function setup(progressData: unknown = { items: [progressB] }) {
  const grantReply = deferred<FakeReply>()
  const planBReply = deferred<FakeReply>()
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const started = vi.fn()
  let draft = planA
  const fake = createFakeService(({ path, params }) => {
    if (path === '/v1/task-plans/progress') return { ok: true, data: progressData }
    if (path === '/v1/task-plans/capability') return { ok: true, data: { enabled: true } }
    if (path === '/v1/task-plans/drafts') return { ok: true, data: { items: [draft], next_cursor: null } }
    if (path === '/v1/task-plans/get' && params.get('plan_id') === planB.plan_id) return planBReply.promise
    if (path === '/v1/task-plans/materials') return grantReply.promise
    if (path === '/v1/task-plans/confirm') return { ok: true, data: { task_id: 'task-a', run_id: 'run-a' } }
    throw new Error('Unexpected request: ' + path)
  })
  const client = createApiClient('http://panel.test', (url, init) => {
    if (init?.method === 'POST') posts.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init.body)) })
    return fake.fetcher(url, init)
  })
  const api = createResourcesApi(client)
  const commands = createTaskCommands(client)
  const view = await renderPanel(<PanelShell activeRoute="tasks" serviceConnected onNavigate={() => {}}>
    <TaskPlanForm api={api} commands={commands} onStarted={started} />
  </PanelShell>)
  return {
    view, posts, started, calls: fake.calls,
    async selectA() {
      await view.click(view.findAll('summary').find(item => item.textContent === '用自然语言规划任务')!)
      await view.flush()
      await view.click(button(view, planA.proposal.title))
      expect(currentTitle(view)).toBe(planA.proposal.title)
    },
    async beginGrant() {
      const summary = view.findAll('summary').find(item => item.textContent === '为本次任务补充材料')!
      await view.click(summary)
      const materials = summary.parentElement!
      await view.click(materials.querySelector('input[type="checkbox"]')!)
      await fill(materials.querySelector('textarea')!, '只供甲计划核对的材料')
      await view.click(button(view, '仅这次使用'))
      expect(posts.filter(item => item.path === '/v1/task-plans/materials')).toHaveLength(1)
    },
    async resolveB() {
      await act(async () => { planBReply.resolve({ ok: true, data: planB }) })
    },
    async resolveGrant() {
      draft = grantedA
      await act(async () => { grantReply.resolve({ ok: true, data: grantedA }) })
      await view.flush()
    },
    close() {
      view.unmount()
      grantReply.resolve({ ok: true, data: grantedA })
      planBReply.resolve({ ok: true, data: planB })
    },
  }
}

it('disables the progress plan action while another plan material grant is pending', async () => {
  const fixture = await setup()
  try {
    await fixture.selectA()
    expect(progressButton(fixture.view).disabled).toBe(false)
    await fixture.beginGrant()
    expect(progressButton(fixture.view).disabled).toBe(true)
    await fixture.view.click(progressButton(fixture.view))
    expect(fixture.calls.filter(item => item.path === '/v1/task-plans/get')).toHaveLength(0)
    expect(currentTitle(fixture.view)).toBe(planA.proposal.title)
  } finally { fixture.close() }
})

it('keeps cancelled plan history readable without offering to resume it, while a declined plan can still be resumed', async () => {
  const fixture = await setup({ items: [
    { ...progressB, request_key: 'discarded', stage: 'cancelled', title: '已放弃的计划' },
    { ...progressB, request_key: 'declined', stage: 'declined', title: '稍后确认的计划' },
  ] })
  try {
    const rows = Array.from(fixture.view.container.querySelectorAll('[aria-label="会话规划进度"] li'))
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('已取消规划')
    expect(rows[0]!.querySelector('button')).toBeNull()
    const resume = rows[1]!.querySelector('button')!
    expect(resume.textContent).toBe('核对这份计划')
    await fixture.view.click(resume)
    await fixture.resolveB()
    expect(currentTitle(fixture.view)).toBe(planB.proposal.title)
  } finally { fixture.close() }
})

it('ignores a pending progress plan read after material authorization starts and can confirm the newly authorized plan', async () => {
  const fixture = await setup()
  try {
    await fixture.selectA()
    await fixture.view.click(progressButton(fixture.view))
    expect(fixture.calls.filter(item => item.path === '/v1/task-plans/get')).toEqual([
      expect.objectContaining({ params: expect.any(URLSearchParams) }),
    ])
    expect(fixture.calls.find(item => item.path === '/v1/task-plans/get')!.params.get('plan_id')).toBe(planB.plan_id)
    await fixture.beginGrant()
    await fixture.resolveB()
    expect(currentTitle(fixture.view)).toBe(planA.proposal.title)
    expect(button(fixture.view, '确认后启动任务').disabled).toBe(true)
    await fixture.resolveGrant()
    expect(currentTitle(fixture.view)).toBe(grantedA.proposal.title)
    const consent = fixture.view.findAll('label').find(item => item.textContent?.includes('我已核对'))!.querySelector('input')!
    expect(button(fixture.view, '确认后启动任务').disabled).toBe(true)
    await fixture.view.click(consent)
    expect(button(fixture.view, '确认后启动任务').disabled).toBe(false)
    await fixture.view.click(button(fixture.view, '确认后启动任务'))
    expect(fixture.posts.filter(item => item.path === '/v1/task-plans/confirm')).toEqual([
      { path: '/v1/task-plans/confirm', body: { plan_id: grantedA.plan_id, content_hash: grantedA.content_hash, confirmed: true } },
    ])
    expect(fixture.started).toHaveBeenCalledWith('task-a')
  } finally { fixture.close() }
})

it.each([
  ['missing items', {}],
  ['null item', { items: [null] }],
] as const)('contains a malformed progress response (%s) inside the progress section without losing the plan form', async (_case, data) => {
  const fixture = await setup(data)
  try {
    await fixture.selectA()
    const section = fixture.view.container.querySelector('[aria-label="会话规划进度"]')!
    expect(section).not.toBeNull()
    expect(section.textContent).toContain('重新读取')
    expect(currentTitle(fixture.view)).toBe(planA.proposal.title)
    const consent = fixture.view.findAll('label').find(item => item.textContent?.includes('我已核对'))!.querySelector('input')!
    await fixture.view.click(consent)
    expect(button(fixture.view, '确认后启动任务').disabled).toBe(false)
  } finally { fixture.close() }
})
