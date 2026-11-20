// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { ModelRoutingSettings } from '../../src/client/panel/model-routing-settings.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { renderPanel } from './harness.ts'

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
