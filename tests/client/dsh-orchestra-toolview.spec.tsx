// @vitest-environment jsdom
import { Context, type Plugin } from '@deepseek-ai/cordis'
import { createElement, type ReactElement } from 'react'
import { expect, it } from 'vitest'
import { apply, inject } from '../../src/client/index.tsx'
import { renderPanel } from './harness.ts'

type ToolOwner = {
  toolName: string
  callId: string
  phase: 'preparing' | 'start' | 'result'
  block: { [name: string]: unknown }
}
type Row = (owner: ToolOwner) => ReactElement

it('注册 Desktop 工具卡，只接管 Orchestra 工具并随插件卸载', async () => {
  const host = new Context()
  const rows = new Map<string, Row>([['bash', () => <p>宿主终端工具卡</p>]])
  const slot = 'tool.call.toolview'
  host.provide('slots', {
    inject(name: string, mount: () => unknown) {
      expect(name).toBe(slot)
      return mount()
    },
    register({ name, key }: { name: string; key: string }, component: Row) {
      expect(name).toBe(slot)
      expect(rows.has(key)).toBe(false)
      rows.set(key, component)
      return () => { rows.delete(key) }
    },
  })
  // Mirrors rc.5 renderSlot(name, owner, {entryKey: toolName, fallback}) and the renderer's owner-prop spread.
  const nativeRow = (toolName: string, phase: ToolOwner['phase'], block: ToolOwner['block']) => {
    const component = rows.get(toolName)
    return component ? createElement(component, { toolName, callId: 'call-id', phase, block }) : <p>宿主默认工具卡</p>
  }
  const product = host.plugin({ apply, inject } as unknown as Plugin)
  const args = { argsRaw: '{"run_id":"private-run-id","action":"status"}' }
  const text = 'Orchestra 等待人工处理\n已登记 collection-review.md，仍需核验 summary.md。'
  try {
    await product.await()
    const view = await renderPanel(nativeRow('orchestra_task', 'preparing', { call: args }))
    try {
      expect(view.text()).toBe('Orchestra 正在处理这次操作…')
      await view.rerender(nativeRow('orchestra_task', 'start', { call: args }))
      expect(view.text()).toBe('Orchestra 正在处理这次操作…')
      const historical = { call: args, content: [{ type: 'text', text: '{"status":"blocked_post"}' }] }
      await view.rerender(nativeRow('orchestra_task', 'result', { ...historical, meta: { summary: text } }))
      expect(view.text()).toBe(text)
      expect(view.byRole('status')).toHaveLength(1)

      await view.rerender(nativeRow('orchestra_task', 'result', historical))
      expect(view.text()).toBe('请在 Orchestra 面板查看这次操作的结果。')
      await view.rerender(nativeRow('orchestra_task', 'result', { ...historical, isError: true }))
      expect(view.text()).toBe('Orchestra 未能完成这次操作。请在 Orchestra 面板确认任务状态后再试。')
      expect(view.byRole('alert')).toHaveLength(1)
      await view.rerender(nativeRow('orchestra_task', 'result', { ...historical, isError: true, meta: { summary: '请回到发起任务的会话。' } }))
      expect(view.text()).toBe('请回到发起任务的会话。')
      expect(view.byRole('alert')).toHaveLength(1)

      await view.rerender(nativeRow('bash', 'result', {}))
      expect(view.text()).toBe('宿主终端工具卡')
      await view.rerender(nativeRow('other-tool', 'result', {}))
      expect(view.text()).toBe('宿主默认工具卡')
    } finally { view.unmount() }
  } finally { await product.dispose() }
  expect([...rows.keys()]).toEqual(['bash'])
})
