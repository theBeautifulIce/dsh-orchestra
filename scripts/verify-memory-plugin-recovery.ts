import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createApiClient } from '../src/client/api/client.ts'
import { createDecisionCommandsApi } from '../src/client/api/decision-commands.ts'
import { createMemoryRecoveryApi } from '../src/client/api/memory-recovery.ts'
import { createResourcesApi } from '../src/client/api/resources.ts'
import { uuidv7 } from '../src/core/ids.ts'
import { contentHash, type MemoryItemInput } from '../src/core/memory-canonical.ts'
import { serveOrchestra, type MemoryPluginWriter } from '../src/index.ts'
import { openDb, withTx, type Db } from '../src/infra/sqlite/driver.ts'
import { startMemoryRun } from '../src/service/commands/memory.ts'
import { resolveMemoryApproval } from '../src/service/commands/memory-approval.ts'
import { createMemoryPorts, type ApplyGovernedPortInput } from '../src/service/commands/memory-ports.ts'
import { createMemoryRuntime } from '../src/service/commands/memory-runtime.ts'
import { createMemoryHost } from '../src/service/memory-host.ts'
import { freshLedger, seed, TEST_SECRET } from '../tests/fixtures/ledger.ts'

const args = process.argv.slice(2)
const caseIndex = args.indexOf('--case')
const acceptedCases = ['Q-61', 'Q-62', 'Q-63'] as const
type EvidenceCase = typeof acceptedCases[number]
const evidenceCase = caseIndex < 0 ? undefined : args.splice(caseIndex, 2)[1] as EvidenceCase | undefined
assert(caseIndex < 0 || (evidenceCase && acceptedCases.includes(evidenceCase)), '--case must be Q-61, Q-62 or Q-63')
const [pluginArg, binaryArg] = args
assert(pluginArg && args.length <= 2,
  'Usage: node scripts/verify-memory-plugin-recovery.ts <plugin-package-directory> [go-sidecar-binary] [--case Q-61|Q-62|Q-63]')
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
    const backendVersion = logs.find((line) => line.includes('Go 记忆服务已启动'))?.match(/，v([^）]+)）/)?.[1]
    return { writer: writer!, context: ctx, close, backendVersion }
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

function readStorage(storage: string, batchId: string) {
  const external = openDb(join(storage, 'memory.sqlite3'), { readonly: true })
  try {
    return {
      memories: external.raw.prepare('SELECT id, content FROM memories ORDER BY id').all(),
      receipts: external.raw.prepare('SELECT batch_id, client_key, content_hash, applied_item_id FROM orchestra_memory_receipts WHERE batch_id = ? ORDER BY client_key').all(batchId),
    }
  } finally { external.raw.close() }
}

