import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { openDb } from '../src/infra/sqlite/driver.ts'
import { verifyLedgerSnapshot } from '../src/service/queries/verify_ledger.ts'
import { evidenceFile, sealCheckpoint } from './fault-reconcile.ts'
import { loadUpgradeBuild } from './upgrade-host.ts'
import { assertPortReleased, CONFIG, DATABASE, FIXTURE, FIXTURE_CONTENT, sidecarsReleased, startSoakService } from './soak-workload.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const intervalMs = 60_000
const durationMs = 72 * 60 * 60 * 1000
const hash = /^[a-f0-9]{64}$/
const commit = /^[a-f0-9]{40}$/
const cancellation = 'cancel.request'
export const R0_ORIGINALS = ['launch.json', 'worker.json', 'samples.ndjson', 'end.json', DATABASE, CONFIG, 'workspace/' + FIXTURE] as const

type Launch = {
  schema: 1; id: string; kind: 'formal' | 'short'; candidate: string; archive: string | null; archiveSha256: string | null
  directory: string; interval_ms: number; slots: number; requested_utc: string
}
type Worker = { id: string; pid: number; started_utc: string; node: string }
type Sample = {
  slot: number; pid: number; boot_id: string; epoch: number; utc: string; monotonic_ms: number
  head: number; run_id: string | null; node_run_id: string | null; trial_since: string
}
type End = {
  id: string; status: 'complete' | 'failed' | 'interrupted'; error: string | null; utc: string; prior_sha256?: Record<string, string>
  synthetic_ledger_key?: string
}
const readJson = <T>(directory: string, file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8')) as T
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const utcMs = (utc: string) => Date.parse(utc)

function gitState() {
  const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8' }).trim()
  return { candidate: git('rev-parse', 'HEAD'), clean: !git('status', '--porcelain=v1', '--untracked-files=all') }
}
function assertCandidate(launch: Launch) {
  if (launch.kind === 'formal') {
    const state = gitState()
    assert(state.clean && state.candidate === launch.candidate, 'Formal R0 requires the exact frozen clean candidate')
  }
}
function assertIsolatedDirectory(directory: string) {
  const tmp = resolve(root, 'tmp')
  mkdirSync(tmp, { recursive: true })
  const offset = relative(tmp, directory)
  assert(offset && !offset.startsWith('..') && !isAbsolute(offset), 'R0 directory must be a new path under this worktree tmp')
  for (let path = directory; ; path = dirname(path)) {
    assert(!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink(), 'R0 rejects linked directories')
    if (path === tmp) break
  }
  assert.equal(realpathSync(tmp), tmp, 'R0 tmp must resolve to itself')
}
function atomic(directory: string, file: string, value: unknown) {
  const path = join(directory, file)
  assert(!existsSync(path), 'R0 original already exists: ' + file)
  const staging = path + '.' + randomUUID() + '.partial'
  writeFileSync(staging, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true })
  renameSync(staging, path)
}
const originalHash = (directory: string, file: string) => sha(readFileSync(evidenceFile(directory, file)))
function samples(directory: string, allowPartial = false) {
  const content = readFileSync(join(directory, 'samples.ndjson'), 'utf8')
  assert(allowPartial || content === '' || content.endsWith('\n'), 'Partial R0 sample')
  return content.split('\n').slice(0, -1).map((line) => JSON.parse(line) as Sample)
}
function assertPoint(launch: Launch, baseline: Sample, prior: Sample, current: Sample) {
  const tolerance = Math.min(5_000, launch.interval_ms / 2)
  assert(current.slot === prior.slot + 1 && current.pid === baseline.pid && current.boot_id === baseline.boot_id
    && current.epoch === baseline.epoch && current.trial_since === baseline.trial_since, 'R0 sample or service continuity broke')
  const elapsed = current.monotonic_ms - baseline.monotonic_ms
  const wall = utcMs(current.utc) - utcMs(baseline.utc)
  assert(elapsed >= current.slot * launch.interval_ms && elapsed <= current.slot * launch.interval_ms + tolerance
    && current.monotonic_ms > prior.monotonic_ms && current.monotonic_ms - prior.monotonic_ms <= launch.interval_ms + tolerance
    && utcMs(current.utc) > utcMs(prior.utc) && utcMs(current.utc) - utcMs(prior.utc) <= launch.interval_ms + tolerance
    && Math.abs(wall - elapsed) <= tolerance && current.head > prior.head && current.run_id && current.node_run_id,
  'R0 sample missed its monotonic/UTC interval or made no durable progress')
}

