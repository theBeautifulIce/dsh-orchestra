import { useEffect, useRef, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { UnverifiedEffectView } from '../api/types.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { UnknownState } from './shell.tsx'

export const VERIFY_BANNER = '签字只表示人接下了后果，不表示副作用已消失'
const EFFECT_LABEL: Record<string, string> = { pure: '只读', compensable: '可补偿', irreversible: '不可逆' }
const STATUS_LABEL: Record<string, string> = {
  running: '正在做', completed: '已完成', failed: '失败', blocked: '卡住了',
  waiting: '等待中', cancelled: '已取消', indeterminate_side_effect: '副作用情况待核实',
}

export type UnverifiedEffectsProps = {
  api: ResourcesApi
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
}

export function UnverifiedEffects({ api, reloadVersion = 0, onSnapshot }: UnverifiedEffectsProps) {
  const [items, setItems] = useState<UnverifiedEffectView[]>([])
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
    void api.listUnverifiedEffects({ limit: 50, cursor }).then((result) => {
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
  return <section aria-labelledby="unverified-title" style={{ display: 'grid', gap: 18 }}>
    <header>
      <p style={kickerStyle}>需要跟进</p>
      <h1 id="unverified-title" style={titleStyle}>待核实</h1>
      <p style={mutedStyle}>{VERIFY_BANNER}</p>
    </header>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <h2 style={sectionTitleStyle}>未验证操作</h2>
      <button type="button" onClick={refresh} disabled={loading} style={buttonStyle}>{loading ? '正在更新…' : '刷新'}</button>
    </div>
    {failed && <div role="alert" style={errorStyle}><span>{COPY.queryFailed}</span><button type="button" onClick={refresh} style={buttonStyle}>{COPY.retry}</button></div>}
    {loading && <p role="status" style={mutedStyle}>正在读取待核实事项…</p>}
    {!loading && !failed && items.length === 0 && <div style={emptyStyle}>{COPY.emptyEffects}</div>}
    {!failed && items.map((effect) => <EffectCard key={effect.node_run_id} effect={effect} />)}
    {nextCursor && !failed && <button type="button" disabled={loading} onClick={() => setCursor(nextCursor)} style={buttonStyle}>加载更多</button>}
  </section>
}

function EffectCard({ effect }: { effect: UnverifiedEffectView }) {
  const level = EFFECT_LABEL[effect.side_effect_policy]
  return <article style={cardStyle}>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
      <h2 style={cardTitleStyle}>{effect.node_id || '未命名步骤'}</h2>
      <strong style={{ color: effect.side_effect_policy === 'irreversible' ? COLOR.danger : COLOR.warning, fontSize: FONT_PX.helper }}>
        {level ?? <UnknownState value={effect.side_effect_policy} />}
      </strong>
    </div>
    <dl style={detailGridStyle}>
      <dt>当前状态</dt><dd>{STATUS_LABEL[effect.status] ?? <UnknownState value={effect.status} />}</dd>
      <dt>核实状态</dt><dd>未验证</dd>
      <dt>已等待</dt><dd>{effect.age_seconds === null ? '时长未知' : `${effect.age_seconds} 秒`}</dd>
      <dt>开始时间</dt><dd>{effect.started_at ? formatDate(effect.started_at) : '没有记录开始时间'}</dd>
      <dt>停止记录</dt><dd>{effect.stop_evidence ?? '没有记录停止证据'}</dd>
      <dt>签认状态</dt><dd>{effect.resolved ? '已有处理记录' : '尚无处理记录'}</dd>
    </dl>
    <p style={mutedStyle}>动作摘要、停止时刻、最后执行阶段和已验证证据尚未由当前读模型提供。</p>
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
