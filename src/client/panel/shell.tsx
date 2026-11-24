import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { COPY } from './copy.ts'
import { COLOR, FONT_PX } from './tokens.ts'
import type { StreamStatus } from '../api/sse.ts'
import { PANEL_LAYOUT_CSS } from './panel-layout.ts'
import { RouteIcon } from './route-icons.tsx'

export const PANEL_ROUTES = [
  { id: 'overview', label: '总览' },
  { id: 'tasks', label: '任务' },
  { id: 'decisions', label: '审批中心' },
  { id: 'effects', label: '操作核验' },
  { id: 'workflows', label: 'Workflow 管理' },
  { id: 'activity', label: '事件日志' },
  { id: 'collaboration', label: '协作核验' },
  { id: 'memory', label: '记忆' },
  { id: 'settings', label: '设置' },
] as const

export type PanelRoute = (typeof PANEL_ROUTES)[number]['id']
const NAV_GROUPS: readonly { label: string; routes: readonly PanelRoute[] }[] = [
  { label: '工作空间', routes: ['overview', 'tasks'] },
  { label: '处理与核验', routes: ['decisions', 'effects'] },
  { label: '资源与记录', routes: ['workflows', 'activity', 'collaboration', 'memory'] },
  { label: '偏好与服务', routes: ['settings'] },
]
type SettingsSection = { id: string; label: string }
export type PanelShellProps = {
  activeRoute: PanelRoute
  onNavigate: (route: PanelRoute) => void
  serviceConnected: boolean
  protocolMismatch?: boolean
  snapshotStale?: boolean
  streamStatus?: StreamStatus
  collaborationEnabled?: boolean
  settingsSections?: readonly SettingsSection[]
  children?: ReactNode
}

type CommandsAvailability = { enabled: boolean; reason: string }
const CommandsEnabledContext = createContext<CommandsAvailability | null>(null)

/** Write controls default to disabled outside a connected panel shell. */
export function usePanelCommandsEnabled(standalone = false): boolean {
  return useContext(CommandsEnabledContext)?.enabled ?? standalone
}

export function PanelCommandButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { enabled, reason } = useContext(CommandsEnabledContext) ?? { enabled: false, reason: COPY.serviceDown }
  const { disabled, title, type, ...rest } = props
  return <button
    {...rest}
    type={type ?? 'button'}
    disabled={disabled || !enabled}
    title={!enabled ? reason : title}
  />
}

export function UnknownState(_props: { value: string }) {
  return <span role="status" style={{ color: COLOR.warning }}>
    {COPY.oldPanel}
  </span>
}