export function verifyR0Observation(directory: string, expected?: { candidate: string; archiveSha256: string }) {
  directory = realpathSync(directory)
  for (const file of R0_ORIGINALS) evidenceFile(directory, file)
  const launch = readJson<Launch>(directory, 'launch.json')
  const worker = readJson<Worker>(directory, 'worker.json')
  const end = readJson<End>(directory, 'end.json')
  assert(launch.schema === 1 && commit.test(launch.candidate) && end.status === 'complete' && end.error === null
    && end.id === launch.id && worker.id === launch.id && end.synthetic_ledger_key && end.prior_sha256, 'R0 window did not complete')
  if (launch.kind === 'formal') {
    assert(launch.slots * launch.interval_ms === durationMs && launch.interval_ms === intervalMs && launch.archiveSha256
      && hash.test(launch.archiveSha256), 'Invalid formal R0 plan')
  } else {
    assert(launch.kind === 'short' && launch.archive === null && launch.archiveSha256 === null
      && launch.slots >= 2 && launch.slots <= 30 && launch.interval_ms >= 500 && launch.interval_ms <= 30_000, 'Invalid R0 short plan')
  }
  if (expected) assert(launch.kind === 'formal' && launch.candidate === expected.candidate
    && launch.archiveSha256 === expected.archiveSha256, 'R0 does not bind the required frozen candidate and archive')
  for (const file of R0_ORIGINALS) {
    if (file !== 'end.json') assert.equal(originalHash(directory, file), end.prior_sha256[file], 'R0 original changed: ' + file)
  }
  const normalized = (path: string) => path.replace(/\\/g, '/')
  const originalRoot = normalized(launch.directory)
  const configuration = readJson<{ phase: string; service: { db_path: string }; bridge: { spill_dir: string } }>(directory, CONFIG)
  assert(/^(?:[a-z]:)?\//i.test(originalRoot) && configuration.phase === 'S6'
    && normalized(configuration.service.db_path) === originalRoot + '/' + DATABASE
    && normalized(configuration.bridge.spill_dir) === originalRoot + '/spill'
    && readFileSync(join(directory, 'workspace', FIXTURE), 'utf8') === FIXTURE_CONTENT, 'R0 workspace or fixture was not isolated')
  const points = samples(directory)
  const first = points[0]!
  const last = points.at(-1)!
  assert(points.length === launch.slots + 1 && first.slot === 0 && first.pid === worker.pid && first.run_id === null
    && first.node_run_id === null && first.head > 0 && utcMs(first.trial_since) <= utcMs(first.utc)
    && Number.isFinite(first.monotonic_ms) && first.monotonic_ms > 0 && first.boot_id && Number.isSafeInteger(first.epoch) && first.epoch > 0
    && utcMs(launch.requested_utc) <= utcMs(worker.started_utc) && utcMs(worker.started_utc) <= utcMs(first.trial_since)
    && utcMs(end.utc) >= utcMs(last.utc), 'R0 sample coverage or manifest binding is incomplete')
  for (let i = 1; i < points.length; i++) assertPoint(launch, first, points[i - 1]!, points[i]!)
  const elapsed = last.monotonic_ms - first.monotonic_ms
  const wall = utcMs(last.utc) - utcMs(first.utc)
  assert(elapsed >= launch.slots * launch.interval_ms && wall >= launch.slots * launch.interval_ms, 'R0 actual observation window was too short')
  const ledgerPath = join(directory, DATABASE)
  assert(sidecarsReleased(ledgerPath), 'R0 ledger was not fully shut down')
  const db = openDb(ledgerPath, { readonly: true })
  try {
    assert.equal(db.epoch, first.epoch, 'R0 writer epoch changed')
    const ledger = verifyLedgerSnapshot(db, end.synthetic_ledger_key)
    assert(ledger.item.valid && ledger.as_of_seq === last.head, 'R0 ledger failed replay')
    const rows = db.raw.prepare("SELECT seq,payload_redacted FROM events WHERE type='release.trial_circle'").all()
    assert(rows.length === 1 && Number(rows[0]!.seq) <= first.head, 'R0 ledger did not keep its initial trial revision')
    const state = JSON.parse(String(rows[0]!.payload_redacted))
    assert(state.circle === 'R0' && state.revision === 1 && state.halted === false && state.candidate === launch.candidate
      && state.since === first.trial_since && state.evidence_id === 'synthetic-workspace-bound', 'R0 trial binding changed')
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n, launch.slots)
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM tool_executions').get()?.n, launch.slots)
    const verifyRun = db.raw.prepare("SELECT e.seq FROM runs r JOIN node_runs n USING (run_id)"
      + " JOIN tool_executions t USING (node_run_id) JOIN events e ON e.run_id=r.run_id AND e.type='run.terminal'"
      + " WHERE r.run_id=? AND n.node_run_id=? AND r.status='succeeded' AND r.workflow_id='s6_soak_read' AND r.workflow_version=1"
      + " AND n.node_type='agent' AND n.status='done' AND n.side_effect_policy='pure' AND t.tool='soak.fixture.read' AND t.exit_code=0")
    for (let i = 1; i < points.length; i++) {
      const point = points[i]!
      const terminal = verifyRun.all(point.run_id, point.node_run_id)
      assert(terminal.length === 1 && Number(terminal[0]!.seq) > points[i - 1]!.head && Number(terminal[0]!.seq) <= point.head,
        'R0 sample disagrees with the read-only run and its terminal event')
    }
  } finally { db.raw.close() }
  assert(sidecarsReleased(ledgerPath), 'R0 verifier altered SQLite sidecars')
  return { conclusion: launch.kind === 'formal' ? 'continuous_72h_machine_observation' : 'development_short_observation',
    circle: 'R0', candidate: launch.candidate, archive_sha256: launch.archiveSha256, workspace_id: launch.id,
    workspace_root: join(launch.directory, 'workspace'), pid: worker.pid, from_utc: first.utc, to_utc: last.utc,
    wall_ms: wall, monotonic_ms: elapsed, sampled_runs: launch.slots, initial_head: first.head, final_head: last.head,
    human_assessment_required: true }
}

