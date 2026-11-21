import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
  { observeSqlite, openDb },
  { summarizeLag },
  { createG6FileEvidenceReader },
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
let audited
let portReleased
const observations = []
const emitted = []
const slots = 120
const slotMs = 5_000
const slotsPerSlice = 12
const maxSeq = db => Number(db.raw.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq)
const writeJson = (name, data) =>
  writeFileSync(join(output, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })
const waitTo = target => sleep(Math.max(0, target - performance.now()), undefined, { signal: abort.signal })
let startedAt
let elapsedMs
let window
try {
  workload = await startSoakService(output, secret, abort.signal, fail)
  const { db } = workload.service.orchestra
  await workload.load()
  await workload.run(-1)
  await workload.poll()
  let previous = maxSeq(db)
  observer = await startObserver(workload.service.endpoint, secret, previous, abort.signal, fail)
  diagnostics.startCommitSampling()
  startedAt = new Date().toISOString()
  const startMs = performance.now()
  window = { startMs, slotMs, slots, slotsPerSlice }
  writeJson('launch.json', { candidate: revision, clean: true, startedAt, window, platform: process.platform,
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
    await waitTo(slotStart + slotMs - 100)
    const through = maxSeq(db)
    const entries = await observer.rows(db, previous, through, diagnostics, slot)
    for (const entry of entries) {
      assert.notEqual(entry.observedMs, null, 'SSE missed a ledger entry')
      emitted.push(entry)
    }
    const probe = entries.find(entry => entry.seq === seq)
    assert.equal(probe?.type, 's6.soak_probe')
    observations.push({ slot, seq, committedMs: probe.committedMs, observedMs: probe.observedMs })
    appendFileSync(join(output, 'events.ndjson'), entries.map(row => JSON.stringify(row)).join('\n') + '\n')
    previous = through
  }
  await waitTo(startMs + slots * slotMs + 25)
  elapsedMs = performance.now() - startMs
  abort.signal.throwIfAborted()
  requireCandidate()
  assert.ok(elapsedMs >= 600_000)
  observer.stop()
  observer = undefined
  await workload.service.close()
  diagnostics.stop()
  portReleased = await assertPortReleased(workload.service.endpoint)
  assert.ok(portReleased)
  const reader = openDb(dbFile, { readonly: true })
  try {
    const rows = reader.raw.prepare('SELECT seq,event_id,type FROM events WHERE seq>=? AND seq<=? ORDER BY seq')
      .all(emitted[0].seq, emitted.at(-1).seq)
    assert.deepEqual(rows.map(row => [Number(row.seq), row.event_id, row.type]),
      emitted.map(row => [row.seq, row.event_id, row.type]))
    audited = rows.length
  } finally {
    reader.raw.close()
  }
  const result = summarizeLag(observations, window)
  assert.ok(result.passed, JSON.stringify(result))
  const evidence = { candidate: revision, clean: true, window, observations }
  const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + '\n')
  const gateReader = createG6FileEvidenceReader(() => undefined)
  const evaluated = await gateReader.observe({ id: 'event_lag', candidate: { git_sha: revision }, evidence: [
    { entry: { file: 'lag/lag-samples.json' }, bytes },
  ] })
  assert.equal(evaluated.kind, 'event_lag')
  assert.equal(evaluated.windows.length, 11)
  writeFileSync(join(output, 'lag-samples.json'), bytes, { flag: 'wx' })
  writeJson('report.json', { candidate: revision, startedAt, endedAt: new Date().toISOString(), elapsedMs,
    portReleased, audited, workloads: workload.counts, result, evaluated })
  console.log(JSON.stringify({ candidate: revision, samples: slots, elapsedMs, audited, ...result.full }))
} finally {
  observer?.stop()
  if (workload && portReleased === undefined) await workload.service.close()
  diagnostics.stop()
}
