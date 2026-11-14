// tests/fixtures/agent-bridge.ts —— 事件驱动的 Agent 替身：按脚本发 tool.call，收到 toolResult 再继续。
import { BridgeClient, type BridgeEvent, type BridgeTransport } from '../../src/executor/bridge.ts'

export type AgentToolStep = { tool: string; args?: string[]; cwd?: string; timeoutMs?: number }

export type AgentBridgeOptions = {
  agentId: string
  steps: AgentToolStep[]
  report?: Record<string, unknown> | null
  at?: string
}

type ToolResult = { exitCode: number; stdout: string; stderr: string }
type ResultWaiter = (result: ToolResult) => void

export type FakeAgentBridge = BridgeTransport & {
  calls: { method: string; params: unknown }[]
  disposed: boolean
  cancelled: boolean
}

// 一个最小宿主：订阅确认后先等 send，再逐条发 tool.call；每条等宿主回传结果，exitCode≠0 即停。
export function fakeAgentBridge(opts: AgentBridgeOptions): FakeAgentBridge {
  const calls: { method: string; params: unknown }[] = []
  const waiters = new Map<string, ResultWaiter>()
  const results = new Map<string, ToolResult>()
  let startResolve: (() => void) | null = null
  const startGate = new Promise<void>((resolve) => { startResolve = resolve })
  let cancelled = false
  let disposed = false
  let listenIndex = 0
  const at = opts.at ?? '2026-11-13T03:00:00.000Z'

  const waitForResult = (callId: string): Promise<ToolResult> => {
    const stored = results.get(callId)
    if (stored) return Promise.resolve(stored)
    return new Promise((resolve) => { waiters.set(callId, resolve) })
  }

  return {
    calls,
    get disposed(): boolean { return disposed },
    get cancelled(): boolean { return cancelled },
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params })
      if (method === 'executor.subscribe') return { subscribed: true, fromSeq: 0, lastSeq: 0 } as T
      if (method === 'executor.send') { startResolve?.(); return undefined as T }
      if (method === 'executor.toolResult') {
        const p = params as { callId: string; result: ToolResult }
        results.set(p.callId, p.result)
        waiters.get(p.callId)?.(p.result)
        waiters.delete(p.callId)
        return undefined as T
      }
      if (method === 'executor.cancel') { cancelled = true; return 'interrupted' as T }
      if (method === 'executor.state') return { state: disposed ? 'unloaded' : 'idle', toolCallSeq: 0, hasToolCall: false } as T
      if (method === 'executor.whenIdle') return { idle: true, timedOut: false } as T
      if (method === 'executor.dispose') { disposed = true; return undefined as T }
      return {} as T
    },
    listen(_params, signal: AbortSignal): AsyncIterable<BridgeEvent> {
      calls.push({ method: 'executor.listen', params: _params })
      listenIndex += 1
      const callPrefix = 'call_' + String(listenIndex) + '_'
      let seq = 0
      const next = (type: BridgeEvent['type'], payload: unknown): BridgeEvent => {
        seq += 1
        return { seq, type, at, toolStartAt: null, payload, attempt: opts.steps.length ? 1 : undefined, executorAgentId: opts.agentId }
      }
      return (async function* () {
        await Promise.race([
          startGate,
          new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
        ])
        for (const [index, step] of opts.steps.entries()) {
          if (signal.aborted) return
          const callId = callPrefix + String(index + 1)
          yield next('tool.call', {
            callId,
            tool: step.tool,
            args: step.args ?? [],
            cwd: step.cwd ?? '.',
            timeoutMs: step.timeoutMs ?? 5000,
          })
          const result = await Promise.race([
            waitForResult(callId),
            new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true })),
          ])
          if (result === null || result.exitCode !== 0) break
        }
        if (signal.aborted) return
        if (opts.report !== null) {
          yield next('turn', { kind: 'report', report: opts.report ?? { status: 'done', output: {} } })
        }
      })()
    },
  }
}

// 生产装配要的是 BridgeClient；替身只实现传输层，这里包一层真实客户端。
export function fakeAgentClient(opts: AgentBridgeOptions): BridgeClient {
  return new BridgeClient(fakeAgentBridge(opts))
}
