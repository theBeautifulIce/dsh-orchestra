import { OrchError } from '../../core/errors.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { withReadTx } from './read-tx.ts'

export type ArtifactView = {
  artifact_id: string
  run_id: string
  sha256: string
  evidence_index: unknown
  retain_until: string | null
  expired: boolean
}

function parseEvidenceIndex(raw: unknown): unknown {
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) as unknown } catch { return null }
}

export function getArtifactSnapshot(db: Db, artifactId: string, now = Date.now()): { item: ArtifactView; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<Record<string, unknown>>(
      'SELECT artifact_id, run_id, sha256, evidence_index, retain_until FROM artifacts WHERE artifact_id = ?',
      [artifactId],
    )
    if (!row) throw new OrchError('NOT_FOUND', '没找到这份产物')
    const retainUntil = typeof row.retain_until === 'string' ? row.retain_until : null
    const retainTime = retainUntil === null ? null : Date.parse(retainUntil)
    return {
      item: {
        artifact_id: String(row.artifact_id),
        run_id: String(row.run_id),
        sha256: String(row.sha256),
        evidence_index: parseEvidenceIndex(row.evidence_index),
        retain_until: retainUntil,
        expired: retainTime !== null && Number.isFinite(retainTime) && retainTime < now,
      },
      as_of_seq: ctx.as_of_seq,
    }
  })
}

export function getArtifact(db: Db, artifactId: string, now = Date.now()): ArtifactView {
  return getArtifactSnapshot(db, artifactId, now).item
}
