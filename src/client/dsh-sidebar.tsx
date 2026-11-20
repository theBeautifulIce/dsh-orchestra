import type { ReactElement } from 'react'
import { createPanelHost, type PanelHostProps } from './panel-host.tsx'

const panelId = 'dsh-orchestra'
type PanelSlot =
  | { name: 'main'; key: string }
  | { name: 'sidebar.panellist'; id: string; order: number; label: () => string }

export type DshPanelContext = {
  effect(register: () => Generator<unknown, void, unknown>, label: string): unknown
  slots: {
    inject(slot: PanelSlot['name'], register: () => unknown): unknown
    register(slot: PanelSlot, component: () => ReactElement): unknown
  }
}

/** Called by a trusted DSH web adapter after it resolves the workspace's endpoint and authenticated transport. */
export function registerDshOrchestraPanel(ctx: DshPanelContext, options: PanelHostProps & { fetcher: NonNullable<PanelHostProps['fetcher']> }) {
  const panel = createPanelHost(options)
  const icon = () => <span aria-hidden="true">◫</span>
  return ctx.effect(function* () {
    yield ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, panel))
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: panelId, order: 20, label: () => 'Orchestra',
    }, icon))
  }, 'orchestra: authenticated workspace panel')
}
