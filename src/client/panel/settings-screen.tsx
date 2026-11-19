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
  return <section aria-labelledby="settings-title" className="ops-surface">
    <header className="ops-surface-head">
      <h2 id="settings-title">服务状态</h2>
      {props.onRefresh && <button type="button" onClick={props.onRefresh} className="ops-button">重新检测</button>}
    </header>
    <dl style={listStyle}>
      {rows.map((row) => (
        <div key={row.key} style={rowStyle}>
          <dt style={labelStyle}>{row.label}</dt>
          <dd style={{ ...valueStyle, color: toneColor(row.tone) }}>{row.value}</dd>
        </div>
      ))}
    </dl>
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

const listStyle = { margin: 0, display: 'grid', minWidth: 0 } as const
const rowStyle = { display: 'grid', gridTemplateColumns: 'minmax(90px, 42%) minmax(0, 1fr)', alignItems: 'baseline',
  gap: '4px 10px', minWidth: 0, borderBottom: `1px solid ${COLOR.line}`, padding: '7px 12px' } as const
const labelStyle = { margin: 0, color: COLOR.inkMuted, fontSize: FONT_PX.menu } as const
const valueStyle = { margin: 0, fontSize: FONT_PX.body, fontWeight: 600 } as const