async function runWorker(directory: string, id: string) {
  assertIsolatedDirectory(directory)
  const launch = readJson<Launch>(directory, 'launch.json')
  assert(launch.id === id && launch.directory === directory, 'R0 launch identity mismatch')
  atomic(directory, 'worker.json', { id, pid: process.pid, started_utc: new Date().toISOString(), node: process.version } satisfies Worker)
  const abort = new AbortController()
  const fail = (error: Error) => { if (!abort.signal.aborted) abort.abort(error) }
  let interrupted = false
  const cancel = () => { interrupted = true; fail(new Error('R0 observation interrupted')) }
  const timer = setInterval(() => { if (existsSync(join(directory, cancellation))) cancel() }, 250)
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  const secret = randomUUID()
  let workload: Awaited<ReturnType<typeof startSoakService>> | undefined
  let error: string | null = null
  try {
    assertCandidate(launch)
    if (existsSync(join(directory, cancellation))) cancel()
    abort.signal.throwIfAborted()
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    mkdirSync(join(directory, 'spill'))
    writeFileSync(join(workspace, FIXTURE), FIXTURE_CONTENT, { flag: 'wx', mode: 0o400, flush: true })
    const config = readJson<Record<string, unknown>>(root, 'orchestra.config.json')
    writeFileSync(join(directory, CONFIG), JSON.stringify({ ...config, phase: 'S6',
      service: { ...(config.service as object), db_path: join(directory, DATABASE) },
      bridge: { ...(config.bridge as object), spill_dir: join(directory, 'spill') },
    }) + '\n', { flag: 'wx', flush: true })
    const serve = launch.archive && launch.archiveSha256
      ? (await loadUpgradeBuild({ archive: launch.archive, sha256: launch.archiveSha256 }, join(directory, 'package-build'), false)).module.serveOrchestra
      : undefined
    workload = await startSoakService(directory, secret, abort.signal, fail, {
      ...(serve ? { serve } : {}), trial: { candidate: launch.candidate, workspace: { id, root: workspace, kind: 'synthetic' },
        authorize: () => null, authenticateOperator: () => null },
    })
    const service = workload.service
    assert.equal(new URL(service.endpoint).hostname, '127.0.0.1')
    await workload.load()
    function point(slot: number, run: Awaited<ReturnType<NonNullable<typeof workload>['run']>> | null): Sample {
      const trial = service.orchestra.trial?.get()
      assert(trial?.circle === 'R0' && trial.candidate === launch.candidate && trial.revision === 1 && !trial.halted, 'Expected the original synthetic R0 trial')
      const db = service.orchestra.db
      return { slot, pid: process.pid, epoch: db.epoch, boot_id: service.orchestra.runtime.clock.bootId, utc: new Date().toISOString(),
        monotonic_ms: performance.now(), head: Number(db.raw.prepare('SELECT MAX(seq) AS seq FROM events').get()?.seq),
        run_id: run?.runId ?? null, node_run_id: run?.nodeRunId ?? null, trial_since: trial.since }
    }
    function record(value: Sample) { appendFileSync(join(directory, 'samples.ndjson'), JSON.stringify(value) + '\n', { flush: true }) }
    const first = point(0, null)
    let prior = first
    record(first)
    for (let slot = 1; slot <= launch.slots; slot++) {
      const due = first.monotonic_ms + slot * launch.interval_ms
      while (performance.now() < due) await delay(Math.ceil(due - performance.now()), undefined, { signal: abort.signal })
      abort.signal.throwIfAborted()
      if (performance.now() > due + Math.min(5_000, launch.interval_ms / 2)) throw new Error('R0 sample deadline was missed')
      assertCandidate(launch)
      const current = point(slot, await workload.run(slot))
      assertPoint(launch, first, prior, current)
      record(current)
      prior = current
    }
    assertCandidate(launch)
    if (launch.archive) assert.equal(sha(readFileSync(launch.archive)), launch.archiveSha256)
    abort.signal.throwIfAborted()
  } catch (caught) { error = String(abort.signal.reason ?? caught) }
  finally {
    clearInterval(timer)
    process.off('SIGTERM', cancel)
    process.off('SIGINT', cancel)
    try {
      if (workload) {
        const { service } = workload
        await service.close()
        assert(await assertPortReleased(service.endpoint) && sidecarsReleased(join(directory, DATABASE)), 'R0 service did not release its resources')
        if (!error && !abort.signal.aborted) sealCheckpoint(join(directory, DATABASE))
      }
    } catch (caught) { error ??= String(caught) }
  }
  if (abort.signal.aborted) error ??= String(abort.signal.reason)
  let originalHashes: Record<string, string> | undefined
  if (!error && !interrupted) {
    try {
      originalHashes = Object.fromEntries(R0_ORIGINALS.filter((file) => file !== 'end.json').map((file) => [file, originalHash(directory, file)]))
    } catch (caught) { error = String(caught) }
  }
  const end: End = { id, utc: new Date().toISOString(), status: interrupted ? 'interrupted' : error ? 'failed' : 'complete', error,
    ...(originalHashes ? { prior_sha256: originalHashes, synthetic_ledger_key: secret } : {}) }
  atomic(directory, 'end.json', end)
  if (end.status !== 'complete') process.exitCode = 1
}

