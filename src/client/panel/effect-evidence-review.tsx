import { useState } from 'react'
import { postWithOperationReceipt } from '../api/commands.ts'
import type { ApiClient } from '../api/client.ts'
import type { EffectReview, ResourcesApi } from '../api/resources.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import { PanelCommandButton } from './shell.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

export function EffectEvidenceReview({ api, client, nodeId, onResolved }: {
  api: ResourcesApi; client: ApiClient; nodeId: string; onResolved: () => void
}) {
  const [review, setReview] = useState<EffectReview | null>(null)
  const [evidenceId, setEvidenceId] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  async function inspect() {
    setBusy(true)
    setNotice('')
    setReview(null)
    setEvidenceId('')
    try { setReview((await api.getEffectReview(nodeId)).data) }
    catch (error) { setNotice(error instanceof Error ? error.message : '证据查询没有完成。') }
    finally { setBusy(false) }
  }
  async function confirm() {
    if (!review?.evidence.some((item) => item.evidence_id === evidenceId)) return
    setBusy(true)
    try {
      await postWithOperationReceipt(client, '/v1/effects/resolve', 'effect.resolve', {
        node_run_id: review.node_run_id, run_id: review.run_id, basis: 'evidence', evidence_source: 'run_tool', evidence_id: evidenceId,
        expected: { revision: review.revision }, operation_id: newOperationId(),
      })
      setReview(null)
      setNotice('核实结果已记录。')
      onResolved()
    } catch (error) {
      setReview(null)
      setNotice(error instanceof Error ? error.message : '暂时无法确认核实结果。')
    } finally { setBusy(false) }
  }
  return <section aria-label="核对系统证据" style={{ display: 'grid', gap: 7, marginTop: 10 }}>
    <button type="button" onClick={() => { void inspect() }} disabled={busy} style={control}>核对系统证据</button>
    {review?.evidence.length === 0 && <p style={hint}>目前没有能用于这次核实的系统证据。</p>}
    {review?.evidence.map((item) => <label key={item.evidence_id} style={hint}>
      <input type="radio" name={`verify-${nodeId}`} value={item.evidence_id} checked={evidenceId === item.evidence_id}
        onChange={() => setEvidenceId(item.evidence_id)} disabled={busy} />
      {item.tool} · 退出码 {item.exit_code} · {new Date(item.finished_at).toLocaleString()} · {item.evidence_id}
    </label>)}
    {evidenceId && review && <PanelCommandButton style={control} disabled={busy} onClick={() => { void confirm() }}>用所选证据记录核实</PanelCommandButton>}
    {notice && <p style={hint} role="status">{notice}</p>}
  </section>
}

const control = { justifySelf: 'start', minHeight: 33, padding: '0 9px', background: COLOR.surface, border: `1px solid ${COLOR.line}`,
  borderRadius: 6, color: COLOR.ink, cursor: 'pointer', fontSize: FONT_PX.menu }
const hint = { margin: 0, color: COLOR.inkMuted, fontSize: FONT_PX.menu, overflowWrap: 'anywhere' } as const
