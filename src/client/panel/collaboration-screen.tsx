import { useEffect, useRef, useState } from 'react'
import { ApiError, type ApiClient } from '../api/client.ts'
import { CollaborationMembers, type SelectedMember } from './collaboration-members.tsx'
import { postWithOperationReceipt } from '../api/commands.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import type { CollaborationHost } from '../../service/collaboration.ts'
import { PanelCommandButton } from './shell.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

type Summary = ReturnType<CollaborationHost['listScopes']>['items'][number]
type ScopeDetail = ReturnType<CollaborationHost['getScope']>['item']
type Action = 'authorize' | 'deny' | 'adopt' | 'dismiss' | 'reassign'
const LABELS: Record<string, string> = {
  proposed: '待授权', authorized: '已授权，等接收方读取', delivered: '已送达', accepted: '已接手',
  completed: '核验完成', rejected: '接收方拒绝', denied: '主理人拒绝', expired: '已到期', withdrawn: '已撤回',
  confirmed: '已证实', refuted: '已反证', inconclusive: '证据未能定论', adopted: '已采纳', dismissed: '未采纳',
}
const ACTIONS: Record<Action, string> = {
  authorize: '授权核验', deny: '拒绝请求', adopt: '采纳结论', dismiss: '不采纳结论', reassign: '重新指派',
}

