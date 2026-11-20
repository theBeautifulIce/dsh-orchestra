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

export type ExecutionTaskOptions = {
  // 占人工名额：等人复核的任务同时最多 human_slots 个
  human?: boolean
  // 任务名：只进日志与排队信息，便于定位是谁在排
  label?: string
  nodeRunId?: string
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
  readonly inFlight: number
  readonly waiting: number
  readonly concurrency: number
  readonly humanSlots: number
  // 关闭调度器：drain=true 等队列与在跑任务收完；drain=false 立即拒掉排队任务，在跑任务自然结束。
  // 两种模式都会停止接收新任务，重复调用返回同一个 Promise。
  close(opts?: { drain?: boolean }): Promise<void>
}

type QueuedTask = {
  human: boolean
  label: string
  nodeRunId?: string
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
  private readonly concurrencyLimit: number
  private readonly humanSlotLimit: number
  private readonly maxWaiting: number
  private readonly log: Logger
  // 等待中的任务：先进先出，谁先到谁先拿名额
  private readonly queue: QueuedTask[] = []
  private running = 0
  private humanRunning = 0
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

  run<T>(fn: () => Promise<T> | T, opts?: ExecutionTaskOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.accepting) {
        reject(new OrchError('SERVICE_UNAVAILABLE', '调度器已关闭，先别排', { label: opts?.label ?? '' }))
        return
      }
      if (this.queue.length >= this.maxWaiting) {
        this.log.warn('执行队列满了，拒掉这一件', { waiting: this.queue.length, maxWaiting: this.maxWaiting })
        reject(new OrchError('SERVICE_UNAVAILABLE', '执行队列满了，先别排', {
          maxWaiting: this.maxWaiting,
          waiting: this.queue.length,
        }))
        return
      }
      const task: QueuedTask = {
        human: opts?.human === true,
        label: opts?.label ?? '',
        nodeRunId: opts?.nodeRunId,
        invoke: fn,
        resolve: (value) => { resolve(value as T) },
        reject: (reason) => { reject(reason) },
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

  // 派名额：先给排在前面的任务；占人工名额的要等人工名额空出来
  private pump(): void {
    while (this.running < this.concurrencyLimit && this.queue.length > 0) {
      const idx = this.queue.findIndex((t) => !t.human || this.humanRunning < this.humanSlotLimit)
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
    this.pump()
    this.settleClose()
    if (failed) task.reject(failure)
    else task.resolve(value)
  }
}

export function createExecutionScheduler(opts: {
  concurrency?: number
  humanSlots?: number
  // 排队上限：超了直接拒（背压）。缺省为有界默认值，避免生产队列无界
  maxWaiting?: number
  log?: Logger
} = {}): ExecutionScheduler {
  return new Scheduler({
    concurrency: opts.concurrency ?? DEFAULT_EXECUTION_CONCURRENCY,
    humanSlots: opts.humanSlots ?? DEFAULT_HUMAN_SLOTS,
    maxWaiting: opts.maxWaiting ?? DEFAULT_MAX_WAITING,
    log: opts.log ?? nullLogger,
  })
}

// 配置是唯一来源：execution.concurrency / human_slots / max_waiting 在这里真正落到调度上
export function createExecutionSchedulerFromConfig(cfg: OrchestraConfig, log?: Logger): ExecutionScheduler {
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
