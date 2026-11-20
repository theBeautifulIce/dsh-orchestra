/** G-11 uses a separate durable writer store so ledger projections cannot stand in for write facts. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentHash, type MemoryItemInput } from '../src/core/memory-canonical.ts'
import { uuidv7 } from '../src/core/ids.ts'
import { openServiceOrchestra } from '../src/index.ts'
import { wakeOnEvent } from '../src/service/commands/wait.ts'
import { listUnverifiedEffects } from '../src/service/queries/effects.ts'
import { ORPHAN_REFERENCES_SQL, sealCheckpoint, type FaultQuery } from './fault-reconcile.ts'
import { businessQuery, checkpoint, EVENT_PREFIX, faultRows, missingPrefix } from './fault-business-support.ts'
import type { FaultCase } from './fault-report.ts'
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

function insertRows(tx: Pick<Tx, 'get' | 'run'>, input: Pick<GovernedWriteInput, 'batch_id' | 'node_run_id' | 'run_id'>, items: readonly MemoryItemInput[]) {
  if (tx.get('SELECT 1 FROM fences WHERE attempt_id = ?', [input.node_run_id])) throw new Error('attempt fenced')
  return items.map((item) => {
    const id = 'g11_' + item.client_key
    tx.run('INSERT INTO written VALUES (?, ?, ?, ?, ?)', [input.batch_id, item.client_key, contentHash(item), id, item.content])
    return { client_key: item.client_key, item_id: id }
  })
}

function memoryRuntime(db: Db, writer: Db, crash?: Crash, recordWrite?: (input: GovernedWriteInput) => void) {
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
        recordWrite?.(input)
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

async function killWriter(dbFile: string, writerFile: string, runId: string, crash: Crash) {
  const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--worker', dbFile, writerFile, runId, crash],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  return new Promise<{ pid: number; code: number | null; signal: NodeJS.Signals; output: string }>((resolve, reject) => {
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
      else if (!child.pid) reject(new Error('G-11 writer PID missing'))
      else resolve({ pid: child.pid, code, signal, output })
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

async function scenario(dir: string, crash: Crash, sourceRunId?: string) {
  const dbFile = join(dir, crash + '.db')
  const writerFile = join(dir, crash + '-writer.db')
  let db = openDb(dbFile)
  let writer = setupWriter(writerFile)
  const before: unknown[] = []
  const scoped = sourceRunId !== undefined
  const sourceRun = sourceRunId ?? 'r1'
  const stages: Record<string, ReturnType<typeof s6Snapshot>> = {}
  const retries: Pick<GovernedWriteInput, 'node_run_id' | 'run_id' | 'batch_id'>[] = []
  try {
    if (!scoped) {
      applySteps(db, loadSteps(defaultMigrationsDir()))
      seed(db)
      db.raw.prepare("UPDATE runs SET status = 'succeeded' WHERE run_id = 'r1'").run()
    }
    const { memory_run_id: run, batch_id: batch } = startMemoryRun(db, {
      source_run_id: sourceRun, request_key: 'g11', reason: 'G-11', operation_id: uuidv7(), now: NOW,
    })
    await memoryRuntime(db, writer).advance({ memory_run_id: run })
    const { decision_id } = db.raw.prepare('SELECT decision_id FROM memory_batches WHERE batch_id = ?').get(batch)!
    withTx(db, (tx) => resolveMemoryApproval(tx, TEST_SECRET, {
      batch_id: batch, decision_id: String(decision_id), resolution: 'approved', actor: ACTOR, now: NOW,
    }))
    const capture = (stage: string) => {
      if (!scoped) return
      stages[stage] = s6Snapshot(db, writer, batch, run, sourceRun)
      if (stage !== 'after') {
        checkpoint(db, dir, crash + '-' + stage + '.db')
        checkpoint(writer, dir, crash + '-' + stage + '-writer.db')
      }
    }
    before.push(ledgerSnapshot(db, batch, run))
    capture('before')
    const prefix = scoped ? faultRows(db, EVENT_PREFIX) : []
    db.raw.close()
    writer.raw.close()
    const termination = await killWriter(dbFile, writerFile, run, crash)
    db = openDb(dbFile)
    writer = setupWriter(writerFile)
    const cut = ledgerSnapshot(db, batch, run)
    assert.deepEqual({ ...cut.batch }, { status: 'applying', outcome: null, applied_count: 0 })
    assert.equal(cut.nodes[0]?.status, 'started')
    before.push(cut)
    capture('breakpoint')
    const applyId = String(db.raw.prepare("SELECT apply_node_run_id FROM memory_batches WHERE batch_id = ?").get(batch)!.apply_node_run_id)
    const maintenance = '2026-11-20T00:00:00.000Z'
    const clock = new ScriptedClock('g11-restart', { wallClockMs: Date.parse(maintenance), monotonicNs: 0 })
    sweep(db, TEST_SECRET, { now: maintenance, clock, executorLost: [applyId] })
    assert.equal(ledgerSnapshot(db, batch, run).nodes[0]?.status, 'indeterminate_side_effect')
    capture('lost')
    const runtime = memoryRuntime(db, writer, undefined, ({ node_run_id, run_id, batch_id }) => {
      retries.push({ node_run_id, run_id, batch_id })
    })
    assert.equal((await runtime.advance({ memory_run_id: run })).status, 'blocked')
    const recovery = { db, secret: TEST_SECRET, now: () => NOW, inspectWrite: fencedInspection(writer) }
    const original = recovery.inspectWrite
    if (scoped) {
      const lost = stages.lost
      await assert.rejects(inspectMemoryRecovery({ ...recovery, inspectWrite: async (scope) => ({
        ...scope, stopped_at: '', entries: [],
      }) }, batch), { code: 'VERIFICATION_TOO_WEAK' })
      assert.deepEqual(s6Snapshot(db, writer, batch, run, sourceRun), lost)
    }
    if (crash === 'partial') {
      await assert.rejects(inspectMemoryRecovery({ ...recovery, inspectWrite: async (scope) => {
        const facts = await original(scope)
        return { ...facts, entries: facts.entries.map((entry) => ({ ...entry, content_hash: 'wrong' })) }
      } }, batch), { code: 'MEMORY_APPLY_CONFLICT' })
      assert.equal(ledgerSnapshot(db, batch, run).batch?.status, 'applying')
    }
    const proof = await runtime.inspectBatch(batch)
    if (scoped) {
      assert.equal(stages.breakpoint?.writerRows.length, crash === 'committed' ? 2 : crash === 'partial' ? 1 : 0)
      assert.equal(stages.breakpoint?.fences.length, 0)
      assert.ok(proof.evidence_id)
      assert.ok(Number.isFinite(Date.parse(proof.stopped_at)))
    }
    assert.equal(proof.written_count, crash === 'committed' ? 2 : crash === 'partial' ? 1 : 0)
    assert.equal(proof.missing_count, 2 - proof.written_count)
    assert.equal(proof.partial, crash === 'partial')
    sweep(db, TEST_SECRET, { now: maintenance, clock })
    capture('inspected')
    assert.deepEqual((await runtime.inspectBatch(batch)), proof)
    if (scoped) assert.deepEqual(s6Snapshot(db, writer, batch, run, sourceRun), stages.inspected)
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
    if (scoped) assert.deepEqual(s6Snapshot(db, writer, batch, run, sourceRun), stages.inspected)
    const result = runtime.resolveRecovery(ACTOR, request)
    capture('resolved')
    assert.deepEqual(runtime.resolveRecovery(ACTOR, request), result)
    if (scoped) assert.deepEqual(s6Snapshot(db, writer, batch, run, sourceRun), stages.resolved)

    let acknowledgement: { request: unknown; reply: unknown; inspection: unknown; operationId: string } | undefined
    if (crash === 'partial') {
      assert.throws(() => startMemoryRun(db, {
        source_run_id: sourceRun, request_key: 'second', reason: 'G-11', operation_id: uuidv7(), now: NOW, retry: true,
      }), { code: 'MEMORY_RUN_ACTIVE' })
      assert.equal((await runtime.advance({ memory_run_id: run })).status, 'blocked')
      const ack = await runtime.inspectBatch(batch)
      assert.equal(ack.decision_id, result.abandon_ack_id)
      assert.equal(ledgerSnapshot(db, batch, run).run, 'paused')
      const ackRequest = { ...request, decision_id: ack.decision_id,
        revision: ack.revision, operation_id: uuidv7(), resolution: 'acknowledge_abandon' } as const
      const acked = runtime.resolveRecovery(ACTOR, ackRequest)
      assert.equal(acked.terminal, 'succeeded_with_unverified')
      acknowledgement = { request: ackRequest, reply: acked, inspection: ack, operationId: ackRequest.operation_id }
      if (scoped) {
        const first = s6Snapshot(db, writer, batch, run, sourceRun)
        assert.deepEqual(runtime.resolveRecovery(ACTOR, ackRequest), acked)
        assert.deepEqual(s6Snapshot(db, writer, batch, run, sourceRun), first)
      }
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
    assert.equal(db.raw.prepare("SELECT status FROM runs WHERE run_id = ?").get(sourceRun)?.status, 'succeeded')
    assert.throws(() => withTx(writer, (tx) => insertRows(tx,
      { batch_id: batch, node_run_id: proof.node_run_id, run_id: run }, proposals)), /attempt fenced/)
    capture('after')
    if (scoped) {
      assert.deepEqual(retries.map(row => row.node_run_id), crash === 'rolled_back' ? [result.replacement_node_run_id] : [])
      if (crash !== 'rolled_back') assert.deepEqual(stages.after?.writerRows, stages.breakpoint?.writerRows)
      const outstanding = stages.after?.unverified.filter(row => row.node_id === 'mem_apply')
      assert.deepEqual(outstanding?.map(row => [row.node_run_id, row.evidence]), crash === 'partial'
        ? [[proof.node_run_id, proof.evidence_id]] : [])
      assert.equal(stages.after?.terminal.length, 1)
      assert.deepEqual(faultRows(db, EVENT_PREFIX).slice(0, prefix.length), prefix)
    }
    return {
      crash, before, after: final,
      s6: { stages, prefix, termination, run, batch, sourceRun, proof, request, resolution: result, acknowledgement, retries },
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

function s6Snapshot(db: Db, writer: Db, batch: string, run: string, sourceRun: string) {
  return {
    source: faultRows(db, 'SELECT * FROM runs WHERE run_id=?', sourceRun),
    run: faultRows(db, 'SELECT * FROM runs WHERE run_id=?', run),
    batch: faultRows(db, 'SELECT * FROM memory_batches WHERE batch_id=?', batch),
    items: faultRows(db, 'SELECT * FROM memory_items WHERE batch_id=? ORDER BY client_key', batch),
    nodes: faultRows(db, "SELECT * FROM node_runs WHERE run_id=? AND node_id='mem_apply' ORDER BY attempt", run),
    decisions: faultRows(db, 'SELECT * FROM decisions WHERE run_id=? ORDER BY decision_id', run),
    recoveries: faultRows(db, 'SELECT * FROM memory_write_recoveries WHERE batch_id=? ORDER BY node_run_id', batch),
    events: faultRows(db, 'SELECT * FROM events WHERE run_id=? ORDER BY seq', run),
    terminal: faultRows(db, "SELECT * FROM events WHERE run_id=? AND type='run.terminal' ORDER BY seq", run),
    chains: faultRows(db, 'SELECT e.* FROM node_run_events e JOIN node_runs n ON n.node_run_id=e.node_run_id WHERE n.run_id=? ORDER BY e.node_run_id, e.seq', run),
    writerRows: faultRows(writer, 'SELECT * FROM written WHERE batch_id=? ORDER BY client_key', batch),
    fences: faultRows(writer, 'SELECT * FROM fences ORDER BY attempt_id'),
    unverified: listUnverifiedEffects(db, { run_id: run, now: Date.parse(NOW) }).items,
    globalEventCount: db.raw.prepare('SELECT COUNT(*) AS n FROM events').get()?.n,
    receiptCount: db.raw.prepare('SELECT COUNT(*) AS n FROM inbox').get()?.n,
  }
}

async function startS6Source(file: string) {
  const service = await openServiceOrchestra({ dbFile: file, secret: TEST_SECRET, phase: 'S6' })
  const { commands, db } = service.orchestra
  const workflowId = 'wf_s6_g11_source'
  try {
    commands.loadWorkflow({ workflow_id: workflowId, workflow_version: '1', nodes: [{
      node_id: 'source', type: 'wait', wait: { wait_kind: 'event', match: { type: 'g11.source.done' }, max_wait_ms: 60_000 },
    }] })
    const source = commands.startRun({ workflowId, workflowVersion: '1', taskTitle: 'S6 G-11 synthetic source',
      operationId: uuidv7(), now: NOW }).run_id
    const dispatch = await commands.dispatch({ runId: source, nodes: { source: { tools: [] } }, now: NOW })
    assert.deepEqual(dispatch.map(item => item.status), ['waiting'])
    const wake = withTx(db, tx => wakeOnEvent(tx, TEST_SECRET, { runId: source, eventType: 'g11.source.done', now: NOW }))
    assert.equal(wake.woken, 1)
    assert.equal(db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(source)?.status, 'succeeded')
    return source
  } finally {
    await service.release()
  }
}

const ARTIFACT_STAGES = ['before', 'breakpoint', 'lost', 'inspected', 'resolved'] as const

export const caseG11S6: FaultCase = async ({ directory }) => {
  const results: ({ crash: Crash } & Awaited<ReturnType<typeof scenario>>['s6'])[] = []
  const artifacts: string[] = ['memory-recovery.json']
  const extraQueries: Record<string, FaultQuery> = {}
  for (const crash of CASES) {
    const database = crash + '.db'
    const file = join(directory, database)
    const writer = crash + '-writer.db'
    const source = await startS6Source(file)
    const result = (await scenario(directory, crash, source)).s6
    sealCheckpoint(file)
    sealCheckpoint(join(directory, writer))
    results.push({ crash, ...result })
    artifacts.push(database, writer)
    for (const stage of ARTIFACT_STAGES) artifacts.push(crash + '-' + stage + '.db', crash + '-' + stage + '-writer.db')
    const cut = crash + '-breakpoint.db'
    const lost = crash + '-lost.db'
    const inspected = crash + '-inspected.db'
    const { run, batch, proof } = result
    const n = crash === 'committed' ? 2 : crash === 'partial' ? 1 : 0
    const terminal = crash === 'partial' ? 'succeeded_with_unverified' : 'succeeded'
    extraQueries[crash + '_breakpoint_writer_rows'] = businessQuery(crash + '-breakpoint-writer.db',
      'SELECT * FROM written WHERE batch_id=? ORDER BY client_key', n, batch)
    extraQueries[crash + '_final_writer_rows'] = businessQuery(writer,
      'SELECT * FROM written WHERE batch_id=? ORDER BY client_key', crash === 'partial' ? 1 : 2, batch)
    extraQueries[crash + '_killed_while_applying'] = businessQuery(cut,
      "SELECT * FROM memory_batches WHERE batch_id=? AND memory_run_id=? AND status='applying' AND outcome IS NULL AND applied_count=0", 1, batch, run)
    extraQueries[crash + '_lost_executor'] = businessQuery(lost,
      "SELECT * FROM node_runs WHERE node_run_id=? AND run_id=? AND status='indeterminate_side_effect'", 1, proof.node_run_id, run)
    extraQueries[crash + '_uninspected_at_loss'] = businessQuery(lost,
      'SELECT * FROM memory_write_recoveries WHERE batch_id=?', 0, batch)
    extraQueries[crash + '_inspection'] = businessQuery(inspected,
      "SELECT * FROM memory_write_recoveries WHERE batch_id=? AND node_run_id=? AND evidence_id=? AND stopped_at=? AND status='inspected'",
      1, batch, proof.node_run_id, proof.evidence_id, proof.stopped_at)
    extraQueries[crash + '_writer_fence'] = businessQuery(crash + '-inspected-writer.db',
      'SELECT * FROM fences WHERE attempt_id=? AND stopped_at=?', 1, proof.node_run_id, proof.stopped_at)
    extraQueries[crash + '_evidence_events'] = businessQuery(database,
      "SELECT * FROM events WHERE run_id=? AND node_run_id=? AND type='memory.apply.inspected' AND json_extract(payload_redacted,'$.evidence_id')=?",
      1, run, proof.node_run_id, proof.evidence_id)
    extraQueries[crash + '_recovery_events'] = businessQuery(database,
      "SELECT * FROM events WHERE run_id=? AND node_run_id=? AND type='memory.apply.recovered' AND json_extract(payload_redacted,'$.evidence_id')=? ORDER BY seq",
      crash === 'partial' ? 2 : 1, run, proof.node_run_id, proof.evidence_id)
    extraQueries[crash + '_terminal_event'] = businessQuery(database,
      "SELECT * FROM events WHERE run_id=? AND type='run.terminal' AND json_extract(payload_redacted,'$.status')=?", 1, run, terminal)
    extraQueries[crash + '_memory_terminal'] = businessQuery(database,
      'SELECT * FROM runs WHERE run_id=? AND status=?', 1, run, terminal)
    extraQueries[crash + '_source_terminal'] = businessQuery(database,
      "SELECT * FROM runs WHERE run_id=? AND status='succeeded'", 1, source)
    extraQueries[crash + '_final_batch'] = businessQuery(database,
      'SELECT * FROM memory_batches WHERE batch_id=? AND memory_run_id=? AND status=? AND applied_count=?',
      1, batch, run, crash === 'partial' ? 'indeterminate' : 'applied', crash === 'partial' ? 1 : 2)
    extraQueries[crash + '_original_receipt'] = businessQuery(database,
      "SELECT * FROM inbox WHERE operation_id=? AND status='applied' AND receipt_json IS NOT NULL", 1, result.request.operation_id)
    extraQueries[crash + '_orphan_runs'] = businessQuery(database, ORPHAN_REFERENCES_SQL, 0)
    extraQueries[crash + '_missing_events'] = missingPrefix(database, result.prefix)
    if (crash === 'rolled_back') {
      extraQueries.retry_generation = businessQuery(database,
        "SELECT * FROM node_runs WHERE run_id=? AND node_id='mem_apply' AND (action_generation=1 AND status='superseded' OR action_generation=2 AND status='done') ORDER BY action_generation",
        2, run)
    }
    if (crash === 'partial') {
      assert.ok(result.acknowledgement)
      extraQueries.partial_ack_receipt = businessQuery(database,
        "SELECT * FROM inbox WHERE operation_id=? AND status='applied' AND receipt_json IS NOT NULL", 1, result.acknowledgement.operationId)
      extraQueries.partial_ack_decisions = businessQuery(database,
        "SELECT * FROM decisions WHERE run_id=? AND kind IN ('verify_human','abandon_ack') AND status='resolved' ORDER BY kind", 2, run)
      extraQueries.partial_still_unverified = businessQuery(database,
        "SELECT * FROM node_runs WHERE run_id=? AND node_run_id=? AND status='abandoned_unverified' AND side_effect_verified_none=0",
        1, run, proof.node_run_id)
      extraQueries.partial_items_split = businessQuery(database,
        "SELECT * FROM memory_items WHERE batch_id=? AND (client_key='first' AND status='applied' AND applied_item_id IS NOT NULL OR client_key='second' AND status='approved' AND applied_item_id IS NULL) ORDER BY client_key",
        2, batch)
    }
  }

  const partial = results.find(result => result.crash === 'partial')!
  const forStage = (stage: string) => Object.fromEntries(results.map(result => [result.crash, result.stages[stage]]))
  const writes = Object.fromEntries(results.map(result => [result.crash, result.retries]))
  writeFileSync(join(directory, artifacts[0]!), JSON.stringify({ scenarios: results, writes }, null, 2) + '\n')
  return {
    params: { storage: 'separate local SQLite writer implementing governed write and fence/inspect ports',
      fixture: 'synthetic proposal/judge and controlled host protocol; actual independent SQLite transactions' },
    sampleIds: Object.fromEntries(results.flatMap(result => [
      [result.crash + '_source_run_id', result.sourceRun], [result.crash + '_memory_run_id', result.run],
      [result.crash + '_batch_id', result.batch], [result.crash + '_apply_node_run_id', result.proof.node_run_id],
    ])),
    boundary: { reached: true, marker: 'G11_WRITE_REACHED', writers: results.map(result => ({ crash: result.crash, ...result.termination })) },
    snapshots: { before: forStage('before'), breakpoint: forStage('breakpoint'), after: forStage('after') },
    queries: {
      half_rows: businessQuery('partial.db', `SELECT i.* FROM memory_items i JOIN memory_batches b USING (batch_id) WHERE i.batch_id=?
        AND (b.status!='indeterminate' OR (i.status='applied')!=(i.applied_item_id IS NOT NULL))`, 0, partial.batch),
      orphan_runs: businessQuery('partial.db', ORPHAN_REFERENCES_SQL, 0),
      missing_events: missingPrefix('partial.db', partial.prefix),
    },
    extraQueries,
    artifacts,
    extra: { stage_ledger_and_writer_copies: ARTIFACT_STAGES, writes },
  }
}

if (process.argv[2] === '--worker' && process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , , dbFile, writerFile, run, crash] = process.argv
  await memoryRuntime(openDb(dbFile!), setupWriter(writerFile!), crash as Crash).advance({ memory_run_id: run! })
  throw new Error('G-11 写入子进程在断点前返回')
}
