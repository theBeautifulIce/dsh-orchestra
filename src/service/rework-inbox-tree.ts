import { withReadTx } from './queries/read-tx.ts'
import type { Db } from '../infra/sqlite/driver.ts'

type PendingRework = {
  run_id: string; request_id: string; target_node_run_id: string; status: string
  round_no: number; reason: string; revision: number
}

/**
 * 当前人在这棵运行树里真正能办的返工待办。
 * 从任意一层运行出发都先回到根，再取根的后代：子运行提出的返工不能在原会话里消失（D07）。
 */
export function pendingReworkTree(db: Db, runId: string, actor: string, limit = 5) {
  return withReadTx(db, ({ tx }) => {
    const rows = tx.all<PendingRework & { total: number }>(
      `WITH RECURSIVE up(run_id,parent_run_id,task_id,depth) AS (
         SELECT run_id,parent_run_id,task_id,0 FROM runs WHERE run_id=?
         UNION ALL SELECT r.run_id,r.parent_run_id,r.task_id,up.depth+1 FROM runs r JOIN up ON r.run_id=up.parent_run_id
         WHERE r.task_id=up.task_id AND up.depth<16
       ), root(run_id,task_id) AS (
         SELECT run_id,task_id FROM up WHERE parent_run_id IS NULL ORDER BY depth DESC LIMIT 1
       ), tree(run_id,task_id) AS (
         SELECT run_id,task_id FROM root
         UNION SELECT r.run_id,r.task_id FROM runs r JOIN tree t ON r.parent_run_id=t.run_id AND r.task_id=t.task_id
       )
       SELECT q.run_id,q.request_id,q.target_node_run_id,q.status,q.round_no,q.reason,q.revision,
         count(*) OVER() AS total
       FROM tree t JOIN rework_requests q ON q.run_id=t.run_id
       JOIN runs r ON r.run_id=t.run_id
       WHERE q.owner_actor=? AND r.status='running' AND r.cancel_requested_at IS NULL
         AND q.status IN ('proposed','needs_human_approval','escalated','awaiting_review')
       ORDER BY q.created_at,q.request_id`, [runId, actor])
    const items = rows.slice(0, limit).map(({ total: _total, ...item }) => item)
    return { items, total: rows[0]?.total ?? 0 }
  })
}
