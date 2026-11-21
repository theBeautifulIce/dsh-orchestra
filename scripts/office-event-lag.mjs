import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const [sourceDir, revision, outputDir] = process.argv.slice(2)
if (!sourceDir || !revision || !outputDir) {
  throw new Error('Usage: node scripts/office-event-lag.mjs <clean-worktree> <candidate-sha> <output-directory>')
}
const source = resolve(sourceDir)
const output = resolve(outputDir)
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim()
const requireCandidate = () => {
  assert.match(revision, /^[a-f0-9]{40}$/)
  assert.equal(git('rev-parse', 'HEAD'), revision)
  assert.equal(git('status', '--porcelain', '--untracked-files=normal'), '')
}
requireCandidate()
const load = relative => import(pathToFileURL(join(source, relative)).href)
const [
  { CONFIG, DATABASE, FIXTURE, FIXTURE_CONTENT, startObserver, startSoakService, assertPortReleased },
  { observeSqlite },
  { summarizeLag },
  { createG6FileEvidenceReader, OFFICE_LAG_SCHEMA, OFFICE_LAG_ORIGINALS, OFFICE_LAG_WINDOW },
] = await Promise.all([
  load('scripts/soak-workload.ts'), load('src/infra/sqlite/driver.ts'),
  load('scripts/event-lag.ts'), load('scripts/g6-file-evidence.ts'),
])

mkdirSync(output, { recursive: true })
mkdirSync(join(output, 'workspace'))
mkdirSync(join(output, 'spill'))
writeFileSync(join(output, 'workspace', FIXTURE), FIXTURE_CONTENT, { flag: 'wx' })
const config = JSON.parse(readFileSync(join(source, 'orchestra.config.json'), 'utf8'))
const dbFile = join(output, DATABASE)
writeFileSync(join(output, CONFIG), JSON.stringify({
  ...config, phase: 'S6', service: { ...config.service, db_path: dbFile },
  bridge: { ...config.bridge, spill_dir: join(output, 'spill') },
}), { flag: 'wx' })
const abort = new AbortController()
const fail = error => abort.abort(error)
const diagnostics = observeSqlite(dbFile)
const secret = randomUUID()
let workload
let observer
let closed = false
const probeSequences = []
const { slots, slotMs } = OFFICE_LAG_WINDOW
const measurement = randomUUID()
const evidenceIdentity = { schema: OFFICE_LAG_SCHEMA, candidate: revision, measurement }
const maxSeq = db => Number(db.raw.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq)
const writeJson = (name, data) =>
  writeFileSync(join(output, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })
const waitTo = target => sleep(Math.max(0, target - performance.now()), undefined, { signal: abort.signal })
try {
  workload = await startSoakService(output, secret, abort.signal, fail)
  const { db } = workload.service.orchestra
  await workload.load()
  await workload.run(-1)
  await workload.poll()
  const baselineSeq = maxSeq(db)
  observer = await startObserver(workload.service.endpoint, secret, baselineSeq, abort.signal, fail)
  diagnostics.startCommitSampling()
  const startedAt = new Date().toISOString()
  const startMs = performance.now()
  const window = { startMs, ...OFFICE_LAG_WINDOW }
  writeJson('launch.json', { ...evidenceIdentity, clean: true, startedAt, window, baselineSeq, platform: process.platform,
    clock: 'performance.now(), SQLite commit and authenticated loopback SSE in the same process',
    traffic: 'one real probe per slot with a synthetic read-only workflow every 3 slices' })
  for (let slot = 0; slot < slots; slot++) {
    const slotStart = startMs + slot * slotMs
    await waitTo(slotStart + 50)
    if (slot > 0 && slot % 36 === 0) {
      requireCandidate()
      await workload.run(slot)
      await workload.poll()
    }
    const beforeProbe = maxSeq(db)
    await workload.probe()
    const seq = maxSeq(db)
    assert.equal(seq, beforeProbe + 1)
    probeSequences.push(seq)
  }
  const boundary = startMs + slots * slotMs
  await waitTo(boundary + 25)
  const throughSeq = maxSeq(db)
  const deliveryDeadline = boundary + 10_000
  // Allow late deliveries to be timed against their own commits, even after their sampling slot.
  while (observer.unconsumed() < throughSeq - baselineSeq && performance.now() < deliveryDeadline) {
    await waitTo(Math.min(deliveryDeadline, performance.now() + 50))
  }
  const completedMs = performance.now()
  const completedAt = new Date().toISOString()
  const elapsedMs = completedMs - startMs
  abort.signal.throwIfAborted()
  requireCandidate()
  const emitted = (await observer.rows(db, baselineSeq, throughSeq, diagnostics, 0))
    .map(row => ({ ...row, slot: Math.floor((row.committedMs - startMs) / slotMs) }))
  const bySequence = new Map(emitted.map(row => [row.seq, row]))
  const observations = probeSequences.map(seq => {
    const probe = bySequence.get(seq)
    assert.equal(probe?.type, 's6.soak_probe')
    const { slot, committedMs, observedMs } = probe
    return { slot, seq, committedMs, observedMs }
  })
  writeFileSync(join(output, 'events.ndjson'), emitted.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' })
  writeJson('lag-samples.json', { ...evidenceIdentity, clean: true, window, observations })
  observer.stop()
  observer = undefined
  await workload.service.close()
  closed = true
  diagnostics.stop()
  const portReleased = await assertPortReleased(workload.service.endpoint)
  assert.ok(portReleased)
  // Seal a self-contained database after the production service and WAL writer have closed.
  const archive = new DatabaseSync(dbFile)
  try {
    assert.equal(archive.prepare('PRAGMA journal_mode=DELETE').get().journal_mode, 'delete')
  } finally {
    archive.close()
  }
  const originals = new Map(OFFICE_LAG_ORIGINALS.map(name => [name, readFileSync(join(output, name))]))
  writeJson('end.json', { ...evidenceIdentity, portReleased, completedAt, completedMs, elapsedMs, throughSeq,
    originals: Object.fromEntries([...originals].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])) })
  originals.set('end.json', readFileSync(join(output, 'end.json')))
  const gateReader = createG6FileEvidenceReader(() => undefined)
  const evaluated = await gateReader.observe({ id: 'event_lag', candidate: { git_sha: revision },
    evidence: [...originals].map(([name, bytes]) => ({ entry: { file: 'lag/' + name }, bytes })) })
  const audited = emitted.length
  const result = summarizeLag(observations, window)
  writeJson('report.json', { candidate: revision, startedAt, endedAt: new Date().toISOString(), elapsedMs,
    portReleased, audited, workloads: workload.counts, result, evaluated })
  assert.equal(evaluated?.kind, 'event_lag', 'Office lag originals did not meet the gate')
  console.log(JSON.stringify({ candidate: revision, samples: slots, elapsedMs, audited, ...evaluated.windows[0] }))
} finally {
  observer?.stop()
  if (workload && !closed) await workload.service.close()
  diagnostics.stop()
}
