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

// 半态钟（startup_unknown / 围栏宽限 / 等待）同一口径：锚点不全就当没有判定依据。
export type AnchoredDeadlineRow = {
  deadlineAt: string | null
  bootId: string | null
  monotonicNs: number | null
}

export function deadlineFromAnchors(row: AnchoredDeadlineRow): Deadline | null {
  if (!row.bootId || row.monotonicNs === null || !row.deadlineAt) return null
  return {
    bootId: row.bootId,
    monotonicNs: Number(row.monotonicNs),
    wallClockMs: Date.parse(row.deadlineAt),
  }
}

// 写锚点用：同一采样同时落展示用墙钟与判定用单调纳秒。
export function deadlineFromSample(clock: ClockProvider, afterMs: number): Deadline {
  const sample = clock.sample()
  return {
    bootId: sample.bootId,
    monotonicNs: sample.monotonicNs + Math.max(0, afterMs) * 1e6,
    wallClockMs: sample.wallClockMs + Math.max(0, afterMs),
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

// 判定用的时钟提供方：生产用系统时钟，测试与注入脚本用可编排时钟（规格 3.4 行 171）
export type ClockProvider = {
  readonly bootId: BootId
  sample(): ClockSample
  decide(deadline: Deadline): ClockDecision
}

// 生产时钟：墙钟与单调钟同时取样，漂移超过 2 秒就判不确定（规格 3.4 行 171）
export class SystemClock implements ClockProvider {
  private readonly clock: MonotonicClock

  constructor(bootId: BootId) {
    this.clock = new MonotonicClock(bootId, {
      wallClockMs: Date.now(),
      monotonicNs: Number(process.hrtime.bigint()),
    })
  }

  get bootId(): BootId { return this.clock.id }

  sample(): ClockSample {
    const wallClockMs = Date.now()
    const monotonicNs = Number(process.hrtime.bigint())
    this.clock.sample(wallClockMs, monotonicNs)
    return { bootId: this.bootId, monotonicNs, wallClockMs }
  }

  decide(deadline: Deadline): ClockDecision {
    return this.clock.decide(deadline, this.sample())
  }
}

// 可编排时钟：测试与注入脚本用它模拟墙钟跳变、跨 boot 与漂移（规格 3.4 行 171、12.3 行 1066）
export class ScriptedClock implements ClockProvider {
  private currentBootId: BootId
  private wallMs: number
  private monoNs: number
  private originWallMs: number
  private originMonoNs: number

  constructor(bootId: BootId, opts: { wallClockMs?: number; monotonicNs?: number } = {}) {
    this.currentBootId = bootId
    this.wallMs = opts.wallClockMs ?? Date.parse('2026-11-13T03:00:00.000Z')
    this.monoNs = opts.monotonicNs ?? 0
    this.originWallMs = this.wallMs
    this.originMonoNs = this.monoNs
  }

  get bootId(): BootId { return this.currentBootId }

  // 墙钟跳变：模拟 NTP 校正或人工改表
  setWallClockMs(ms: number): void { this.wallMs = ms }

  // 单调钟推进：模拟真实流逝
  advanceMs(ms: number): void { this.monoNs += Math.round(ms * 1e6) }

  // 重启：换 boot，漂移基准跟着重置
  reboot(bootId: BootId): void {
    this.currentBootId = bootId
    this.originWallMs = this.wallMs
    this.originMonoNs = this.monoNs
  }

  sample(): ClockSample {
    return { bootId: this.currentBootId, monotonicNs: this.monoNs, wallClockMs: this.wallMs }
  }

  decide(deadline: Deadline): ClockDecision {
    if (deadline.bootId !== this.currentBootId) return { kind: 'uncertain', reason: 'boot_changed' }
    const expectedWall = this.originWallMs + (this.monoNs - this.originMonoNs) / 1e6
    const drift = Math.abs(expectedWall - this.wallMs)
    if (drift > CLOCK_DRIFT_TOLERANCE_MS) return { kind: 'uncertain', reason: 'clock_drift' }
    const remainingNs = deadline.monotonicNs - this.monoNs
    if (remainingNs <= 0) return { kind: 'expired' }
    return { kind: 'pending', remainingMs: remainingNs / 1e6 }
  }
}
