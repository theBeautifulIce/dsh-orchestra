import { expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { sha256Hex } from '../../src/core/canonical.ts'
import { releaseHash } from '../../src/core/wf-release-v1.ts'
import { createG6FileEvidenceReader } from '../../scripts/g6-file-evidence.ts'
import { assertFormalSoakArchive, FORMAL_SOAK_ARCHIVE } from '../../scripts/soak-archive.ts'
import type { Manifest } from '../../scripts/soak-judge.ts'
import { assertG6Body, assertG5History, authenticateG6Proof, g6Body, signG6, verifyG6 } from '../../scripts/gate-g6.ts'

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

it('derives lag from committed-to-observed samples and rejects fake report conclusions', () => {
  const sha = '1'.repeat(40)
  const seed = { candidate: sha, clean: true, window: { startMs: 0, slotMs: 60_000, slots: 10, slotsPerSlice: 1 },
    observations: Array.from({ length: 10 }, (_, slot) => ({ seq: slot + 1, slot, committedMs: slot * 60_000, observedMs: slot * 60_000 + 2_000 })) }
  const reader = createG6FileEvidenceReader(() => undefined)
  const read = (id: string, file: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value))
    return reader.observe({ id, candidate: { git_sha: sha, schema_version: 1, phase: 'S6' }, evidence: [{
      entry: { evidence_id: 'sample', file, strength: 'strong', source: 'fixture', sha256: sha256Hex(bytes) }, bytes,
    }] })
  }
  expect(read('event_lag', 'lag-samples.json', seed)).toMatchObject({ kind: 'event_lag' })
  seed.observations[1]!.observedMs += 8010
  expect(read('event_lag', 'lag-samples.json', seed)).toBeUndefined()
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
