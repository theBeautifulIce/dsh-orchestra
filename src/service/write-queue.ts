// 写队列：单写者服务内的排队器；上限默认 1000，满了立刻报 SERVICE_UNAVAILABLE，不阻塞读路径（S1 定值）
import { OrchError } from '../core/errors.ts'
import { type Logger, nullLogger } from '../infra/logger.ts'

export class WriteQueue {
  private pending = 0
  private readonly max: number
  private readonly log: Logger

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
    try {
      return await fn()
    } finally {
      this.pending -= 1
    }
  }
}
