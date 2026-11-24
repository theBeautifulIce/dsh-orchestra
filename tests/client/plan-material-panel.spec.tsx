// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { createTaskCommands } from '../../src/client/api/task-commands.ts'
import { PlanMaterialPanel, PlanMaterialList } from '../../src/client/panel/plan-material-panel.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { TaskPlanForm } from '../../src/client/panel/task-plan-form.tsx'
import type { TaskPlanView } from '../../src/service/task-planning.ts'
import { createFakeService, deferred, renderPanel } from './harness.ts'

const plan = (title: string): TaskPlanView => ({
  plan_id: title, content_hash: 'a'.repeat(64), created_at: '2026-11-24T12:00:00Z', launch: null,
  brief: { goal: title, requirements: [] }, quality: { ready: true, checks: [] }, material_recipients: ['read'],
  proposal: { title, workflow_id: 'w', workflow_version: '1', risks: [], steps: [
    { node_id: 'read', description: '核对材料', goal_ids: ['goal'], depends_on: [], tools: [], complexity: 'routine', model_reason: '整理', preferred_model_ref: '核对模型' },
    { node_id: 'approval', description: '人工确认', goal_ids: ['goal'], depends_on: ['read'], tools: [], complexity: 'routine', model_reason: '人工' },
  ], deliverables: [{ title: '核对报告', node_id: 'read', goal_ids: ['goal'], acceptance: { kind: 'artifact', file_name: '核对.md', minimum_bytes: 1 } }] },
})
const services = (title: string) => {
  const fake = createFakeService(({ path }) => {
    if (path === '/v1/task-plans/capability') return { ok: true, data: { enabled: true } }
    if (path === '/v1/task-plans/drafts') return { ok: true, data: { items: [plan(title)] } }
    if (path === '/v1/task-plans/progress') return { ok: true, data: { items: [] } }
    throw new Error(path)
  })
  const client = createApiClient('http://panel.test', fake.fetcher)
  return { api: createResourcesApi(client), commands: createTaskCommands(client) }
}
async function textInput(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('only offers real execution steps, submits after consent and reuses the request identity after a lost response', async () => {
  const { api, commands } = services('计划甲')
  const grant = vi.fn().mockRejectedValueOnce(new Error('暂未取得回执')).mockResolvedValueOnce(plan('修订计划'))
  const saved = vi.fn(), busy = vi.fn()
  const view = await renderPanel(<PlanMaterialPanel plan={plan('计划甲')} api={api}
    commands={{ ...commands, grantPlanMaterials: grant }} onPlan={saved} onBusy={busy} />)
  try {
    expect(view.findAll('input[type="checkbox"]')).toHaveLength(1)
    expect(view.text()).toContain('核对模型')
    expect(view.text()).not.toContain('人工确认')
    await textInput(view.container.querySelector('textarea')!, '这份材料只给核对步骤')
    const submit = view.container.querySelector('button')!
    expect(submit.disabled).toBe(true)
    await view.click(view.findAll('input[type="checkbox"]')[0]!)
    expect(grant).not.toHaveBeenCalled()
    await view.click(submit)
    expect(view.text()).toContain('暂未取得回执')
    const first = grant.mock.calls[0]!
    expect(first.slice(0, 4)).toEqual(['计划甲', 'a'.repeat(64), ['read'], [{ name: '补充材料.txt', body: '这份材料只给核对步骤' }]])
    await view.click(submit)
    expect(grant.mock.calls[1]![4]).toBe(first[4])
    expect(saved).toHaveBeenCalledWith(plan('修订计划'))
    expect(busy.mock.calls).toEqual([[true], [false], [true], [false]])
  } finally { view.unmount() }
})

it('clears a previous session plan and ignores its late launch receipt after a transport change', async () => {
  const before = services('会话甲的计划'), after = services('会话乙的计划')
  const receipt = deferred<{ task_id: string; run_id: string; replayed: boolean }>()
  const confirm = vi.fn().mockReturnValue(receipt.promise)
  const started = vi.fn()
  const commands = { ...before.commands, confirmTaskPlan: confirm }
  const view = await renderPanel(<PanelShell activeRoute="tasks" serviceConnected onNavigate={() => {}}><TaskPlanForm api={before.api} commands={commands} onStarted={started} /></PanelShell>)
  try {
    await view.click(view.findAll('summary').find(item => item.textContent === '用自然语言规划任务')!)
    await view.flush()
    await view.click(view.findAll('button').find(item => item.textContent === '会话甲的计划')!)
    const consent = view.findAll('label').find(item => item.textContent?.includes('我已核对'))!.querySelector('input')!
    await view.click(consent)
    await view.click(view.findAll('button').find(item => item.textContent === '确认后启动任务')!)
    expect(confirm).toHaveBeenCalledTimes(1)
    await view.rerender(<PanelShell activeRoute="tasks" serviceConnected onNavigate={() => {}}><TaskPlanForm api={after.api} commands={after.commands} onStarted={started} /></PanelShell>)
    expect(view.text()).not.toContain('会话甲的计划')
    await act(async () => { receipt.resolve({ task_id: 'old-task', run_id: 'old-run', replayed: false }) })
    expect(started).not.toHaveBeenCalled()
    expect(view.text()).not.toContain('已建立受监督')
    await view.click(view.findAll('summary').find(item => item.textContent === '用自然语言规划任务')!)
    await view.flush()
    expect(view.text()).toContain('会话乙的计划')
  } finally { view.unmount() }
})

it('shows persisted authorization state, named recipients and expiry and deduplicates a revoke click', async () => {
  const servicesForPlan = services('授权核对')
  const expiry = Date.now() + 60_000
  const material = { id: 'm1', digest: 'b'.repeat(64), name: '收入.csv', nodes: ['read'], expires_ms: expiry, draft: 'draft' }
  const pending = deferred<{ data: { revoked: boolean }; as_of_seq: number }>()
  const revoke = vi.fn().mockReturnValue(pending.promise)
  const api = { ...servicesForPlan.api, revokePlanMaterial: revoke }
  const ready = { ...plan('授权核对'), brief: { goal: '核对', requirements: [], materials: [material] } }
  const shell = (value: TaskPlanView) => <PanelShell activeRoute="tasks" serviceConnected onNavigate={() => {}}>
    <PlanMaterialList plan={value} api={api} />
  </PanelShell>
  const view = await renderPanel(shell(ready))
  try {
    expect(view.text()).toContain('可读步骤：核对材料')
    expect(view.text()).toContain('到期时间：')
    const button = view.findAll('button').find(item => item.textContent === '撤回授权')!
    await view.click(button)
    await view.click(button)
    expect(revoke).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve({ data: { revoked: true }, as_of_seq: 1 }) })
    expect(view.text()).toContain('已撤回')
    await view.rerender(shell({ ...ready, plan_id: 'reloaded', material_states: [{ id: 'm1', state: 'revoked', expires_ms: expiry }] }))
    expect(view.text()).toContain('已撤回')
    expect(view.findAll('button').some(item => item.textContent === '撤回授权')).toBe(false)
    await view.rerender(shell({ ...ready, plan_id: 'expired', material_states: [{ id: 'm1', state: 'expired', expires_ms: expiry - 60_001 }] }))
    expect(view.text()).toContain('已到期')
  } finally { pending.resolve({ data: { revoked: false }, as_of_seq: 1 }); view.unmount() }
})
