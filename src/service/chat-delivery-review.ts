import type { Db } from '../infra/sqlite/driver.ts'
import { getArtifactContent, type RunArtifact } from './queries/artifacts.ts'
import { readRunNodeDisplay } from './queries/nodes.ts'
import { withReadTx } from './queries/read-tx.ts'
import { readApprovedTaskPlanForRun } from './task-planning.ts'

export type ChatDeliveryReview = {
  title: string
  step: string
  nodeRunId: string
  nodeRevision: number
  requestedAt?: string
  hold?: { hold_id: string; expected_revision: number }
  /** 留验可能还没有任何成果文件：这时只给"补交或撤销"，不能装作可验收（D06）。 */
  artifact: RunArtifact | null
  runId: string
  criteria: string[]
  otherArtifacts: boolean
  revised?: { requestId: string; revision: number; round: number }
  preview?: string
}

export function listChatDeliveryReviews(db: Db, runId: string, actor: string, now = Date.now()): ChatDeliveryReview[] {
  const at = new Date(now).toISOString()
  return withReadTx(db, ({ tx }) => {
    const rows = tx.all<{
      title: string; run_id: string; node_id: string; node_run_id: string; node_revision: number; artifact_id: string | null; file_name: string | null
      sha256: string | null; retain_until: string | null; created_at: string | null; size_bytes: number | null; target_count: number
      hold_id: string | null; hold_revision: number | null; request_id: string | null; request_revision: number | null; round_no: number | null; expected_result: string | null; requested_at: string
    }>(`WITH targets AS (
      SELECT h.run_id,n.node_id,n.node_run_id,n.revision AS node_revision,h.updated_at AS requested_at,
        h.hold_id,h.revision AS hold_revision,NULL AS request_id,NULL AS request_revision,NULL AS round_no,NULL AS expected_result,
        h.review_set_json AS review_set,h.accepted_json AS accepted
      FROM delivery_review_holds h JOIN node_runs n ON n.run_id=h.run_id AND n.node_id=h.node_id
      WHERE h.run_id=? AND h.owner_actor=? AND (h.status='held' OR h.node_run_id<>n.node_run_id)
        AND n.replacement_node_run_id IS NULL AND n.status='done'
        AND NOT EXISTS (SELECT 1 FROM rework_requests q WHERE q.run_id=h.run_id
          AND (q.target_node_run_id=n.node_run_id OR q.new_node_run_id=n.node_run_id)
          AND q.status NOT IN ('closed','declined','cancelled'))
      UNION ALL
      SELECT q.run_id,n.node_id,n.node_run_id,n.revision,q.updated_at,NULL,NULL,q.request_id,q.revision,q.round_no,q.expected_result,
        COALESCE(w.result_manifest_json,json_array(json_object('artifact_id',w.result_artifact_id,'sha256',w.result_artifact_hash))),w.accepted_files_json
      FROM rework_requests q JOIN rework_attempts w ON w.request_id=q.request_id AND w.round_no=q.round_no
      JOIN node_runs n ON n.run_id=q.run_id AND n.node_run_id=q.new_node_run_id AND n.node_run_id=w.new_node_run_id
      WHERE q.run_id=? AND q.owner_actor=? AND q.status='awaiting_review' AND q.expires_at>?
        AND w.status='awaiting_review' AND n.status='done' AND n.replacement_node_run_id IS NULL
    ), versions AS (
      SELECT c.*,row_number() OVER(PARTITION BY c.node_run_id,c.file_name ORDER BY a.created_at DESC,a.artifact_id DESC) AS version_rank
      FROM artifact_contents c JOIN artifacts a USING(artifact_id) WHERE a.run_id=?
    )
    SELECT task.title,g.run_id,g.node_id,g.node_run_id,g.node_revision,g.requested_at,g.hold_id,g.hold_revision,g.request_id,g.request_revision,g.round_no,g.expected_result,
      a.artifact_id,c.file_name,a.sha256,a.retain_until,a.created_at,length(c.bytes) AS size_bytes,
      count(*) OVER (PARTITION BY g.node_run_id,g.request_id) AS target_count
    FROM targets g JOIN runs r ON r.run_id=g.run_id JOIN tasks task ON task.task_id=r.task_id
    LEFT JOIN versions c ON c.node_run_id=g.node_run_id
    LEFT JOIN artifacts a ON a.artifact_id=c.artifact_id AND a.run_id=r.run_id
    WHERE r.status='running' AND r.cancel_requested_at IS NULL
      AND ((g.review_set IS NULL AND (c.version_rank=1 OR c.artifact_id IS NULL)) OR EXISTS (
        SELECT 1 FROM json_each(g.review_set) f WHERE json_extract(f.value,'$.artifact_id')=a.artifact_id
          AND json_extract(f.value,'$.sha256')=a.sha256))
      AND NOT EXISTS (SELECT 1 FROM json_each(g.accepted) f
        WHERE json_extract(f.value,'$.artifact_id')=a.artifact_id AND json_extract(f.value,'$.sha256')=a.sha256)
    ORDER BY g.node_run_id,a.created_at,a.artifact_id LIMIT 8`, [runId, actor, runId, actor, at,runId])
    if (!rows.length) return []
    const { nodes } = readRunNodeDisplay(tx, runId)
    const plan = readApprovedTaskPlanForRun(tx, runId)
    return rows.map((row) => {
      const step = nodes.get(row.node_id)?.title
      const plannedStep = plan?.proposal.steps.find((entry) => entry.node_id === row.node_id)
      const deliverables = plan?.proposal.deliverables.filter((entry) => entry.node_id === row.node_id).map((entry) => entry.title) ?? []
      const requirements = plan?.brief.requirements.filter((entry) => plannedStep?.goal_ids.includes(entry.id)).map((entry) => entry.text) ?? []
      const criteria = [...new Set([row.expected_result, plannedStep?.description, ...requirements, ...deliverables]
        .filter((entry): entry is string => Boolean(entry)))].slice(0, 6)
      return {
        title: row.title, step: step && step !== row.node_id ? step : '步骤名称未记录',
        nodeRunId: row.node_run_id, nodeRevision: row.node_revision, requestedAt: row.requested_at, criteria,
        otherArtifacts: row.target_count > 1,
        ...(row.hold_id && row.hold_revision ? {hold:{hold_id:row.hold_id,expected_revision:row.hold_revision}} : {}),
        ...(row.request_id && row.request_revision !== null && row.round_no !== null
          ? { revised: { requestId: row.request_id, revision: row.request_revision, round: row.round_no } } : {}),
        runId: row.run_id,
        artifact: row.artifact_id && row.sha256 && row.created_at
          ? {
            run_id: runId, artifact_id: row.artifact_id, sha256: row.sha256, file_name: row.file_name ?? undefined,
            source_node_run_id: row.node_run_id, size_bytes: row.size_bytes ?? undefined, created_at: row.created_at,
            retain_until: row.retain_until, expired: row.retain_until !== null && !(Date.parse(row.retain_until) > now),
          }
          : null,
      }
    })
  })
}

