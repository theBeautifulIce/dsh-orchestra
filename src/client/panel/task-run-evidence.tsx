import { useEffect, useState } from 'react'
import { ApiError } from '../api/client.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { AttestationView, EvidenceView, NodeRunView } from '../api/types.ts'
import { COLOR, FONT_PX } from './tokens.ts'

type EvidenceReference = { kind: 'tool' | 'human'; id: string; label: string }

export function NodeEvidence({ api, node, reloadVersion }: { api: ResourcesApi; node: NodeRunView; reloadVersion: number }) {
  const refs: EvidenceReference[] = (node.execution_ids ?? []).map((id, index) => ({ kind: 'tool', id, label: `工具执行记录 ${index + 1}` }))
  if (node.attestation_id) refs.push({ kind: 'human', id: node.attestation_id, label: '人工签认' })
  return refs.length
    ? refs.map((ref) => <EvidenceRecord key={`${ref.kind}-${ref.id}`} api={api} node={node} record={ref} reloadVersion={reloadVersion} />)
    : <p style={mutedStyle}>这一步尚无关联证据。</p>
}

function EvidenceRecord({ api, node, record, reloadVersion }: {
  api: ResourcesApi; node: NodeRunView; record: EvidenceReference; reloadVersion: number
}) {
  const [open, setOpen] = useState(false)
  const [verified, setVerified] = useState<EvidenceView | AttestationView | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let current = true
    setVerified(null)
    setFailure(null)
    const request = record.kind === 'tool' ? api.getEvidence(record.id) : api.getAttestation(record.id)
    void request.then(({ data }) => {
      if ('evidence_id' in data) {
        if (record.kind !== 'tool' || data.strength !== 'strong' || data.source !== 'run_tool' || data.evidence_id !== record.id
          || data.run_id !== node.run_id || data.node_run_id !== node.node_run_id || data.attempt !== node.attempt) {
          throw new Error('证据与当前步骤不匹配')
        }
      } else if (record.kind !== 'human' || data.attestation_id !== record.id) throw new Error('签认与当前记录不匹配')
      if (current) setVerified(data)
    }).catch((error: unknown) => {
      if (!current) return
      const unverified = error instanceof ApiError && error.code === 'EVIDENCE_SOURCE_UNAVAILABLE'
      setFailure(record.kind === 'human' ? '暂时无法读取这条签认。'
        : unverified ? '这条执行记录暂未通过系统核验。' : '暂时无法确认这条系统证据。')
    })
    return () => { current = false }
  }, [api, node.attempt, node.node_run_id, node.run_id, open, record.id, record.kind, reloadVersion])
  return <details style={evidenceStyle} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{record.label}</summary>
    {open && failure && <p role="status" style={mutedStyle}>{failure}</p>}
    {open && !verified && !failure && <p role="status" style={mutedStyle}>正在读取…</p>}
    {verified && ('evidence_id' in verified ? <>
      <p style={mutedStyle}>系统证据（账本已核验）· {verified.tool} · 退出码 {verified.exit_code}</p>
      <p style={mutedStyle}>记录于 {formatDate(verified.observed_at)}</p>
      {verified.stdout_hash && <p style={mutedStyle}>标准输出哈希 <code>{verified.stdout_hash}</code></p>}
      {verified.stderr_hash && <p style={mutedStyle}>标准错误哈希 <code>{verified.stderr_hash}</code></p>}
    </> : <>
      <p style={mutedStyle}>{verified.classification} · {verified.attested_by} · {formatDate(verified.attested_at)}</p>
      <p style={mutedStyle}>{verified.summary ?? verified.claim}</p>
    </>)}
  </details>
}

function formatDate(value: string) {
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toLocaleString() : '时间未知'
}

const evidenceStyle = { padding: '6px 0', borderTop: `1px solid ${COLOR.line}`, overflowWrap: 'anywhere' as const }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
