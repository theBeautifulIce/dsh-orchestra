import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDb } from '../src/infra/sqlite/driver.ts'
import { withReadTx } from '../src/service/queries/read-tx.ts'

/** Return only the command's verified references and outcome from the service audit event. */
export function readCommandAudit(dbFile: string, afterSeq = 0, limit = 200) {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('Invalid audit page range')
  }
  const db = openDb(dbFile, { readonly: true })
  try {
    return withReadTx(db, ({ tx, as_of_seq }) => {
      const rows = tx.all<{
        seq: number; event_id: string; run_id: string; node_run_id: string | null; decision_id: string
        operation_id: string; actor_id: string; actor_kind: string; resolution: string; result: string
        occurred_at: string; evidence_json: string
      }>(
        "SELECT seq, event_id, run_id, node_run_id, decision_id, json_extract(payload_redacted, '$.operation_id') AS operation_id,"
        + " json_extract(payload_redacted, '$.actor_id') AS actor_id, json_extract(payload_redacted, '$.actor_kind') AS actor_kind,"
        + " json_extract(payload_redacted, '$.resolution') AS resolution, json_extract(payload_redacted, '$.result') AS result,"
        + " json_extract(payload_redacted, '$.occurred_at') AS occurred_at, json_extract(payload_redacted, '$.evidence_ids') AS evidence_json"
        + " FROM events WHERE type = 'decision.command_audited' AND seq > ? ORDER BY seq LIMIT ?",
        [afterSeq, limit + 1],
      )
      const items = rows.slice(0, limit).map(({ evidence_json, ...row }) => {
        const ids = JSON.parse(evidence_json) as unknown
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Invalid audit evidence references at ' + row.seq)
        return { ...row, evidence_ids: ids as string[] }
      })
      return { schema: 1, as_of_seq, items, next_after_seq: rows.length > limit ? items.at(-1)!.seq : null }
    })
  } finally {
    db.raw.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dbFile, afterSeq, extra] = process.argv.slice(2)
  if (dbFile === '--help' && afterSeq === undefined) {
    process.stdout.write('node --no-warnings scripts/export-command-audit.ts <ledger.db> [after_seq]\n')
  } else {
    try {
      if (!dbFile || extra !== undefined) throw new Error('Supply the ledger path and optional after_seq')
      process.stdout.write(JSON.stringify(readCommandAudit(dbFile, afterSeq === undefined ? 0 : Number(afterSeq)), null, 2) + '\n')
    } catch (error) {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
      process.exitCode = 1
    }
  }
}
