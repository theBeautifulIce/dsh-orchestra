import type { FetchLike } from './client.ts'
import type { EventStreamOptions, Invalidation } from './sse.ts'

type Subscribe = EventStreamOptions['subscribe']

/** Fetch based SSE transport for hosts that inject authenticated fetch without exposing a secret to the panel. */
export function createSseSubscribe(fetcher: FetchLike, baseUrl: string, requestInit: Omit<RequestInit, 'method' | 'signal'> = {}): Subscribe {
  return (afterSeq, onEvent, onResyncRequired, onError, onOpen) => {
    const controller = new AbortController()
    const url = new URL('v1/events/stream', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    url.searchParams.set('after_seq', String(afterSeq))
    void pump(url, fetcher, requestInit, controller.signal, onEvent, onResyncRequired, onError, onOpen)
    return () => controller.abort()
  }
}

async function pump(
  url: URL,
  fetcher: FetchLike,
  requestInit: Omit<RequestInit, 'method' | 'signal'>,
  signal: AbortSignal,
  onEvent: (event: Invalidation) => void,
  onResyncRequired: () => void,
  onError: () => void,
  onOpen: () => void,
): Promise<void> {
  try {
    const response = await fetcher(url, {
      ...requestInit,
      method: 'GET',
      signal,
      headers: { ...Object.fromEntries(new Headers(requestInit.headers)), accept: 'text/event-stream' },
    })
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      onError()
      return
    }
    onOpen()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read()
        if (done) {
          if (!signal.aborted) onError()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        buffer = buffer.replace(/\r\n/g, '\n')
        if (buffer.length > 64 * 1024) {
          onResyncRequired()
          await reader.cancel()
          return
        }
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary).replace(/\r/g, '')
          buffer = buffer.slice(boundary + 2)
          if (!dispatchFrame(frame, onEvent, onResyncRequired)) {
            await reader.cancel()
            return
          }
        }
      }
    } finally {
      if (signal.aborted) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  } catch {
    if (!signal.aborted) onError()
  }
}

/** Returns false when the server explicitly requires a snapshot resync. */
function dispatchFrame(frame: string, onEvent: (event: Invalidation) => void, onResyncRequired: () => void): boolean {
  let eventName = 'message'
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') eventName = value
    else if (field === 'data') data.push(value)
  }
  if (eventName === 'resync_required') {
    onResyncRequired()
    return false
  }
  if (eventName !== 'invalidation' || data.length === 0) return true
  try {
    const value = JSON.parse(data.join('\n')) as Partial<Invalidation>
    if (Number.isSafeInteger(value.seq) && typeof value.event_id === 'string' && typeof value.type === 'string') {
      onEvent({ seq: value.seq as number, event_id: value.event_id, type: value.type })
    } else {
      onResyncRequired()
      return false
    }
  } catch {
    onResyncRequired()
    return false
  }
  return true
}
