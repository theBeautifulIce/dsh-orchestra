import { useEffect, useRef, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { DecisionView } from '../api/types.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { UnknownState } from './shell.tsx'

const KIND_LABEL: Record<string, string> = {
  pre_execution: '执行前确认', action_overrun: '操作范围确认', abandon_ack: '停止后确认', verify_human: '人工核验',
  audit_result: '结果复核', rule_ambiguous: '规则待澄清', startup_unknown: '启动状态待确认', report_contradicted: '结果不一致',
}
const STATUS_LABEL: Record<string, string> = { pending: '待处理', acknowledged: '已接手', blocked_for_human: '等你处理' }

export type DecisionInboxProps = {
  api: ResourcesApi
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
}

export function DecisionInbox({ api, reloadVersion = 0, onSnapshot }: DecisionInboxProps) {
  const [items, setItems] = useState<DecisionView[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const lastReload = useRef(reloadVersion)

  useEffect(() => {
    if (lastReload.current !== reloadVersion) {
      lastReload.current = reloadVersion
      setCursor(undefined)
    }
  }, [reloadVersion])

  useEffect(() => {
    let current = true
    setLoading(true)
    setFailed(false)
    void api.listDecisions({ limit: 50, cursor }).then((result) => {
      if (!current) return
      setItems((previous) => cursor ? [...previous, ...result.data.items] : result.data.items)
      setNextCursor(result.data.next_cursor)
      onSnapshot?.(result.as_of_seq)
    }).catch(() => {
      if (current) setFailed(true)
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [api, cursor, retry, reloadVersion, onSnapshot])

  function refresh() { setCursor(undefined); setRetry((value) => value + 1) }
  return <section aria-labelledby="decision-inbox-title" style={{ display: 'grid', gap: 18 }}>
    <header>
      <p style={kickerStyle}>需要你关注</p>
      <h1 id="decision-inbox-title" style={titleStyle}>等你决定</h1>
      <p style={mutedStyle}>这里列出当前仍开放的决定事项。页面只展示已保存的信息，不推测缺失的策略。</p>
    </header>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <h2 style={sectionTitleStyle}>待处理事项</h2>
      <button type="button" onClick={refresh} disabled={loading} style={buttonStyle}>{loading ? '正在更新…' : '刷新'}</button>
    </div>
    {failed && <div role="alert" style={errorStyle}><span>{COPY.queryFailed}</span><button type="button" onClick={refresh} style={buttonStyle}>{COPY.retry}</button></div>}
    {loading && <p role="status" style={mutedStyle}>正在读取决定事项…</p>}
    {!loading && !failed && items.length === 0 && <div style={emptyStyle}>{COPY.emptyDecisions}</div>}
    {!failed && items.map((decision) => <DecisionCard key={decision.decision_id} decision={decision} />)}
    {nextCursor && !failed && <button type="button" disabled={loading} onClick={() => setCursor(nextCursor)} style={buttonStyle}>加载更多</button>}
  </section>
}

function DecisionCard({ decision }: { decision: DecisionView }) {
  const kind = KIND_LABEL[decision.kind]
  const status = STATUS_LABEL[decision.status]
  return <article style={cardStyle}>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
      <h2 style={cardTitleStyle}>{kind ?? <UnknownState value={decision.kind} />}</h2>
      <strong style={{ color: decision.status === 'blocked_for_human' ? COLOR.warning : COLOR.inkMuted, fontSize: FONT_PX.helper }}>
        {status ?? <UnknownState value={decision.status} />}
      </strong>
    </div>
    <dl style={detailGridStyle}>
      <dt>说明</dt><dd>{decision.target_summary ?? '说明暂不可用'}</dd>
      <dt>为什么需要处理</dt><dd>{decision.priority_reason ?? '处理原因暂不可用'}</dd>
      <dt>可选处理</dt><dd>{decision.allowed_resolutions?.join(' / ') ?? '操作选项尚未接入'}</dd>
      <dt>需要的证据</dt><dd>{decision.required_evidence?.join('、') ?? '证据要求尚未接入'}</dd>
      <dt>过期会怎样</dt><dd>{decision.expires_at ? `记录的截止时间：${formatDate(decision.expires_at)}；截止后的处理方式尚未提供` : '没有记录截止时间，也没有过期处理规则'}</dd>
    </dl>
    {decision.confirm_required && <p style={warningStyle}>处理前需要再次确认。</p>}
    {decision.projection_missing.length > 0 && <p style={mutedStyle}>部分决策信息尚未持久化，当前无法提供安全的处理选项。</p>}
  </article>
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString()
}

const kickerStyle = { margin: '0 0 5px', color: COLOR.inkMuted, fontSize: FONT_PX.helper } as const
const titleStyle = { margin: 0, fontSize: FONT_PX.title }
const sectionTitleStyle = { margin: 0, fontSize: 16 }
const cardTitleStyle = { margin: 0, fontSize: 16 }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
const cardStyle = { minWidth: 0, padding: 18, border: `1px solid ${COLOR.line}`, borderRadius: 9, background: COLOR.surface }
const detailGridStyle = { display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: '8px 12px', margin: '16px 0 0', fontSize: FONT_PX.body } as const
const emptyStyle = { border: `1px dashed ${COLOR.line}`, borderRadius: 9, padding: 32, textAlign: 'center' as const, color: COLOR.inkMuted }
const buttonStyle = { minHeight: 36, justifySelf: 'start' as const, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, color: COLOR.danger, background: '#fff1f0', borderRadius: 8 }
const warningStyle = { padding: 11, borderRadius: 7, background: '#fff8e9', color: COLOR.warning, fontSize: FONT_PX.body }
