import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
  renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate as settle, setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { observeSqlite, openDb } from '../src/infra/sqlite/driver.ts'
import { sealCheckpoint } from './fault-reconcile.ts'
import { ledgerHealth } from './soak-ledger.ts'
import { assertFormalSoakArchive } from './soak-archive.ts'
import {
  FORMAL_DURATION_MS, FORMAL_SLOTS, FORMAL_SLOT_MS, judgeSoak, lagStats,
  type Cleanup, type End, type Point, type Manifest, type SoakEvent,
} from './soak-judge.ts'
import {
  activeResources, assertPortReleased, CONFIG, DATABASE, diskBytes, FIXTURE,
  FIXTURE_CONTENT, observeTimers, sidecarsReleased, spillBytes, startObserver, startSoakService,
} from './soak-workload.ts'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const MIN_FREE_BYTES = 128 * 1024 * 1024
const FILES = ['launch.json', 'host.json', 'manifest.json', 'points.ndjson', 'events.ndjson', 'end.json',
  CONFIG, DATABASE, 'workspace/' + FIXTURE] as const
const cancelName = 'cancel.request'

type Launch = {
  schema: 1; id: string; kind: Manifest['kind']; requestedCandidate: string | null; slots: number; slotMs: number
  command: string[]; supervisorPid: number; supervision: Manifest['supervision']; requestedAt: string
}
type Status = { id: string; pid: number; runtime: string; latest_slot: number; wall_ms: number; reason?: string }
type Arguments = { directory: string; mode: 'launch' | 'verify' | 'status' | 'cancel' | 'worker';
  kind: Launch['kind']; slots: number; slotMs: number; candidate: string | null; runId: string | null; detached: boolean }

const HELP = [
  'node --no-warnings scripts/soak.ts --hours 24 --candidate <full-clean-frozen-SHA> --evidence-dir <new-path>',
  'node --no-warnings scripts/soak.ts --short [--detached] --slots 3 --interval-ms 2000 --evidence-dir <new-path>',
  'node --no-warnings scripts/soak.ts --status|--cancel|--verify --evidence-dir <run-path>',
  'Formal runs start a detached worker. Status reads worker PID, boot, schedule and latest heartbeat.',
  'A restarted service or missing sample invalidates its window. Start any retry in a new directory.',
  'Verification recomputes from sealed bytes and checks the final ledger in read-only mode.',
].join('\n')

export function parseSoakArguments(args: readonly string[]): Arguments {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!
    if (flags.has(flag) || values.has(flag)) throw new Error('Duplicate option ' + flag)
    if (['--short', '--detached', '--status', '--cancel', '--verify'].includes(flag)) { flags.add(flag); continue }
    if (!['--hours', '--slots', '--interval-ms', '--evidence-dir', '--candidate', '--worker'].includes(flag)) {
      throw new Error('Unknown option ' + flag)
    }
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + flag)
    values.set(flag, value)
  }
  const path = values.get('--evidence-dir')
  if (!path) throw new Error('--evidence-dir is required')
  const directory = resolve(path)
  const candidate = values.get('--candidate') ?? null
  const runId = values.get('--worker') ?? null
  const modes = ['--verify', '--status', '--cancel'].filter(flag => flags.has(flag))
  if (modes.length > 1 || (runId && modes.length)
    || ((modes.length || runId) && (values.size !== (runId ? 2 : 1) || flags.size !== modes.length))) {
    throw new Error('Select exactly one action')
  }
  if (modes.length || runId) {
    const mode = runId ? 'worker' : modes[0]!.slice(2) as 'verify' | 'status' | 'cancel'
    return { directory, mode, kind: 'short', slots: 0, slotMs: 0, candidate, runId, detached: false }
  }
  if (flags.has('--short')) {
    const slots = Number(values.get('--slots') ?? 3)
    const slotMs = Number(values.get('--interval-ms') ?? 2_000)
    if (values.has('--hours') || candidate || !Number.isSafeInteger(slots) || slots < 1 || slots > 30
      || !Number.isSafeInteger(slotMs) || slotMs < 1_000 || slotMs > 30_000) throw new Error('Invalid short window')
    return { directory, mode: 'launch', kind: 'short', slots, slotMs, candidate, runId, detached: flags.has('--detached') }
  }
  if (values.get('--hours') !== '24' || !candidate || !/^[a-f0-9]{40}$/.test(candidate)
    || values.has('--slots') || values.has('--interval-ms')) throw new Error('Formal evidence requires --hours 24 and --candidate <full SHA>')
  return { directory, mode: 'launch', kind: 'formal', slots: FORMAL_SLOTS, slotMs: FORMAL_SLOT_MS, candidate, runId, detached: true }
}

