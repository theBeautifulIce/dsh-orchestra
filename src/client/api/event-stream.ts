import type { ApiClient, FetchLike } from './client.ts'
import { EventStream, type Invalidation, type StreamStatus } from './sse.ts'
import { createSseSubscribe } from './sse-fetch.ts'

export type ConnectedEventStreamOptions = {
  client: ApiClient
  fetcher: FetchLike
  baseUrl: string
  requestInit?: Omit<RequestInit, 'method' | 'signal'>
  onInvalidate: (type: string) => void
  onStatus: (status: StreamStatus) => void
  pollIntervalMs?: number
  coalesceMs?: number
}

/** Connects invalidation events to authoritative list_events reads via the injected API client and host fetch. */
export function createConnectedEventStream(options: ConnectedEventStreamOptions): EventStream {
  return new EventStream({
    subscribe: createSseSubscribe(options.fetcher, options.baseUrl, options.requestInit),
    readAfter: async (afterSeq, limit) => {
      const page = await options.client.get<{ items: Invalidation[] }>('/v1/events', { from_seq: afterSeq, limit })
      return page.data.items
    },
    onInvalidate: options.onInvalidate,
    onStatus: options.onStatus,
    pollIntervalMs: options.pollIntervalMs,
    coalesceMs: options.coalesceMs,
  })
}
