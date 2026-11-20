// 执行调度器：真正限制同时执行的并发数（配置 execution.concurrency / human_slots）
// 评审 P1：agent 执行是长时间任务，不许占着写队列的名额；并发闸单独放在这里，
// 写队列只管短时数据库写与背压。配置里的 concurrency 与 human_slots 在这里真正生效。
import { OrchError } from '../core/errors.ts'
import { type Logger, nullLogger } from '../infra/logger.ts'
import type { OrchestraConfig } from '../core/config.ts'

// 与 orchestra.config.json 的定值一致：并发 3、人工名额 1
export const DEFAULT_EXECUTION_CONCURRENCY = 3
export const DEFAULT_HUMAN_SLOTS = 1
// 排队上限：生产默认必须有界，不能让无限 Promise 把内存与停机时间拖垮（S2 第三十七轮 P1-01）。
export const DEFAULT_MAX_WAITING = 1000

export type ExecutionWorkflowScope = { runId: string; workflowId: string; nodeId: string }
type ResolveWorkflowLimits = (scope: ExecutionWorkflowScope) => { runLimit: number | null; nodeLimit: number | null }

export type ExecutionTaskOptions = {
  // 占人工名额：等人复核的任务同时最多 human_slots 个
  human?: boolean
  // 任务名：只进日志与排队信息，便于定位是谁在排
  label?: string
  nodeRunId?: string
  attempt?: number
  workflowScope?: ExecutionWorkflowScope
}

export type ExecutionStats = {
  // 正在跑的任务数
  inFlight: number
  // 排队等名额的任务数
  waiting: number
  concurrency: number
  humanSlots: number
  // 正在跑且占着人工名额的任务数
  humanInFlight: number
  maxWaiting: number
}

export type ExecutionScheduler = {
  // 排进调度器：名额空出来才开跑，任务抛错也照样释放名额
  run<T>(fn: () => Promise<T> | T, opts?: ExecutionTaskOptions): Promise<T>
  stats(): ExecutionStats
  isWaiting?(nodeRunId: string): boolean
  cancelWaiting?(nodeRunId: string, attempt: number): void
  configureWorkflowLimits?(resolve: ResolveWorkflowLimits): void
  readonly inFlight: number
  readonly waiting: number
  readonly concurrency: number
  readonly humanSlots: number
  // 关闭调度器：drain=true 等队列与在跑任务收完；drain=false 立即拒掉排队任务，在跑任务自然结束。
  // 两种模式都会停止接收新任务，重复调用返回同一个 Promise。
  close(opts?: { drain?: boolean }): Promise<void>
}

export type ExecutionCapacity = Pick<ExecutionStats, 'concurrency' | 'maxWaiting'>

export type ConfigurableExecutionScheduler = ExecutionScheduler & {
  setCapacity(capacity: ExecutionCapacity): void
  configureWorkflowLimits(resolve: ResolveWorkflowLimits): void
}

type QueuedTask = {
  human: boolean
  label: string
  nodeRunId?: string
  attempt?: number
  workflow?: { scope: ExecutionWorkflowScope; nodeKey: string }
  // 真正开跑的那一步
  invoke: () => Promise<unknown> | unknown
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

type SchedulerOptions = {
  concurrency: number
  humanSlots: number
  maxWaiting: number
  log: Logger
}

// 名额与上限都得是正经正数：配错就在装配期拒掉，不许带着 0 并发跑起来
function positive(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new OrchError('SCHEMA_VERSION_UNSUPPORTED', '执行调度的参数不合法', { field, value })
  }
  return value
}

class Scheduler {
  private concurrencyLimit: number
  private readonly humanSlotLimit: number
  private maxWaiting: number
  private readonly log: Logger
  // 等待中的任务：先进先出，谁先到谁先拿名额
  private readonly queue: QueuedTask[] = []
  private running = 0
  private humanRunning = 0
  private readonly runningByRun = new Map<string, number>()
  private readonly runningByWorkflowNode = new Map<string, number>()
  private resolveWorkflowLimits?: ResolveWorkflowLimits
  // 关闭状态：accepting=false 后新任务一律拒；draining=true 时队列继续跑完。
  private accepting = true
  private draining = false
  private closePromise: Promise<void> | null = null
  private resolveClose: (() => void) | null = null

