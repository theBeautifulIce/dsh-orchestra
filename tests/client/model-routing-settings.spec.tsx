// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { ModelRoutingSettings } from '../../src/client/panel/model-routing-settings.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { renderPanel } from './harness.ts'

it('仅有一个宿主模型时允许评估为专家，再按实际目录刷新并选择思考深度', async () => {
  const initial = { ref: 'first/same', capacity: 'standard', host_capacity: 'standard', provider: 'first', model: 'same' }
  let profiles: Record<string, unknown>[] = [initial]
  let revision = 0
  let settings: Record<string, unknown> = {
    mapping: { routine: null, standard: null, advanced: null, complex: null, expert: null },
  }
  const submissions: Record<string, unknown>[] = []
  const client = createApiClient('http://panel.test', async (_input, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      submissions.push(body)
      settings = { ...settings, ...body }
      revision++
    }
    return Response.json({ ok: true, schema_version: 1, as_of_seq: 5,
      data: { ...settings, revision, profiles, unavailable_providers: [] } })
  })
  const view = await renderPanel(<PanelShell activeRoute="settings" serviceConnected onNavigate={() => {}}>
    <ModelRoutingSettings client={client} />
  </PanelShell>)
  const select = (query: string) => view.container.querySelector<HTMLSelectElement>(query)!
  const button = (text: string) => view.findAll('button').find((element) => element.textContent === text)!
  async function change(query: string, value: string) {
    await act(async () => {
      const element = select(query)
      element.value = value
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  try {
    await view.flush()
    expect(select('#model-route-expert').options).toHaveLength(1)
    expect(view.text()).toContain('该模型未提供可调思考档')
    await change('select[aria-label="first / same 最大能力"]', 'expert')
    await change('#model-route-expert', 'first/same')
    expect(select('#model-effort-expert')).toBeNull()
    await view.click(button('保存模型分配'))
    await view.flush()
    expect(submissions[0]).toMatchObject({ model_capacities: [{ ref: 'first/same', capacity: 'expert' }],
      mapping: { expert: 'first/same' } })
    profiles = [initial, { ref: 'second/same', capacity: null, host_capacity: null, provider: 'second', model: 'same',
      reasoning: { efforts: [{ id: 'deep', name: 'Deep' }, { id: 'turbo', name: 'Turbo' }], defaultEffort: 'deep' } }]
    await view.click(button('重新读取'))
    await view.flush()
    await change('select[aria-label="second / same 最大能力"]', 'expert')
    await change('#model-route-expert', 'second/same')
    expect([...select('#model-effort-expert').options].map(({ value, label }) => [value, label])).toEqual([
      ['', '模型默认（Deep）'], ['deep', 'Deep'], ['turbo', 'Turbo'],
    ])
    await change('#model-effort-expert', 'turbo')
    await view.click(button('保存模型分配'))
    await view.flush()
    expect(submissions[1]).toMatchObject({ expected_revision: 1, mapping: { expert: 'second/same' },
      reasoning_efforts: { expert: 'turbo' } })
  } finally { view.unmount() }
})

it('设置按五档复杂度筛选获准模型，并保存和回读模型用途说明', async () => {
  const profiles = [
    { ref: 'fast', capacity: 'routine', provider: 'dsh', model: 'fast-model' },
    { ref: 'middle', capacity: 'standard', provider: 'dsh', model: 'middle-model' },
    { ref: 'analyst', capacity: 'advanced', provider: 'dsh', model: 'analyst-model' },
    { ref: 'reasoner', capacity: 'complex', provider: 'dsh', model: 'reasoning-model' },
    { ref: 'expert', capacity: 'expert', provider: 'dsh', model: 'expert-model' },
  ]
  let revision = 3
  let mapping = { routine: null, standard: null, advanced: null, complex: null, expert: null }
  let modelNotes = [{ ref: 'reasoner', note: '初始用途' }]
  let submitted: Record<string, unknown> | undefined
  const client = createApiClient('http://panel.test', async (_input, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      submitted = body
      revision++
      mapping = body.mapping
      modelNotes = body.model_notes
    }
    return new Response(JSON.stringify({ ok: true, schema_version: 1, as_of_seq: 5, data: { revision, profiles, mapping, model_notes: modelNotes } }))
  })
  const view = await renderPanel(<PanelShell activeRoute="settings" serviceConnected onNavigate={() => {}}>
    <ModelRoutingSettings client={client} />
  </PanelShell>)
  try {
    await view.flush()
    const selects = view.findAll('select') as HTMLSelectElement[]
    expect(selects.map((element) => [...element.options].map((option) => option.value))).toEqual([
      ['', 'fast', 'middle', 'analyst', 'reasoner', 'expert'], ['', 'middle', 'analyst', 'reasoner', 'expert'],
      ['', 'analyst', 'reasoner', 'expert'], ['', 'reasoner', 'expert'], ['', 'expert'],
    ])
    const note = (view.findAll('fieldset input') as HTMLInputElement[])[3]!
    expect(note.value).toBe('初始用途')
    expect(note.maxLength).toBe(160)
    await act(async () => {
      selects[2]!.value = 'analyst'
      selects[2]!.dispatchEvent(new Event('change', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, '  擅长复核证据  ')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = view.findAll('button').find((element) => element.textContent === '保存模型分配')
    await view.click(save!)
    await view.flush()
    expect(submitted).toMatchObject({ expected_revision: 3, mapping: { routine: null, standard: null, advanced: 'analyst', complex: null, expert: null },
      model_notes: [{ ref: 'reasoner', note: '擅长复核证据' }],
      operation_id: expect.stringMatching(/^[0-9a-f-]+$/) })
    expect(note.value).toBe('擅长复核证据')
    expect(view.text()).toContain('下一次派发采用新配置')
  } finally { view.unmount() }
})
