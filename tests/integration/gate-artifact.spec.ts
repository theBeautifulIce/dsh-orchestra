import { expect, it } from 'vitest'
import { sha256Hex } from '../../src/core/canonical.ts'
import { buildReleaseArtifact, releaseArtifactBody } from '../../src/core/gate-artifact.ts'
import { judgeReleaseEvidence, normalizeReleaseManifest, releaseHash } from '../../src/core/wf-release-v1.ts'
import { compareReleaseArtifacts, PRIOR_GATE_HASH } from '../../src/service/release-gate.ts'
import { releaseEvidenceFixture } from '../fixtures/release-evidence.ts'

it('uses code point order and the four G6 preimages regardless of input order', () => {
  const { manifest, reader } = releaseEvidenceFixture()
  const result = judgeReleaseEvidence(manifest, reader())
  expect(result.conclusion).toBe('pass')
  const ordered = normalizeReleaseManifest(manifest)
  expect(ordered.change_scope.touched_paths).toEqual(['src/\uE000', 'src/\u{10000}'])
  const expected = '{"capability_ids":["release.run"],"touched_paths":["src/\uE000","src/\u{10000}"]}'
  expect(result.change_scope_hash).toBe(sha256Hex(expected))
  expect(result.candidate_hash).toBe(sha256Hex('{"git_sha":"' + '1'.repeat(40) + '","phase":"S6","schema_version":1}'))
  expect(judgeReleaseEvidence({ ...manifest, evidence: [...manifest.evidence].reverse(), items: [...manifest.items].reverse(),
    invariants: [...manifest.invariants].reverse(), change_scope: { ...manifest.change_scope, touched_paths: [...manifest.change_scope.touched_paths].reverse() } },
  reader())).toEqual(result)
  expect(releaseHash({ '\u{10000}': 2, '\uE000': 1 })).toBe(sha256Hex('{"\uE000":1,"\u{10000}":2}'))
})

it('rejects ambiguous input, missing files, missing reconciliation and an over-limit latency window', () => {
  const { manifest, reader, entries } = releaseEvidenceFixture()
  expect(() => normalizeReleaseManifest({ ...manifest, evidence: [...manifest.evidence, manifest.evidence[0]] })).toThrow(/重复/)
  expect(() => normalizeReleaseManifest({ ...manifest, items: manifest.items.slice(1) })).toThrow(/缺项/)
  entries.delete('test-evidence/G-07.json')
  const source = reader()
  const result = judgeReleaseEvidence(manifest, { ...source, observe: (request) =>
    request.id === 'event_lag' ? { kind: 'event_lag', windows: [{ p95_ms: 1999, max_ms: 10_001, samples: 100 }] }
      : request.id === 'G-03' ? { kind: 'fault', exit_code: 0, injection: true, before_ledger: true, after_ledger: true }
        : source.observe(request) })
  expect(result.conclusion).toBe('fail')
  expect(result.must_pass_items.filter(({ result }) => result === 'fail').map(({ id }) => id)).toEqual(['G-03', 'G-07', 'event_lag'])
})

it('compares only the three published fields, rejects double fail, and excludes self anchor and expired exceptions', () => {
  const { manifest, reader } = releaseEvidenceFixture()
  const result = judgeReleaseEvidence(manifest, reader())
  const independent = releaseArtifactBody(result, { producer: 'human', gate_run_id: null, run_terminal: 'not_applicable' })
  const published = releaseArtifactBody(result, { producer: 'wf_release_v1', gate_run_id: 'real-run-id', run_terminal: 'succeeded' })
  expect(compareReleaseArtifacts({ ...published, change_scope_hash: 'different' }, independent).passed).toBe(true)
  const unverified = releaseArtifactBody(result, { producer: 'wf_release_v1', gate_run_id: 'real-run-id', run_terminal: 'succeeded_with_unverified' })
  expect(compareReleaseArtifacts(unverified, independent)).toMatchObject({ passed: false, mismatches: ['conclusion'] })
  expect(compareReleaseArtifacts({ ...unverified, conclusion: 'fail' }, { ...independent, conclusion: 'fail' }))
    .toMatchObject({ passed: false, mismatches: [] })
  expect(compareReleaseArtifacts({ ...published, candidate_hash: '0', evidence_index_hash: '1' }, independent).mismatches)
    .toEqual(['candidate_hash', 'evidence_index_hash'])
  const governance = { approver: 'human:fixture', approved_at: '2026-11-20T08:00:00.000Z', previous_artifact_hash: PRIOR_GATE_HASH,
    audit_round: 1, audit_report: 'test-docs/audit.md', audit_report_sha256: '1'.repeat(64), exceptions: [],
    rollback: { target: 'G5', action: 'replay', duration_s: 60, verification: 'match' } }
  expect(buildReleaseArtifact(published, governance)).toMatchObject({ approver: 'human:fixture', conclusion: 'pass' })
  const selfAnchored = { ...published, artifact_hash: 'invalid' }
  expect(() => buildReleaseArtifact(selfAnchored, governance)).toThrow(/外部锚点/)
  expect(() => buildReleaseArtifact(published, { ...governance, exceptions: [{
    code: 'TEMP', type: 'accepted', status: 403, note: 'test', scope: 'test', expires_at: '2026-11-20T07:00:00.000Z',
    compensation: 'rollback', rollback_target: 'G5', approver: 'human:fixture',
  }] })).toThrow(/批准时有效/)
})
