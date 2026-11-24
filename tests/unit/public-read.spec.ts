import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { publicReadInput, readAihotPublic } from '../../src/executor/public-read.ts'

const signal = () => new AbortController().signal
it('读取固定匿名端点，保留来源与原文，并且禁止重定向和凭据', async () => {
  const body = '# 今日热点\n没有可核实条目。'
  const request = vi.fn(async (_url: unknown, _init: unknown) => new Response(body, { headers: { 'content-type': 'text/markdown; charset=utf-8' } }))
  const result = await readAihotPublic({ action: 'aihot_latest' }, signal(), request as typeof fetch)
  expect(request).toHaveBeenCalledWith('https://aihot.news/api/v1/agent/latest', expect.objectContaining({
    method: 'GET', redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal),
  }))
  expect(result).toMatchObject({ text: body, source_url: 'https://aihot.news/api/v1/agent/latest', untrusted: true,
    sha256: createHash('sha256').update(body).digest('hex') })
  expect(Number.isFinite(Date.parse(result.fetched_at))).toBe(true)
})

it.each([
  { action: 'aihot_latest', url: 'http://127.0.0.1/private' },
  { action: 'aihot_latest', headers: { Authorization: 'secret' } },
  { action: 'aihot_latest', command: 'pwsh -Command Remove-Item' },
  { action: 'other_site' },
])('拒绝自由URL、请求头和命令参数：%j', value => {
  expect(publicReadInput.safeParse(value).success).toBe(false)
})

it.each([429, 500, 302])('HTTP %s 返回错误，不能变成空成果或成功', async status => {
  const request = vi.fn(async () => new Response('not news', { status, headers: { 'content-type': 'text/plain' } }))
  await expect(readAihotPublic({ action: 'aihot_latest' }, signal(), request as typeof fetch)).rejects.toThrow('读取失败')
  expect(request).toHaveBeenCalledTimes(1)
})

it('流式超过上限时取消读取，不能静默截断成果', async () => {
  const cancel = vi.fn()
  let chunk = 0
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(32 * 1024)); if (++chunk === 5) controller.close() }, cancel,
  }), { headers: { 'content-type': 'text/plain' } })
  await expect(readAihotPublic({ action: 'aihot_latest' }, signal(), async () => response)).rejects.toThrow('超过64 KiB')
  expect(cancel).toHaveBeenCalled()
})

it('取消后不发送请求，空正文不等于查询完成', async () => {
  const control = new AbortController()
  control.abort()
  const request = vi.fn(async () => new Response('', { headers: { 'content-type': 'text/plain' } }))
  await expect(readAihotPublic({ action: 'aihot_latest' }, control.signal, request as typeof fetch)).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
  await expect(readAihotPublic({ action: 'aihot_latest' }, signal(), request as typeof fetch)).rejects.toThrow('空正文')
})
