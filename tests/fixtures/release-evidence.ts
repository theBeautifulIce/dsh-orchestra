import { sha256Hex } from '../../src/core/canonical.ts'
import { RELEASE_INVARIANTS, RELEASE_ITEMS, type ReleaseEvidenceReader, type ReleaseObservation } from '../../src/core/wf-release-v1.ts'

export function releaseEvidenceFixture() {
  const candidate = { git_sha: '1'.repeat(40), schema_version: 1, phase: 'S6' }
  const entries = new Map<string, Buffer>()
  const observations: Record<string, ReleaseObservation> = {
    control_p95: { kind: 'control_p95', list_tasks_rows: 10_000, list_tasks_ms: 90, get_run_nodes: 1000, get_run_ms: 100,
      list_nodes_rows: 200, list_nodes_ms: 70, list_events_rows: 200, list_events_ms: 40 },
    event_lag: { kind: 'event_lag', windows: [{ p95_ms: 2000, max_ms: 10000, samples: 100 }] },
    soak_24h: { kind: 'soak_24h', duration_ms: 86_400_000, samples: 2880, orphaned: 0, unsettled: 0, leaks: 0,
      rss_growth: false, wal_growth: false, p95_ms: 2000, max_ms: 10000 },
    upgrade: { kind: 'upgrade', previous_build: '2'.repeat(64), healthy: true, ledger_replayed: true },
    load_rollback: { kind: 'load_rollback', previous_build: '2'.repeat(64), under_load: true,
      old_reads_new: true, new_reads_old: true, ledger_replayed: true },
    oncall_drill: { kind: 'oncall_drill', acknowledged_by: 'human:测试值班身份', rollback_verified: true },
  }
  const items = RELEASE_ITEMS.map((id) => ({ id, evidence_ids: ['ev-' + id] }))
  const invariants = RELEASE_INVARIANTS.map((id) => ({ id, method: 'counterexample', evidence_ids: ['ev-' + id] }))
  const evidence = [...items, ...invariants].map(({ id }) => {
    const item: ReleaseObservation = observations[id] ?? (id.startsWith('G-')
      ? { kind: 'fault', exit_code: 0, injection: true, before_ledger: true, after_ledger: true, reconciled: true }
      : { kind: 'invariant', id, method: 'counterexample', result: 'pass' })
    const bytes = Buffer.from(JSON.stringify({ candidate, id, item }))
    const file = 'test-evidence/' + id + '.json'
    entries.set(file, bytes)
    return { evidence_id: 'ev-' + id, file, source: 'fixture', strength: 'strong', sha256: sha256Hex(bytes) }
  })
  const manifest = { candidate, items, invariants, evidence,
    change_scope: { capability_ids: ['release.run'], touched_paths: ['src/\u{10000}', 'src/\uE000'] } }
  const reader = (): ReleaseEvidenceReader => ({
    read: (entry) => entries.get(entry.file),
    observe: (request) => {
      const row = JSON.parse(Buffer.from(request.evidence[0]!.bytes).toString()) as { id: string; candidate: { git_sha: string }; item: unknown }
      return row.id === request.id && row.candidate.git_sha === request.candidate.git_sha ? row.item : null
    },
  })
  return { manifest, reader, entries }
}
