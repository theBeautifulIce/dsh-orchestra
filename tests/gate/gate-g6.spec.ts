import { expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../../src/core/canonical.ts'
import { releaseHash } from '../../src/core/wf-release-v1.ts'
import { createG6FileEvidenceReader, OFFICE_LAG_ORIGINALS, OFFICE_LAG_SCHEMA, OFFICE_LAG_WINDOW, withG6Scratch } from '../../scripts/g6-file-evidence.ts'
import { assertFormalSoakArchive, FORMAL_SOAK_ARCHIVE } from '../../scripts/soak-archive.ts'
import type { Manifest } from '../../scripts/soak-judge.ts'
import { assertG6Body, assertG5History, assertG6R0Evidence, authenticateG6Proof, g6Body, signG6, verifyG6 } from '../../scripts/gate-g6.ts'
import { R0_ORIGINALS } from '../../scripts/r0-observe.ts'

it('binds the authorized role, signer and exact approval payload', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const payload = { candidate_commit: '1'.repeat(40), principal: 'human:fixture-owner', evidence_hash: '2'.repeat(64) }
  const proofHash = releaseHash({ domain: 'dsh-orchestra/g6', role: 'approval', key: 'fixture-owner', payload })
  const proof = { key: 'fixture-owner', payload, signature: sign(null, Buffer.from(proofHash, 'hex'), privateKey).toString('base64') }
  const trust = [{ key: proof.key, principal: payload.principal, role: 'approval' as const, public_key: publicKey.export({ type: 'spki', format: 'pem' }) as string }]
  expect(authenticateG6Proof(proof, 'approval', trust).principal).toBe(payload.principal)
  expect(() => authenticateG6Proof(proof, 'audit', trust)).toThrow(/没有授权/)
  expect(() => authenticateG6Proof({ ...proof, payload: { ...payload, evidence_hash: '3'.repeat(64) } }, 'approval', trust)).toThrow(/原件不符/)
  expect(() => authenticateG6Proof({ ...proof, key: 'fake' }, 'approval', trust)).toThrow(/没有授权/)
})

it('freezes both artifact anchors and all text before the appendices', () => {
  const values = { candidate: '1'.repeat(40), audit: '2'.repeat(40), auditSha: '3'.repeat(64),
    evidence: '9'.repeat(40), approver: 'human:fixture', approval: '2026-11-20T08:00:00.000Z',
    independentHash: '4'.repeat(64), publicationHash: '5'.repeat(64) }
  const { body, bodyHash } = g6Body(values)
  expect(body).toContain('body_hash=' + bodyHash)
  expect(() => assertG6Body(body + '\n实测补记\n', body)).not.toThrow()
  expect(() => assertG6Body(body.replace(values.independentHash, values.publicationHash), body)).toThrow(/锚前/)
  expect(() => assertG6Body(body.replace('结论：pass', '结论：fail'), body)).toThrow(/锚前/)
  expect(() => assertG6Body(body + 'candidate_commit=' + values.audit, body)).toThrow(/覆写/)
})

it('拒绝缺少或重复的 R0 原件，以及短窗和错候选、错包的原件', () => {
  const candidate = '1'.repeat(40)
  const archiveSha256 = '2'.repeat(64)
  const expected = { candidate, archiveSha256, startedAt: '2026-11-20T03:00:00.000Z', endedAt: '2026-11-23T03:00:00.000Z' }
  const inputs = R0_ORIGINALS.map((name) => ({ source: 'r0-observation:' + name, file: 'evidence/r0/' + name }))
  const originals = new Map<string, Buffer>(inputs.map(({ file }) => [file, Buffer.alloc(0)]))
  const put = (file: string, value: unknown) => originals.set('evidence/r0/' + file, Buffer.from(JSON.stringify(value)))
  const blob = (file: string) => originals.get(file)!
  expect(() => assertG6R0Evidence(inputs.slice(1), blob, expected)).toThrow(/原件缺失/)
  expect(() => assertG6R0Evidence([...inputs, inputs[0]!], blob, expected)).toThrow(/来源重复/)
  const id = 'r0-fixture'
  const short = { schema: 1, id, kind: 'short', slots: 2, interval_ms: 1000, candidate, archive: null, archiveSha256: null }
  put('launch.json', short)
  put('worker.json', { id })
  put('end.json', { id, error: null, status: 'complete', synthetic_ledger_key: 'synthetic-key', prior_sha256: {} })
  expect(() => assertG6R0Evidence(inputs, blob, expected)).toThrow(/frozen candidate and archive/)
  const formal = { ...short, kind: 'formal', slots: 4320, interval_ms: 60_000, archive: 'isolation.tgz', archiveSha256 }
  put('launch.json', { ...formal, candidate: '3'.repeat(40) })
  expect(() => assertG6R0Evidence(inputs, blob, expected)).toThrow(/frozen candidate and archive/)
  put('launch.json', { ...formal, archiveSha256: '4'.repeat(64) })
  expect(() => assertG6R0Evidence(inputs, blob, expected)).toThrow(/frozen candidate and archive/)
})

