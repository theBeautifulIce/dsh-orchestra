import { z } from 'zod'
import type { Tx } from '../infra/sqlite/driver.ts'
import { OrchError } from '../core/errors.ts'
import { readApprovedTaskPlanForRun } from './task-planning.ts'

const reviewFile = z.object({
  artifact_id: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  file_name: z.string().min(1)
})
export type ReviewFile = z.infer<typeof reviewFile>
export function reviewFilesForDoneAttempt(
  tx: Tx, runId: string, attemptId: string, nodeId: string, now: string,
  sealedJson: string | null
): ReviewFile[] {
  if (sealedJson !== null) {
    let decoded: unknown
    try { decoded = JSON.parse(sealedJson) } catch { throw new OrchError('CONFIRMATION_MISMATCH','留验清单无法解析') }
    const value = reviewFile.array().min(1).safeParse(decoded)
    if (!value.success) throw new OrchError('CONFIRMATION_MISMATCH', '本轮验收清单无法核对，请刷新')
    return value.data
  }
  const done = tx.get("SELECT 1 FROM node_runs WHERE run_id=? AND node_run_id=? AND node_id=? AND status='done' AND replacement_node_run_id IS NULL",
    [runId, attemptId, nodeId])
  if (!done) throw new OrchError('STALE_GENERATION', '步骤仍在交付')
  const rows = tx.all<ReviewFile & { size: number; expired: number }>(
    `SELECT a.artifact_id,a.sha256,c.file_name,length(c.bytes) AS size,
      CASE WHEN a.retain_until IS NULL OR julianday(a.retain_until)>julianday(?) THEN 0 ELSE 1 END AS expired
     FROM artifacts a JOIN artifact_contents c USING(artifact_id)
     WHERE a.run_id=? AND c.node_run_id=? ORDER BY a.created_at,a.artifact_id`, [now,runId,attemptId])
  const plan = readApprovedTaskPlanForRun(tx, runId)
  const mandatory = plan?.proposal.deliverables.flatMap(item =>
    item.node_id === nodeId && item.acceptance.kind === 'artifact' ? [item.acceptance] : []) ?? []
  if (!rows.length || rows.some(file => file.expired) || mandatory.some(rule =>
    !rows.some(file => file.file_name === rule.file_name && file.size >= rule.minimum_bytes))) {
    throw new OrchError('RESOLUTION_NOT_AVAILABLE', '本轮成果不齐或已过期，可补交或撤销留验')
  }
  // 同一文件名的重复登记是同一份交付的新旧版本：一个名字只占一个应审位，取最新一版。
  const byName = new Map<string, ReviewFile>()
  for (const row of rows) byName.set(row.file_name, { artifact_id: row.artifact_id, sha256: row.sha256, file_name: row.file_name })
  return [...byName.values()]
}

export function advanceReview(files: readonly ReviewFile[],
  previous: readonly Pick<ReviewFile, 'artifact_id'|'sha256'>[],
  selected: Pick<ReviewFile, 'artifact_id'|'sha256'>) {
  const same = (a: typeof selected, b: typeof selected) => a.artifact_id === b.artifact_id && a.sha256 === b.sha256
  if (!files.length || !files.some(x => same(x,selected)) || previous.some(x => !files.some(f => same(f,x))))
    throw new OrchError('CONFIRMATION_MISMATCH','该版本不属于本轮验收清单')
  const accepted = previous.some(x => same(x,selected)) ? [...previous] : [...previous,selected]
  const pending = files.filter(x => !accepted.some(y => same(x,y)))
  return { accepted, pending, complete: pending.length === 0 }
}