function info(plugin: Awaited<ReturnType<typeof loadPlugin>>) {
  const path = binaryArg ? resolve(binaryArg) : join(pluginDir, 'bin', `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'memory-service.exe' : 'memory-service')
  return { plugin: manifest.version, backend: 'Go', backend_version: plugin.backendVersion ?? null,
    backend_sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    host: 'production Orchestra with isolated plugin profile and Cordis context fixture', judge: 'fixture' }
}

async function finishOnPanel(scope: { endpoint: string; runId: string; batchId: string; nodeRunId: string }) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const { stdout } = await promisify(execFile)(process.execPath, [
    join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run',
    'tests/client/memory-recovery-acceptance.spec.tsx', '-t', 'Q-63', '--reporter=dot',
  ], {
    cwd: root, env: { ...process.env, G5_MEMORY_PANEL_CONTEXT: JSON.stringify({ ...scope, secret: TEST_SECRET }) },
    timeout: 45_000,
  })
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('G5_MEMORY_PANEL_RESULT '))
  assert(line, stdout)
  const panel = JSON.parse(line.slice('G5_MEMORY_PANEL_RESULT '.length))
  assert.equal(panel.run_id, scope.runId)
  assert.equal(panel.batch_id, scope.batchId)
  assert.equal(panel.node_run_id, scope.nodeRunId)
  assert.equal(panel.run_status, 'succeeded_with_unverified')
  return panel
}

async function verify(branch: 'full' | 'zero' | 'partial' | 'Q-61' | 'Q-63', dir: string) {
  const storage = join(dir, 'plugin')
  let plugin = await loadPlugin(storage)
  let service: Awaited<ReturnType<typeof serveOrchestra>> | undefined
  let original: Parameters<MemoryPluginWriter['writeMemory']>[0] | undefined
  let resultDropped = false
  let pluginRejection: string | undefined
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
                if (branch === 'zero' || branch === 'Q-61') {
                  // Fail on the second item, after Go prepares the first item in the same transaction.
                  const invalid = [input.items[0]!, { ...input.items[1]!, title: '' }]
                  try {
                    await plugin.writer.writeMemory({ ...input, items: invalid })
                  } catch (error) {
                    pluginRejection = String((error as Error).message)
                    assert.match(pluginRejection, /invalid governed memory content/i)
                    if (branch === 'Q-61') throw error
                  }
                  assert(pluginRejection, 'Go unexpectedly accepted the invalid second item')
                } else {
                  const writes = branch === 'partial' || branch === 'Q-63' ? input.items.slice(0, 1) : input.items
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
      source_run_id: 'r1', request_key: `verify_${branch.toLowerCase()}`, reason: `验证 ${branch}`, operation_id: uuidv7(),
    })).data
    const getBatch = async () => (await api.listMemoryBatches({})).data.items.find((batch) => batch.batch_id === started.batch_id)
    const pending = await waitFor(getBatch, (batch) => batch?.status === 'awaiting_human', 'memory approval')
    assert(pending?.decision_id && pending.decision_revision && pending.proposal_hash)
    const before = readStorage(storage, started.batch_id)
    assert.deepEqual(before, { memories: [], receipts: [] })
    await createDecisionCommandsApi(client).resolveDecision({
      decisionId: pending.decision_id, revision: pending.decision_revision, resolution: 'approved',
    })
    await waitFor(getBatch, (batch) => batch?.recovery_available === true, 'recoverable write')
    assert(original)
    assert.equal(calls, 1)
    const scope = { runId: started.memory_run_id, batchId: started.batch_id, nodeRunId: original.node_run_id }
    const applyNode = () => ({ ...db.raw.prepare('SELECT status, attempt FROM node_runs WHERE node_run_id = ? AND run_id = ?')
      .get(scope.nodeRunId, scope.runId) })
    const attempt = applyNode().attempt
    if (branch === 'Q-61') {
      assert(pluginRejection)
      assert(!resultDropped)
      const event = db.raw.prepare("SELECT payload_redacted AS payload FROM events WHERE run_id = ? AND node_run_id = ? AND type = 'memory.apply.outcome_unknown'")
        .get(scope.runId, scope.nodeRunId)
      assert.deepEqual(JSON.parse(String(event?.payload)), { batch_id: scope.batchId, error_code: 'MEMORY_APPLY_FAILED' })
      assert.deepEqual(readStorage(storage, scope.batchId), before)
      const runtime = createMemoryRuntime({ db, secret: TEST_SECRET, ownerEpoch: db.epoch, prepareItems: async () => ({ items }), judge,
        writer: { fenceAndInspect: plugin.writer.fenceAndInspect, async writeMemory(input) {
          calls += 1
          const response = await plugin.writer.writeMemory({ ...input, items: input.items.map((item) => ({ ...item, content_hash: contentHash(item) })) })
          return { applied_count: response.length, skipped_count: 0, applied_item_ids: response.map((entry) => entry.applied_item_id) }
        } },
      })
      const recheck = await runtime.advance({ memory_run_id: scope.runId })
      assert.equal(recheck.status, 'blocked')
      assert.equal(recheck.run_status, 'paused')
      assert.deepEqual(recheck.steps, [])
      assert.deepEqual(applyNode(), { status: 'indeterminate_side_effect', attempt })
      assert.equal(calls, 1)
      const after = readStorage(storage, scope.batchId)
      assert.deepEqual(after, before)
      console.log(JSON.stringify({ case: branch, ...info(plugin), ...scope, attempt, plugin_rejection: pluginRejection,
        error_code: 'MEMORY_APPLY_FAILED', before, after, write_calls: calls, recheck }))
      return
    }
    assert(resultDropped, 'plugin operation did not reach the intended fault injection point')

    // Reload the actual plugin and sidecar before inspecting; the oracle is its SQLite database.
    plugin.close()
    plugin = await loadPlugin(storage)
    const proof = await recovery.inspect(started.batch_id)
    const expected = { full: { written: 2, choice: 'confirm_applied' }, zero: { written: 0, choice: 'confirm_not_applied' }, partial: { written: 1, choice: 'abandon' } } as const
    const { written, choice } = expected[branch === 'Q-63' ? 'partial' : branch]
    assert.equal(proof.written_count, written)
    assert.equal(proof.missing_count, 2 - written)
    assert.deepEqual(proof.allowed_resolutions, [choice])
    await assert.rejects(plugin.writer.writeMemory(original), /fenced/i)
    let panel: unknown
    let partialStore: ReturnType<typeof readStorage> | undefined
    if (branch === 'Q-63') {
      assert.equal((await getBatch())?.status, 'indeterminate')
      assert.deepEqual(applyNode(), { status: 'indeterminate_side_effect', attempt })
      partialStore = readStorage(storage, scope.batchId)
      assert.equal(partialStore.memories.length, 1)
      assert.equal(partialStore.receipts.length, 1)
      assert.equal(partialStore.receipts[0]?.client_key, original.items[0]?.client_key)
      assert.equal(partialStore.receipts[0]?.applied_item_id, partialStore.memories[0]?.id)
      panel = await finishOnPanel({ endpoint: service.endpoint, ...scope })
    } else {
      await recovery.resolve(proof, choice)
    }
    if (branch === 'partial') {
      assert.equal(db.raw.prepare('SELECT status FROM runs WHERE run_id = ?').get(started.memory_run_id)?.status, 'paused')
      const acknowledge = await recovery.inspect(started.batch_id)
      assert.deepEqual(acknowledge.allowed_resolutions, ['acknowledge_abandon'])
      assert.equal(acknowledge.written_count, 1)
      await recovery.resolve(acknowledge, 'acknowledge_abandon')
    }
    const partial = branch === 'partial' || branch === 'Q-63'
    const runState = partial ? 'succeeded_with_unverified' : 'succeeded'
    const readRun = async () => db.raw.prepare('SELECT status FROM runs WHERE run_id = ?').get(started.memory_run_id)?.status
    assert.equal(await waitFor(readRun, (status) => status === runState, `${branch} terminal state`), runState)
    const memoryDb = openDb(join(storage, 'memory.sqlite3'), { readonly: true })
    try {
      const expectedContents = items.slice(0, partial ? 1 : 2).map((item) => item.content).sort()
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
      assert.equal(batch?.status, partial ? 'indeterminate' : 'applied')
      assert.equal(calls, branch === 'zero' ? 2 : 1)
      if (branch === 'Q-63') {
        const after = readStorage(storage, scope.batchId)
        assert.deepEqual(after, partialStore)
        assert.deepEqual(applyNode(), { status: 'abandoned_unverified', attempt })
        const row = db.raw.prepare('SELECT status FROM memory_write_recoveries WHERE batch_id = ? AND node_run_id = ?').get(scope.batchId, scope.nodeRunId)
        assert.equal(row?.status, 'acknowledged')
        console.log(JSON.stringify({ case: branch, ...info(plugin), ...scope, attempt, before, partial_store: partialStore, after,
          writes: calls, run_status: runState, panel }))
      }
      console.log(JSON.stringify({ branch, plugin: manifest.version, backend: 'go', written, missing: 2 - written,
        resolution: choice, old_attempt_fenced: true, writes: calls, stored_items: actual.length, run_status: runState }))
    } finally {
      memoryDb.raw.close()
    }
  } finally {
    try { await service?.close() } finally { plugin.close() }
  }
}

function ledgerState(db: Db) {
  return {
    runs: db.raw.prepare('SELECT * FROM runs ORDER BY run_id').all(),
    batches: db.raw.prepare('SELECT * FROM memory_batches ORDER BY batch_id').all(),
    items: db.raw.prepare('SELECT * FROM memory_items ORDER BY batch_id, client_key').all(),
    decisions: db.raw.prepare('SELECT * FROM decisions ORDER BY decision_id').all(),
    nodes: db.raw.prepare('SELECT node_run_id, status, revision, attempt FROM node_runs ORDER BY node_run_id').all(),
    receipts: db.raw.prepare('SELECT * FROM inbox ORDER BY operation_id').all(),
    watermark: db.raw.prepare('SELECT MAX(seq) AS seq FROM events').get()?.seq,
  }
}

async function verifyRejectionOrder(dir: string) {
  const storage = join(dir, 'plugin')
  const plugin = await loadPlugin(storage)
  const { db } = freshLedger(dir)
  let host: ReturnType<typeof createMemoryHost> | undefined
  const now = new Date().toISOString()
  try {
    seed(db)
    withTx(db, (tx) => {
      tx.run("UPDATE runs SET status = 'succeeded' WHERE run_id = 'r1'")
      tx.run("INSERT INTO runs (run_id, task_id, status, revision, created_at, updated_at) VALUES ('r_other', 't1', 'succeeded', 1, ?, ?)", [now, now])
    })
    const start = (source_run_id: string) => startMemoryRun(db, {
      source_run_id, now, reason: '验证写入守卫', request_key: 'verify_q62', operation_id: uuidv7(),
    })
    const primary = start('r1')
    const other = start('r_other')
    const writeNode = (runId: string) => db.raw.prepare("SELECT node_run_id, status FROM node_runs WHERE run_id = ? AND node_id = 'mem_apply'").get(runId)!
    const bound = writeNode(primary.memory_run_id)
    const foreign = writeNode(other.memory_run_id)
    // The negative node is already started in its own running run, so status cannot explain the binding rejection.
    withTx(db, (tx) => tx.run("UPDATE node_runs SET status = 'started' WHERE node_run_id = ?", [foreign.node_run_id]))
    let writeCalls = 0
    const portWriter = async (input: Parameters<MemoryPluginWriter['writeMemory']>[0]) => {
      writeCalls += 1
      return plugin.writer.writeMemory(input)
    }
    const ports = createMemoryPorts({ db, judge, async writeMemory(input) {
      const result = await portWriter({ ...input, items: input.items.map((item) => ({ ...item, content_hash: contentHash(item) })) })
      return { applied_count: result.length, skipped_count: 0, applied_item_ids: result.map((entry) => entry.applied_item_id) }
    } })
    const runtime = createMemoryRuntime({ db, secret: TEST_SECRET, ownerEpoch: db.epoch, prepareItems: async () => ({ items }), judge,
      writer: { fenceAndInspect: plugin.writer.fenceAndInspect, async writeMemory() { throw new Error('只推进到批准前') } } })
    assert.equal((await runtime.advance({ memory_run_id: primary.memory_run_id, now })).batch_status, 'awaiting_human')
    const approval = db.raw.prepare('SELECT decision_id, proposal_hash FROM memory_batches WHERE batch_id = ?').get(primary.batch_id)!
    const input = { batch_id: primary.batch_id, run_id: primary.memory_run_id, node_run_id: String(bound.node_run_id),
      decision_id: String(approval.decision_id), now }
    const mismatched = { ...input, node_run_id: String(foreign.node_run_id) }
    const external = () => readStorage(storage, primary.batch_id)
    const codes: Record<string, string> = {}
    const rejected = async (name: string, request: ApplyGovernedPortInput, code: string, message?: RegExp) => {
      const before = { ledger: ledgerState(db), plugin: external(), calls: writeCalls }
      await assert.rejects(ports.applyGoverned(request, () => now), (error: unknown) => {
        assert(error instanceof Error)
        assert.equal((error as { code?: unknown }).code, code)
        if (message) assert.match(error.message, message)
        codes[name] = code
        return true
      })
      assert.deepEqual({ ledger: ledgerState(db), plugin: external(), calls: writeCalls }, before)
    }
    await rejected('cross_run_batch', { ...input, run_id: other.memory_run_id }, 'MEMORY_BATCH_NOT_FOUND')
    await rejected('unapproved_and_foreign_node', mismatched, 'MEMORY_BATCH_NOT_APPROVED')
    const verdict = withTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: input.batch_id, decision_id: input.decision_id, resolution: 'approved',
      actor: { kind: 'human', id: 'fixture-reviewer' }, now, contentHash: String(approval.proposal_hash),
    }))
    assert.equal(verdict.batch_status, 'approved')
    await rejected('approved_but_foreign_node', mismatched, 'MEMORY_APPLY_BINDING_INVALID', /写入节点不属于/)

    // Preload a genuinely committed plugin receipt for the same client key with a different hash.
    const existing = { ...items[0]!, content: '既有同键异哈希的隔离夹具' }
    const { now: _now, ...scope } = input
    const pluginScope = { ...scope, source_run_id: primary.source_run_id }
    const [receipt] = await plugin.writer.writeMemory({ ...pluginScope, items: [{ ...existing, content_hash: contentHash(existing) }] })
    assert(receipt)
    assert.notEqual(receipt.content_hash, contentHash(items[0]!))
    const seeded = external()
    assert.equal(seeded.memories.length, 1)
    assert.equal(seeded.receipts.length, 1)
    const approvedInput = { ...pluginScope, items: items.map((entry) => ({ ...entry, content_hash: contentHash(entry) })) }
    let pluginConflict: string | undefined
    await assert.rejects(plugin.writer.writeMemory(approvedInput), (error: unknown) => {
      assert(error instanceof Error)
      assert.match(error.message, /governed content hash conflict/)
      pluginConflict = error.message
      return true
    })
    assert.deepEqual(external(), seeded)
    assert.equal(writeCalls, 0)

    // Set the prerequisite node state and corrupt the proposal hash only in this isolated ledger.
    // Restore both before letting the production host advance the plugin-only control.
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status = 'started' WHERE node_run_id = ?", [input.node_run_id])
      tx.run('UPDATE memory_batches SET proposal_hash = ? WHERE batch_id = ?', ['0'.repeat(64), input.batch_id])
    })
    await rejected('snapshot_and_plugin_hash_conflict', input, 'MEMORY_APPLY_BINDING_INVALID', /批准快照不一致/)
    withTx(db, (tx) => {
      tx.run('UPDATE memory_batches SET proposal_hash = ? WHERE batch_id = ?', [approval.proposal_hash, input.batch_id])
      tx.run('UPDATE node_runs SET status = ? WHERE node_run_id = ?', [bound.status, input.node_run_id])
      tx.run("UPDATE runs SET status = 'paused' WHERE run_id = ?", [other.memory_run_id])
    })
    const receiptsBefore = ledgerState(db).receipts
    host = createMemoryHost(db, TEST_SECRET, { prepareItems: async () => ({ items }), judge, plugin: {
      protocol: 1, writeMemory: portWriter, fenceAndInspect: plugin.writer.fenceAndInspect,
    } }, (error) => console.error(error))
    host.resume(now)
    const event = await waitFor(async () => db.raw.prepare("SELECT payload_redacted AS payload FROM events WHERE run_id = ? AND node_run_id = ? AND type = 'memory.apply.outcome_unknown'")
      .get(input.run_id, input.node_run_id), Boolean, 'plugin hash conflict')
    const reported = JSON.parse(String(event?.payload))
    assert.equal(reported.error_code, 'MEMORY_APPLY_CONFLICT', `actual plugin error: ${pluginConflict}`)
    codes.approved_and_bound_plugin_hash_conflict = reported.error_code
    assert.equal(writeCalls, 1)
    assert.deepEqual(external(), seeded)
    assert.deepEqual(ledgerState(db).receipts, receiptsBefore)
    const afterItems = db.raw.prepare('SELECT client_key, status, applied_item_id FROM memory_items WHERE batch_id = ? ORDER BY client_key')
      .all(input.batch_id).map((row) => ({ ...row }))
    assert.deepEqual(afterItems,
      items.map(({ client_key }) => ({ client_key, status: 'approved', applied_item_id: null })))
    console.log(JSON.stringify({ case: 'Q-62', ...info(plugin), ...scope, foreign_run_id: other.memory_run_id, foreign_node_run_id: foreign.node_run_id,
      codes, plugin_conflict: pluginConflict, writer_calls: writeCalls, original_plugin_store: seeded, after: external(), rejected_requests_side_effect_free: true }))
  } finally {
    try { await host?.close() } finally {
      db.raw.close()
      plugin.close()
    }
  }
}

delete process.env.DSH_MEMORY_SERVICE
const cases = evidenceCase ? [evidenceCase] : ['full', 'zero', 'partial'] as const
for (const branch of cases) {
  const dir = mkdtempSync(join(tmpdir(), `orchestra-plugin-${branch}-`))
  process.env.DSH_HOME = join(dir, 'dsh-home')
  try {
    if (binaryArg) {
      const binary = join(dir, process.platform === 'win32' ? 'memory-service.exe' : 'memory-service')
      copyFileSync(resolve(binaryArg), binary)
      process.env.DSH_MEMORY_SERVICE = binary
    }
    if (branch === 'Q-62') await verifyRejectionOrder(dir)
    else await verify(branch, dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error: unknown) => {
      console.warn(`Could not remove isolated fixture ${dir}`, error)
    })
  }
}
