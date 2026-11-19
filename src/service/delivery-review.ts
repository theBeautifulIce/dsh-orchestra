import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import { sha256Hex } from '../core/canonical.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'
import { requestHashOf, runIdempotentCommand } from './commands/idempotency.ts'
import { closeRun } from './commands/run-close.ts'

const holdKeys = { operation_id: z.uuidv7(), run_id: z.string().min(1).max(256), node_run_id: z.string().min(1).max(256) }
export const deliveryHoldSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...holdKeys, action: z.literal('hold') }),
  z.strictObject({ ...holdKeys, action: z.literal('withdraw') }),
  z.strictObject({ ...holdKeys, action: z.literal('accept'), artifact_id: z.string().min(1).max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
])

export function hasDeliveryReviewHold(tx: ReadTx, runId: string): boolean {
  // A previous approval cannot approve a later attempt of the same logical node.
  return Boolean(tx.get(`SELECT 1 FROM delivery_review_holds h JOIN node_runs n
    ON n.run_id=h.run_id AND n.node_id=h.node_id AND n.replacement_node_run_id IS NULL
    WHERE h.run_id=? AND (h.status='held' OR h.node_run_id<>n.node_run_id)
    AND n.status IN ('done','queued','started','verifying','dispatched') LIMIT 1`, [runId]))
}

export function reviewOwnership(tx: ReadTx, secret: string, runId: string) {
  const operator = 'service:' + sha256Hex(secret).slice(0, 8)
  const root = tx.get<{run_id:string;task_id:string}>(`WITH RECURSIVE lineage(run_id,parent_run_id,task_id,depth) AS (
    SELECT run_id,parent_run_id,task_id,0 FROM runs WHERE run_id=?
    UNION ALL SELECT r.run_id,r.parent_run_id,r.task_id,l.depth+1 FROM runs r JOIN lineage l ON r.run_id=l.parent_run_id
    WHERE r.task_id=l.task_id AND l.depth<16
  ) SELECT run_id,task_id FROM lineage WHERE parent_run_id IS NULL ORDER BY depth DESC LIMIT 1`,[runId])
  if (!root) throw new OrchError('FORBIDDEN','当前运行没有有效的任务归属链')
  const owner = tx.get<{ created_by: string }>(`SELECT p.created_by FROM task_plans p
    JOIN start_run_operations o ON o.operation_id=p.launch_operation_id WHERE o.run_id=?`, [root.run_id])
  return { rootRunId: root.run_id, taskId: root.task_id, owner: owner?.created_by ?? operator }
}

export function requireReviewOperator(tx: ReadTx, secret: string, actor: string, runId: string) {
  const ownership = reviewOwnership(tx, secret, runId)
  if (actor !== ownership.owner) throw new OrchError('FORBIDDEN', '当前主体没有该运行的人工审核权限')
  return ownership
}

export function createDeliveryReviewHost(db: Db, secret: string) {
  return {
    list(actor: string, runId?: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        if (runId) requireReviewOperator(tx, secret, actor, runId)
        const items = tx.all(`SELECT h.run_id,h.node_id,n.node_run_id,
          CASE WHEN n.node_run_id=h.node_run_id THEN h.status ELSE 'held' END AS status,
          h.artifact_id,h.sha256,h.updated_at FROM delivery_review_holds h
          JOIN node_runs n ON n.run_id=h.run_id AND n.node_id=h.node_id AND n.replacement_node_run_id IS NULL
          WHERE h.owner_actor=? AND (? IS NULL OR h.run_id=?) ORDER BY h.updated_at DESC LIMIT 150`,
        [actor, runId ?? null, runId ?? null])
        return { items, as_of_seq }
      })
    },
    change(input: z.infer<typeof deliveryHoldSchema>, actor: string, now: string) {
      const body = deliveryHoldSchema.parse(input)
      return withTx(db, (tx) => runIdempotentCommand(tx, {
        kind: 'rework.hold', operationId: body.operation_id, requestHash: requestHashOf('rework.hold', { body, actor }), now,
      }, () => {
        requireReviewOperator(tx, secret, actor, body.run_id)
        const node = tx.get<{ node_id: string; status: string }>(`SELECT n.node_id,n.status FROM node_runs n JOIN runs r USING(run_id)
          WHERE r.run_id=? AND n.node_run_id=? AND n.node_type='agent' AND n.replacement_node_run_id IS NULL
          AND r.status='running' AND r.cancel_requested_at IS NULL`, [body.run_id, body.node_run_id])
        if (!node) throw new OrchError('STALE_GENERATION', '只能审核进行中运行的当前智能体步骤')
        const key = [body.run_id, node.node_id]
        if (body.action === 'hold') {
          tx.run(`INSERT INTO delivery_review_holds(run_id,node_id,node_run_id,owner_actor,status,updated_at)
            VALUES(?,?,?,?,'held',?) ON CONFLICT(run_id,node_id) DO UPDATE SET node_run_id=excluded.node_run_id,
            status='held',artifact_id=NULL,sha256=NULL,updated_at=excluded.updated_at`, [...key, body.node_run_id, actor, now])
        } else {
          if (!tx.get('SELECT 1 FROM delivery_review_holds WHERE run_id=? AND node_id=? AND owner_actor=?', [...key, actor])) {
            throw new OrchError('NOT_FOUND', '该步骤没有人工留验要求')
          }
          if (body.action === 'withdraw') {
            tx.run('DELETE FROM delivery_review_holds WHERE run_id=? AND node_id=?', key)
          } else {
            const artifact = tx.get<{ bytes: Uint8Array }>(`SELECT c.bytes FROM artifacts a JOIN artifact_contents c USING(artifact_id)
              WHERE a.run_id=? AND c.node_run_id=? AND a.artifact_id=? AND a.sha256=? AND (a.retain_until IS NULL OR a.retain_until>?)`,
            [body.run_id, body.node_run_id, body.artifact_id, body.sha256, now])
            if (node.status !== 'done' || !artifact || sha256Hex(Buffer.from(artifact.bytes)) !== body.sha256) throw new OrchError('CONFIRMATION_MISMATCH', '成果版本与当前已完成步骤不符')
            tx.run(`UPDATE delivery_review_holds SET status='accepted',node_run_id=?,artifact_id=?,sha256=?,updated_at=? WHERE run_id=? AND node_id=?`,
            [body.node_run_id, body.artifact_id, body.sha256, now, ...key])
          }
        }
        appendEvent(tx, { type: 'rework.hold_' + body.action, runId: body.run_id, nodeRunId: body.node_run_id, payload: { ...body, actor } })
        if (body.action !== 'hold') closeRun(tx, secret, body.run_id, now)
        return { run_id: body.run_id, node_run_id: body.node_run_id, action: body.action }
      }).result)
    },
  }
}
