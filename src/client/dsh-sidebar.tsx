import type { ReactElement } from 'react'
import { createPanelHost, type PanelHostProps } from './panel-host.tsx'

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

type DshClientContext = DshPanelContext & {
  inject(names: string[], callback: (ctx: DshClientContext) => void): unknown
  orchestraPanelTransport: DshOrchestraPanelTransport
}

export const inject = ['slots']

/** Wait for the trusted browser adapter in the same Cordis service scope. */
export function apply(ctx: DshClientContext): void {
  ctx.inject(['slots', 'orchestraPanelTransport'], function mountOrchestraPanel(ready) {
    registerDshOrchestraPanel(ready, ready.orchestraPanelTransport)
  })
}

/** Called by a trusted DSH web adapter after it resolves the workspace's endpoint and authenticated transport. */
export function registerDshOrchestraPanel(ctx: DshPanelContext, options: DshOrchestraPanelTransport) {
  if (typeof options?.baseUrl !== 'string' || !options.baseUrl.trim() || typeof options.fetcher !== 'function') {
    throw new TypeError('Orchestra requires an endpoint and an authenticated host fetcher')
  }
  const panel = createPanelHost(options)
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
