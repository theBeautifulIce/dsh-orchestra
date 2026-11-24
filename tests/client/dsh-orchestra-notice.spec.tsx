// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { ORCHESTRA_MESSAGE_SOURCE } from '../../src/core/dsh-message-source.ts'
import { OrchestraNoticeTail, orchestraNoticeDefinition, registerNativeOrchestraNotices,
  type NativeOrchestraNoticeContext } from '../../src/client/dsh-orchestra-notice.tsx'
import { renderPanel } from './harness.ts'

const notice = { id: 'notice-1', seq: 75, title: '新闻整理：执行受阻',
  text: '新闻整理：执行受阻\n原因：无法访问新闻来源。\n下一步：启用检索工具后重试。' }
const event = { type: 'user/message', seq: notice.seq, surfaceOp: 'append', data: {
  id: notice.id, source: { kind: ORCHESTRA_MESSAGE_SOURCE, form: 'notice', summary: notice.title },
  content: [{ type: 'text', text: notice.text }],
} }

it('projects only durable Orchestra notices and keeps recovery instructions out of the result', () => {
  expect(orchestraNoticeDefinition.match(event)).toEqual({ id: notice.id, role: 'start' })
  const match = { event, location: { kind: 'turn', turn: 4 } }
  const state = orchestraNoticeDefinition.start({ key: 'key', id: notice.id }, match)
  expect(orchestraNoticeDefinition.buildViewNode({ key: 'key', id: notice.id, start: match, state }))
    .toMatchObject({ visibility: 'hidden', target: 'chat', anchorSeq: 75, data: notice })
  for (const source of [{ kind: 'user' }, { kind: 'other-plugin', form: 'notice' },
    { kind: ORCHESTRA_MESSAGE_SOURCE, form: 'report_instruction' }]) {
    expect(orchestraNoticeDefinition.match({ ...event, data: { ...event.data, source } })).toBeNull()
  }
  expect(orchestraNoticeDefinition.match({ ...event, surfaceOp: 'update' })).toBeNull()
})

it.each(['blocked', 'failed', 'cancelled', 'completed'])('shows the recorded outcome when %s ends without final assistant text', async kind => {
  const view = await renderPanel(<OrchestraNoticeTail turn={{ turn: 4, end: { data: { reason: { kind } } }, data: new Map() }}
    useNotices={() => [notice]} />)
  try {
    expect(view.byRole('status')).toHaveLength(1)
    expect(view.text()).toContain('原因：无法访问新闻来源。')
    expect(view.text()).toContain('下一步：启用检索工具后重试。')
    expect(view.text().split(notice.title)).toHaveLength(2)
  } finally { view.unmount() }
})

it('avoids a duplicate fallback after a completed final answer and waits while the model is running', async () => {
  const turn = { turn: 4, end: { data: { reason: { kind: 'completed' } } },
    data: new Map([['turn-tail', { closing: { finalNode: { seq: 83 } } }]]) }
  const view = await renderPanel(<OrchestraNoticeTail turn={turn} useNotices={() => [notice]} />)
  try {
    expect(view.byRole('status')).toHaveLength(0)
    await view.rerender(<OrchestraNoticeTail turn={{ turn: 4, data: new Map() }} useNotices={() => [notice]} />)
    expect(view.byRole('status')).toHaveLength(0)
  } finally { view.unmount() }
})

it('retains distinct task outcomes and renders supplied text as text', async () => {
  const view = await renderPanel(<OrchestraNoticeTail turn={{ turn: 4, end: {}, data: new Map() }}
    useNotices={() => [notice, { id: 'notice-2', seq: 76, title: '第二个任务', text: '<script>run()</script>' }]} />)
  try {
    expect(view.byRole('status')).toHaveLength(2)
    expect(view.text()).toContain('<script>run()</script>')
    expect(view.findAll('script')).toHaveLength(0)
  } finally { view.unmount() }
})

it('uses the rc.5 session-bound turn-tail extension without replacing host renderers', () => {
  const source = { getSnapshot: () => [notice], subscribe: () => () => {} }
  const turnDataSource = vi.fn(() => source)
  const binding = { sessionId: 'source-session' }
  const ready = {
    effect: (register: () => unknown) => register(),
    sessions: { binding: vi.fn(() => binding) },
    uiConversation: { events: { register: vi.fn(() => () => {}) },
      binding: vi.fn(() => ({ target: vi.fn(() => ({ getSnapshot: () => ({ nodes: { turnDataSource } }) })) })) },
    slots: { inject: vi.fn((_slot: string, register: () => unknown) => register()), register: vi.fn() },
  }
  const inject = vi.fn((_names: string[], register: (services: unknown) => unknown) => register(ready))
  registerNativeOrchestraNotices({ inject } as NativeOrchestraNoticeContext)
  expect(inject.mock.calls[0]![0]).toEqual(['slots', 'sessions', 'uiConversation'])
  expect(ready.uiConversation.events.register).toHaveBeenCalledWith(orchestraNoticeDefinition)
  const [slot, component] = ready.slots.register.mock.calls[0]!
  expect(slot).toMatchObject({ name: 'conversation.chat.turnTail', id: 'orchestra-notice' })
  expect(component).toBe(OrchestraNoticeTail)
  expect(slot.inject('source-session').keyedHooks.notices('4')).toBe(source)
  expect(ready.sessions.binding).toHaveBeenCalledWith('source-session')
  expect(turnDataSource).toHaveBeenCalledWith(4, 'orchestra-notice')
})
