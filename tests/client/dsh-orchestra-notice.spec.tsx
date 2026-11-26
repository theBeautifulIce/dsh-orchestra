// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { ORCHESTRA_MESSAGE_SOURCE } from '../../src/core/dsh-message-source.ts'
import { OrchestraNoticeTail, OrchestraAttentionNotice, orchestraNoticeDefinition, registerNativeOrchestraNotices,
  type NativeOrchestraNoticeContext } from '../../src/client/dsh-orchestra-notice.tsx'
import { renderPanel } from './harness.ts'
import type { ChatArtifactLink } from '../../src/core/receipt-location.ts'
import type { ChatAttentionLink } from '../../src/core/receipt-location.ts'

const notice = { id: 'notice-1', seq: 75, title: '新闻整理：执行受阻',
  text: '新闻整理：执行受阻\n原因：无法访问新闻来源。\n下一步：启用检索工具后重试。' }
const event = { type: 'user/message', seq: notice.seq, surfaceOp: 'append', data: {
  id: notice.id, source: { kind: ORCHESTRA_MESSAGE_SOURCE, form: 'notice', summary: notice.title },
  content: [{ type: 'text', text: notice.text }],
} }
const artifact: ChatArtifactLink = { title: '最终完整简报', fileName: '会话正文-3.md', location: {
  kind: 'artifact', workspaceId: 'workspace', sessionId: 'source-session', taskId: 'task', runId: 'run',
  artifactId: 'artifact', sha256: 'a'.repeat(64),
} }
const attention: ChatAttentionLink = { title: '执行超时，等待处理', location: {
  kind: 'decision', workspaceId: 'workspace', sessionId: 'source-session', taskId: 'task', runId: 'run', decisionId: 'decision',
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

it('keeps named original artifacts beside a completed final answer and deduplicates by exact recorded version', async () => {
  const turn = { turn: 4, end: { data: { reason: { kind: 'completed' } } },
    data: new Map([['turn-tail', { closing: { finalNode: { seq: 100 } } }]]) }
  const openArtifact = vi.fn(async () => {})
  const secondVersion = { ...artifact, title: '最终完整简报（修订）', location: { ...artifact.location, artifactId: 'revised-artifact', sha256: 'b'.repeat(64) } }
  const view = await renderPanel(<OrchestraNoticeTail turn={turn} openArtifact={openArtifact} useNotices={() => [
    { ...notice, artifacts: [artifact] },
    { ...notice, id: 'retry-notice', seq: 76, artifacts: [artifact, secondVersion] },
  ]} />)
  try {
    expect(view.byRole('status')).toHaveLength(0)
    expect(view.text()).not.toContain('执行受阻')
    expect(view.findAll('a').map(link => link.textContent)).toEqual(['最终完整简报', '最终完整简报（修订）'])
    await view.click(view.findAll('a')[0]!)
    expect(openArtifact).toHaveBeenCalledWith(artifact, expect.any(AbortSignal))
    expect(view.container.innerHTML).not.toMatch(/http:|token|secret/u)
  } finally { view.unmount() }
})

it('restores only validated artifact identities from durable source metadata', () => {
  const withArtifacts = { ...event, data: { ...event.data, source: { ...event.data.source, artifacts: [artifact] } } }
  const restored = orchestraNoticeDefinition.start({ key: 'notice', id: notice.id }, { event: withArtifacts, location: {} })
  expect(restored.artifacts).toEqual([artifact])
  for (const invalid of [{ ...artifact, url: 'http://unsafe.invalid' }, { ...artifact, location: { ...artifact.location, sha256: 'invalid' } }]) {
    const state = orchestraNoticeDefinition.start({ key: 'notice', id: notice.id }, {
      event: { ...withArtifacts, data: { ...withArtifacts.data, source: { ...withArtifacts.data.source, artifacts: [invalid] } } }, location: {},
    })
    expect(state.artifacts).toBeUndefined()
  }
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
  const [slot, component] = ready.slots.register.mock.calls.find(([entry]) => entry.name === 'conversation.chat.turnTail')!
  expect(slot).toMatchObject({ name: 'conversation.chat.turnTail', id: 'orchestra-notice' })
  expect(component).toBe(OrchestraNoticeTail)
  expect(slot.inject('source-session').keyedHooks.notices('4')).toBe(source)
  expect(ready.sessions.binding).toHaveBeenCalledWith('source-session')
  expect(turnDataSource).toHaveBeenCalledWith(4, 'orchestra-notice')
  expect(ready.slots.register.mock.calls.find(([entry]) => entry.name === 'conversation.chat.node'))
    .toMatchObject([{ name: 'conversation.chat.node', key: 'orchestra-notice' }, OrchestraAttentionNotice])
})

it('publishes a visible pending-decision node before turn/end and keeps its action after an assistant answer', async () => {
  const withAttention = { ...event, data: { ...event.data, source: { ...event.data.source, attentionLinks: [attention] } } }
  const match = { event: withAttention, location: { kind: 'step', turn: { turn: 4 }, step: { step: 2 } } }
  const state = orchestraNoticeDefinition.start({ key: 'key', id: notice.id }, match)
  const node = orchestraNoticeDefinition.buildViewNode({ key: 'key', id: notice.id, start: match, state })!
  expect(node.visibility).toBe('visible')
  const sessionSnapshot = { byId: { 'source-session': { id: 'source-session', retainedBy: { mainView: 1 } } } }
  const workspaceSnapshot = { items: [{ workspaceId: 'workspace', sessionIds: ['source-session'] }], archivedSessionIds: [] }
  const sources = { sessions: { list: { getSnapshot: () => sessionSnapshot, subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => workspaceSnapshot, subscribe: () => () => {} } } }
  const openLocation = vi.fn(async () => {})
  const view = await renderPanel(<OrchestraAttentionNotice node={node} sources={sources} openLocation={openLocation} />)
  try {
    expect(view.byRole('status')).toHaveLength(1)
    const action = view.findAll('button').find(button => button.textContent === '前往审批中心')!
    expect(action).toBeDefined()
    await view.click(action)
    expect(openLocation).toHaveBeenCalledWith(attention.location)
    await view.rerender(<><div hidden data-turn-process-hidden><OrchestraAttentionNotice node={node} sources={sources} openLocation={openLocation} /></div>
      <OrchestraNoticeTail turn={{ turn: 4, end: { data: { reason: { kind: 'completed' } } },
        data: new Map([['turn-tail', { closing: { finalNode: { seq: 100 } } }]]) }} sources={sources}
        openLocation={openLocation} useNotices={() => [state]} /></>)
    const visible = view.findAll('button').filter(button => button.textContent === '前往审批中心' && !button.closest('[hidden]'))
    expect(visible).toHaveLength(1)
    await view.click(visible[0]!)
    expect(openLocation).toHaveBeenCalledTimes(2)
    expect(openLocation).toHaveBeenLastCalledWith(attention.location)
  } finally { view.unmount() }
})

it('keeps one named approval at the completed turn tail and suppresses out-of-scope or ordinary messages', async () => {
  const turn = { turn: 4, end: { data: { reason: { kind: 'completed' } } },
    data: new Map([['turn-tail', { closing: { finalNode: { seq: 100 } } }]]) }
  const sessionSnapshot = { byId: { 'source-session': { id: 'source-session', retainedBy: { mainView: 1 } } } }
  const workspaceSnapshot = { items: [{ workspaceId: 'workspace', sessionIds: ['source-session'] }], archivedSessionIds: [] }
  const sources = { sessions: { list: { getSnapshot: () => sessionSnapshot, subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => workspaceSnapshot, subscribe: () => () => {} } } }
  const named = { ...attention, title: '批准预算分析' }
  const unrelated = { ...named, location: { ...named.location, sessionId: 'different-session' } }
  const wrongWorkspace = { ...named, location: { ...named.location, workspaceId: 'other-workspace' } }
  const openLocation = vi.fn(async () => {})
  const render = (useNotices: () => Array<typeof notice & { attentionLinks?: ChatAttentionLink[] }>) =>
    <OrchestraNoticeTail turn={turn} sources={sources} openLocation={openLocation} useNotices={useNotices} />
  const view = await renderPanel(render(() => [
    { ...notice, attentionLinks: [named, unrelated, wrongWorkspace] },
    { ...notice, id: 'retry-notice', seq: 76, attentionLinks: [named] },
  ]))
  try {
    const actions = view.findAll('button').filter(button => button.textContent === '前往审批中心')
    expect(actions).toHaveLength(1)
    expect(view.text()).toContain(named.title)
    await view.click(actions[0]!)
    expect(openLocation).toHaveBeenCalledExactlyOnceWith(named.location)
    await view.rerender(render(() => [{ ...notice, attentionLinks: [unrelated, wrongWorkspace] }]))
    expect(view.findAll('button')).toHaveLength(0)
    await view.rerender(render(() => [notice]))
    expect(view.findAll('button')).toHaveLength(0)
    expect(openLocation).toHaveBeenCalledOnce()
  } finally { view.unmount() }
})

it('does not restore actions with arbitrary URLs or hide a legacy text-only result', () => {
  for (const invalid of [{ ...attention, url: 'https://unsafe.invalid' }, { ...attention, location: { ...attention.location, command: 'approve' } }]) {
    const injected = { ...event, data: { ...event.data, source: { ...event.data.source, attentionLinks: [invalid] } } }
    const match = { event: injected, location: {} }
    const state = orchestraNoticeDefinition.start({ key: 'key', id: notice.id }, match)
    expect(state.attentionLinks).toBeUndefined()
    expect(state.text).toBe(notice.text)
    expect(orchestraNoticeDefinition.buildViewNode({ key: 'key', id: notice.id, start: match, state })?.visibility).toBe('hidden')
  }
})

it.each([undefined, 'completed', 'cancelled', 'blocked'])('keeps a T07 final result and all named original artifacts visible once when the source turn is %s', async kind => {
  const artifacts: ChatArtifactLink[] = [
    { ...artifact, title: '系统风险检查报告', fileName: '会话正文-1.md', location: { ...artifact.location, artifactId: 'risk' } },
    { ...artifact, title: '执行可靠性检查报告', fileName: '会话正文-2.md', location: { ...artifact.location, artifactId: 'reliability' } },
    { ...artifact, title: '用户体验检查报告', fileName: '会话正文-3.md', location: { ...artifact.location, artifactId: 'experience' } },
  ]
  const turn = { turn: 4, ...(kind && { end: { data: { reason: { kind } } } }),
    data: new Map([['turn-tail', { closing: { finalNode: { seq: 100 } } }]]) }
  const withFinal = { ...event, data: { ...event.data, source: { ...event.data.source, final: true, artifacts } } }
  const match = { event: withFinal, location: { kind: 'step', turn, step: { step: 2 } } }
  const state = orchestraNoticeDefinition.start({ key: 'key', id: notice.id }, match)
  const node = orchestraNoticeDefinition.buildViewNode({ key: 'key', id: notice.id, start: match, state })!
  const openArtifact = vi.fn(async () => {})
  if (!turn.end) expect(node.visibility).toBe('visible')
  const view = await renderPanel(turn.end
    ? <OrchestraNoticeTail turn={turn} useNotices={() => [state]} openArtifact={openArtifact} />
    : <OrchestraAttentionNotice node={node} openArtifact={openArtifact} />)
  try {
    expect(view.byRole('status')).toHaveLength(turn.end ? 0 : 1)
    expect(view.findAll('a').map(link => link.textContent)).toEqual(artifacts.map(item => item.title))
    await view.click(view.findAll('a')[2]!)
    expect(openArtifact).toHaveBeenCalledExactlyOnceWith(artifacts[2], expect.any(AbortSignal))
  } finally { view.unmount() }
})

it('keeps the canonical mailbox cause, business excerpt, and original link in active and ended layouts', async () => {
  const title = '合成协作回执'
  const fullArtifact = { ...artifact, title: '会话正文·退款核对原件', fileName: 'refund-check.md' }
  const body = `${title}\n代理 B 未能回应。信箱已按参与方不可用收口。从发出到信箱登记关闭经过 12.865 秒，设置的等待上限为 30 秒。`
  const withReceipt = { ...event, data: { ...event.data, source: { ...event.data.source, summary: title,
    final: true, mailboxReceipt: true, artifacts: [fullArtifact],
    stepExcerpts: [{ title: '退款金额核对', text: '业务节选：账目中可见退款 128.65 元，尚未收到代理 B 的独立核对。', truncated: true }] },
    content: [{ type: 'text', text: body }] } }
  const activeMatch = { event: withReceipt, location: { kind: 'step', turn: { turn: 4 }, step: { step: 2 } } }
  const state = orchestraNoticeDefinition.start({ key: 'notice', id: notice.id }, activeMatch)
  const activeNode = orchestraNoticeDefinition.buildViewNode({ key: 'notice', id: notice.id, start: activeMatch, state })!
  const openArtifact = vi.fn(async () => {})
  const active = await renderPanel(<OrchestraAttentionNotice node={activeNode} openArtifact={openArtifact} />)
  try {
    expect(active.byRole('status')).toHaveLength(1)
    expect(active.text()).toContain('信箱已按参与方不可用收口。')
    expect(active.text()).toContain('经过 12.865 秒，设置的等待上限为 30 秒。')
    expect(active.text()).toContain('退款金额核对 · 步骤原文')
    expect(active.text()).toContain('账目中可见退款 128.65 元')
    expect(active.findAll('a').map(link => link.textContent)).toContain(fullArtifact.title)
    await active.click(active.findAll('a').find(link => link.textContent === fullArtifact.title)!)
    expect(openArtifact).toHaveBeenCalledExactlyOnceWith(fullArtifact, expect.any(AbortSignal))
  } finally { active.unmount() }

  const folded = await renderPanel(<OrchestraAttentionNotice node={activeNode} turnProcess={{ foldable: true }} openArtifact={openArtifact} />)
  try {
    expect(folded.byRole('status')).toHaveLength(1)
    expect(folded.text()).toContain('退款金额核对 · 步骤原文')
    expect(folded.findAll('a').map(link => link.textContent)).toEqual([fullArtifact.title])
  } finally { folded.unmount() }

  const ended = await renderPanel(<OrchestraNoticeTail turn={{ turn: 4, end: { data: { reason: { kind: 'completed' } } },
    data: new Map() }} useNotices={() => [state]} openArtifact={openArtifact} />)
  try {
    expect(ended.byRole('status')).toHaveLength(1)
    expect(ended.text()).toContain('信箱已按参与方不可用收口。')
    expect(ended.text()).toContain('账目中可见退款 128.65 元')
    expect(ended.findAll('a').map(link => link.textContent)).toEqual([fullArtifact.title])
  } finally { ended.unmount() }
})

it('keeps a durable notice visible when optional receipt metadata is malformed', () => {
  const malformed = { ...event, data: { ...event.data, source: { ...event.data.source, final: true, mailboxReceipt: true,
    artifacts: [{ ...artifact, location: { ...artifact.location, sha256: 'wrong' } }],
    attentionLinks: [{ ...attention, location: { ...attention.location, command: 'approve' } }],
    stepExcerpts: [{ title: '不完整节选', text: 123, truncated: true }] } } }
  const match = { event: malformed, location: {} }
  const state = orchestraNoticeDefinition.start({ key: 'notice', id: notice.id }, match)
  expect(state.text).toBe(notice.text)
  expect(state.mailboxReceipt).toBe(true)
  expect(state.artifacts).toBeUndefined()
  expect(state.attentionLinks).toBeUndefined()
  expect(state.stepExcerpts).toBeUndefined()
  expect(orchestraNoticeDefinition.buildViewNode({ key: 'notice', id: notice.id, start: match, state })?.visibility).toBe('visible')
})
