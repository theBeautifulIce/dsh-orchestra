import { ReworkPanel } from './rework-panel.tsx'
import type { ReworkApi } from '../api/rework.ts'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { DecisionView, MemoryApprovalCard } from '../api/types.ts'
import { DecisionConfirmationRequired, describeDecisionError, type DecisionCommandsApi, type DecisionResolveInput } from '../api/decision-commands.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { usePanelCommandsEnabled } from './shell.tsx'
import { priorityRank } from '../../core/decision-priority.ts'
import { operatorReason, operatorStatus } from '../../core/operator-language.ts'

export { priorityRank }

const KIND_LABEL: Record<string, string> = {
  pre_execution: '执行前确认', action_overrun: '操作范围确认', abandon_ack: '停止后确认', verify_human: '人工核验',
  audit_result: '结果复核', rule_ambiguous: '规则待澄清', startup_unknown: '启动状态待确认', report_contradicted: '结果不一致',
}
const DECISION_OPTIONS = new Map([
  ['approved', '批准执行'], ['rejected', '拒绝执行'], ['expired', '按到期处理'],
  ['continue', '继续执行'], ['abort', '停止执行'],
  ['confirm_applied', '确认外部操作已发生'], ['confirm_not_applied', '确认外部操作未发生'],
  ['confirm_started', '确认已启动'], ['confirm_not_started', '确认未启动'],
  ['continue_tracking', '继续跟踪'], ['continue_wait', '继续等待'], ['abandon', '停止跟踪'],
  ['uphold_report', '采纳回报'], ['uphold_decision', '保留原处理决定'],
])
const PRIORITY_LABEL = new Map([['critical', '最高'], ['urgent', '紧急'], ['high', '高'], ['normal', '普通'], ['low', '低']])
const FIELD_LABEL = new Map([
  ['allowed_resolutions', '处理选项'], ['priority', '优先级'], ['priority_reason', '等待原因'],
  ['required_evidence', '核验材料'], ['target_summary', '事项说明'], ['payload', '事项内容'],
])
const APPROVER_LABEL: Readonly<Record<string, string>> = { human: '人工', either: '人工或授权执行主体', agent: '授权执行主体' }
const EXPIRY_LABEL: Readonly<Record<string, string>> = { auto_resolve: '按已记录的规则自动处理', escalate_only: '升级给人工', none: '无自动动作' }

// 服务端没给的字段一律写明「服务端未提供」，面板不替它编。
const NOT_PROVIDED = '服务端未提供'

function optionalReason(reason: string | null | undefined, fallback = NOT_PROVIDED): string {
  return reason ? operatorReason(reason) : fallback
}

function missingFields(fields: string[]): string {
  return [...new Set(fields.map((field) => FIELD_LABEL.get(field) ?? '部分事项信息'))].join('、')
}

/** 同优先级先处理等待时间较长的决定，缺失优先级的决定仍按等待时间排序。 */
export function sortDecisions(items: DecisionView[]): DecisionView[] {
  return [...items].sort((a, b) => {
    const byPriority = priorityRank(b.priority) - priorityRank(a.priority)
    if (byPriority !== 0) return byPriority
    const createdA = Date.parse(a.created_at) || 0
    const createdB = Date.parse(b.created_at) || 0
    if (createdA !== createdB) return createdA - createdB
    return a.decision_id === b.decision_id ? 0 : a.decision_id < b.decision_id ? -1 : 1
  })
}

export type DecisionInboxProps = {
  api: ResourcesApi
  rework?: ReworkApi
  reworkPlannerEnabled?: boolean
  commands?: DecisionCommandsApi
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
  decisionId?: string
  onShowAll?: () => void
}

type Notice = { text: string; tone: 'ok' | 'error' }
const DECISION_VIEWS = { inbox: '待处理', active: '全部进行中', history: '已处理' } as const

