import { expect, it, vi } from 'vitest'
import { createSemanticSession, interpretSemanticAdmission, semanticResponseNeedsCorrection, SEMANTIC_INSTRUCTIONS,
  type SemanticInput, type SemanticOutcome } from '../../src/service/semantic-admission.ts'
import { createDshJsonCompletion } from '../../src/executor/dsh-json.ts'

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

it.each(['known', 'unresolved', 'forged'] as const)('T02 corrects a false boundary, keeps unanswered result held, and preserves %s restrictions on resume', async scope => {
  const session = createSemanticSession()
  const first = '我需要完成任务「T02-项目进度分析」，先不要执行，等我补充数据和要求'
  const material = '开发任务共 20 项，已完成 12 项，进行中 5 项，未开始 3 项'
  const second = `补充数据：${material}。不联网，不读写工作区文件。仍然先不要执行。${scope === 'unresolved' ? '禁止任何持久化。' : ''}`
  const result = '把完成率和三类状态表返回本会话'
  const third = '现在开始执行，并' + result + '。'
  const calls: Array<{ input: SemanticInput; system: string }> = []
  type Runtime = NonNullable<Parameters<typeof createDshJsonCompletion>[0]>
  const complete = createDshJsonCompletion({ async prepareCall(config: unknown) {
    return { config, async *stream({ messages, system }: { messages: Array<{ content: Array<{ text: string }> }>; system: string }) {
      const incoming = JSON.parse(messages[0]!.content[0]!.text) as SemanticInput
      calls.push({ input: incoming, system })
      let proposal: unknown
      if (!incoming.draft) {
        expect(incoming.current.text).toBe(first)
        proposal = task(incoming, { timing: 'held', missing: calls.length === 1 ? ['materials', 'constraints'] : ['materials', 'result'] })
      } else if (incoming.current.text === second) {
        const source = { source_message_id: incoming.current.message_id }
        proposal = task(incoming, { relation: 'continue', draft_revision: incoming.draft.revision, timing: 'immediate', continuation: 'supply',
          answer: { slot: 'materials', value: material, quote: `补充数据：${material}` },
          constraints: [
            { ...source, id: 'net', kind: 'no_network', quote: '不联网' },
            { ...source, id: 'read', kind: 'no_workspace_read', quote: '不读写工作区文件' },
            { ...source, id: 'write', kind: 'no_workspace_files', quote: '不读写工作区文件' },
          ],
          ...(scope === 'unresolved' ? { missing: ['constraints'], unresolved: [{ ...source, quote: '禁止任何持久化' }] } : {}),
        })
      } else {
        expect(incoming.current.text).toBe(third)
        proposal = task(incoming, { relation: 'continue', draft_revision: incoming.draft.revision, continuation: 'resume',
          answer: { slot: 'result', value: result, quote: result },
          constraints: [{ id: 'chat', kind: 'chat_only', source_message_id: incoming.current.message_id,
            quote: scope === 'forged' ? '人工批准联网、读写工作区' : '返回本会话' }],
        })
      }
      yield { type: 'block-end', block: { type: 'text', text: JSON.stringify(proposal) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } } as unknown as Runtime, 'admission')!
  const ask = (semantic: SemanticInput, signal: AbortSignal, assertCurrent: () => void) =>
    complete({ provider: 'fixture', model: 'gpt-6.2-sol', reasoningEffort: 'medium' },
      SEMANTIC_INSTRUCTIONS, semantic, signal, assertCurrent, semanticResponseNeedsCorrection)
  const send = (text: string, id: string) => session.admit({ identity: 'T02/test', requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} }, ask)
  const held = await send(first, 'u1')
  expect(held).toMatchObject({ kind: 'held', draft: { missing: ['materials', 'result'], unresolved: [],
    sources: [{ message_id: 'u1', text: first }] } })
  expect(held.draft?.requires_restatement).toBeUndefined()
  expect(calls).toHaveLength(2)
  expect(calls[0]!.system).not.toContain('Copy only the shortest necessary verbatim clauses')
  expect(calls[1]!.system).toContain('Copy only the shortest necessary verbatim clauses')
  expect(calls[1]!.input).toEqual(calls[0]!.input)

  const supplied = await send(second, 'u2')
  const known = [
    { kind: 'no_network', source_message_id: 'u2' }, { kind: 'no_workspace_read', source_message_id: 'u2' },
    { kind: 'no_workspace_files', source_message_id: 'u2' },
  ]
  const unresolved = scope === 'unresolved' ? [{ source_message_id: 'u2', quote: '禁止任何持久化' }] : []
  expect(supplied).toMatchObject({ kind: 'held', draft: {
    missing: scope === 'unresolved' ? ['result', 'constraints'] : ['result'], constraints: known, unresolved,
    sources: [{ message_id: 'u1', text: first }, { message_id: 'u2', text: second }],
  } })
  expect(supplied.draft?.requires_restatement).toBeUndefined()

  const resumed = await send(third, 'u3')
  const sources = [{ message_id: 'u1', text: first }, { message_id: 'u2', text: second }, { message_id: 'u3', text: third }]
  if (scope === 'known') {
    expect(resumed).toMatchObject({ kind: 'ready', request: { goal: [first, second, third].join('\n'),
      requirements_contract: { start_policy: 'immediate', sources, constraints: [...known, { kind: 'chat_only', source_message_id: 'u3' }] },
    } })
  } else if (scope === 'unresolved') {
    expect(resumed).toMatchObject({ kind: 'clarify', message: expect.stringContaining('禁止任何持久化'),
      draft: { missing: ['constraints'], unresolved, sources } })
  } else {
    expect(resumed).toMatchObject({ kind: 'clarify', draft: { requires_restatement: true, sources, constraints: known } })
  }
  expect(calls).toHaveLength(4)
  expect(calls[3]!.input.draft?.missing).toEqual(scope === 'unresolved' ? ['result', 'constraints'] : ['result'])
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

it.each([false, true])('keeps a complete unstarted request so a short supplement preserves its goal, timing and restrictions (answer=%s)', async hasAnswer => {
  const session = createSemanticSession()
  const request = (text: string, id: string) => ({ identity: 'workspace/session', requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  const original = '请查找今天 AIHOT 和 B站的 AI 热点，15条内，输出到聊天里'
  expect(await session.admit(request(original, 'u1'), async i => task(i, { constraints: [
    { id: 'c', kind: 'chat_only', source_message_id: 'u1', quote: '输出到聊天里' },
  ] }))).toMatchObject({ kind: 'ready' })
  session.retainUnstarted('u1', 'u1')
  const supplement = '合计，重复信息合并，时间最近24小时'
  const out = await session.admit(request(supplement, 'u2'), async i => {
    expect(i.draft?.sources).toEqual([{ message_id: 'u1', text: original }])
    return task(i, { relation: 'continue', draft_revision: i.draft!.revision, continuation: 'supply',
      ...(hasAnswer ? { answer: { slot: 'result', quote: supplement, value: '重复信息合并' } } : {}) })
  })
  expect(out).toMatchObject({ kind: 'ready', request: { goal: original + '\n' + supplement,
    requirements_contract: { start_policy: 'immediate', timing: { source_message_id: 'u1' },
      constraints: [{ kind: 'chat_only', source_message_id: 'u1' }] } } })
})

it('retains plan-only timing on added details and requires a new explicit resume to execute', async () => {
  const first = input('先给我整理方案，暂不执行')
  const held = draftOf(interpretSemanticAdmission(first, task(first, { timing: 'held' })))
  const next = { ...input('输出五条建议', 'u2'), draft: held }
  const raw = task(next, { relation: 'continue', draft_revision: held.revision, continuation: 'supply' })
  expect(interpretSemanticAdmission(next, raw)).toMatchObject({ kind: 'held' })
  const plan = { ...held, timing: 'plan_only' as const }
  expect(interpretSemanticAdmission({ ...next, draft: plan }, raw)).toMatchObject({ kind: 'ready',
    request: { requirements_contract: { start_policy: 'plan_only', timing: { source_message_id: 'u1' } } } })
})

it('cannot restore an older failed request over a newer draft or another workspace', async () => {
  const session = createSemanticSession()
  const request = (text: string, id: string, identity = 'one') => ({ identity, requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  await session.admit(request('整理月报', 'u1'), async i => task(i))
  session.retainUnstarted('u1', 'wrong-hash')
  await session.admit(request('先别执行旅行计划', 'u2'), async i => {
    expect(i.draft).toBeUndefined()
    return task(i, { timing: 'held' })
  })
  session.retainUnstarted('u1', 'u1')
  await session.admit(request('继续旅行计划', 'u3'), async i => {
    expect(i.draft?.sources.map(source => source.message_id)).toEqual(['u2'])
    return task(i, { relation: 'continue', draft_revision: i.draft!.revision, continuation: 'resume' })
  })
  await session.admit(request('你好', 'u4', 'two'), async () => ({ kind: 'conversation' }))
  session.retainUnstarted('u3', 'u3')
  await session.admit(request('整理日报', 'u5', 'two'), async i => {
    expect(i.draft).toBeUndefined()
    return task(i)
  })
})

it('does not retain a successfully admitted request unless the caller reports it unstarted', async () => {
  const session = createSemanticSession()
  const request = (text: string, id: string) => ({ identity: 'one', requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  await session.admit(request('生成周报', 'u1'), async i => task(i))
  await session.admit(request('生成日报', 'u2'), async i => {
    expect(i.draft).toBeUndefined()
    return task(i)
  })
})

it.each(['held', 'plan_only', 'unclear'] as const)('an explicit %s supplement overrides an unstarted immediate request', async timing => {
  const session = createSemanticSession()
  const request = (text: string, id: string) => ({ identity: 'one', requestId: id, hash: id,
    input: input(text, id), signal: new AbortController().signal, assertCurrent() {} })
  await session.admit(request('查找今天 AI 热点，直接执行', 'u1'), async current => task(current))
  session.retainUnstarted('u1', 'u1')
  const outcome = await session.admit(request('先不要执行，只补充来源为AIHOT', 'u2'), async current => task(current, {
    relation: 'continue', draft_revision: current.draft!.revision, continuation: 'supply', timing,
  }))
  if (timing === 'plan_only') {
    expect(outcome).toMatchObject({ kind: 'ready', request: { requirements_contract: {
      start_policy: 'plan_only', timing: { source_message_id: 'u2' },
    } } })
  } else expect(outcome).toMatchObject({ kind: timing === 'held' ? 'held' : 'clarify',
    draft: { timing, timing_source: { source_message_id: 'u2' } } })
})
