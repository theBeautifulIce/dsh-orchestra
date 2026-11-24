import { expect, it, vi } from 'vitest'
import { createSemanticSession, interpretSemanticAdmission, type SemanticInput, type SemanticOutcome } from '../../src/service/semantic-admission.ts'

function input(text: string, message_id = 'u1'): SemanticInput { return { current: { message_id, text }, explicit: false } }
function task(current: SemanticInput, changes: object = {}) {
  return { kind: 'task', relation: 'new', timing: 'immediate', quote: current.current.text, constraints: [], missing: [], ...changes }
}
function draftOf(result: SemanticOutcome) {
  if (!result.draft) throw Error('Expected pending draft')
  return result.draft
}

it('validates semantic source, restriction scope and explicit version before planning', () => {
  const current = input('请出一份周报，别改原件，用流程月报第 2 版')
  const raw = task(current, { constraints: [{ id: 'model-id', kind: 'preserve_input', source_message_id: 'u1', quote: '别改原件', target: '原件' }],
    workflow: { name: '月报', version: '2', quote: '流程月报第 2 版', source_message_id: 'u1' } })
  const out = interpretSemanticAdmission(current, raw)
  expect(out).toMatchObject({ kind: 'ready', request: { workflow: { name: '月报', version: '2' }, requirements_contract: {
    sources: [{ message_id: 'u1', text: current.current.text }], constraints: [{ id: 'c1', target: '原件' }], start_policy: 'immediate',
  } } })
  expect(interpretSemanticAdmission(current, { ...raw, workflow: { name: '月报', version: '3', quote: '流程月报第 2 版', source_message_id: 'u1' } })).toMatchObject({ kind: 'clarify' })
  expect(interpretSemanticAdmission(current, task(current, { constraints: [{ id: 'a', kind: 'read_only', source_message_id: 'notice', quote: '别改原件' }] }))).toMatchObject({ kind: 'clarify' })
  expect(interpretSemanticAdmission(current, task(current, { constraints: [{ id: 'a', kind: 'preserve_input', source_message_id: 'u1', quote: '别改原件', target: 'other.csv' }] }))).toMatchObject({ kind: 'clarify' })
})

it('retains held timing, preserves previous constraints and pin, and allows a clear ordinary continuation without exposing draft IDs', () => {
  const first = input('先不要执行月报，别改原件，用流程月报第 2 版')
  const held = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held', constraints: [
    { id: 'a', kind: 'preserve_input', source_message_id: 'u1', quote: '别改原件', target: '原件' }],
    workflow: { name: '月报', version: '2', quote: '流程月报第 2 版', source_message_id: 'u1' } })))
  const next = { ...input('现在继续月报', 'u2'), draft: held }
  const result = interpretSemanticAdmission(next, task(next, { relation: 'continue', draft_revision: held.revision, continuation: 'resume' }))
  expect(result).toMatchObject({ kind: 'ready', request: { workflow: { version: '2' }, requirements_contract: { constraints: [
    { kind: 'preserve_input', source_message_id: 'u1', target: '原件' }], timing: { source_message_id: 'u2' } } } })
  expect(interpretSemanticAdmission(next, task(next, { relation: 'continue', draft_revision: held.revision + 1, continuation: 'resume' }))).toMatchObject({ kind: 'clarify' })
})

it('carries only the actual missing material answer forward, and cannot turn a supplement to a held task into a start', () => {
  const first = input('请整理月报')
  const initial = draftOf(interpretSemanticAdmission(first, task(first, { missing: ['materials'] })))
  const next = { ...input('使用账本.csv', 'u2'), draft: initial }
  const raw = task(next, { relation: 'continue', draft_revision: initial.revision, continuation: 'supply', answer: { slot: 'materials', value: '账本.csv', quote: '使用账本.csv' } })
  expect(interpretSemanticAdmission(next, raw)).toMatchObject({ kind: 'ready', request: { goal: '请整理月报\n使用账本.csv',
    requirements_contract: { timing: { source_message_id: 'u1' } } } })
  expect(interpretSemanticAdmission({ ...next, draft: { ...initial, timing: 'held' } }, raw)).toMatchObject({ kind: 'held' })
  expect(interpretSemanticAdmission(next, { ...raw, answer: { slot: 'result', value: '账本.csv', quote: '使用账本.csv' } })).toMatchObject({ kind: 'clarify' })
})

