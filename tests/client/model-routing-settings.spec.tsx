// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { ModelRoutingSettings } from '../../src/client/panel/model-routing-settings.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { renderPanel } from './harness.ts'

it('设置按复杂度筛选获准模型，并按当前修订保存三档映射', async () => {
  const profiles = [
    { ref: 'fast', capacity: 'routine', provider: 'dsh', model: 'fast-model' },
    { ref: 'middle', capacity: 'standard', provider: 'dsh', model: 'middle-model' },
    { ref: 'reasoner', capacity: 'complex', provider: 'dsh', model: 'reasoning-model' },
  ]
  let revision = 3
  let mapping = { routine: null, standard: null, complex: null }
  let submitted: Record<string, unknown> | undefined
  const client = createApiClient('http://panel.test', async (_input, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      submitted = body
      revision++
      mapping = body.mapping
    }
    return new Response(JSON.stringify({ ok: true, schema_version: 1, as_of_seq: 5, data: { revision, profiles, mapping } }))
  })
  const view = await renderPanel(<PanelShell activeRoute="settings" serviceConnected onNavigate={() => {}}>
    <ModelRoutingSettings client={client} />
  </PanelShell>)
  try {
    await view.flush()
    const selects = view.findAll('select') as HTMLSelectElement[]
    expect(selects.map((element) => [...element.options].map((option) => option.value))).toEqual([
      ['', 'fast', 'middle', 'reasoner'], ['', 'middle', 'reasoner'], ['', 'reasoner'],
    ])
    await act(async () => {
      selects[2]!.value = 'reasoner'
      selects[2]!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const save = view.findAll('button').find((element) => element.textContent === '保存模型分配')
    await view.click(save!)
    await view.flush()
    expect(submitted).toMatchObject({ expected_revision: 3, mapping: { routine: null, standard: null, complex: 'reasoner' },
      operation_id: expect.stringMatching(/^[0-9a-f-]+$/) })
    expect(view.text()).toContain('下一次派发采用新配置')
  } finally { view.unmount() }
})
