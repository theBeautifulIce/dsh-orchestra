import { Fragment, useEffect, useMemo, useState } from 'react'
import type { DecisionCommandsApi } from '../api/decision-commands.ts'
import { describeDecisionError } from '../api/decision-commands.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { MemoryBatchView, MemoryItemView } from '../api/types.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'

/** 面板上说的每一句状态话：固定十二句，一字不改。 */
export type MemoryCopy = { text: string; tone: 'neutral' | 'wait' | 'good' | 'warn' }

/** 服务端没给的字段一律写明「服务端未提供」，面板不替它编。 */
const NOT_PROVIDED = '服务端未提供'

/** 批次状态 → 面板文案（规格 §9.9 的十二句）。 */
export function memoryCopy(batch: MemoryBatchView): MemoryCopy {
  switch (batch.status) {
    case 'draft': return { text: '正在整理', tone: 'neutral' }
    case 'evaluating': return { text: '管家在看有没有重复', tone: 'neutral' }
    case 'awaiting_human': return { text: `有 ${batch.pending_count} 条等你确认`, tone: 'wait' }
    case 'approved': return { text: '开始写入', tone: 'neutral' }
    case 'applying': return { text: '正在写入', tone: 'neutral' }
    case 'applied': return { text: `写了 ${batch.applied_count} 条`, tone: 'good' }
    case 'empty': return { text: '这次没有需要写的', tone: 'neutral' }
    case 'blocked': return { text: '有 1 条拿不准，这次没写', tone: 'warn' }
    case 'declined': return { text: '你选择先不写', tone: 'warn' }
    case 'expired': return { text: '超过 24 小时没确认，这次没写', tone: 'warn' }
    case 'failed': return { text: '没写成：裁判没给出结果', tone: 'warn' }
    case 'indeterminate': return { text: '写到一半，等你确认', tone: 'wait' }
    default: return { text: String(batch.status), tone: 'neutral' }
  }
}

// 没写成的批次：这一类都要向用户解释一句为什么，并给出下一步。
const NOT_WRITTEN_STATUSES = new Set(['blocked', 'declined', 'expired', 'failed', 'indeterminate'])

// 每种没写成的原因配一句可以做的事。
const NEXT_STEP: Record<string, string> = {
  blocked: '可以再让管家判断一次这条要不要记。',
  declined: '想记的话，可以让管家改一版。',
  expired: '可以让管家重新整理一批，这次重新确认。',
  failed: '可以让管家改一版，或者再试一次。',
  indeterminate: '如果这次不想写了，可以放弃这次写入。',
}

export type MemoryPanelProps = {
  api: ResourcesApi
  commands?: DecisionCommandsApi
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
  /** 跳到「等你决定」去看同一张审批卡。 */
  onOpenDecisions?: () => void
}

type Notice = { text: string; tone: 'ok' | 'error' }

