import { summarizeLag, type LagObservation } from './event-lag.ts'

export const FORMAL_SLOTS = 2_880
export const FORMAL_SLOT_MS = 30_000
export const FORMAL_DURATION_MS = FORMAL_SLOTS * FORMAL_SLOT_MS
export const POLLS_PER_SLOT = 3
export const TREND_VERSION = 'soak-trend-v1'

export type LedgerHealth = {
  head: number; epoch: number; tasks: number; runs: number; nodes: number; successes: number
  orphanRuns: number; orphanNodes: number; unclosed: number; inFlight: number; foreignKeys: number
  probes: number; toolExecutions: number
}

export type Resources = {
  rssBytes: number; dbBytes: number; walBytes: number; artifactBytes: number
  readConnections: number; writeConnections: number; activeStatements: number
  subscriptionCount: number; fixtureSessions: number; active: Record<string, number>
  childPids: number[]; childRssBytes: number
}

export type Counts = { tasks: number; runs: number; nodes: number; tools: number; polls: number }

export type Point = {
  slot: number; dueMs: number; actualMs: number; wallMs: number; pid: number; bootId: string
  ledger: LedgerHealth; resources: Resources; counts: Counts
  lag: { count: number; missing: number; p95Ms: number | null; maxMs: number | null }
}

export type SoakEvent = {
  slot: number; seq: number; event_id: string; type: string; committedMs: number
  observedMs: number | null
}

export type Manifest = {
  schema: 1; id: string; kind: 'formal' | 'short'; candidate: string; clean: boolean
  pid: number; endpoint: string; epoch: number; bootId: string
  startMs: number; startWallMs: number; slots: number; slotMs: number; walLimitBytes: number
  configHash: string; startedAt: string; command: string[]; node: string; root: string; role: string
  supervision: 'detached' | 'foreground'
}

export type Cleanup = {
  subscriptionsClosed: boolean; serviceClosed: boolean; portReleased: boolean; lockReleased: boolean
  sqliteReleased: boolean; sidecarsReleased: boolean; fixtureReleased: boolean; handlesReleased: boolean
}

export type End = {
  actualMs: number; wallMs: number; candidate: string; clean: boolean; configHash: string
  ledger: LedgerHealth | null; cleanup: Cleanup; error: string | null
}

const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isCount = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value)

export function lagStats(events: readonly SoakEvent[], missing = 0): Point['lag'] {
  const values = events.flatMap(e => e.observedMs === null ? [] : [e.observedMs - e.committedMs]).sort((a, b) => a - b)
  const count = values.length
  return { count, missing: missing + events.length - count,
    p95Ms: count ? values[Math.ceil(count * 0.95) - 1]! : null,
    maxMs: count ? values[count - 1]! : null }
}

function lagAccepted(stats: Point['lag']): boolean {
  return stats.missing === 0 && stats.count > 0 && nonnegative(stats.p95Ms) && stats.p95Ms <= 2_000
    && nonnegative(stats.maxMs) && stats.maxMs <= 10_000
}

function chunkMinima(values: readonly number[]) {
  const length = Math.floor(values.length / 4)
  if (length < 15) return []
  return [0, 1, 2, 3].map(i => Math.min(...values.slice(i * length, i === 3 ? undefined : (i + 1) * length)))
}

function longestRisingSpan(values: readonly number[]) {
  let start = 0
  let increases = 0
  let longest = 0
  for (let i = 1; i < values.length; i++) {
    if (values[i]! < values[i - 1]!) {
      start = i
      increases = 0
    }
    if (values[i]! > values[i - 1]!) increases++
    if (increases >= 3) longest = Math.max(longest, i - start + 1)
  }
  return longest
}

function longestStrictRise(values: readonly number[]) {
  let longest = 0
  let rising = 0
  for (let i = 1; i < values.length; i++) {
    rising = values[i]! > values[i - 1]! ? rising + 1 : 0
    longest = Math.max(longest, rising)
  }
  return longest
}

/** Reject a sustained nondecreasing RSS span or rising minima in all four observed quarters.
 * WAL is a bounded allocation, frequently reused without a file truncation after auto-checkpoint.
 * An allocation above SQLite's configured checkpoint frame limit fails even if it later recovers.
 */
