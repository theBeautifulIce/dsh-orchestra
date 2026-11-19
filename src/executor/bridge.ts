// src/executor/bridge.ts —— 桥 RPC 客户端：最小七方法（规格 7.2 行 582-590）
import { appendFileSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson } from '../core/canonical.ts'
import { OrchError, proposedError } from '../core/errors.ts'
import type { HostAgentFactory } from './session.ts'

// 宿主侧事件流：长生命周期的 AsyncIterable，AbortSignal 负责取消/释放
export type BridgeEventSource = {
  listen(
    params: { executorAgentId: string; attempt: number; fromSeq: number },
    signal: AbortSignal,
  ): AsyncIterable<BridgeEvent>
}

// 宿主侧传输契约：方法名 + 参数，返回值由宿主给；listen 是持续事件流
export type BridgeTransport = BridgeEventSource & {
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
  // 宿主能带就带；带了就必须与当前 attempt/agent 一致，防止旧流串进新 attempt
  attempt?: number
  executorAgentId?: string
}

export type SpawnParams = {
  nodeRunId: string
  attempt: number
  input: unknown
  outputSchema: unknown
  toolPolicy: unknown
  // 节点执行永远开新会话；把这条意图放进协议，不能只靠宿主默认行为。
  inheritHistory: false
  modelRef?: string
  actionGeneration?: number
}

export type SpawnResult = { sessionId: string; agentId: string; effectiveModelRef?: string }

export type SubscribeParams = { executorAgentId: string; attempt: number; fromSeq: number }

export type SubscribeResult = { subscribed: boolean; fromSeq: number; lastSeq: number }

export type SendParams = { executorAgentId: string; attempt: number; instruction: string; attemptId: string }

export type CancelResult = 'interrupted' | 'not_interruptible' | 'already_stopped' | 'unknown'

export type ExecutorState = 'loaded' | 'unloaded' | 'deleted' | 'running' | 'idle'

export type StateResult = { state: ExecutorState; toolCallSeq: number; hasToolCall: boolean }

export type WhenIdleParams = { executorAgentId: string; timeoutMs: number }

// 生产装配的默认宿主工厂：节点执行只经桥 spawn，不在编排进程里直接造 Agent 会话。
export function bridgeHostAgentFactory(client: BridgeClient): HostAgentFactory {
  return {
    create: async (input) => {
      const res = await client.spawn({
        nodeRunId: input.nodeRunId,
        attempt: input.attempt,
        input: input.input,
        outputSchema: input.outputSchema,
        toolPolicy: input.toolPolicy,
        inheritHistory: false,
        ...(input.modelRef ? { modelRef: input.modelRef } : {}),
        ...(input.actionGeneration !== undefined ? { actionGeneration: input.actionGeneration } : {}),
      })
      return res
    },
  }
}

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

  // 持续事件流：订阅确认后从 fromSeq 开始重放并继续收；signal 结束监听
  listen(params: { executorAgentId: string; attempt: number; fromSeq: number }, signal: AbortSignal): AsyncIterable<BridgeEvent> {
    return this.transport.listen(params, signal)
  }

  // 工具结果由宿主执行后回传；这只结束 Agent 的这次 tool.call，不改变账本状态
  async toolResult(params: {
    executorAgentId: string
    attempt: number
    callId: string
    result: { exitCode: number; stdout: string; stderr: string; evidenceId?: string }
  }): Promise<void> {
    await this.transport.request('executor.toolResult', params)
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
  // spill 文件名按 attempt 隔离，防止旧 attempt 追加进同一文件
  attempt?: number
  nodeRunId?: string
}

export type BridgeBufferInit = {
  lastPersistedAckSeq?: number
  // 已落账事件按 seq 回查：重启后同 seq 不同 payload 仍能判冲突
  lookupPersisted?: (seq: number) => BridgeEvent | undefined
}

export class BridgeEventBuffer {
  private readonly opts: BridgeBufferOptions
  private readonly events: BridgeEvent[] = []
  private bytes = 0
  private lastReceivedSeqValue = 0
  private lastContiguousSeqValue = 0
  private lastPersistedAckSeqValue = 0
  // 已收到但还没连成连续段的事件：按 seq 暂存，补洞后依次放行
  private readonly pending = new Map<number, BridgeEvent>()
  private readonly lookupPersisted?: (seq: number) => BridgeEvent | undefined
  // 落盘片段按序保留：二次 spill 不许覆盖前一段，否则早期事件取不回（规格 7.3 行 594）
  private spillFiles: string[] = []