function gitInfo() {
  const git = (args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: ROOT, encoding: 'utf8' }).trim()
  return { candidate: git(['rev-parse', 'HEAD']), clean: git(['status', '--porcelain=v1', '--untracked-files=all']) === '' }
}

function sha(bytes: string | Buffer) { return createHash('sha256').update(bytes).digest('hex') }
async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

function atomicJson(directory: string, file: string, value: unknown) {
  const path = join(directory, file)
  const staging = path + '.' + randomUUID() + '.partial'
  writeFileSync(staging, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true })
  renameSync(staging, path)
}
function appendJson(directory: string, file: string, values: readonly unknown[]) {
  if (values.length) appendFileSync(join(directory, file), values.map(value => JSON.stringify(value) + '\n').join(''), { flush: true })
}
function readJson<T>(directory: string, name: string): T {
  return JSON.parse(readFileSync(join(directory, name), 'utf8')) as T
}
function readLines<T>(directory: string, name: string): T[] {
  const file = readFileSync(join(directory, name), 'utf8')
  if (file !== '' && !file.endsWith('\n')) throw new Error('Partial row in ' + name)
  return file.split('\n').slice(0, -1).map(row => JSON.parse(row) as T)
}
function assertSpace(directory: string) {
  const stat = statfsSync(directory)
  if (stat.bavail * stat.bsize < MIN_FREE_BYTES) throw new Error('Soak host has less than 128 MiB available')
  return { availableBytes: stat.bavail * stat.bsize, requiredBytes: MIN_FREE_BYTES }
}
function candidateMatches(launch: Launch, git: ReturnType<typeof gitInfo>) {
  if (launch.kind === 'formal' && (!git.clean || git.candidate !== launch.requestedCandidate)) {
    throw new Error('Formal execution requires the frozen SHA checked out in a clean worktree')
  }
}
function evidenceFile(directory: string, name: string) {
  const path = join(directory, name)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.nlink !== 1 || realpathSync(path) !== path) throw new Error('Evidence file is not an independent regular file: ' + name)
  return path
}
async function fileHashes(directory: string, supervision: Launch['supervision']) {
  const files = supervision === 'detached' ? [...FILES, 'detached.json'] : FILES
  return Object.fromEntries(await Promise.all(files.map(async name => [name, await hashFile(evidenceFile(directory, name))])))
}
function readFinalLedger(directory: string) {
  const file = evidenceFile(directory, DATABASE)
  if (!sidecarsReleased(file)) throw new Error('Final ledger has an unsealed SQLite sidecar')
  const reader = openDb(file, { readonly: true })
  let result: ReturnType<typeof ledgerHealth>
  try { result = ledgerHealth(reader) } finally { reader.raw.close() }
  if (!sidecarsReleased(file)) throw new Error('Read-only reconciliation created a SQLite sidecar')
  return result
}

function isolatedEnvironment() {
  const names = new Set(['path', 'pathext', 'systemroot', 'systemdrive', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir',
    'lang', 'lc_all', 'lc_ctype', 'number_of_processors', 'processor_architecture'])
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => names.has(name.toLowerCase()) && value !== undefined))
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
}
function sanitizedGitForForeground() {
  for (const name of Object.keys(process.env)) {
    if (/^(?:https?_proxy|all_proxy|no_proxy|node_use_env_proxy|dsh_.+)$/i.test(name)) delete process.env[name]
  }
}
async function waitTo(whenMs: number, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted()
    const remaining = whenMs - performance.now()
    if (remaining <= 0) return
    await sleep(remaining, undefined, { signal })
  }
}

