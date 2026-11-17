import { OrchError } from '../../core/errors.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { withReadTx } from './read-tx.ts'

export type AttestationView = {
  attestation_id: string
  claim: string
  attested_by: string
  attested_at: string
  action_start_source: 'human_attested'
  summary: string | null
  classification: '人证，不是系统证据'
}

export function getAttestationSnapshot(db: Db, attestationId: string): { item: AttestationView; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<Record<string, unknown>>(
      'SELECT attestation_id, claim, attested_by, attested_at, action_start_source, summary FROM attestations WHERE attestation_id = ?',
      [attestationId],
    )
    if (!row) throw new OrchError('NOT_FOUND', '没找到这条人工签字')
    return {
      item: {
        attestation_id: String(row.attestation_id),
        claim: String(row.claim),
        attested_by: String(row.attested_by),
        attested_at: String(row.attested_at),
        action_start_source: 'human_attested',
        summary: typeof row.summary === 'string' ? row.summary : null,
        classification: '人证，不是系统证据',
      },
      as_of_seq: ctx.as_of_seq,
    }
  })
}
