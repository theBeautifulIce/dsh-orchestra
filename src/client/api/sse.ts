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
    this.stopSubscription?.()
    this.stopSubscription = null
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    if (this.coalesceTimer !== null) clearTimeout(this.coalesceTimer)
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.pollTimer = null
    this.coalesceTimer = null
    this.reconnectTimer = null
    this.pendingTypes.clear()
  }

  /** Call after a full page refresh establishes the new authoritative event sequence. */
  setSnapshot(asOfSeq: number): void {
    if (!Number.isSafeInteger(asOfSeq) || asOfSeq < 0) return
    this.lastSeq = asOfSeq
    this.awaitingSnapshot = false
    if (this.started && !this.stopSubscription && !this.pollTimer) this.openStream()
  }

  get lastEventSeq(): number { return this.lastSeq }

  private openStream(): void {
    if (!this.started || this.awaitingSnapshot) return
    try {
      this.options.onStatus('stale')
      this.stopSubscription = this.options.subscribe(
        this.lastSeq,
        (event) => this.accept(event),
        () => this.requireSnapshot(),
        () => this.fallbackToPolling(),
        () => this.options.onStatus('live'),
      )
    } catch {
      this.fallbackToPolling()
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
    this.options.onStatus('stale')
    this.options.onInvalidate('resync_required')
    this.stopSubscription?.()
    this.stopSubscription = null
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private fallbackToPolling(): void {
    if (!this.started || this.awaitingSnapshot || this.pollTimer !== null) return
    this.stopSubscription?.()
    this.stopSubscription = null
    this.options.onStatus('polling')
    void this.pollOnce()
    this.pollTimer = setInterval(() => { void this.pollOnce() }, this.options.pollIntervalMs ?? 5000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.started || this.awaitingSnapshot) return
      if (this.pollTimer !== null) clearInterval(this.pollTimer)
      this.pollTimer = null
      this.openStream()
    }, 30_000)
  }

  private async pollOnce(): Promise<void> {
    if (!this.started || this.awaitingSnapshot || this.reading) return
    this.reading = true
    try {
      const events = await this.options.readAfter(this.lastSeq, 200)
      for (const event of events) {
        this.accept(event)
        if (this.awaitingSnapshot) break
      }
      if (!this.awaitingSnapshot) this.options.onStatus('polling')
    } catch {
      this.options.onStatus('stale')
    } finally {
      this.reading = false
    }
  }
}
