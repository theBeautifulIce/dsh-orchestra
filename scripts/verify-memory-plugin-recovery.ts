import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createApiClient } from '../src/client/api/client.ts'
import { createDecisionCommandsApi } from '../src/client/api/decision-commands.ts'
import { createMemoryRecoveryApi } from '../src/client/api/memory-recovery.ts'
import { createResourcesApi } from '../src/client/api/resources.ts'
import { uuidv7 } from '../src/core/ids.ts'
import type { MemoryItemInput } from '../src/core/memory-canonical.ts'
import { serveOrchestra, type MemoryPluginWriter } from '../src/index.ts'
import { openDb, withTx } from '../src/infra/sqlite/driver.ts'
import { seed, TEST_SECRET } from '../tests/fixtures/ledger.ts'

const [, , pluginArg, binaryArg] = process.argv
assert(pluginArg, 'Usage: node scripts/verify-memory-plugin-recovery.ts <plugin-package-directory> [go-sidecar-binary]')
const pluginDir = resolve(pluginArg)
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
assert.equal(manifest.name, 'dsh-memory-plugin')
const { apply } = await import(pathToFileURL(join(pluginDir, 'index.js')).href)
const noop = () => {}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string) {
  for (let n = 0; n < 150; n += 1) {
    const value = await read()
    if (ready(value)) return value
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function loadPlugin(storageDir: string) {
  const services = new Map<string, unknown>()
  const disposers: (() => void)[] = []
  const logs: string[] = []
  const log = (message: string) => logs.push(message)
  const ctx = {
    logger: { info: log, debug: log, warn: log, error: log },
    get: (name: string) => services.get(name),
    provide(name: string, service: unknown) {
      services.set(name, service)
      return () => { services.delete(name) }
    },
    effect(fn: () => (() => void) | undefined) {
      const dispose = fn()
      if (dispose) disposers.push(dispose)
    },
    on: () => noop,
    tools: { register: () => noop },
    systemPrompt: { section: () => noop },
  }
  function close() {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
  try {
    await apply(ctx, {
      storage: { engine: 'go', dir: storageDir, autoBackup: false },
      performance: { nativeCore: false }, maintenance: { autoRun: false },
    })
    const writer = ctx.get('orchestraMemoryWriter') as MemoryPluginWriter | undefined
    assert.equal(writer?.protocol, 1, logs.join('\n'))
    return { writer: writer!, context: ctx, close }
  } catch (error) {
    close()
    throw error
  }
}

const items: MemoryItemInput[] = ['first', 'second'].map((key) => ({
  client_key: key, action: 'create', target_id: null, layer: 'L4', title: `测试 ${key}`,
  content: `真实 Go 记忆插件恢复测试 ${key}`, tags: ['orchestra-recovery-test'], questions: [],
  key: null, importance: 5, ttl_days: null, quote: '恢复验证', reason: '端到端测试',
}))
const judge = async () => JSON.stringify({
  items: items.map((item) => ({ client_key: item.client_key, verdict: 'approve', reason: '端到端测试', confidence: 0.99 })),
  summary: '恢复验证', duration_ms: 1, model: { provider: 'test', name: 'judge', prompt_version: 'v1' },
})

async function verify(branch: 'full' | 'zero' | 'partial', dir: string) {
  const storage = join(dir, 'plugin')
  let plugin = await loadPlugin(storage)
  let service: Awaited<ReturnType<typeof serveOrchestra>> | undefined
  let original: Parameters<MemoryPluginWriter['writeMemory']>[0] | undefined
  let resultDropped = false
  let calls = 0
  try {
    service = await serveOrchestra({
      dbFile: join(dir, 'orchestra.sqlite3'), secret: TEST_SECRET, phase: 'S5',
      asOfSeq: () => Number(service?.orchestra.db.raw.prepare('SELECT MAX(seq) AS seq FROM events').get()?.seq ?? 0),
      listTasks: () => [], listEvents: () => [], appendLedgerEvent: noop,
      memory: {
        prepareItems: async () => ({ items }), judge,
        context: {
          get(name) {
            const writer = plugin.context.get(name) as MemoryPluginWriter
            return {
              protocol: writer.protocol,
              fenceAndInspect: (input) => plugin.writer.fenceAndInspect(input),
              async writeMemory(input) {
                calls += 1
                if (calls > 1) return plugin.writer.writeMemory(input)
                original = input
                if (branch === 'zero') {
                  // Fail on the second item, after Go prepares the first item in the same transaction.
                  const invalid = [input.items[0]!, { ...input.items[1]!, title: '' }]
                  await assert.rejects(plugin.writer.writeMemory({ ...input, items: invalid }), /invalid governed memory content/i)
                } else {
                  const writes = branch === 'partial' ? input.items.slice(0, 1) : input.items
                  assert.equal((await plugin.writer.writeMemory({ ...input, items: writes })).length, writes.length)
                }
                resultDropped = true
                throw new Error('Injected loss of write result')
              },
            } satisfies MemoryPluginWriter
          },
        },
      },
    })
    const db = service.orchestra.db
    seed(db)
    withTx(db, (tx) => {
      tx.run("UPDATE runs SET status = 'succeeded' WHERE run_id = 'r1'")
      tx.run("UPDATE tasks SET current_run_id = 'r1' WHERE task_id = 't1'")
    })
    const client = createApiClient(service.endpoint, (url, init) => {
      const headers = new Headers(init?.headers)
      headers.set('x-orchestra-secret', TEST_SECRET)
      return fetch(url, { ...init, headers })
    })
    const api = createResourcesApi(client)
    const recovery = createMemoryRecoveryApi(client)
    const started = (await client.post<{ batch_id: string; memory_run_id: string }>('/v1/memory/runs/start', {
      source_run_id: 'r1', request_key: `verify_${branch}`, reason: `验证 ${branch}`, operation_id: uuidv7(),
    })).data
    const getBatch = async () => (await api.listMemoryBatches({})).data.items.find((batch) => batch.batch_id === started.batch_id)
    const pending = await waitFor(getBatch, (batch) => batch?.status === 'awaiting_human', 'memory approval')
    assert(pending?.decision_id && pending.decision_revision && pending.proposal_hash)
    await createDecisionCommandsApi(client).resolveDecision({
      decisionId: pending.decision_id, revision: pending.decision_revision, resolution: 'approved',
    })
    await waitFor(getBatch, (batch) => batch?.recovery_available === true, 'recoverable write')
    assert(original)
    assert(resultDropped, 'plugin operation did not reach the intended fault injection point')
    assert.equal(calls, 1)

    // Reload the actual plugin and sidecar before inspecting; the oracle is its SQLite database.
    plugin.close()
    plugin = await loadPlugin(storage)
    const proof = await recovery.inspect(started.batch_id)
    const expected = { full: { written: 2, choice: 'confirm_applied' }, zero: { written: 0, choice: 'confirm_not_applied' }, partial: { written: 1, choice: 'abandon' } } as const
    const { written, choice } = expected[branch]
    assert.equal(proof.written_count, written)
    assert.equal(proof.missing_count, 2 - written)
    assert.deepEqual(proof.allowed_resolutions, [choice])
    await assert.rejects(plugin.writer.writeMemory(original), /fenced/i)
    await recovery.resolve(proof, choice)
    if (branch === 'partial') {
      assert.equal(db.raw.prepare('SELECT status FROM runs WHERE run_id = ?').get(started.memory_run_id)?.status, 'paused')
      const acknowledge = await recovery.inspect(started.batch_id)
      assert.deepEqual(acknowledge.allowed_resolutions, ['acknowledge_abandon'])
      assert.equal(acknowledge.written_count, 1)
      await recovery.resolve(acknowledge, 'acknowledge_abandon')
    }
    const runState = branch === 'partial' ? 'succeeded_with_unverified' : 'succeeded'
    const readRun = async () => db.raw.prepare('SELECT status FROM runs WHERE run_id = ?').get(started.memory_run_id)?.status
    assert.equal(await waitFor(readRun, (status) => status === runState, `${branch} terminal state`), runState)
    const memoryDb = openDb(join(storage, 'memory.sqlite3'), { readonly: true })
    try {
      const expectedContents = items.slice(0, branch === 'partial' ? 1 : 2).map((item) => item.content).sort()
      const actual = memoryDb.raw.prepare('SELECT content FROM memories ORDER BY content').all().map((row) => row.content)
      assert.deepEqual(actual, expectedContents)
      const receiptCount = memoryDb.raw.prepare('SELECT COUNT(*) AS count FROM orchestra_memory_receipts WHERE batch_id = ?').get(started.batch_id)?.count
      assert.equal(receiptCount, actual.length)
      const source = memoryDb.raw.prepare("SELECT json_extract(metadata, '$.source') AS source FROM memories ORDER BY content").all()
      assert.deepEqual(source.map((row) => JSON.parse(String(row.source)).orchestra), items.slice(0, actual.length).map((item) => ({
        source_run_id: 'r1', memory_run_id: started.memory_run_id, batch_id: started.batch_id,
        decision_id: pending.decision_id, client_key: item.client_key,
      })))
      const batch = await getBatch()
      assert.equal(batch?.status, branch === 'partial' ? 'indeterminate' : 'applied')
      assert.equal(calls, branch === 'zero' ? 2 : 1)
      console.log(JSON.stringify({ branch, plugin: manifest.version, backend: 'go', written, missing: 2 - written,
        resolution: choice, old_attempt_fenced: true, writes: calls, stored_items: actual.length, run_status: runState }))
    } finally {
      memoryDb.raw.close()
    }
  } finally {
    try { await service?.close() } finally { plugin.close() }
  }
}

delete process.env.DSH_MEMORY_SERVICE
for (const branch of ['full', 'zero', 'partial'] as const) {
  const dir = mkdtempSync(join(tmpdir(), `orchestra-plugin-${branch}-`))
  process.env.DSH_HOME = join(dir, 'dsh-home')
  try {
    if (binaryArg) {
      const binary = join(dir, process.platform === 'win32' ? 'memory-service.exe' : 'memory-service')
      copyFileSync(resolve(binaryArg), binary)
      process.env.DSH_MEMORY_SERVICE = binary
    }
    await verify(branch, dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error: unknown) => {
      console.warn(`Could not remove isolated fixture ${dir}`, error)
    })
  }
}
