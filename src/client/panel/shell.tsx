import { createContext, useContext, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import type { StreamStatus } from '../api/sse.ts'

export const PANEL_ROUTES = [
  { id: 'tasks', label: '任务' },
  { id: 'decisions', label: '等你决定' },
  { id: 'effects', label: '待核实' },
  { id: 'workflows', label: '流程' },
  { id: 'memory', label: '记忆' },
  { id: 'settings', label: '设置' },
] as const

export type PanelRoute = (typeof PANEL_ROUTES)[number]['id']
export type PanelShellProps = {
  activeRoute: PanelRoute
  onNavigate: (route: PanelRoute) => void
  serviceConnected: boolean
  protocolMismatch?: boolean
  snapshotStale?: boolean
  streamStatus?: StreamStatus
  children?: ReactNode
}

type CommandsAvailability = { enabled: boolean; reason: string }
const CommandsEnabledContext = createContext<CommandsAvailability>({ enabled: false, reason: COPY.serviceDown })

/** Write controls default to disabled outside a connected panel shell. */
export function usePanelCommandsEnabled(): boolean {
  return useContext(CommandsEnabledContext).enabled
}

export function PanelCommandButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { enabled, reason } = useContext(CommandsEnabledContext)
  const { disabled, title, type, ...rest } = props
  return <button
    {...rest}
    type={type ?? 'button'}
    disabled={disabled || !enabled}
    title={!enabled ? reason : title}
  />
}

export function UnknownState({ value }: { value: string }) {
  return <span role="status" title={value} style={{ color: COLOR.warning }}>
    {COPY.oldPanel}：{value}
  </span>
}

export function PanelShell(props: PanelShellProps) {
  if (props.protocolMismatch) {
    return <main role="alert" style={fullPageStyle}>
      <h1 style={{ fontSize: FONT_PX.title }}>{COPY.protocolMismatch}</h1>
    </main>
  }

  const stateLabel = !props.serviceConnected
    ? COPY.serviceDown
    : props.streamStatus === 'polling' ? '轮询更新' : props.streamStatus === 'stale' ? '数据可能已过期' : props.streamStatus === 'live' ? '实时更新' : '服务已连接'
  const isStale = props.snapshotStale || props.streamStatus === 'stale'
  const commandsEnabled = props.serviceConnected && !isStale
  const commandsUnavailableReason = !props.serviceConnected ? COPY.serviceDown : COPY.staleNotice
  return <CommandsEnabledContext.Provider value={{ enabled: commandsEnabled, reason: commandsUnavailableReason }}>
  <div style={appStyle}>
    <aside aria-label="主导航" style={sidebarStyle}>
      <div style={brandStyle}>Orchestra</div>
      <nav aria-label="主菜单" style={{ display: 'grid', gap: 4 }}>
        {PANEL_ROUTES.map((route) => <button
          key={route.id}
          type="button"
          aria-current={props.activeRoute === route.id ? 'page' : undefined}
          onClick={() => props.onNavigate(route.id)}
          style={{ ...navButtonStyle, ...(props.activeRoute === route.id ? activeNavStyle : {}) }}
        >{route.label}</button>)}
      </nav>
    </aside>
    <div style={{ minWidth: 0, flex: 1 }}>
      <header style={headerStyle}>
        <strong>{PANEL_ROUTES.find((route) => route.id === props.activeRoute)?.label}</strong>
        <span role="status" style={{ color: props.serviceConnected ? COLOR.success : COLOR.warning }}>
          {stateLabel}
        </span>
      </header>
      {(!props.serviceConnected || isStale) && <div role="status" style={noticeStyle}>
        {COPY.staleNotice}。当前页面保留已加载内容，写入操作应由页面禁用。
      </div>}
      <main id="panel-content" style={contentStyle}>{props.children}</main>
    </div>
  </div>
  </CommandsEnabledContext.Provider>
}

const appStyle = { minHeight: '100vh', display: 'flex', background: COLOR.canvas, color: COLOR.ink, fontSize: FONT_PX.body, lineHeight: 1.55 } as const
const sidebarStyle = { width: 236, flex: '0 0 236px', padding: '22px 14px', boxSizing: 'border-box' as const, background: COLOR.sidebar, borderRight: `1px solid ${COLOR.line}` }
const brandStyle = { fontSize: 16, fontWeight: 700, padding: '4px 10px 22px' } as const
const navButtonStyle = { minHeight: 40, padding: '0 12px', border: 0, borderRadius: 7, textAlign: 'left' as const, background: 'transparent', color: COLOR.ink, font: `500 ${FONT_PX.menu}px system-ui, sans-serif`, cursor: 'pointer' }
const activeNavStyle = { background: '#e9edf2', fontWeight: 700 } as const
const headerStyle = { height: 58, padding: '0 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${COLOR.line}`, fontSize: FONT_PX.menu } as const
const noticeStyle = { padding: '10px 28px', background: '#fff8e9', color: COLOR.warning, borderBottom: `1px solid ${COLOR.line}`, fontSize: FONT_PX.helper } as const
const contentStyle = { maxWidth: 1780, margin: '0 auto', padding: '28px 32px 80px', minWidth: 0 } as const
const fullPageStyle = { minHeight: '100vh', display: 'grid', placeContent: 'center', padding: 24, background: COLOR.canvas, color: COLOR.ink, textAlign: 'center' as const }
