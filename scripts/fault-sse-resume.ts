import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { createApiClient, type FetchLike } from '../src/client/api/client.ts'
import { createConnectedEventStream } from '../src/client/api/event-stream.ts'
import type { Invalidation, StreamStatus } from '../src/client/api/sse.ts'
import { sha256Hex } from '../src/core/canonical.ts'
import { ScriptedClock } from '../src/core/clock.ts'
import { serveOrchestra } from '../src/index.ts'
import { appendEvent, appendNodeRunEvent } from '../src/infra/db/ledger.ts'
import { openDb, withTx, type Db } from '../src/infra/sqlite/driver.ts'
import { registerRunArtifact } from '../src/service/artifact-store.ts'
import { verifyLedger } from '../src/service/queries/verify_ledger.ts'
import { freshLedger } from '../tests/fixtures/ledger.ts'
import { executeFaultQuery, MISSING_GLOBAL_EVENTS_SQL, ORPHAN_REFERENCES_SQL, sqlRows, type FaultQuery } from './fault-reconcile.ts'
import { checkpoint, eventually, recordJson, seedScope } from './fault-clock-support.ts'
import type { FaultCase } from './fault-report.ts'

const RUN = 's6-stream-scope'
const NODE = 's6-stream-node'
const ARTIFACT_ID = 's6-stream-artifact'
const ARTIFACT_NAME = 'stream-evidence.txt'
const ARTIFACT_BYTES = Buffer.from('S6 local SSE evidence, immutable content\n')
const EVENT_PREFIX = 's6.stream_case.'
const PAGE_LIMIT = 200
const OFFLINE_WRITES = 425
const OFFLINE_MS = 600_000
const FIXTURE_SECRET = 's6-local-stream-fixture'
const PAGE_SQL = `SELECT seq, event_id, type FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?`
const ARTIFACT_SQL = `SELECT a.artifact_id, a.run_id, c.node_run_id, a.sha256, hex(c.bytes) AS file_hex
  FROM artifacts a JOIN artifact_contents c USING (artifact_id) WHERE a.artifact_id=?`

type WireFault = { action: string; event: Invalidation }
type WireFrame = { mode: string; event: Invalidation }

function observeWire(response: Response, mode: string, frames: WireFrame[], fault?: {
  lastApplied: number; observed: WireFault[];
}): Response {
  if (!response.body || !response.ok) return response
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = ''
  let boundary: number
  const apply = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary + 2)
        buffer = buffer.slice(boundary + 2)
        const payload = /^data: (.*)$/m.exec(frame)?.[1]
        if (!frame.includes('event: invalidation') || !payload) {
          controller.enqueue(encoder.encode(frame))
          continue
        }
        const event = JSON.parse(payload) as Invalidation
        frames.push({ mode, event })
        if (fault && event.seq === fault.lastApplied + 2) {
          fault.observed.push({ action: 'drop', event })
          continue
        }
        controller.enqueue(encoder.encode(frame))
        if (fault && event.seq === fault.lastApplied + 1) {
          fault.observed.push({ action: 'duplicate', event })
          controller.enqueue(encoder.encode(frame))
          // Let the client's real coalescing callback emit seq+1 before exposing the next gap.
          await pause(35)
        }
        if (fault && event.seq === fault.lastApplied + 3) fault.observed.push({ action: 'exposed_gap', event })
      }
    },
  })
  return new Response(response.body.pipeThrough(apply), { status: response.status, headers: response.headers })
}

