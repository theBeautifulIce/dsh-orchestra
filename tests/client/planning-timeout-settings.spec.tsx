// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { PlanningTimeoutSettings } from '../../src/client/panel/planning-timeout-settings.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { renderPanel } from './harness.ts'

it('同一操作重试并回读，恢复默认会保存 null', async () => {
  const defaults = { task_seconds: 30, workflow_seconds: 45, idle_seconds: 30, stage_seconds: 120, request_seconds: 180 }
  const limits = { task_seconds: 600, workflow_seconds: 600, idle_seconds: 300, stage_seconds: 600, request_seconds: 900 }
  let settings = { revision: 0, values: defaults, defaults, limits, overridden: false, legacy_timeout_ms: null,
    branches: { task: 'streaming', automatic_workflow: 'streaming', standalone_workflow: 'streaming' } }
  const posts: Array<{ operation_id: string; expected_revision: number; values: typeof defaults | null }> = []
  const client = createApiClient('http://panel.test', async (input, init) => {
    if (init?.method === 'POST') {
      const command = JSON.parse(String(init.body))
      posts.push(command)
      if (posts.length === 1) throw new Error('lost response')
      settings = { ...settings, revision: settings.revision + 1, values: command.values ?? defaults, overridden: command.values !== null }
    }
    if (new URL(String(input)).pathname === '/v1/operations/get') {
      return Response.json({ ok: false, schema_version: 1, as_of_seq: 0, error: { code: 'NOT_FOUND' } })
    }
    return Response.json({ ok: true, schema_version: 1, as_of_seq: 0, data: settings })
  })
  const view = await renderPanel(<PanelShell activeRoute="settings" serviceConnected onNavigate={() => {}}>
    <PlanningTimeoutSettings client={client} />
  </PanelShell>)
  const button = (label: string) => view.findAll('button').find((item) => item.textContent === label)!
  const change = async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  try {
    await view.flush()
    const inputs = view.findAll('input') as HTMLInputElement[]
    await change(inputs[3]!, '240')
    await view.click(button('保存规划时限'))
    expect(view.text()).toContain('不能长于整次规划总时长')
    expect(posts).toHaveLength(0)
    await change(inputs[4]!, '360')
    await view.click(button('保存规划时限'))
    await view.flush()
    expect(inputs[3]!.disabled).toBe(true)
    await view.click(button('查询或重试'))
    await view.flush()
    expect(posts[1]).toEqual(posts[0])
    expect(posts[1]?.values).toMatchObject({ stage_seconds: 240, request_seconds: 360 })
    expect(inputs[3]!.value).toBe('240')
    await view.click(button('恢复默认'))
    await view.flush()
    expect(posts[2]).toMatchObject({ expected_revision: 1, values: null })
    expect(inputs[3]!.value).toBe('120')
  } finally { view.unmount() }
})
