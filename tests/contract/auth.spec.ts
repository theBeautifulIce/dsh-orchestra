import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sha256Hex } from '../../src/core/canonical.ts'
import { openDb, withTx } from '../../src/infra/sqlite/driver.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../../src/infra/db/migrate.ts'
import { appendEvent } from '../../src/infra/db/ledger.ts'
import { requestHash, commandEnvelopeSchema } from '../../src/service/envelope.ts'
import { startServer } from '../../src/service/server.ts'

const SECRET = 'svc-secret-abc'
const dirs: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) { try { await close() } catch { /* 已关 */ } }
  for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 句柄晚释放 */ } }
})

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-svc-'))
  dirs.push(dir)
  const db = openDb(join(dir, 'orchestra.db'))
  applySteps(db, loadSteps(defaultMigrationsDir()))
  const seen: string[] = []
  const svc = await startServer({
    secret: SECRET,
    phase: 'S1',
    epoch: 7,
    asOfSeq: () => 0,
    listTasks: (limit) => [{ task_id: 't1', limit }],
    listEvents: (fromSeq, limit) => [{ from: fromSeq, limit }],
    appendLedgerEvent: (body, actor) => {
      seen.push(actor)
      const out = withTx(db, (tx) => appendEvent(tx, { type: (body as { type?: string }).type ?? 'test.event', payload: body }))
      return out
    },
  })
  closers.push(async () => { await svc.close(); db.raw.close() })
  return { base: svc.endpoint, seen }
}

const get = (url: string, secret?: string) => fetch(url, { headers: secret ? { 'x-orchestra-secret': secret } : {} })
const post = (url: string, body: unknown, secret?: string) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(secret ? { 'x-orchestra-secret': secret } : {}) },
  body: JSON.stringify(body),
})

describe('认证与信封', () => {
  it('/health 免认证，回 phase 与 epoch', async () => {
    const { base } = await boot()
    const res = await get(base + '/health')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; data: { phase: string; epoch: number } }
    expect(body.ok).toBe(true)
    expect(body.data.phase).toBe('S1')
    expect(body.data.epoch).toBe(7)
  })

  it('GET /v1/tasks 缺密钥 → 401 UNAUTHORIZED', async () => {
    const { base } = await boot()
    const res = await get(base + '/v1/tasks')
    expect(res.status).toBe(401)
    const body = await res.json() as { ok: boolean; error: { code: string; retryable: boolean } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.retryable).toBe(false)
  })

  it('错密钥 → 401', async () => {
    const { base } = await boot()
    const res = await get(base + '/v1/tasks', 'wrong')
    expect(res.status).toBe(401)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED')
  })

  it('对密钥 → 200，信封字段齐全', async () => {
    const { base } = await boot()
    const res = await get(base + '/v1/tasks?limit=3', SECRET)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    for (const key of ['ok', 'schema_version', 'as_of_seq', 'generated_at', 'data']) expect(body).toHaveProperty(key)
    expect(body.ok).toBe(true)
    expect(body.schema_version).toBe(1)
    expect(body.data).toEqual({ items: [{ task_id: 't1', limit: 3 }] })
  })

  it('GET /v1/events 参数透传并夹上限', async () => {
    const { base } = await boot()
    const res = await get(base + '/v1/events?from_seq=5&limit=9999', SECRET)
    expect(res.status).toBe(200)
    // 事件单页上限 200（与 src/service/queries/list_events.ts 的 EVENTS_LIMIT_MAX 一致）
    expect((await res.json() as { data: unknown }).data).toEqual({ items: [{ from: 5, limit: 200 }], next_cursor: null })
  })

  it('POST /v1/ledger/events 匿名写 → 401', async () => {
    const { base } = await boot()
    const res = await post(base + '/v1/ledger/events', { type: 'x' })
    expect(res.status).toBe(401)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED')
  })

  it('body 里自报 actor 无效，写入主体由密钥派生', async () => {
    const { base, seen } = await boot()
    const res = await post(base + '/v1/ledger/events', { type: 'node.started', actor: 'someone-else' }, SECRET)
    expect(res.status).toBe(200)
    const expected = 'service:' + sha256Hex(SECRET).slice(0, 8)
    expect(seen).toEqual([expected])
    const body = await res.json() as { data: { actor: string; seq: number } }
    expect(body.data.actor).toBe(expected)
    expect(body.data.seq).toBe(1)
  })

  it('未知路径 → 404 统一信封', async () => {
    const { base } = await boot()
    const res = await get(base + '/v1/nope', SECRET)
    expect(res.status).toBe(404)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('非 JSON 请求体 → 422 PAYLOAD_SCHEMA_INVALID', async () => {
    const { base } = await boot()
    const res = await fetch(base + '/v1/ledger/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orchestra-secret': SECRET },
      body: 'not json',
    })
    expect(res.status).toBe(422)
  })
})

describe('request_hash', () => {
  const parse = (obj: unknown) => commandEnvelopeSchema.parse(obj)
  const base = {
    operation_id: '018f4c1e-6a3b-7c2d-8e9f-0123456789ab',
    command: 'task.start',
    target: { task_id: 't1' },
    expected: { revision: 3 },
    payload: { x: 1 },
    client: { kind: 'panel', version: '0.1.0' },
  }

  it('operation_id 与 client 不同、其余相同 → hash 相同', () => {
    const a = parse(base)
    const b = parse({ ...base, operation_id: '018f4c1e-6a3b-7c2d-8e9f-0123456789ac', client: { kind: 'cli', version: '9.9.9' } })
    expect(requestHash(a)).toBe(requestHash(b))
  })

  it('payload 不同 → hash 不同', () => {
    expect(requestHash(parse(base))).not.toBe(requestHash(parse({ ...base, payload: { x: 2 } })))
  })

  it('信封拒未知字段、缺 client 拒收', () => {
    expect(() => parse({ ...base, extra: 1 })).toThrow()
    expect(() => parse({ operation_id: base.operation_id, command: 'a', target: {}, expected: {}, payload: {} })).toThrow()
  })
})
