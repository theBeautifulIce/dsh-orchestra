import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observeSqlite, openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { parseSoakArguments } from '../../scripts/soak.ts'
import {
  FORMAL_SLOTS, FORMAL_SLOT_MS, judgeSoak, lagStats, resourceTrend,
  type End, type Manifest, type Point, type SoakEvent,
} from '../../scripts/soak-judge.ts'

function fixture(slots = FORMAL_SLOTS, kind: Manifest['kind'] = 'formal') {
  const manifest: Manifest = {
    schema: 1, id: 'test data', kind, candidate: 'a'.repeat(40), clean: true, pid: 1,
    endpoint: 'http://127.0.0.1:1984', epoch: 1, bootId: 'boot', startMs: 10,
    startWallMs: 1_000, slots, slotMs: FORMAL_SLOT_MS, walLimitBytes: 4096,
    configHash: 'b'.repeat(64), startedAt: 'fixture', command: [], node: 'fixture',
    root: 'fixture', role: 'fixture', supervision: 'detached',
  }
  const events: SoakEvent[] = Array.from({ length: slots }, (_, index) => ({
    slot: index + 1, seq: index + 2, event_id: 'event-' + (index + 2), type: 's6.soak_probe',
    committedMs: manifest.startMs + manifest.slotMs * index + 5_000,
    observedMs: manifest.startMs + manifest.slotMs * index + 5_100,
  }))
  const points: Point[] = Array.from({ length: slots + 1 }, (_, slot) => ({
    slot, dueMs: manifest.startMs + manifest.slotMs * slot, actualMs: manifest.startMs + manifest.slotMs * slot,
    wallMs: manifest.startWallMs + manifest.slotMs * slot, pid: manifest.pid, bootId: manifest.bootId,
    ledger: { head: slot + 1, epoch: manifest.epoch, tasks: slot + 1, runs: slot + 1, nodes: slot + 1,
      successes: slot + 1, probes: slot, toolExecutions: slot + 1, orphanRuns: 0, orphanNodes: 0,
      unclosed: 0, inFlight: 0, foreignKeys: 0 },
    counts: { tasks: slot, runs: slot, nodes: slot, tools: slot, polls: slot * 3 },
    resources: { rssBytes: 200_000 + (slot % 7), dbBytes: 1_000 + slot, walBytes: 1_000 + (slot % 20) * 100,
      artifactBytes: 20, readConnections: 0, writeConnections: 1, activeStatements: 0,
      childPids: [], childRssBytes: 0, subscriptionCount: 1, fixtureSessions: 0, active: { TCPWrap: 2, Timeout: 3 } },
    lag: lagStats(slot ? [events[slot - 1]!] : []),
  }))
  const end: End = { actualMs: points.at(-1)!.actualMs + 1, wallMs: points.at(-1)!.wallMs,
    candidate: manifest.candidate, clean: true, configHash: manifest.configHash,
    ledger: { ...points.at(-1)!.ledger }, error: null,
    cleanup: { subscriptionsClosed: true, serviceClosed: true, portReleased: true, lockReleased: true,
      sqliteReleased: true, sidecarsReleased: true, fixtureReleased: true, handlesReleased: true } }
  return { manifest, points, events, end, decide: () => judgeSoak(manifest, points, events, end) }
}

