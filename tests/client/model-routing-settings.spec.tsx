// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { ModelRoutingSettings } from '../../src/client/panel/model-routing-settings.tsx'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { renderPanel } from './harness.ts'

it('刷新后逐字段确认并发冲突，保留不相交的修改和其他人的最新配置', async () => {
  const reasoning = { defaultEffort: 'low', efforts: ['low', 'high', 'max'].map((id) => ({ id, name: id })) }
  const profiles = ['one', 'two'].map((provider) => ({ provider, ref: provider + '/same', model: 'same',
    host_capacity: 'standard', capacity: 'standard', reasoning }))
  let state = {
    profiles, revision: 1, planner_model_configurable: true,
    planner_model: null as { ref: string; effort: string | null } | null,
    mapping: { routine: 'one/same' as string | null, standard: null, advanced: null, complex: null, expert: null },
    model_notes: [{ ref: 'one/same', note: '原说明' }],
    model_capacities: [] as { ref: string; capacity: string }[],
    model_reasoning_defaults: [] as { ref: string; effort: string }[],
  }
  const posts: unknown[] = []
  const client = createApiClient('http://panel.test', async (_input, init) => {
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(init.body))
      posts.push(payload)
      state = { ...state, ...payload, revision: state.revision + 1 }
    }
    return Response.json({ ok: true, schema_version: 1, as_of_seq: state.revision, data: state })
  })
  const view = await renderPanel(<PanelShell activeRoute="settings" serviceConnected onNavigate={() => {}}>
    <ModelRoutingSettings client={client} />
  </PanelShell>)
  const select = (id: string) => view.container.querySelector<HTMLSelectElement>(id)!
  const button = (text: string) => view.findAll('button').find((element) => element.textContent === text)! as HTMLButtonElement
  const note = () => view.findAll('fieldset input')[0] as HTMLInputElement
  async function change(id: string, value: string) {
    await act(async () => {
      select(id).value = value
      select(id).dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  const resolve = async (label: string, action: string) => {
    const row = view.findAll('li').find((item) => item.querySelector('strong')?.textContent === label)!
    await view.click([...row.querySelectorAll('button')].find((item) => item.textContent === action)!)
  }
  try {
    await view.flush()
    await change('#model-planner-mode', 'fixed')
    await change('#model-planner-effort', 'high')
    await change('#model-route-routine', 'two/same')
    await change('#model-profile-effort', 'max')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note(), '我的说明')
      note().dispatchEvent(new Event('input', { bubbles: true }))
    })
    state = { ...state, revision: 2, planner_model: { ref: 'two/same', effort: 'low' },
      mapping: { ...state.mapping, routine: null }, model_notes: [{ ref: 'one/same', note: '他人说明' }],
      model_capacities: [{ ref: 'one/same', capacity: 'expert' }] }
    await view.click(button('重新读取'))
    await view.flush()
    expect(view.text()).toContain('模型设置有冲突')
    expect(view.text()).toContain('他人说明')
    expect(button('保存模型分配').disabled).toBe(true)
    await view.click(button('保存模型分配'))
    expect(posts).toHaveLength(0)

    await resolve('主脑模型', '保留我的修改')
    await resolve('常规档分配', '采用最新设置')
    await resolve('one / same · 用途说明', '采用最新设置')
    expect(note().value).toBe('他人说明')
    expect(select('#model-profile-capacity').value).toBe('expert')
    expect(select('#model-profile-effort').value).toBe('max')
    expect(select('#model-route-routine').value).toBe('')
    expect(button('保存模型分配').disabled).toBe(false)
    await view.click(button('保存模型分配'))
    await view.flush()
    expect(posts[0]).toMatchObject({ expected_revision: 2, planner_model: { ref: 'one/same', effort: 'high' },
      mapping: { routine: null }, model_reasoning_defaults: [{ ref: 'one/same', effort: 'max' }] })
    expect(posts[0]).not.toHaveProperty('model_notes')
    expect(posts[0]).not.toHaveProperty('model_capacities')
  } finally { view.unmount() }
})

