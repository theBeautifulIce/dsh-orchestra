// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { PanelHost } from '../../src/client/panel-host.tsx'
import { createApiClient, type FetchLike } from '../../src/client/api/client.ts'
import { ExecutionPermissionSettings } from '../../src/client/panel/execution-permission-settings.tsx'
import { deferred, renderPanel } from './harness.ts'

const success = (data: unknown) => Response.json({ ok: true, schema_version: 1, as_of_seq: 0, data })

it('执行权限跟随独立宿主能力显示，四个模式和限制可在设置中找到', async () => {
  const paths: string[] = []
  const fetcher: FetchLike = async input => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path === '/health') return success({ native_execution_permissions_enabled: true, native_chat_routing_enabled: false })
    if (path === '/v1/settings/execution-permissions') return success({ mode: 'full', revision: 0 })
    return new Response('', { headers: { 'content-type': 'text/event-stream' } })
  }
  const view = await renderPanel(<PanelHost baseUrl="http://panel.test" fetcher={fetcher} initialRoute="settings" />)
  try {
    await view.flush()
    const select = view.container.querySelector<HTMLSelectElement>('select[aria-label="执行权限模式"]')!
    expect(select.value).toBe('full')
    expect([...select.options].map(option => option.value)).toEqual(['full', 'inherit', 'brain', 'user'])
    expect(view.text()).toContain('全权限设置不会绕过节点限制')
    expect(paths).not.toContain('/v1/settings/chat-routing')
    await view.click(view.findAll('nav button').find(button => button.textContent === '执行权限')!)
    expect(document.activeElement?.id).toBe('execution-permissions-title')
  } finally { view.unmount() }
})

it('设置写入须得到确切回执，冲突或失联后重新读取真实版本再操作', async () => {
  const pending = deferred<Response>()
  const writes: unknown[] = []
  let reads = 0
  const client = createApiClient('http://panel.test', async (_input, init) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return writes.length === 1 ? pending.promise : success({ mode: 'user', revision: 3 })
    }
    return success(++reads === 1 ? { mode: 'full', revision: 0 } : { mode: 'brain', revision: 2 })
  })
  const view = await renderPanel(<ExecutionPermissionSettings client={client} reloadVersion={0} writable />)
  const select = () => view.container.querySelector<HTMLSelectElement>('select')!
  const change = async (value: string) => act(async () => {
    select().value = value
    select().dispatchEvent(new Event('change', { bubbles: true }))
  })
  try {
    await view.flush()
    await change('inherit')
    expect(writes).toEqual([{ mode: 'inherit', expected_revision: 0 }])
    expect(select()).toBeNull()
    pending.resolve(success({ mode: 'inherit', revision: 2 }))
    await view.flush()
    expect(view.text()).toContain('无法确认设置是否已保存')
    await view.click(view.findAll('button').find(button => button.textContent === '重新读取执行权限设置')!)
    expect(select().value).toBe('brain')
    await change('user')
    await view.flush()
    expect(writes[1]).toEqual({ mode: 'user', expected_revision: 2 })
    expect(select().value).toBe('user')
  } finally { view.unmount() }
})