it('requires all five office lag originals and independently recomputes the full window and minute slices', () => {
  const sha = '1'.repeat(40)
  const header = { schema: OFFICE_LAG_SCHEMA, candidate: sha, measurement: 'dae95922-77fe-49eb-aa56-ed54e8e0e788' }
  const startedAt = '2026-11-21T03:00:00.000Z'
  const window = { startMs: 1000, ...OFFICE_LAG_WINDOW }
  const baselineSeq = 1
  const observations = Array.from({ length: window.slots }, (_, slot) => {
    const committedMs = window.startMs + slot * window.slotMs + 100
    return { seq: slot + 2, slot, committedMs, observedMs: committedMs + 400 }
  })
  const nonProbeCommit = observations.at(-1)!.committedMs + 600
  const events = [...observations.map((probe) => ({ ...probe, type: 's6.soak_probe', event_id: 'evt-' + probe.seq })),
    ...Array.from({ length: 9 }, (_, index) => {
      const seq = index + 122
      const committedMs = nonProbeCommit + index * 10
      return { slot: 119, seq, type: 'run.terminal', event_id: 'evt-' + seq, committedMs, observedMs: committedMs + 500 }
    })]
  const launch = { ...header, clean: true, startedAt, window, baselineSeq, platform: 'win32', clock: 'performance.now()', traffic: 'fixture' }
  const sampleFile = { ...header, clean: true, window, observations }
  const dbBytes = withG6Scratch((directory) => {
    const file = join(directory, 'ledger.db')
    const db = new DatabaseSync(file)
    try {
      db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY, event_id TEXT, type TEXT, created_at TEXT)')
      const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)')
      insert.run(baselineSeq, 'evt-1', 'run.terminal', '2026-11-21T02:59:59.500Z')
      for (const event of events) insert.run(event.seq, event.event_id, event.type,
        new Date(Date.parse(startedAt) + event.committedMs - window.startMs - 1).toISOString())
    } finally { db.close() }
    return readFileSync(file)
  })
  const originals = new Map<string, Buffer>()
  const put = (path: string, value: unknown) => originals.set(path, Buffer.from(JSON.stringify(value) + '\n'))
  const putEvents = (rows: typeof events) => originals.set('events.ndjson', Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n'))
  const seal = (elapsedMs = 607_000, throughSeq = events.at(-1)!.seq, wallElapsedMs = elapsedMs) => put('end.json', { ...header, portReleased: true,
    completedAt: new Date(Date.parse(startedAt) + wallElapsedMs).toISOString(), completedMs: window.startMs + elapsedMs, elapsedMs, throughSeq,
    originals: Object.fromEntries(OFFICE_LAG_ORIGINALS.map((name) => [name, sha256Hex(originals.get(name)!)])),
  })
  const read = (candidate = sha) => createG6FileEvidenceReader(() => undefined).observe({
    id: 'event_lag', candidate: { git_sha: candidate, schema_version: 1, phase: 'S6' }, evidence: [...originals].map(([name, bytes]) => ({
      entry: { evidence_id: 'lag/' + name, file: 'docs/gates/evidence/G6/lag/' + name,
        source: 'office-event-lag', strength: 'strong', sha256: sha256Hex(bytes) }, bytes,
    })),
  })
  put('launch.json', launch)
  put('lag-samples.json', sampleFile)
  originals.set('ledger.db', dbBytes)
  putEvents(events)
  seal()
  const result = read()
  expect(result).toMatchObject({ kind: 'event_lag', windows: [expect.objectContaining({ samples: 129 }), ...Array.from({ length: 10 }, (_, slice) =>
    expect.objectContaining({ samples: slice === 9 ? 21 : 12 }))] })
  expect(read('2'.repeat(40))).toBeUndefined()

  originals.delete('end.json')
  expect(read()).toBeUndefined()
  seal(599_999)
  expect(read()).toBeUndefined()
  seal(607_000, events.at(-1)!.seq, 1)
  expect(read()).toBeUndefined()
  seal()
  const sparse = { startMs: 1000, slotMs: 600_000, slots: 1, slotsPerSlice: 1 }
  put('launch.json', { ...launch, window: sparse })
  put('lag-samples.json', { ...sampleFile, window: sparse, observations: observations.slice(0, 1) })
  seal()
  expect(read()).toBeUndefined()
  put('launch.json', launch)
  put('lag-samples.json', sampleFile)
  seal()

  const last = events.at(-1)!
  putEvents([...events.slice(0, -1), { ...last, event_id: 'tampered' }])
  expect(read()).toBeUndefined()
  seal()
  expect(read()).toBeUndefined()
  putEvents(events.slice(0, -1))
  seal(607_000, last.seq - 1)
  expect(read()).toBeUndefined()

  // All probes still pass. The real last non-probe event alone exceeds the delivery cap.
  putEvents([...events.slice(0, -1), { ...last, observedMs: last.committedMs + 11_000 }])
  seal()
  expect(read()).toBeUndefined()
  putEvents([...events.slice(0, -1), { ...last, observedMs: last.committedMs + 6_000 }])
  seal()
  expect(read()).toMatchObject({ windows: expect.arrayContaining([{ samples: 21, p95_ms: 500, max_ms: 6_000 }]) })
  putEvents(events)
  seal()
  expect(read()).toEqual(result)
})

