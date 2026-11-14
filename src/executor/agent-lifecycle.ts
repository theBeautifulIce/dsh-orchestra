// src/executor/agent-lifecycle.ts —— Agent 会话的生命周期：订阅、事件落账、工具回传、最终结构化输出。
// 自然语言输出不能直接改账本；这里只收集 Agent 的报告，状态变更仍走 submitReport()/applyReport()。
import { OrchError } from '../core/errors.ts'
import type { BridgeClient, BridgeEvent, BridgeEventBuffer } from './bridge.ts'
import { BridgeEventBuffer as BufferImpl } from './bridge.ts'
import { BridgeConsumer } from './bridge-consumer.ts'
import { BridgeLedger } from './bridge-ledger.ts'
import { EvidenceCollector, type ToolTraceEntry } from './evidence-collector.ts'
import type { Db } from '../infra/sqlite/driver.ts'
import type { ClockProvider } from '../core/clock.ts'
import type { ToolPolicy } from './session.ts'
import type { ToolRegistry, ReadOnlyToolRunner } from './tools.ts'
import type { ExecutorAgent } from './session.ts'

export type AgentReportEnvelope = {
  report: unknown
  evidence: unknown | null
}

export type AgentLifecycleDeps = {
  db: Db
  secret: string
  client: BridgeClient
  registry: ToolRegistry
  runner: ReadOnlyToolRunner
  policy: ToolPolicy
  allowedTools: string[]
  nodeRunId: string
  attempt: number
  agent: ExecutorAgent
  instruction: string
  timeoutMs: number
  idleTimeoutMs: number
  nowAt: () => string
  clock?: ClockProvider
  spillDir: string
}

type ReportWaiter = {
  resolve: (value: AgentReportEnvelope) => void
  reject: (reason: unknown) => void
}

// 一个节点对应一个 Agent 会话：事件流只消费本 attempt，工具调用只走宿主执行器。
export class AgentLifecycle {
  private readonly ledger: BridgeLedger
  private readonly collector: EvidenceCollector
  private readonly buffer: BridgeEventBuffer
  private readonly consumer: BridgeConsumer
  private readonly deps: AgentLifecycleDeps
  private readonly controller = new AbortController()
  private waiter: ReportWaiter | null = null
  private reportSeen = false
  private running: Promise<void> | null = null
  private stopTask: Promise<void> | null = null

  constructor(deps: AgentLifecycleDeps) {
    this.deps = deps
    const key = { nodeRunId: deps.nodeRunId, attempt: deps.attempt, executorAgentId: deps.agent.agentId }
    this.ledger = new BridgeLedger(deps.db, deps.secret, key)
    this.collector = new EvidenceCollector({
      db: deps.db,
      secret: deps.secret,
      registry: deps.registry,
      runner: deps.runner,
      policy: deps.policy,
      allowedTools: deps.allowedTools,
      nodeRunId: deps.nodeRunId,
      attempt: deps.attempt,
      executorAgentId: deps.agent.agentId,
      nowAt: deps.nowAt,
      clock: deps.clock,
    })
    const cursor = this.ledger.cursor()
    this.buffer = new BufferImpl({
      agentId: deps.agent.agentId,
      attempt: deps.attempt,
      nodeRunId: deps.nodeRunId,
      spillDir: deps.spillDir,
      limitBytes: 4 * 1024 * 1024,
      highWaterBytes: 2 * 1024 * 1024,
    }, {
      lastPersistedAckSeq: cursor,
      lookupPersisted: (seq) => this.ledger.lookup(seq),
    })
    this.consumer = new BridgeConsumer(deps.client, this.buffer, this.ledger, (ev) => this.onEvent(ev))
  }

  get trace(): ToolTraceEntry[] {
    return this.collector.traceEntries
  }

  get lastEvidence(): unknown | null {
    return this.collector.lastEvidence
  }

  get agentId(): string {
    return this.deps.agent.agentId
  }

  get cursor(): number {
    return this.ledger.cursor()
  }

