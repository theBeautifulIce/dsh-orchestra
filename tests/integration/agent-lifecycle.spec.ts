// R5-D：AgentLifecycle 的生产故障注入（B01/B08/B09/B10）
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLifecycle } from '../../src/executor/agent-lifecycle.ts'
import { BridgeClient, BridgeEventBuffer, type BridgeEvent, type BridgeTransport } from '../../src/executor/bridge.ts'
import { BridgeLedger } from '../../src/executor/bridge-ledger.ts'
import { ToolRegistry, ReadOnlyToolRunner, type HostRunner } from '../../src/executor/tools.ts'
import { freshLedger, seed, TEST_SECRET } from '../fixtures/ledger.ts'

const NOW = '2026-11-13T03:00:00.000Z'
const ev = (seq: number, type: BridgeEvent['type'], payload: unknown, attempt = 1): BridgeEvent => ({
  seq, type, at: NOW, toolStartAt: null, payload, attempt, executorAgentId: 'agent_1',
})

function harness(transport: BridgeTransport, prep?: (db: ReturnType<typeof freshLedger>['db']) => void) {
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
    instruction: 'do it', timeoutMs: 2000, idleTimeoutMs: 50, nowAt: () => NOW,
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
        return {} as never
      },
      listen: () => { throw new Error('不该 listen') },
    }
    const h = harness(transport)
    await expect(h.lifecycle.run(new AbortController().signal)).rejects.toMatchObject({ code: 'BRIDGE_NOT_SUBSCRIBED' })
    expect(calls).not.toContain('executor.send')
    h.cleanup()
  })

  it('B07 工具执行中取消：未确认停止就不放行', async () => {
    const calls: string[] = []
    const transport: BridgeTransport = {
      request: async (method) => {
        calls.push(method)
        if (method === 'executor.cancel') return 'interrupted' as never
        if (method === 'executor.whenIdle') return { idle: false, timedOut: true } as never
        if (method === 'executor.state') return { state: 'running', toolCallSeq: 0, hasToolCall: false } as never
        return {} as never
      },
      listen: () => { throw new Error('不该 listen') },
    }
    const h = harness(transport)
    await expect(h.lifecycle.stop()).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })
    expect(calls).not.toContain('executor.dispose')
    h.cleanup()
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
      ledger.ingest(ev(1, 'step', { kind: 'step' }))
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
