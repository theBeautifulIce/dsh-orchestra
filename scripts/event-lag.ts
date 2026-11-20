/** One probe is due in each fixed interval. Both times come from the same monotonic clock. */
export type LagObservation = {
  slot: number; seq: number; committedMs: number; observedMs: number | null
}

export function summarizeLag(items: readonly LagObservation[], window: {
  startMs: number; slotMs: number; slots: number; slotsPerSlice: number
}) {
  const { startMs, slotMs, slots, slotsPerSlice } = window
  if (!Number.isFinite(startMs) || !Number.isFinite(slotMs) || slotMs <= 0
    || !Number.isSafeInteger(slots) || slots < 1 || !Number.isSafeInteger(slotsPerSlice) || slotsPerSlice < 1) {
    throw new Error('Invalid lag window')
  }
  const errors: string[] = []
  const values = new Map<number, number>()
  let previousSeq = 0
  let previousSlot = -1
  let previousArrival = -Infinity
  for (const item of items) {
    const start = startMs + slotMs * item.slot
    if (!Number.isSafeInteger(item.slot) || item.slot <= previousSlot || item.slot >= slots
      || !Number.isSafeInteger(item.seq) || item.seq <= previousSeq
      || !Number.isFinite(item.committedMs) || item.committedMs < start || item.committedMs >= start + slotMs
      || item.observedMs === null || !Number.isFinite(item.observedMs) || item.observedMs < item.committedMs
      || item.observedMs < previousArrival) {
      errors.push('Invalid or missing observation at slot ' + item.slot)
      continue
    }
    previousSeq = item.seq
    previousSlot = item.slot
    previousArrival = item.observedMs
    values.set(item.slot, item.observedMs - item.committedMs)
  }
  function stats(samples: number[]) {
    if (!samples.length) return { p95Ms: null, maxMs: null, exceeded: false }
    samples.sort((a, b) => a - b)
    const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1]!
    const maxMs = samples[samples.length - 1]!
    return { p95Ms, maxMs, exceeded: p95Ms > 2_000 || maxMs > 10_000 }
  }
  const full = stats([...values.values()])
  const slices = []
  let consecutiveMs = 0
  let alert = false
  for (let first = 0; first < slots; first += slotsPerSlice) {
    const end = Math.min(first + slotsPerSlice, slots)
    const samples = []
    for (let index = first; index < end; index++) {
      const lag = values.get(index)
      if (lag === undefined) errors.push('Unobserved slot ' + index)
      else samples.push(lag)
    }
    const result = stats(samples)
    const complete = samples.length === end - first
    consecutiveMs = complete && result.exceeded ? consecutiveMs + (end - first) * slotMs : 0
    alert ||= consecutiveMs >= 600_000
    slices.push({ first, count: end - first, complete, ...result })
  }
  return { complete: errors.length === 0, errors, full, slices, alert,
    passed: errors.length === 0 && !full.exceeded && slices.every((slice) => !slice.exceeded) }
}
