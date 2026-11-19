import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { registerRunArtifact, serveOrchestra } from '../../src/index.ts'
import { sha256Hex } from '../../src/core/canonical.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { createApiClient } from '../../src/client/api/client.ts'
import { createResourcesApi } from '../../src/client/api/resources.ts'
import { seed } from '../fixtures/ledger.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-artifacts-'))
  const secret = 'artifact-content-test'
  const service = await serveOrchestra({
    dbFile: join(dir, 'orchestra.db'), secret, phase: 'S5',
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'e' }),
  })
  cleanups.push(async () => {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const { db } = service.orchestra
  seed(db)
  withTx(db, (tx) => {
    tx.run("INSERT INTO runs (run_id, task_id, status, created_at, updated_at) VALUES ('r2', 't1', 'running', ?, ?)",
      ['2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z'])
  })
  const api = createResourcesApi(createApiClient(service.endpoint, (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('x-orchestra-secret', secret)
    return fetch(input, { ...init, headers })
  }))
  return { db, api, endpoint: service.endpoint, secret }
}

it('登记产物后，面板按运行预览和下载完整的已校验原始字节', async () => {
  const { db, api, endpoint, secret } = await boot()
  // Preview ends within a multi-byte character and always remains inert text.
  const bytes = Buffer.from('<script>alert(1)</script>\n' + '复'.repeat(20_000), 'utf8')
  const input = { artifactId: 'report-1', runId: 'r1', fileName: '项目复核.html', bytes, nodeRunId: 'nr1' }
  const metadata = registerRunArtifact(db, input)
  expect(registerRunArtifact(db, input)).toEqual(metadata)
  expect(() => registerRunArtifact(db, { ...input, bytes: Buffer.from('替换内容') })).toThrow(/其他内容或来源/)
  expect(() => registerRunArtifact(db, { ...input, runId: 'r2' })).toThrow(/所属的运行节点/)
  expect(db.raw.prepare("SELECT COUNT(*) count FROM events WHERE type = 'artifact.registered'").get()).toMatchObject({ count: 1 })
  expect((await api.listRunArtifacts('r1')).data.items).toEqual([expect.objectContaining({
    artifact_id: input.artifactId, file_name: input.fileName, source_node_run_id: 'nr1',
    sha256: sha256Hex(bytes), size_bytes: bytes.byteLength,
  })])
  const url = endpoint + '/v1/artifacts/content?run_id=r1&artifact_id=report-1&mode=preview'
  const forbidden = await fetch(url)
  expect(forbidden.status).toBe(401)
  await forbidden.text()
  const preview = await fetch(url, { headers: { 'x-orchestra-secret': secret } })
  expect(preview.headers.get('x-content-type-options')).toBe('nosniff')
  expect(preview.headers.get('cache-control')).toBe('private, no-store')
  expect(preview.headers.get('content-type')).toBe('application/json; charset=utf-8')
  expect(await preview.json()).toMatchObject({
    ok: true, data: { kind: 'preview', text: expect.stringMatching(/^<script>alert\(1\)<\/script>\n复+$/), truncated: true },
  })
  const downloaded = (await api.getArtifactContent('r1', input.artifactId, 'download')).data
  expect(downloaded.kind).toBe('download')
  if (downloaded.kind !== 'download') throw new Error('missing download')
  expect(Buffer.from(downloaded.base64, 'base64')).toEqual(bytes)
  await expect(api.getArtifactContent('r2', input.artifactId, 'download')).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

it('拒绝读取已过期、被篡改或只有外部 URI 的产物', async () => {
  const { db, api } = await boot()
  const bytes = Buffer.from('交付内容')
  registerRunArtifact(db, { artifactId: 'expired', runId: 'r1', fileName: '历史.txt', bytes, retainUntil: '2000-01-01T00:00:00.000Z' })
  registerRunArtifact(db, { artifactId: 'changed', runId: 'r1', fileName: '当期.txt', bytes })
  registerRunArtifact(db, { artifactId: 'archive', runId: 'r1', fileName: '记录.zip', bytes: new Uint8Array([0, 1, 2, 3]) })
  withTx(db, (tx) => {
    tx.run("UPDATE artifact_contents SET bytes = ? WHERE artifact_id = 'changed'", [Buffer.from('伪造内容')])
    tx.run("INSERT INTO artifacts (artifact_id, run_id, uri, sha256, created_at) VALUES ('legacy', 'r1', 'file:///private/legacy.txt', ?, ?)",
      [sha256Hex(bytes), new Date().toISOString()])
  })
  const listed = (await api.listRunArtifacts('r1')).data
  expect(listed.items.find((item) => item.artifact_id === 'expired')).toMatchObject({ expired: true })
  expect(JSON.stringify(listed)).not.toContain('file:///private/legacy.txt')
  await expect(api.getArtifactContent('r1', 'expired', 'download')).rejects.toMatchObject({ code: 'OPERATION_EXPIRED' })
  await expect(api.getArtifactContent('r1', 'changed', 'preview')).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' })
  await expect(api.getArtifactContent('r1', 'legacy', 'download')).rejects.toMatchObject({ code: 'EVIDENCE_SOURCE_UNAVAILABLE' })
  await expect(api.getArtifactContent('r1', 'archive', 'preview')).rejects.toMatchObject({ code: 'RESOLUTION_NOT_AVAILABLE' })
  expect((await api.getArtifactContent('r1', 'archive', 'download')).data).toMatchObject({ kind: 'download', base64: 'AAECAw==' })
  expect(() => registerRunArtifact(db, { artifactId: 'unsafe', runId: 'r1', fileName: '../secret.txt', bytes })).toThrow(/普通文件名/)
  expect(() => registerRunArtifact(db, {
    artifactId: 'over-cap', runId: 'r1', fileName: 'oversized.bin', bytes: new Uint8Array(8 * 1024 * 1024 + 1),
  })).toThrow(/8 MiB/)
  // A trusted producer can supply matching bytes for a legacy metadata record.
  registerRunArtifact(db, { artifactId: 'legacy', runId: 'r1', fileName: '历史记录.txt', bytes })
  expect((await api.getArtifactContent('r1', 'legacy', 'preview')).data).toMatchObject({ text: '交付内容' })
})
