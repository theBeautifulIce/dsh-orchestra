export type Invalidation = { seq: number; event_id: string; type: string }
export type StreamStatus = 'live' | 'stale' | 'polling'

export type EventStreamOptions = {
  subscribe: (
    afterSeq: number,
    onEvent: (event: Invalidation) => void,
    onResyncRequired: () => void,
    onError: () => void,
    onOpen: () => void,
  ) => () => void
  readAfter: (afterSeq: number, limit: number) => Promise<Invalidation[]>
  onInvalidate: (type: string) => void
  onStatus: (status: StreamStatus) => void
  pollIntervalMs?: number
  coalesceMs?: number
}

const SEEN_LIMIT = 5000

/** SSE is only an invalidation channel; callers refresh authoritative views separately. */
export class EventStream {
  private readonly options: EventStreamOptions
  private readonly seen = new Set<string>()
  private lastSeq = 0
  private stopSubscription: (() => void) | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private awaitingSnapshot = false
  private transportGeneration = 0
  private reading = false
  private pendingTypes = new Set<string>()

  constructor(options: EventStreamOptions) {
    this.options = options
  }

  start(asOfSeq: number): void {
    this.stop()
    this.started = true
    this.lastSeq = asOfSeq
    this.awaitingSnapshot = false
    this.openStream()
  }

  stop(): void {
    this.started = false
    this.awaitingSnapshot = false
    this.closeTransport()
    this.clearInvalidations()
    this.seen.clear()
  }

  private clearInvalidations(): void {
    if (this.coalesceTimer !== null) clearTimeout(this.coalesceTimer)
    this.coalesceTimer = null
    this.pendingTypes.clear()
  }

  /** Accept a refreshed snapshot only after the stream requested a resync. */
  setSnapshot(asOfSeq: number): void {
    if (!this.started || !this.awaitingSnapshot || !Number.isSafeInteger(asOfSeq) || asOfSeq < 0) return
    this.lastSeq = asOfSeq
    this.awaitingSnapshot = false
    this.seen.clear()
    this.openStream()
  }

  get lastEventSeq(): number { return this.lastSeq }

  private closeTransport(): void {
    this.transportGeneration += 1
    this.stopSubscription?.()
    this.stopSubscription = null
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.pollTimer = null
    this.reconnectTimer = null
    this.reading = false
  }

  private openStream(): void {
    if (!this.started || this.awaitingSnapshot) return
    const generation = this.transportGeneration
    const active = () => generation === this.transportGeneration
    try {
      this.options.onStatus('stale')
      if (!active()) return
      const unsubscribe = this.options.subscribe(
        this.lastSeq,
        (event) => { if (active()) this.accept(event) },
        () => { if (active()) this.requireSnapshot() },
        () => { if (active()) this.fallbackToPolling() },
        () => { if (active()) this.options.onStatus('live') },
      )
      if (active()) this.stopSubscription = unsubscribe
      else unsubscribe()
    } catch {
      if (active()) this.fallbackToPolling()
    }
  }

  private accept(event: Invalidation): void {
    if (!this.started || this.awaitingSnapshot) return
    if (this.seen.has(event.event_id)) return
    if (!Number.isSafeInteger(event.seq) || event.seq !== this.lastSeq + 1) {
      this.requireSnapshot()
      return
    }
    this.seen.add(event.event_id)
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value as string | undefined
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    this.lastSeq = event.seq
    this.pendingTypes.add(event.type)
    if (this.coalesceTimer === null) {
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = null
        for (const type of this.pendingTypes) this.options.onInvalidate(type)
        this.pendingTypes.clear()
      }, this.options.coalesceMs ?? 100)
    }
  }

  private requireSnapshot(): void {
    if (!this.started || this.awaitingSnapshot) return
    this.awaitingSnapshot = true
    this.closeTransport()
    this.clearInvalidations()
    this.options.onStatus('stale')
    this.options.onInvalidate('resync_required')
  }

  private fallbackToPolling(): void {
    if (!this.started || this.awaitingSnapshot || this.pollTimer !== null) return
    this.closeTransport()
    const generation = this.transportGeneration
    this.options.onStatus('stale')
    if (generation !== this.transportGeneration) return
    this.pollTimer = setInterval(() => { void this.pollOnce(generation) }, this.options.pollIntervalMs ?? 5000)
    this.reconnectTimer = setTimeout(() => {
      if (generation !== this.transportGeneration) return
      this.closeTransport()
      this.openStream()
    }, 30_000)
    void this.pollOnce(generation)
  }

  private async pollOnce(generation: number): Promise<void> {
    if (generation !== this.transportGeneration || this.reading) return
    this.reading = true
    try {
      const events = await this.options.readAfter(this.lastSeq, 200)
      for (const event of events) {
        if (generation !== this.transportGeneration) return
        this.accept(event)
      }
      if (generation === this.transportGeneration) this.options.onStatus('polling')
    } catch {
      if (generation === this.transportGeneration) this.options.onStatus('stale')
    } finally {
      if (generation === this.transportGeneration) this.reading = false
    }
  }
}
