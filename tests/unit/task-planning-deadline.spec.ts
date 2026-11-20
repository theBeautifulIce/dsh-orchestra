import type { Context } from '@deepseek-ai/cordis'
import { rmSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { OrchError } from '../../src/core/errors.ts'
import { createDshPlanningCallback } from '../../src/executor/dsh-host.ts'
import { callPlanningStage, createTaskPlanningHost } from '../../src/service/task-planning.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { freshLedger } from '../fixtures/ledger.ts'

const messages = { timeout: '生成超时', failure: '模型暂时不可用' }

afterEach(() => vi.useRealTimers())

it('honors a non-streaming extension timeout above the streaming idle limit without supplying a progress callback', async () => {
  const { db, dir } = freshLedger()
  try {
    vi.useFakeTimers()
    let signal!: AbortSignal
    const generate = vi.fn((_input, incoming) => {
      signal = incoming
      return new Promise<never>(() => {})
    })
    const planning = createTaskPlanningHost(db, new WorkflowCatalog('S5', db), undefined, {
      timeoutMs: 75_000, propose: async () => {}, workflowGenerator: generate,
    })
    const pending = planning.propose({ goal: '生成流程', requirements: [] }, 'user', '2026-11-20T00:00:00Z')
    const result = expect(pending).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', details: { boundary: 'maximum' } })
    await vi.advanceTimersByTimeAsync(74_999)
    expect(signal.aborted).toBe(false)
    expect(generate.mock.calls[0]).toHaveLength(2)
    expect(planning.requestTimeoutMs).toBe(225_000)
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(signal.aborted).toBe(true)
  } finally {
    db.raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps an active DSH reasoning stream past the old deadline until the final workflow JSON', async () => {
  vi.useFakeTimers()
  let stream!: (event: unknown) => void
  let finish!: () => void
  const cancel = vi.fn()
  const dispose = vi.fn(async () => {})
  const route = { provider: 'fixture', model: 'reasoner' }
  const agent = {
    model: { select() {} }, followup() {}, cancel,
    whenIdle: () => new Promise<void>((resolve) => { finish = resolve }),
    session: { snapshotEvents: () => [
      { type: 'request/header', data: { header: { config: route } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"name":"valid workflow"}' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ] },
  }
  const child = {
    tools: { restrict() {} },
    on(name: string, handler: (event: unknown) => void) { if (name === 'agent/assistant-stream') stream = handler },
  }
  const parent = {
    session: { id: 'dsh-parent', header: { cwd: process.cwd() } },
    ctx: { agents: { async create(options: { setup(ctx: unknown, agent: unknown): void }) {
      options.setup(child, agent)
      return { agent, dispose }
    } } },
  }
  const context = { agents: { get: () => parent }, llm: { listModels: async () => [{ id: route.model }] } } as unknown as Context
  const generate = createDshPlanningCallback({ context, parent: () => parent as never, model: route }, 'workflow')
  const pending = callPlanningStage((signal, progress) => generate({ goal: '计划' }, signal, progress), undefined, messages)
  const settled = expect(pending).resolves.toEqual({ name: 'valid workflow' })
  await vi.advanceTimersByTimeAsync(20_000)
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'reasoning' } } })
  await vi.advanceTimersByTimeAsync(20_000)
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', index: 1, text: '{' } } })
  await vi.advanceTimersByTimeAsync(12_000)
  finish()
  await settled
  expect(cancel).not.toHaveBeenCalled()
  expect(dispose).toHaveBeenCalledOnce()
})

it('keeps an idle and hard ceiling and passes caller cancellation through to the planner', async () => {
  vi.useFakeTimers()
  const waiting = () => new Promise<never>(() => {})
  const idle = expect(callPlanningStage(waiting, undefined, messages)).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', details: { boundary: 'inactivity' } })
  await vi.advanceTimersByTimeAsync(30_000)
  await idle

  let progress!: () => void
  const maximum = expect(callPlanningStage((_signal, notify) => { progress = notify!; return waiting() }, undefined, messages))
    .rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', details: { boundary: 'maximum' } })
  for (let elapsed = 0; elapsed < 100_000; elapsed += 20_000) {
    await vi.advanceTimersByTimeAsync(20_000)
    progress()
  }
  await vi.advanceTimersByTimeAsync(20_000)
  await maximum

  const caller = new AbortController()
  const expected = new OrchError('SERVICE_UNAVAILABLE', 'request disconnected')
  let usedSignal!: AbortSignal
  const cancelled = expect(callPlanningStage((signal) => { usedSignal = signal; return waiting() }, caller.signal, messages)).rejects.toBe(expected)
  caller.abort(expected)
  await cancelled
  expect(usedSignal.reason).toBe(expected)
})

it('keeps typed access and validation errors distinct and hides opaque provider errors', async () => {
  for (const code of ['FORBIDDEN', 'PAYLOAD_SCHEMA_INVALID', 'PROTOCOL_VERSION_MISMATCH'] as const) {
    const error = new OrchError(code, 'typed diagnostic')
    await expect(callPlanningStage(async () => { throw error }, undefined, messages)).rejects.toBe(error)
  }
  await expect(callPlanningStage(async () => { throw new Error('raw wire details') }, undefined, messages))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: messages.failure })
})
