// tests/fixtures/bridge.ts —— 桥的替身：按方法名回放预设回包，并记下调用
import type { BridgeEvent, BridgeTransport } from '../../src/executor/bridge.ts'

export type FakeCall = { method: string; params: unknown }

export type FakeBridge = BridgeTransport & {
  calls: FakeCall[]
  lastCall: (method: string) => FakeCall | undefined
}

export function fakeBridge(reply: (method: string, params: unknown) => unknown): FakeBridge {
  const calls: FakeCall[] = []
  return {
    calls,
    lastCall: (method: string) => calls.find((c) => c.method === method),
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params })
      return reply(method, params) as T
    },
    listen(params: { executorAgentId: string; attempt: number; fromSeq: number }, _signal: AbortSignal): AsyncIterable<BridgeEvent> {
      calls.push({ method: 'executor.listen', params })
      return (async function* () {})()
    },
  }
}

// 默认回包：spawn 成功、subscribe 确认、cancel 报 interrupted
export function defaultBridgeReply(method: string): unknown {
  if (method === 'executor.spawn') return { sessionId: 'sess_1', agentId: 'agent_1' }
  if (method === 'executor.subscribe') return { subscribed: true, fromSeq: 0, lastSeq: 0 }
  if (method === 'executor.cancel') return 'interrupted'
  if (method === 'executor.state') return { state: 'idle', toolCallSeq: 0, hasToolCall: false }
  if (method === 'executor.whenIdle') return { idle: true, timedOut: false }
  return {}
}
