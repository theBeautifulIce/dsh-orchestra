import { useEffect, useState } from 'react'
import { ApiError } from '../api/client.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { AttestationView, EvidenceView, NodeRunView } from '../api/types.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { operatorReason } from '../../core/operator-language.ts'

type EvidenceReference = { kind: 'tool' | 'human'; id: string; label: string }

const TOOL_ACTIONS = new Map([
  ['workspace_read_sample', '读取已授权的工作区资料'],
  ['workspace_list', '列出获准查看的工作区目录'],
])

export function evidenceToolLabel(tool: string, fallback: string): string {
  return TOOL_ACTIONS.get(tool) ?? fallback
}

export function NodeEffectFacts({ node, onOpenDecision }: { node: NodeRunView; onOpenDecision?: (id: string) => void }) {
  const effectLabel = (value: string | null) => value === 'applied' ? '外部操作已发生'
    : value === 'not_applied' ? '外部操作未发生' : null
  const declared = effectLabel(node.declared_effect)
  const verified = effectLabel(node.verified_effect)
  const settled = node.evidence_state === 'settled' && verified
  const readOnly = node.evidence_state === 'not_required' && node.side_effect_policy === 'pure'
  const mismatch = declared && settled && declared !== verified
  const decisionId = node.effect_decision_id
  const reason = node.evidence_state_reason && operatorReason(node.evidence_state_reason)
  if (readOnly && !declared) return <p style={mutedStyle}>{reason || '此步骤按只读策略执行，无需核验外部操作。'}</p>
  const headline = mismatch ? '声明与核实结果不一致'
    : readOnly ? '只读步骤'
      : settled ? `已核验 · ${verified}`
        : node.evidence_state === 'unverified' ? '外部操作待核验'
          : '缺少外部操作核验记录'
  const basis = node.effect_resolution_basis === 'decision' ? '依据已批准的决定及其引用的系统证据。'
    : node.effect_resolution_basis === 'verified_none' ? '依据账本中的停止或未发生记录。'
      : node.effect_resolution_basis === 'evidence' ? '依据系统核验证据。' : null
  return <div style={mismatch ? { ...evidenceStyle, background: '#fff8e9', color: COLOR.warning } : evidenceStyle}>
    <strong>{headline}</strong>
    <dl className="task-run-facts">
      {(!readOnly || declared) && <div><dt>步骤声明</dt><dd>{declared ?? '无声明记录'}</dd></div>}
      {mismatch && <div><dt>核验结果</dt><dd>{verified}</dd></div>}
    </dl>
    {(basis ?? reason) && <p style={mutedStyle}>{basis ?? reason}</p>}
    {mismatch && decisionId && onOpenDecision &&
      <button type="button" className="ops-button" onClick={() => onOpenDecision(decisionId)}>查看相关决定</button>}
  </div>
}

export function NodeEvidence({ api, node, reloadVersion, onOpenDecision }: {
  api: ResourcesApi; node: NodeRunView; reloadVersion: number; onOpenDecision?: (id: string) => void
}) {
  const refs: EvidenceReference[] = (node.execution_ids ?? []).map((id, index) => ({ kind: 'tool', id, label: `工具执行记录 ${index + 1}` }))
  if (node.attestation_id) refs.push({ kind: 'human', id: node.attestation_id, label: '人工签认' })
  return <>
    <NodeEffectFacts node={node} onOpenDecision={onOpenDecision} />
    {!refs.length && <p style={mutedStyle}>这次尝试没有关联工具记录或人工签认。</p>}
    {refs.map((ref) => <EvidenceRecord key={`${ref.kind}-${ref.id}`} api={api} node={node} record={ref} reloadVersion={reloadVersion} />)}
  </>
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
      } else if (record.kind !== 'human' || data.attestation_id !== record.id || data.action_start_source !== 'human_attested'
        || data.run_id !== node.run_id || data.node_run_id !== node.node_run_id || data.attempt !== node.attempt) {
        throw new Error('签认与当前记录不匹配')
      }
      if (current) setVerified(data)
    }).catch((error: unknown) => {
      if (!current) return
      const unverified = error instanceof ApiError && error.code === 'EVIDENCE_SOURCE_UNAVAILABLE'
      const missing = error instanceof ApiError && error.code === 'NOT_FOUND'
      setFailure(record.kind === 'human' ? '暂时无法读取这条签认。'
        : missing ? '未找到这条工具执行记录。'
          : unverified ? '这条执行记录尚未通过系统核验。' : '暂时无法确认这条系统证据。')
    })
    return () => { current = false }
  }, [api, node.attempt, node.node_run_id, node.run_id, open, record.id, record.kind, reloadVersion])
  return <details style={evidenceStyle} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{verified && 'evidence_id' in verified ? evidenceToolLabel(verified.tool, `已核对的${record.label}`) : record.label}</summary>
    {open && failure && <p role="status" style={mutedStyle}>{failure}</p>}
    {open && !verified && !failure && <p role="status" style={mutedStyle}>正在读取…</p>}
    {verified && ('evidence_id' in verified ? <>
      <p><strong>{verified.exit_code === 0 ? '只读工具正常退出' : '只读工具返回非零退出码'}</strong> · 退出码 {verified.exit_code}</p>
      <p style={mutedStyle}>系统已核对这次调用的记录。交付产物是否符合要求，请查看交付验收。</p>
      <details>
        <summary>查看核验明细</summary>
        <p style={mutedStyle}>工具 <code>{verified.tool}</code> · 记录于 {formatDate(verified.observed_at)}</p>
        {verified.execution_boundary === 'dsh_workspace_rpc' && <p style={mutedStyle}>执行环境为 DSH 工作区固定读取接口。</p>}
        {verified.execution_boundary === 'windows_appcontainer_bfs' && <p style={mutedStyle}>执行环境为 Windows AppContainer 只读工作区。</p>}
        <p style={mutedStyle}>证据编号 <code>{verified.evidence_id}</code></p>
        {verified.stdout_hash && <p style={mutedStyle}>标准输出哈希 <code>{verified.stdout_hash}</code></p>}
        {verified.stderr_hash && <p style={mutedStyle}>标准错误哈希 <code>{verified.stderr_hash}</code></p>}
      </details>
    </> : <>
      <p><strong>{verified.claim === 'action_started' ? '有人确认操作已启动' : '已记录人工签认'}</strong></p>
      <p style={mutedStyle}>签认人 {verified.attested_by} · {formatDate(verified.attested_at)}</p>
      <p style={mutedStyle}>签认覆盖本步骤的第 {node.attempt} 次尝试，外部操作结果仍以对应核验记录为准。</p>
      {verified.summary && <p style={mutedStyle}>{verified.summary}</p>}
      <details><summary>查看签认明细</summary><p>签认编号 <code>{verified.attestation_id}</code></p></details>
    </>)}
  </details>
}

function formatDate(value: string) {
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toLocaleString() : '时间未知'
}

const evidenceStyle = { padding: '6px 0', borderTop: `1px solid ${COLOR.line}`, overflowWrap: 'anywhere' as const }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
