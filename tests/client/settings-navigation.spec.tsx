// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { PanelApp } from '../../src/client/panel/app.tsx'
import { deferred, renderPanel } from './harness.ts'

function success(data: unknown) {
  return Response.json({ ok: true, schema_version: 1, as_of_seq: 1, data })
}

it('设置子菜单跳到对应标题，重复点击仍能聚焦，并保留未保存的输入', async () => {
  const defaults = { task_seconds: 30, workflow_seconds: 45, idle_seconds: 30, stage_seconds: 120, request_seconds: 180 }
  const limits = { task_seconds: 600, workflow_seconds: 600, idle_seconds: 300, stage_seconds: 600, request_seconds: 900 }
  const client = createApiClient('http://panel.test', async (input) => {
    if (new URL(String(input)).pathname === '/v1/settings/planning-timeouts') {
      return success({ revision: 0, values: defaults, defaults, limits, overridden: false, legacy_timeout_ms: null,
        branches: { task: 'streaming', automatic_workflow: 'streaming', standalone_workflow: 'streaming' } })
    }
    return success({ items: [], next_cursor: null })
  })
  const view = await renderPanel(<PanelApp client={client} serviceConnected planningTimeoutsEnabled />)
  const navButton = (label: string) => view.findAll('nav button').find((button) => button.textContent === label)!
  try {
    const settings = navButton('设置')
    expect(settings.getAttribute('aria-expanded')).toBe('false')
    expect(view.findAll('[aria-label="设置子菜单"]')).toHaveLength(0)
    await view.click(settings)
    await view.flush()
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    expect(view.findAll('.ops-settings-menu button').map((button) => button.textContent)).toEqual([
      '规划时限', '显示偏好', '服务状态', '任务记忆',
    ])
    const planning = navButton('规划时限')
    await view.click(planning)
    expect(document.activeElement?.id).toBe('planning-timeouts-title')
    expect(planning.getAttribute('aria-current')).toBe('location')
    const input = view.container.querySelector<HTMLInputElement>('input[type=number]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '31')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await view.click(navButton('服务状态'))
    expect(document.activeElement?.id).toBe('settings-title')
    expect(planning.hasAttribute('aria-current')).toBe(false)
    for (let visit = 0; visit < 2; visit += 1) {
      input.focus()
      await view.click(planning)
      expect(document.activeElement?.id).toBe('planning-timeouts-title')
      expect(input.value).toBe('31')
    }
    expect(window.location.hash).toBe('')
    await view.click(navButton('任务'))
    expect(view.findAll('[aria-label="设置子菜单"]')).toHaveLength(0)
    expect(navButton('任务').getAttribute('aria-current')).toBe('page')
  } finally { view.unmount() }
})

it('模型菜单仅指向当前宿主实际渲染的标题', async () => {
  const read = deferred<Response>()
  const client = createApiClient('http://panel.test', () => read.promise)
  const view = await renderPanel(<PanelApp client={client} initialRoute="settings" serviceConnected modelRoutingEnabled
    additionalScreens={{ settings: <p>宿主设置</p> }} />)
  const sections = () => view.findAll('.ops-settings-menu button')
  try {
    expect(sections().map((button) => button.textContent)).toEqual(['显示偏好', '任务记忆'])
    read.resolve(success({ revision: 0, profiles: [], planner_model_configurable: false,
      mapping: { routine: null, standard: null, advanced: null, complex: null, expert: null } }))
    await view.flush()
    expect(sections().map((button) => button.textContent)).toEqual(['子模型及能力', '显示偏好', '任务记忆'])
    for (const button of sections()) {
      const target = button.getAttribute('aria-controls')
      await view.click(button)
      expect(document.activeElement?.id).toBe(target)
    }
  } finally { view.unmount() }
})