it('rejects fake G6 report conclusions', () => {
  const sha = '1'.repeat(40)
  const reader = createG6FileEvidenceReader(() => undefined)
  const read = (id: string, file: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value))
    return reader.observe({ id, candidate: { git_sha: sha, schema_version: 1, phase: 'S6' }, evidence: [{
      entry: { evidence_id: 'sample', file, strength: 'strong', source: 'fixture', sha256: sha256Hex(bytes) }, bytes,
    }] })
  }
  expect(read('event_lag', 'lag/lag-samples.json', { conclusion: 'pass' })).toBeUndefined()
  expect(read('soak_24h', 'soak-report.json', { conclusion: 'pass', g6Eligible: true })).toBeUndefined()
  expect(read('G-01', 'report.json', { conclusion: 'pass', passed: true })).toBeUndefined()
  expect(read('control_p95', 'perf-report.json', { conclusion: 'pass', passed: true })).toBeUndefined()
})

it('binds the formal soak launch, detached worker, isolated configuration and all archive hashes', () => {
  const root = '/fixture/soak'
  const sha = '1'.repeat(40)
  const startedAt = '2026-11-20T02:00:01.000Z'
  const requestedAt = '2026-11-20T02:00:00.000Z'
  const binary = ['/fixture/node', '--no-warnings', '/fixture/scripts/soak.ts']
  const command = [...binary, '--hours', '24', '--candidate', sha, '--evidence-dir', root]
  const fixture = 's6 synthetic read-only fixture v1'
  const baseConfig = JSON.parse(readFileSync(new URL('../../orchestra.config.json', import.meta.url), 'utf8'))
  const isolated = { ...baseConfig, phase: 'S6', service: { ...baseConfig.service, db_path: root + '/ledger.db' },
    bridge: { ...baseConfig.bridge, spill_dir: root + '/spill' } }
  const manifest: Manifest = { schema: 1, id: 'test-fixture', kind: 'formal', supervision: 'detached', candidate: sha,
    clean: true, pid: 42, endpoint: 'http://127.0.0.1:9001', epoch: 1, bootId: 'fixture', startMs: 10,
    startWallMs: Date.parse(startedAt), slots: 2880, slotMs: 30_000, walLimitBytes: 4_200_000,
    configHash: sha256Hex(JSON.stringify(isolated)), startedAt, root, role: 's6-soak-synthetic', node: 'fixture', command }
  const files = new Map<string, Uint8Array>()
  const put = (name: string, value: unknown) => files.set(name, Buffer.from(JSON.stringify(value)))
  const read = (name: string) => {
    const value = files.get(name)
    if (!value) throw new Error('Missing ' + name)
    return value
  }
  const seal = () => put('hashes.json', Object.fromEntries(FORMAL_SOAK_ARCHIVE.map(name => [name, sha256Hex(Buffer.from(read(name)))])))
  const detached = { pid: manifest.pid, startedAt, command: [...binary, '--worker', manifest.id, '--evidence-dir', manifest.root] }
  put('launch.json', { schema: 1, id: manifest.id, kind: manifest.kind, requestedCandidate: sha, slots: 2880, slotMs: 30_000,
    command, supervisorPid: 41, supervision: 'detached', requestedAt })
  put('detached.json', detached)
  put('host.json', { phase: 'S6', supervision: 'detached', isolatedWorkspace: root + '/workspace', fixture,
    availableBytes: 512 * 1024 * 1024, requiredBytes: 128 * 1024 * 1024, topology: 'one process plus loopback HTTP/SSE; no child executor' })
  put('manifest.json', manifest)
  put('soak-config.json', isolated)
  put('end.json', {})
  for (const name of ['points.ndjson', 'events.ndjson', 'ledger.db']) files.set(name, Buffer.alloc(0))
  files.set('workspace/sample.txt', Buffer.from(fixture + '\n'))
  seal()
  expect(() => assertFormalSoakArchive(read, manifest)).not.toThrow()
  expect(() => assertFormalSoakArchive(read, { ...manifest, kind: 'short' })).toThrow(/formal continuous run/)
  const gate = createG6FileEvidenceReader(() => undefined)
  expect(gate.observe({ id: 'soak_24h', candidate: { git_sha: sha, schema_version: 1, phase: 'S6' },
    evidence: [...files].map(([name, bytes]) => ({
      entry: { evidence_id: name, file: 'fixture/' + name, strength: 'strong', source: 'fixture', sha256: sha256Hex(Buffer.from(bytes)) }, bytes,
    })),
  })).toBeUndefined()
  put('detached.json', { ...detached, pid: 99 })
  expect(() => assertFormalSoakArchive(read, manifest)).toThrow(/hashes/)
  seal()
  expect(() => assertFormalSoakArchive(read, manifest)).toThrow(/worker or candidate/)
  files.delete('host.json')
  expect(() => assertFormalSoakArchive(read, manifest)).toThrow(/Missing host/)
})

it('fails cleanly when the formal trusted workspace, real history, or authorization is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-g6-test-'))
  const provider = process.env.DSH_G6_WORKSPACE_PROVIDER
  const offline = process.env.DSH_G6_TRUST_FILE
  try {
    delete process.env.DSH_G6_WORKSPACE_PROVIDER
    delete process.env.DSH_G6_TRUST_FILE
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','--quiet','-m','fixture'], { cwd: root })
    expect(() => assertG5History(root)).toThrow(/无法证明正式 G5/)
    await expect(verifyG6(root, () => 'pass')).rejects.toThrow(/工作区授权验证器/)
    await expect(signG6(root, () => 'pass')).rejects.toThrow(/工作区授权验证器/)
  } finally {
    if (provider !== undefined) process.env.DSH_G6_WORKSPACE_PROVIDER = provider
    if (offline !== undefined) process.env.DSH_G6_TRUST_FILE = offline
    rmSync(root, { recursive: true, force: true })
  }
})
