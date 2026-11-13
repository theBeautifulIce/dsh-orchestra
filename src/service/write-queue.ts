// 写队列：单写者服务内的排队器；上限默认 1000，满了立刻报 SERVICE_UNAVAILABLE，不阻塞读路径（S1 定值）
import { OrchError } from '../core/errors.ts'

export class WriteQueue {
  private pending = 0
  private readonly max: number

  constructor(max = 1000) {
    this.max = max
  }

  get size(): number {
    return this.pending
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.pending >= this.max) {
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