  get lastSeq(): number {
    return this.buffer.lastSeq
  }

  // 启动事件流并发出任务；只有收到结构化 report 才收口，自然语言文本不触发完成。
  async run(signal: AbortSignal): Promise<AgentReportEnvelope> {
    const timeout = setTimeout(() => {
      this.controller.abort(new OrchError('OPERATION_TIMEOUT', 'Agent 生命周期超过节点动作上限', {
        nodeRunId: this.deps.nodeRunId, attempt: this.deps.attempt, timeoutMs: this.deps.timeoutMs,
      }))
    }, this.deps.timeoutMs)
    const onAbort = (): void => { this.controller.abort(signal.reason) }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    // 中止竞速必须从 subscribe 之前就存在：订阅或发送挂住时，动作超时同样要能打穿。
    const aborted = new Promise<never>((_, reject) => {
      const onStop = (): void => { reject(this.abortReason()) }
      if (this.controller.signal.aborted) onStop()
      else this.controller.signal.addEventListener('abort', onStop, { once: true })
    })
    // 若超时先发生、后续才走到 race，这个拒绝仍然必须被视为已处理，不能让进程因 unhandledRejection 退出。
    void aborted.catch(() => {})
    const guarded = <T>(task: Promise<T>): Promise<T> => Promise.race([task, aborted])
    try {
      const fromSeq = this.ledger.cursor()
      const subscribed = await guarded(this.deps.client.subscribe({
        executorAgentId: this.agentId, attempt: this.deps.attempt, fromSeq,
      }))
      if (!subscribed.subscribed) {
        throw new OrchError('BRIDGE_NOT_SUBSCRIBED', 'Agent 订阅未确认，不能开始执行', { agentId: this.agentId })
      }
      const report = new Promise<AgentReportEnvelope>((resolve, reject) => {
        this.waiter = { resolve, reject }
      })
      this.running = this.consume(this.controller.signal).catch((err) => {
        if (!this.reportSeen) this.waiter?.reject(err)
      })
      await guarded(this.deps.client.send({
        executorAgentId: this.agentId,
        attempt: this.deps.attempt,
        instruction: this.deps.instruction,
        attemptId: this.deps.nodeRunId + ':' + String(this.deps.attempt),
      }))
      return await guarded(report)
    } catch (err) {
      if (this.controller.signal.aborted && this.controller.signal.reason instanceof OrchError) {
        throw this.controller.signal.reason
      }
      throw err
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }

  // 断线重连：每次都从账本已确认位重新 listen，宿主按 fromSeq 重放；已落账事件由 buffer 幂等去重。
  // 重试有界，连续失败就把错误交给 run()，节点按失败收口，不无限挂住。
  private async consume(signal: AbortSignal): Promise<void> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) return
      const fromSeq = this.ledger.cursor()
      try {
        const stream = this.deps.client.listen(
          { executorAgentId: this.agentId, attempt: this.deps.attempt, fromSeq },
          signal,
        )
        await this.consumer.run(stream, signal)
        if (signal.aborted) return
        lastError = new OrchError('SERVICE_UNAVAILABLE', '桥事件流提前结束，等待重连', { fromSeq })
      } catch (err) {
        if (signal.aborted) return
        // 只有“流断了/宿主暂不可用”才重连；工具越权、协议冲突、证据缺失是确定性失败，
        // 重放同一条事件只会把错误拖成 BRIDGE_SEQ_CONFLICT。
        if (!(err instanceof OrchError) || err.code !== 'SERVICE_UNAVAILABLE') throw err
        lastError = err
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw lastError ?? new OrchError('SERVICE_UNAVAILABLE', '桥事件流重连次数用尽', {})
  }

  // 让消费器把收到的最后一条追平到持久确认位；追不平就按未完成处理。
  async flush(timeoutMs: number): Promise<boolean> {
    return this.consumer.waitPersisted(this.buffer.lastSeq, timeoutMs)
  }