  constructor(opts: SchedulerOptions) {
    this.concurrencyLimit = positive(opts.concurrency, 'concurrency')
    this.humanSlotLimit = positive(opts.humanSlots, 'human_slots')
    this.maxWaiting = positive(opts.maxWaiting, 'max_waiting')
    this.log = opts.log
  }

  get inFlight(): number {
    return this.running
  }

  get waiting(): number {
    return this.queue.length
  }

  get concurrency(): number {
    return this.concurrencyLimit
  }

  get humanSlots(): number {
    return this.humanSlotLimit
  }

  stats(): ExecutionStats {
    return {
      inFlight: this.running,
      waiting: this.queue.length,
      concurrency: this.concurrencyLimit,
      humanSlots: this.humanSlotLimit,
      humanInFlight: this.humanRunning,
      maxWaiting: this.maxWaiting,
    }
  }

  isWaiting(nodeRunId: string): boolean {
    return this.queue.some((task) => task.nodeRunId === nodeRunId)
  }

  cancelWaiting(nodeRunId: string, attempt: number): void {
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const task = this.queue[index]!
      if (task.nodeRunId !== nodeRunId || task.attempt !== attempt) continue
      this.queue.splice(index, 1)
      task.reject(new OrchError('STALE_GENERATION', '本次步骤尝试已取消排队'))
    }
    this.settleClose()
  }

  setCapacity(capacity: ExecutionCapacity): void {
    const concurrency = positive(capacity.concurrency, 'concurrency')
    const maxWaiting = positive(capacity.maxWaiting, 'max_waiting')
    this.concurrencyLimit = concurrency
    this.maxWaiting = maxWaiting
    this.pump()
  }

  configureWorkflowLimits(resolve: ResolveWorkflowLimits): void {
    this.resolveWorkflowLimits = resolve
    this.pump()
  }

  run<T>(fn: () => Promise<T> | T, opts?: ExecutionTaskOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.accepting) {
        reject(new OrchError('SERVICE_UNAVAILABLE', '调度器已关闭，先别排', { label: opts?.label ?? '' }))
        return
      }
      const scope = opts?.workflowScope ? { ...opts.workflowScope } : undefined
      const task: QueuedTask = {
        human: opts?.human === true,
        label: opts?.label ?? '',
        nodeRunId: opts?.nodeRunId,
        attempt: opts?.attempt,
        workflow: scope && { scope, nodeKey: JSON.stringify([scope.workflowId, scope.nodeId]) },
        invoke: fn,
        resolve: (value) => { resolve(value as T) },
        reject: (reason) => { reject(reason) },
      }
      if (this.queue.length >= this.maxWaiting && !this.canStart(task)) {
        this.log.warn('执行队列满了，拒掉这一件', { waiting: this.queue.length, maxWaiting: this.maxWaiting })
        reject(new OrchError('SERVICE_UNAVAILABLE', '执行队列满了，先别排', {
          maxWaiting: this.maxWaiting,
          waiting: this.queue.length,
        }))
        return
      }
      this.queue.push(task)
      this.log.info('执行任务入队', { label: task.label, waiting: this.queue.length, inFlight: this.running })
      this.pump()
    })
  }

  close(opts: { drain?: boolean } = {}): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.accepting = false
    this.draining = opts.drain !== false
    this.closePromise = new Promise<void>((resolve) => { this.resolveClose = resolve })
    if (!this.draining) {
      const pending = this.queue.splice(0)
      for (const task of pending) {
        this.log.warn('调度器关闭，取消排队任务', { label: task.label, waiting: pending.length })
        task.reject(new OrchError('SERVICE_UNAVAILABLE', '调度器已关闭，排队任务已取消', { label: task.label }))
      }
    } else {
      this.pump()
    }
    this.settleClose()
    return this.closePromise
  }

  // 只在所有该收的都收完时兑现关闭 Promise：drain 模式要等队列清空，紧急模式只等在跑任务结束。
  private settleClose(): void {
    if (this.accepting || this.running > 0) return
    if (this.draining && this.queue.length > 0) return
    this.resolveClose?.()
    this.resolveClose = null
  }

  private canStart(task: QueuedTask): boolean {
    if (this.running >= this.concurrencyLimit || (task.human && this.humanRunning >= this.humanSlotLimit)) return false
    if (!task.workflow || !this.resolveWorkflowLimits) return true
    const { scope, nodeKey } = task.workflow
    const { runLimit, nodeLimit } = this.resolveWorkflowLimits(scope)
    return (runLimit === null || (this.runningByRun.get(scope.runId) ?? 0) < runLimit)
      && (nodeLimit === null || (this.runningByWorkflowNode.get(nodeKey) ?? 0) < nodeLimit)
  }

  private trackWorkflowTask(task: QueuedTask, delta: 1 | -1): void {
    if (!task.workflow) return
    changeCount(this.runningByRun, task.workflow.scope.runId, delta)
    changeCount(this.runningByWorkflowNode, task.workflow.nodeKey, delta)
  }

  // 按入队顺序取首个仍有所有所需名额的任务。
  private pump(): void {
    while (this.running < this.concurrencyLimit && this.queue.length > 0) {
      const idx = this.queue.findIndex((task) => this.canStart(task))
      if (idx < 0) return
      const [task] = this.queue.splice(idx, 1)
      if (!task) return
      void this.launch(task)
    }
  }

  // 跑一件任务：名额在答复调用方之前就还回去
  // 这样调用方拿到结果时看到的计数已经是收干净的样子（成功与抛错都一样）
  private async launch(task: QueuedTask): Promise<void> {
    this.running += 1
    if (task.human) this.humanRunning += 1
    this.trackWorkflowTask(task, 1)
    this.log.info('执行任务开跑', { label: task.label, inFlight: this.running, waiting: this.queue.length })
    let value: unknown = undefined
    let failure: unknown = null
    let failed = false
    try {
      value = await task.invoke()
    } catch (err) {
      failed = true
      failure = err
    }
    this.running -= 1
    if (task.human) this.humanRunning -= 1
    this.trackWorkflowTask(task, -1)
    this.pump()
    this.settleClose()
    if (failed) task.reject(failure)
    else task.resolve(value)
  }
}

