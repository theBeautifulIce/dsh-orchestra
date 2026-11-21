// R5-D：AgentLifecycle 的生产故障注入（B01/B08/B09/B10）
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLifecycle } from '../../src/executor/agent-lifecycle.ts'
import { BridgeClient, BridgeEventBuffer, type BridgeEvent, type BridgeTransport } from '../../src/executor/bridge.ts'
import { BridgeLedger } from '../../src/executor/bridge-ledger.ts'
import { superviseOrdinaryAttempt } from '../../src/executor/ordinary-supervision.ts'
import { ScriptedClock } from '../../src/core/clock.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { acquireLease } from '../../src/service/commands/lease.ts'
import { ToolRegistry, ReadOnlyToolRunner, type HostRunner } from '../../src/executor/tools.ts'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'

const NOW = '2026-11-13T03:00:00.000Z'

it.each([true, false])('bounds signed final receipt intake while the resident native agent is idle (in grace: %s)', (inGrace) => {
  const { db, dir } = freshLedger()
  try {
    seed(db)
    const lease = withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status='queued',attempt=1 WHERE node_run_id='nr1'")
      const result = acquireLease(tx, TEST_SECRET, { nodeRunId: 'nr1', ownerEpoch: db.epoch, leaseTtlMs: 1000, now: NOW })
      tx.run("UPDATE node_runs SET status='started',executor_agent_id='agent_1',executor_session_id='sess_1' WHERE node_run_id='nr1'")
      return result
    })
    vi.useFakeTimers({ toFake: ['performance'] })
    const binding = { nodeRunId: 'nr1', attempt: 1, actionGeneration: lease.actionGeneration,
      executorAgentId: 'agent_1', executorSessionId: 'sess_1' }
    const bridge = new BridgeClient({
      async request() { throw new Error('Receipt observation must not need an executor RPC') },
      async *listen() {},
      fenceAttemptTools: () => true,
      observeAttempt: () => undefined,
    })
    const supervision = superviseOrdinaryAttempt({ db, secret: TEST_SECRET, bridge, binding,
      clock: new ScriptedClock('fixture-boot', { wallClockMs: Date.parse(NOW) }),
      leaseId: lease.leaseId, ownerEpoch: db.epoch, nowAt: () => NOW, timeoutMs: 100, unknownWatchdogMs: 120_000 })
    bridge.installAttemptMonitor({ binding, budget: supervision.budget, actionTimeoutMs: 100 },
      supervision.mayUseTools, new AbortController().signal)
    expect(supervision.mayUseTools()).toBe(true)
    vi.advanceTimersByTime(101)
    expect(supervision.mayUseTools()).toBe(false)
    expect(supervision.poll()).toBe(true)
    const turn = ev(1, 'turn', { kind: 'report', report: { status: 'done', output: {} } })
    expect(supervision.poll(turn)).toBe(false)
    const ledger = new BridgeLedger(db, TEST_SECRET, binding)
    ledger.ingest(turn)
    expect(supervision.poll({ ...turn, attempt: 2 })).toBe(false)
    if (!inGrace) {
      vi.advanceTimersByTime(250)
      expect(supervision.poll(turn)).toBe(false)
      return
    }
    expect(supervision.poll(turn)).toBe(true)
    expect(supervision.lateStatus()).toEqual({ status: 'startup_unknown', rearmGeneration: 1 })
    expect(supervision.mayUseTools()).toBe(false)
    expect(bridge.liveAttempt({ ...binding, rearmGeneration: 1 })).toBeUndefined()
    expect(db.raw.prepare("SELECT lease_id FROM node_runs WHERE node_run_id='nr1'").get()).toEqual({ lease_id: null })
  } finally {
    vi.useRealTimers()
    db.raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const began = Date.now()
  while (!cond()) {
    if (Date.now() - began > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const ev = (seq: number, type: BridgeEvent['type'], payload: unknown, attempt = 1): BridgeEvent => ({
  seq, type, at: NOW, toolStartAt: null, payload, attempt, executorAgentId: 'agent_1',
})

function harness(transport: BridgeTransport, prep?: (db: ReturnType<typeof freshLedger>['db']) => void, timeoutMs = 2000) {
  const { dir, db } = freshLedger()
  seed(db)
  prep?.(db)
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
  const host: HostRunner = {
    readonlyAvailable: () => true,
    run: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }),
  }
  const lifecycle = new AgentLifecycle({
    db, secret: TEST_SECRET, client: new BridgeClient(transport), registry,
    runner: new ReadOnlyToolRunner(registry, host, dir),
    policy: { allow: ['ro.echo'], deny: [], declaredPolicy: 'pure' },
    allowedTools: ['ro.echo'],
    nodeRunId: 'nr1', attempt: 1,
    agent: {
      agentId: 'agent_1', sessionId: 'sess_1',
      tools: [{ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } }],
    },
    instruction: 'do it', timeoutMs, idleTimeoutMs: 50, nowAt: () => NOW,
    spillDir: join(dir, 'spill'),
  })
  return {
    dir, db, lifecycle,
    cleanup: () => { db.raw.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

describe('AgentLifecycle 故障注入', () => {
  it('B01 订阅失败：不发任务，也不留不可追踪的 Agent', async () => {
    const calls: string[] = []
    const transport: BridgeTransport = {
      request: async (method) => {
        calls.push(method)
        if (method === 'executor.subscribe') return { subscribed: false } as never
        if (method === 'executor.cancel') return 'interrupted' as never
        if (method === 'executor.whenIdle') return { idle: true, timedOut: false } as never
        if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false } as never
        return {} as never
      },
      listen: () => { throw new Error('不该 listen') },
    }
    const h = harness(transport)
    await expect(h.lifecycle.run(new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_NOT_SUBSCRIBED' })
    expect(calls).not.toContain('executor.send')
    await h.lifecycle.stop()
    expect(calls.filter((method) => method === 'executor.cancel')).toHaveLength(1)
    expect(calls.filter((method) => method === 'executor.dispose')).toHaveLength(1)
    h.cleanup()
  })

  it('B11 动作超时：abort 必须打穿等待，不能永久挂起', async () => {
    const calls: string[] = []
    const transport: BridgeTransport = {
      request: async (method) => {
        calls.push(method)
        if (method === 'executor.subscribe') return { subscribed: true, fromSeq: 0, lastSeq: 0 } as never
        if (method === 'executor.send') return undefined as never
        if (method === 'executor.cancel') return 'interrupted' as never
        if (method === 'executor.whenIdle') return { idle: true, timedOut: false } as never
        if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false } as never
        return undefined as never
      },
      listen: (_params, signal) => (async function* () {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      })(),
    }
    const h = harness(transport, undefined, 50)
    const began = Date.now()
    await expect(h.lifecycle.run(new AbortController().signal)).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(Date.now() - began).toBeLessThan(1000)
    // 超时后仍要走完整停止确认，不能把会话留在宿主。
    await h.lifecycle.stop()
    expect(calls).toContain('executor.cancel')
    expect(calls).toContain('executor.dispose')
    h.cleanup()
  })

  it('B13 订阅挂住：动作超时必须打穿 subscribe，不能永远停在 started', async () => {
    const calls: string[] = []
    const transport: BridgeTransport = {
      request: async (method) => {
        calls.push(method)
        if (method === 'executor.subscribe') return new Promise<never>(() => {}) as never
        if (method === 'executor.cancel') return 'interrupted' as never
        if (method === 'executor.whenIdle') return { idle: true, timedOut: false } as never
        if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false } as never
        return undefined as never
      },
      listen: () => { throw new Error('不该 listen') },
    }
    const h = harness(transport, undefined, 50)
    const began = Date.now()
    await expect(h.lifecycle.run(new AbortController().signal)).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(Date.now() - began).toBeLessThan(1000)
    await h.lifecycle.stop()
    expect(calls).toContain('executor.cancel')
    expect(calls).toContain('executor.dispose')
    h.cleanup()
  })

  it('B14 发送挂住：动作超时必须打穿 send，仍要 cancel/dispose', async () => {
    const calls: string[] = []
    const transport: BridgeTransport = {
      request: async (method) => {
        calls.push(method)
        if (method === 'executor.subscribe') return { subscribed: true, fromSeq: 0, lastSeq: 0 } as never
        if (method === 'executor.send') return new Promise<never>(() => {}) as never
        if (method === 'executor.cancel') return 'interrupted' as never
        if (method === 'executor.whenIdle') return { idle: true, timedOut: false } as never
        if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false } as never
        return undefined as never
      },
      listen: (_params, signal) => (async function* () {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      })(),
    }
    const h = harness(transport, undefined, 50)
    const began = Date.now()
    await expect(h.lifecycle.run(new AbortController().signal)).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
    expect(Date.now() - began).toBeLessThan(1000)
    await h.lifecycle.stop()
    expect(calls).toContain('executor.cancel')
    expect(calls).toContain('executor.dispose')
    h.cleanup()
  })

  it('B15 listen 先失败、send 还挂着：report 的拒绝必须被消费，不能 unhandledRejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    const transport: BridgeTransport = {
      request: async (method) => {
        if (method === 'executor.subscribe') return { subscribed: true, fromSeq: 0, lastSeq: 0 } as never
        if (method === 'executor.send') return new Promise<never>(() => {}) as never
        if (method === 'executor.cancel') return 'interrupted' as never
        if (method === 'executor.whenIdle') return { idle: true, timedOut: false } as never
        if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false } as never
        return undefined as never
      },
      listen: () => (async function* () {
        throw new Error('listen boom')
      })(),
    }
    const h = harness(transport, undefined, 50)
    try {
      await expect(h.lifecycle.run(new AbortController().signal)).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
      await h.lifecycle.stop()
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      h.cleanup()
    }
  })

  it('B12 stop 失败后再次调用不重发取消/释放', async () => {
    let disposeCalls = 0
    let cancelCalls = 0
    let idleCalls = 0
    const transport: BridgeTransport = {
      request: async (method) => {
        if (method === 'executor.cancel') { cancelCalls += 1; return 'interrupted' as never }
        if (method === 'executor.whenIdle') { idleCalls += 1; return { idle: true, timedOut: false } as never }
        if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false } as never
        if (method === 'executor.dispose') { disposeCalls += 1; throw new Error('transient dispose failure') }
        return undefined as never
      },
      listen: () => { throw new Error('不该 listen') },
    }
    const h = harness(transport)
    await expect(h.lifecycle.stop()).rejects.toThrow('transient dispose failure')
    await expect(h.lifecycle.stop()).rejects.toThrow('transient dispose failure')
    expect(cancelCalls).toBe(1)
    expect(idleCalls).toBe(1)
    expect(disposeCalls).toBe(1)
    h.cleanup()
  })

  it('B16 收口 cancel 挂住：单次 RPC 有上限，仍要用真实状态完成确认', async () => {
    let disposeCalls = 0
    const transport: BridgeTransport = {
      request: async (method) => {
        if (method === 'executor.cancel') return new Promise<never>(() => {}) as never
        if (method === 'executor.whenIdle') return { idle: true, timedOut: false } as never
        if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false } as never
        if (method === 'executor.dispose') { disposeCalls += 1; return undefined as never }
        return undefined as never
      },
      listen: () => { throw new Error('不该 listen') },
    }
    const h = harness(transport)
    const began = Date.now()
    await h.lifecycle.stop()
    const elapsed = Date.now() - began
    expect(elapsed).toBeGreaterThanOrEqual(1_900)
    expect(elapsed).toBeLessThan(4_000)
    expect(disposeCalls).toBe(1)
    h.cleanup()
  })

  it('B07 工具执行中取消：先杀掉真实子进程并确认停止，才允许 dispose', async () => {
    const { dir, db } = freshLedger()
    seed(db)
    const marker = join(dir, 'tool-running.txt')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const exit = once(child, 'exit')
    let disposeCalls = 0
    let disposedAfterExit = false

    const registry = new ToolRegistry()
    registry.register({ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } })
    const host: HostRunner = {
      readonlyAvailable: () => true,
      run: async () => {
        writeFileSync(marker, 'running')
        await exit
        return { exitCode: 0, stdout: 'killed\n', stderr: '' }
      },
    }
    const transport: BridgeTransport = {
      request: async (method) => {
        if (method === 'executor.subscribe') return { subscribed: true, fromSeq: 0, lastSeq: 0 } as never
        if (method === 'executor.send') return undefined as never
        if (method === 'executor.cancel') { child.kill('SIGKILL'); return 'interrupted' as never }
        if (method === 'executor.whenIdle') { await exit; return { idle: true, timedOut: false } as never }
        if (method === 'executor.state') return { state: child.exitCode === null && child.signalCode === null ? 'running' : 'idle', toolCallSeq: 0, hasToolCall: false } as never
        if (method === 'executor.dispose') {
          disposeCalls += 1
          disposedAfterExit = child.exitCode !== null || child.signalCode !== null
          return undefined as never
        }
        return {} as never
      },
      listen: async function* (_params, signal) {
        yield ev(1, 'tool.call', { callId: 'c1', tool: 'ro.echo', args: [], cwd: '.', timeoutMs: 30_000 })
        // 真实桥在 abort 时会结束流；测试替身也必须如此，否则 stop 会卡在 running。
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }
    const lifecycle = new AgentLifecycle({
      db, secret: TEST_SECRET, client: new BridgeClient(transport), registry,
      runner: new ReadOnlyToolRunner(registry, host, dir),
      policy: { allow: ['ro.echo'], deny: [], declaredPolicy: 'pure' }, allowedTools: ['ro.echo'],
      nodeRunId: 'nr1', attempt: 1,
      agent: { agentId: 'agent_1', sessionId: 'sess_1', tools: [{ name: 'ro.echo', capability: 'read_only', command: { bin: 'echo', args: ['ok'] } }] },
      instruction: 'do it', timeoutMs: 30_000, idleTimeoutMs: 1_000, nowAt: () => NOW, spillDir: join(dir, 'spill'),
    })
    try {
      const ac = new AbortController()
      const run = lifecycle.run(ac.signal)
      await waitFor(() => existsSync(marker), 5_000)
      ac.abort(new Error('用户取消'))
      await expect(run).rejects.toBeTruthy()
      await lifecycle.stop()
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
      expect(disposeCalls).toBe(1)
      expect(disposedAfterExit).toBe(true)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      db.raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('B08 dispose 前 ACK 落后：客户端拒绝释放 Agent', async () => {
    const calls: string[] = []
    const client = new BridgeClient({
      request: async (method) => { calls.push(method); return {} as never },
      listen: () => { throw new Error('不该 listen') },
    })
    await expect(client.dispose({ executorAgentId: 'agent_1', serviceAckSeq: 0, bridgeLastSeq: 1 }))
      .rejects.toMatchObject({ code: 'BRIDGE_ACK_LAG' })
    expect(calls).not.toContain('executor.dispose')
  })

  it('B09 旧 attempt 事件迟到：不能进入新 attempt 的缓冲', () => {
    const buf = new BridgeEventBuffer(
      { agentId: 'agent_1', attempt: 2, nodeRunId: 'nr1', spillDir: join(tmpdir(), 'dsh-orchestra-b9'), limitBytes: 1024 * 1024, highWaterBytes: 512 * 1024 },
      { lastPersistedAckSeq: 0 },
    )
    expect(() => buf.push(ev(1, 'turn', { old: true }, 1))).toThrow(/attempt/)
  })

  it('B02 send 后崩溃：重启从持久化 ACK 位重放，不重头订阅', async () => {
    let listenFrom = -1
    const transport: BridgeTransport = {
      request: async (method) => {
        if (method === 'executor.subscribe') return { subscribed: true, fromSeq: 1, lastSeq: 1 } as never
        if (method === 'executor.send') return undefined as never
        if (method === 'executor.cancel') return 'interrupted' as never
        if (method === 'executor.whenIdle') return { idle: true, timedOut: false } as never
        if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false } as never
        return undefined as never
      },
      listen: (params): AsyncIterable<BridgeEvent> => {
        listenFrom = params.fromSeq
        return (async function* () {
          yield ev(2, 'turn', { kind: 'report', report: { status: 'done', output: {} } })
        })()
      },
    }
    const h = harness(transport, (db) => {
      const ledger = new BridgeLedger(db, TEST_SECRET, { nodeRunId: 'nr1', attempt: 1, executorAgentId: 'agent_1' })
      const ingested = ledger.ingest(ev(1, 'step', { kind: 'step' }))
      ledger.markHandled(ingested.eventSeq)
    })
    const envelope = await h.lifecycle.run(new AbortController().signal)
    expect(envelope.report).toMatchObject({ status: 'done' })
    expect(listenFrom).toBe(1)
    await h.lifecycle.stop()
    h.cleanup()
  })

  it('B03 事件 2 跳到 5：先整页补洞，再按连续序消费', async () => {
    let pageFrom = -1
    const transport: BridgeTransport = {
      request: async (method, params) => {
        if (method === 'executor.subscribe') return { subscribed: true, fromSeq: 0, lastSeq: 0 } as never
        if (method === 'executor.send') return undefined as never
        if (method === 'executor.page') {
          pageFrom = (params as { fromSeq: number }).fromSeq
          return { events: [ev(1, 'step', { kind: 'step' }), ev(2, 'step', { kind: 'step' })] } as never
        }
        if (method === 'executor.cancel') return 'interrupted' as never
        if (method === 'executor.whenIdle') return { idle: true, timedOut: false } as never
        if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false } as never
        return undefined as never
      },
      listen: (): AsyncIterable<BridgeEvent> => (async function* () {
        yield ev(3, 'turn', { kind: 'report', report: { status: 'done', output: {} } })
      })(),
    }
    const h = harness(transport)
    const envelope = await h.lifecycle.run(new AbortController().signal)
    expect(envelope.report).toMatchObject({ status: 'done' })
    expect(pageFrom).toBe(1)
    const receipts = h.db.raw.prepare(
      'SELECT bridge_seq FROM bridge_event_receipts WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ? ORDER BY bridge_seq',
    ).all('nr1', 1, 'agent_1') as { bridge_seq: number }[]
    expect(receipts.map((row) => row.bridge_seq)).toEqual([1, 2, 3])
    const cursor = h.db.raw.prepare(
      'SELECT last_persisted_ack_seq, last_handled_seq FROM bridge_stream_cursors WHERE node_run_id = ? AND attempt = ? AND executor_agent_id = ?',
    ).get('nr1', 1, 'agent_1') as { last_persisted_ack_seq: number; last_handled_seq: number }
    expect(cursor).toEqual({ last_persisted_ack_seq: 3, last_handled_seq: 3 })
    await h.lifecycle.stop()
    h.cleanup()
  })

  it('B10 断线重连：从账本确认位重放，不丢 report', async () => {
    let listens = 0
    const listenFrom: number[] = []
    let resultResolve: (() => void) | null = null
    const resultGate = new Promise<void>((resolve) => { resultResolve = resolve })
    const transport: BridgeTransport = {
      request: async (method) => {
        if (method === 'executor.subscribe') return { subscribed: true, fromSeq: 0, lastSeq: 0 } as never
        if (method === 'executor.send') return undefined as never
        if (method === 'executor.toolResult') { resultResolve?.(); return undefined as never }
        if (method === 'executor.cancel') return 'interrupted' as never
        if (method === 'executor.whenIdle') return { idle: true, timedOut: false } as never
        if (method === 'executor.state') return { state: 'idle', toolCallSeq: 1, hasToolCall: false } as never
        if (method === 'executor.dispose') return undefined as never
        return {} as never
      },
      listen: (params, signal): AsyncIterable<BridgeEvent> => {
        listens += 1
        listenFrom.push(params.fromSeq)
        const round = listens
        return (async function* () {
          if (round === 1) {
            yield ev(1, 'tool.call', { callId: 'c1', tool: 'ro.echo', args: [], cwd: '.', timeoutMs: 1000 })
            await Promise.race([
              resultGate,
              new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
            ])
            return
          }
          yield ev(2, 'turn', { kind: 'report', report: { status: 'done', output: {} } })
        })()
      },
    }
    const h = harness(transport)
    const envelope = await h.lifecycle.run(new AbortController().signal)
    expect(envelope.report).toMatchObject({ status: 'done' })
    expect(listens).toBe(2)
    expect(listenFrom).toEqual([0, 1])
    await h.lifecycle.stop()
    h.cleanup()
  })
})