  // 同一次生命周期只执行一轮停止：第一次失败后 finally 再调不能重发取消/释放，
  // 否则会把一次可确认的失败变成两次副作用。
  stop(): Promise<void> {
    this.stopTask ??= this.stopInternal()
    return this.stopTask
  }

  private abortReason(): OrchError {
    const reason = this.controller.signal.reason
    if (reason instanceof OrchError) return reason
    return new OrchError('SERVICE_UNAVAILABLE', 'Agent 生命周期被中止', {
      nodeRunId: this.deps.nodeRunId, attempt: this.deps.attempt,
    })
  }

  // 先停止监听，再取消会话；interrupted 不当作已停止，必须 whenIdle+state 复核。
  private async stopInternal(): Promise<void> {
    this.controller.abort(new OrchError('SERVICE_UNAVAILABLE', '节点收口，停止监听', {}))
    if (this.running) {
      await this.running.catch(() => undefined)
      this.running = null
    }
    try {
      await this.deps.client.cancel({ executorAgentId: this.agentId, attempt: this.deps.attempt })
    } catch {
      // 取消失败不掩盖真正的失败原因；下面仍要复核状态
    }
    let idle: { idle: boolean; timedOut: boolean } | null = null
    try {
      idle = await this.deps.client.whenIdle({ executorAgentId: this.agentId, timeoutMs: this.deps.idleTimeoutMs })
    } catch {
      idle = null
    }
    let state: { state: string; toolCallSeq: number; hasToolCall: boolean } | null = null
    try {
      state = await this.deps.client.state({ executorAgentId: this.agentId })
    } catch {
      state = null
    }
    // 两个条件都要成立：whenIdle 只说明“当前没在跑”，state 才说明会话确实落到可释放的终态；
    // idle:true + state:running 这种矛盾回包不能直接 dispose。
    const idleOk = idle?.idle === true
    const stateOk = state?.state === 'idle' || state?.state === 'unloaded' || state?.state === 'deleted'
    if (!idleOk || !stateOk) {
      throw new OrchError('LEASE_EXPIRED', 'Agent 未确认停止，不能推断副作用不存在', {
        agentId: this.agentId, idle, state,
      })
    }
    // 服务端确认位没追平桥事件位时，dispose 会拒绝；这是有意的，不能提前放掉宿主。
    await this.deps.client.dispose({
      executorAgentId: this.agentId,
      serviceAckSeq: this.ledger.cursor(),
      bridgeLastSeq: this.buffer.lastSeq,
    })
    this.buffer.cleanupSpill()
  }

  private async onEvent(ev: BridgeEvent): Promise<void> {
    const payload = ev.payload as Record<string, unknown> | null
    if (ev.type === 'tool.call') {
      const result = await this.collector.collect(payload)
      await this.deps.client.toolResult({
        executorAgentId: this.agentId,
        attempt: this.deps.attempt,
        callId: result.callId,
        result: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
      })
      return
    }
    if (!this.reportSeen && isReportEnvelope(payload)) {
      this.reportSeen = true
      const report = payload.report
      // 不能在这里 await flush：本条事件的 ACK 要等 onEvent 返回后由消费器推进，
      // 在 onEvent 里等确认位会自我等待到超时。交给后台追平，run() 仍等确认后再收口。
      void this.flush(5_000).then((persisted) => {
        if (persisted) this.waiter?.resolve({ report, evidence: this.collector.lastEvidence })
        else this.waiter?.reject(new OrchError('SERVICE_UNAVAILABLE', 'Agent 报告未落账，不能收口', {
          lastSeq: this.buffer.lastSeq, cursor: this.ledger.cursor(),
        }))
      }, (err: unknown) => { this.waiter?.reject(err) })
    }
  }
}

function isReportEnvelope(payload: Record<string, unknown> | null): payload is { report: unknown } {
  if (!payload || typeof payload !== 'object') return false
  if (payload.kind !== 'report') return false
  const report = payload.report
  return report !== null && typeof report === 'object' && !Array.isArray(report)
}