export function streamResumeCase(realTime: boolean): FaultCase {
  return async ({ directory }) => {
    const { file, db: initialDb } = freshLedger(directory)
    const clock = new ScriptedClock('s6_offline', { wallClockMs: Date.now(), monotonicNs: 0 })
    const wire: WireFault[] = []
    const frames: WireFrame[] = []
    const subscriptions: { afterSeq: number; at: string; mode: string; status?: number }[] = []
    const statuses: { status: StreamStatus; cursor: number; at: string }[] = []
    const commits: { seq: number; event_id: string; type: string; stage: string }[] = []
    const notifications: { type: string; cursor: number }[] = []
    const pages: { fromSeq: number; waterline: number; items: Invalidation[] }[] = []
    const oldReadRequested = Promise.withResolvers<void>()
    const allowOldRead = Promise.withResolvers<void>()
    const oldReadStarted = Promise.withResolvers<void>()
    const releaseOldRead = Promise.withResolvers<void>()
    const initialCut = new AbortController()
    let stalePage: (typeof pages)[number] | undefined
    let staleResponseReturned = false
    let service: Awaited<ReturnType<typeof serveOrchestra>> | undefined
    let stream: ReturnType<typeof createConnectedEventStream> | undefined
    let recovery: Promise<number> | undefined
    let resumeCursor = -1
    let injectFrames = false
    const artifacts: string[] = []
    try {
      seedScope(initialDb, RUN, NODE)
      registerRunArtifact(initialDb, { artifactId: ARTIFACT_ID, runId: RUN, nodeRunId: NODE,
        fileName: ARTIFACT_NAME, bytes: ARTIFACT_BYTES })
      writeFileSync(join(directory, ARTIFACT_NAME), ARTIFACT_BYTES, { flag: 'wx' })
      artifacts.push(ARTIFACT_NAME)
    } finally { initialDb.raw.close() }

    const head = (db: Db) => Number(db.raw.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get()?.seq)
    try {
      service = await serveOrchestra({
        dbFile: file, configPath: join(directory, 'no-host-config.json'), phase: 'S6', secret: FIXTURE_SECRET,
        asOfSeq: () => head(service!.orchestra.db),
        listTasks: () => { throw new Error('Unexpected legacy task reader') },
        listEvents: () => { throw new Error('Unexpected legacy event reader') },
        appendLedgerEvent(body) {
          const { type } = body as { type: string }
          return withTx(service!.orchestra.db, (tx) => {
            const receipt = appendEvent(tx, { type, runId: RUN, nodeRunId: NODE })
            appendNodeRunEvent(tx, FIXTURE_SECRET, NODE, type, receipt)
            return receipt
          })
        },
      })
      const db = service.orchestra.db
      const base = service.endpoint
      const originalHead = head(db)
      const requestHeaders = { 'x-orchestra-secret': FIXTURE_SECRET }
      let retainStaleResponse = false
      let streamMode = 'initial'
      const fetcher: FetchLike = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
        const headers = { ...Object.fromEntries(new Headers(init?.headers)), ...requestHeaders }
        if (url.pathname === '/v1/events/stream') {
          const mode = streamMode
          const afterSeq = Number(url.searchParams.get('after_seq'))
          const trace = { afterSeq, mode, at: new Date().toISOString(), status: 0 }
          subscriptions.push(trace)
          const signal = mode === 'initial' && init?.signal
            ? AbortSignal.any([init.signal, initialCut.signal]) : init?.signal
          const response = await fetch(url, { ...init, headers, signal })
          trace.status = response.status
          const fault = injectFrames ? { lastApplied: resumeCursor, observed: wire } : undefined
          injectFrames = false
          return observeWire(response, mode, frames, fault)
        }
        const stale = url.pathname === '/v1/events' && retainStaleResponse
        if (stale) {
          retainStaleResponse = false
          oldReadRequested.resolve()
          await allowOldRead.promise
        }
        const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(8000) })
        if (stale) {
          const raw = await response.text()
          const old = JSON.parse(raw) as { as_of_seq: number; data: { items: Invalidation[] } }
          stalePage = { fromSeq: Number(url.searchParams.get('from_seq')), waterline: old.as_of_seq, items: old.data.items }
          oldReadStarted.resolve()
          await releaseOldRead.promise
          staleResponseReturned = true
          return new Response(raw, { status: response.status, headers: { 'content-type': 'application/json' } })
        }
        return response
      }
      const client = createApiClient(base, fetcher)
      const write = async (index: number, stage: string) => {
        const type = EVENT_PREFIX + index
        const reply = await client.post<{ seq: number; event_id: string }>('/v1/ledger/events', { type })
        const receipt = { seq: reply.data.seq, event_id: reply.data.event_id, type, stage }
        commits.push(receipt)
        return receipt
      }

      // The local ledger consumer retains individual event receipts during the production
      // EventStream resync callback. PanelApp uses that callback to refresh visible snapshots.
      const recover = async () => {
        let cursor = stream!.lastEventSeq
        for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
          const page = await client.get<{ items: Invalidation[] }>('/v1/events', { from_seq: cursor, limit: PAGE_LIMIT })
          const items = page.data.items.map(({ seq, event_id, type }) => ({ seq, event_id, type }))
          pages.push({ fromSeq: cursor, waterline: page.as_of_seq, items })
          if (pageNumber === 0) await write(OFFLINE_WRITES + 2, 'during_recovery')
          cursor = items.at(-1)?.seq ?? cursor
          if (items.length < PAGE_LIMIT && cursor === page.as_of_seq) {
            stream!.setSnapshot(cursor)
            return cursor
          }
        }
        throw new Error('Authoritative replay did not reach a contiguous bounded watermark')
      }
      stream = createConnectedEventStream({
        client, fetcher, baseUrl: base, coalesceMs: 0,
        onInvalidate(type) {
          notifications.push({ type, cursor: stream!.lastEventSeq })
          if (type === 'resync_required') {
            recovery = recover()
            void recovery.catch(() => undefined)
          }
        },
        onStatus(status) { statuses.push({ status, cursor: stream?.lastEventSeq ?? -1, at: new Date().toISOString() }) },
      })
      stream.start(originalHead)
      await eventually(() => statuses.at(-1)?.status === 'live', 'initial SSE handshake')
      const initial = await write(0, 'before_cut')
      await eventually(() => notifications.some(({ type }) => type === initial.type), 'initial receipt consumed by SSE')
      resumeCursor = stream.lastEventSeq
      const before = { db: checkpoint(file, directory, 'before.db'), cursor: resumeCursor, initial }
      artifacts.push(before.db)
      // A real response is captured by the old polling generation, held past resync, and released after a new live write.
      retainStaleResponse = true
      initialCut.abort()
      const waitForOldRead = (promise: Promise<void>) => Promise.race([promise,
        pause(8000, undefined, { ref: false }).then(() => { throw new Error('No fallback read after the live SSE disconnect') })])
      await waitForOldRead(oldReadRequested.promise)
      const oldReadEvent = await write(1, 'offline')
      allowOldRead.resolve()
      await waitForOldRead(oldReadStarted.promise)
      stream.stop()

      const offlineAt = new Date().toISOString()
      const offlineStarted = performance.now()
      const offlineClock = clock.sample()
      for (let index = 2; index <= OFFLINE_WRITES; index++) await write(index, 'offline')
      if (realTime) await pause(Math.max(0, OFFLINE_MS - (performance.now() - offlineStarted) + 1))
      clock.advanceMs(OFFLINE_MS)
      clock.setWallClockMs(offlineClock.wallClockMs + OFFLINE_MS)
      const elapsedMs = performance.now() - offlineStarted
      const breakpoint = { db: checkpoint(file, directory, 'offline.db'), cursor: resumeCursor, head: head(db),
        offlineAt, resumeAt: new Date().toISOString(), actualOfflineMs: elapsedMs,
        clockAdvanceMs: (clock.sample().monotonicNs - offlineClock.monotonicNs) / 1e6 }
      artifacts.push(breakpoint.db)
      injectFrames = true
      streamMode = 'resume_with_wire_faults'
      stream.start(resumeCursor)
      await eventually(() => recovery !== undefined, 'gap recovery callback')
      if (!recovery) throw new Error('Gap recovery did not start')
      const recoveredCursor = await recovery
      await eventually(() => statuses.at(-1)?.status === 'live' && stream!.lastEventSeq === recoveredCursor, 'recovered SSE connection')
      const late = await write(OFFLINE_WRITES + 3, 'after_recovery')
      await eventually(() => notifications.some(({ type }) => type === late.type), 'post-resync live receipt')
      const priorToOldPage = { cursor: stream.lastEventSeq, notifications: notifications.length }
      releaseOldRead.resolve()
      await eventually(() => staleResponseReturned, 'delivery of the old generation read')
      await pause(40)
      const afterOldPage = { cursor: stream.lastEventSeq, notifications: notifications.length }

      stream.stop()
      streamMode = 'second_resume'
      stream.start(priorToOldPage.cursor)
      await eventually(() => statuses.at(-1)?.status === 'live', 'second SSE reconnection')
      await pause(300)
      const countAfterSecondResume = notifications.length
      const final = await write(OFFLINE_WRITES + 4, 'after_second_resume')
      await eventually(() => notifications.some(({ type }) => type === final.type), 'receipt on second reconnect')
      const after = { db: checkpoint(file, directory, 'after.db'), head: head(db), cursor: stream.lastEventSeq, recoveredCursor }
      artifacts.push(after.db)

      const byType = new Map(frames.map(({ event }) => [event.type, event]))
      const delivered = notifications.filter(({ type }) => type !== 'resync_required')
      const sseAccepted = delivered.flatMap(({ type }) => {
        const frame = byType.get(type)
        return frame ? [frame] : []
      })
      const consumer = [...sseAccepted.filter(({ seq }) => seq <= resumeCursor + 1),
        ...pages.flatMap(({ items }) => items), ...sseAccepted.filter(({ seq }) => seq > recoveredCursor)]
      const q = (sql: string, expectedCount: number, bindings: FaultQuery['bindings'] = [], database = 'after.db'): FaultQuery =>
        ({ database, sql, bindings, expectedCount })
      // The final DB contains two further live receipts which were not committed during the last rebuild read.
      const independentRebuildPages = pages.map(({ fromSeq, waterline, items }) => executeFaultQuery(directory,
        q(PAGE_SQL, items.length, [fromSeq, waterline, PAGE_LIMIT])))
      const authoritative = sqlRows(db.raw.prepare(PAGE_SQL).all(originalHead, after.head, commits.length))
      const ledger = verifyLedger(db, FIXTURE_SECRET)
      const artifactRow = db.raw.prepare(ARTIFACT_SQL).get(ARTIFACT_ID)
      const suppliedHash = sha256Hex(ARTIFACT_BYTES)
      artifacts.push(recordJson(directory, 'stream-raw.json', {
        wire, frames, subscriptions, statuses, commits, notifications, pages, independentRebuildPages, consumer,
        stalePage, priorToOldPage, afterOldPage, ledger, artifactRow, suppliedHash,
      }))
      return {
        params: { offlineTargetMs: OFFLINE_MS, realTime, offlineWrites: OFFLINE_WRITES, replayPageLimit: PAGE_LIMIT },
        sampleIds: { runId: RUN, nodeRunId: NODE, artifactId: ARTIFACT_ID, lastAppliedBeforeCut: resumeCursor },
        boundary: { reached: wire.some(({ action }) => action === 'duplicate') && wire.some(({ action }) => action === 'drop')
          && wire.some(({ action }) => action === 'exposed_gap') && staleResponseReturned
          && (!realTime || elapsedMs >= OFFLINE_MS), initialCut: initialCut.signal.aborted, actualOfflineMs: elapsedMs },
        snapshots: { before, breakpoint, after },
        queries: {
          half_rows: q(`SELECT g.seq,g.event_id,n.node_run_id FROM events g LEFT JOIN node_run_events n
              ON n.node_run_id=? AND json_extract(n.payload,'$.event_id')=g.event_id AND n.type=g.type
            WHERE g.run_id=? AND g.type LIKE ? AND (n.node_run_id IS NULL OR g.node_run_id <> ?)
            UNION ALL SELECT n.seq,json_extract(n.payload,'$.event_id'),n.node_run_id FROM node_run_events n
              LEFT JOIN events g ON g.event_id=json_extract(n.payload,'$.event_id') AND g.run_id=?
              WHERE n.node_run_id=? AND g.seq IS NULL`, 0, [NODE, RUN, EVENT_PREFIX + '%', NODE, RUN, NODE]),
          orphan_runs: q(ORPHAN_REFERENCES_SQL, 0),
          missing_events: q(MISSING_GLOBAL_EVENTS_SQL, 0, [JSON.stringify(commits)]),
        },
        extraQueries: {
          offline_receipts: q(PAGE_SQL, OFFLINE_WRITES, [resumeCursor, breakpoint.head, OFFLINE_WRITES + 1], 'offline.db'),
          artifact_scope: q(ARTIFACT_SQL, 1, [ARTIFACT_ID]),
          chain_head_scope: q('SELECT h.* FROM node_run_chain_heads h JOIN node_runs n USING(node_run_id) WHERE n.run_id=? AND h.node_run_id=? AND h.event_count=?', 1, [RUN, NODE, commits.length]),
          ...Object.fromEntries(pages.map(({ fromSeq, waterline, items }, index) =>
            ['replay_page_' + (index + 1), q(PAGE_SQL, items.length, [fromSeq, waterline, PAGE_LIMIT])])),
        },
        checks: {
          real_ten_minute_disconnect: { actual: elapsedMs >= OFFLINE_MS, expected: true },
          controlled_elapsed_ms: { actual: breakpoint.clockAdvanceMs, expected: OFFLINE_MS },
          offline_and_recovery_write_counts: { actual: commits.filter(({ stage }) => stage === 'offline').length, expected: OFFLINE_WRITES },
          live_receipts: { actual: sseAccepted.map(({ seq }) => seq), expected: [resumeCursor, resumeCursor + 1, late.seq, final.seq] },
          wire_receipts_match_consumer_notifications: { actual: delivered.map(({ cursor }) => cursor),
            expected: sseAccepted.map(({ seq }) => seq) },
          duplicate_gap_and_replay: { actual: wire.map(({ action, event }) => [action, event.seq]),
            expected: [['duplicate', resumeCursor + 1], ['drop', resumeCursor + 2], ['exposed_gap', resumeCursor + 3]] },
          recovery_pages: { actual: pages.map(({ items }) => items.length), expected: [200, 200, 25] },
          independent_paginated_event_identity: { actual: independentRebuildPages.map(({ rows }) => rows), expected: pages.map(({ items }) => items) },
          consumed_receipts_match_sql: { actual: consumer, expected: authoritative },
          consumed_once_in_order: { actual: {
              missing: authoritative.filter(({ seq }) => !consumer.some((event) => event.seq === seq)).length,
              duplicate: consumer.length - new Set(consumer.map(({ event_id }) => event_id)).size,
              outOfOrder: consumer.filter(({ seq }, index) => seq !== originalHead + index + 1).length,
            }, expected: { missing: 0, duplicate: 0, outOfOrder: 0 } },
          old_poll_cannot_override_resync: { actual: [staleResponseReturned, stalePage?.items.map(({ seq }) => seq),
              afterOldPage, statuses.at(-1)?.status],
            expected: [true, [oldReadEvent.seq], priorToOldPage, 'live'] },
          new_cursor_and_no_replay_on_second_resume: { actual: [countAfterSecondResume, subscriptions.at(-1)?.afterSeq, after.cursor],
            expected: [priorToOldPage.notifications, priorToOldPage.cursor, final.seq] },
          chain_hashes: { actual: [ledger.valid, ledger.chains, ledger.entries, ledger.gaps.length], expected: [true, 1, commits.length, 0] },
          artifact_content_and_ownership: { actual: [artifactRow?.run_id, artifactRow?.node_run_id, artifactRow?.sha256,
              sha256Hex(Buffer.from(String(artifactRow?.file_hex ?? ''), 'hex'))],
            expected: [RUN, NODE, suppliedHash, suppliedHash] },
        },
        artifacts,
        extra: { productionPanelContract: 'A gap refreshes visible snapshots from the authoritative watermark. The local per-event consumer uses the EventStream resync callback to record event replay pages.',
          fullDurationCommand: 'Set ORCHESTRA_S6_G09_REAL_TIME=1 for an actual ten-minute reconnect. The fast case retains a failed real-time check.' },
      }
    } finally {
      allowOldRead.resolve()
      releaseOldRead.resolve()
      stream?.stop()
      try { await service?.close() } finally {
        if (!artifacts.includes('stream-raw.json')) recordJson(directory, 'stream-partial.json', {
          wire, frames, subscriptions, statuses, commits, notifications, pages, stalePage, staleResponseReturned,
        })
      }
    }
  }
}

export const caseG09S6: FaultCase = (context) => streamResumeCase(process.env.ORCHESTRA_S6_G09_REAL_TIME === '1')(context)
