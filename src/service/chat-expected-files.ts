import type { Db } from '../infra/sqlite/driver.ts'
import { withReadTx } from './queries/read-tx.ts'
import { approvedArtifactRequirements } from './task-planning.ts'

/** Files not submitted for this attempt. Existing receipts alone do not prove acceptance. */
export function readOutstandingFiles(db: Db, runId: string) {
  return withReadTx(db, ({ tx }) => {
    const nodes = tx.all<{ node_run_id: string; node_id: string; attempt: number; action_generation: number }>(
      "SELECT node_run_id, node_id, attempt, action_generation FROM node_runs WHERE run_id=? AND status='blocked_post'", [runId],
    )
    return nodes.flatMap((node) => {
      const approved = approvedArtifactRequirements(tx, runId, node.node_id)
      if (!approved) return []
      const receipts = tx.all<{ file_name: string }>(`
        WITH publications AS (
          SELECT CASE WHEN json_valid(payload) THEN payload END AS receipt
          FROM node_run_events WHERE node_run_id=? AND type='artifact.published_for_attempt'
        )
        SELECT c.file_name FROM publications p
        JOIN artifacts a ON a.artifact_id=json_extract(p.receipt,'$.artifact_id') AND a.run_id=?
        JOIN artifact_contents c ON c.artifact_id=a.artifact_id AND c.node_run_id=?
          AND c.file_name=json_extract(p.receipt,'$.file_name')
        WHERE json_extract(p.receipt,'$.attempt')=? AND json_extract(p.receipt,'$.action_generation')=?
          AND json_extract(p.receipt,'$.plan_id')=? AND json_extract(p.receipt,'$.plan_hash')=?
      `, [node.node_run_id, runId, node.node_run_id, node.attempt, node.action_generation, approved.planId, approved.contentHash])
      const submitted = new Set(receipts.map((item) => item.file_name))
      const missing = [...new Set(approved.rules.map((rule) => rule.file_name))].filter((name) => !submitted.has(name))
      return missing.length ? [{ node_run_id: node.node_run_id, file_names: missing }] : []
    })
  })
}
