import { observedCount, type ModelAttemptMetering } from './model-routing.ts'

type MeteringEvent = {
  type: string
  seq: number
  data: unknown
  surfaceOp?: unknown
}

type UsageSample = { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown }
type Settlement = {
  turn?: number
  step?: number
  usage?: UsageSample
  stream?: readonly { type: string; chunk?: { type: string; usage?: UsageSample } }[]
}

function attemptTokens(events: readonly MeteringEvent[]): ModelAttemptMetering['tokens'] {
  // Like DSH's tokenUsage fold, replace the sample within a turn/step and
  // close that slot on llm/retry-started. Keep absent counters unknown.
  const samples: (UsageSample | undefined)[] = []
  let current: { turn: number; step: number; usage?: UsageSample } | undefined
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt' && event.type !== 'llm/retry-started') continue
    const data = (event.data ?? {}) as Settlement
    const sameStep = current?.turn === data.turn && current?.step === data.step
    if (event.type === 'llm/retry-started') {
      if (current && sameStep) {
        samples.push(current.usage)
        current = undefined
      } else samples.push(undefined)
      continue
    }
    if (typeof data.turn !== 'number' || typeof data.step !== 'number') {
      samples.push(undefined)
      continue
    }
    if (!sameStep && current) samples.push(current.usage)
    const stream = Array.isArray(data.stream) ? data.stream as Settlement['stream'] : undefined
    const sample = data.usage ?? stream?.findLast((record) => record?.type === 'chunk' && record.chunk?.type === 'usage')?.chunk?.usage
    current = { turn: data.turn, step: data.step, usage: sample ?? (sameStep ? current?.usage : undefined) }
  }
  if (current) samples.push(current.usage)
  const total = (bucket: keyof UsageSample) => {
    if (samples.length === 0) return null
    let sum = 0
    for (const sample of samples) {
      const count = observedCount(sample?.[bucket])
      if (count === null || !Number.isSafeInteger(sum + count)) return null
      sum += count
    }
    return sum
  }
  return { uncached_input_tokens: total('inputTokens'), output_tokens: total('outputTokens'),
    cache_read_tokens: total('cacheReadTokens'), cache_write_tokens: total('cacheWriteTokens') }
}

function attemptCompactions(events: readonly MeteringEvent[], supported: boolean): ModelAttemptMetering['context_compactions'] {
  const summaries = new Set<string>()
  const prunes = new Set<number>()
  for (const [index, event] of events.entries()) {
    if (event.type !== 'compaction/summary' && event.type !== 'compaction/prune') continue
    const summary = event.type === 'compaction/summary'
    const next = events[index + 1]
    const replacement = next?.surfaceOp as { op?: string; startSeq?: number; endSeq?: number } | undefined
    const { compactionId, shadowedRange } = (event.data ?? {}) as { compactionId?: string; shadowedRange?: { start: number; end: number } }
    // The pricing event directly precedes the replacement. The replacement
    // event, start/end markers and shadowed tokens are not additional counts.
    if (!shadowedRange || next?.seq !== event.seq + 1 || next.type !== (summary ? 'user/message' : 'tool/result')
      || replacement?.op !== 'replace' || replacement.startSeq !== shadowedRange.start
      || replacement.endSeq !== shadowedRange.end) return null
    if (summary) {
      if (typeof compactionId !== 'string' || !compactionId) return null
      summaries.add(compactionId)
    } else prunes.add(event.seq)
  }
  return supported || summaries.size + prunes.size > 0 ? { summaries: summaries.size, tool_result_prunes: prunes.size } : null
}

/** Only a fresh, trusted DSH child session can contribute metering. */
export function readDshAttemptMetering(events: readonly MeteringEvent[], compactionAvailable: boolean): ModelAttemptMetering {
  return { tokens: attemptTokens(events), context_compactions: attemptCompactions(events, compactionAvailable) }
}
