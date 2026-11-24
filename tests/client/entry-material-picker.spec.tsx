// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { MaterialPicker } from '../../src/client/panel/material-picker.tsx'
import { deferred, renderPanel } from './harness.ts'

it('keeps pasted material local until consent and preserves it after an unsuccessful grant', async () => {
  const grant = vi.fn().mockRejectedValueOnce(new Error('授权服务暂不可用')).mockResolvedValueOnce(undefined)
  const view = await renderPanel(<MaterialPicker recipients={['复核步骤 / 审计模型']} onGrant={grant} />)
  try {
    const area = view.container.querySelector('textarea')!
    const submit = view.container.querySelector('button')!
    expect(submit.disabled).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(area,'收入 10 元')
      area.dispatchEvent(new Event('input',{bubbles:true}))
    })
    expect(grant).not.toHaveBeenCalled()
    expect(view.text()).toContain('复核步骤 / 审计模型')
    await view.click(submit)
    expect(area.value).toBe('收入 10 元')
    expect(view.text()).toContain('授权服务暂不可用')
    await view.click(submit)
    expect(grant).toHaveBeenLastCalledWith([{name:'补充材料.txt',body:'收入 10 元'}])
    expect(area.value).toBe('')
  } finally { view.unmount() }
})

it('lists selected files before consent and reads the selected bytes only on submit', async () => {
  const grant = vi.fn().mockResolvedValue(undefined)
  const read = vi.fn().mockResolvedValue(new TextEncoder().encode('value\n10').buffer)
  const file = new File(['value\n10'],'income.csv',{type:'text/csv'})
  Object.defineProperty(file,'arrayBuffer',{value:read})
  const view = await renderPanel(<MaterialPicker recipients={['复核步骤 / 审计模型']} onGrant={grant} />)
  try {
    const input = view.container.querySelector('input')!
    await act(async () => {
      Object.defineProperty(input,'files',{configurable:true,value:[file]})
      input.dispatchEvent(new Event('change',{bubbles:true}))
    })
    expect(view.text()).toContain('income.csv')
    expect(read).not.toHaveBeenCalled()
    expect(grant).not.toHaveBeenCalled()
    await view.click(view.container.querySelector('button')!)
    expect(grant).toHaveBeenCalledWith([{name:'income.csv',body:'value\n10'}])
    expect(read).toHaveBeenCalledTimes(1)
  } finally { view.unmount() }
})

it('does not upload a locally selected file if its read completes after the material form leaves the session', async () => {
  const contents = deferred<ArrayBuffer>()
  const grant = vi.fn()
  const file = new File(['private'], '私有材料.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'arrayBuffer', { value: () => contents.promise })
  const view = await renderPanel(<MaterialPicker recipients={['核对材料']} onGrant={grant} />)
  const input = view.container.querySelector('input')!
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await view.click(view.container.querySelector('button')!)
  view.unmount()
  await act(async () => { contents.resolve(new TextEncoder().encode('private').buffer) })
  expect(grant).not.toHaveBeenCalled()
})
