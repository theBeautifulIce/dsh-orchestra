import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { createDshTaskRequirements } from '../../src/executor/dsh-task-requirements.ts'
import type { SemanticInput } from '../../src/service/semantic-admission.ts'

type Options = Parameters<typeof createDshTaskRequirements>[0]
type Parent = NonNullable<ReturnType<Options['parent']>>
const route = { provider: 'fixture', model: 'planner' }
const signal = () => new AbortController().signal

function setup(reply: (request: SemanticInput) => unknown) {
  const parent = { session: { id: 'parent' } } as Parent
  let current: Parent | undefined = parent
  let authorized = true
  const stream = vi.fn(async function* (options: { sessionId?: string; tools: unknown[]; messages: { content: { text: string }[] }[] }) {
    expect(options.tools).toEqual([])
    expect(options.sessionId).toBeUndefined()
    expect(options.messages).toHaveLength(1)
    const input = JSON.parse(options.messages[0]!.content[0]!.text) as SemanticInput
    yield { type: 'block-end', block: { type: 'text', text: JSON.stringify(reply(input)) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const context = { llm: { async prepareCall(config: unknown) { return { config, stream } } },
    agents: { get: () => current } } as unknown as Context
  const model = vi.fn(() => route)
  const resolveWorkflow = vi.fn((hint: { version?: string }) => ({ workflow_id: 'wf-report', workflow_version: hint.version ?? '5' }))
  const read = createDshTaskRequirements({ context, parent: () => current, model,
    isAuthorized: () => authorized, resolveWorkflow })
  return { read, model, stream, resolveWorkflow, context, parent, revoke: () => { authorized = false },
    replace: () => { current = { session: { id: 'next' } } as Parent } }
}
const task = (input: SemanticInput) => ({ kind: 'task', relation: 'new', timing: 'immediate',
  quote: input.current.text.slice(0, Math.min(120, input.current.text.length)), constraints: [], missing: [] })

it('interprets the original form once, carries cited plan-only restrictions and keeps the form wording', async () => {
  const f = setup(input => ({ ...task(input), timing: 'plan_only', constraints: [{ id: 'a', kind: 'chat_only',
    source_message_id: input.current.message_id, quote: '只在会话里交付' }] }))
  const input = { goal: '先生成方案，等我确认再开始', requirements: ['只在会话里交付'] }
  const value = await f.read(input, signal())
  expect(value.goal).toBe(input.goal)
  expect(value.requirements).toEqual(input.requirements)
  expect(value.requirements_contract).toMatchObject({ version: 1, start_policy: 'plan_only', constraints: [{ kind: 'chat_only' }],
    sources: [{ text: input.goal + '\n只在会话里交付' }] })
  expect(f.model).toHaveBeenCalledTimes(1)
  expect(f.stream).toHaveBeenCalledTimes(1)
  await expect(f.read(value, signal())).resolves.toEqual(value)
  expect(f.stream).toHaveBeenCalledTimes(1)
})

it('accepts the existing form limit including all twelve separate requirements', async () => {
  const f = setup(task)
  const input = { goal: '核对材料'.repeat(400), requirements: Array.from({ length: 12 }, (_, i) => String(i) + '要求'.repeat(140)) }
  const result = await f.read(input, signal())
  expect(result.goal).toBe(input.goal)
  expect(result.requirements).toEqual(input.requirements)
  expect(result.requirements_contract?.sources[0]?.text.length).toBeGreaterThan(2000)
})

it('a claimed constraint must cite the original form and ambiguity produces no workflow lookup', async () => {
  const f = setup(input => ({ ...task(input), constraints: [{ id: 'a', kind: 'read_only',
    source_message_id: input.current.message_id, quote: 'invented authorization' }] }))
  await expect(f.read({ goal: '整理报告', requirements: [] }, signal())).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
  expect(f.resolveWorkflow).not.toHaveBeenCalled()
  const held = setup(input => ({ ...task(input), timing: 'held' }))
  await expect(held.read({ goal: '先别启动这项任务', requirements: [] }, signal())).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
})

it('resolves textual pins exactly and preserves a selected historical version when the text names only the workflow', async () => {
  const f = setup(input => ({ ...task(input), workflow: { name: '月报', quote: '用月报流程', source_message_id: input.current.message_id } }))
  const value = await f.read({ goal: '用月报流程整理数据', requirements: [], workflow_id: 'wf-report', workflow_version: '2' }, signal())
  expect(f.resolveWorkflow).toHaveBeenCalledWith(expect.objectContaining({ name: '月报', version: '2' }))
  expect(value).toMatchObject({ workflow_id: 'wf-report', workflow_version: '2' })
  await expect(f.read({ goal: '用月报流程整理数据', requirements: [], workflow_id: 'wf-other' }, signal()))
    .rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
  const version = setup(input => ({ ...task(input), workflow: { name: '月报', version: '3', quote: '月报第3版', source_message_id: input.current.message_id } }))
  await expect(version.read({ goal: '使用月报第3版整理数据', requirements: [], workflow_id: 'wf-report', workflow_version: '2' }, signal()))
    .rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
})

it('checks the trusted workspace and parent around the completion and has no regexp fallback', async () => {
  const f = setup(task)
  f.revoke()
  await expect(f.read({ goal: '生成报告', requirements: [] }, signal())).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(f.stream).not.toHaveBeenCalled()
  const changed = setup(input => { changed.replace(); return task(input) })
  await expect(changed.read({ goal: '生成报告', requirements: [] }, signal())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  const missing = createDshTaskRequirements({ context: { llm: {} } as Context,
    parent: () => undefined, model: route, resolveWorkflow: () => ({ workflow_id: 'unused', workflow_version: '1' }) })
  await expect(missing({ goal: '生成报告', requirements: [] }, signal())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
})
