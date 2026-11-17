import type { IncomingMessage, ServerResponse } from 'node:http'

export const HEARTBEAT_MS = 15_000
export const POLL_INTERVAL_MS = 250
export const SSE_MAX_BUFFER_BYTES = 256 * 1024
export const LAST_EVENT_ID_HEADER = 'last-event-id'

export type InvalidationEvent = { seq: number; event_id: string; type: string }
export type EventPage = { rows: unknown[]; as_of_seq: number }
export type ReadEventPage = (afterSeq: number, limit: number) => EventPage

export function nextSeq(afterSeq: number, eventSeq: number): number | null {
  return eventSeq === afterSeq + 1 ? eventSeq : null
}

function writeResync(res: ServerResponse, details: Record<string, number>): void {
  if (res.destroyed || res.writableEnded) return
  res.write('event: resync_required\ndata: ' + JSON.stringify(details) + '\n\n')
  res.end()
}

/** Sends event invalidations only; clients must use list_events for authoritative state. */
export function startEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  readPage: ReadEventPage,
  initialSeq: number,
): void {
  let afterSeq = initialSeq
  let polling = false
  let closed = false
  let lastHeartbeatAt = Date.now()
  const stop = () => {
    if (closed) return
    closed = true
    clearInterval(pollTimer)
    clearInterval(heartbeatTimer)
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  const pollTimer = setInterval(() => {
    if (closed || polling || res.destroyed || res.writableEnded) return
    if (res.writableLength > SSE_MAX_BUFFER_BYTES) {
      writeResync(res, { after_seq: afterSeq, as_of_seq: afterSeq })
      stop()
      return
    }
    polling = true
    try {
      const page = readPage(afterSeq, 100)
      if (page.as_of_seq < afterSeq || (page.rows.length === 0 && page.as_of_seq > afterSeq)) {
        writeResync(res, { expected_seq: afterSeq + 1, actual_seq: page.as_of_seq, as_of_seq: page.as_of_seq })
        stop()
        return
      }
      for (const value of page.rows) {
        const event = value as Partial<InvalidationEvent>
        if (typeof event.seq !== 'number' || typeof event.event_id !== 'string' || typeof event.type !== 'string') continue
        const expected = afterSeq + 1
        const next = nextSeq(afterSeq, event.seq)
        if (next === null) {
          writeResync(res, { expected_seq: expected, actual_seq: event.seq, as_of_seq: page.as_of_seq })
          stop()
          return
        }
        const body = JSON.stringify({ seq: event.seq, event_id: event.event_id, type: event.type })
        res.write('id: ' + String(event.seq) + '\nevent: invalidation\ndata: ' + body + '\n\n')
        afterSeq = next
      }
    } catch {
      writeResync(res, { after_seq: afterSeq, as_of_seq: afterSeq })
      stop()
    } finally {
      polling = false
    }
  }, POLL_INTERVAL_MS)
  const heartbeatTimer = setInterval(() => {
    if (closed || res.destroyed || res.writableEnded) return
    if (Date.now() - lastHeartbeatAt < HEARTBEAT_MS) return
    lastHeartbeatAt = Date.now()
    if (!res.write(': heartbeat\n\n') || res.writableLength > SSE_MAX_BUFFER_BYTES) {
      writeResync(res, { after_seq: afterSeq, as_of_seq: afterSeq })
      stop()
    }
  }, HEARTBEAT_MS)
  req.once('aborted', stop)
  res.once('close', stop)
  res.once('finish', stop)
}
