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

it('ignores a rapid double submit while the first save is still pending', async () => {
  let resolvePost!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => { resolvePost = resolve })
  let writes = 0
  const client = createApiClient('http://panel.test', async (_input, init) => {
    if (init?.method === 'POST') {
      writes++
      return pending
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, schema_version: 1, as_of_seq: 1,
      data: { items: [] } }) } as Response
  })
  const view = await renderPanel(<PanelShell activeRoute="tasks" onNavigate={() => undefined} serviceConnected>
    <RunNotes client={client} runId="same-run" reloadVersion={0} />
  </PanelShell>)
  try {
    await view.flush()
    const input = view.container.querySelector<HTMLTextAreaElement>('textarea')!
    const button = view.container.querySelector<HTMLButtonElement>('button[type=submit]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'one note')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      button.click()
      button.click()
    })
    expect(writes).toBe(1)
    expect(input.value).toBe('one note')
    expect(button.disabled).toBe(true)
    resolvePost({ ok: true, status: 200, json: async () => ({ ok: true, schema_version: 1, as_of_seq: 2,
      data: { note_id: 'saved-note', seq: 2 } }) } as Response)
    await view.flush()
    expect(writes).toBe(1)
    expect(input.value).toBe('')
    expect(view.text()).toContain('便条已添加')
  } finally { view.unmount() }
})

it('uses the shared A-workbench controls and clears the old draft when the run changes', async () => {
  const writes: string[] = []
  const client = createApiClient('http://panel.test', async (input, init) => {
    if (init?.method === 'POST') writes.push(String(init.body))
    const run = new URL(String(input)).searchParams.get('run_id')
    return { ok: true, status: 200, json: async () => ({ ok: true, schema_version: 1, as_of_seq: 1,
      data: { items: [{ note_id: run, author: 'source', source: 'node', attempt: 1, body: `note-${run}`, created_at: '2026-11-21T00:00:00.000Z' }] } }) } as Response
  })
  const panel = (runId: string, connected = true) => <PanelShell activeRoute="tasks" onNavigate={() => undefined} serviceConnected={connected}>
    <RunNotes client={client} runId={runId} reloadVersion={0} />
  </PanelShell>
  const view = await renderPanel(panel('first'))
  try {
    await view.flush()
    const input = view.container.querySelector<HTMLTextAreaElement>('textarea.ops-field')!
    expect(input).toBeTruthy()
    expect(input.labels?.[0]?.textContent).toBe('添加运行便条')
    expect(view.container.querySelector('form.ops-run-notes-form .ops-button.ops-button--primary')).toBeTruthy()
    expect(view.text()).toContain('note-first')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'old draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await view.rerender(panel('first', false))
    expect(view.container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true)
    await act(async () => { view.container.querySelector('form.ops-run-notes-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(writes).toEqual([])
    await view.rerender(panel('second'))
    await view.flush()
    expect(view.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('')
    expect(view.text()).not.toContain('note-first')
    expect(view.text()).toContain('note-second')
  } finally { view.unmount() }
})
