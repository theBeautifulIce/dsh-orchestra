import { OrchError } from '../core/errors.ts'
import type { Tx } from '../infra/sqlite/driver.ts'
import type { ReviewFile } from './review-manifest.ts'

export type HoldKey = { runId: string; nodeId: string; attemptId: string; actor: string }
export type SeenHold = { hold_id: string; expected_revision: number }
const stale = () => new OrchError('STALE_GENERATION', '留验已更新，请重新查看')
export function startHold(tx: Tx, k: HoldKey, operationId: string, now: string, replaces?: SeenHold) {
  if (replaces) {
    const changed = tx.run(`UPDATE delivery_review_holds SET node_run_id=?,hold_id=?,status='held',artifact_id=NULL,
      sha256=NULL,review_set_json=NULL,accepted_json='[]',revision=1,updated_at=? WHERE run_id=? AND node_id=?
      AND owner_actor=? AND hold_id=? AND revision=? AND (status='accepted' OR node_run_id<>?)`,
      [k.attemptId,operationId,now,k.runId,k.nodeId,k.actor,replaces.hold_id,replaces.expected_revision,k.attemptId])
    if (changed.changes!==1) throw stale()
    return {hold_id:operationId,revision:1,status:'held' as const}
  }
  const result = tx.run(`INSERT INTO delivery_review_holds
    (run_id,node_id,node_run_id,owner_actor,status,updated_at,hold_id,review_set_json,accepted_json,revision)
    VALUES(?,?,?,?,'held',?,?,NULL,'[]',1) ON CONFLICT(run_id,node_id) DO NOTHING`,
    [k.runId,k.nodeId,k.attemptId,k.actor,now,operationId])
  if (result.changes !== 1) throw stale()
  return { hold_id: operationId, revision: 1, status: 'held' as const }
}
export function submitHold(tx: Tx, k: HoldKey, seen: SeenHold, now: string,
  next: {files: ReviewFile[]; accepted: Pick<ReviewFile,'artifact_id'|'sha256'>[];
    complete: boolean; file: Pick<ReviewFile,'artifact_id'|'sha256'>} | null) {
  const where = "run_id=? AND node_id=? AND node_run_id=? AND owner_actor=? AND status='held' AND hold_id=? AND revision=?"
  const key = [k.runId,k.nodeId,k.attemptId,k.actor,seen.hold_id,seen.expected_revision]
  const changed = next === null ? tx.run('DELETE FROM delivery_review_holds WHERE '+where,key) :
    tx.run(`UPDATE delivery_review_holds SET status=?,artifact_id=?,sha256=?,review_set_json=?,
      accepted_json=?,revision=revision+1,updated_at=? WHERE ` + where, [
        next.complete ? 'accepted' : 'held', next.complete ? next.file.artifact_id : null,
        next.complete ? next.file.sha256 : null,JSON.stringify(next.files),JSON.stringify(next.accepted),now,...key])
  if (changed.changes !== 1) throw stale()
  return { hold_id: seen.hold_id, revision: seen.expected_revision+1,
    status: next === null ? 'withdrawn' as const : next.complete ? 'accepted' as const : 'held' as const }
}
