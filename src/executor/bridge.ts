// src/executor/bridge.ts —— 桥 RPC 客户端：最小七方法（规格 7.2 行 582-590）
import { OrchError, proposedError } from '../core/errors.ts'

// 宿主侧传输契约：方法名 + 参数，返回值由宿主给
export type BridgeTransport = {
  request<T>(method: string, params: unknown): Promise<T>
}

/** 桥事件的最小形状。具体类型判别在 S2 Task 3 的缓冲层里做。 */
export type BridgeEvent = {
  seq: number
  type: string
  payload?: unknown
}

export type SpawnParams = {
  nodeRunId: string
  attempt: number
  input: unknown
  outputSchema: unknown
  toolPolicy: unknown
}

export type SpawnResult = { sessionId: string; agentId: string }

export type SubscribeParams = { executorAgentId: string; attempt: number; fromSeq: number }

export type SubscribeResult = { subscribed: boolean; fromSeq: number; lastSeq: number }

export type SendParams = { executorAgentId: string; attempt: number; instruction: string; attemptId: string }

export type CancelResult = 'interrupted' | 'not_interruptible' | 'already_stopped' | 'unknown'

export type ExecutorState = 'loaded' | 'unloaded' | 'deleted' | 'running' | 'idle'

export type StateResult = { state: ExecutorState; toolCallSeq: number; hasToolCall: boolean }

export type WhenIdleParams = { executorAgentId: string; timeoutMs: number }

export class BridgeClient {
  private readonly transport: BridgeTransport
  // 已经确认订阅的 executor；没进这个集合就不许 send（规格 7.2 行 584）
  private readonly subscribed = new Set<string>()

  constructor(transport: BridgeTransport) {
    this.transport = transport
  }

  // spawn 返回时订阅已生效，所以这里直接把 agentId 记成已订阅（规格 7.2 行 582）
  async spawn(params: SpawnParams): Promise<SpawnResult> {
    const res = await this.transport.request<SpawnResult>('executor.spawn', params)
    if (!res.agentId) throw new OrchError('PROTOCOL_VERSION_MISMATCH', 'spawn 回包缺 agentId', { params })
    this.subscribed.add(res.agentId)
    return res
  }

  // 按序号重放；断线重连用同一个 fromSeq（规格 7.2 行 583）
  async subscribe(params: SubscribeParams): Promise<SubscribeResult> {
    const res = await this.transport.request<SubscribeResult>('executor.subscribe', params)
    if (res.subscribed) this.subscribed.add(params.executorAgentId)
    return res
  }

  // send 必须在 subscribe 确认之后，否则 BRIDGE_NOT_SUBSCRIBED（规格 7.2 行 584）
  async send(params: SendParams): Promise<void> {
    if (!this.subscribed.has(params.executorAgentId)) {
      throw new OrchError('BRIDGE_NOT_SUBSCRIBED', '还没订阅确认，不许发指令', {
        executorAgentId: params.executorAgentId,
      })
    }
    await this.transport.request('executor.send', params)
  }

  // cancel 回四值之一；不在枚举里按协议不合处理（规格 7.2 行 585、4.5 行 349-353）
  async cancel(params: { executorAgentId: string; attempt: number }): Promise<CancelResult> {
    const res = await this.transport.request<CancelResult>('executor.cancel', params)
    const values: CancelResult[] = ['interrupted', 'not_interruptible', 'already_stopped', 'unknown']
    if (!values.includes(res)) {
      throw new OrchError('PROTOCOL_VERSION_MISMATCH', 'cancel 回包取值不在枚举里', { result: res })
    }
    return res
  }

  // dispose 前置 service_ack_seq >= bridge_last_seq（规格 7.2 行 585、7.3 行 595）
  async dispose(params: { executorAgentId: string; serviceAckSeq: number; bridgeLastSeq: number }): Promise<void> {
    if (params.serviceAckSeq < params.bridgeLastSeq) {
      throw proposedError('BRIDGE_ACK_LAG', '服务确认位落后于桥事件位，不许 dispose', {
        serviceAckSeq: params.serviceAckSeq,
        bridgeLastSeq: params.bridgeLastSeq,
      })
    }
    await this.transport.request('executor.dispose', { executorAgentId: params.executorAgentId })
    this.subscribed.delete(params.executorAgentId)
  }

  // state 回 loaded / unloaded / deleted / running / idle，另带 tool_call_seq 与 has_tool_call（规格 7.2 行 586）
  async state(params: { executorAgentId: string }): Promise<StateResult> {
    const res = await this.transport.request<StateResult>('executor.state', params)
    const states: ExecutorState[] = ['loaded', 'unloaded', 'deleted', 'running', 'idle']
    if (!states.includes(res.state)) {
      throw new OrchError('PROTOCOL_VERSION_MISMATCH', 'state 回包取值不在枚举里', { state: res.state })
    }
    return res
  }

  // whenIdle 必须带超时；超时按未确认停止处理，不判 indeterminate（规格 7.2 行 588）
  async whenIdle(params: WhenIdleParams): Promise<{ idle: boolean; timedOut: boolean }> {
    if (!Number.isInteger(params.timeoutMs) || params.timeoutMs <= 0) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', 'whenIdle 必须带正整数超时', { field: 'timeoutMs' })
    }
    return this.transport.request<{ idle: boolean; timedOut: boolean }>('executor.whenIdle', params)
  }

  // 断号重取用：宿主按 fromSeq 重放一页（规格 7.3 行 595）
  async fetchPage(params: { executorAgentId: string; attempt: number; fromSeq: number; pageSize: number }): Promise<{ events: BridgeEvent[] }> {
    return this.transport.request<{ events: BridgeEvent[] }>('executor.page', params)
  }

  // 订阅态给上层看：围栏里判断「要不要等」时用
  isSubscribed(executorAgentId: string): boolean {
    return this.subscribed.has(executorAgentId)
  }
}
