import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { sha256Hex } from '../src/core/canonical.ts'
import { releaseHash, type ReleaseEvidenceReader } from '../src/core/wf-release-v1.ts'
import { openDb } from '../src/infra/sqlite/driver.ts'
import { summarizeLag } from './event-lag.ts'
import { executeFaultQuery, REQUIRED_FAULT_QUERIES, type FaultQuery } from './fault-reconcile.ts'
import { assessPerfReport, perfReportSchema } from './perf-budget-evidence.ts'
import { judgeSoak, type End, type Manifest, type Point, type SoakEvent } from './soak-judge.ts'
import { assertFormalSoakArchive } from './soak-archive.ts'
import { ledgerHealth } from './soak-ledger.ts'

export function withG6Scratch<T>(fn: (directory: string) => T): T {
  const parent = resolve(tmpdir())
  const directory = resolve(mkdtempSync(join(parent, 'dsh-g6-')))
  if (!directory.startsWith(parent + sep)) throw new Error('Invalid scratch directory')
  try { return fn(directory) }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

const utf8 = new TextDecoder('utf-8', { fatal: true })
function parse<T = unknown>(bytes: Uint8Array): T { return JSON.parse(utf8.decode(bytes)) as T }
function lines<T>(bytes: Uint8Array): T[] {
  const text = utf8.decode(bytes)
  if (text && !text.endsWith('\n')) throw new Error('Incomplete NDJSON record')
  return text.split(/\r?\n/u).slice(0, -1).map(line => JSON.parse(line) as T)
}
type Query = Parameters<ReleaseEvidenceReader['observe']>[0]

function byBasename(evidence: Query['evidence']) {
  const files = new Map<string, Uint8Array>()
  for (const { entry, bytes } of evidence) {
    const name = basename(entry.file)
    if (files.has(name)) throw new Error('Conflicting evidence basenames')
    files.set(name, bytes)
  }
  return { files, get(name: string): Uint8Array {
    const file = files.get(name)
    if (!file) throw new Error('Missing evidence ' + name)
    return file
  } }
}

function fault(input: Query, frozenPackageSha?: string) {
  const reports = input.evidence.filter(({ entry }) => posix.basename(entry.file) === 'report.json')
  if (reports.length !== 1) return
  const prefix = posix.dirname(reports[0]!.entry.file)
  const files = new Map<string, Uint8Array>()
  for (const { entry, bytes } of input.evidence) {
    const name = posix.relative(prefix, entry.file)
    if (name.split('/').some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')
      || posix.join(prefix, name) !== entry.file || files.has(name)) return
    files.set(name, bytes)
  }
  const report = parse<{
    schemaVersion: number; scriptVersion: number; case: string; candidateSha: string; candidateDirty: boolean;
    argv: unknown[]; boundary?: { reached: boolean }; snapshots: Record<string, Record<string, unknown>>; sampleIds: Record<string, unknown>;
    passed: boolean; failures: string[]; startedAt: string; finishedAt: string;
    artifacts: Record<string, { sha256: string; bytes: number }>;
    params?: { evidence_mode?: string; official_eligible?: boolean; candidate_package_sha256?: string };
    reconcile: Record<string, FaultQuery & { rows: unknown; actualCount: number; passed: boolean }>;
    extra: { queries?: Record<string, FaultQuery & { rows: unknown; actualCount: number; passed: boolean }>;
      checks?: Record<string, { actual: unknown; expected: unknown; passed: boolean }> };
  }>(reports[0]!.bytes)
  if (report.schemaVersion !== 1 || report.scriptVersion !== 1 || report.case !== input.id
    || report.candidateSha !== input.candidate.git_sha || report.candidateDirty !== false
    || report.boundary?.reached !== true || report.passed !== true || report.failures.length !== 0 || !report.argv.length
    || !(Date.parse(report.finishedAt) >= Date.parse(report.startedAt))
    || !Object.keys(report.sampleIds).length || !Object.keys(report.artifacts).length
    || !['before','breakpoint','after'].every((stage) => !!Object.keys(report.snapshots[stage] ?? {}).length)) return
  if (files.size !== Object.keys(report.artifacts).length + 1 || !REQUIRED_FAULT_QUERIES.every((name) => report.reconcile[name])) return
  if (input.id === 'G-13' && (!frozenPackageSha || report.params?.evidence_mode !== 'candidate' || report.params.official_eligible !== true
    || report.params.candidate_package_sha256 !== frozenPackageSha || report.artifacts['candidate.tgz']?.sha256 !== frozenPackageSha)) return
  if (Object.values(report.extra.checks ?? {}).some((check) => check.passed !== true || releaseHash(check.actual) !== releaseHash(check.expected))) return
  return withG6Scratch((directory) => {
    for (const [name, meta] of Object.entries(report.artifacts)) {
      const bytes = files.get(name)
      if (name === 'report.json' || !bytes || bytes.byteLength !== meta.bytes || sha256Hex(Buffer.from(bytes)) !== meta.sha256) return
      mkdirSync(dirname(join(directory, name)), { recursive: true })
      writeFileSync(join(directory, name), bytes, { flag: 'wx' })
    }
    const queries = [...Object.values(report.reconcile), ...Object.values(report.extra.queries ?? {})]
    for (const expected of queries) {
      const observed = executeFaultQuery(directory, expected)
      if (!observed.passed || expected.passed !== true || observed.actualCount !== expected.actualCount
        || releaseHash(observed.rows) !== releaseHash(expected.rows)) return
    }
    return { kind: 'fault', exit_code: 0, injection: true, before_ledger: true, after_ledger: true, reconciled: true }
  })
}

function perf(input: Query) {
  const raw = parse(byBasename(input.evidence).get('perf-report.json'))
  const parsed = perfReportSchema.safeParse(raw)
  const assessed = assessPerfReport(raw)
  if (!parsed.success || parsed.data.candidate.commit !== input.candidate.git_sha || !assessed.pass) return
  const { data } = parsed
  const statistics = assessed.statistics
  return { kind: 'control_p95', list_tasks_rows: data.seeds.q27_tasks, list_tasks_ms: statistics.list_tasks?.p95,
    get_run_nodes: data.seeds.q26_nodes, get_run_ms: statistics.get_run?.p95,
    list_nodes_rows: data.cases.list_nodes.size, list_nodes_ms: statistics.list_nodes?.p95,
    list_events_rows: data.cases.list_events.size, list_events_ms: statistics.list_events?.p95 }
}

function soak(input: Query) {
  const { get } = byBasename(input.evidence)
  const manifest = parse<Manifest>(get('manifest.json'))
  if (manifest.kind !== 'formal' || manifest.candidate !== input.candidate.git_sha) return
  const readArchive = (name: string) => {
    if (name !== 'workspace/sample.txt') return get(name)
    const example = input.evidence.find(({ entry }) => entry.file.replaceAll('\\', '/').endsWith('/' + name))
    if (!example) throw new Error('Missing isolated soak workspace fixture')
    return example.bytes
  }
  assertFormalSoakArchive(readArchive, manifest)
  const end = parse<End>(get('end.json'))
  const points = lines<Point>(get('points.ndjson'))
  const events = lines<SoakEvent>(get('events.ndjson'))
  const report = judgeSoak(manifest, points, events, end)
  if (!report.g6Eligible || releaseHash(report) !== releaseHash(parse(get('soak-report.json')))) return
  const verified = withG6Scratch((directory) => {
    const dbFile = join(directory, 'ledger.db')
    writeFileSync(dbFile, get('ledger.db'), { flag: 'wx' })
    const db = openDb(dbFile, { readonly: true })
    try {
      if (db.raw.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
        || db.raw.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') return false
      const check = db.raw.prepare('SELECT event_id,type FROM events WHERE seq=?')
      return !!end.ledger && releaseHash(ledgerHealth(db)) === releaseHash(end.ledger)
        && events.every((event) => {
          const row = check.get(event.seq)
          return row?.event_id === event.event_id && row?.type === event.type
        })
    } finally { db.raw.close() }
  })
  if (!verified) return
  if (input.id === 'event_lag') {
    const lag = report.lag.probes
    if (!lag.passed || !lag.complete) return
    return { kind: 'event_lag', windows: [report.lag.events, ...lag.slices.map((window) => ({ ...window, count: window.count }))]
      .map((window) => ({ p95_ms: window.p95Ms, max_ms: window.maxMs, samples: window.count })) }
  }
  return { kind: 'soak_24h', duration_ms: report.observed_duration_ms, samples: report.sample_count,
    orphaned: 0, unsettled: 0, leaks: 0, rss_growth: false, wal_growth: false,
    p95_ms: report.lag.events.p95Ms, max_ms: report.lag.events.maxMs }
}

export const OFFICE_LAG_SCHEMA = 'dsh-office-event-lag/1'
export const OFFICE_LAG_WINDOW = { slotMs: 5_000, slots: 120, slotsPerSlice: 12 } as const
export const OFFICE_LAG_ORIGINALS = ['launch.json', 'events.ndjson', 'ledger.db', 'lag-samples.json'] as const
const officeLagFiles = [...OFFICE_LAG_ORIGINALS, 'end.json'] as const
const elapsedWindowMs = OFFICE_LAG_WINDOW.slotMs * OFFICE_LAG_WINDOW.slots
const probeType = 's6.soak_probe'
const lagInstant = z.number().nonnegative()
const lagSeq = z.number().int().positive()
const lagCandidate = z.string().regex(/^[a-f0-9]{40}$/u)
const lagMeasurement = z.uuid()
const lagWindow = z.strictObject({
  startMs: lagInstant, slotMs: z.literal(OFFICE_LAG_WINDOW.slotMs),
  slots: z.literal(OFFICE_LAG_WINDOW.slots), slotsPerSlice: z.literal(OFFICE_LAG_WINDOW.slotsPerSlice),
})
const lagObservation = z.strictObject({
  slot: z.number().int().min(0).max(OFFICE_LAG_WINDOW.slots - 1),
  seq: lagSeq, committedMs: lagInstant, observedMs: lagInstant,
})
const lagEvent = lagObservation.extend({ type: z.string().min(1), event_id: z.string().min(1) })
const lagLaunch = z.strictObject({
  schema: z.literal(OFFICE_LAG_SCHEMA), candidate: lagCandidate, measurement: lagMeasurement, clean: z.literal(true),
  startedAt: z.iso.datetime(), window: lagWindow, baselineSeq: z.number().int().nonnegative(),
  platform: z.string().min(1), clock: z.string().min(1), traffic: z.string().min(1),
})
const lagFile = z.strictObject({
  schema: z.literal(OFFICE_LAG_SCHEMA), candidate: lagCandidate, measurement: lagMeasurement, clean: z.literal(true),
  window: lagWindow, observations: lagObservation.array().length(OFFICE_LAG_WINDOW.slots),
})
const lagEnd = z.strictObject({
  schema: z.literal(OFFICE_LAG_SCHEMA), candidate: lagCandidate, measurement: lagMeasurement, portReleased: z.literal(true),
  completedAt: z.iso.datetime(), completedMs: lagInstant, elapsedMs: lagInstant, throughSeq: lagSeq,
  originals: z.record(z.enum(OFFICE_LAG_ORIGINALS), z.string().regex(/^[a-f0-9]{64}$/u)),
})

function lagStats(samples: number[]) {
  const ordered = samples.sort((a, b) => a - b)
  return { samples: ordered.length, p95_ms: ordered[Math.ceil(ordered.length * 0.95) - 1]!, max_ms: ordered.at(-1)! }
}

function lag(input: Query) {
  const { files, get } = byBasename(input.evidence)
  const prefix = posix.dirname(input.evidence[0]?.entry.file ?? '')
  if (files.size !== officeLagFiles.length || !officeLagFiles.every((file) => files.has(file))
    || posix.basename(prefix) !== 'lag' || input.evidence.some(({ entry }) => posix.dirname(entry.file) !== prefix
      || posix.normalize(entry.file) !== entry.file)) return
  const launch = lagLaunch.parse(parse(get('launch.json')))
  const raw = lagFile.parse(parse(get('lag-samples.json')))
  const end = lagEnd.parse(parse(get('end.json')))
  const { startMs, slotMs, slotsPerSlice } = launch.window
  const startedAt = Date.parse(launch.startedAt)
  const completedAt = Date.parse(end.completedAt)
  if ([launch, raw, end].some((record) => record.candidate !== input.candidate.git_sha || record.measurement !== launch.measurement)
    || raw.window.startMs !== startMs || end.completedMs - startMs !== end.elapsedMs || end.elapsedMs < elapsedWindowMs
    || Math.abs(completedAt - startedAt - end.elapsedMs) > 1_000
    || !OFFICE_LAG_ORIGINALS.every((name) => sha256Hex(Buffer.from(get(name))) === end.originals[name])) return

  const events = lagEvent.array().parse(lines(get('events.ndjson')))
  if (events.length < launch.window.slots || events.length !== end.throughSeq - launch.baselineSeq
    || new Set(events.map((event) => event.event_id)).size !== events.length) return
  const probes = []
  const slices = Array.from({ length: launch.window.slots / slotsPerSlice }, () => [] as number[])
  let lastCommit = startMs
  let lastDelivery = startMs
  const all = []
  for (const [index, { event_id: _id, type, ...sample }] of events.entries()) {
    const { seq, slot, committedMs, observedMs } = sample
    if (seq !== launch.baselineSeq + index + 1 || slot !== Math.floor((committedMs - startMs) / slotMs)
      || committedMs < lastCommit || observedMs < committedMs || observedMs < lastDelivery || observedMs > end.completedMs) return
    lastCommit = committedMs
    lastDelivery = observedMs
    const lagMs = observedMs - committedMs
    all.push(lagMs)
    slices[Math.floor(slot / slotsPerSlice)]!.push(lagMs)
    if (type === probeType) probes.push(sample)
  }
  if (releaseHash(probes) !== releaseHash(raw.observations) || !summarizeLag(raw.observations, launch.window).complete) return

  const checked = withG6Scratch((directory) => {
    const dbFile = join(directory, 'ledger.db')
    writeFileSync(dbFile, get('ledger.db'), { flag: 'wx' })
    const db = openDb(dbFile, { readonly: true })
    try {
      if (db.raw.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
        || db.raw.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete'
        || db.raw.prepare('SELECT MAX(seq) AS seq FROM events').get()?.seq !== end.throughSeq) return false
      if (launch.baselineSeq > 0) {
        const previous = db.raw.prepare('SELECT created_at FROM events WHERE seq=?').get(launch.baselineSeq)
        if (!previous || typeof previous.created_at !== 'string' || !(Date.parse(previous.created_at) <= startedAt)
          || db.raw.prepare('SELECT 1 FROM events WHERE seq<=? AND type=? LIMIT 1').get(launch.baselineSeq, probeType)) return false
      }
      const ledger = db.raw.prepare('SELECT seq,event_id,type,created_at FROM events WHERE seq>? ORDER BY seq').all(launch.baselineSeq)
      return ledger.length === events.length && ledger.every((row, index) => {
        const observed = events[index]!
        const createdAt = typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN
        // SQLite records insertion wall time, and the collector samples monotonic time after COMMIT.
        // Allow 10 ms for wall-clock precision and the two start-clock reads.
        return row.seq === observed.seq && row.event_id === observed.event_id && row.type === observed.type
          && createdAt >= startedAt - 10 && createdAt <= startedAt + (observed.committedMs - startMs) + 10
          && createdAt <= completedAt + 10
      })
    } finally { db.raw.close() }
  })
  if (!checked) return
  const windows = [all, ...slices].map(lagStats)
  if (windows.some(({ p95_ms, max_ms }) => p95_ms > 2_000 || max_ms > 10_000)) return
  return { kind: 'event_lag', windows }
}

const hash = z.string().regex(/^[0-9a-f]{64}$/).refine((value) => !/^0+$/.test(value))
const operation = z.strictObject({ schema: z.literal('g6-operations/1'), candidate: z.string(), item: z.string(),
  previous_build: hash, observed_at: z.iso.datetime(), session: z.string().min(8),
  performed_by: z.string().regex(/^human:\S.*$/),
  steps: z.array(z.strictObject({ id: z.string(), exit_code: z.literal(0), evidence_id: z.string(),
    ledger_seq: z.number().int().nonnegative(), at: z.iso.datetime(),
  })).min(1).max(20),
})
function operations(input: Query) {
  const raw = operation.parse(parse(byBasename(input.evidence).get(input.id + '.json')))
  if (raw.candidate !== input.candidate.git_sha || raw.item !== input.id) return
  const expected = input.id === 'upgrade'
    ? ['backup','verify_copy','quiesce','healthcheck','synthetic_run','observe']
    : input.id === 'load_rollback'
      ? ['backup','verify_copy','quiesce','healthcheck','synthetic_run','observe','fault','old_reads_new','new_reads_old','rollback_with_load','replay']
      : ['alert','human_ack','quiesce','rollback_verified']
  const available = new Set(input.evidence.filter(({ entry }) => basename(entry.file) !== input.id + '.json').map(({ entry }) => entry.evidence_id))
  if (raw.steps.length !== expected.length || new Set(raw.steps.map((step) => step.evidence_id)).size !== raw.steps.length
    || raw.steps.some((step, index) => step.id !== expected[index] || !available.has(step.evidence_id)
      || (index > 0 && (step.ledger_seq < raw.steps[index - 1]!.ledger_seq || step.at < raw.steps[index - 1]!.at)))) return
  if (input.id === 'upgrade') return { kind: 'upgrade', previous_build: raw.previous_build, healthy: true, ledger_replayed: true }
  if (input.id === 'load_rollback') return { kind: 'load_rollback', previous_build: raw.previous_build, under_load: true,
    old_reads_new: true, new_reads_old: true, ledger_replayed: true }
  return { kind: 'oncall_drill', acknowledged_by: raw.performed_by, rollback_verified: true }
}

const invariant = z.strictObject({ schema: z.literal('g6-invariant/1'), candidate: z.string(), id: z.string(), method: z.string(),
  comparisons: z.array(z.strictObject({ evidence_id: z.string(), observed: hash, expected: hash })).min(1).max(50),
})
function checkInvariant(input: Query) {
  const raw = invariant.parse(parse(byBasename(input.evidence).get(input.id + '.json')))
  const files = new Map(input.evidence.filter(({ entry }) => basename(entry.file) !== input.id + '.json').map(({ entry }) =>
    [entry.evidence_id, entry.sha256]))
  if (raw.candidate !== input.candidate.git_sha || raw.id !== input.id || raw.comparisons.some((check) =>
    check.observed !== check.expected || files.get(check.evidence_id) !== check.observed)) return
  return { kind: 'invariant', id: raw.id, method: raw.method, result: 'pass' }
}

/** Reads exact bytes, with no trust in a report's self-declared verdict. Parser selection is pinned by the item ID. */
export function createG6FileEvidenceReader(read: ReleaseEvidenceReader['read'], frozenPackageSha?: string): ReleaseEvidenceReader {
  return { read, observe(input) {
    try {
      if (input.id.startsWith('G-')) return fault(input, frozenPackageSha)
      if (input.id === 'control_p95') return perf(input)
      if (input.id === 'soak_24h') return soak(input)
      if (input.id === 'event_lag') return input.evidence.some(({ entry }) => basename(entry.file) === 'lag-samples.json') ? lag(input) : soak(input)
      if (['upgrade','load_rollback','oncall_drill'].includes(input.id)) return operations(input)
      return checkInvariant(input)
    } catch {
      return undefined
    }
  } }
}
