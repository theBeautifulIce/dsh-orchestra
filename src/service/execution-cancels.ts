// src/service/execution-cancels.ts —— 执行中取消的进程内注册表
// 账本只记取消事实；真正把 AbortSignal 送到 runNode 的是这里。
// 键必须带 attempt：旧 attempt 的取消不能打断新 attempt（B09）。

type Entry = {
  controller: AbortController
}

export class ExecutionCancels {
  private readonly active = new Map<string, Entry>()

  private key(nodeRunId: string, attempt: number): string {
    return `${nodeRunId}:${attempt}`
  }

  // 同一个 node_run+attempt 只允许一个在跑实例；重复注册返回同一个信号。
  register(nodeRunId: string, attempt: number): AbortSignal {
    const key = this.key(nodeRunId, attempt)
    const existing = this.active.get(key)
    if (existing) return existing.controller.signal
    const controller = new AbortController()
    this.active.set(key, { controller })
    return controller.signal
  }

  // 取消是“请求停止”，不是“已停止”：调用方仍要靠 whenIdle/state 确认。
  abort(nodeRunId: string, attempt: number, reason: string): boolean {
    const entry = this.active.get(this.key(nodeRunId, attempt))
    if (!entry) return false
    if (!entry.controller.signal.aborted) entry.controller.abort(reason)
    return true
  }

  release(nodeRunId: string, attempt: number): void {
    this.active.delete(this.key(nodeRunId, attempt))
  }

  has(nodeRunId: string, attempt: number): boolean {
    return this.active.has(this.key(nodeRunId, attempt))
  }
}