describe('independent soak adjudication', () => {
  it('requires the complete formal wall-clock shape and keeps the short result ineligible', () => {
    const formal = fixture()
    expect(formal.decide()).toMatchObject({ status: 'passed', g6Eligible: true, sample_count: 2880, observed_duration_ms: 86_400_000 })
    const short = fixture(3, 'short')
    expect(short.decide()).toMatchObject({ status: 'short-complete', g6Eligible: false })
    short.manifest.kind = 'formal'
    expect(short.decide()).toMatchObject({ status: 'failed', g6Eligible: false })
    formal.manifest.clean = false
    expect(formal.decide().g6Eligible).toBe(false)
  })

  it('fails for missing, duplicate, reordered, delayed, or restarted samples and wall rollback', () => {
    const bad = [
      (p: Point[]) => p.splice(1, 1),
      (p: Point[]) => p.splice(1, 0, p[1]!),
      (p: Point[]) => { [p[1], p[2]] = [p[2]!, p[1]!] },
      (p: Point[]) => { p[2]!.actualMs += FORMAL_SLOT_MS },
      (p: Point[]) => { p[2]!.pid++ },
      (p: Point[]) => { p[2]!.bootId += 'restart' },
      (p: Point[]) => { p[2]!.ledger.epoch++ },
      (p: Point[]) => { p[2]!.wallMs = p[1]!.wallMs - 1 },
      (p: Point[]) => { p[2]!.ledger.head = 0 },
      (p: Point[]) => { p[2]!.counts.polls-- },
      (p: Point[]) => { p[2]!.resources.childPids.push(1111) },
    ]
    for (const change of bad) {
      const candidate = fixture(4, 'short')
      change(candidate.points)
      expect(candidate.decide().status).toBe('failed')
    }
    const interrupted = fixture(4, 'short')
    expect(judgeSoak(interrupted.manifest, interrupted.points.slice(0, 2), interrupted.events.slice(0, 1), null))
      .toMatchObject({ status: 'incomplete', g6Eligible: false })
  })

  it('fails for an 11-second spike, missing invalidation, unresolved event or a recovered orphan', () => {
    const spike = fixture(4, 'short')
    spike.events[1]!.observedMs = spike.events[1]!.committedMs + 11_000
    spike.points[2]!.lag = lagStats([spike.events[1]!])
    expect(spike.decide().lag.events.maxMs).toBe(11_000)
    expect(spike.decide().status).toBe('failed')

    const missing = fixture(4, 'short')
    missing.events[1]!.observedMs = null
    missing.points[2]!.lag = lagStats([missing.events[1]!])
    expect(missing.decide().status).toBe('failed')

    for (const issue of ['unclosed', 'orphanRuns', 'orphanNodes'] as const) {
      const candidate = fixture(4, 'short')
      candidate.points[1]!.ledger[issue]++
      expect(candidate.decide().errors).toContain('Ledger reconciliation failed at slot 1')
    }
  })

  it('detects transient handle and SQLite leaks and sustained RSS growth, while accepting WAL checkpoints', () => {
    const tolerable = fixture(100, 'short')
    expect(resourceTrend(tolerable.points, tolerable.manifest.walLimitBytes)).toMatchObject({ passed: true, walDownwardResets: 5 })
    const connection = fixture(4, 'short')
    connection.points[1]!.resources.readConnections++
    connection.points[2]!.resources.activeStatements++
    expect(connection.decide().errors).toContain('Resource measurements are invalid at slot 1')
    expect(connection.decide().errors).toContain('Resource measurements are invalid at slot 2')

    const handles = fixture(4, 'short')
    handles.points[2]!.resources.active.TCPWrap!++
    expect(handles.decide().resources).toMatchObject({ passed: false, resourceGrowth: [{ name: 'TCPWrap', slot: 2 }] })
    tolerable.points[31]!.resources.walBytes = 5_000
    expect(resourceTrend(tolerable.points, tolerable.manifest.walLimitBytes).passed).toBe(false)
    const rss = fixture(100, 'short')
    rss.points.forEach((point, slot) => { point.resources.rssBytes += slot * 10 })
    expect(resourceTrend(rss.points, rss.manifest.walLimitBytes)).toMatchObject({ passed: false, risingQuarters: true, rssRisingSpan: 101 })
  })

  it('rejects a short or accelerated schedule at the formal CLI boundary', () => {
    const args = ['--candidate', 'a'.repeat(40), '--evidence-dir', 'test']
    expect(parseSoakArguments(['--hours', '24', ...args])).toMatchObject({ kind: 'formal', slots: 2880, slotMs: 30_000 })
    expect(() => parseSoakArguments(['--hours', '24', '--slots', '2', ...args])).toThrow()
    expect(() => parseSoakArguments(['--hours', '1', ...args])).toThrow()
    expect(() => parseSoakArguments(['--hours', '24', '--evidence-dir', 'test'])).toThrow()
    expect(() => parseSoakArguments(['--status', '--cancel', '--evidence-dir', 'test'])).toThrow()
  })

  it('counts live connections, tracks only executing statements, and attributes only committed rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 's6-soak-db-observer-'))
    const file = join(directory, 'test.db')
    const observation = observeSqlite(file)
    const writer = openDb(file)
    try {
      writer.raw.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY)')
      const reader = openDb(file, { readonly: true })
      try {
        expect(observation.snapshot()).toEqual({ readConnections: 1, writeConnections: 1, activeStatements: 0 })
        reader.raw.function('soak_resource_count', () => observation.snapshot().activeStatements)
        expect(reader.raw.prepare('SELECT soak_resource_count() AS count').get()?.count).toBe(1)
        expect([...reader.raw.prepare('SELECT soak_resource_count() AS count').iterate()]).toEqual([{ count: 1 }])
        expect(() => observation.stop()).toThrow(/unreleased/)
      } finally { reader.raw.close() }
      observation.startCommitSampling()
      expect(() => withTx(writer, tx => {
        tx.run('INSERT INTO events VALUES (1)')
        throw new Error('Rollback')
      })).toThrow('Rollback')
      expect(observation.drainCommits()).toEqual([])
      withTx(writer, tx => { tx.run('INSERT INTO events VALUES (1), (2)') })
      expect(observation.drainCommits()).toEqual([{ from: 1, to: 2, atMs: expect.any(Number) }])
      expect(observation.snapshot()).toEqual({ readConnections: 0, writeConnections: 1, activeStatements: 0 })
    } finally {
      writer.raw.close()
      observation.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