it('treats unrelated self-contained work separately while a previous task remains held', () => {
  const a = input('先不要执行月报')
  const old = draftOf(interpretSemanticAdmission(a, task(a, { timing: 'held' })))
  const b = { ...input('请编写旅行预算', 'u2'), draft: old }
  expect(interpretSemanticAdmission(b, task(b, { independent: { action_quote: '编写', subject_quote: '旅行预算' } }))).toMatchObject({
    kind: 'ready', request: { goal: '请编写旅行预算' }, draft: { id: old.id },
  })
  expect(interpretSemanticAdmission(b, task(b))).toMatchObject({ kind: 'clarify', message: expect.stringContaining('另开') })
})

it('requires the existing narrow user request to expose private notes and distinguishes plan-only from held', () => {
  const read = input('你好')
  expect(interpretSemanticAdmission(read, { kind: 'brain_notes', quote: '你好' })).toMatchObject({ kind: 'conversation' })
  const plan = input('先出计划，等我确认后再执行')
  expect(interpretSemanticAdmission(plan, task(plan, { timing: 'plan_only' }))).toMatchObject({ kind: 'ready', request: { requirements_contract: { start_policy: 'plan_only' } } })
  expect(interpretSemanticAdmission(plan, task(plan, { timing: 'held' }))).toMatchObject({ kind: 'held' })
})

it('isolates workspace drafts, ignores bare acknowledgment and discards stale asynchronous results', async () => {
  const session = createSemanticSession()
  const ask = vi.fn(async (i: SemanticInput) => task(i, { timing: 'held' }))
  let current = true
  const request = (text: string, id: string, identity = 'workspace/session') => ({ identity, requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() { if (!current) throw Error('stale') } })
  await session.admit(request('先别执行月报', 'a'), ask)
  expect(await session.admit(request('收到', 'b'), ask)).toMatchObject({ kind: 'conversation' })
  expect(ask).toHaveBeenCalledTimes(1)
  await session.admit(request('出个周报', 'c', 'other/session'), ask)
  expect(ask.mock.calls.at(-1)?.[0].draft).toBeUndefined()
  const delayed = Promise.withResolvers<unknown>()
  const pending = session.admit(request('出日报', 'd'), async () => delayed.promise)
  current = false
  delayed.resolve(task(input('出日报', 'd')))
  await expect(pending).rejects.toThrow('stale')
})

it('keeps held A and its restrictions when unrelated B also needs a pending draft', () => {
  const first = input('暂缓月报，保留 ledger.csv')
  const a = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held', constraints: [
    { id: 'a', kind: 'preserve_input', source_message_id: 'u1', quote: '保留 ledger.csv', target: 'ledger.csv' }],
    workflow: { name: '月报', quote: '暂缓月报', source_message_id: 'u1' } })))
  const second = { ...input('先别编写旅行预算', 'u2'), draft: a }
  const result = interpretSemanticAdmission(second, task(second, { timing: 'held', independent: { action_quote: '编写', subject_quote: '旅行预算' } }))
  expect(result).toMatchObject({ kind: 'clarify', draft: { id: a.id, constraints: [{ target: 'ledger.csv' }], workflow: { name: '月报' } } })
  const third = { ...input('现在继续月报', 'u3'), draft: result.draft! }
  expect(interpretSemanticAdmission(third, task(third, { relation: 'continue', draft_revision: a.revision, continuation: 'resume' }))).toMatchObject({
    kind: 'ready', request: { workflow: { name: '月报' }, requirements_contract: { constraints: [{ target: 'ledger.csv' }] } },
  })
})

it('does not silently drop an unresolved original boundary on a later model response', () => {
  const first = input('整理报告，禁止任何持久化')
  const a = draftOf(interpretSemanticAdmission(first, task(first, { missing: ['constraints'], unresolved: [
    { source_message_id: 'u1', quote: '禁止任何持久化' } ] })))
  const second = { ...input('继续', 'u2'), draft: a }
  const result = interpretSemanticAdmission(second, task(second, { relation: 'continue', draft_revision: a.revision, continuation: 'resume' }))
  expect(result).toMatchObject({ kind: 'clarify', draft: { missing: ['constraints'], unresolved: [{ quote: '禁止任何持久化' }] } })
})