export function attachChatDeliveryPreviews(db: Db, reviews: ChatDeliveryReview[]) {
  return reviews.map((review) => {
    const file = review.artifact
    if (!file || file.expired || (file.size_bytes ?? Infinity) > 4096) return review
    try {
      const { item } = getArtifactContent(db, file.run_id, file.artifact_id, 'preview', Date.now())
      if (item.kind === 'preview' && !item.truncated && item.sha256 === file.sha256) return { ...review, preview: item.text }
    } catch { /* Keep the exact file link available without displaying unverified content. */ }
    return review
  })
}

export function formatDeliveryReviewNotice(review: ChatDeliveryReview) {
  const line = (value: string) => {
    const text = value.replace(/\s+/gu, ' ').trim()
    return text.length > 200 ? text.slice(0, 199) + '…' : text
  }
  const file = review.artifact ? line(review.artifact.file_name ?? '未命名成果') : '还没有登记成果文件'
  return [
    '任务　' + line(review.title),
    '步骤　' + line(review.step),
    '待审成果　' + file + (review.revised ? `（第 ${review.revised.round} 轮修订）` : ''),
    // 无文件时不能说「已交付」：这一步已结束，但没有可核对的内容（D06）。
    '审核原因　' + (review.revised ? '修订已完成，请核对本轮成果是否达到要求。'
      : review.artifact ? '该步骤已交付，当前运行等待人工验收。' : '步骤已结束，尚无可核对文件，当前运行等待人工处理。'),
    '审核标准　' + (review.criteria.length ? review.criteria.slice(0, 4).map(line).join('、') : '请对照原始任务要求核对成果。'),
    '处理方式　' + (!review.artifact ? '先提交这一步的成果文件，或撤销这次留验让运行继续收尾。'
      : review.artifact.expired ? '成果已过期，请在 Orchestra 的任务结果中核对登记。'
      : review.otherArtifacts ? '该步骤登记了多份成果，请在任务结果中核对完整交付后提交结论。'
        : '先查看成果，再选择「通过验收」或填写修改意见。'),
  ].join('\n')
}
