import { useEffect, useMemo, useRef, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { DecisionView, MemoryApprovalCard } from '../api/types.ts'
import { describeDecisionError, type DecisionCommandsApi } from '../api/decision-commands.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { UnknownState } from './shell.tsx'

const KIND_LABEL: Record<string, string> = {
  pre_execution: '执行前确认', action_overrun: '操作范围确认', abandon_ack: '停止后确认', verify_human: '人工核验',
  audit_result: '结果复核', rule_ambiguous: '规则待澄清', startup_unknown: '启动状态待确认', report_contradicted: '结果不一致',
}
const STATUS_LABEL: Record<string, string> = { pending: '待处理', acknowledged: '已接手', blocked_for_human: '等你处理' }

// 服务端没给的字段一律写明「服务端未提供」，面板不替它编。
const NOT_PROVIDED = '服务端未提供'

// 服务端给的优先级名次；没给或看不懂的算「没有名次」，排在有名次的后面。
const PRIORITY_RANK: Record<string, number> = { critical: 50, urgent: 40, high: 30, normal: 20, low: 10 }
const NO_PRIORITY_RANK = 0

export function priorityRank(priority: string | null | undefined): number {
  if (!priority) return NO_PRIORITY_RANK
  return PRIORITY_RANK[priority] ?? NO_PRIORITY_RANK
}

/** 有 priority 就按 priority 降序，同 priority 按 created_at 降序；priority 缺失时退回 created_at 降序。 */
export function sortDecisions(items: DecisionView[]): DecisionView[] {
  return [...items].sort((a, b) => {
    const byPriority = priorityRank(b.priority) - priorityRank(a.priority)
    if (byPriority !== 0) return byPriority
    const createdA = Date.parse(a.created_at) || 0
    const createdB = Date.parse(b.created_at) || 0
    if (createdA !== createdB) return createdB - createdA
    return b.decision_id.localeCompare(a.decision_id)
  })
}

export type DecisionInboxProps = {
  api: ResourcesApi
  commands?: DecisionCommandsApi
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
}

type Notice = { text: string; tone: 'ok' | 'error' }

export function DecisionInbox({ api, commands, reloadVersion = 0, onSnapshot }: DecisionInboxProps) {
  const [items, setItems] = useState<DecisionView[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const lastReload = useRef(reloadVersion)
  const [selected, setSelected] = useState<string[]>([])
  const [developerView, setDeveloperView] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [cardNotices, setCardNotices] = useState<Record<string, Notice>>({})

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

  const sorted = useMemo(() => sortDecisions(items), [items])

  function setCardNotice(decisionId: string, value: Notice | null) {
    setCardNotices((previous) => {
      const next = { ...previous }
      if (value) next[decisionId] = value
      else delete next[decisionId]
      return next
    })
  }

  function toggleSelected(decisionId: string) {
    setSelected((previous) => previous.includes(decisionId)
      ? previous.filter((id) => id !== decisionId)
      : [...previous, decisionId])
  }

  async function acknowledgeDecision(decision: DecisionView) {
    if (!commands) return
    setBusy(true)
    setCardNotice(decision.decision_id, null)
    try {
      await commands.acknowledgeDecision({ decisionId: decision.decision_id, revision: decision.current_revision })
      setCardNotice(decision.decision_id, { text: '已接手。', tone: 'ok' })
      refresh()
    } catch (error) {
      setCardNotice(decision.decision_id, { text: describeDecisionError(error), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function resolveDecision(decision: DecisionView, resolution: string) {
    if (!commands) return
    setBusy(true)
    setCardNotice(decision.decision_id, null)
    try {
      await commands.resolveDecision({ decisionId: decision.decision_id, revision: decision.current_revision, resolution })
      setCardNotice(decision.decision_id, { text: `已按 ${resolution} 处理。`, tone: 'ok' })
      refresh()
    } catch (error) {
      setCardNotice(decision.decision_id, { text: describeDecisionError(error), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  // 批量只做接手：处理一次一条，没有「忽略」。
  async function acknowledgeSelected() {
    if (!commands || selected.length === 0) return
    setBusy(true)
    setNotice(null)
    const failures: string[] = []
    let done = 0
    for (const decisionId of selected) {
      const decision = items.find((item) => item.decision_id === decisionId)
      if (!decision) continue
      try {
        await commands.acknowledgeDecision({ decisionId, revision: decision.current_revision })
        done += 1
      } catch (error) {
        failures.push(describeDecisionError(error))
      }
    }
    setSelected([])
    setBusy(false)
    setNotice(failures.length > 0
      ? { text: `批量接手完成 ${done} 条，${failures.length} 条没成功：${failures.join('；')}`, tone: 'error' }
      : { text: `已批量接手 ${done} 条。`, tone: 'ok' })
    refresh()
  }

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
    <div style={toolbarStyle}>
      <span style={mutedStyle}>已选 {selected.length} 条</span>
      <button type="button" onClick={() => { void acknowledgeSelected() }} disabled={!commands || busy || selected.length === 0} style={buttonStyle}>批量接手</button>
      <label style={toggleStyle}>
        <input
          type="checkbox"
          aria-label="开发者视图"
          checked={developerView}
          onChange={(event) => setDeveloperView(event.target.checked)}
        />
        开发者视图
      </label>
    </div>
    {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} style={notice.tone === 'error' ? errorTextStyle : mutedStyle}>{notice.text}</p>}
    {failed && <div role="alert" style={errorStyle}><span>{COPY.queryFailed}</span><button type="button" onClick={refresh} style={buttonStyle}>{COPY.retry}</button></div>}
    {loading && <p role="status" style={mutedStyle}>正在读取决定事项…</p>}
    {!loading && !failed && items.length === 0 && <div style={emptyStyle}>{COPY.emptyDecisions}</div>}
    {!failed && sorted.map((decision) => <DecisionCard
      key={decision.decision_id}
      decision={decision}
      commands={commands}
      developerView={developerView}
      selected={selected.includes(decision.decision_id)}
      busy={busy}
      notice={cardNotices[decision.decision_id]}
      onToggle={() => toggleSelected(decision.decision_id)}
      onAcknowledge={() => { void acknowledgeDecision(decision) }}
      onResolve={(resolution) => { void resolveDecision(decision, resolution) }}
    />)}
    {nextCursor && !failed && <button type="button" disabled={loading} onClick={() => setCursor(nextCursor)} style={buttonStyle}>加载更多</button>}
  </section>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 认出服务端 buildApprovalCard 落到决定 payload 里的审批卡（规格 §9.6）。
 * 认不出就返回 null，这条决定仍按普通决定卡片渲染。
 */
export function readMemoryApprovalCard(payload: unknown): MemoryApprovalCard | null {
  if (!isRecord(payload)) return null
  if (payload.kind !== 'audit_result') return null
  if (typeof payload.title !== 'string' || payload.title.length === 0) return null
  if (typeof payload.summary_line !== 'string') return null
  const rawItems = Array.isArray(payload.items) ? payload.items.filter(isRecord) : []
  const rawButtons = Array.isArray(payload.buttons) ? payload.buttons.filter(isRecord) : []
  return {
    kind: 'audit_result',
    title: payload.title,
    summary_line: payload.summary_line,
    items: rawItems.map((item) => ({
      layer: typeof item.layer === 'string' ? item.layer : '',
      title: typeof item.title === 'string' ? item.title : '',
      digest: typeof item.digest === 'string' ? item.digest : '',
      judge_reason: typeof item.judge_reason === 'string' ? item.judge_reason : null,
    })),
    buttons: rawButtons.map((button) => ({
      label: typeof button.label === 'string' ? button.label : '',
      resolution: typeof button.resolution === 'string' ? button.resolution : '',
    })),
    allowed_resolutions: Array.isArray(payload.allowed_resolutions)
      ? payload.allowed_resolutions.filter((value): value is string => typeof value === 'string')
      : [],
    resolve_payload: isRecord(payload.resolve_payload) ? payload.resolve_payload : {},
    expand_label: typeof payload.expand_label === 'string' && payload.expand_label.length > 0
      ? payload.expand_label
      : '为什么记这条',
    batch_id: typeof payload.batch_id === 'string' ? payload.batch_id : null,
    evaluation_id: typeof payload.evaluation_id === 'string' ? payload.evaluation_id : null,
    proposal_hash: typeof payload.proposal_hash === 'string' ? payload.proposal_hash : null,
  }
}

function DecisionCard(props: {
  decision: DecisionView
  commands?: DecisionCommandsApi
  developerView: boolean
  selected: boolean
  busy: boolean
  notice?: Notice
  onToggle: () => void
  onAcknowledge: () => void
  onResolve: (resolution: string) => void
}) {
  const { decision } = props
  const kind = KIND_LABEL[decision.kind]
  const status = STATUS_LABEL[decision.status]
  const resolutions = decision.allowed_resolutions ?? []
  const missing = decision.projection_missing ?? []
  // 记忆审批卡：卡上的两个按钮由服务端给的标签与 resolution 组成，前端不猜。
  const memoryCard = useMemo(() => readMemoryApprovalCard(decision.payload), [decision.payload])
  if (memoryCard) {
    return <MemoryApprovalCardView
      decision={decision}
      card={memoryCard}
      commands={props.commands}
      developerView={props.developerView}
      busy={props.busy}
      notice={props.notice}
      onResolve={props.onResolve}
    />
  }
  return <article style={cardStyle}>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
      <h2 style={cardTitleStyle}>{kind ?? <UnknownState value={decision.kind} />}</h2>
      <strong style={{ color: decision.status === 'blocked_for_human' ? COLOR.warning : COLOR.inkMuted, fontSize: FONT_PX.helper }}>
        {status ?? <UnknownState value={decision.status} />}
      </strong>
    </div>
    {decision.priority && <p style={mutedStyle}>优先级：{decision.priority}</p>}
    <dl style={detailGridStyle}>
      <dt>为什么卡</dt><dd>{decision.priority_reason ?? NOT_PROVIDED}</dd>
      <dt>你能选什么</dt><dd>{resolutions.length > 0 ? resolutions.join(' / ') : NOT_PROVIDED}</dd>
      <dt>需要什么证据</dt><dd>{decision.required_evidence && decision.required_evidence.length > 0 ? decision.required_evidence.join('、') : NOT_PROVIDED}</dd>
      <dt>过期会怎样</dt><dd>{decision.expires_at ? `记录的截止时间：${formatDate(decision.expires_at)}；截止后的处理方式尚未提供` : NOT_PROVIDED}</dd>
    </dl>
    <dl style={detailGridStyle}>
      <dt>说明</dt><dd>{decision.target_summary ?? '说明暂不可用'}</dd>
      <dt>为什么需要处理</dt><dd>{decision.priority_reason ?? '处理原因暂不可用'}</dd>
      <dt>可选处理</dt><dd>{decision.allowed_resolutions?.join(' / ') ?? '操作选项尚未接入'}</dd>
      <dt>需要的证据</dt><dd>{decision.required_evidence?.join('、') ?? '证据要求尚未接入'}</dd>
      <dt>过期会怎样</dt><dd>{decision.expires_at ? `记录的截止时间：${formatDate(decision.expires_at)}；截止后的处理方式尚未提供` : '没有记录截止时间，也没有过期处理规则'}</dd>
    </dl>
    {props.developerView && <dl style={detailGridStyle}>
      <dt>决定 ID</dt><dd>{decision.decision_id}</dd>
      <dt>运行 ID</dt><dd>{decision.run_id}</dd>
      <dt>节点运行 ID</dt><dd>{decision.node_run_id}</dd>
    </dl>}
    {decision.confirm_required && <p style={warningStyle}>处理前需要再次确认。</p>}
    {missing.length > 0 && <p style={mutedStyle}>部分决策信息尚未持久化，当前无法提供安全的处理选项。</p>}
    {missing.length > 0 && <p style={mutedStyle}>服务端未持久化的字段：{missing.join('、')}</p>}
    <div style={actionStyle}>
      <label style={toggleStyle}>
        <input
          type="checkbox"
          aria-label="选择这条决定"
          checked={props.selected}
          onChange={props.onToggle}
          disabled={props.busy}
        />
        选择这条决定
      </label>
      <button type="button" onClick={props.onAcknowledge} disabled={!props.commands || props.busy} style={buttonStyle}>接手</button>
      {resolutions.length > 0
        ? resolutions.map((resolution) => <button
          key={resolution}
          type="button"
          aria-label={`按 ${resolution} 处理`}
          title={`按 ${resolution} 处理`}
          onClick={() => props.onResolve(resolution)}
          disabled={!props.commands || props.busy}
          style={buttonStyle}
        >{resolution}</button>)
        : <button type="button" disabled style={buttonStyle}>处理</button>}
    </div>
    {resolutions.length === 0 && <p style={mutedStyle}>服务端没有给出可选项，这里不替你编。</p>}
    {props.notice && (
      <p role={props.notice.tone === 'error' ? 'alert' : 'status'} style={props.notice.tone === 'error' ? errorTextStyle : mutedStyle}>
        {props.notice.text}
      </p>
    )}
  </article>
}

/** 记忆审批卡：标题、首行、每条一行、两个按钮；技术编号只在开发者视图里出现。 */
function MemoryApprovalCardView(props: {
  decision: DecisionView
  card: MemoryApprovalCard
  commands?: DecisionCommandsApi
  developerView: boolean
  busy: boolean
  notice?: Notice
  onResolve: (resolution: string) => void
}) {
  const { decision, card } = props
  const [expanded, setExpanded] = useState(false)
  const missing = decision.projection_missing ?? []
  // 按标签找服务端给的按钮与 resolution；找不到就是服务端没投影出来，这里不替它编。
  const approve = card.buttons.find((button) => button.label === '按这个方案写入')
  const decline = card.buttons.find((button) => button.label === '这次不写')
  const incomplete = approve === undefined || decline === undefined
  return <article style={cardStyle}>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
      <h2 style={cardTitleStyle}>{card.title}</h2>
      <strong style={{ color: decision.status === 'blocked_for_human' ? COLOR.warning : COLOR.inkMuted, fontSize: FONT_PX.helper }}>
        {STATUS_LABEL[decision.status] ?? <UnknownState value={decision.status} />}
      </strong>
    </div>
    <p style={mutedStyle}>{card.summary_line}</p>
    <ul style={listStyle}>
      {card.items.map((item, index) => <li key={`${item.layer}-${index}`} style={itemStyle}>
        <p style={itemTitleStyle}>层：{item.layer} · {item.title}</p>
        <p style={mutedStyle}>{item.digest}</p>
        <p style={mutedStyle}>理由：{item.judge_reason ?? NOT_PROVIDED}</p>
      </li>)}
    </ul>
    <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} style={buttonStyle}>{card.expand_label}</button>
    {expanded && <div style={detailStyle}>
      {card.items.map((item, index) => <p key={`why-${index}`} style={mutedStyle}>
        {item.title}：{item.judge_reason ?? NOT_PROVIDED}
      </p>)}
    </div>}
    {props.developerView && <dl style={detailGridStyle}>
      <dt>批次 ID</dt><dd>batch_id: {card.batch_id ?? NOT_PROVIDED}</dd>
      <dt>评估 ID</dt><dd>evaluation_id: {card.evaluation_id ?? NOT_PROVIDED}</dd>
      <dt>提议哈希</dt><dd>proposal_hash: {card.proposal_hash ?? NOT_PROVIDED}</dd>
      <dt>决定 ID</dt><dd>decision_id: {decision.decision_id}</dd>
    </dl>}
    {incomplete && <p style={mutedStyle}>部分决策信息尚未持久化，当前无法提供安全的处理选项。</p>}
    {incomplete && missing.length > 0 && <p style={mutedStyle}>服务端未持久化的字段：{missing.join('、')}</p>}
    {incomplete && missing.length === 0 && <p style={mutedStyle}>服务端没有给出可选项，这里不替你编。</p>}
    <div style={actionStyle}>
      <button
        type="button"
        onClick={() => { if (approve) props.onResolve(approve.resolution) }}
        disabled={!props.commands || props.busy || !approve}
        style={buttonStyle}
      >按这个方案写入</button>
      <button
        type="button"
        onClick={() => { if (decline) props.onResolve(decline.resolution) }}
        disabled={!props.commands || props.busy || !decline}
        style={buttonStyle}
      >这次不写</button>
    </div>
    {props.notice && (
      <p role={props.notice.tone === 'error' ? 'alert' : 'status'} style={props.notice.tone === 'error' ? errorTextStyle : mutedStyle}>
        {props.notice.text}
      </p>
    )}
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
const listStyle = { display: 'grid', gap: 10, margin: '12px 0 0', padding: 0, listStyle: 'none' } as const
const itemStyle = { display: 'grid', gap: 3, minWidth: 0 } as const
const itemTitleStyle = { margin: 0, fontSize: FONT_PX.body } as const
const detailStyle = { margin: '8px 0 0', paddingLeft: 10, borderLeft: `2px solid ${COLOR.line}` } as const
const emptyStyle = { border: `1px dashed ${COLOR.line}`, borderRadius: 9, padding: 32, textAlign: 'center' as const, color: COLOR.inkMuted }
const buttonStyle = { minHeight: 36, justifySelf: 'start' as const, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, color: COLOR.danger, background: '#fff1f0', borderRadius: 8 }
const warningStyle = { padding: 11, borderRadius: 7, background: '#fff8e9', color: COLOR.warning, fontSize: FONT_PX.body }
const toolbarStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } as const
const toggleStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FONT_PX.body } as const
const actionStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, margin: '14px 0 0' } as const
const errorTextStyle = { margin: '8px 0 0', color: COLOR.danger, fontSize: FONT_PX.body } as const
