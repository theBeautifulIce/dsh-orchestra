import type { StreamStatus } from '../api/sse.ts'
import { COLOR, FONT_PX } from './tokens.ts'

export type SettingsScreenProps = {
  /** 服务是否可达：由宿主探测 /health 得到；没探到就显示未知。 */
  serviceConnected?: boolean
  /** 服务与面板协议版本是否一致：宿主探测得到；没探到就显示未知。 */
  protocolMismatch?: boolean
  /** 数据快照是否可能已过期：宿主从事件流状态推得。 */
  snapshotStale?: boolean
  /** 实时事件流状态：宿主从事件流回调拿到的真实状态。 */
  streamStatus?: StreamStatus
  /** 服务当前阶段：由 /health 返回的 phase 原样带出。 */
  phase?: string
  /** 面板版本：由宿主注入；宿主拿不到就显示未知。 */
  panelVersion?: string
  /** 重新探测真实状态；宿主没提供就不显示这个入口。 */
  onRefresh?: () => void
}

type Tone = 'plain' | 'ok' | 'warn' | 'bad'

type SettingRow = { key: string; label: string; value: string; tone: Tone }

const UNKNOWN = '未知'

/** 设置屏只显示真实状态：拿不到的项一律写「未知」，不填猜测值。 */
export function SettingsScreen(props: SettingsScreenProps) {
  const rows = buildRows(props)
  return <section aria-labelledby="settings-title" style={sectionStyle}>
    <h1 id="settings-title" style={titleStyle}>设置</h1>
    <p style={leadStyle}>这里只写面板此刻能确认的状态；拿不到的项显示「未知」，不猜。</p>
    <dl style={listStyle}>
      {rows.map((row) => (
        <div key={row.key} style={rowStyle}>
          <dt style={labelStyle}>{row.label}</dt>
          <dd style={{ ...valueStyle, color: toneColor(row.tone) }}>{row.value}</dd>
        </div>
      ))}
    </dl>
    <p style={noteStyle}>「未知」说明面板此刻没拿到这个状态，不代表服务出了问题。</p>
    {props.onRefresh && <button type="button" onClick={props.onRefresh} style={buttonStyle}>重新检测</button>}
  </section>
}

export function buildRows(props: SettingsScreenProps): SettingRow[] {
  return [
    {
      key: 'service',
      label: '服务连接',
      value: props.serviceConnected === undefined ? UNKNOWN : props.serviceConnected ? '已连接' : '未连接',
      tone: props.serviceConnected === undefined ? 'plain' : props.serviceConnected ? 'ok' : 'bad',
    },
    {
      key: 'protocol',
      label: '协议版本',
      value: props.protocolMismatch === undefined ? UNKNOWN : props.protocolMismatch ? '与服务不一致' : '与服务一致',
      tone: props.protocolMismatch === undefined ? 'plain' : props.protocolMismatch ? 'bad' : 'ok',
    },
    {
      key: 'snapshot',
      label: '数据快照',
      value: snapshotValue(props),
      tone: props.snapshotStale === true || props.streamStatus === 'stale' ? 'warn' : props.streamStatus === undefined ? 'plain' : 'ok',
    },
    {
      key: 'stream',
      label: '实时事件流',
      value: streamValue(props.streamStatus),
      tone: props.streamStatus === undefined ? 'plain' : props.streamStatus === 'live' ? 'ok' : 'warn',
    },
    {
      key: 'phase',
      label: '当前阶段',
      value: props.phase ?? UNKNOWN,
      tone: 'plain',
    },
    {
      key: 'version',
      label: '面板版本',
      value: props.panelVersion ?? UNKNOWN,
      tone: 'plain',
    },
  ]
}

function snapshotValue(props: SettingsScreenProps): string {
  if (props.snapshotStale === true) return '可能已过期'
  if (props.streamStatus === undefined) return UNKNOWN
  if (props.streamStatus === 'stale') return '可能已过期'
  if (props.streamStatus === 'polling') return '可能滞后'
  return '最新'
}

function streamValue(status: StreamStatus | undefined): string {
  if (status === undefined) return UNKNOWN
  if (status === 'live') return '实时更新'
  if (status === 'polling') return '轮询更新'
  return '数据可能已过期'
}

function toneColor(tone: Tone): string {
  if (tone === 'ok') return COLOR.success
  if (tone === 'warn') return COLOR.warning
  if (tone === 'bad') return COLOR.danger
  return COLOR.ink
}

const sectionStyle = { display: 'grid', gap: 16, maxWidth: '100%', minWidth: 0 } as const
const titleStyle = { margin: 0, fontSize: FONT_PX.title, lineHeight: 1.3 } as const
const leadStyle = { margin: 0, color: COLOR.inkMuted, fontSize: FONT_PX.body } as const
const listStyle = { margin: 0, display: 'grid', gap: 10, minWidth: 0 } as const
const rowStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '6px 16px', minWidth: 0, border: `1px solid ${COLOR.line}`, borderRadius: 9, padding: '14px 18px', background: COLOR.surface } as const
const labelStyle = { margin: 0, color: COLOR.inkMuted, fontSize: FONT_PX.menu } as const
const valueStyle = { margin: 0, fontSize: FONT_PX.body, fontWeight: 600 } as const
const noteStyle = { margin: 0, color: COLOR.inkMuted, fontSize: FONT_PX.helper } as const
const buttonStyle = { minHeight: 36, justifySelf: 'start', padding: '0 14px', border: `1px solid ${COLOR.line}`, borderRadius: 7, background: COLOR.surface, color: COLOR.ink, fontSize: FONT_PX.menu, cursor: 'pointer' } as const
