// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { openPanelReceipt } from '../../src/client/dsh-panel-navigation.ts'
import { PanelApp } from '../../src/client/panel/app.tsx'
import { createApiClient } from '../../src/client/api/client.ts'
import type { PanelReceiptLocation } from '../../src/core/receipt-location.ts'
import { createFakeService, decisionView, deferred, page, renderPanel } from './harness.ts'

const target: PanelReceiptLocation = { kind: 'decision', sessionId: 'source', workspaceId: 'work', taskId: 'task', runId: 'run', decisionId: 'decision' }
function environment() {
  let selected = 'source'
  let archived = false
  const sources = {
    sessions: { list: { getSnapshot: () => ({ byId: { [selected]: { id: selected, retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'work', sessionIds: ['source', 'other'] }],
      archivedSessionIds: archived ? ['source'] : [] }), subscribe: () => () => {} } },
  }
  const control = new AbortController()
  const host = { layout: { beginNavigation: () => control.signal, selectPanel: vi.fn() } }
  return { sources, host, control, switch: () => { selected = 'other' }, archive: () => { archived = true } }
}
const response = (data: unknown) => Response.json({ ok: true, schema_version: 1, as_of_seq: 1, data })

it('revalidates the exact run and decision before opening the scoped approval, without submitting a resolution', async () => {
  const context = environment()
  const opened = vi.fn()
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe('GET')
    const url = new URL(String(input), 'dsh-app://app')
    expect(url.searchParams.get('sessionId')).toBe('source')
    expect(url.searchParams.get('workspaceId')).toBe('work')
    const path = new URL(url.searchParams.get('path')!, 'http://fixture.test')
    if (path.pathname === '/v1/runs/get') return response({ task_id: 'task', run_id: 'run' })
    expect(path.searchParams.get('decision_id')).toBe('decision')
    return response({ decision_id: 'decision', run_id: 'run', status: 'resolved' })
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    await openPanelReceipt(target, context.sources, context.host, opened)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(opened).toHaveBeenCalledWith(target)
    expect(context.host.layout.selectPanel).toHaveBeenCalledWith('dsh-orchestra')
  } finally { vi.unstubAllGlobals() }
})

it.each(['switched', 'archived', 'wrong-run', 'late-switch', 'superseded'] as const)
('does not navigate on %s scope or stale ownership', async reason => {
  const context = environment()
  const opened = vi.fn()
  if (reason === 'switched') context.switch()
  if (reason === 'archived') context.archive()
  const wait = deferred<Response>()
  const fetcher = vi.fn(async () => {
    if (reason === 'late-switch' || reason === 'superseded') return wait.promise
    return response({ task_id: 'task', run_id: 'wrong' })
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    const pending = openPanelReceipt(target, context.sources, context.host, opened)
    const rejected = expect(pending).rejects.toThrow()
    if (reason === 'late-switch') context.switch()
    if (reason === 'superseded') context.control.abort()
    wait.resolve(response({ task_id: 'task', run_id: 'run' }))
    await rejected
    expect(opened).not.toHaveBeenCalled()
    expect(context.host.layout.selectPanel).not.toHaveBeenCalled()
    if (reason === 'switched' || reason === 'archived') expect(fetcher).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

it('opens the exact decision detail on panel mount, including a previously resolved item', async () => {
  const service = createFakeService(({ path, params }) => ({ ok: true, data: path === '/v1/decisions/get'
    ? decisionView({ decision_id: params.get('decision_id')!, run_id: 'run', node_run_id: null, status: 'resolved',
      target_summary: '来源会话选中的核验事项', allowed_resolutions: [], required_evidence: [] }) : page([]) }))
  const view = await renderPanel(<PanelApp client={createApiClient('http://service.test', service.fetcher)}
    serviceConnected initialLocation={target} />)
  try {
    await view.flush()
    expect(service.calls.find(call => call.path === '/v1/decisions/get')?.params.get('decision_id')).toBe('decision')
    expect(view.text()).toContain('来源会话选中的核验事项')
    expect(service.calls.some(call => call.path.includes('resolve'))).toBe(false)
  } finally { view.unmount() }
})
