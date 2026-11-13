// src/core/clock.ts —— 单调时钟与截止判定（规格 3.4 行 171、12.3 行 1066）
export type BootId = string

export type ClockSample = {
  bootId: BootId
  monotonicNs: number
  wallClockMs: number
}

export type Deadline = {
  bootId: BootId
  monotonicNs: number
  wallClockMs: number
}

// 墙钟与单调钟的漂移容忍：超过 2 秒就不敢自动判超时（规格 3.4 行 171）
export const CLOCK_DRIFT_TOLERANCE_MS = 2000

export type ClockDecision =
  | { kind: 'pending'; remainingMs: number }
  | { kind: 'expired' }
  | { kind: 'uncertain'; reason: string }

export class MonotonicClock {
  private readonly bootId: BootId
  private readonly originWallMs: number
  private readonly originMonotonicNs: number
  private readonly driftSamples: number[] = []

  constructor(bootId: BootId, now: { wallClockMs: number; monotonicNs: number }) {
    this.bootId = bootId
    this.originWallMs = now.wallClockMs
    this.originMonotonicNs = now.monotonicNs
  }

  get id(): BootId { return this.bootId }

  // 用墙钟与单调钟两个来源估漂移；漂移超差就置不确定（规格 3.4 行 171）
  sample(wallClockMs: number, monotonicNs: number): number {
    const expectedWall = this.originWallMs + (monotonicNs - this.originMonotonicNs) / 1e6
    const drift = Math.abs(expectedWall - wallClockMs)
    this.driftSamples.push(drift)
    if (this.driftSamples.length > 32) this.driftSamples.shift()
    return drift
  }

  maxDriftMs(): number {
    return this.driftSamples.length === 0 ? 0 : Math.max(...this.driftSamples)
  }

  // 判定截止：只在同一个 boot 内比单调钟
  decide(deadline: Deadline, now: ClockSample): ClockDecision {
    if (now.bootId !== deadline.bootId) {
      return { kind: 'uncertain', reason: 'boot_changed' }
    }
    if (this.maxDriftMs() > CLOCK_DRIFT_TOLERANCE_MS) {
      return { kind: 'uncertain', reason: 'clock_drift' }
    }
    const remainingNs = deadline.monotonicNs - now.monotonicNs
    if (remainingNs <= 0) return { kind: 'expired' }
    return { kind: 'pending', remainingMs: remainingNs / 1e6 }
  }
}

// 节点行上的截止锚点 → 判定用的 Deadline
// 墙钟只作展示用；判定只看 boot_id 与单调纳秒（规格 3.4 行 171）
export type DeadlineRow = {
  deadline_boot_id: string | null
  deadline_monotonic_ns: number | null
  deadline_at: string | null
}

export function deadlineFromRow(row: DeadlineRow): Deadline | null {
  if (!row.deadline_boot_id || row.deadline_monotonic_ns === null || !row.deadline_at) return null
  return {
    bootId: row.deadline_boot_id,
    monotonicNs: Number(row.deadline_monotonic_ns),
    wallClockMs: Date.parse(row.deadline_at),
  }
}

// 跨 boot 剩余预算
export type PreviousClock = {
  bootId: BootId
  lastEventMonotonicNs: number
  lastEventWallMs: number
  deadlineMonotonicNs: number
}

// remaining = (deadline_monotonic_ns - prev.last_event_monotonic_ns) - (current_boot.started_at - prev.last_event_at)
// 停机那段时间不算进预算（规格 4.4 行 342）
export function remainingAcrossBoot(prev: PreviousClock, currentBoot: { startedAtMs: number; monotonicNs: number }): number {
  const budgetMs = Math.max(0, (prev.deadlineMonotonicNs - prev.lastEventMonotonicNs) / 1e6)
  // 墙钟回拨时 downtime 会是负数：夹到 0，且剩余不许超过预算（规格 4.4 行 342）
  const downtimeMs = Math.max(0, currentBoot.startedAtMs - prev.lastEventWallMs)
  const remainingMs = Math.min(budgetMs, budgetMs - downtimeMs)
  return remainingMs > 0 ? remainingMs : 0
}
