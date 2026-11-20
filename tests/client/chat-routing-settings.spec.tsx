// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { PanelHost } from '../../src/client/panel-host.tsx'
import type { FetchLike } from '../../src/client/api/client.ts'
import { ChatRoutingSettings } from '../../src/client/panel/chat-routing-settings.tsx'
import { createApiClient } from '../../src/client/api/client.ts'
import { deferred, renderPanel } from './harness.ts'

function success(data: unknown) {
  return Response.json({ ok: true, schema_version: 1, as_of_seq: 0, data })
}

it('shows the profile preference only when the host reports native chat routing', async () => {
  let supported = false
  const paths: string[] = []
  const fetcher: FetchLike = async (input) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path === '/health') return success({ native_chat_routing_enabled: supported })
    if (path === '/v1/settings/chat-routing') return success({ enabled: true, revision: 0 })
    return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const panel = () => <PanelHost baseUrl="http://panel.test" fetcher={fetcher} initialRoute="settings" />
  const view = await renderPanel(panel())
  try {
    expect(view.byRole('switch')).toHaveLength(0)
    expect(paths).not.toContain('/v1/settings/chat-routing')
    supported = true
    await view.rerender(<PanelHost key="supported" baseUrl="http://panel.test" fetcher={fetcher} initialRoute="settings" />)
    await view.flush()
    expect((view.byRole('switch')[0] as HTMLInputElement).checked).toBe(true)
    expect(view.text()).toContain('此 Desktop 用户的会话')
    expect(view.text()).toContain('/orchestra 任务内容')
    expect(view.findAll('h2')[0]?.textContent).toBe('聊天任务自动接管')
  } finally { view.unmount() }
})

it('waits for confirmed writes and can recover from an ambiguous save or invalid read', async () => {
  const firstRead = deferred<Response>()
  const firstWrite = deferred<Response>()
  let read = 0
  const writes: unknown[] = []
  const client = createApiClient('http://panel.test', async (_input, init) => {
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      if (writes.length === 1) return firstWrite.promise
      return success({ enabled: true, revision: 2 })
    }
    if (++read === 1) return firstRead.promise
    return read === 2 ? success({ enabled: 'false', revision: 1 }) : success({ enabled: false, revision: 1 })
  })
  const settings = (writable: boolean) => <ChatRoutingSettings client={client} writable={writable} reloadVersion={0} />
  const view = await renderPanel(settings(false))
  const toggle = () => view.byRole('switch')[0] as HTMLInputElement
  const retry = () => view.findAll('button').find((item) => item.textContent === '重新读取自动接管设置')!
  try {
    expect(view.text()).toContain('正在读取自动接管设置')
    expect(toggle()).toBeUndefined()
    firstRead.resolve(success({ enabled: true, revision: 0 }))
    await view.flush()
    expect(toggle().disabled).toBe(true)
    await view.click(toggle())
    expect(writes).toHaveLength(0)
    await view.rerender(settings(true))
    await view.click(toggle())
    expect(writes).toEqual([{ enabled: false, expected_revision: 0 }])
    expect(view.text()).toContain('正在确认设置是否已保存')
    expect(toggle()).toBeUndefined()
    firstWrite.reject(new Error('lost response'))
    await view.flush()
    expect(view.text()).toContain('暂时无法确认设置是否已保存')
    expect(toggle()).toBeUndefined()
    await view.click(retry())
    expect(view.text()).toContain('暂时无法读取自动接管设置')
    expect(toggle()).toBeUndefined()
    await view.click(retry())
    expect(toggle().checked).toBe(false)
    await view.click(toggle())
    expect(writes[1]).toEqual({ enabled: true, expected_revision: 1 })
    expect(toggle().checked).toBe(true)
  } finally { view.unmount() }
})