async function runWorker(directory: string, launch: Launch) {
  const workerLock = join(directory, 'worker.pid')
  writeFileSync(workerLock, String(process.pid) + '\n', { flag: 'wx', mode: 0o600, flush: true })
  sanitizedGitForForeground()
  const originalHandles = activeResources()
  const timers = observeTimers()
  const dbFile = join(directory, DATABASE)
  const diagnostics = observeSqlite(dbFile)
  const abort = new AbortController()
  const fail = (error: Error) => { if (!abort.signal.aborted) abort.abort(error) }
  let workload: Awaited<ReturnType<typeof startSoakService>> | undefined
  let observer: Awaited<ReturnType<typeof startObserver>> | undefined
  let manifest: Manifest | undefined
  let lastPoint: Point | undefined
  let config = ''
  let caught: string | null = null
  const released: Cleanup = { subscriptionsClosed: false, serviceClosed: false, portReleased: false,
    lockReleased: false, sqliteReleased: false, sidecarsReleased: false, fixtureReleased: false, handlesReleased: false }
  const heartbeat = (runtime: string, reason?: string) => atomicJson(directory, 'heartbeat.json', {
    id: launch.id, pid: process.pid, runtime, latest_slot: lastPoint?.slot ?? 0, wall_ms: Date.now(), reason,
  } satisfies Status)
  const cancel = () => fail(new Error('Worker cancelled; continuous window is invalid'))
  const watchCancel = setInterval(() => {
    if (existsSync(join(directory, cancelName))) cancel()
  }, 200)
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    heartbeat('starting')
    if (existsSync(join(directory, cancelName))) cancel()
    abort.signal.throwIfAborted()
    const git = gitInfo()
    candidateMatches(launch, git)
    const space = assertSpace(directory)
    atomicJson(directory, 'host.json', { platform: process.platform, arch: process.arch, ...space,
      isolatedWorkspace: join(directory, 'workspace'), phase: 'S6', topology: 'one process plus loopback HTTP/SSE; no child executor',
      writer: 'synthetic workflow and probe only', observer: 'read-only SQLite + authenticated panel reads',
      supervision: launch.supervision, fixture: FIXTURE_CONTENT.trim() })
    mkdirSync(join(directory, 'workspace'))
    writeFileSync(join(directory, 'workspace', FIXTURE), FIXTURE_CONTENT, { flag: 'wx', mode: 0o400 })
    mkdirSync(join(directory, 'spill'))
    const baseConfig = JSON.parse(readFileSync(join(ROOT, 'orchestra.config.json'), 'utf8'))
    config = JSON.stringify({ ...baseConfig, phase: 'S6', service: { ...baseConfig.service, db_path: dbFile },
      bridge: { ...baseConfig.bridge, spill_dir: join(directory, 'spill') } }, null, 2) + '\n'
    writeFileSync(join(directory, CONFIG), config, { flag: 'wx', mode: 0o600, flush: true })
    for (const file of ['points.ndjson', 'events.ndjson']) writeFileSync(join(directory, file), '', { flag: 'wx', mode: 0o600 })
    const secret = randomUUID()
    workload = await startSoakService(directory, secret, abort.signal, fail)
    const db = workload.service.orchestra.db
    await workload.load()
    for (let i = 0; i < 3; i++) await workload.run(-i)
    await workload.poll()
    Object.assign(workload.counts, { tasks: 0, runs: 0, nodes: 0, tools: 0, polls: 0 })
    const initialCheckpoint = db.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (initialCheckpoint?.busy !== 0) throw new Error('Initial SQLite checkpoint failed')
    const frameBytes = Number(db.raw.prepare('PRAGMA page_size').get()?.page_size) + 24
    const autoCheckpointFrames = Number(db.raw.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint)
    // One small write transaction may cross the checkpoint boundary by its own frames.
    const walLimitBytes = 32 + frameBytes * (autoCheckpointFrames + 128)
    const baselineHealth = ledgerHealth(db)
    observer = await startObserver(workload.service.endpoint, secret, baselineHealth.head, abort.signal, fail)
    await settle()
    diagnostics.startCommitSampling()
    const startMs = performance.now()
    const startWallMs = Date.now()
    const bootId = workload.service.orchestra.runtime.clock.bootId
    manifest = { schema: 1, id: launch.id, kind: launch.kind, ...git, pid: process.pid, bootId,
      endpoint: workload.service.endpoint, epoch: db.epoch, startMs, startWallMs, slots: launch.slots, slotMs: launch.slotMs,
      walLimitBytes, configHash: sha(config), startedAt: new Date(startWallMs).toISOString(), command: launch.command,
      node: process.version, root: directory, role: workload.role, supervision: launch.supervision }
    atomicJson(directory, 'manifest.json', manifest)
    function point(slot: number, ledger: Point['ledger'], events: SoakEvent[]): Point {
      return {
        slot, dueMs: startMs + slot * launch.slotMs, actualMs: slot === 0 ? startMs : performance.now(),
        wallMs: slot === 0 ? startWallMs : Date.now(), pid: process.pid, bootId: workload!.service.orchestra.runtime.clock.bootId,
        ledger, counts: { ...workload!.counts }, lag: lagStats(events), resources: {
          rssBytes: process.memoryUsage.rss(), dbBytes: diskBytes(dbFile), walBytes: diskBytes(dbFile + '-wal'),
          artifactBytes: spillBytes(join(directory, 'spill')), ...diagnostics.snapshot(),
          subscriptionCount: observer!.active(), fixtureSessions: workload!.sessions.size,
          active: { ...activeResources(), trackedTimers: timers.count() },
          childPids: [], childRssBytes: 0,
        },
      }
    }
    lastPoint = point(0, baselineHealth, [])
    const baselineResources = lastPoint.resources
    appendJson(directory, 'points.ndjson', [lastPoint])
    heartbeat('observing')
    for (let slot = 1; slot <= launch.slots; slot++) {
      const begin = startMs + (slot - 1) * launch.slotMs
      const due = begin + launch.slotMs
      await waitTo(begin + launch.slotMs / 10, abort.signal)
      await workload.run(slot)
      await workload.probe()
      await workload.poll()
      await waitTo(begin + launch.slotMs / 2, abort.signal)
      await workload.poll()
      await waitTo(begin + launch.slotMs * 0.75, abort.signal)
      await workload.poll()
      await waitTo(due, abort.signal)
      await settle()
      assertSpace(directory)
      if (launch.kind === 'formal' && slot % 10 === 0) candidateMatches(launch, gitInfo())
      const health = ledgerHealth(db)
      const rows = await observer.rows(db, lastPoint.ledger.head, health.head, diagnostics, slot)
      const current = point(slot, health, rows)
      appendJson(directory, 'events.ndjson', rows)
      appendJson(directory, 'points.ndjson', [current])
      const prior = lastPoint
      lastPoint = current
      heartbeat('observing')
      if (current.actualMs >= due + Math.min(1_000, launch.slotMs / 4)
        || current.wallMs < prior.wallMs || current.ledger.epoch !== db.epoch || current.bootId !== bootId
        || health.orphanRuns || health.orphanNodes || health.unclosed || health.inFlight || health.foreignKeys
        || health.successes !== health.runs || current.lag.missing || current.lag.maxMs === null
        || current.lag.maxMs > 10_000 || current.lag.p95Ms! > 2_000 || observer.unconsumed()
        || rows.some(row => row.committedMs < begin || row.committedMs >= due) || !rows.some(row => row.type === 's6.soak_probe')
        || current.resources.readConnections || current.resources.writeConnections !== 1 || current.resources.activeStatements
        || current.resources.fixtureSessions || current.resources.walBytes > walLimitBytes
        || Object.entries(current.resources.active).some(([name, count]) => count > (baselineResources.active[name] ?? 0))) {
        throw new Error('Continuous observation failed at sample ' + slot)
      }
    }
    abort.signal.throwIfAborted()

  } catch (error) {
    caught = abort.signal.aborted ? String(abort.signal.reason) : error instanceof Error ? error.message : String(error)
  } finally {
    clearInterval(watchCancel)
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    if (observer) observer.stop()
    released.subscriptionsClosed = observer?.active() === 0
    try {
      if (workload) {
        if (caught) {
          try { await workload.finishInflight() } catch (error) { caught += '\nWorkload stop: ' + String(error) }
        }
        await workload.service.close()
        released.serviceClosed = true
        released.fixtureReleased = workload.sessions.size === 0
        released.portReleased = await assertPortReleased(workload.service.endpoint)
        released.lockReleased = !existsSync(dbFile + '.lock.lock')
        released.sidecarsReleased = sidecarsReleased(dbFile)
      }
      diagnostics.stop()
      released.sqliteReleased = true
      // Undici closes its aborted SSE socket asynchronously.
      const deadline = performance.now() + 1_000
      while (performance.now() < deadline) {
        released.handlesReleased = Object.entries(activeResources()).every(([name, count]) => count <= (originalHandles[name] ?? 0))
        if (released.handlesReleased) break
        await sleep(25)
      }
    } catch (error) { caught ??= error instanceof Error ? error.message : String(error) }
    finally { timers.stop() }
  }

  if (!manifest || !lastPoint) {
    const failure = { schema: 1, run_id: launch.id, run_type: launch.kind, status: 'incomplete', g6Eligible: false,
      errors: [caught ?? 'Worker failed before the observation started'], cleanup: released }
    atomicJson(directory, 'soak-report.json', failure)
    heartbeat('incomplete', failure.errors[0])
    return failure
  }
  let ledger: End['ledger'] = null
  try {
    if (!released.serviceClosed || !released.lockReleased || !released.sqliteReleased || !released.sidecarsReleased) {
      throw new Error('Cannot seal the ledger while its resources are still open')
    }
    sealCheckpoint(dbFile)
    ledger = readFinalLedger(directory)
  } catch (error) { caught ??= String(error) }
  let finalGit = { candidate: '', clean: false }
  try { finalGit = gitInfo() } catch (error) { caught ??= String(error) }
  const end: End = { actualMs: performance.now(), wallMs: Date.now(), ...finalGit, ledger, cleanup: released,
    configHash: sha(readFileSync(join(directory, CONFIG))), error: caught }
  atomicJson(directory, 'end.json', end)
  atomicJson(directory, 'hashes.json', await fileHashes(directory, launch.supervision))
  const report = judgeSoak(manifest, readLines<Point>(directory, 'points.ndjson'), readLines<SoakEvent>(directory, 'events.ndjson'), end)
  atomicJson(directory, 'soak-report.json', report)
  heartbeat(report.status, report.errors[0])
  return report
}

