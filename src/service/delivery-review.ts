import { z } from 'zod'
import { OrchError } from '../core/errors.ts'
import { sha256Hex } from '../core/canonical.ts'
import { appendEvent } from '../infra/db/ledger.ts'
import { withTx, type Db } from '../infra/sqlite/driver.ts'
import { withReadTx, type ReadTx } from './queries/read-tx.ts'
import { requestHashOf, runIdempotentCommand } from './commands/idempotency.ts'
import { closeRun } from './commands/run-close.ts'
import { advanceReview, reviewFilesForDoneAttempt } from './review-manifest.ts'
import { startHold, submitHold, type HoldKey, type SeenHold } from './review-cas.ts'

const holdKeys = { operation_id: z.uuidv7(), run_id: z.string().min(1).max(256), node_run_id: z.string().min(1).max(256) }
/** 读到的留验身份：新客户端必须带上，旧页签的结论只能落到它读到的那一代（D04）。 */
const seenHold = {
  hold_id: z.string().min(1).max(128).optional(),
  expected_revision: z.number().int().min(1).optional(),
}
export const deliveryHoldSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...holdKeys, ...seenHold, action: z.literal('hold') }),
  z.strictObject({ ...holdKeys, ...seenHold, action: z.literal('withdraw') }),
  z.strictObject({ ...holdKeys, ...seenHold, action: z.literal('accept'), artifact_id: z.string().min(1).max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
])

export function hasDeliveryReviewHold(tx: ReadTx, runId: string): boolean {
  // A previous approval cannot approve a later attempt of the same logical node.
  return Boolean(tx.get(`SELECT 1 FROM delivery_review_holds h JOIN node_runs n
    ON n.run_id=h.run_id AND n.node_id=h.node_id AND n.replacement_node_run_id IS NULL
    WHERE h.run_id=? AND (h.status='held' OR h.node_run_id<>n.node_run_id)
    AND n.status IN ('done','queued','started','verifying','dispatched') LIMIT 1`, [runId]))
}

export function reviewOwnership(tx: ReadTx, secret: string, runId: string, humanOnly = false) {
  const root = tx.get<{run_id:string;task_id:string}>(`WITH RECURSIVE lineage(run_id,parent_run_id,task_id,depth) AS (
    SELECT run_id,parent_run_id,task_id,0 FROM runs WHERE run_id=?
    UNION ALL SELECT r.run_id,r.parent_run_id,r.task_id,l.depth+1 FROM runs r JOIN lineage l ON r.run_id=l.parent_run_id
    WHERE r.task_id=l.task_id AND l.depth<16
  ) SELECT run_id,task_id FROM lineage WHERE parent_run_id IS NULL ORDER BY depth DESC LIMIT 1`,[runId])
  if (!root) throw new OrchError('FORBIDDEN','当前运行没有有效的任务归属链')
  const launch = tx.get<{ started_by: string | null; created_by: string | null }>(`SELECT o.started_by,p.created_by
    FROM start_run_operations o LEFT JOIN task_plans p ON p.launch_operation_id=o.operation_id
    WHERE o.run_id=? AND o.task_id=?`, [root.run_id, root.task_id])
  const authorized = launch?.started_by ?? launch?.created_by
  if (humanOnly && (!authorized?.trim() || /^(?:service|agent|system):/i.test(authorized))) {
    throw new OrchError('FORBIDDEN', '该运行未记录可信的人工负责人，无法办理人工审核')
  }
  const owner = authorized ?? 'service:' + sha256Hex(secret).slice(0, 8)
  return { rootRunId: root.run_id, taskId: root.task_id, owner }
}

export function requireReviewOperator(tx: ReadTx, secret: string, actor: string, runId: string, humanOnly = false) {
  const ownership = reviewOwnership(tx, secret, runId, humanOnly)
  if (actor !== ownership.owner) throw new OrchError('FORBIDDEN', '当前主体没有该运行的人工审核权限')
  return ownership
}

type ReviewItem = { artifact_id: string; sha256: string; file_name: string | null }
type ReviewSet = ReviewItem[]

/** 旧记录的清单列为空：按当时的单件语义解释，不补造历史。 */
function readReviewSet(raw: unknown): ReviewSet | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) return null
    return value.flatMap((item) => typeof item === 'object' && item !== null
      && typeof (item as ReviewItem).artifact_id === 'string' && typeof (item as ReviewItem).sha256 === 'string'
      ? [{ artifact_id: (item as ReviewItem).artifact_id, sha256: (item as ReviewItem).sha256,
        file_name: typeof (item as ReviewItem).file_name === 'string' ? (item as ReviewItem).file_name : null }]
      : [])
  } catch { return null }
}

