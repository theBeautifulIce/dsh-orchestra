import { expect, it } from 'vitest'
import { get } from 'node:http'
import { sha256Hex } from '../../src/core/canonical.ts'
import { OrchError } from '../../src/core/errors.ts'
import { type ArtifactReceiptLocation } from '../../src/core/receipt-location.ts'
import { createArtifactBrowserReader } from '../../src/service/artifact-browser.ts'

const location = (hash: string): ArtifactReceiptLocation => ({ kind: 'artifact', workspaceId: 'workspace', sessionId: 'session',
  taskId: 'task', runId: 'run', artifactId: 'artifact', sha256: hash })

it('serves a complete verified Markdown artifact over real loopback HTTP without executing its active content', async () => {
  const text = '# 完整成果\n\n' + '可验证的正文段落。\n'.repeat(3000)
    + '\n<script src="https://unsafe.invalid/run.js">secret()</script>\n'
    + '![远程图片](https://unsafe.invalid/track.gif)\n[来源](https://source.invalid/news)\n\n正文末尾：THE-EXACT-END-完整。'
  const bytes = Buffer.from(text)
  const sha256 = sha256Hex(bytes)
  let authorized = true
  let actual = bytes
  const reads: unknown[] = []
  const reader = createArtifactBrowserReader({ async read(target, identity) {
    reads.push({ target, identity })
    if (!authorized) throw new OrchError('FORBIDDEN', '来源授权已失效')
    return { fileName: '每日简报.md', bytes: actual, sha256 }
  } })
  let url = ''
  try {
    const opened = await reader.open(location(sha256), 'private-binding')
    url = opened.url
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/artifacts\/[a-f0-9]{64}$/u)
    expect(JSON.stringify(opened)).not.toContain('private-binding')
    expect(new URL(url).port).not.toBe('')
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await response.text()
    expect(Buffer.byteLength(html)).toBe(Number(response.headers.get('content-length')))
    expect(html).toContain('<h1>每日简报.md</h1>')
    expect(html.split('可验证的正文段落。')).toHaveLength(3001)
    expect(html).toContain('正文末尾：THE-EXACT-END-完整。')
    expect(html).not.toMatch(/<(?:script|img|iframe|object|embed)\b/iu)
    expect(html).not.toContain('https://unsafe.invalid/track.gif')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(reads).toHaveLength(2) // Mint and the actual browser GET both revalidate authorization.
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      get(url, { headers: { host: 'evil.invalid' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode))
      }).on('error', reject)
    })
    expect(badHost).toBe(403)
    expect((await fetch(url, { method: 'POST' })).status).toBe(405)
    expect((await fetch(url.replace(/.$/u, url.endsWith('0') ? '1' : '0'))).status).toBe(410)
    expect((await fetch(url + '/other')).status).toBe(410)
    authorized = false
    expect((await fetch(url)).status).toBe(403)
    authorized = true
    actual = Buffer.from('changed after publication')
    expect((await fetch(url)).status).toBe(409)
  } finally { await reader.close() }
  await expect(fetch(url)).rejects.toThrow()
})

it('expires access independently of the durable artifact identity and bounds active grants and size', async () => {
  const bytes = Buffer.from('历史成果末尾')
  const sha256 = sha256Hex(bytes)
  let now = Date.now()
  const reader = createArtifactBrowserReader({ now: () => now, capacity: 1, ttlMs: 50,
    read: async () => ({ fileName: '历史成果.txt', bytes, sha256 }) })
  try {
    const first = await reader.open(location(sha256), 'source')
    await expect(reader.open(location(sha256), 'source')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    now += 51
    const expired = await fetch(first.url)
    expect(expired.status).toBe(410)
    expect(await expired.text()).toContain('再次点击成果名称')
    const next = await reader.open(location(sha256), 'source')
    expect(next.url).not.toBe(first.url)
    expect(await (await fetch(next.url)).text()).toContain('历史成果末尾')
  } finally { await reader.close() }
  const tooLarge = createArtifactBrowserReader({ read: async () => ({ fileName: 'large.txt', bytes: Buffer.alloc(8 * 1024 * 1024 + 1), sha256 }) })
  try { await expect(tooLarge.open(location(sha256), 'source')).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE' }) }
  finally { await tooLarge.close() }
})

it('previews only verified common image bytes and keeps PDF and active image markup on the explicit download fallback', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LZsAAAAASUVORK5CYII=', 'base64')
  let item = { fileName: '图片.png', bytes: png, sha256: sha256Hex(png) }
  let available = true
  const reader = createArtifactBrowserReader({ read: async () => {
    if (!available) throw new OrchError('FORBIDDEN', '原会话授权已失效')
    return item
  } })
  try {
    const opened = await reader.open(location(item.sha256), 'source')
    const html = await (await fetch(opened.url)).text()
    expect(html).toContain(new URL(opened.url).pathname + '/image')
    expect(html).not.toContain('data:')
    const image = await fetch(opened.url + '/image')
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
    available = false
    expect((await fetch(opened.url + '/image')).status).toBe(403)
    available = true
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>run()</script></svg>')
    item = { fileName: '图形.svg', bytes: svg, sha256: sha256Hex(svg) }
    const safe = await reader.open(location(item.sha256), 'source')
    const escaped = await (await fetch(safe.url)).text()
    expect(escaped).toContain('&lt;svg')
    expect(escaped).not.toMatch(/<(?:svg|script|img)\b/iu)
    expect((await fetch(safe.url + '/image')).status).toBe(404)
    const pdf = Buffer.from('%PDF-1.7\nplain but not text preview')
    item = { fileName: '附件.pdf', bytes: pdf, sha256: sha256Hex(pdf) }
    const binary = await reader.open(location(item.sha256), 'source')
    const fallback = await (await fetch(binary.url)).text()
    expect(fallback).toContain('下载原件')
    expect(fallback).toContain('完整的原始文件')
    expect(fallback).not.toContain('PDF-1.7')
  } finally { await reader.close() }
})