function workerEnvironment() {
  const keys = /^(path|pathext|systemroot|systemdrive|windir|comspec|temp|tmp|tmpdir|lang|lc_all|lc_ctype)$/i
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.test(key)))
}
function status(directory: string) {
  const launch = readJson<Launch>(directory, 'launch.json')
  if (existsSync(join(directory, 'end.json'))) {
    const end = readJson<End>(directory, 'end.json')
    return { id: end.id, status: end.status, utc: end.utc, error: end.error }
  }
  if (!existsSync(join(directory, 'worker.json'))) {
    return { status: Date.now() - utcMs(launch.requested_utc) <= 60_000 ? 'starting' : 'interrupted', id: launch.id, pid: null }
  }
  const worker = readJson<Worker>(directory, 'worker.json')
  const point = existsSync(join(directory, 'samples.ndjson')) ? samples(directory, true).at(-1) : undefined
  let alive = true
  try { process.kill(worker.pid, 0) } catch { alive = false }
  const fresh = Date.now() - utcMs(point?.utc ?? worker.started_utc) <= Math.max(60_000, launch.interval_ms + 15_000)
  return { status: alive && fresh ? (point ? 'observing' : 'starting') : 'interrupted', ...worker, latest_sample: point ?? null }
}

const help = [
  'node --no-warnings scripts/r0-observe.ts launch <new-tmp-directory> <clean-C> <candidate.tgz> <sha256>',
  'node --no-warnings scripts/r0-observe.ts short <new-tmp-directory> [interval-ms=1000] [samples=3]',
  'node --no-warnings scripts/r0-observe.ts status|cancel|verify <run-directory>',
].join('\n')

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, path, ...args] = process.argv.slice(2)
    if (command === '--help') console.log(help)
    else {
      assert(path, help)
      const directory = resolve(root, path)
      if (command === 'verify' && args.length === 0) console.log(JSON.stringify(verifyR0Observation(directory), null, 2))
      else if (command === 'status' && args.length === 0) console.log(JSON.stringify(status(directory), null, 2))
      else if (command === 'cancel' && args.length === 0) {
        assertIsolatedDirectory(directory)
        assert(['starting', 'observing'].includes(status(directory).status), 'Only an active R0 observation can be cancelled')
        writeFileSync(join(directory, cancellation), new Date().toISOString() + '\n', { flag: 'wx', flush: true })
      } else if (command === 'worker' && args.length === 1) await runWorker(directory, args[0]!)
      else {
        assert(command === 'launch' || command === 'short', help)
        assertIsolatedDirectory(directory)
        const id = randomUUID()
        const common = { schema: 1 as const, id, directory, requested_utc: new Date().toISOString() }
        let launch: Launch
        if (command === 'launch') {
          const [candidate, path, archiveSha256] = args
          assert(args.length === 3 && candidate && commit.test(candidate) && path && archiveSha256 && hash.test(archiveSha256), help)
          launch = { ...common, kind: 'formal', candidate, archive: realpathSync(resolve(root, path)), archiveSha256,
            slots: durationMs / intervalMs, interval_ms: intervalMs }
          assertCandidate(launch)
          assert.equal(sha(readFileSync(launch.archive!)), archiveSha256, 'R0 candidate archive SHA256 mismatch')
        } else {
          const interval = Number(args[0] ?? 1000)
          const slots = Number(args[1] ?? 3)
          assert(args.length <= 2 && Number.isInteger(interval) && interval >= 500 && interval <= 30_000
            && Number.isInteger(slots) && slots >= 2 && slots <= 30, 'Invalid short R0 observation')
          launch = { ...common, kind: 'short', candidate: gitState().candidate, archive: null, archiveSha256: null,
            slots, interval_ms: interval }
        }
        assert(!existsSync(directory), 'R0 observation directory already exists')
        mkdirSync(directory, { recursive: true })
        atomic(directory, 'launch.json', launch)
        const log = openSync(join(directory, 'worker.log'), 'wx')
        try {
          const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), 'worker', directory, id], {
            cwd: directory, detached: true, windowsHide: true, stdio: ['ignore', log, log], env: workerEnvironment(),
          })
          await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
          child.unref()
          console.log(JSON.stringify({ id, pid: child.pid, directory, status: 'starting' }))
        } finally { closeSync(log) }
      }
    }
  } catch (error) { console.error(String(error)); process.exitCode = 1 }
}