function readAccepted(raw: unknown): Array<{ artifact_id: string; sha256: string }> {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.flatMap((item) => typeof item === 'object' && item !== null
      && typeof (item as { artifact_id?: unknown }).artifact_id === 'string'
      && typeof (item as { sha256?: unknown }).sha256 === 'string'
      ? [{ artifact_id: (item as { artifact_id: string }).artifact_id, sha256: (item as { sha256: string }).sha256 }] : []) : []
  } catch { return [] }
}

export function createDeliveryReviewHost(db: Db, secret: string, humanOnly = false) {
  return {
    list(actor: string, runId?: string) {
      return withReadTx(db, ({ tx, as_of_seq }) => {
        if (runId) requireReviewOperator(tx, secret, actor, runId, humanOnly)
        const rows = tx.all<{ run_id: string; node_id: string; node_run_id: string; status: string;
          artifact_id: string | null; sha256: string | null; updated_at: string
          hold_id: string | null; revision: number; review_set_json: string | null; accepted_json: string | null }>(
          `SELECT h.run_id,h.node_id,n.node_run_id,
          CASE WHEN n.node_run_id=h.node_run_id THEN h.status ELSE 'held' END AS status,
          h.artifact_id,h.sha256,h.updated_at,h.hold_id,h.revision,h.review_set_json,h.accepted_json
          FROM delivery_review_holds h
          JOIN node_runs n ON n.run_id=h.run_id AND n.node_id=h.node_id AND n.replacement_node_run_id IS NULL
          WHERE h.owner_actor=? AND (? IS NULL OR h.run_id=?) ORDER BY h.updated_at DESC LIMIT 150`,
          [actor, runId ?? null, runId ?? null])
        // 带上读到的身份与剩余应审文件：旧页签据此提交，服务端据此拒绝过期结论（D04/D03）。
        const items = rows.map(({ review_set_json: rawSet, accepted_json: rawAccepted, ...row }) => {
          const files = readReviewSet(rawSet) ?? []
          const accepted = readAccepted(rawAccepted)
          return {
            ...row,
            reviewed_files: files.map((item) => ({ artifact_id: item.artifact_id, sha256: item.sha256, file_name: item.file_name })),
            pending: files.filter((item) => !accepted.some((done) =>
              done.artifact_id === item.artifact_id && done.sha256 === item.sha256)).map((item) => item.file_name ?? item.artifact_id),
          }
        })
        return { items, as_of_seq }
      })
    },
    change(input: z.infer<typeof deliveryHoldSchema>, actor: string, now: string) {
      const body = deliveryHoldSchema.parse(input)
      return withTx(db, (tx) => runIdempotentCommand(tx, {
        kind: 'rework.hold', operationId: body.operation_id, requestHash: requestHashOf('rework.hold', { body, actor }), now,
      }, () => {
        requireReviewOperator(tx, secret, actor, body.run_id, humanOnly)
        const node = tx.get<{ node_id: string; status: string }>(`SELECT n.node_id,n.status FROM node_runs n JOIN runs r USING(run_id)
          WHERE r.run_id=? AND n.node_run_id=? AND n.node_type='agent' AND n.replacement_node_run_id IS NULL
          AND r.status='running' AND r.cancel_requested_at IS NULL`, [body.run_id, body.node_run_id])
        if (!node) throw new OrchError('STALE_GENERATION', '只能审核进行中运行的当前智能体步骤')
        const holdKey: HoldKey = { runId: body.run_id, nodeId: node.node_id, attemptId: body.node_run_id, actor }
        const seen: SeenHold | undefined = body.hold_id !== undefined && body.expected_revision !== undefined
          ? { hold_id: body.hold_id, expected_revision: body.expected_revision } : undefined
        if (body.action === 'hold') {
          // 新留验不预冻结清单：留验早于交付时冻结的会是空集，验收那一刻再按完整尝试封存（D03）。
          const started = startHold(tx, holdKey, body.operation_id, now, seen)
          appendEvent(tx, { type: 'rework.hold_hold', runId: body.run_id, nodeRunId: body.node_run_id,
            payload: { ...body, actor, hold_id: started.hold_id, revision: started.revision } })
          return { run_id: body.run_id, node_run_id: body.node_run_id, action: body.action,
            status: 'held' as const, hold_id: started.hold_id, revision: started.revision }
        }
        const current = tx.get<{ status: string; review_set_json: string | null; accepted_json: string | null;
          revision: number; hold_id: string | null; node_run_id: string }>(
          'SELECT status,review_set_json,accepted_json,revision,hold_id,node_run_id FROM delivery_review_holds WHERE run_id=? AND node_id=? AND owner_actor=?',
          [body.run_id, node.node_id, actor])
        if (!current) throw new OrchError('NOT_FOUND', '该步骤没有人工留验要求')
        if (current.status !== 'held') {
          throw new OrchError('STALE_GENERATION', '该留验已由其他页面提交，请刷新当前结论后再核对')
        }
        if (!seen) throw new OrchError('CONFIRMATION_REQUIRED', '请刷新并携带本轮留验身份后提交')
        if (seen !== undefined) {
          if (current.hold_id !== seen.hold_id || current.revision !== seen.expected_revision) {
            throw new OrchError('STALE_GENERATION', '留验已更新，请刷新当前结论后再核对')
          }
        }
        if (body.action === 'withdraw') {
          // 撤销同样服从代次：另一个页面已经提交的结论不能被悄悄撤掉（D04）。
          const withdrawn = submitHold(tx, holdKey, seen, now, null)
          appendEvent(tx, { type: 'rework.hold_withdraw', runId: body.run_id, nodeRunId: body.node_run_id,
            payload: { ...body, actor, hold_id: withdrawn.hold_id, withdrawn_revision: current.revision } })
          closeRun(tx, secret, body.run_id, now)
          return { run_id: body.run_id, node_run_id: body.node_run_id, action: body.action,
            status: 'withdrawn' as const, hold_id: withdrawn.hold_id, revision: withdrawn.revision }
        }
        if (tx.get(`SELECT 1 FROM rework_requests WHERE run_id=?
          AND (target_node_run_id=? OR new_node_run_id=?)
          AND status NOT IN ('closed','declined','cancelled')`, [body.run_id, body.node_run_id, body.node_run_id])) {
          throw new OrchError('STALE_GENERATION', '该步骤正在返工，请在修订成果待办中提交验收')
        }
        const artifact = tx.get<{ bytes: Uint8Array }>(`SELECT c.bytes FROM artifacts a JOIN artifact_contents c USING(artifact_id)
          WHERE a.run_id=? AND c.node_run_id=? AND a.artifact_id=? AND a.sha256=? AND (a.retain_until IS NULL OR a.retain_until>?)`,
        [body.run_id, body.node_run_id, body.artifact_id, body.sha256, now])
        if (node.status !== 'done' || !artifact || sha256Hex(Buffer.from(artifact.bytes)) !== body.sha256) {
          throw new OrchError('CONFIRMATION_MISMATCH', '成果版本与当前已完成步骤不符')
        }
        // 本轮应审清单：已封存就按封存件核对；未封存则按当前已完成尝试与计划必交件封存一次（D03）。
        // 同名旧版不能替换最新版本或已封存版本，更不能借新版的字节数通过必交条件。
        const sealed = reviewFilesForDoneAttempt(tx, body.run_id, body.node_run_id, node.node_id, now, current.review_set_json)
        const files = sealed
        if (!files.some((item) => item.artifact_id === body.artifact_id && item.sha256 === body.sha256)) {
          throw new OrchError('CONFIRMATION_MISMATCH', '这份成果不在本次应审清单内，请刷新后核对当前版本')
        }
        const previous = readAccepted(current.accepted_json)
        const next = advanceReview(files, previous, { artifact_id: body.artifact_id, sha256: body.sha256 })
        const submitted = submitHold(tx, holdKey, seen, now, {
          files,
          accepted: next.accepted,
          complete: next.complete,
          file: { artifact_id: body.artifact_id, sha256: body.sha256 },
        })
        appendEvent(tx, { type: 'rework.hold_accept', runId: body.run_id, nodeRunId: body.node_run_id,
          payload: { ...body, actor, hold_id: submitted.hold_id, revision: submitted.revision, pending: next.pending.length } })
        if (!next.complete) {
          return { run_id: body.run_id, node_run_id: body.node_run_id, action: body.action,
            status: 'held' as const, pending: next.pending.map((item) => item.file_name ?? item.artifact_id),
            hold_id: submitted.hold_id, revision: submitted.revision }
        }
        closeRun(tx, secret, body.run_id, now)
        return { run_id: body.run_id, node_run_id: body.node_run_id, action: body.action,
          status: 'accepted' as const, hold_id: submitted.hold_id, revision: submitted.revision }
      }).result)
    },
  }
}
