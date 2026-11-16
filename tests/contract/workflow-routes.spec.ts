// S4 工作流命令的 HTTP 入口：四个写命令强制 operation_id（规格 3.7）
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openServiceOrchestra } from '../../src/index.ts'
import { startServer } from '../../src/service/server.ts'

const SECRET = 'wf-routes-secret'
const NOW = '2026-11-16T17:00:00.000Z'
const closers: (() => Promise<void>)[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) { try { await close() } catch { /* 已关 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-wf-routes-'))
  dirs.push(dir)
  const service = await openServiceOrchestra({ dbFile: join(dir, 'orchestra.db'), secret: SECRET, phase: 'S2' })
  const svc = await startServer({
    secret: SECRET, phase: 'S2', epoch: service.orchestra.db.epoch,
    asOfSeq: () => 0,
    listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'e' }),
    now: () => NOW,
    commands: service.orchestra.commands,
  })
  closers.push(async () => { await svc.close(); await service.release() })
  return svc.endpoint
}

const post = (url: string, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orchestra-secret': SECRET },
  body: JSON.stringify(body),
})

const doc = {
  name: '发布流程',
  nodes: [
    { node_id: 't', type: 'trigger', title: '入口', position: { x: 0, y: 0 }, config: {} },
    { node_id: 'a', type: 'agent', title: '执行', position: { x: 100, y: 0 }, config: {} },
  ],
  edges: [{ from: 't', to: 'a' }],
}

describe('工作流命令 HTTP 入口', () => {
  it('缺 operation_id 直接 400：写命令一律要走幂等协议', async () => {
    const base = await boot()
    const res = await post(base + '/v1/workflows', {
      workflow_id: 'wf1', name: '发布流程', definition: doc, now: NOW,
    })
    expect(res.status).toBe(400)
  })

  it('create → publish → 重放：版本只出一个，回执标记 replayed', async () => {
    const base = await boot()
    const created = await post(base + '/v1/workflows', {
      operation_id: 'op-create-1', workflow_id: 'wf1', name: '发布流程', definition: doc, now: NOW,
    })
    expect(created.status).toBe(200)
    const createdBody = await created.json() as any
    expect(createdBody.data).toMatchObject({ workflow_id: 'wf1', revision: 1, replayed: false })

    const published = await post(base + '/v1/workflows/publish', {
      operation_id: 'op-pub-1', workflow_id: 'wf1', revision: 1, base_version: 0, now: NOW,
    })
    expect(published.status).toBe(200)
    const publishedBody = await published.json() as any
    expect(publishedBody.data).toMatchObject({ version: '1', replayed: false })

    const replay = await post(base + '/v1/workflows/publish', {
      operation_id: 'op-pub-1', workflow_id: 'wf1', revision: 1, base_version: 0, now: NOW,
    })
    expect(replay.status).toBe(200)
    const replayBody = await replay.json() as any
    expect(replayBody.data).toMatchObject({ version: '1', replayed: true })

    const list = await fetch(base + '/v1/workflows', { headers: { 'x-orchestra-secret': SECRET } })
    const listBody = await list.json() as any
    expect(listBody.data.items).toHaveLength(1)
    expect(listBody.data.items[0]).toMatchObject({ workflow_id: 'wf1', current_version: '1' })
  })

  it('发布层不通过：422 + 未注册节点清单', async () => {
    const base = await boot()
    await post(base + '/v1/workflows', {
      operation_id: 'op-create-2', workflow_id: 'wf2', name: '带分支',
      definition: {
        name: '带分支',
        nodes: [
          { node_id: 't', type: 'trigger', title: '入口', position: { x: 0, y: 0 }, config: {} },
          { node_id: 'b', type: 'branch', title: '分支', position: { x: 1, y: 0 }, config: {} },
        ],
        edges: [{ from: 't', to: 'b' }],
      },
      now: NOW,
    })
    const res = await post(base + '/v1/workflows/publish', {
      operation_id: 'op-pub-2', workflow_id: 'wf2', revision: 1, base_version: 0, now: NOW,
    })
    expect(res.status).toBe(422)
    const body = await res.json() as any
    expect(body.error.code).toBe('WORKFLOW_VALIDATION_FAILED')
    expect(body.error.details.errors.some((e: { code: string }) => e.code === 'NODE_NOT_SUPPORTED')).toBe(true)
  })
})