export function MemoryPanel({ api, commands, reloadVersion = 0, onSnapshot, onOpenDecisions }: MemoryPanelProps) {
  const [batches, setBatches] = useState<MemoryBatchView[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [developerView, setDeveloperView] = useState(false)
  const [openedItem, setOpenedItem] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    setLoading(true)
    setFailed(false)
    // 只读一个 GET：面板自己不发任何写请求。
    void api.listMemoryBatches({}).then((result) => {
      if (!current) return
      setBatches(result.data.items)
      onSnapshot?.(result.as_of_seq)
    }).catch(() => {
      if (current) setFailed(true)
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [api, retry, reloadVersion, onSnapshot])

  const latest = useMemo(() => {
    if (batches.length === 0) return undefined
    return [...batches].sort((a, b) =>
      (b.attempt - a.attempt)
      || ((Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))
      || b.created_at.localeCompare(a.created_at))[0]
  }, [batches])

  // ① 已经写进去的条目。
  const writtenItems = useMemo(() => batches.flatMap((batch) => batch.items.filter((item) => item.status === 'applied')), [batches])
  // ② 还有什么没定。
  const awaitingBatches = useMemo(() => batches.filter((batch) => batch.status === 'awaiting_human'), [batches])
  const pendingTotal = useMemo(() => awaitingBatches.reduce((sum, batch) => sum + batch.pending_count, 0), [awaitingBatches])
  // ③ 哪条没写成。
  const notWrittenBatches = useMemo(() => batches.filter((batch) => NOT_WRITTEN_STATUSES.has(batch.status)), [batches])

  async function abandonBatch(batch: MemoryBatchView) {
    if (!commands) return
    // resolution 由服务端给；服务端没给「放弃」这个选项，这里就只说明，不替它编。
    const resolution = batch.allowed_resolutions?.find((value) => value === 'abandon')
    if (!resolution || !batch.decision_id || batch.decision_revision === null) return
    setBusy(true)
    setNotice(null)
    try {
      await commands.resolveDecision({ decisionId: batch.decision_id, revision: batch.decision_revision, resolution })
      setNotice({ text: '已放弃这次写入。', tone: 'ok' })
      setRetry((value) => value + 1)
    } catch (error) {
      setNotice({ text: describeDecisionError(error), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return <section aria-labelledby="memory-panel-title" style={{ display: 'grid', gap: 18 }}>
    <header>
      <p style={kickerStyle}>记忆</p>
      <h1 id="memory-panel-title" style={titleStyle}>这次的记忆</h1>
      <p style={mutedStyle}>这里只回答四个问题：这次记了什么、还有什么没定、哪条没写成、要不要现在记。</p>
      {latest && <p style={statusStyle}>这次运行：{memoryCopy(latest).text}</p>}
    </header>
    {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} style={notice.tone === 'error' ? errorTextStyle : mutedStyle}>{notice.text}</p>}
    {failed && <div role="alert" style={errorStyle}><span>{COPY.queryFailed}</span><button type="button" onClick={() => setRetry((value) => value + 1)} style={buttonStyle}>{COPY.retry}</button></div>}
    {loading && <p role="status" style={mutedStyle}>正在读取记忆…</p>}

    {/* ① 这次记了什么 */}
    <section aria-labelledby="memory-q1-title" style={blockStyle}>
      <h2 id="memory-q1-title" style={sectionTitleStyle}>这次记了什么</h2>
      {writtenItems.length === 0
        ? <p style={mutedStyle}>这次还没有记下东西。</p>
        : <ul style={listStyle}>
          {writtenItems.map((item) => <li key={item.client_key} style={itemStyle}>
            <p style={itemTitleStyle}>{item.title}</p>
            <p style={mutedStyle}>层：{item.layer}</p>
            <p style={mutedStyle}>{item.digest}</p>
            <button
              type="button"
              onClick={() => setOpenedItem(openedItem === item.client_key ? null : item.client_key)}
              style={buttonStyle}
            >{openedItem === item.client_key ? '收起' : '展开看全文与来源'}</button>
            {openedItem === item.client_key && <div style={detailStyle}>
              <p style={mutedStyle}>全文：{item.content ?? NOT_PROVIDED}</p>
              <p style={mutedStyle}>来源：{item.source ?? NOT_PROVIDED}</p>
            </div>}
          </li>)}
        </ul>}
    </section>

    {/* ② 还有什么没定 */}
    <section aria-labelledby="memory-q2-title" style={blockStyle}>
      <h2 id="memory-q2-title" style={sectionTitleStyle}>还有什么没定</h2>
      {awaitingBatches.length === 0
        ? <p style={mutedStyle}>没有待确认</p>
        : <>
          <p style={statusStyle}>有 {pendingTotal} 条等你确认</p>
          <button type="button" onClick={() => onOpenDecisions?.()} disabled={!onOpenDecisions} style={buttonStyle}>去「等你决定」看看</button>
        </>}
    </section>

    {/* ③ 哪条没写成，为什么 */}
    <section aria-labelledby="memory-q3-title" style={blockStyle}>
      <h2 id="memory-q3-title" style={sectionTitleStyle}>哪条没写成，为什么</h2>
      {notWrittenBatches.length === 0
        ? <p style={mutedStyle}>这次没有没写成的条目。</p>
        : notWrittenBatches.map((batch) => {
          const copy = memoryCopy(batch)
          const hideItems = batch.status === 'indeterminate'
          const notWritten = batch.items.filter((item) => item.status !== 'applied')
          const abandonResolution = batch.allowed_resolutions?.find((value) => value === 'abandon') ?? null
          const abandonReady = Boolean(batch.decision_id) && batch.decision_revision !== null && abandonResolution !== null
          return <div key={batch.batch_id} style={itemStyle}>
            <p style={statusStyle}>{copy.text}</p>
            <p style={mutedStyle}>{NEXT_STEP[batch.status] ?? '可以再让管家处理一次。'}</p>
            {!hideItems && notWritten.map((item) => <p key={item.client_key} style={mutedStyle}>
              {item.title}：{item.judge_reason ?? '这次没有写进去'}
            </p>)}
            {batch.status === 'indeterminate' && <>
              <button
                type="button"
                onClick={() => { void abandonBatch(batch) }}
                disabled={!commands || busy || !abandonReady}
                style={buttonStyle}
              >放弃这次写入</button>
              {!abandonReady && <p style={mutedStyle}>服务端这次没有给出放弃的选项，这里不替你编。</p>}
            </>}
          </div>
        })}
    </section>

    {/* ④ 要不要现在记：只给提示，不在这里发任何写命令。 */}
    <section aria-labelledby="memory-q4-title" style={blockStyle}>
      <h2 id="memory-q4-title" style={sectionTitleStyle}>要不要现在记</h2>
      {!latest
        ? <p style={mutedStyle}>记录这次任务</p>
        : <>
          {latest.status === 'failed' || latest.status === 'declined'
            ? <>
              <p style={mutedStyle}>让管家改一版</p>
              <p style={mutedStyle}>再试一次</p>
            </>
            : <p style={mutedStyle}>{latest.status === 'awaiting_human' ? '先确认要写哪几条' : '这次不用再记了'}</p>}
        </>}
    </section>

    <div style={toolbarStyle}>
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
    {developerView && <dl style={detailGridStyle}>
      {batches.map((batch) => <Fragment key={batch.batch_id}>
        <dt>批次 ID</dt><dd>batch_id: {batch.batch_id}</dd>
        <dt>评估 ID</dt><dd>evaluation_id: {batch.evaluation_id ?? NOT_PROVIDED}</dd>
        <dt>提议哈希</dt><dd>proposal_hash: {batch.proposal_hash ?? NOT_PROVIDED}</dd>
        <dt>决定 ID</dt><dd>decision_id: {batch.decision_id ?? NOT_PROVIDED}</dd>
        <dt>任务 ID</dt><dd>task_id: {batch.task_id}</dd>
      </Fragment>)}
    </dl>}
  </section>
}

const kickerStyle = { margin: '0 0 5px', color: COLOR.inkMuted, fontSize: FONT_PX.helper } as const
const titleStyle = { margin: 0, fontSize: FONT_PX.title }
const sectionTitleStyle = { margin: 0, fontSize: 16 }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
const statusStyle = { margin: '8px 0 0', fontSize: FONT_PX.body }
const blockStyle = { display: 'grid', gap: 8, padding: 16, border: `1px solid ${COLOR.line}`, borderRadius: 9, background: COLOR.surface }
const listStyle = { display: 'grid', gap: 12, margin: 0, padding: 0, listStyle: 'none' } as const
const itemStyle = { display: 'grid', gap: 4, minWidth: 0 } as const
const itemTitleStyle = { margin: 0, fontSize: FONT_PX.body } as const
const detailStyle = { margin: '6px 0 0', paddingLeft: 10, borderLeft: `2px solid ${COLOR.line}` } as const
const detailGridStyle = { display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: '8px 12px', margin: '0', fontSize: FONT_PX.body } as const
const buttonStyle = { minHeight: 36, justifySelf: 'start' as const, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, color: COLOR.danger, background: '#fff1f0', borderRadius: 8 }
const errorTextStyle = { margin: '8px 0 0', color: COLOR.danger, fontSize: FONT_PX.body } as const
const toolbarStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } as const
const toggleStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FONT_PX.body } as const
