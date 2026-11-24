// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import { CommandSettings } from '../../src/client/panel/command-settings.tsx'
import { createApiClient } from '../../src/client/api/client.ts'
import { createClientCommandReservations, type DshCommandUi } from '../../src/client/dsh-command-reservations.ts'
import { deferred, renderPanel } from './harness.ts'

const response = (data: unknown) => Response.json({ ok: true, schema_version: 1, as_of_seq: 0, data })
const check = (name: string, conflict = false) => ({ name, available: !conflict, conflicts: conflict ? [{ kind: 'host_command', name, label: '已有宿主命令' }] : [] })
const registry = () => {
  const entries = new Set(['model'])
  const service: DshCommandUi = { register({ name }) {
    if (entries.has(name)) throw new Error('duplicate')
    entries.add(name); return () => { entries.delete(name) }
  } }
  return { entries, manager: createClientCommandReservations(service) }
}
const inputValue = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const settleCheck = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 390)) })

it('checks host and client names, normalizes a command, holds it through save and confirms the persisted revision', async () => {
  const local = registry()
  const writes: unknown[] = []
  const saveReply = deferred<Response>()
  let read = { name: 'orchestra', revision: 0, check: check('orchestra') }
  const client = createApiClient('http://panel.test', async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/check')) { const { name } = JSON.parse(String(init?.body)); return response(check(name, name === 'help')) }
    if (init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return saveReply.promise }
    return response(read)
  })
  const view = await renderPanel(<CommandSettings client={client} clientCommands={local.manager} />)
  const input = () => view.findAll('input')[0] as HTMLInputElement
  const save = () => view.findAll('button').find(button => button.textContent === '保存命令') as HTMLButtonElement
  try {
    await settleCheck()
    expect(input().value).toBe('/orchestra')
    await inputValue(input(), '/help'); await settleCheck()
    expect(view.text()).toContain('已有宿主命令'); expect(save().disabled).toBe(true)
    await inputValue(input(), '/model'); await settleCheck()
    expect(view.text()).toContain('客户端命令'); expect(save().disabled).toBe(true)
    await inputValue(input(), ' /GO_2 '); await settleCheck()
    expect(view.text()).toContain('/go_2 可用')
    expect(save().disabled).toBe(false)
    await view.click(save())
    expect(writes).toEqual([{ name: 'go_2', expected_revision: 0 }])
    expect(local.entries.has('go_2')).toBe(true)
    expect(local.entries.has('orchestra')).toBe(true)
    expect(save().disabled).toBe(true)
    read = { name: 'go_2', revision: 1, check: check('go_2') }
    saveReply.resolve(response(read)); await view.flush(); await settleCheck()
    expect(view.text()).toContain('已保存。现在使用 /go_2 任务内容')
    expect(input().value).toBe('/go_2')
    expect(local.entries.has('orchestra')).toBe(false)
    expect(local.entries.has('go_2')).toBe(true)
  } finally { view.unmount(); local.manager.dispose() }
  expect([...local.entries]).toEqual(['model'])
})

it('ignores stale validation, rejects a late save collision and releases a canceled reservation', async () => {
  const local = registry()
  const oldCheck = deferred<Response>()
  let activeSave = false
  let saveSignal: AbortSignal | null | undefined
  const delayedSave = deferred<Response>()
  const client = createApiClient('http://panel.test', async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/check')) {
      const { name } = JSON.parse(String(init?.body))
      return name === 'old' ? oldCheck.promise : response(check(name))
    }
    if (init?.method === 'POST') {
      if (activeSave) { saveSignal = init.signal; return delayedSave.promise }
      return Response.json({ ok: false, schema_version: 1, as_of_seq: 0, error: { code: 'COMMAND_BUSY', message: '/next 已被占用', retryable: true, details: {} } }, { status: 409 })
    }
    return response({ name: 'orchestra', revision: 0, check: check('orchestra') })
  })
  const view = await renderPanel(<CommandSettings client={client} clientCommands={local.manager} />)
  const input = () => view.findAll('input')[0] as HTMLInputElement
  const save = () => view.findAll('button').find(button => button.textContent === '保存命令') as HTMLButtonElement
  try {
    await settleCheck()
    await inputValue(input(), 'old'); await settleCheck()
    await inputValue(input(), 'next'); await settleCheck()
    oldCheck.resolve(response(check('old', true))); await view.flush()
    expect(view.text()).toContain('/next 可用')
    expect(view.text()).not.toContain('/old 不可用')
    await view.click(save()); await view.flush()
    expect(view.text()).toContain('/next 已被占用')
    expect(local.entries.has('next')).toBe(false)
    expect(local.entries.has('orchestra')).toBe(true)
    activeSave = true
    await inputValue(input(), 'later'); await settleCheck()
    await view.click(save())
    expect(saveSignal?.aborted).toBe(false)
    await view.rerender(<CommandSettings key="new-session" client={client} clientCommands={local.manager} />)
    expect(saveSignal?.aborted).toBe(true)
    delayedSave.resolve(response({ name: 'later', revision: 1, check: check('later') })); await view.flush()
    expect(local.entries.has('later')).toBe(false)
    expect(view.text()).not.toContain('已保存。现在使用 /later')
  } finally { view.unmount(); local.manager.dispose() }
})
