// src/executor/bridge-consumer.ts —— 事件流消费者：先落账，再 ACK；缺口整页补，不把最大序号当确认位。
import { OrchError } from '../core/errors.ts'
import type { BridgeClient, BridgeEvent, BridgeEventBuffer } from './bridge.ts'
import type { BridgeLedger } from './bridge-ledger.ts'

export type BridgeEventHandler = (ev: BridgeEvent, ledgerSeq: number | null) => Promise<void> | void

export class BridgeConsumer {
  private readonly client: BridgeClient
  private readonly buffer: BridgeEventBuffer
  private readonly ledger: BridgeLedger
  private readonly onEvent: BridgeEventHandler

  constructor(client: BridgeClient, buffer: BridgeEventBuffer, ledger: BridgeLedger, onEvent: BridgeEventHandler) {
    this.client = client
    this.buffer = buffer
    this.ledger = ledger
    this.onEvent = onEvent
  }

  // 持续消费一条事件流；流正常结束或 signal 取消都返回，不把“流停了”当成节点完成。
  async run(stream: AsyncIterable<BridgeEvent>, signal: AbortSignal): Promise<void> {
    try {
      for await (const ev of stream) {
        if (signal.aborted) break
        await this.receive(ev)
      }
    } catch (err) {
      if (signal.aborted) return
      throw err
    }
    if (!signal.aborted) {
      throw new OrchError('SERVICE_UNAVAILABLE', '桥事件流提前结束，节点不能按完成收口', {
        lastSeq: this.buffer.lastSeq,
        lastPersistedAckSeq: this.buffer.lastPersistedAckSeq,
      })
    }
  }

  // 单条事件：先入缓冲；有缺口先补页，再从连续位逐条落账并 ACK。
  async receive(ev: BridgeEvent): Promise<void> {
    const pushed = this.buffer.push(ev)
    if (pushed.gapFrom !== null) await this.fillGap(pushed.gapFrom)
    await this.drain()
  }

  // 整页补洞：只接受从 fromSeq 起严格连续的页；补完再 drain，不边补边跳。
  private async fillGap(fromSeq: number): Promise<void> {
    let from = fromSeq
    for (let guard = 0; guard < 1024; guard += 1) {
      if (from === null) return
      const page = await this.client.fetchPage({
        executorAgentId: this.buffer.agentId,
        attempt: this.buffer.attempt,
        fromSeq: from,
        pageSize: 256,
      })
      if (page.events.length === 0) {
        throw new OrchError('SERVICE_UNAVAILABLE', '宿主补洞返回空页，缺口无法补齐', { fromSeq: from })
      }
      let cursor = from - 1
      for (const ev of page.events) {
        if (ev.seq !== cursor + 1) {
          throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '补洞页序号不连续', { expect: cursor + 1, got: ev.seq })
        }
        cursor = ev.seq
        this.buffer.push(ev)
      }
      const next = this.buffer.gapFrom
      if (next === null) return
      if (next <= from) {
        throw new OrchError('SERVICE_UNAVAILABLE', '补洞没有推进缺口，停止重取', { fromSeq: from, next })
      }
      from = next
    }
    throw new OrchError('SERVICE_UNAVAILABLE', '补洞超过上限，缺口仍未补齐', { fromSeq })
  }

  // 从「已处理位」之后取连续事件：落账与 onEvent 都成功后才推进处理位。
  // 只落账不处理就推进，会让 onEvent 抛错后重连跳过该事件。
  // 账本里已落账但还没处理的事件（重启、旧 ACK 顺序留下的 persisted > handled）
  // 从 receipt 回查后照常处理，不能因为“不再走缓冲”就被永久跳过。
  async drain(): Promise<void> {
    for (;;) {
      const next = this.ledger.handled() + 1
      const buffered = this.buffer.takeFrom(next).find((candidate) => candidate.seq === next)
      const ev = buffered ?? this.ledger.lookup(next)
      if (!ev) return
      const ingested = this.ledger.ingest(ev)
      await this.onEvent(ev, ingested.ledgerSeq)
      // 处理位只按这条事件的桥序号推进；不能用当前落账游标代替
      this.ledger.markHandled(ingested.eventSeq)
      // 缓冲里的连续位只在事件确实来自缓冲时推进；回查重放不占缓冲的位
      if (buffered) this.buffer.ack(ingested.eventSeq, this.ledger.handled())
    }
  }

  // 等到某个序号完成处理；正常收口前必须追平，不能凭内存里的 lastSeq 释放。
  async waitPersisted(seq: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.ledger.handled() < seq) {
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return true
  }
}