export function resourceTrend(points: readonly Point[], walLimitBytes: number) {
  const rss = points.map(p => p.resources.rssBytes)
  const wal = points.map(p => p.resources.walBytes)
  const rssQuarterMinima = chunkMinima(rss)
  const rssRisingSpan = longestRisingSpan(rss)
  const risingQuarters = rssQuarterMinima.length === 4 && rssQuarterMinima.slice(1).every((value, i) => value > rssQuarterMinima[i]!)
  const walPeakBytes = wal.reduce((peak, bytes) => Math.max(peak, bytes), 0)
  const walDownwardResets = wal.filter((bytes, i) => i > 0 && bytes < wal[i - 1]!).length
  const walRisingSlots = longestStrictRise(wal)
  const baseline = points[0]?.resources
  const resourceGrowth = baseline ? points.flatMap(p => Object.entries(p.resources.active).flatMap(([name, value]) =>
    value > (baseline.active[name] ?? 0) ? [{ slot: p.slot, name, value, baseline: baseline.active[name] ?? 0 }] : [])) : []
  return { version: TREND_VERSION, rssQuarterMinima, rssRisingSpan, risingQuarters, walPeakBytes, walDownwardResets, walRisingSlots,
    walLimitBytes, resourceGrowth,
    passed: rssRisingSpan < 60 && !risingQuarters && walRisingSlots < 60 && walPeakBytes <= walLimitBytes && resourceGrowth.length === 0 }
}