export function CollaborationScreen({ client, reloadVersion, onSnapshot, onOpenRun }: {
  client: ApiClient; reloadVersion: number; onSnapshot: (seq: number) => void; onOpenRun: (task: string, run: string) => void
}) {
  const [scopes, setScopes] = useState<Summary[]>()
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<ScopeDetail>()
  const [retry, refresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [failed, setFailed] = useState(false)
  const [title, setTitle] = useState('')
  const [members, setMembers] = useState<SelectedMember[]>([])
  const [creating, setCreating] = useState(false)
  const pending = useRef(new Map<string, string>())
  const [minutes, setMinutes] = useState(60)
  const [review, setReview] = useState<{ id: string; revision: number; action: Action }>()
  const [note, setNote] = useState('')
  const [replacement, setReplacement] = useState('')
  const scopeId = selected || scopes?.[0]?.scope_id

  useEffect(() => {
    let current = true
    void client.get<{ items: Summary[] }>('/v1/collaboration/scopes').then(({ data, as_of_seq }) => {
      if (current) { setScopes(data.items); onSnapshot(as_of_seq) }
    }).catch(() => { if (current) { setFailed(true); setNotice('协作范围读取失败。') } })
    return () => { current = false }
  }, [client, onSnapshot, reloadVersion, retry])
  useEffect(() => {
    if (!scopeId) return
    let current = true
    void client.get<ScopeDetail>('/v1/collaboration/scopes/get', { scope_id: scopeId }).then(({ data, as_of_seq }) => {
      if (current) { setDetail(data); onSnapshot(as_of_seq) }
    }).catch(() => { if (current) { setFailed(true); setNotice('核验详情读取失败。') } })
    return () => { current = false }
  }, [client, scopeId, onSnapshot, reloadVersion, retry])

  async function command(path: string, kind: string, body: Record<string, unknown>, done: () => void) {
    if (busy) return
    const key = JSON.stringify([kind, body])
    const id = pending.current.get(key) ?? newOperationId()
    pending.current.set(key, id)
    setNotice(''); setFailed(false); setBusy(true)
    try {
      await postWithOperationReceipt(client, path, kind, { ...body, operation_id: id })
      pending.current.delete(key)
      done(); refresh((value) => value + 1); setNotice('已记录。')
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'OPERATION_OUTCOME_UNKNOWN')) pending.current.delete(key)
      setFailed(true); setNotice(error instanceof Error ? error.message : '操作结果暂不可确认。')
    }
    finally { setBusy(false) }
  }
  const memberIds = members.map((member) => member.id).sort()
  const shown = detail?.scope.scope_id === scopeId ? detail : undefined
  return <section className="ops-page">
    <header className="ops-page-header"><h1>协作核验</h1>
      {scopes && scopes.length > 0 && <label className="ops-actions">协作范围 <select className="ops-field" value={scopeId} onChange={(event) => {
        setSelected(event.target.value); setReview(undefined)
      }}>{scopes.map((scope) => <option key={scope.scope_id} value={scope.scope_id}>{scope.title}</option>)}</select></label>}
    </header>
    <p className="ops-meta">让一个执行步骤独立复核另一个步骤的发现。例如，分析步骤发现汇总金额有误，可请复核步骤重算，再由你决定是否采纳。</p>
    <details className="ops-surface ops-inset" open={creating} onToggle={(event) => setCreating(event.currentTarget.open)}>
      <summary>选择可相互核验的步骤</summary>
      <form style={form} onSubmit={(event) => {
        event.preventDefault()
        void command('/v1/collaboration/scopes', 'collaboration.scope_create',
          { title: title.trim(), node_run_ids: memberIds, ttl_minutes: minutes }, () => { setTitle(''); setMembers([]); setSelected(''); setCreating(false) })
      }}>
        <label>本次核验名称 <input required maxLength={200} placeholder="例如：复核月报汇总金额" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        {creating && <CollaborationMembers client={client} selected={members} onChange={setMembers} disabled={busy} />}
        <label>允许提出核验的时长（分钟） <input type="number" required min={1} max={10_080} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>
        <p className="ops-meta">保存后，选中的步骤可在范围内提出带证据的请求。出现请求时，在这里选择「授权核验」。</p>
        <PanelCommandButton type="submit" disabled={busy || !title.trim() || memberIds.length < 2 || memberIds.length > 16}>保存范围</PanelCommandButton>
      </form>
    </details>
    {notice && <p role={failed ? 'alert' : 'status'}>{notice} {failed && <button type="button" onClick={() => refresh((value) => value + 1)}>刷新</button>}</p>}
    {!scopes && !failed && <p role="status">正在读取协作范围…</p>}
    {scopes?.length === 0 && <p className="ops-surface ops-empty">还没有协作范围。</p>}
    {shown && <>
      <section style={card}><div className="ops-toolbar"><strong>参与节点</strong><span className="ops-meta">有效至 {new Date(shown.scope.expires_at).toLocaleString()}</span></div>
        <div className="ops-actions">{shown.members.map((node) => <button className="ops-button ops-button--link"
          key={node.node_run_id} type="button" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}
          title={node.node_run_id} onClick={() => onOpenRun(node.task_id, node.run_id)}>{node.node_id}</button>)}</div>
      </section>
      {shown.findings.map((finding) => <article key={finding.finding_id} style={card}>
        <h2 style={{ margin: 0, fontSize: FONT_PX.section }}>{finding.title}</h2>
        <p>{finding.summary}</p><p>原始系统证据 <code>{finding.evidence_id}</code></p>
        {shown.requests.filter((request) => request.finding_id === finding.finding_id).map((request) => {
          const candidates = request.reassignment_candidates
          const actions: Action[] = request.status === 'proposed' ? candidates === null ? ['authorize', 'deny'] : ['deny']
            : request.status === 'completed' && request.adoption === null ? ['adopt', 'dismiss'] : []
          if (candidates?.length) actions.push('reassign')
          return <section id={request.request_id} key={request.request_id} style={{ borderTop: `1px solid ${COLOR.line}`, marginTop: 10, paddingTop: 10 }}>
            <strong>{LABELS[request.status] ?? request.status}</strong>
            {request.withdrawn_from_status && <span> · 撤回前{LABELS[request.withdrawn_from_status]}</span>}
            <p>{request.question}</p>
            <p>接收节点 <code>{request.target_node_run_id}</code></p>
            {request.target_attempt !== null && <p>执行轮次 {request.target_attempt} · 代次 {request.target_generation}</p>}
            {request.replacement_request_id && <p><a href={'#' + request.replacement_request_id}>查看重新指派的请求</a></p>}
            {request.replaces_request_id && <p><a href={'#' + request.replaces_request_id}>查看已撤回的请求</a></p>}
            {candidates?.length === 0 && <p>当前协作范围内没有可用的替代接收方。</p>}
            {request.authorization_note && <p>派发记录 · {request.authorization_note}</p>}
            {request.result && <p>{LABELS[request.verdict ?? '']} · {request.result} · <code>{request.evidence_id}</code></p>}
            {request.adoption && <p>{LABELS[request.adoption]} · {request.adoption_note}</p>}
            {actions.map((action) => <PanelCommandButton key={action} disabled={busy} onClick={() => {
              setReview({ id: request.request_id, revision: request.revision, action }); setNote(''); setReplacement('')
            }}>{ACTIONS[action]}</PanelCommandButton>)}
            {review?.id === request.request_id && review.revision === request.revision && actions.includes(review.action) && <form style={form} onSubmit={(event) => {
              event.preventDefault()
              const base = { request_id: review.id, expected_revision: review.revision, note: note.trim() }
              if (review.action === 'reassign') {
                void command('/v1/collaboration/reassign', 'collaboration.reassign', { ...base, target_node_run_id: replacement }, () => setReview(undefined))
              } else {
                void command('/v1/collaboration/review', 'collaboration.review', { ...base, action: review.action }, () => setReview(undefined))
              }
            }}>
              {review.action === 'reassign' && <label>新接收节点 <select required value={replacement} onChange={(event) => setReplacement(event.target.value)}>
                <option value="">选择接收节点</option>
                {candidates?.map((id) => <option key={id} value={id}>{shown.members.find((node) => node.node_run_id === id)?.node_id ?? id} · {id}</option>)}
              </select></label>}
              <label>处理理由 <textarea required maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
              <PanelCommandButton type="submit" disabled={busy || !note.trim()
                || (review.action === 'reassign' && !candidates?.includes(replacement))}>确认{ACTIONS[review.action]}</PanelCommandButton>
            </form>}
          </section>
        })}
      </article>)}
      {shown.findings.length === 0 && <p>参与步骤已选好。执行者提交发现后，这里会显示原始证据和待授权的核验请求。</p>}
    </>}
  </section>
}

const card = { border: '1px solid #dde4ed', background: COLOR.surface, borderRadius: 8, padding: '9px 12px', overflowWrap: 'anywhere' as const }
const form = { display: 'grid', gap: 7, marginTop: 8, maxWidth: 540 }
