import { useEffect, useRef, useState } from 'react'
import type { ResourcesApi } from '../api/resources.ts'
import type { ApiClient } from '../api/client.ts'
import type { UnverifiedEffectView } from '../api/types.ts'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import { UnknownState } from './shell.tsx'
import { EffectEvidenceReview } from './effect-evidence-review.tsx'

export const VERIFY_BANNER = '人工签认记录责任接管。外部操作是否发生仍以核验证据为准。'
const EFFECT_LABEL: Record<string, string> = { pure: '只读', compensable: '可补偿', irreversible: '不可逆' }
const STATUS_LABEL: Record<string, string> = {
  running: '正在做', completed: '已完成', failed: '失败', blocked: '卡住了',
  waiting: '等待中', cancelled: '已取消', indeterminate_side_effect: '外部操作结果待核验',
  abandoned_unverified: '已停止跟踪，外部操作待核验', failed_with_unverified: '执行失败，外部操作待核验',
}

// 当前读模型没有来源列的字段一律写「未知」，不用别的值顶替。
const UNKNOWN = '未知'

export type UnverifiedEffectsProps = {
  api: ResourcesApi
  reloadVersion?: number
  onSnapshot?: (asOfSeq: number) => void
  client?: ApiClient
}

export function UnverifiedEffects({ api, reloadVersion = 0, onSnapshot, client }: UnverifiedEffectsProps) {
  const [items, setItems] = useState<UnverifiedEffectView[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const lastReload = useRef(reloadVersion)
  const [developerView, setDeveloperView] = useState(false)

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
  return <section aria-labelledby="unverified-title" className="ops-page">
    <header className="ops-page-header">
      <div><h1 id="unverified-title">操作核验</h1><p className="ops-meta">{VERIFY_BANNER}</p></div>
      <div className="ops-actions">
      <label style={toggleStyle}>
        <input
          type="checkbox"
          aria-label="开发者视图"
          checked={developerView}
          onChange={(event) => setDeveloperView(event.target.checked)}
        />
        开发者视图
      </label>
      <button type="button" onClick={refresh} disabled={loading} className="ops-button">{loading ? '正在更新…' : '刷新'}</button>
      </div>
    </header>
    {failed && <div role="alert" style={errorStyle}><span>{COPY.queryFailed}</span><button type="button" onClick={refresh} style={buttonStyle}>{COPY.retry}</button></div>}
    {loading && <p role="status" style={mutedStyle}>正在读取待核实事项…</p>}
    {!loading && !failed && items.length === 0 && <p className="ops-surface ops-empty">{COPY.emptyEffects}</p>}
    <div className="ops-card-grid">
    {!failed && items.map((effect) => <EffectCard key={effect.node_run_id} effect={effect} developerView={developerView}>
      {client && <EffectEvidenceReview api={api} client={client} nodeId={effect.node_run_id} onResolved={refresh} />}
    </EffectCard>)}
    </div>
    {nextCursor && !failed && <button type="button" disabled={loading} onClick={() => setCursor(nextCursor)} style={buttonStyle}>加载更多</button>}
  </section>
}

function EffectCard({ effect, developerView, children }: { effect: UnverifiedEffectView; developerView: boolean; children?: React.ReactNode }) {
  const level = EFFECT_LABEL[effect.side_effect_policy]
  const age = effect.age_seconds === null ? '时长未知' : `已等待 ${effect.age_seconds} 秒`
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
      {developerView && <><dt>节点运行 ID</dt><dd>{effect.node_run_id}</dd></>}
    </dl>
    {children}
    {developerView && <><div className="ops-table-scroll"><table className="ops-table" style={tableStyle}>
      <thead>
        <tr>
          <th scope="col">运行</th>
          <th scope="col">节点</th>
          <th scope="col">动作摘要</th>
          <th scope="col">外部操作风险</th>
          <th scope="col">停止时刻 stopped_at</th>
          <th scope="col">最后已知阶段 last_known_phase</th>
          <th scope="col">验证状态</th>
          <th scope="col">证据</th>
          <th scope="col">年龄</th>
          <th scope="col">是否已解决 / 解决依据</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{effect.run_id}</td>
          <td>{effect.node_id || '未命名步骤'}</td>
          <td>{UNKNOWN}</td>
          <td>{level ?? <UnknownState value={effect.side_effect_policy} />}</td>
          <td>{UNKNOWN}</td>
          <td>{UNKNOWN}</td>
          <td>未验证</td>
          <td>{UNKNOWN}</td>
          <td>{age}</td>
          <td>
            <div>{effect.resolved ? '是（已有处理记录）' : '否（尚无处理记录）'}</div>
            <div>解决依据：{effect.resolution_basis ?? UNKNOWN}</div>
          </td>
        </tr>
      </tbody>
    </table></div>
    <p style={mutedStyle}>读模型未提供的字段显示「未知」。</p></>}
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
const buttonStyle = { minHeight: 36, justifySelf: 'start' as const, padding: '0 12px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' }
const errorStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, color: COLOR.danger, background: '#fff1f0', borderRadius: 8 }
const toggleStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FONT_PX.body } as const
const tableStyle = { width: '100%', margin: '16px 0 0', borderCollapse: 'collapse', fontSize: FONT_PX.helper, textAlign: 'left' as const } as const