export function judgeSoak(manifest: Manifest, points: readonly Point[], events: readonly SoakEvent[], end: End | null) {
  const errors: string[] = []
  const { slotMs, slots, startMs, startWallMs } = manifest
  const formal = manifest.kind === 'formal'
  const validSpan = isCount(slots) && slots > 0 && slots <= FORMAL_SLOTS && isCount(slotMs) && slotMs > 0
  if (!validSpan || manifest.schema !== 1 || (manifest.kind !== 'short' && !formal)) throw new Error('Invalid soak manifest')
  if (formal && (slots !== FORMAL_SLOTS || slotMs !== FORMAL_SLOT_MS || manifest.supervision !== 'detached'
      || !manifest.clean || !/^[a-f0-9]{40}$/.test(manifest.candidate))) errors.push('Formal candidate or schedule is invalid')
  if (!nonnegative(startMs) || !isCount(startWallMs) || !isCount(manifest.pid) || manifest.pid < 1 || !manifest.bootId
    || !isCount(manifest.epoch) || manifest.epoch < 1 || !isCount(manifest.walLimitBytes) || manifest.walLimitBytes < 32
    || !/^[a-f0-9]{64}$/.test(manifest.configHash) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(manifest.endpoint)) {
    errors.push('Invalid service baseline')
  }
  if (points.length !== slots + 1) errors.push('Baseline or scheduled samples are missing or duplicated')
  if (points[0]?.actualMs !== startMs || points[0]?.wallMs !== startWallMs) errors.push('Baseline does not match manifest')

  const probes: LagObservation[] = []
  const eventsBySlot = new Map<number, SoakEvent[]>()
  let prevSeq = points[0]?.ledger.head ?? 0
  let prevCommit = startMs
  let prevArrival = startMs
  for (const event of events) {
    if (!isCount(event.slot) || event.slot < 1 || event.slot > slots || event.seq !== prevSeq + 1
      || !event.event_id || !event.type || !nonnegative(event.committedMs) || event.committedMs < prevCommit
      || event.committedMs < startMs + (event.slot - 1) * slotMs || event.committedMs >= startMs + event.slot * slotMs
      || !nonnegative(event.observedMs) || event.observedMs < event.committedMs || event.observedMs < prevArrival) {
      errors.push('Invalid or missing committed SSE event at sequence ' + event.seq)
    }
    prevSeq = event.seq
    prevCommit = event.committedMs
    prevArrival = event.observedMs ?? prevArrival
    const group = eventsBySlot.get(event.slot)
    if (group) group.push(event)
    else eventsBySlot.set(event.slot, [event])
    if (event.type === 's6.soak_probe') probes.push({ ...event, slot: event.slot - 1 })
  }

  for (const [index, point] of points.entries()) {
    const previous = points[index - 1]
    const due = startMs + index * slotMs
    const rows = eventsBySlot.get(index) ?? []
    if (point.slot !== index || point.dueMs !== due || !nonnegative(point.actualMs) || point.actualMs < due
      || point.actualMs >= due + Math.min(1_000, slotMs / 4) || !isCount(point.wallMs)
      || (previous && (point.wallMs < previous.wallMs || point.actualMs <= previous.actualMs))
      || point.pid !== manifest.pid || point.bootId !== manifest.bootId || point.ledger.epoch !== manifest.epoch) {
      errors.push('Invalid sample timing or service generation at slot ' + index)
    }

    const { ledger, resources, counts } = point
    if (!Object.values(ledger).every(isCount) || ledger.head < 1 || ledger.orphanRuns !== 0 || ledger.orphanNodes !== 0
      || ledger.unclosed !== 0 || ledger.inFlight !== 0 || ledger.foreignKeys !== 0 || ledger.successes !== ledger.runs
      || ledger.head !== (rows.at(-1)?.seq ?? previous?.ledger.head ?? ledger.head)) {
      errors.push('Ledger reconciliation failed at slot ' + index)
    }
    if (!Object.values(counts).every(isCount) || counts.tasks !== index || counts.runs !== index || counts.nodes !== index
      || counts.tools !== index || counts.polls !== index * POLLS_PER_SLOT || (previous && (
        ledger.tasks !== previous.ledger.tasks + 1 || ledger.nodes !== previous.ledger.nodes + 1
        || ledger.runs !== previous.ledger.runs + 1 || ledger.probes !== previous.ledger.probes + 1
        || ledger.toolExecutions !== previous.ledger.toolExecutions + 1 || ledger.head <= previous.ledger.head))) {
      errors.push('Workload was incomplete at slot ' + index)
    }
    if (!isCount(resources.rssBytes) || resources.rssBytes < 1 || !isCount(resources.dbBytes) || resources.dbBytes < 1
      || !isCount(resources.walBytes) || !isCount(resources.artifactBytes)
      || resources.readConnections !== 0 || resources.writeConnections !== 1 || resources.activeStatements !== 0
      || resources.subscriptionCount !== 1 || resources.fixtureSessions !== 0
      || resources.childPids.length !== 0 || resources.childRssBytes !== 0
      || !Object.values(resources.active).every(isCount) || !Object.keys(resources.active).length) {
      errors.push('Resource measurements are invalid at slot ' + index)
    }
    const stats = lagStats(rows)
    if ((index > 0 && !lagAccepted(stats)) || rows.some(event => (event.observedMs ?? Infinity) > point.actualMs)
      || (Object.keys(stats) as (keyof typeof stats)[]).some(key => point.lag[key] !== stats[key])) {
      errors.push('Event reconciliation or lag budget failed at slot ' + index)
    }
  }

  const lag = summarizeLag(probes, { startMs, slotMs, slots, slotsPerSlice: Math.max(1, Math.ceil(60_000 / slotMs)) })
  const allEvents = lagStats(events)
  if (!lag.passed || !lagAccepted(allEvents)) errors.push('Lag observations are incomplete or exceed the budget')
  const resources = resourceTrend(points, manifest.walLimitBytes)
  if (!resources.passed) errors.push('Resource growth crosses the declared trend bounds')
  const last = points.at(-1)
  if (!end || !last) errors.push('The worker did not finish with a sealed endpoint')
  else {
    if (end.error) errors.push(end.error)
    if (!nonnegative(end.actualMs) || end.actualMs < last.actualMs || end.actualMs - startMs < slots * slotMs
      || !isCount(end.wallMs) || end.wallMs < last.wallMs
      || end.candidate !== manifest.candidate || end.configHash !== manifest.configHash || (formal && !end.clean)) {
      errors.push('End time, candidate, or configuration is inconsistent')
    }
    if (!end.ledger || (Object.keys(last.ledger) as (keyof LedgerHealth)[]).some(key => end.ledger?.[key] !== last.ledger[key])) {
      errors.push('Sealed ledger does not match the final observation')
    }
    for (const check of ['subscriptionsClosed', 'serviceClosed', 'portReleased', 'lockReleased', 'sqliteReleased',
      'sidecarsReleased', 'fixtureReleased', 'handlesReleased'] as const) {
      if (end.cleanup[check] !== true) errors.push('Resource cleanup failed: ' + check)
    }
  }
  return {
    schema: 1, run_id: manifest.id, candidate: manifest.candidate, run_type: manifest.kind,
    status: errors.length ? (end ? 'failed' : 'incomplete') : formal ? 'passed' : 'short-complete',
    g6Eligible: errors.length === 0 && formal, expected_slots: slots, sample_count: Math.max(0, points.length - 1),
    observed_duration_ms: last ? last.actualMs - startMs : null, lag: { probes: lag, events: allEvents },
    resources, errors,
  }
}