export function DecisionInbox({ api, commands, rework, reworkPlannerEnabled, reloadVersion = 0, onSnapshot, decisionId, onShowAll }: DecisionInboxProps) {
  const canWrite = usePanelCommandsEnabled(true)
  const [items, setItems] = useState<DecisionView[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [decisionView, setDecisionView] = useState<keyof typeof DECISION_VIEWS>('inbox')
  const history = decisionView === 'history'
  const lastReload = useRef(reloadVersion)
  const [selected, setSelected] = useState<string[]>([])
  const [developerView, setDeveloperView] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [cardNotices, setCardNotices] = useState<Record<string, Notice>>({})
  const [pending, setPending] = useState<{ input: DecisionResolveInput; label: string } | null>(null)

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
    const query = decisionId
      ? api.getDecision(decisionId).then((result) => ({ ...result, data: { items: [result.data], next_cursor: null } }))
      : api.listDecisions({ limit: 50, cursor,
        inbox: decisionView === 'inbox' ? 'human' : undefined,
        status: decisionView === 'history' ? 'resolved' : undefined,
      })
    void query.then((result) => {
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
  }, [api, cursor, retry, decisionView, reloadVersion, onSnapshot, decisionId])

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
    if (!canWrite || !commands) return
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

  async function resolveDecision(input: DecisionResolveInput, label: string) {
    if (!canWrite || !commands) return
    const { decisionId } = input
    setBusy(true)
    setPending(null)
    setCardNotice(decisionId, null)
    try {
      await commands.resolveDecision(input)
      setCardNotice(decisionId, { text: `已处理：${label}。`, tone: 'ok' })
      refresh()
    } catch (error) {
      if (error instanceof DecisionConfirmationRequired) {
        setPending({ input: { ...input, confirmation: error.confirmation }, label })
      } else setCardNotice(decisionId, { text: describeDecisionError(error), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  // 批量只做接手：处理一次一条，没有「忽略」。
  async function acknowledgeSelected() {
    if (!canWrite || !commands || selected.length === 0) return
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

  return <section aria-labelledby="decision-inbox-title" className="ops-page">
    <header className="ops-page-header">
      <h1 id="decision-inbox-title">审批中心</h1>
      {decisionId && onShowAll && <button type="button" className="ops-button" onClick={onShowAll}>查看全部决定</button>}
      <button type="button" onClick={refresh} disabled={loading} className="ops-button">{loading ? '正在更新…' : '刷新'}</button>
    </header>
    {rework && !decisionId && <ReworkPanel api={api} commands={rework} plannerEnabled={reworkPlannerEnabled} reloadVersion={reloadVersion} onSnapshot={onSnapshot} />}
    <div className="ops-toolbar">
    {!decisionId && <div role="group" aria-label="决定视图" className="ops-tabs">
      {Object.entries(DECISION_VIEWS).map(([value, label]) => <button type="button" key={value} aria-pressed={value === decisionView}
        onClick={() => {
          setItems([]); setSelected([]); setPending(null); setNextCursor(null); setCursor(undefined)
          setDecisionView(value as keyof typeof DECISION_VIEWS); setRetry((version) => version + 1)
        }}>{label}</button>)}
    </div>}
    <div className="ops-actions">
      {!history && <>
      <span style={mutedStyle}>已选 {selected.length} 条</span>
      <button type="button" onClick={() => { void acknowledgeSelected() }} disabled={!canWrite || failed || !commands || busy || selected.length === 0} className="ops-button">批量接手</button>
      </>}
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
    </div>
    {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} style={notice.tone === 'error' ? errorTextStyle : mutedStyle}>{notice.text}</p>}
    {failed && <div role="alert" style={errorStyle}><span>{COPY.queryFailed}</span><button type="button" onClick={refresh} style={buttonStyle}>{COPY.retry}</button></div>}
    {loading && <p role="status" style={mutedStyle}>正在读取决定事项…</p>}
    {!loading && !failed && items.length === 0 && <p className="ops-surface ops-empty">{history ? '还没有已处理的决定。' : COPY.emptyDecisions}</p>}
    <div className="ops-card-grid">
    {sorted.map((decision) => <DecisionCard
      key={decision.decision_id}
      decision={decision}
      commands={history || failed || !canWrite ? undefined : commands}
      developerView={developerView}
      selected={selected.includes(decision.decision_id)}
      busy={busy}
      notice={cardNotices[decision.decision_id]}
      onToggle={() => toggleSelected(decision.decision_id)}
      onAcknowledge={() => { void acknowledgeDecision(decision) }}
      onResolve={(resolution, label) => { void resolveDecision({
        decisionId: decision.decision_id, revision: decision.current_revision, resolution,
        ...(decision.content_hash ? { contentHash: decision.content_hash } : {}),
      }, label) }}
      confirmation={!history && pending?.input.decisionId === decision.decision_id
        && pending.input.revision === decision.current_revision && pending.input.contentHash === (decision.content_hash ?? undefined)
        && decision.status !== 'resolved' && <div role="group" aria-label="再次确认这条决定" style={actionStyle}>
          <strong>确认{pending.label}？</strong>
          <button type="button" disabled={!canWrite || failed || !commands || busy} style={buttonStyle} onClick={() => {
            void resolveDecision(pending.input, pending.label)
          }}>确认处理</button>
          <button type="button" style={buttonStyle} onClick={() => setPending(null)}>取消</button>
        </div>}
    />)}
    </div>
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
  onResolve: (resolution: string, label: string) => void
  confirmation?: ReactNode
}) {
  const { decision } = props
  const kind = Object.hasOwn(KIND_LABEL, decision.kind) ? KIND_LABEL[decision.kind] : '待确认事项'
  const agentOnly = decision.approver?.startsWith('agent:') === true
  const status = agentOnly && decision.status !== 'resolved' ? '由授权核验主体处理' : operatorStatus(decision.status)
  const choices = (decision.allowed_resolutions ?? []).flatMap((value) => {
    const label = DECISION_OPTIONS.get(value)
    return label ? [{ value, label }] : []
  })
  const priority = decision.priority && PRIORITY_LABEL.get(decision.priority)
  const evidence = [...new Set((decision.required_evidence ?? []).map(operatorReason))]
  const missing = decision.projection_missing ?? []
  // 记忆审批卡：卡上的两个按钮由服务端给的标签与 resolution 组成，前端不猜。
  const memoryCard = useMemo(() => readMemoryApprovalCard(decision.payload), [decision.payload])
  if (memoryCard && decision.status !== 'resolved') {
    return <MemoryApprovalCardView
      decision={decision}
      card={memoryCard}
      commands={props.commands}
      developerView={props.developerView}
      busy={props.busy}
      notice={props.notice}
      onResolve={props.onResolve}
      confirmation={props.confirmation}
    />
  }
  return <article style={cardStyle}>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
      <h2 style={cardTitleStyle}>{kind}</h2>
      <strong style={{ color: !agentOnly && decision.status === 'blocked_for_human' ? COLOR.warning : COLOR.inkMuted, fontSize: FONT_PX.helper }}>
        {status}
      </strong>
    </div>
    {priority && <p style={mutedStyle}>优先级：{priority}</p>}
    <dl style={detailGridStyle}>
      <dt>说明</dt><dd>{optionalReason(decision.target_summary, '说明暂不可用')}</dd>
      <dt>为什么卡</dt><dd>{optionalReason(decision.priority_reason)}</dd>
      {decision.approver && <><dt>谁能处理</dt><dd>{agentOnly ? APPROVER_LABEL.agent
        : Object.hasOwn(APPROVER_LABEL, decision.approver) ? APPROVER_LABEL[decision.approver] : '处理人待确认'}</dd></>}
      <dt>你能选什么</dt><dd>{choices.length ? choices.map(({ label }) => label).join(' / ') : NOT_PROVIDED}</dd>
      <dt>需要什么证据</dt><dd>{evidence.length ? evidence.join('、') : NOT_PROVIDED}</dd>
      <dt>过期会怎样</dt><dd>{decision.kind === 'report_contradicted' ? '仅由人工处理，系统不会自动收口。'
        : memoryCard && decision.expires_at ? formatDate(decision.expires_at) + ' · 到期未批准，批次关闭。'
        : decision.expires_at ? formatDate(decision.expires_at) + ' · ' + (decision.expiry_effect && Object.hasOwn(EXPIRY_LABEL, decision.expiry_effect)
          ? EXPIRY_LABEL[decision.expiry_effect] : '截止后的处理方式尚未提供') : NOT_PROVIDED}</dd>
      {decision.status === 'resolved' && <><dt>处理结果</dt><dd>{DECISION_OPTIONS.get(decision.closed_reason ?? '') ?? optionalReason(decision.closed_reason)}</dd></>}
      {decision.status === 'resolved' && decision.resolved_by && <><dt>处理人</dt><dd>{agentOnly ? '授权核验主体' : '已记录，见开发者视图'}</dd></>}
      {decision.status === 'resolved' && decision.decided_at && <><dt>处理时间</dt><dd>{formatDate(decision.decided_at)}</dd></>}
    </dl>
    {props.developerView && <dl style={detailGridStyle}>
      <dt>决定 ID</dt><dd>{decision.decision_id}</dd>
      <dt>运行 ID</dt><dd>{decision.run_id}</dd>
      <dt>节点运行 ID</dt><dd>{decision.node_run_id}</dd>
      {decision.resolved_by && <><dt>处理人标识</dt><dd>{decision.resolved_by}</dd></>}
      {missing.length > 0 && <><dt>缺少的字段</dt><dd>{missing.join('、')}</dd></>}
    </dl>}
    {decision.confirm_required && <p style={warningStyle}>处理前需要再次确认。</p>}
    {missing.length > 0 && <p style={mutedStyle}>当前记录缺少：{missingFields(missing)}。</p>}
    {!agentOnly && decision.status !== 'resolved' && <div style={actionStyle}>
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
      {choices.length > 0
        ? choices.map(({ value, label }) => <button
          key={value}
          type="button"
          onClick={() => props.onResolve(value, label)}
          disabled={!props.commands || props.busy}
          style={buttonStyle}
        >{label}</button>)
        : <button type="button" disabled style={buttonStyle}>处理</button>}
    </div>}
    {props.confirmation}
    {decision.status !== 'resolved' && choices.length === 0 && <p style={mutedStyle}>{optionalReason(decision.resolution_unavailable_reason, '当前没有可从这里执行的处理选项。')}</p>}
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
  onResolve: (resolution: string, label: string) => void
  confirmation?: ReactNode
}) {
  const { decision, card } = props
  const [expanded, setExpanded] = useState(false)
  const missing = decision.projection_missing ?? []
  // 按标签找服务端给的按钮与 resolution；找不到就是服务端没投影出来，这里不替它编。
  const choices = decision.allowed_resolutions ?? []
  const approve = card.buttons.find((button) => button.resolution === 'approved' && choices.includes(button.resolution))
  const decline = card.buttons.find((button) => button.resolution === 'rejected' && choices.includes(button.resolution))
  const incomplete = approve === undefined || decline === undefined
  return <article style={cardStyle}>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
      <h2 style={cardTitleStyle}>{card.title}</h2>
      <strong style={{ color: decision.status === 'blocked_for_human' ? COLOR.warning : COLOR.inkMuted, fontSize: FONT_PX.helper }}>
        {operatorStatus(decision.status)}
      </strong>
    </div>
    <p style={mutedStyle}>{card.summary_line}</p>
    {decision.expires_at && <p style={mutedStyle}>{formatDate(decision.expires_at)} · 到期未批准，批次关闭。</p>}
    <ul style={listStyle}>
      {card.items.map((item, index) => <li key={`${item.layer}-${index}`} style={itemStyle}>
        <p style={itemTitleStyle}>层：{item.layer} · {item.title}</p>
        <p style={mutedStyle}>{item.digest}</p>
        <p style={mutedStyle}>理由：{optionalReason(item.judge_reason)}</p>
      </li>)}
    </ul>
    <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} style={buttonStyle}>{card.expand_label}</button>
    {expanded && <div style={detailStyle}>
      {card.items.map((item, index) => <p key={`why-${index}`} style={mutedStyle}>
        {item.title}：{optionalReason(item.judge_reason)}
      </p>)}
    </div>}
    {props.developerView && <dl style={detailGridStyle}>
      <dt>批次 ID</dt><dd>batch_id: {card.batch_id ?? NOT_PROVIDED}</dd>
      <dt>评估 ID</dt><dd>evaluation_id: {card.evaluation_id ?? NOT_PROVIDED}</dd>
      <dt>提议哈希</dt><dd>proposal_hash: {card.proposal_hash ?? NOT_PROVIDED}</dd>
      <dt>决定 ID</dt><dd>decision_id: {decision.decision_id}</dd>
      {missing.length > 0 && <><dt>缺少的字段</dt><dd>{missing.join('、')}</dd></>}
    </dl>}
    {incomplete && decision.resolution_unavailable_reason && <p style={mutedStyle}>{operatorReason(decision.resolution_unavailable_reason)}</p>}
    {incomplete && missing.length > 0 && <p style={mutedStyle}>当前记录缺少：{missingFields(missing)}。</p>}
    {incomplete && missing.length === 0 && !decision.resolution_unavailable_reason && <p style={mutedStyle}>当前没有完整的处理选项。</p>}
    <div style={actionStyle}>
      <button
        type="button"
        onClick={() => { if (approve) props.onResolve(approve.resolution, approve.label) }}
        disabled={!props.commands || props.busy || !approve}
        style={buttonStyle}
      >{approve?.label ?? '按这个方案写入'}</button>
      <button
        type="button"
        onClick={() => { if (decline) props.onResolve(decline.resolution, decline.label) }}
        disabled={!props.commands || props.busy || !decline}
        style={buttonStyle}
      >{decline?.label ?? '这次不写'}</button>
    </div>
    {props.confirmation}
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

const cardTitleStyle = { margin: 0, fontSize: 16 }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
const cardStyle = { minWidth: 0, padding: '11px 13px', border: '1px solid #dde4ed', borderRadius: 9, background: COLOR.surface }
const detailGridStyle = { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '4px 10px', margin: '8px 0 0', fontSize: FONT_PX.body } as const
const listStyle = { display: 'grid', gap: 10, margin: '12px 0 0', padding: 0, listStyle: 'none' } as const
const itemStyle = { display: 'grid', gap: 3, minWidth: 0 } as const
const itemTitleStyle = { margin: 0, fontSize: FONT_PX.body } as const
const detailStyle = { margin: '8px 0 0', paddingLeft: 10, borderLeft: `2px solid ${COLOR.line}` } as const
const buttonStyle = { minHeight: 36, justifySelf: 'start' as const, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, color: COLOR.danger, background: '#fff1f0', borderRadius: 8 }
const warningStyle = { padding: 11, borderRadius: 7, background: '#fff8e9', color: COLOR.warning, fontSize: FONT_PX.body }
const toggleStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FONT_PX.body } as const
const actionStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, margin: '14px 0 0' } as const
const errorTextStyle = { margin: '8px 0 0', color: COLOR.danger, fontSize: FONT_PX.body } as const