export async function verifyEvidence(input: string) {
  const directory = realpathSync(input)
  const manifest = readJson<Manifest>(directory, 'manifest.json')
  const launch = readJson<Launch>(directory, 'launch.json')
  const end = readJson<End>(directory, 'end.json')
  if (launch.id !== manifest.id || launch.kind !== manifest.kind || launch.slots !== manifest.slots
    || launch.slotMs !== manifest.slotMs || launch.supervision !== manifest.supervision
    || JSON.stringify(launch.command) !== JSON.stringify(manifest.command)
    || (launch.kind === 'formal' && launch.requestedCandidate !== manifest.candidate)) throw new Error('Launch manifest does not match the observation')
  const hashes = readJson<Record<string, string>>(directory, 'hashes.json')
  if (JSON.stringify(await fileHashes(directory, launch.supervision)) !== JSON.stringify(hashes)) throw new Error('Evidence file hashes do not match')
  if (launch.supervision === 'detached') {
    const supervisor = readJson<{ pid: number; startedAt: string }>(directory, 'detached.json')
    if (supervisor.pid !== manifest.pid || supervisor.pid === launch.supervisorPid
      || !Number.isFinite(Date.parse(supervisor.startedAt)) || Date.parse(supervisor.startedAt) > manifest.startWallMs) {
      throw new Error('The detached process does not match the sampling PID')
    }
  }
  if (hashes[CONFIG] !== manifest.configHash) throw new Error('Configuration hash does not match manifest')
  if (manifest.kind === 'formal') assertFormalSoakArchive(name => readFileSync(evidenceFile(directory, name)), manifest)
  const events = readLines<SoakEvent>(directory, 'events.ndjson')
  const points = readLines<Point>(directory, 'points.ndjson')
  const ledger = readFinalLedger(directory)
  if (JSON.stringify(ledger) !== JSON.stringify(end.ledger)) throw new Error('Endpoint ledger does not match')
  if (events.length) {
    // Read-only, paged verification across the sealed SQLite database.
    const reader = openDb(join(directory, DATABASE), { readonly: true })
    try {
      const result = reader.raw.prepare('PRAGMA integrity_check').get()
      if (result?.integrity_check !== 'ok') throw new Error('Sealed SQLite integrity check failed')
      const statement = reader.raw.prepare('SELECT seq, event_id, type FROM events WHERE seq=?')
      for (const event of events) {
        const row = statement.get(event.seq)
        if (!row || row.event_id !== event.event_id || row.type !== event.type) throw new Error('Sealed event mismatch at ' + event.seq)
      }
    } finally { reader.raw.close() }
  }
  const report = judgeSoak(manifest, points, events, end)
  if (JSON.stringify(report) !== JSON.stringify(readJson(directory, 'soak-report.json'))) throw new Error('Recomputed report differs from stored report')
  return report
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
function print(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n') }
function passed(status: string) { return status === 'passed' || status === 'short-complete' }

async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(HELP + '\n'); return }
  const options = parseSoakArguments(args)
  const { directory } = options
  if (options.mode === 'verify') {
    const report = await verifyEvidence(directory)
    print(report)
    if (!passed(report.status)) process.exitCode = 1
    return
  }
  if (options.mode === 'cancel') {
    if (!existsSync(join(directory, 'launch.json')) || existsSync(join(directory, 'end.json'))
      || existsSync(join(directory, 'soak-report.json'))) throw new Error('No cancellable worker in this evidence directory')
    writeFileSync(join(directory, cancelName), new Date().toISOString() + '\n', { flag: 'wx', mode: 0o600, flush: true })
    print({ cancellation_requested: directory })
    return
  }
  if (options.mode === 'status') {
    const launch = readJson<Launch>(directory, 'launch.json')
    const manifest = existsSync(join(directory, 'manifest.json')) ? readJson<Manifest>(directory, 'manifest.json') : null
    const status = existsSync(join(directory, 'heartbeat.json')) ? readJson<Status>(directory, 'heartbeat.json') : null
    const handoff = existsSync(join(directory, 'detached.json')) ? readJson<{ pid: number }>(directory, 'detached.json') : null
    const pid = status?.pid ?? handoff?.pid
    const active = pid ? alive(pid) : false
    const heartbeatStale = status && active && Date.now() - status.wall_ms > Math.max(15_000, launch.slotMs * 2)
    print({ ...launch, manifest, heartbeat: status, pid, active,
      state: status && ['failed', 'passed', 'short-complete', 'incomplete'].includes(status.runtime) ? status.runtime
        : active ? heartbeatStale ? 'stale' : status?.runtime ?? 'starting' : 'incomplete',
      evidence_directory: directory })
    return
  }
  if (options.mode === 'worker') {
    const launch = readJson<Launch>(directory, 'launch.json')
    const validWindow = launch.kind === 'formal'
      ? launch.slotMs === FORMAL_SLOT_MS && launch.slots * launch.slotMs === FORMAL_DURATION_MS
      : launch.kind === 'short' && Number.isSafeInteger(launch.slots) && launch.slots >= 1 && launch.slots <= 30
        && Number.isSafeInteger(launch.slotMs) && launch.slotMs >= 1_000 && launch.slotMs <= 30_000
    if (launch.id !== options.runId || launch.supervision !== 'detached' || !validWindow) throw new Error('Invalid worker launch reservation')
    const report = await runWorker(realpathSync(directory), launch)
    if (!passed(report.status)) process.exitCode = 1
    return
  }
  const launch: Launch = { schema: 1, id: randomUUID(), kind: options.kind, requestedCandidate: options.candidate,
    slots: options.slots, slotMs: options.slotMs, command: [process.execPath, ...process.execArgv, SCRIPT, ...args],
    supervisorPid: process.pid, supervision: options.detached ? 'detached' : 'foreground', requestedAt: new Date().toISOString() }
  candidateMatches(launch, gitInfo())
  mkdirSync(dirname(directory), { recursive: true })
  mkdirSync(directory, { mode: 0o700 })
  const root = realpathSync(directory)
  atomicJson(root, 'launch.json', launch)
  if (launch.supervision === 'detached') {
    candidateMatches(launch, gitInfo())
    const child = spawn(process.execPath, ['--no-warnings', SCRIPT, '--worker', launch.id, '--evidence-dir', root],
      { detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT, env: isolatedEnvironment() })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    atomicJson(root, 'detached.json', { pid: child.pid, startedAt: new Date().toISOString(), command: child.spawnargs })
    child.unref()
    print({ id: launch.id, pid: child.pid, evidence_directory: root, supervision: launch.supervision, state: 'started' })
    return
  }
  const report = await runWorker(root, launch)
  print(report)
  if (!passed(report.status)) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch(error => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 1
  })
}
