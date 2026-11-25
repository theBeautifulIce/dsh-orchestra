import { useSyncExternalStore, type ReactElement } from 'react'
import { DshLocalPanel, isDshLocalShell, type DshLocalPanelSources } from './dsh-local-panel.tsx'
import { formatNativeOrchestraApprovalCards } from './dsh-orchestra-approval-card.ts'
import { registerNativeOrchestraSlash, type NativeOrchestraSlashContext } from './dsh-orchestra-slash.ts'
import { createClientCommandReservations, type ClientCommandReservations, type DshCommandUi } from './dsh-command-reservations.ts'
import { registerNativeOrchestraToolView, type NativeOrchestraToolViewContext } from './dsh-orchestra-toolview.tsx'
import { registerNativeOrchestraNotices, type NativeOrchestraNoticeContext } from './dsh-orchestra-notice.tsx'
import { createPanelHost, type PanelHostProps } from './panel-host.tsx'
import { openPanelReceipt, type OpenPanelReceipt, type PanelNavigationHost } from './dsh-panel-navigation.ts'
import type { PanelReceiptLocation } from '../core/receipt-location.ts'

const panelId = 'dsh-orchestra'
const registeredRoots = new WeakSet<object>()
type PanelSlot =
  | { name: 'main'; key: string }
  | { name: 'sidebar.panellist'; id: string; order: number; label: () => string }

export type DshPanelContext = {
  root?: object
  effect(register: () => Generator<unknown, void, unknown>, label: string): unknown
  slots: {
    inject(slot: PanelSlot['name'], register: () => unknown): unknown
    register(slot: PanelSlot, component: () => ReactElement): unknown
  }
}

export type DshOrchestraPanelTransport = PanelHostProps & { fetcher: NonNullable<PanelHostProps['fetcher']> }

type Panel = () => ReactElement
type DshClientContext = DshPanelContext & NativeOrchestraSlashContext & NativeOrchestraToolViewContext & {
  commandUi: DshCommandUi
  inject(names: string[], callback: (ctx: DshClientContext) => void): unknown
  orchestraPanelTransport: DshOrchestraPanelTransport
  layout: PanelNavigationHost['layout']
}

export const inject = ['slots']

/** Activate the host panel while a trusted transport is available in this scope. */
export function apply(ctx: DshClientContext): void {
  let reviewSources: DshLocalPanelSources | undefined
  let clientCommands: ClientCommandReservations | undefined
  let refreshLocal: (() => void) | undefined
  let navigationHost: PanelNavigationHost | undefined
  let localLocation: PanelReceiptLocation | undefined
  const openLocation: OpenPanelReceipt = (location, signal) => openPanelReceipt(location, reviewSources, navigationHost, target => {
    if (!refreshLocal || explicit) throw new Error('当前面板连接已变化。请从当前会话重新打开 Orchestra。')
    localLocation = target
    refreshLocal()
  }, signal)
  const { openArtifact, downloadArtifact } = registerNativeOrchestraNotices(ctx as unknown as NativeOrchestraNoticeContext, () => reviewSources, openLocation)
  registerNativeOrchestraToolView(ctx, () => reviewSources, openArtifact, downloadArtifact, openLocation)
  let explicit: Panel | undefined
  let local: Panel | undefined
  let unmount: (() => unknown) | undefined
  let unmounting: Promise<unknown> | undefined
  const listeners = new Set<() => void>()

  function ActivePanel() {
    const Panel = useSyncExternalStore(listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }, () => explicit ?? local)
    return Panel ? <Panel /> : <></>
  }

  function refresh() {
    for (const listener of listeners) listener()
    if (explicit || local) {
      if (!unmount && !unmounting) {
        const dispose = registerSlots(ctx, ActivePanel)
        if (typeof dispose === 'function') unmount = dispose as () => unknown
      }
    } else if (unmount) {
      const dispose = unmount
      unmount = undefined
      unmounting = Promise.resolve(dispose()).finally(() => {
        unmounting = undefined
        refresh()
      })
      return unmounting
    }
  }

  ctx.inject(['slots', 'orchestraPanelTransport'], function bindHostAdapter(ready) {
    ready.effect(function* () {
      explicit = bindTransport(ready.orchestraPanelTransport)
      refresh()
      yield () => { explicit = undefined; return refresh() }
    }, 'orchestra: provided transport')
  })

  ctx.inject(['layout'], ready => {
    ready.effect(function* () {
      navigationHost = ready
      yield () => { if (navigationHost === ready) navigationHost = undefined }
    }, 'orchestra: scoped panel navigation')
  })

  if (typeof window === 'undefined' || !window.location?.href || !isDshLocalShell(window.location.href)) return
  ctx.effect(function* () {
    yield formatNativeOrchestraApprovalCards(window.document)
  }, 'orchestra: native approval fields')
  ctx.inject(['sessions', 'workspaces', 'inputTriggers', 'commandUi'], ready => {
    ready.effect(function* () {
      const reservations = createClientCommandReservations(ready.commandUi)
      clientCommands = reservations
      refreshLocal?.()
      yield () => { clientCommands = undefined; reservations.dispose(); refreshLocal?.() }
      yield registerNativeOrchestraSlash(ready, (input, init) => window.fetch(input, init), reservations)
    }, 'orchestra: native slash suggestion')
  })
  ctx.inject(['slots', 'sessions', 'workspaces'], function bindLocalShell(ready) {
    ready.effect(function* () {
      const { sessions, workspaces } = ready
      reviewSources = { sessions, workspaces }
      refreshLocal = () => {
        local = () => <DshLocalPanel sessions={sessions} workspaces={workspaces} clientCommands={clientCommands} initialLocation={localLocation} />
        refresh()
      }
      refreshLocal()
      yield () => { refreshLocal = undefined; local = undefined; reviewSources = undefined; return refresh() }
    }, 'orchestra: local DSH workspace transport')
  })
}

/** Called by a trusted DSH web adapter after it resolves the workspace's endpoint and authenticated transport. */
export function registerDshOrchestraPanel(ctx: DshPanelContext, options: DshOrchestraPanelTransport) {
  return registerSlots(ctx, bindTransport(options))
}

function bindTransport(options: DshOrchestraPanelTransport): Panel {
  if (typeof options?.baseUrl !== 'string' || !options.baseUrl.trim() || typeof options.fetcher !== 'function') {
    throw new TypeError('Orchestra requires an endpoint and an authenticated host fetcher')
  }
  return createPanelHost(options)
}

function registerSlots(ctx: DshPanelContext, panel: Panel) {
  const icon = () => <span aria-hidden="true">◫</span>
  const root = ctx.root
  return ctx.effect(function* () {
    if (root) {
      if (registeredRoots.has(root)) return
      registeredRoots.add(root)
      yield () => { registeredRoots.delete(root) }
    }
    yield ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, panel))
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: panelId, order: 20, label: () => 'Orchestra',
    }, icon))
  }, 'orchestra: authenticated workspace panel')
}