export function PanelShell(props: PanelShellProps) {
  const content = useRef<HTMLElement>(null)
  const settingsMenuId = useId()
  const [activeSettingsSection, setActiveSettingsSection] = useState<string>()
  const settingsOpen = props.activeRoute === 'settings' && !!props.settingsSections?.length
  useLayoutEffect(() => {
    if (content.current) {
      content.current.scrollTop = 0
      content.current.scrollLeft = 0
    }
    setActiveSettingsSection(undefined)
  }, [props.activeRoute])

  useLayoutEffect(() => {
    if (activeSettingsSection && !props.settingsSections?.some(({ id }) => id === activeSettingsSection)) {
      setActiveSettingsSection(undefined)
    }
  }, [activeSettingsSection, props.settingsSections])

  function openSettingsSection(id: string) {
    const scroller = content.current
    const heading = scroller?.querySelector<HTMLElement>(`#${id}`)
    if (!scroller || !heading) return

    const offset = heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTop += offset - 12
    heading.focus({ preventScroll: true })
    setActiveSettingsSection(id)
  }

  if (props.protocolMismatch) {
    return <div className="ops-panel-viewport" style={appStyle}>
      <style>{PANEL_LAYOUT_CSS}</style>
      <main role="alert" className="ops-panel-protocol-error">
        <h1 style={{ fontSize: FONT_PX.title }}>{COPY.protocolMismatch}</h1>
      </main>
    </div>
  }

  const isStale = props.snapshotStale || props.streamStatus === 'stale'
  const stateLabel = !props.serviceConnected
    ? COPY.serviceDown
    : isStale ? '数据可能已过期' : props.streamStatus === 'polling' ? '轮询更新' : props.streamStatus === 'live' ? '实时更新' : '服务已连接'
  const commandsEnabled = props.serviceConnected && !isStale
  const commandsUnavailableReason = !props.serviceConnected ? COPY.serviceDown : COPY.staleNotice
  return <CommandsEnabledContext.Provider value={{ enabled: commandsEnabled, reason: commandsUnavailableReason }}>
    <div className="ops-panel-viewport" style={appStyle}>
      <style>{PANEL_LAYOUT_CSS}</style>
      <button type="button" className="ops-skip-link" aria-controls="panel-content"
        onClick={() => content.current?.focus({ preventScroll: true })}>跳到主要内容</button>
      <div className="ops-shell" data-panel-route={props.activeRoute}>
        <aside aria-label="主导航" className="ops-shell-sidebar">
          <div className="ops-shell-identity">
            <div className="ops-shell-brand">Orchestra<span aria-hidden="true" /></div>
            <p className="ops-shell-caption">任务与协作工作台</p>
          </div>
          <nav aria-label="主菜单" className="ops-main-menu">
            {NAV_GROUPS.map((group) => <div key={group.label} className="ops-nav-group" role="group" aria-label={group.label}>
              <div className="ops-nav-group-label" aria-hidden="true">{group.label}</div>
              {PANEL_ROUTES.filter((route) => group.routes.includes(route.id) && (route.id !== 'collaboration' || props.collaborationEnabled)).map((route) => <button
                key={route.id}
                type="button"
                className="ops-nav-button"
                aria-current={props.activeRoute === route.id ? 'page' : undefined}
                aria-expanded={route.id === 'settings' && props.settingsSections?.length ? settingsOpen : undefined}
                aria-controls={route.id === 'settings' && settingsOpen ? settingsMenuId : undefined}
                onClick={() => props.onNavigate(route.id)}
              ><RouteIcon route={route.id} /><span>{route.label}</span></button>)}
            </div>)}
          </nav>
          {settingsOpen && <nav id={settingsMenuId} aria-label="设置子菜单" className="ops-settings-menu">
            {props.settingsSections?.map(({ id, label }) => <button key={id} type="button"
              aria-current={activeSettingsSection === id ? 'location' : undefined}
              aria-controls={id}
              onClick={() => openSettingsSection(id)}
            >{label}</button>)}
          </nav>}
        </aside>
        <div className="ops-shell-main" data-panel-route={props.activeRoute}>
          <header className="ops-shell-header">
            <div className="ops-breadcrumb" aria-label="当前位置">
              <span>工作空间</span><span aria-hidden="true">/</span>
              <strong>{PANEL_ROUTES.find((route) => route.id === props.activeRoute)?.label}</strong>
            </div>
            <span role="status" className="ops-connection-state"
              data-tone={!props.serviceConnected || isStale ? 'warning' : props.streamStatus === 'polling' ? 'info' : 'success'}>
              <span className="ops-state-dot" aria-hidden="true" />{stateLabel}
            </span>
          </header>
          {(!props.serviceConnected || isStale) && <div role="status" className="ops-connection-notice">
            {COPY.staleNotice}。刷新成功后可继续写入。
          </div>}
          <main id="panel-content" ref={content} tabIndex={0}>
            <div className="ops-panel-content-inner">{props.children}</div>
          </main>
        </div>
      </div>
    </div>
  </CommandsEnabledContext.Provider>
}

const appStyle = { background: COLOR.canvas, color: COLOR.ink, fontSize: FONT_PX.body, lineHeight: 1.6,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' } as const