function changeCount(counts: Map<string, number>, key: string, delta: 1 | -1): void {
  const next = (counts.get(key) ?? 0) + delta
  if (next === 0) counts.delete(key)
  else counts.set(key, next)
}

export function createExecutionScheduler(opts: {
  concurrency?: number
  humanSlots?: number
  // 排队上限：超了直接拒（背压）。缺省为有界默认值，避免生产队列无界
  maxWaiting?: number
  log?: Logger
} = {}): ConfigurableExecutionScheduler {
  return new Scheduler({
    concurrency: opts.concurrency ?? DEFAULT_EXECUTION_CONCURRENCY,
    humanSlots: opts.humanSlots ?? DEFAULT_HUMAN_SLOTS,
    maxWaiting: opts.maxWaiting ?? DEFAULT_MAX_WAITING,
    log: opts.log ?? nullLogger,
  })
}

// 配置提供宿主默认值；S6 可以在运行时覆盖并发和排队上限。
export function createExecutionSchedulerFromConfig(cfg: OrchestraConfig, log?: Logger): ConfigurableExecutionScheduler {
  return createExecutionScheduler({
    concurrency: cfg.execution.concurrency,
    humanSlots: cfg.execution.human_slots,
    maxWaiting: cfg.execution.max_waiting,
    log,
  })
}

// 没有装配调度器时的兜底也必须有界：默认并发 3、人工 1、排队 1000。
// 老装配不传 scheduler 时仍然受同一个上限约束，不能成为绕过并发闸的后门。
const fallbackScheduler = createExecutionScheduler()

export async function runThroughScheduler<T>(
  scheduler: ExecutionScheduler | undefined,
  fn: () => Promise<T> | T,
  opts?: ExecutionTaskOptions,
): Promise<T> {
  return await (scheduler ?? fallbackScheduler).run(fn, opts)
}