it('主脑独立跟随或选择官方账户路由，刷新保留草稿并可清除已失效配置', async () => {
  const flash = { model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', capacity: 'standard',
    reasoning: { defaultEffort: 'high', efforts: ['off', 'low', 'high', 'max'].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) })) } }
  const official = { ...flash, ref: 'deepseek-official/deepseek-flash', provider: 'deepseek-official', provider_name: 'DeepSeek' }
  const account = { ...flash, ref: 'deepseek-account/deepseek-flash', provider: 'deepseek-account', provider_name: 'DeepSeek Account' }
  let profiles = [official, account]
  let plannerModel: { ref: string; effort: string | null } | null = null
  let configurable = true
  let revision = 0
  const submissions: unknown[] = []
  const mapping = { routine: null, standard: null, advanced: null, complex: null, expert: null }
  const client = createApiClient('http://panel.test', async (_input, init) => {
    if (init?.method === 'POST') {
      const payload = JSON.parse(String(init.body))
      submissions.push(payload)
      plannerModel = payload.planner_model
      revision++
    }
    return Response.json({ ok: true, schema_version: 1, as_of_seq: 1, data: {
      profiles, mapping, revision, planner_model_configurable: configurable, planner_model: plannerModel,
    } })
  })
  const view = await renderPanel(<PanelShell activeRoute="settings" serviceConnected onNavigate={() => {}}>
    <ModelRoutingSettings client={client} />
  </PanelShell>)
  const select = (id: string) => view.container.querySelector<HTMLSelectElement>(id)
  const button = (text: string) => view.findAll('button').find((element) => element.textContent === text)!
  async function change(id: string, value: string) {
    const element = select(id)!
    await act(async () => {
      element.value = value
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  try {
    await view.flush()
    expect(select('#model-planner-mode')?.value).toBe('session')
    expect(select('#model-planner-provider')).toBeNull()
    await change('#model-planner-mode', 'fixed')
    expect([...select('#model-planner-provider')!.options].map(({ label }) => label)).toEqual([
      'DeepSeek (deepseek-official)', 'DeepSeek Account (deepseek-account)',
    ])
    await change('#model-planner-provider', account.provider)
    expect(select('#model-planner-model')?.value).toBe(account.ref)
    expect([...select('#model-planner-effort')!.options].map(({ label }) => label))
      .toEqual(['宿主默认（High）', 'Off', 'Low', 'High', 'Max'])
    await change('#model-planner-effort', 'max')
    await view.click(button('重新读取'))
    await view.flush()
    expect(select('#model-planner-effort')?.value).toBe('max')
    await view.click(button('保存模型分配'))
    await view.flush()
    expect(submissions[0]).toMatchObject({ expected_revision: 0, mapping, planner_model: { ref: account.ref, effort: 'max' } })
    profiles = [{ ...official, reasoning: { defaultEffort: 'off', efforts: [{ id: 'off', name: 'Off' }] } }]
    await view.click(button('重新读取'))
    await view.flush()
    expect(view.text()).toContain('当前目录没有已选主脑模型')
    await change('#model-planner-provider', official.provider)
    expect(select('#model-planner-effort')).toBeNull()
    expect(view.text()).toContain('该模型只提供 Off')
    await change('#model-planner-mode', 'session')
    await view.click(button('保存模型分配'))
    await view.flush()
    expect(submissions[1]).toMatchObject({ expected_revision: 1, mapping, planner_model: null })
    configurable = false
    await view.click(button('重新读取'))
    await view.flush()
    expect(select('#model-planner-mode')).toBeNull()
  } finally { view.unmount() }
})

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
    expect(view.findAll('fieldset input')).toHaveLength(1)
    await change('#model-profile-provider', 'second')
    expect(select('#model-profile-model').value).toBe('second/same')
    await change('select[aria-label="second / same 最大能力"]', 'expert')
    await change('#model-profile-effort', 'turbo')
    await change('#model-route-expert', 'second/same')
    expect([...select('#model-effort-expert').options].map(({ value, label }) => [value, label])).toEqual([
      ['', '模型默认（Turbo）'], ['deep', 'Deep'], ['turbo', 'Turbo'],
    ])
    await change('#model-effort-expert', 'deep')
    await change('#model-profile-provider', 'first')
    expect(select('#model-profile-effort')).toBeNull()
    await view.click(button('重新读取'))
    await view.flush()
    await change('#model-profile-provider', 'second')
    expect(select('#model-profile-effort').value).toBe('turbo')
    expect(select('#model-effort-expert').value).toBe('deep')
    await view.click(button('保存模型分配'))
    await view.flush()
    expect(submissions[1]).toMatchObject({ expected_revision: 1, mapping: { expert: 'second/same' },
      reasoning_efforts: { expert: 'deep' }, model_reasoning_defaults: [{ ref: 'second/same', effort: 'turbo' }] })
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
    const selects = view.findAll('select[id^="model-route-"]') as HTMLSelectElement[]
    expect(selects.map((element) => [...element.options].map((option) => option.value))).toEqual([
      ['', 'fast', 'middle', 'analyst', 'reasoner', 'expert'], ['', 'middle', 'analyst', 'reasoner', 'expert'],
      ['', 'analyst', 'reasoner', 'expert'], ['', 'reasoner', 'expert'], ['', 'expert'],
    ])
    expect(view.findAll('fieldset input')).toHaveLength(1)
    await act(async () => {
      const editor = view.container.querySelector<HTMLSelectElement>('#model-profile-model')!
      editor.value = 'reasoner'
      editor.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const note = (view.findAll('fieldset input') as HTMLInputElement[])[0]!
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
