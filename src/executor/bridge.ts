// src/executor/bridge.ts —— 桥 RPC 客户端：最小七方法（规格 7.2 行 582-590）
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OrchError, proposedError } from '../core/errors.ts'

// 宿主侧传输契约：方法名 + 参数，返回值由宿主给
export type BridgeTransport = {
  request<T>(method: string, params: unknown): Promise<T>
}

// 事件类型固定五类，写别的直接拒（规格 7.2 行 590）
export const BRIDGE_EVENT_TYPES = ['step', 'turn', 'tool.call', 'tool.start', 'tool.result'] as const
export type BridgeEventType = (typeof BRIDGE_EVENT_TYPES)[number]

export type BridgeEvent = {
  seq: number
  type: BridgeEventType
  at: string
  // tool.start 的时间锚点；动作计时用它，不拿 tool.call 的时间当动作起点
  toolStartAt: string | null
  payload: unknown
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

// —— 桥事件缓冲与断号重取（规格 7.3 行 594-597）——

export type BridgeBufferOptions = {
  limitBytes: number
  highWaterBytes: number
  spillDir: string
  agentId: string
}

export class BridgeEventBuffer {
  private readonly opts: BridgeBufferOptions
  private readonly events: BridgeEvent[] = []
  private bytes = 0
  private seqCursor = 0
  // 落盘片段按序保留：二次 spill 不许覆盖前一段，否则早期事件取不回（规格 7.3 行 594）
  private spillFiles: string[] = []

  constructor(opts: BridgeBufferOptions) {
    this.opts = opts
  }

  // 收一条事件：类型固定、序号单调、同号重复按幂等跳过
  // 返回 gapFrom：非空表示中间断了号，调用方要整页重取
  push(ev: BridgeEvent): { accepted: boolean; gapFrom: number | null } {
    if (!BRIDGE_EVENT_TYPES.includes(ev.type)) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件类型不在固定清单里', { type: ev.type })
    }
    if (ev.seq <= this.seqCursor) {
      if (ev.seq === this.seqCursor) return { accepted: false, gapFrom: null }
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件序号倒退', { seq: ev.seq, lastSeq: this.seqCursor })
    }
    const gapFrom = ev.seq === this.seqCursor + 1 ? null : this.seqCursor + 1
    const size = Buffer.byteLength(JSON.stringify(ev), 'utf8')
    // 常驻内存有硬上限：先落盘再收；单条就超上限说明配置或事件异常
    if (this.bytes + size > this.opts.limitBytes) {
      this.spill()
      if (size > this.opts.limitBytes) {
        throw new OrchError('SERVICE_UNAVAILABLE', '单条桥事件超过缓冲上限，证据许可不了', { seq: ev.seq, size })
      }
    }
    this.events.push(ev)
    this.bytes += size
    this.seqCursor = ev.seq
    if (this.bytes >= this.opts.highWaterBytes) this.spill()
    return { accepted: true, gapFrom }
  }

  // 超过高水位就落盘：证据不丢，只是搬到磁盘（规格 7.3 行 594）
  private spill(): void {
    const first = this.events[0]
    if (!first) return
    // 每段一个文件，文件名带起止序号；绝不复用上一段的文件名
    const last = this.events[this.events.length - 1] ?? first
    const file = join(this.opts.spillDir, this.opts.agentId + '-' + first.seq + '-' + last.seq + '.jsonl')
    const body = this.events.map((e) => JSON.stringify(e)).join('\n')
    try {
      appendFileSync(file, body + '\n', 'utf8')
    } catch (err) {
      // 落盘失败等于证据要丢，宁可报错也不许静默丢
      throw new OrchError('SERVICE_UNAVAILABLE', '桥缓冲溢出且落盘失败，证据不许丢', {
        file: String(err), seq: first.seq,
      })
    }
    if (!this.spillFiles.includes(file)) this.spillFiles.push(file)
    this.events.length = 0
    this.bytes = 0
  }

  private readSpill(file: string): BridgeEvent[] {
    const out: BridgeEvent[] = []
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      out.push(JSON.parse(line) as BridgeEvent)
    }
    return out
  }

  // 取 fromSeq 之后的全部事件：所有 spill 片段加内存，按 seq 去重排序
  takeFrom(fromSeq: number): BridgeEvent[] {
    const bySeq = new Map<number, BridgeEvent>()
    for (const file of this.spillFiles) {
      for (const ev of this.readSpill(file)) {
        if (ev.seq >= fromSeq) bySeq.set(ev.seq, ev)
      }
    }
    for (const ev of this.events) {
      if (ev.seq >= fromSeq) bySeq.set(ev.seq, ev)
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  }

  // 动作计时锚点：最近一条 tool.start 的时间，落盘的也要看（规格 7.2 行 590）
  toolStartAnchor(): string | null {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const ev = this.events[i]
      if (ev && ev.type === 'tool.start') return ev.toolStartAt ?? ev.at
    }
    for (let f = this.spillFiles.length - 1; f >= 0; f -= 1) {
      const file = this.spillFiles[f]
      if (!file) continue
      const evs = this.readSpill(file)
      for (let i = evs.length - 1; i >= 0; i -= 1) {
        const ev = evs[i]
        if (ev && ev.type === 'tool.start') return ev.toolStartAt ?? ev.at
      }
    }
    return null
  }

  get lastSeq(): number { return this.seqCursor }
  get spilled(): boolean { return this.spillFiles.length > 0 }
  get spillCount(): number { return this.spillFiles.length }
  get bufferedBytes(): number { return this.bytes }
}

// 断号不许增量补洞：整页重取，从缺口起点一次拉一页（规格 7.3 行 595）
export async function refillPage(
  client: BridgeClient,
  params: { executorAgentId: string; attempt: number; gapFrom: number; pageSize?: number },
  receive: (events: BridgeEvent[]) => void,
): Promise<number> {
  const pageSize = params.pageSize ?? 256
  // 宿主按 fromSeq 重放，回包里带事件页；页里序号连续才收
  const page = await client.fetchPage({
    executorAgentId: params.executorAgentId,
    attempt: params.attempt,
    fromSeq: params.gapFrom,
    pageSize,
  })
  let cursor = params.gapFrom - 1
  for (const ev of page.events) {
    if (ev.seq !== cursor + 1) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '重取页里序号不连续', { expect: cursor + 1, got: ev.seq })
    }
    cursor = ev.seq
    receive([ev])
  }
  return cursor
}

