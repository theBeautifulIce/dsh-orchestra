import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GateCard } from '../../src/client/panel/gate-card.tsx'

it('renders the gate, one conclusion and the next person and action without internal identity', () => {
  const card = renderToStaticMarkup(<GateCard state="approval" />)
  expect(card).toContain('S6 · G6 发布门')
  expect(card).toContain('判卷通过，等待人工确认')
  expect(card).toContain('获授权的审批人')
  expect(card).toContain('在受信工作区完成二次确认')
  expect(card).not.toMatch(/run_id|node_run_id|event_id|部署/)
  expect(renderToStaticMarkup(<GateCard state="confirmed" />)).toContain('等待独立联检')
})
