import { Fragment, useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/client.ts'
import { describeDecisionError } from '../api/decision-commands.ts'
import type { MemoryRecoveryApi, MemoryRecoveryView, RecoveryChoice } from '../api/memory-recovery.ts'
import type { ResourcesApi } from '../api/resources.ts'
import type { MemoryBatchView, MemoryItemView } from '../api/types.ts'
import { COPY } from './copy.ts'
import { PanelCommandButton } from './shell.tsx'
import { COLOR, FONT_PX } from './tokens.ts'

/** 面板上说的每一句状态话：固定十二句，一字不改。 */
export type MemoryCopy = { text: string; tone: 'neutral' | 'wait' | 'good' | 'warn' }

/** 服务端没给的字段一律写明「服务端未提供」，面板不替它编。 */
const NOT_PROVIDED = '服务端未提供'

/** 批次状态 → 面板文案（规格 §9.9 的十二句）。 */
export function memoryCopy(batch: MemoryBatchView): MemoryCopy {
  if (batch.status === 'applying' && batch.recovery_available) return { text: '写入结果待核对', tone: 'wait' }
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
  recovery?: MemoryRecoveryApi
  memoryEnabled?: boolean
  proposalOnly?: boolean
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
  /** 跳到「等你决定」去看同一张审批卡。 */
  onOpenDecisions?: () => void
  onOpenTasks?: () => void
}

type Notice = { text: string; tone: 'ok' | 'error' }
type ReadResult = {
  retry: number
  reloadVersion: number
  onSnapshot: MemoryPanelProps['onSnapshot']
} & ({ status: 'ready'; batches: MemoryBatchView[] } | { status: 'failed' })

const EMPTY_BATCHES: MemoryBatchView[] = []

const RECOVERY_LABEL: Record<RecoveryChoice, string> = {
  confirm_applied: '确认全部写入',
  confirm_not_applied: '确认未写入并重新执行',
  abandon: '放弃这次写入',
  acknowledge_abandon: '签认并结束',
}

function recoveryError(error: unknown): string {
  if (error instanceof ApiError && ['RESOLUTION_NOT_AVAILABLE', 'OPERATION_OUTCOME_UNKNOWN'].includes(error.code)) return error.message
  return describeDecisionError(error)
}

export function MemoryPanel(props: MemoryPanelProps) {
  const { api, recovery, memoryEnabled, proposalOnly } = props
  const [source, setSource] = useState({ api, recovery, memoryEnabled, proposalOnly, generation: 0 })
  // Reset expanded items and recovery proofs before rendering another source or permission mode.
  if (source.api !== api || source.recovery !== recovery
    || source.memoryEnabled !== memoryEnabled || source.proposalOnly !== proposalOnly) {
    setSource({ api, recovery, memoryEnabled, proposalOnly, generation: source.generation + 1 })
  }
  return <MemoryPanelContent key={source.generation} {...props} />
}

function MemoryPanelContent({ api, recovery, memoryEnabled, proposalOnly, reloadVersion = 0, onSnapshot, onOpenDecisions, onOpenTasks }: MemoryPanelProps) {
  const [readResult, setReadResult] = useState<ReadResult | null>(null)
  const [retry, setRetry] = useState(0)
  const [developerView, setDeveloperView] = useState(false)
  const [openedItem, setOpenedItem] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [proof, setProof] = useState<MemoryRecoveryView | null>(null)

  useEffect(() => {
    let current = true
    const request = { retry, reloadVersion, onSnapshot }
    void api.listMemoryBatches({}).then((result) => {
      if (!current) return
      setReadResult({ ...request, status: 'ready', batches: result.data.items })
      onSnapshot?.(result.as_of_seq)
    }).catch(() => {
      if (current) setReadResult({ ...request, status: 'failed' })
    })
    return () => { current = false }
  }, [api, retry, reloadVersion, onSnapshot])

  const result = readResult?.retry === retry && readResult.reloadVersion === reloadVersion && readResult.onSnapshot === onSnapshot
    ? readResult : null
  const batches = result?.status === 'ready' ? result.batches : EMPTY_BATCHES
  const readOnly = memoryEnabled === false
  const latest = useMemo(() => {
    if (batches.length === 0) return undefined
    return [...batches].sort((a, b) =>
      ((Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))
      || b.created_at.localeCompare(a.created_at))[0]
  }, [batches])

  // ① 已经写进去的条目。
  const writtenItems = useMemo(() => batches.flatMap((batch) => batch.items
    .filter((item) => item.status === 'applied')
    .map((item) => ({ item, key: JSON.stringify([batch.batch_id, item.client_key]) }))), [batches])
  // ② 还有什么没定。
  const awaitingBatches = useMemo(() => batches.filter((batch) => batch.status === 'awaiting_human'), [batches])
  const pendingTotal = useMemo(() => awaitingBatches.reduce((sum, batch) => sum + batch.pending_count, 0), [awaitingBatches])
  // ③ 哪条没写成。
  const notWrittenBatches = useMemo(() => batches.filter((batch) => NOT_WRITTEN_STATUSES.has(batch.status)), [batches])

  async function inspectBatch(batch: MemoryBatchView) {
    if (readOnly || !recovery) return
    setBusy(true)
    setNotice(null)
    setProof(null)
    try {
      setProof(await recovery.inspect(batch.batch_id))
      setRetry((value) => value + 1)
    } catch (error) {
      setNotice({ text: recoveryError(error), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function resolveRecovery(inspection: MemoryRecoveryView, choice: RecoveryChoice) {
    if (readOnly || !recovery) return
    setBusy(true)
    setNotice(null)
    try {
      await recovery.resolve(inspection, choice)
      setProof(null)
      setNotice({ text: choice === 'abandon' ? '已放弃本次写入，请签认。' : '已记录恢复决定。', tone: 'ok' })
      setRetry((value) => value + 1)
    } catch (error) {
      setProof(null)
      setNotice({ text: recoveryError(error), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return <section aria-labelledby="memory-panel-title" className="ops-page">
    <header className="ops-page-header">
      <div>
        <h1 id="memory-panel-title">记忆管理</h1>
        <p className="ops-meta">{readOnly ? '当前宿主未启用记忆整理，页面为只读。连接正常时，仍可查看已有条目和历史整理结果。'
          : proposalOnly ? '当前工作区开放记忆提议和来源核对，写入尚未开放。'
            : memoryEnabled ? '把成功任务中值得复用的经验整理成条目，核对提议和来源后，再批准写入。'
              : '查看任务整理出的记忆条目、提议和来源。'}</p>
        {latest && <p className="ops-meta">最近批次 · {batchStateText(latest, readOnly, proposalOnly)}</p>}
      </div>
      {result?.status === 'ready' && <label style={toggleStyle}>
        <input type="checkbox" aria-label="开发者视图" checked={developerView} onChange={(event) => setDeveloperView(event.target.checked)} />
        开发者视图
      </label>}
    </header>
    {result?.status === 'ready' && notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} style={notice.tone === 'error' ? errorTextStyle : mutedStyle}>{notice.text}</p>}
    {result?.status === 'failed' && <div role="alert" style={errorStyle}><span>记忆{COPY.queryFailed}</span><button type="button" onClick={() => setRetry((value) => value + 1)} style={buttonStyle}>{COPY.retry}</button></div>}
    {!result && <p role="status" style={mutedStyle}>正在读取记忆…</p>}

    {result?.status === 'ready' && <div className="ops-context-grid">
    <section aria-labelledby="memory-q1-title" style={blockStyle}>
      <h2 id="memory-q1-title" style={sectionTitleStyle}>已写入条目</h2>
      {writtenItems.length === 0
        ? <p style={mutedStyle}>这次还没有记下东西。</p>
        : <ul style={listStyle}>
          {writtenItems.map(({ item, key }) => <li key={key} style={itemStyle}>
            <p style={itemTitleStyle}>{item.title}</p>
            <p style={mutedStyle}>层：{item.layer}</p>
            <p style={mutedStyle}>{item.digest}</p>
            <button
              type="button"
              onClick={() => setOpenedItem(openedItem === key ? null : key)}
              style={buttonStyle}
            >{openedItem === key ? '收起' : '展开看全文与来源'}</button>
            {openedItem === key && <div style={detailStyle}>
              <p style={mutedStyle}>全文：{item.content ?? NOT_PROVIDED}</p>
              <p style={mutedStyle}>来源：{item.source ?? NOT_PROVIDED}</p>
            </div>}
          </li>)}
        </ul>}
    </section>

    <section aria-labelledby="memory-q2-title" style={blockStyle}>
      <h2 id="memory-q2-title" style={sectionTitleStyle}>{!readOnly && proposalOnly ? '提议与来源' : '审批与对账'}</h2>
      {awaitingBatches.length === 0
        ? <p style={mutedStyle}>{!readOnly && proposalOnly ? '没有可查看的提议' : '没有待确认'}</p>
        : <>
          <p style={statusStyle}>{readOnly ? `有 ${pendingTotal} 条提议待确认，当前仅可查看。`
            : proposalOnly ? `有 ${pendingTotal} 条记忆提议可查看` : `有 ${pendingTotal} 条等你确认`}</p>
          {!readOnly && <button type="button" onClick={() => onOpenDecisions?.()} disabled={!onOpenDecisions} style={buttonStyle}>
            {proposalOnly ? '查看提议' : '查看审批'}
          </button>}
        </>}
      {!readOnly && batches.filter((batch) => batch.recovery_available).map((batch) => {
        const inspection = proof?.batch_id === batch.batch_id ? proof : null
        return <div key={batch.batch_id} style={itemStyle}>
          <PanelCommandButton disabled={!recovery || busy} onClick={() => { void inspectBatch(batch) }} style={buttonStyle}>
            核对记忆写入
          </PanelCommandButton>
          {inspection && <>
            <p style={mutedStyle}>已写入 {inspection.written_count} 条，未写入 {inspection.missing_count} 条。</p>
            {inspection.allowed_resolutions.map((choice) => <PanelCommandButton key={choice}
              disabled={busy} style={buttonStyle}
              onClick={() => { void resolveRecovery(inspection, choice) }}>{RECOVERY_LABEL[choice]}</PanelCommandButton>)}
          </>}
        </div>
      })}
    </section>

    <section aria-labelledby="memory-q3-title" style={blockStyle}>
      <h2 id="memory-q3-title" style={sectionTitleStyle}>未写入条目</h2>
      {notWrittenBatches.length === 0
        ? <p style={mutedStyle}>这次没有没写成的条目。</p>
        : notWrittenBatches.map((batch) => {
          const hideItems = batch.status === 'indeterminate'
          const notWritten = batch.items.filter((item) => item.status !== 'applied')
          return <div key={batch.batch_id} style={itemStyle}>
            <p style={statusStyle}>{batchStateText(batch, readOnly)}</p>
            {!readOnly && <p style={mutedStyle}>{NEXT_STEP[batch.status] ?? '可以再让管家处理一次。'}</p>}
            {!hideItems && notWritten.map((item) => <p key={item.client_key} style={mutedStyle}>
              {item.title}：{item.judge_reason ?? '这次没有写进去'}
            </p>)}
          </div>
        })}
    </section>

    <section aria-labelledby="memory-q4-title" style={blockStyle}>
      <h2 id="memory-q4-title" style={sectionTitleStyle}>整理状态</h2>
      {readOnly ? <p style={mutedStyle}>{latest ? '以上是最近一次整理的记录。' : '暂无整理记录。'}</p>
        : !latest ? <div><p style={mutedStyle}>要记录这次任务的经验，打开成功运行的「结果」，选择「整理为记忆」，写下希望保留的内容。</p>
            {memoryEnabled && onOpenTasks && <button type="button" onClick={onOpenTasks} style={buttonStyle}>去任务中选择一次成功运行</button>}
          </div>
        : <>
          {latest.status === 'failed' || latest.status === 'declined'
            ? <>
              <p style={mutedStyle}>让管家改一版</p>
              <p style={mutedStyle}>再试一次</p>
            </>
            : <p style={mutedStyle}>{latest.status === 'awaiting_human'
              ? proposalOnly ? '可以查看提议及其来源' : '先确认要写哪几条'
              : '这次不用再记了'}</p>}
        </>}
    </section>

    </div>}
    {result?.status === 'ready' && developerView && <dl style={detailGridStyle}>
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

function batchStateText(batch: MemoryBatchView, readOnly: boolean, proposalOnly?: boolean): string {
  if (batch.status === 'awaiting_human' && (readOnly || proposalOnly)) {
    return `有 ${batch.pending_count} 条${readOnly ? '提议待确认' : '提议可查看'}`
  }
  if (readOnly) {
    if (batch.status === 'approved') return '已批准，尚未写入'
    if (batch.status === 'applying' || batch.status === 'indeterminate') return '写入结果待核对'
  }
  return memoryCopy(batch).text
}

const sectionTitleStyle = { margin: 0, fontSize: FONT_PX.section }
const mutedStyle = { margin: '6px 0 0', color: COLOR.inkMuted, fontSize: FONT_PX.body }
const statusStyle = { margin: '8px 0 0', fontSize: FONT_PX.body }
const blockStyle = { display: 'grid', alignContent: 'start', minWidth: 0, gap: 12, padding: '20px', border: `1px solid ${COLOR.line}`, borderRadius: 12, background: COLOR.surface }
const listStyle = { display: 'grid', gap: 12, margin: 0, padding: 0, listStyle: 'none' } as const
const itemStyle = { display: 'grid', gap: 4, minWidth: 0 } as const
const itemTitleStyle = { margin: 0, fontSize: FONT_PX.body } as const
const detailStyle = { margin: '6px 0 0', paddingLeft: 10, borderLeft: `2px solid ${COLOR.line}` } as const
const detailGridStyle = { display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: '8px 12px', margin: '0', fontSize: FONT_PX.body } as const
const buttonStyle = { minHeight: 44, justifySelf: 'start' as const, padding: '0 14px', border: `1px solid ${COLOR.line}`, borderRadius: 8, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.body, cursor: 'pointer' }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, color: COLOR.danger, background: '#fff1f0', borderRadius: 8 }
const errorTextStyle = { margin: '8px 0 0', color: COLOR.danger, fontSize: FONT_PX.body } as const
const toggleStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FONT_PX.body } as const
