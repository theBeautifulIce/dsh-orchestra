/** G-11 uses a separate durable writer store so ledger projections cannot stand in for write facts. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentHash, type MemoryItemInput } from '../src/core/memory-canonical.ts'
import { uuidv7 } from '../src/core/ids.ts'
import { ScriptedClock } from '../src/core/clock.ts'
import { applySteps, defaultMigrationsDir, loadSteps } from '../src/infra/db/migrate.ts'
import { openDb, withTx, type Db, type Tx } from '../src/infra/sqlite/driver.ts'
import { startMemoryRun } from '../src/service/commands/memory.ts'
import { resolveMemoryApproval } from '../src/service/commands/memory-approval.ts'
import type { GovernedWriteInput, InspectMemoryWrite } from '../src/service/commands/memory-ports.ts'
import { inspectMemoryRecovery, resolveMemoryRecovery } from '../src/service/commands/memory-recovery.ts'
import { createMemoryRuntime } from '../src/service/commands/memory-runtime.ts'
import { resolveDecision } from '../src/service/commands/decisions.ts'
import { sweep } from '../src/service/sweep.ts'
import { seed, TEST_SECRET } from '../tests/fixtures/ledger.ts'
import type { InjectionResult } from './fault-inject.ts'

const NOW = '2026-11-18T03:00:00.000Z'
const ACTOR = { kind: 'human', id: 'human:g11' } as const
const CASES = ['committed', 'rolled_back', 'partial'] as const
type Crash = typeof CASES[number]

const proposals: MemoryItemInput[] = ['first', 'second'].map((key) => ({
  client_key: key, action: 'create', target_id: null, layer: 'L4',
  title: key, content: 'memory ' + key, key: null, tags: [], questions: [],
  importance: 5, ttl_days: null, quote: 'fixture', reason: 'G-11',
}))

function setupWriter(file: string) {
  const db = openDb(file)
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS fences (attempt_id TEXT PRIMARY KEY, stopped_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS written (
      batch_id TEXT NOT NULL, client_key TEXT NOT NULL, content_hash TEXT NOT NULL,
      applied_item_id TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (batch_id, client_key)
    );
  `)
  return db
}

function insertRows(tx: Pick<Tx, 'get' | 'run'>, input: GovernedWriteInput, items: readonly MemoryItemInput[]) {
  if (tx.get('SELECT 1 FROM fences WHERE attempt_id = ?', [input.node_run_id])) throw new Error('attempt fenced')
  return items.map((item) => {
    const id = 'g11_' + item.client_key
    tx.run('INSERT INTO written VALUES (?, ?, ?, ?, ?)', [input.batch_id, item.client_key, contentHash(item), id, item.content])
    return { client_key: item.client_key, item_id: id }
  })
}

function memoryRuntime(db: Db, writer: Db, crash?: Crash) {
  return createMemoryRuntime({
    db, secret: TEST_SECRET, now: () => NOW,
    prepareItems: async () => ({ items: proposals }),
    judge: async () => JSON.stringify({
      items: proposals.map((item) => ({ client_key: item.client_key, verdict: 'approve', confidence: 1, reason: 'G-11' })),
      summary: 'G-11', duration_ms: 1, model: { provider: 'fixture', name: 'g11', prompt_version: '1' },
    }),
    writer: {
      fenceAndInspect: fencedInspection(writer),
      writeMemory: async (input) => {
        const items = crash === 'partial' || crash === 'rolled_back' ? input.items.slice(0, 1) : input.items
        if (crash === 'rolled_back') {
          writer.raw.exec('BEGIN IMMEDIATE')
          writer.raw.prepare('INSERT INTO written VALUES (?, ?, ?, ?, ?)').run(
            input.batch_id, items[0]!.client_key, contentHash(items[0]!), 'g11_first', items[0]!.content,
          )
        } else {
          const applied = withTx(writer, (tx) => insertRows(tx, input, items))
          if (!crash) return { applied, applied_count: applied.length, skipped_count: 0, applied_item_ids: applied.map((row) => row.item_id) }
        }
        process.stdout.write('G11_WRITE_REACHED\n')
        return new Promise(() => { setInterval(() => {}, 60_000) })
      },
    },
  })
}

function fencedInspection(writer: Db): InspectMemoryWrite {
  return async ({ batch_id, node_run_id }) => withTx(writer, (tx) => {
    tx.run('INSERT OR IGNORE INTO fences VALUES (?, ?)', [node_run_id, NOW])
    const stopped_at = tx.get<{ stopped_at: string }>('SELECT stopped_at FROM fences WHERE attempt_id = ?', [node_run_id])!.stopped_at
    const entries = tx.all<{ client_key: string; content_hash: string; applied_item_id: string }>(
      'SELECT client_key, content_hash, applied_item_id FROM written WHERE batch_id = ? ORDER BY client_key', [batch_id],
    )
    return { batch_id, node_run_id, stopped_at, entries }
  })
}

async function killWriter(dbFile: string, writerFile: string, runId: string, crash: Crash): Promise<void> {
  const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--worker', dbFile, writerFile, runId, crash],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  await new Promise<void>((resolve, reject) => {
    let output = ''
    let marker = false
    let killed = false
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (marker || !output.includes('G11_WRITE_REACHED\n')) return
      marker = true
      killed = child.kill('SIGKILL')
    })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.once('error', (err) => { clearTimeout(timer); reject(err) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (!marker || !killed || code === 0 || signal !== 'SIGKILL') reject(new Error('G-11 未在写入点终止子进程：' + output))
      else resolve()
    })
  })
}

function ledgerSnapshot(db: Db, batch: string, run: string) {
  return {
    run: db.raw.prepare('SELECT status FROM runs WHERE run_id = ?').get(run)?.status,
    batch: db.raw.prepare('SELECT status, outcome, applied_count FROM memory_batches WHERE batch_id = ?').get(batch),
    nodes: db.raw.prepare("SELECT attempt, status, action_generation FROM node_runs WHERE run_id = ? AND node_id = 'mem_apply' ORDER BY attempt").all(run),
    items: db.raw.prepare('SELECT client_key, status, applied_item_id FROM memory_items WHERE batch_id = ? ORDER BY client_key').all(batch),
  }
}

async function scenario(dir: string, crash: Crash) {
  const dbFile = join(dir, crash + '.db')
  const writerFile = join(dir, crash + '-writer.db')
  let db = openDb(dbFile)
  let writer = setupWriter(writerFile)
  const before: unknown[] = []
  try {
    applySteps(db, loadSteps(defaultMigrationsDir()))
    seed(db)
    db.raw.prepare("UPDATE runs SET status = 'succeeded' WHERE run_id = 'r1'").run()
    const { memory_run_id: run, batch_id: batch } = startMemoryRun(db, {
      source_run_id: 'r1', request_key: 'g11', reason: 'G-11', operation_id: uuidv7(), now: NOW,
    })
    await memoryRuntime(db, writer).advance({ memory_run_id: run })
    const { decision_id } = db.raw.prepare('SELECT decision_id FROM memory_batches WHERE batch_id = ?').get(batch)!
    withTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: batch, decision_id: String(decision_id), resolution: 'approved', actor: ACTOR, now: NOW,
    }))
    before.push(ledgerSnapshot(db, batch, run))
    db.raw.close()
    writer.raw.close()
    await killWriter(dbFile, writerFile, run, crash)
    db = openDb(dbFile)
    writer = setupWriter(writerFile)
    const cut = ledgerSnapshot(db, batch, run)
    assert.deepEqual({ ...cut.batch }, { status: 'applying', outcome: null, applied_count: 0 })
    assert.equal(cut.nodes[0]?.status, 'started')
    before.push(cut)
    const applyId = String(db.raw.prepare("SELECT apply_node_run_id FROM memory_batches WHERE batch_id = ?").get(batch)!.apply_node_run_id)
    const maintenance = '2026-11-20T00:00:00.000Z'
    const clock = new ScriptedClock('g11-restart', { wallClockMs: Date.parse(maintenance), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: maintenance, clock, executorLost: [applyId] })
    assert.equal(ledgerSnapshot(db, batch, run).nodes[0]?.status, 'indeterminate_side_effect')
    const runtime = memoryRuntime(db, writer)
    assert.equal((await runtime.advance({ memory_run_id: run })).status, 'blocked')
    const recovery = { db, secret: TEST_SECRET, now: () => NOW, inspectWrite: fencedInspection(writer) }
    const original = recovery.inspectWrite
    if (crash === 'partial') {
      await assert.rejects(inspectMemoryRecovery({ ...recovery, inspectWrite: async (scope) => {
        const facts = await original(scope)
        return { ...facts, entries: facts.entries.map((entry) => ({ ...entry, content_hash: 'wrong' })) }
      } }, batch), { code: 'MEMORY_APPLY_CONFLICT' })
      assert.equal(ledgerSnapshot(db, batch, run).batch?.status, 'applying')
    }
    const proof = await runtime.inspectBatch(batch)
    assert.equal(proof.written_count, crash === 'committed' ? 2 : crash === 'partial' ? 1 : 0)
    assert.equal(proof.missing_count, 2 - proof.written_count)
    assert.equal(proof.partial, crash === 'partial')
    sweep(db, TEST_SECRET, { now: maintenance, clock })
    assert.deepEqual((await runtime.inspectBatch(batch)), proof)
    assert.equal(ledgerSnapshot(db, batch, run).nodes[0]?.status, 'indeterminate_side_effect')
    assert.equal(ledgerSnapshot(db, batch, run).run, 'paused')
    const resolution = crash === 'committed' ? 'confirm_applied' : crash === 'partial' ? 'abandon' : 'confirm_not_applied'
    assert.deepEqual(proof.allowed_resolutions, [resolution])
    const request = {
      batch_id: batch, decision_id: proof.decision_id, revision: proof.revision, resolution,
      stopped_at: proof.stopped_at, evidence_id: proof.evidence_id, operation_id: uuidv7(),
    } as const
    assert.throws(() => resolveMemoryRecovery(recovery, ACTOR, { ...request, stopped_at: '' }), { code: 'VERIFICATION_TOO_WEAK' })
    assert.throws(() => resolveMemoryRecovery(recovery, ACTOR, { ...request, evidence_id: 'forged' }), { code: 'VERIFICATION_TOO_WEAK' })
    assert.throws(() => runtime.resolveRecovery({ kind: 'agent', id: 'agent:g11' }, request), { code: 'FORBIDDEN' })
    assert.throws(() => withTx(db, (tx) => resolveDecision(tx, TEST_SECRET, {
      decisionId: proof.decision_id, revision: proof.revision, resolution: 'approved', now: NOW, actor: ACTOR,
    })), { code: 'RESOLUTION_NOT_AVAILABLE' })
    assert.throws(() => resolveMemoryRecovery(recovery, ACTOR, { ...request, revision: 0 }), { code: 'DECISION_REVISION_CONFLICT' })
    const result = runtime.resolveRecovery(ACTOR, request)
    assert.deepEqual(runtime.resolveRecovery(ACTOR, request), result)

    if (crash === 'partial') {
      assert.throws(() => startMemoryRun(db, {
        source_run_id: 'r1', request_key: 'second', reason: 'G-11', operation_id: uuidv7(), now: NOW, retry: true,
      }), { code: 'MEMORY_RUN_ACTIVE' })
      assert.equal((await runtime.advance({ memory_run_id: run })).status, 'blocked')
      const ack = await runtime.inspectBatch(batch)
      assert.equal(ack.decision_id, result.abandon_ack_id)
      assert.equal(ledgerSnapshot(db, batch, run).run, 'paused')
      const acked = runtime.resolveRecovery(ACTOR, { ...request, decision_id: ack.decision_id,
        revision: ack.revision, operation_id: uuidv7(), resolution: 'acknowledge_abandon' })
      assert.equal(acked.terminal, 'succeeded_with_unverified')
    } else {
      if (crash === 'rolled_back') {
        const newAttempt = ledgerSnapshot(db, batch, run)
        assert.equal(newAttempt.batch?.status, 'applying')
        assert.equal(newAttempt.nodes[0]?.status, 'superseded')
        assert.equal(newAttempt.nodes[1]?.status, 'queued')
      }
      assert.equal((await runtime.advance({ memory_run_id: run })).terminal, 'succeeded')
    }
    const final = ledgerSnapshot(db, batch, run)
    const stored = writer.raw.prepare('SELECT client_key, content_hash, applied_item_id FROM written ORDER BY client_key').all()
    assert.equal(stored.length, crash === 'partial' ? 1 : 2)
    assert.deepEqual(final.items.map((row) => row.status), crash === 'partial' ? ['applied', 'approved'] : ['applied', 'applied'])
    assert.equal(final.batch?.status, crash === 'partial' ? 'indeterminate' : 'applied')
    if (crash === 'rolled_back') assert.deepEqual(final.nodes.map((row) => row.action_generation), [1, 2])
    assert.equal(db.raw.prepare("SELECT status FROM runs WHERE run_id = 'r1'").get()?.status, 'succeeded')
    assert.throws(() => withTx(writer, (tx) => insertRows(tx,
      { batch_id: batch, node_run_id: proof.node_run_id, run_id: run, items: proposals }, proposals)), /attempt fenced/)
    return {
      crash, before, after: final,
      reconcile: { writer_rows: stored, written_count_at_inspect: proof.written_count, missing_count_at_inspect: proof.missing_count,
        partial: proof.partial, evidence_recorded: !!db.raw.prepare("SELECT 1 FROM node_run_events WHERE node_run_id = ? AND type = 'memory.apply.inspected'").get(proof.node_run_id),
        stopped_attempt_cannot_write: true, source_run: 'succeeded' },
    }
  } finally {
    try { db.raw.close() } catch { /* closed before spawn */ }
    try { writer.raw.close() } catch { /* closed before spawn */ }
  }
}

export async function caseG11(): Promise<InjectionResult> {
  const dir = mkdtempSync(join(tmpdir(), 'orch-g11-'))
  try {
    const results: Awaited<ReturnType<typeof scenario>>[] = []
    for (const crash of CASES) results.push(await scenario(dir, crash))
    const section = (key: 'before' | 'after' | 'reconcile') =>
      JSON.stringify(Object.fromEntries(results.map((result) => [result.crash, result[key]])), null, 2)
    return { case: 'G-11', params: { signal: 'SIGKILL', scenarios: CASES, approved_items: 2, storage: 'separate SQLite writer' },
      before: section('before'), after: section('after'), reconcile: section('reconcile') }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

if (process.argv[2] === '--worker' && process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , , dbFile, writerFile, run, crash] = process.argv
  await memoryRuntime(openDb(dbFile!), setupWriter(writerFile!), crash as Crash).advance({ memory_run_id: run! })
  throw new Error('G-11 写入子进程在断点前返回')
}
