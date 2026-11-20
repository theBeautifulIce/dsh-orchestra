// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { WorkflowConcurrencySettings } from '../../src/client/panel/workflow-concurrency-settings.tsx'
import { renderPanel, workflowItem } from './harness.ts'

const path = '/v1/settings/workflow-concurrency'
const defaults = { run_limit: null, node_limit: null, helper_limit: 0 }
const envelope = (data: unknown) => Response.json({ ok: true, schema_version: 1, as_of_seq: 1, data })
const reject = (code: string, message: string) => Response.json({
  ok: false, schema_version: 1, as_of_seq: 1, error: { code, message, retryable: false },
})
const change = async (select: HTMLSelectElement, value: string) => act(async () => {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
})

it('列出各页已发布 Workflow 和已发布智能体步骤，并在各目标分别保存或恢复继承', async () => {
  const writes: unknown[] = []
  const targetReads: [string | null, string | null][] = []
  let overrides: Record<string, number | null> = { node_limit: 5 }
  let revision = 7
  const client = createApiClient('http://panel.test', async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/v1/workflows') {
      return url.searchParams.get('cursor') === 'next'
        ? envelope({ items: [workflowItem({ workflow_id: 'wf2', name: '流程二' })], next_cursor: null })
        : envelope({ items: [workflowItem(), workflowItem({ workflow_id: 'draft', current_version: null })], next_cursor: 'next' })
    }
    if (url.pathname === '/v1/workflows/get') {
      return envelope({
        draft: { definition: { nodes: [{ node_id: 'draft_agent', type: 'agent', title: '草稿步骤' }] } },
        current: { definition: { nodes: [
          { node_id: 'published_agent', type: 'agent', title: '已发布智能体' },
          { node_id: 'tool', type: 'tool', title: '工具步骤' },
        ] } },
      })
    }
    if (init?.method === 'POST') {
      const command = JSON.parse(String(init.body))
      writes.push(command)
      overrides = command.values ?? {}
      revision++
      return envelope({})
    }
    if (url.pathname !== path) throw new Error('unexpected request')
    targetReads.push([url.searchParams.get('workflow_id'), url.searchParams.get('node_id')])
    const targetOverrides = url.searchParams.has('node_id') ? overrides : {}
    return envelope({ revision: url.searchParams.has('node_id') ? revision : 7, inherited: defaults, overrides: targetOverrides,
      values: { ...defaults, ...targetOverrides }, helper_available: true })
  })
  const view = await renderPanel(<PanelShell activeRoute="settings" onNavigate={() => {}} serviceConnected>
    <WorkflowConcurrencySettings client={client} />
  </PanelShell>)
  const select = (label: string) => (view.findAll('select') as HTMLSelectElement[])
    .find((item) => item.labels?.[0]?.textContent?.startsWith(label))!
  const button = (label: string) => view.findAll('button').find((item) => item.textContent === label)!
  try {
    await view.flush()
    expect(targetReads).toContainEqual([null, null])
    expect([...select('应用范围').options].map(({ value }) => value)).toEqual(['', 'wf1', 'wf2'])
    await change(select('每次流程运行的并行步骤数'), '3')
    await change(select('应用范围'), 'wf2')
    await view.flush()
    expect([...select('已发布步骤').options].map(({ value }) => value)).toEqual(['', 'published_agent'])
    await change(select('已发布步骤'), 'published_agent')
    await view.flush()
    expect(targetReads).toContainEqual(['wf2', null])
    expect(targetReads).toContainEqual(['wf2', 'published_agent'])
    expect(select('每次流程运行的并行步骤数')).toBeUndefined()
    expect(select('同一步骤跨任务的并发数').value).toBe('5')
    await change(select('同一步骤跨任务的并发数'), 'unlimited')
    await change(select('每个步骤内的并行助手数'), '2')
    expect(writes).toHaveLength(0)
    await view.click(button('保存 Workflow 并发'))
    await view.flush()
    expect(writes[0]).toMatchObject({ expected_revision: 7, workflow_id: 'wf2', node_id: 'published_agent',
      values: { node_limit: null, helper_limit: 2 } })
    await view.click(button('恢复继承'))
    await view.flush()
    expect(writes[1]).toMatchObject({ expected_revision: 8, workflow_id: 'wf2', node_id: 'published_agent', values: null })
    await change(select('应用范围'), '')
    await view.flush()
    expect(select('每次流程运行的并行步骤数').value).toBe('3')
    expect((button('保存 Workflow 并发') as HTMLButtonElement).disabled).toBe(false)
  } finally { view.unmount() }
})

it('请求结果未知时使用原操作重试，其他人更新版本后保留本地草稿并阻止覆盖', async () => {
  const writes: unknown[] = []
  let revision = 0
  let stored = 1
  const client = createApiClient('http://panel.test', async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/v1/workflows') return envelope({ items: [], next_cursor: null })
    if (url.pathname === '/v1/operations/get') return reject('NOT_FOUND', '回执不存在')
    if (init?.method === 'POST') {
      const command = JSON.parse(String(init.body))
      writes.push(command)
      if (writes.length === 1) throw new Error('lost response')
      if (command.expected_revision !== revision) return reject('REVISION_CONFLICT', '版本已变化')
      revision++
      stored = command.values.run_limit
      return envelope({})
    }
    const overrides = { run_limit: stored }
    return envelope({ revision, inherited: defaults, overrides, values: { ...defaults, ...overrides }, helper_available: false })
  })
  const panel = (reloadVersion: number) => <PanelShell activeRoute="settings" onNavigate={() => {}} serviceConnected>
    <WorkflowConcurrencySettings client={client} reloadVersion={reloadVersion} />
  </PanelShell>
  const view = await renderPanel(panel(0))
  const select = () => (view.findAll('select')[1] as HTMLSelectElement)
  const button = (label: string) => view.findAll('button').find((item) => item.textContent === label) as HTMLButtonElement
  try {
    await view.flush()
    await change(select(), '2')
    await view.click(button('保存 Workflow 并发'))
    await view.flush()
    expect(select().disabled).toBe(true)
    await view.click(button('查询或重试 Workflow 并发保存'))
    await view.flush()
    expect(writes[1]).toEqual(writes[0])
    await change(select(), '3')
    revision++
    stored = 4
    await view.rerender(panel(1))
    await view.flush()
    expect(view.text()).toContain('被其他操作更新')
    expect(select().value).toBe('3')
    expect(button('保存 Workflow 并发').disabled).toBe(true)
    await view.click(button('舍弃本地修改'))
    expect(select().value).toBe('4')
    expect(writes).toHaveLength(2)
  } finally { view.unmount() }
})
