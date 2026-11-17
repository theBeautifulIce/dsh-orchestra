import { OrchError } from '../../core/errors.ts'
import type { ChainRow } from '../../core/hash-chain.ts'
import type { Db } from '../../infra/sqlite/driver.ts'
import { chainBreakOf } from '../../infra/db/ledger.ts'
import { withReadTx } from './read-tx.ts'

export type EvidenceView = {
  evidence_id: string
  node_run_id: string
  run_id: string
  attempt: number
  strength: 'strong'
  source: 'run_tool'
  tool: string
  exit_code: number
  stdout_hash: string | null
  stderr_hash: string | null
  command_hash: string | null
  observed_at: string
  summary: string
  artifact_id: null
}

type EvidenceRow = {
  execution_id: string
  node_run_id: string
  run_id: string
  attempt: number
  tool: string
  exit_code: number
  stdout_hash: string | null
  stderr_hash: string | null
  command_hash: string | null
  finished_at: string | null
}

function evidenceUnavailable(evidenceId: string, reason: string): OrchError {
  return new OrchError('EVIDENCE_SOURCE_UNAVAILABLE', '系统证据无法核对', { evidence_id: evidenceId, reason })
}

/** Evidence IDs are host-issued tool execution IDs. Model output and human attestations are not evidence rows. */
export function getEvidenceSnapshot(db: Db, secret: string, evidenceId: string): { item: EvidenceView; as_of_seq: number } {
  return withReadTx(db, (ctx) => {
    const row = ctx.tx.get<EvidenceRow>(
      'SELECT t.execution_id, t.node_run_id, n.run_id, t.attempt, t.tool, t.exit_code, t.stdout_hash, '
      + 't.stderr_hash, t.command_hash, t.finished_at FROM tool_executions t '
      + 'JOIN node_runs n ON n.node_run_id = t.node_run_id WHERE t.execution_id = ?',
      [evidenceId],
    )
    if (!row) throw new OrchError('NOT_FOUND', '没找到这条系统证据', { evidence_id: evidenceId })
    if (!row.finished_at) throw evidenceUnavailable(evidenceId, 'tool execution has no finish time')

    const chain = ctx.tx.all<ChainRow>(
      'SELECT node_run_id, seq, type, prev_hash, hash, payload FROM node_run_events WHERE node_run_id = ? ORDER BY seq ASC',
      [row.node_run_id],
    )
    const broken = chainBreakOf(secret, chain)
    if (broken) throw evidenceUnavailable(evidenceId, 'node run event chain is invalid')
    const finished = chain.find((event) => {
      if (event.type !== 'tool_finished') return false
      try {
        const payload = JSON.parse(event.payload) as Record<string, unknown>
        return payload.execution_id === evidenceId
      } catch {
        return false
      }
    })
    if (!finished) throw evidenceUnavailable(evidenceId, 'tool execution has no matching tool_finished event')
    let payload: Record<string, unknown>
    try { payload = JSON.parse(finished.payload) as Record<string, unknown> } catch {
      throw evidenceUnavailable(evidenceId, 'tool_finished payload is invalid')
    }
    if (payload.tool !== row.tool || Number(payload.attempt) !== row.attempt
      || Number(payload.exit_code) !== row.exit_code
      || payload.stdout_hash !== row.stdout_hash
      || payload.stderr_hash !== row.stderr_hash
      || payload.command_hash !== row.command_hash
      || payload.finished_at !== row.finished_at) {
      throw evidenceUnavailable(evidenceId, 'tool execution row differs from its ledger event')
    }

    return {
      item: {
        evidence_id: row.execution_id,
        node_run_id: row.node_run_id,
        run_id: row.run_id,
        attempt: row.attempt,
        strength: 'strong',
        source: 'run_tool',
        tool: row.tool,
        exit_code: row.exit_code,
        stdout_hash: row.stdout_hash,
        stderr_hash: row.stderr_hash,
        command_hash: row.command_hash,
        observed_at: row.finished_at,
        summary: '宿主只读工具执行完成，exit_code=' + String(row.exit_code),
        artifact_id: null,
      },
      as_of_seq: ctx.as_of_seq,
    }
  })
}
