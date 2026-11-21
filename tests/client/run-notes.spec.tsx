// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { createApiClient } from '../../src/client/api/client.ts'
import { PanelShell } from '../../src/client/panel/shell.tsx'
import { RunNotes } from '../../src/client/panel/run-notes.tsx'
import { renderPanel } from './harness.ts'

it('renders reference text literally, saves into the visible run, and reuses an unconfirmed operation', async () => {
  const writes: Record<string, unknown>[] = []
  const reads: string[] = []
  const reference = '<img src=x onerror=alert(1)>'
  const client = createApiClient('http://panel.test', async (input, init) => {
    const url = new URL(String(input))
    expect(url.pathname).toBe('/v1/run-notes')
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      if (writes.length === 1) throw new Error('unconfirmed')
    } else {
      reads.push(url.searchParams.get('run_id') ?? '')
    }
    const data = { items: writes.length < 2 ? [] : [
      { note_id: 'note', author: 'source', source: 'node', attempt: 1, body: reference, created_at: '2026-11-21T00:00:00.000Z' },
    ] }
    return { ok: true, status: 200, json: async () => ({ ok: true, schema_version: 1, as_of_seq: 1, data }) } as Response
  })
  const view = await renderPanel(<PanelShell activeRoute="tasks" onNavigate={() => undefined} serviceConnected>
    <RunNotes client={client} runId="this-run" reloadVersion={0} />
  </PanelShell>)
  try {
    await view.flush()
    expect(view.text()).toContain('本次运行暂无共同可见的便条')
    const input = view.container.querySelector('textarea')!
    const change = async (text: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const button = view.container.querySelector<HTMLButtonElement>('button[type=submit]')!
    await change('😀'.repeat(501))
    expect(button.disabled).toBe(true)
    await change('Fixture note')
    await view.click(button)
    await view.flush()
    expect(view.byRole('alert')).toHaveLength(1)
    await view.click(button)
    await view.flush()
    expect(writes).toEqual([
      { run_id: 'this-run', body: 'Fixture note', operation_id: expect.any(String) },
      writes[0],
    ])
    expect(reads).toEqual(['this-run', 'this-run'])
    expect(view.text()).toContain(reference)
    expect(view.findAll('img')).toHaveLength(0)
    expect(view.text()).toContain('步骤 source')
  } finally { view.unmount() }
})