it('keeps an unresolved persistence boundary when a model relabels the same old quote after only 继续', () => {
  const first = input('整理报告，禁止任何持久化')
  const original = draftOf(interpretSemanticAdmission(first, task(first, { missing: ['constraints'], unresolved: [
    { source_message_id: 'u1', quote: '禁止任何持久化' } ] })))
  const next = { ...input('继续', 'u2'), draft: original }
  const reinterpreted = task(next, { relation: 'continue', draft_revision: original.revision,
    continuation: 'resume', constraints: [{ id: 'relabel', kind: 'no_workspace_files',
      source_message_id: 'u1', quote: '禁止任何持久化' }], missing: [], unresolved: [] })
  const result = interpretSemanticAdmission(next, reinterpreted)
  expect(result).toMatchObject({ kind: 'clarify', message: expect.stringContaining('先说明放弃该草稿'),
    draft: { unresolved: [{ source_message_id: 'u1', quote: '禁止任何持久化' }], missing: ['constraints'] } })
})

it('retains the current restriction on a generic clarification of a held draft across three human turns', () => {
  const first = input('生成月报，先别执行')
  const a = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held' })))
  const second = { ...input('不准任何持久化', 'u2'), draft: a }
  const b = draftOf(interpretSemanticAdmission(second, { kind: 'clarify', missing: ['constraints'] }))
  expect(b.sources.map(source => source.message_id)).toEqual(['u1', 'u2'])
  expect(b.revision).toBe(a.revision + 1)
  expect(b.timing).toBe('held')
  const third = { ...input('继续', 'u3'), draft: b }
  expect(interpretSemanticAdmission(third, task(third, { relation: 'continue', draft_revision: b.revision,
    continuation: 'resume', constraints: [] }))).toMatchObject({ kind: 'clarify', draft: {
      sources: [{ message_id: 'u1' }, { message_id: 'u2' }, { message_id: 'u3' }],
      unresolved: [{ source_message_id: 'u2', quote: '不准任何持久化' }],
    } })
})

it.each([
  { kind: 'unsupported-response' },
  { kind: 'task', relation: 'continue', timing: 'immediate', quote: '模型编造的引用', draft_revision: 1,
    continuation: 'resume', constraints: [] },
])('keeps an invalid interpretation from consuming and losing a new human restriction', raw => {
  const first = input('生成月报，先别执行')
  const a = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held' })))
  const second = { ...input('不准任何持久化', 'u2'), draft: a }
  const b = draftOf(interpretSemanticAdmission(second, raw))
  expect(b.sources.at(-1)).toEqual(second.current)
  expect(b.requires_restatement).toBe(true)
  const third = { ...input('继续', 'u3'), draft: b }
  expect(interpretSemanticAdmission(third, task(third, { relation: 'continue', draft_revision: b.revision,
    continuation: 'resume', constraints: [] }))).toMatchObject({ kind: 'clarify' })
})

it('preserves a new human restriction when its model call fails while an earlier task is held', async () => {
  const session = createSemanticSession()
  const request = (text: string, id: string) => ({ identity: 'one', requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  await session.admit(request('生成月报，先别执行', 'u1'), async i => task(i, { timing: 'held' }))
  await expect(session.admit(request('不准任何持久化', 'u2'), async () => { throw Error('provider offline') })).rejects.toThrow('provider offline')
  const next = await session.admit(request('继续', 'u3'), async i => task(i, { relation: 'continue', draft_revision: i.draft!.revision,
    continuation: 'resume', constraints: [] }))
  expect(next).toMatchObject({ kind: 'clarify', draft: { requires_restatement: true,
    unresolved: expect.arrayContaining([{ source_message_id: 'u2', quote: '不准任何持久化' }]) } })
})

it('ignores a late provider failure after the session has moved to another workspace draft', async () => {
  const session = createSemanticSession()
  const request = (text: string, id: string, identity: string) => ({ identity, requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  await session.admit(request('暂缓月报', 'a1', 'workspace-a'), async i => task(i, { timing: 'held' }))
  const provider = Promise.withResolvers<unknown>()
  const late = session.admit(request('不准持久化', 'a2', 'workspace-a'), async () => provider.promise).catch(error => error)
  await session.admit(request('暂缓旅行预算', 'b1', 'workspace-b'), async i => task(i, { timing: 'held' }))
  provider.reject(Error('late failure'))
  await late
  const resumed = await session.admit(request('继续旅行预算', 'b2', 'workspace-b'), async i => {
    expect(i.draft?.sources.map(source => source.message_id)).toEqual(['b1'])
    expect(i.draft?.requires_restatement).toBeUndefined()
    return task(i, { relation: 'continue', draft_revision: i.draft!.revision, continuation: 'resume' })
  })
  expect(resumed.kind).toBe('ready')
})