  constructor(opts: BridgeBufferOptions, init: BridgeBufferInit = {}) {
    this.opts = opts
    const ack = init.lastPersistedAckSeq ?? 0
    if (!Number.isInteger(ack) || ack < 0) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '持久确认游标必须是非负整数', { lastPersistedAckSeq: ack })
    }
    // 有持久确认位却查不到已落账事件，重启冲突检测会静默退化成“已收到”，必须拒绝构造
    if (ack > 0 && !init.lookupPersisted) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '有持久确认位时必须注入已落账事件回查，否则重启冲突检测会静默失效', { lastPersistedAckSeq: ack })
    }
    this.lastPersistedAckSeqValue = ack
    this.lastContiguousSeqValue = ack
    this.lastReceivedSeqValue = ack
    this.lookupPersisted = init.lookupPersisted
    this.loadSpill()
  }

  // 重启后先按 attempt 前缀认回自己的 spill，再按 seq 恢复连续位与缺口
  private loadSpill(): void {
    let names: string[]
    try {
      names = readdirSync(this.opts.spillDir)
    } catch {
      return
    }
    const prefix = this.spillPrefix()
    const files = names
      .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
      .map((name) => join(this.opts.spillDir, name))
      .sort()
    if (files.length === 0) return
    this.spillFiles = files
    const bySeq = new Map<number, BridgeEvent>()
    for (const file of files) {
      for (const ev of this.readSpill(file)) {
        if (!bySeq.has(ev.seq)) bySeq.set(ev.seq, ev)
      }
    }
    for (const seq of [...bySeq.keys()].sort((a, b) => a - b)) {
      const ev = bySeq.get(seq)!
      if (ev.seq <= this.lastPersistedAckSeqValue) continue
      if (ev.seq === this.lastContiguousSeqValue + 1) this.lastContiguousSeqValue = ev.seq
      else this.pending.set(ev.seq, ev)
      if (ev.seq > this.lastReceivedSeqValue) this.lastReceivedSeqValue = ev.seq
    }
  }

  // 节点已确认收口并 dispose 后，清掉本 attempt 的 spill 段；删不掉只留文件，不影响账本。
  cleanupSpill(): void {
    for (const file of this.spillFiles) {
      try { unlinkSync(file) } catch { /* 已被清理或占用 */ }
    }
    this.spillFiles = []
  }

  private spillPrefix(): string {
    const run = (this.opts.nodeRunId ?? 'nr').replace(/[^A-Za-z0-9_.-]/g, '_')
    const agent = this.opts.agentId.replace(/[^A-Za-z0-9_.-]/g, '_')
    return run + '-' + agent + '-a' + String(this.opts.attempt ?? 0) + '-'
  }

  private currentGap(): number | null {
    return this.pending.size > 0 ? this.lastContiguousSeqValue + 1 : null
  }

  // 收一条事件：类型固定、同号同 payload 幂等、同号不同 payload 协议冲突
  // 返回 gapFrom：非空表示中间断了号，调用方要整页重取
  push(ev: BridgeEvent): { accepted: boolean; gapFrom: number | null } {
    if (!BRIDGE_EVENT_TYPES.includes(ev.type)) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件类型不在固定清单里', { type: ev.type })
    }
    if (!Number.isInteger(ev.seq) || ev.seq < 1) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件序号必须是正整数', { seq: ev.seq })
    }
    if (ev.attempt !== undefined && this.opts.attempt !== undefined && ev.attempt !== this.opts.attempt) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件 attempt 与当前缓冲不一致', { eventAttempt: ev.attempt, bufferAttempt: this.opts.attempt })
    }
    if (ev.executorAgentId !== undefined && ev.executorAgentId !== this.opts.agentId) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '桥事件 executorAgentId 与当前缓冲不一致', { eventAgent: ev.executorAgentId, bufferAgent: this.opts.agentId })
    }
    if (ev.seq <= this.lastPersistedAckSeqValue) {
      const stored = this.findStored(ev.seq)
      if (stored) this.assertSamePayload(stored, ev)
      return { accepted: false, gapFrom: this.currentGap() }
    }
    const stored = this.findStored(ev.seq)
    if (stored) {
      this.assertSamePayload(stored, ev)
      return { accepted: false, gapFrom: this.currentGap() }
    }
    if (ev.seq <= this.lastContiguousSeqValue) return { accepted: false, gapFrom: this.currentGap() }

    this.store(ev)
    this.pending.set(ev.seq, ev)
    if (ev.seq > this.lastReceivedSeqValue) this.lastReceivedSeqValue = ev.seq
    // 只有从已确认位置之后连续到达的事件才推进连续游标
    while (this.pending.has(this.lastContiguousSeqValue + 1)) {
      this.pending.delete(this.lastContiguousSeqValue + 1)
      this.lastContiguousSeqValue += 1
    }
    return {
      accepted: true,
      gapFrom: this.pending.size > 0 ? this.lastContiguousSeqValue + 1 : null,
    }
  }

  // 本地账本提交成功后调用：必须同时给账本已提交的游标，只能逐条推进
  ack(seq: number, persistedAckSeq: number): void {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '确认序号必须是非负整数', { seq })
    }
    if (!Number.isInteger(persistedAckSeq) || persistedAckSeq < 0) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '账本确认游标必须是非负整数', { persistedAckSeq })
    }
    if (seq <= this.lastPersistedAckSeqValue) return
    if (persistedAckSeq < seq) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '确认位尚未落账，先提交账本', { seq, persistedAckSeq })
    }
    if (seq > this.lastContiguousSeqValue) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '确认位超过连续收到位，先补洞', {
        seq, lastContiguousSeq: this.lastContiguousSeqValue,
      })
    }
    if (seq !== this.lastPersistedAckSeqValue + 1) {
      throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '确认位必须逐条推进', {
        seq, lastPersistedAckSeq: this.lastPersistedAckSeqValue,
      })
    }
    this.lastPersistedAckSeqValue = seq
  }

  private store(ev: BridgeEvent): void {
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
    if (this.bytes >= this.opts.highWaterBytes) this.spill()
  }

  private findStored(seq: number): BridgeEvent | undefined {
    for (const ev of this.events) if (ev.seq === seq) return ev
    for (const file of this.spillFiles) {
      for (const ev of this.readSpill(file)) if (ev.seq === seq) return ev
    }
    return this.lookupPersisted?.(seq)
  }

  // 幂等只认 type + payload；宿主持久重放重建 at 字段时不误判冲突
  private assertSamePayload(a: BridgeEvent, b: BridgeEvent): void {
    if (a.type !== b.type || canonicalJson(a.payload) !== canonicalJson(b.payload)) {
      throw proposedError('BRIDGE_SEQ_CONFLICT', '同一桥序号出现了不同 payload，按协议冲突拒绝', {
        seq: b.seq,
      })
    }
  }

  // 超过高水位就落盘：证据不丢，只是搬到磁盘（规格 7.3 行 594）
  private spill(): void {
    const first = this.events[0]
    if (!first) return
    // 每段一个文件，文件名带起止序号；绝不复用上一段的文件名
    const last = this.events[this.events.length - 1] ?? first
    const file = join(this.opts.spillDir, this.spillPrefix() + first.seq + '-' + last.seq + '.jsonl')
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
    const lines = text.split('\n')
    // 崩溃可能留下没有换行的半行；只容错最后一行，完整行的损坏仍要报错
    const endsWithNewline = text.endsWith('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as BridgeEvent)
      } catch (err) {
        if (!endsWithNewline && i === lines.length - 1) break
        throw err
      }
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

  get agentId(): string { return this.opts.agentId }
  get attempt(): number { return this.opts.attempt ?? 0 }
  get lastSeq(): number { return this.lastReceivedSeqValue }
  get lastReceivedSeq(): number { return this.lastReceivedSeqValue }
  get lastContiguousSeq(): number { return this.lastContiguousSeqValue }
  get lastPersistedAckSeq(): number { return this.lastPersistedAckSeqValue }
  get pendingCount(): number { return this.pending.size }
  get gapFrom(): number | null { return this.pending.size > 0 ? this.lastContiguousSeqValue + 1 : null }
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

