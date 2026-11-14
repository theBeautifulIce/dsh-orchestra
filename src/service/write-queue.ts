// 写队列：单写者服务内的串行排队器；上限默认 1000，满了立刻报 SERVICE_UNAVAILABLE，不阻塞读路径（S1 定值）
// 评审 P1：原来的实现只是加了个 pending 计数就并行执行，算不上队列；这里改成真 FIFO。
// 同一时刻只有一笔在跑，后来的按入队顺序排队；前一笔失败也不许卡住后面的笔。
// 写队列只管短时的数据库写与背压：长时间跑的 agent 执行不许占着这里的名额（那是 ExecutionScheduler 的活）。
import { OrchError } from '../core/errors.ts'
import { type Logger, nullLogger } from '../infra/logger.ts'

export class WriteQueue {
  // 已受理但还没做完的笔数：正在跑的那笔加上排队的那些
  private pending = 0
  private readonly max: number
  private readonly log: Logger
  // 串行链尾：新任务挂在上一个任务之后，执行顺序就是入队顺序
  private tail: Promise<unknown> = Promise.resolve()

  constructor(max = 1000, log: Logger = nullLogger) {
    this.max = max
    this.log = log
  }

  get size(): number {
    return this.pending
  }

  get capacity(): number {
    return this.max
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.pending >= this.max) {
      this.log.warn('写队列满了，拒掉这一笔写', { pending: this.pending, max: this.max })
      throw new OrchError('SERVICE_UNAVAILABLE', '写队列满了，先别写', { max: this.max })
    }
    this.pending += 1
    // 挂到链尾：前一笔无论成功还是失败，链子都要接上，后面的笔照跑不误
    const settled: Promise<T> = this.tail.then<T>(() => fn())
    this.tail = settled.then(() => undefined, () => undefined)
    try {
      return await settled
    } finally {
      this.pending -= 1
    }
  }
}
