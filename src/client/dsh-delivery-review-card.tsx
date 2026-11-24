import { useMemo, useRef, useState } from 'react'
import { ApiError, createApiClient } from './api/client.ts'
import { createResourcesApi } from './api/resources.ts'
import { createReworkApi } from './api/rework.ts'
import { createLocalSessionFetcher, localPanelBase, type DshLocalPanelSources } from './dsh-local-panel.tsx'
import { ArtifactContent, useArtifactRetention } from './panel/artifact-content.tsx'
import { mayReview, type AcquiredVersion } from './panel/acquired-version.ts'
import { operatorReason } from '../core/operator-language.ts'
import type { ChatDeliveryReview } from '../service/chat-delivery-review.ts'

export type DshDeliveryReview = { workspaceId: string; sessionId: string; reviews: ChatDeliveryReview[] }

export function DshDeliveryReviewCard({ scope, sources }: { scope: DshDeliveryReview; sources: DshLocalPanelSources }) {
  const client = useMemo(() => createApiClient(localPanelBase, createLocalSessionFetcher(sources, scope.workspaceId, scope.sessionId)),
    [sources, scope.workspaceId, scope.sessionId])
  const api = useMemo(() => createResourcesApi(client), [client])
  const commands = useMemo(() => createReworkApi(client), [client])
  return <section aria-label="待审成果">
    {scope.reviews.map((review) => <Review key={(review.artifact?.artifact_id ?? review.nodeRunId) + ':' + (review.revised?.revision ?? review.nodeRevision)}
      review={review} api={api} commands={commands} />)}
  </section>
}

