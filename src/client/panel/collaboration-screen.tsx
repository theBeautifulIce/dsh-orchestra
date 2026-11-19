import { useEffect, useState } from 'react'
import type { ApiClient } from '../api/client.ts'
import { postWithOperationReceipt } from '../api/commands.ts'
import { newOperationId } from '../api/workflow-commands.ts'
import type { CollaborationHost } from '../../service/collaboration.ts'
import { PanelCommandButton } from './shell.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

type Summary = ReturnType<CollaborationHost['listScopes']>['items'][number]
type ScopeDetail = ReturnType<CollaborationHost['getScope']>['item']
type Action = 'authorize' | 'deny' | 'adopt' | 'dismiss'
const LABELS: Record<string, string> = {
  proposed: '待授权', authorized: '已授权，等接收方读取', delivered: '已送达', accepted: '已接手',
  completed: '核验完成', rejected: '接收方拒绝', denied: '主理人拒绝', expired: '已到期',
  confirmed: '已证实', refuted: '已反证', inconclusive: '证据未能定论', adopted: '已采纳', dismissed: '未采纳',
}
const ACTIONS: Record<Action, string> = { authorize: '授权核验', deny: '拒绝请求', adopt: '采纳结论', dismiss: '不采纳结论' }

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
  const [members, setMembers] = useState('')
  const [minutes, setMinutes] = useState(60)
  const [review, setReview] = useState<{ id: string; revision: number; action: Action }>()
  const [note, setNote] = useState('')
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
    setNotice(''); setFailed(false); setBusy(true)
    try {
      await postWithOperationReceipt(client, path, kind, { ...body, operation_id: newOperationId() })
      done(); refresh((value) => value + 1); setNotice('已记录。')
    } catch (error) { setFailed(true); setNotice(error instanceof Error ? error.message : '操作结果暂不可确认。') }
    finally { setBusy(false) }
  }
  const memberIds = members.split(/[\s,，]+/u).filter(Boolean)
  const shown = detail?.scope.scope_id === scopeId ? detail : undefined
  return <section className="ops-page">
    <header className="ops-page-header"><h1>协作核验</h1>
      {scopes && scopes.length > 0 && <label className="ops-actions">协作范围 <select className="ops-field" value={scopeId} onChange={(event) => {
        setSelected(event.target.value); setReview(undefined)
      }}>{scopes.map((scope) => <option key={scope.scope_id} value={scope.scope_id}>{scope.title}</option>)}</select></label>}
    </header>
    <details className="ops-surface ops-inset">
      <summary>新建协作范围</summary>
      <form style={form} onSubmit={(event) => {
        event.preventDefault()
        void command('/v1/collaboration/scopes', 'collaboration.scope_create',
          { title: title.trim(), node_run_ids: memberIds, ttl_minutes: minutes }, () => { setTitle(''); setMembers('') })
      }}>
        <label>范围名称 <input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>参与节点运行 ID <textarea required placeholder="以空格或换行分隔至少两个 ID" value={members} onChange={(event) => setMembers(event.target.value)} /></label>
        <label>有效分钟数 <input type="number" required min={1} max={10_080} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>
        <PanelCommandButton type="submit" disabled={busy || memberIds.length < 2 || memberIds.length > 16}>保存范围</PanelCommandButton>
      </form>
    </details>
    {notice && <p role={failed ? 'alert' : 'status'}>{notice} {failed && <button type="button" onClick={() => refresh((value) => value + 1)}>刷新</button>}</p>}
    {!scopes && !failed && <p role="status">正在读取协作范围…</p>}
    {scopes?.length === 0 && <p className="ops-surface ops-empty">还没有协作范围。</p>}
    {shown && <>
      <section style={card}><div className="ops-toolbar"><strong>参与节点</strong><span className="ops-meta">有效至 {new Date(shown.scope.expires_at).toLocaleString()}</span></div>
        <div className="ops-actions">{shown.members.map((node) => <button className="ops-button ops-button--link"
          key={node.node_run_id} type="button" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}
          onClick={() => onOpenRun(node.task_id, node.run_id)}>{node.node_run_id}</button>)}</div>
      </section>
      {shown.findings.map((finding) => <article key={finding.finding_id} style={card}>
        <h2 style={{ margin: 0, fontSize: FONT_PX.section }}>{finding.title}</h2>
        <p>{finding.summary}</p><p>原始系统证据 <code>{finding.evidence_id}</code></p>
        {shown.requests.filter((request) => request.finding_id === finding.finding_id).map((request) => {
          const actions: Action[] = request.status === 'proposed' ? ['authorize', 'deny']
            : request.status === 'completed' && request.adoption === null ? ['adopt', 'dismiss'] : []
          return <section key={request.request_id} style={{ borderTop: `1px solid ${COLOR.line}`, marginTop: 10, paddingTop: 10 }}>
            <strong>{LABELS[request.status] ?? request.status}</strong><p>{request.question}</p>
            <p>接收节点 <code>{request.target_node_run_id}</code></p>
            {request.authorization_note && <p>派发记录 · {request.authorization_note}</p>}
            {request.result && <p>{LABELS[request.verdict ?? '']} · {request.result} · <code>{request.evidence_id}</code></p>}
            {request.adoption && <p>{LABELS[request.adoption]} · {request.adoption_note}</p>}
            {actions.map((action) => <PanelCommandButton key={action} disabled={busy} onClick={() => {
              setReview({ id: request.request_id, revision: request.revision, action }); setNote('')
            }}>{ACTIONS[action]}</PanelCommandButton>)}
            {review?.id === request.request_id && review.revision === request.revision && <form style={form} onSubmit={(event) => {
              event.preventDefault()
              void command('/v1/collaboration/review', 'collaboration.review', { request_id: review.id,
                expected_revision: review.revision, action: review.action, note: note.trim() }, () => setReview(undefined))
            }}>
              <label>处理理由 <textarea required maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
              <PanelCommandButton type="submit" disabled={busy || !note.trim()}>确认{ACTIONS[review.action]}</PanelCommandButton>
            </form>}
          </section>
        })}
      </article>)}
      {shown.findings.length === 0 && <p>当前范围暂无执行者报告的发现。</p>}
    </>}
  </section>
}

const card = { border: '1px solid #dde4ed', background: COLOR.surface, borderRadius: 8, padding: '9px 12px', overflowWrap: 'anywhere' as const }
const form = { display: 'grid', gap: 7, marginTop: 8, maxWidth: 540 }