function Review({ review, api, commands }: {
  review: ChatDeliveryReview; api: ReturnType<typeof createResourcesApi>; commands: ReturnType<typeof createReworkApi>
}) {
  const { revised } = review
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState('')
  const [expected, setExpected] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [unconfirmed, setUnconfirmed] = useState<string>()
  // 没有会话内全文时，先真正取得并核验这一版；只勾选「已打开」不构成已读（D08）。
  const [acquired, setAcquired] = useState<AcquiredVersion | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const locked = useRef(false)
  const retention = useArtifactRetention(review.artifact ?? undefined)
  const readInChat = review.preview !== undefined
  const artifactFile = review.artifact
  const readable = artifactFile ? mayReview(artifactFile, acquired, readInChat, acknowledged) : false
  const enabled = retention === 'available' && !review.otherArtifacts && !busy && !notice && !unconfirmed && readable

  // 没有成果文件的留验只能补交或撤销，不给验收动作（D06）。
  if (!review.artifact) return <PendingDelivery review={review} commands={commands} />
  const artifact = review.artifact
  async function submit(action: 'accept' | 'request_changes') {
    if (!enabled || locked.current || action === 'request_changes' && (!reason.trim() || !revised && !expected.trim())) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      if (revised) {
        const result = await commands.review({ request_id: revised.requestId, expected_revision: revised.revision, action,
          note: action === 'accept' ? '人工验收通过' : reason.trim(), artifact_id: artifact.artifact_id, artifact_hash: artifact.sha256 })
        if (result.status === 'escalated') {
          setNotice('已登记修改意见。本轮返工预算已用完，请在 Orchestra 处理升级。')
          return
        }
      } else {
        const { data } = await commands.listHolds(artifact.run_id)
        const hold = data.items.find((item) => item.status === 'held' && item.node_run_id === review.nodeRunId)
        if (!hold) {
          setNotice('这条待办已处理或成果版本已更新。请刷新任务结果。')
          return
        }
        // 把读到的留验身份带回去：另一个页签已经换代时，这次结论必须失败（D04）。
        const seen = hold.hold_id ? { hold_id: hold.hold_id, expected_revision: hold.revision } : {}
        if (action === 'accept') await commands.hold({ run_id: artifact.run_id, node_run_id: review.nodeRunId, action: 'accept',
          ...seen, artifact_id: artifact.artifact_id, sha256: artifact.sha256 })
        else {
          const result = await commands.request({ run_id: artifact.run_id, target_node_run_id: review.nodeRunId,
            source_artifact_id: artifact.artifact_id, source_artifact_hash: artifact.sha256, expected_revision: review.nodeRevision,
            reason: reason.trim(), expected_result: expected.trim(), preserve_requirements: [], suggested_scope: 'targeted_revision', evidence_ids: [] })
          if (result.status === 'scheduled') {
            setNotice('已登记修改意见，原步骤已排队返工。')
            return
          }
        }
      }
      setNotice(action === 'accept' ? '已经通过此版本的验收。' : '已登记修改意见。返工按任务的授权流程处理。')
    } catch (cause) {
      setError(cause instanceof Error ? operatorReason(cause.message) : '提交未完成。')
      if (cause instanceof ApiError && cause.code === 'OPERATION_OUTCOME_UNKNOWN') {
        const details = cause.details as { operation_id?: string } | undefined
        if (details?.operation_id) setUnconfirmed(details.operation_id)
      }
    } finally {
      locked.current = false
      setBusy(false)
    }
  }

  async function checkReceipt(operation: string) {
    try {
      const { data } = await commands.getOperation(operation)
      if (data.status === 'applied') setNotice('操作已生效。')
      else setError('原操作尚未确认。请在 Orchestra 的任务结果中核对后再处理。')
    } catch { setError('暂时无法查询原操作回执。') }
  }

  return <article style={{ border: '1px solid var(--dsw-alias-divider, #d5dee8)', borderRadius: 8, padding: 12, marginTop: 8, overflowWrap: 'anywhere' }}>
    <h4 style={{ margin: '0 0 8px' }}>成果待审核</h4>
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '6px 12px', margin: 0 }}>
      {[
        ['任务', review.title], ['步骤', review.step], ['待审成果', artifact.file_name ?? '未命名成果'],
        ['审核原因', revised ? `第 ${revised.round} 轮修订已完成` : '该步骤的交付要求人工验收'],
      ].map(([label, value]) => <div key={label} style={{ display: 'contents' }}><dt>{label}</dt><dd style={{ margin: 0 }}>{value}</dd></div>)}
      <dt>审核标准</dt>
      <dd style={{ margin: 0 }}>{review.criteria.length
        ? <ul style={{ margin: 0, paddingInlineStart: '1.25em' }}>{review.criteria.map(criterion => <li key={criterion}>{criterion}</li>)}</ul>
        : '对照原始任务要求核对成果'}</dd>
    </dl>
    {review.preview !== undefined && retention === 'available' && <pre aria-label="待审成果全文" style={{
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 250, overflow: 'auto', padding: 10, border: '1px solid #d5dee8',
    }}>{review.preview}</pre>}
    <ArtifactContent api={api} artifact={artifact} onAcquired={setAcquired} />
    {review.otherArtifacts ? <p>这个步骤还有其他成果。请在 Orchestra 的任务结果中核对完整交付再提交结论。</p>
      : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {!readInChat && retention === 'available' && <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={acknowledged} disabled={acquired === null} onChange={event => setAcknowledged(event.currentTarget.checked)} />
          我已打开这一版成果
        </label>}
        <button type="button" disabled={!enabled || editing} onClick={() => void submit('accept')}>通过验收</button>
        <button type="button" disabled={!enabled || editing} aria-expanded={editing} onClick={() => setEditing(!editing)}>要求修改</button>
      </div>}
    {editing && !notice && <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
      <label>具体修改意见<textarea value={reason} maxLength={2500} rows={3} onChange={event => setReason(event.currentTarget.value)} style={{ display: 'block', width: '100%' }} /></label>
      {!revised && <label>期望结果<textarea value={expected} maxLength={2500} rows={2} onChange={event => setExpected(event.currentTarget.value)} style={{ display: 'block', width: '100%' }} /></label>}
      <button type="button" disabled={!enabled || !reason.trim() || !revised && !expected.trim()} onClick={() => void submit('request_changes')}>提交修改意见</button>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && !notice && <p role="alert">{error}</p>}
    {unconfirmed && !notice && <button type="button" onClick={() => void checkReceipt(unconfirmed)}>核对提交回执</button>}
  </article>
}


/** 留验了但还没有成果文件：说明真实等待原因，并给撤销入口（D06）。 */
function PendingDelivery({ review, commands }: {
  review: ChatDeliveryReview; commands: ReturnType<typeof createReworkApi>
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  async function withdraw() {
    if (busy) return
    setBusy(true); setError('')
    try {
      await commands.hold({ run_id: review.runId, node_run_id: review.nodeRunId, action: 'withdraw' })
      setNotice('已撤销这次留验，运行会继续收尾。')
    } catch (cause) {
      setError(cause instanceof ApiError ? operatorReason(cause.message) : '撤销未完成，请稍后重试')
    } finally { setBusy(false) }
  }
  return <article aria-label="待审成果">
    <h3>{review.title} · {review.step}</h3>
    <p>这一步已经留验，但还没有登记任何成果文件。补交成果后再验收，或者撤销留验让运行继续收尾。</p>
    {review.criteria.length > 0 && <ul>{review.criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>}
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <button type="button" disabled={busy || Boolean(notice)} onClick={() => void withdraw()}>撤销留验</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && !notice && <p role="alert">{error}</p>}
  </article>
}
