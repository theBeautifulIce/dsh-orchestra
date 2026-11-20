import assert from 'node:assert/strict'
import { join } from 'node:path'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { ScriptedClock } from '../src/core/clock.ts'
import { OrchError } from '../src/core/errors.ts'
import { uuidv7 } from '../src/core/ids.ts'
import { BridgeClient } from '../src/executor/bridge.ts'
import { EvidenceCollector } from '../src/executor/evidence-collector.ts'
import { ReadOnlyToolRunner, ToolRegistry, type HostRunner } from '../src/executor/tools.ts'
import { chainBreakOf, readChain } from '../src/infra/db/ledger.ts'
import { UNVERIFIED_EFFECT } from '../src/infra/db/unverified-effects.ts'
import { openDb, withTx, type Db } from '../src/infra/sqlite/driver.ts'
import { inspectEffectEvidence, resolveEffect } from '../src/service/commands/effects.ts'
import { loadNodeRun } from '../src/service/commands/lease.ts'
import { acquireNodeRun, renewNodeLease, submitCancel, submitReport, sweepNow } from '../src/service/commands/runtime.ts'
import { listUnverifiedEffects } from '../src/service/queries/effects.ts'
import { createRun } from '../src/service/runs.ts'
import { WorkflowCatalog } from '../src/service/workflows.ts'
import { freshLedger, TEST_SECRET } from '../tests/fixtures/ledger.ts'
import { businessQuery as query, checkpoint, EVENT_PREFIX, faultRows, missingPrefix } from './fault-business-support.ts'
import { ORPHAN_REFERENCES_SQL, sealCheckpoint } from './fault-reconcile.ts'
import type { FaultCase, FaultObservation } from './fault-report.ts'

const START = Date.parse('2026-11-20T00:00:00.000Z')
const iso = (elapsed: number) => new Date(START + elapsed).toISOString()
const NODE = 'SELECT * FROM node_runs WHERE node_run_id=?'
const RUN_TERMINAL = "SELECT * FROM events WHERE run_id=? AND type='run.terminal'"
const NODE_EVENT = 'SELECT * FROM node_run_events WHERE node_run_id=? AND type=? ORDER BY seq'
const OUTBOX = 'SELECT * FROM bridge_tool_outbox WHERE node_run_id=? AND attempt=? AND executor_agent_id=? AND call_id=?'
const EXECUTION = 'SELECT * FROM tool_executions WHERE node_run_id=? ORDER BY tool_seq'
const RESOLUTION = 'SELECT * FROM unverified_resolutions WHERE node_run_id=?'
const UNVERIFIED = 'SELECT n.* FROM node_runs n WHERE n.node_run_id=? AND (' + UNVERIFIED_EFFECT + ')'
const WORKFLOW = 's6-cancel-receipt-fixture'
const PURE = 'fixture.read'
const VERIFY = 'fixture.inspect-commit'
const DATABASE = 'orchestra.db'

function setup(directory: string, registry: ToolRegistry, label: string) {
  const { db, file } = freshLedger(directory)
  const catalog = new WorkflowCatalog('S6', db, name => registry.lookup(name)?.capability === 'read_only', registry)
  const clock = new ScriptedClock(label, { wallClockMs: START, monotonicNs: 0 })
  const runtime = { catalog, clock, db, secret: TEST_SECRET, phase: 'S6' as const }
  let elapsed = 0
  const now = () => iso(elapsed)
  const advance = (ms: number) => {
    elapsed += ms
    clock.advanceMs(ms)
    clock.setWallClockMs(START + elapsed)
  }
  return { db, file, catalog, clock, runtime, now, advance, scan: () => sweepNow(runtime, now()) }
}

type Fixture = ReturnType<typeof setup>

function provision(fixture: Fixture, name: string, tool: string, policy: 'pure' | undefined, ttl = 120_000) {
  const { catalog, db, now, runtime } = fixture
  const workflowId = WORKFLOW + '-' + name
  const nodeId = 'action'
  catalog.load({
    workflow_id: workflowId, workflow_version: '1',
    nodes: [{ node_id: nodeId, type: 'agent', side_effect_policy: policy, tools: { allow: [tool], deny: [] } }],
    pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }],
  })
  const run = createRun(db, catalog, { workflowId, workflowVersion: '1', taskTitle: 'S6 ' + name, now: now() })
  const nodeRunId = run.nodes[0]!.node_run_id
  const lease = acquireNodeRun(runtime, { nodeRunId, ownerEpoch: db.epoch, leaseTtlMs: ttl, now: now() })
  const started = submitReport(runtime, {
    nodeRunId, attempt: 1, generation: lease.action_generation, now: now(), expectedStatus: 'dispatched',
    report: { report_id: uuidv7(), node_run_id: nodeRunId, attempt: 1, status: 'started' },
  })
  assert.equal(started.accepted, true)
  return { nodeRunId, nodeId, runId: run.run_id, workflowHash: catalog.definitionHash(workflowId, '1'), name, lease }
}

type Subject = ReturnType<typeof provision>

function collect(fixture: Fixture, directory: string, registry: ToolRegistry, run: HostRunner['run'], subject: Subject, tool: string) {
  const agentId = 'local-host-' + subject.name
  const request = { callId: 'local-call-' + subject.name, tool, args: [], cwd: '.', timeoutMs: 5_000 }
  const make = () => new EvidenceCollector({
    db: fixture.db, secret: TEST_SECRET, registry, clock: fixture.clock,
    runner: new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true, run }, directory),
    policy: { allow: [tool], deny: [] }, allowedTools: [tool],
    nodeRunId: subject.nodeRunId, attempt: 1, executorAgentId: agentId, nowAt: fixture.now,
  })
  return { make, request, agentId, scope: [subject.nodeRunId, 1, agentId, request.callId] as const }
}

function snapshot(db: Db, subject: Subject) {
  return {
    node: faultRows(db, NODE, subject.nodeRunId)[0],
    nodeEvents: faultRows(db, 'SELECT * FROM node_run_events WHERE node_run_id=? ORDER BY seq', subject.nodeRunId),
    reports: faultRows(db, 'SELECT * FROM report_registry WHERE node_run_id=? ORDER BY report_seq', subject.nodeRunId),
    completion: faultRows(db, RUN_TERMINAL, subject.runId),
    outbox: faultRows(db, 'SELECT * FROM bridge_tool_outbox WHERE node_run_id=? ORDER BY call_id', subject.nodeRunId),
    toolExecutions: faultRows(db, EXECUTION, subject.nodeRunId),
    resolutions: faultRows(db, RESOLUTION, subject.nodeRunId),
  }
}

function resultOf<T>(action: () => T) {
  try { return { value: action(), code: null } }
  catch (error) {
    if (!(error instanceof OrchError)) throw error
    return { value: null, code: error.code, message: error.message }
  }
}

const REJECTED_REPORT = "SELECT * FROM report_registry WHERE report_id=? AND state='rejected'"
const APPLIED_REPORT = "SELECT * FROM report_registry WHERE report_id=? AND state='applied'"

const cancelScenarios = [
  { label: 'confirmed', receipt: 'interrupted', status: 'timing_out', fence: 'armed' },
  { label: 'refused', receipt: 'not_interruptible', status: 'stopping', fence: null },
  { label: 'unanswered', receipt: 'unknown', status: 'stopping', fence: null },
] as const

export const caseG05S6: FaultCase = async ({ directory }) => {
  const registry = new ToolRegistry()
  registry.register({ name: PURE, capability: 'read_only', command: { bin: 'fixture-read', args: [] } })
  const fixture = setup(directory, registry, 's6-g05')
  const { db, runtime, now } = fixture
  const before: Record<string, unknown> = {}
  const breakpoint: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const sampleIds: FaultObservation['sampleIds'] = {}
  const checks: NonNullable<FaultObservation['checks']> = {}
  const extraQueries: NonNullable<FaultObservation['extraQueries']> = {}
  const artifacts = [DATABASE]
  let livePrefix: ReturnType<typeof faultRows> = []
  try {
    for (const scenario of cancelScenarios) {
      const { label, receipt, status, fence } = scenario
      const subject = provision(fixture, label, PURE, 'pure')
      const nodeId = subject.nodeRunId
      sampleIds[label + '_node'] = nodeId
      sampleIds[label + '_run'] = subject.runId
      renewNodeLease(runtime, { nodeRunId: nodeId, leaseTtlMs: 120_000, now: now() })
      const { make, request, agentId } = collect(fixture, directory, registry, async () => ({
        exitCode: 1, stdout: '', stderr: 'Local fixture action failed before its receipt was delivered',
      }), subject, PURE)
      const result = await make().collect(request)
      assert.ok(result.evidence && result.trace)
      const held = Promise.withResolvers<void>()
      const delivered = Promise.withResolvers<void>()
      const protocol: { method: string; params: unknown; response: unknown }[] = []
      let stopped = false
      let receiptDelivered = false
      let delivery: Promise<void> | undefined
      const bridge = new BridgeClient({
        async *listen() {},
        async request<T>(method: string, params: unknown): Promise<T> {
          const scoped = params as { executorAgentId: string; attempt?: number }
          assert.equal(scoped.executorAgentId, agentId)
          if (scoped.attempt !== undefined) assert.equal(scoped.attempt, 1)
          if (method === 'executor.toolResult') {
            protocol.push({ method, params, response: 'in_flight' })
            held.resolve()
            await delivered.promise
            receiptDelivered = true
          }
          if (method === 'executor.cancel' && label === 'unanswered') {
            protocol.push({ method, params, response: 'transport_closed_before_response' })
            throw new OrchError('SERVICE_UNAVAILABLE', 'Local fixture cancel receipt missing')
          }
          const response = method === 'executor.cancel' ? receipt
            : method === 'executor.whenIdle' ? { idle: stopped, timedOut: !stopped }
              : method === 'executor.state' ? { state: stopped ? 'idle' : 'running', hasToolCall: !stopped, toolCallSeq: 1 }
                : undefined
          protocol.push({ method, params, response: response ?? null })
          return response as T
        },
      })
      try {
        delivery = bridge.toolResult({ executorAgentId: agentId, attempt: 1, callId: request.callId,
          result: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, evidenceId: result.trace.executionId } })
        await held.promise
        const started = snapshot(db, subject)
        before[label] = started
        const beforeFile = label + '-before.db'
        const middleFile = label + '-breakpoint.db'
        const sweptFile = label + '-preterminal.db'
        const settledFile = label + '-after.db'
        for (const name of [beforeFile, middleFile, sweptFile, settledFile]) artifacts.push(name)
        checkpoint(db, directory, beforeFile)

        const original = withTx(db, tx => loadNodeRun(tx, nodeId))
        const askedAt = now()
        const cancel = (cancelResult: typeof receipt) => submitCancel(runtime, {
          nodeRunId: nodeId, attempt: 1, revision: original.revision, cancelResult,
          now: askedAt, graceMs: 30_000, extendDeadlineMs: 90_000,
        })
        const responses = await Promise.all([0, 1].map(async () => {
          const cancelResult = await bridge.cancel({ executorAgentId: agentId, attempt: 1 }).catch(error => {
            if (!(error instanceof OrchError) || error.code !== 'SERVICE_UNAVAILABLE' || label !== 'unanswered') throw error
            return 'unknown' as const
          })
          assert.equal(cancelResult, receipt)
          return resultOf(() => cancel(receipt))
        }))
        const lateId = uuidv7()
        const late = submitReport(runtime, {
          nodeRunId: nodeId, attempt: 1, generation: subject.lease.action_generation, now: now(), expectedStatus: 'started',
          report: { report_id: lateId, node_run_id: nodeId, attempt: 1, status: 'done', evidence: { source: 'tool_result' } },
        })
        const noStop = await bridge.whenIdle({ executorAgentId: agentId, timeoutMs: 100 })
        const middle = snapshot(db, subject)
        checkpoint(db, directory, middleFile)
        fixture.advance(31_000)
        const swept = fixture.scan()
        const preterminal = snapshot(db, subject)
        livePrefix = faultRows(db, EVENT_PREFIX)
        checkpoint(db, directory, sweptFile)
        breakpoint[label] = { cancel: responses, late, noStop, initial: middle, swept, preterminal }

        delivered.resolve()
        await delivery
        stopped = receiptDelivered
        const stoppedIdle = await bridge.whenIdle({ executorAgentId: agentId, timeoutMs: 100 })
        const stoppedState = await bridge.state({ executorAgentId: agentId })
        assert.deepEqual(stoppedIdle, { idle: true, timedOut: false })
        assert.equal(stoppedState.state, 'idle')
        const finalReportId = uuidv7()
        const finalReport = {
          nodeRunId: nodeId, attempt: 1, generation: subject.lease.action_generation, now: now(), expectedStatus: 'stopping',
          report: { report_id: finalReportId, node_run_id: nodeId, attempt: 1, status: 'failed',
            evidence: result.evidence, output: { evidence_trace: [result.trace] } },
        }
        const accepted = submitReport(runtime, finalReport)
        fixture.scan()
        const terminal = snapshot(db, subject)
        const repeatedCancel = cancel(receipt)
        checkpoint(db, directory, settledFile)
        const repeatedReport = submitReport(runtime, finalReport)
        const afterReplay = snapshot(db, subject)
        submitReport(runtime, finalReport)
        fixture.scan()
        const repeated = snapshot(db, subject)
        after[label] = { repeatedCancel, accepted, repeatedReport, stoppedIdle, stoppedState, terminal, repeated, protocol }

        checks[label + '_cancel_outcomes'] = {
          actual: responses.map(row => row.value ? [row.value.next_status, row.value.fence_state, row.value.reason] : row.code),
          expected: scenario.fence === 'armed'
            ? [[status, fence, 'cancel_confirmed'], [status, fence, 'fence_already_armed']]
            : [[status, fence, receipt], 'STALE_GENERATION'],
        }
        checks[label + '_late_report'] = {
          actual: late,
          expected: { accepted: false, registry_state: 'rejected', reason: fence === 'armed' ? 'fence_armed' : 'status_mismatch' },
        }
        checks[label + '_sweep_and_heartbeat'] = {
          actual: [preterminal.node?.status, preterminal.node?.fence_state, preterminal.node?.heartbeat_at,
            preterminal.node?.deadline_at, cell(middle, 'fence_grace_until'), preterminal.node?.cancel_result,
            swept.fence_revoked, noStop],
          expected: ['stopping', fence === 'armed' ? 'revoked' : null, askedAt,
            fence === 'armed' ? iso(Date.parse(askedAt) - START + 61_000) : receipt === 'not_interruptible' ? iso(Date.parse(askedAt) - START + 90_000) : null,
            fence === 'armed' ? iso(Date.parse(askedAt) - START + 30_000) : null, receipt,
            fence === 'armed' ? [nodeId] : [], { idle: false, timedOut: true }],
        }
        checks[label + '_terminal_replay'] = {
          actual: [accepted.accepted, terminal.node?.status, repeatedCancel.reason, repeatedReport.registry_state, repeated, afterReplay.node, afterReplay.completion],
          expected: [true, 'failed', 'terminal_no_out_edge', 'replayed', afterReplay, terminal.node, terminal.completion],
        }
        extraQueries[label + '_in_flight'] = query(beforeFile, NODE_EVENT, 1, nodeId, 'tool_started')
        extraQueries[label + '_armed_anchor'] = query(middleFile, NODE + " AND fence_state='armed' AND fence_armed_at=? AND fence_grace_boot_id='s6-g05' AND fence_grace_monotonic_ns=?",
          fence === 'armed' ? 1 : 0, nodeId, askedAt, (Date.parse(askedAt) - START + 30_000) * 1e6)
        extraQueries[label + '_report_replay_audit'] = query(DATABASE,
          NODE_EVENT.replace(' ORDER BY seq', " AND json_extract(payload,'$.report_id')=? ORDER BY seq"),
          1, nodeId, 'report_replayed', finalReportId)
        extraQueries[label + '_armed'] = query(middleFile, NODE_EVENT, fence === 'armed' ? 1 : 0, nodeId, 'fence_armed')
        extraQueries[label + '_fence_after_grace'] = query(sweptFile, 'SELECT * FROM node_runs WHERE node_run_id=? AND fence_state IS ?', 1, nodeId, fence === 'armed' ? 'revoked' : null)
        extraQueries[label + '_late_rejected'] = query(sweptFile, REJECTED_REPORT, 1, lateId)
        extraQueries[label + '_terminal_before_stop'] = query(sweptFile, RUN_TERMINAL, 0, subject.runId)
        extraQueries[label + '_terminal_after_stop'] = query(settledFile, RUN_TERMINAL + " AND json_extract(payload_redacted,'$.status')='failed'", 1, subject.runId)
        extraQueries[label + '_valid_report'] = query(settledFile, APPLIED_REPORT, 1, finalReportId)
        extraQueries[label + '_single_attempt'] = query(DATABASE, 'SELECT * FROM node_runs WHERE run_id=?', 1, subject.runId)
        extraQueries[label + '_original_attempt'] = query(DATABASE, NODE + ' AND attempt=1 AND action_generation=?', 1, nodeId, subject.lease.action_generation)
      } finally {
        delivered.resolve()
        await delivery
      }
    }
    return {
      params: { phase: 'S6', host: 'trusted local bridge simulator', cancel_boundary: 'completed read has an in-flight toolResult RPC; before agent receipt' },
      sampleIds, boundary: { reached: true, scenarios: cancelScenarios.length }, snapshots: { before, breakpoint, after },
      checks, extraQueries, artifacts, queries: {
        half_rows: query(DATABASE, `SELECT r.run_id FROM runs r LEFT JOIN events e ON r.run_id=e.run_id
          AND e.type='run.terminal' GROUP BY r.run_id HAVING count(e.seq)<>1`, 0),
        orphan_runs: query(DATABASE, ORPHAN_REFERENCES_SQL, 0),
        missing_events: missingPrefix(DATABASE, livePrefix),
      },
    }
  } finally {
    db.raw.close()
    sealCheckpoint(fixture.file)
  }
}

function cell(sample: ReturnType<typeof snapshot>, column: string) {
  return sample.node?.[column] ?? null
}

const HOST_DATABASE = 'host.sqlite'
const HOST_QUERY = 'SELECT * FROM host_commits WHERE reference=? ORDER BY invocation'

async function loseCommittedReceipt(hostFile: string, reference: string, committedAt: string) {
  // The host has its own SQLite connection. Close its reply channel after the
  // autocommitted write, without delivering any completion envelope.
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads')
    const { DatabaseSync } = require('node:sqlite')
    const host = new DatabaseSync(workerData.hostFile)
    parentPort.once('message', ({ reference, committedAt }) => {
      host.prepare("INSERT INTO host_commits(reference,state,committed_at) VALUES (?,'committed',?)").run(reference, committedAt)
      host.close()
      parentPort.close()
    })
  `, { eval: true, workerData: { hostFile } })
  const delivered: unknown[] = []
  worker.on('message', message => delivered.push(message))
  try {
    const exited = once(worker, 'exit', { signal: AbortSignal.timeout(5_000) })
    worker.postMessage({ reference, committedAt })
    const [exitCode] = await exited
    assert.equal(exitCode, 0)
    assert.deepEqual(delivered, [])
    return { closed: true, deliveries: delivered.length }
  } finally {
    await worker.terminate()
  }
}


export const caseG06S6: FaultCase = async ({ directory }) => {
  const registry = new ToolRegistry()
  registry.register({ name: PURE, capability: 'read_only', command: { bin: 'fixture-read', args: [] } })
  const fixture = setup(directory, registry, 's6-g06')
  const { db, now } = fixture
  const hostFile = join(directory, HOST_DATABASE)
  const host = openDb(hostFile)
  try {
    host.raw.exec('CREATE TABLE host_commits (invocation INTEGER PRIMARY KEY, reference TEXT NOT NULL, state TEXT NOT NULL, committed_at TEXT NOT NULL)')
    const pure = provision(fixture, 'pure-control', PURE, 'pure', 300_000)
    const verifier = {
      id: 'fixture-commit-v1', workflowDefinitionHash: '', nodeId: 'action',
      verify(target: { run_id: string; node_run_id: string; attempt: number }, output: { stdout: string }) {
        const record = JSON.parse(output.stdout) as { reference?: string; state?: string }
        const reference = [target.run_id, target.node_run_id, target.attempt].join('/')
        return record.reference === reference && record.state === 'committed' ? { verdict: 'applied' as const, reference } : null
      },
    }
    // The descriptor is fixed against the pinned definition before any verifier runs.
    registry.register({ name: VERIFY, capability: 'read_only', command: { bin: 'fixture-inspect', args: [] } })
    const effect = provision(fixture, 'non-pure-host-action', VERIFY, undefined, 10_000)
    const effectRegistry = new ToolRegistry()
    effectRegistry.register({ name: VERIFY, capability: 'read_only', command: { bin: 'fixture-inspect', args: [] },
      effectVerifier: { ...verifier, workflowDefinitionHash: effect.workflowHash } })
    const reference = [effect.runId, effect.nodeRunId, 1].join('/')
    const items = () => listUnverifiedEffects(db, { run_id: effect.runId, now: Date.parse(now()) }).items.map(row => row.node_run_id)
    const sample = () => ({
      pure: snapshot(db, pure), effect: snapshot(db, effect), unverified: items(),
      host: faultRows(host, HOST_QUERY, reference),
    })
    const before = sample()
    checkpoint(db, directory, 'before.db')

    let pureCalls = 0
    const pureTool = collect(fixture, directory, registry, async () => {
      pureCalls += 1
      return { exitCode: 0, stdout: 'fixture read', stderr: '' }
    }, pure, PURE)
    const pureDeliveries: { outcome: string; params: unknown }[] = []
    const pureBridge = new BridgeClient({
      async *listen() {},
      async request<T>(method: string, params: unknown): Promise<T> {
        assert.equal(method, 'executor.toolResult')
        if (pureDeliveries.length === 0) {
          pureDeliveries.push({ outcome: 'connection_closed_before_delivery', params })
          throw new OrchError('SERVICE_UNAVAILABLE', 'Local pure tool response was dropped')
        }
        pureDeliveries.push({ outcome: 'delivered', params })
        return undefined as T
      },
    })
    const sendPure = async (result: Awaited<ReturnType<EvidenceCollector['collect']>>) => pureBridge.toolResult({
      executorAgentId: pureTool.agentId, attempt: 1, callId: result.callId,
      result: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, evidenceId: result.trace?.executionId },
    })
    const pureResult = await pureTool.make().collect(pureTool.request)
    await assert.rejects(sendPure(pureResult), (error: unknown) => error instanceof OrchError && error.code === 'SERVICE_UNAVAILABLE')
    const pureReplay = await pureTool.make().collect(pureTool.request)
    await sendPure(pureReplay)

    const lost = await loseCommittedReceipt(hostFile, reference, now())
    const breakpoint = sample()
    checkpoint(db, directory, 'breakpoint.db')
    const verifierTool = collect(fixture, directory, effectRegistry, async ({ bin, args }) => {
      assert.deepEqual([bin, args], ['fixture-inspect', []])
      const [record] = faultRows(host, HOST_QUERY, reference)
      return { exitCode: record ? 0 : 1, stdout: JSON.stringify(record ?? {}), stderr: '' }
    }, effect, VERIFY)
    const proof = await verifierTool.make().collect(verifierTool.request)
    assert.ok(proof.trace)
    const evidenceId = proof.trace.executionId

    fixture.advance(10_001)
    const expired = fixture.scan()
    const leaseLost = sample()
    checkpoint(db, directory, 'lease-lost.db')
    fixture.advance(120_001)
    const recovered = fixture.scan()
    const pending = sample()
    checkpoint(db, directory, 'pending.db')
    const reportAtFault = faultRows(db, EVENT_PREFIX)

    const visible = inspectEffectEvidence(db, TEST_SECRET, effect.nodeRunId)
    const current = withTx(db, tx => loadNodeRun(tx, effect.nodeRunId))
    const legal = {
      basis: 'evidence' as const, nodeRunId: effect.nodeRunId, runId: effect.runId,
      expected: { revision: current.revision }, evidenceId,
      evidenceSource: 'run_tool' as const, operationId: uuidv7(), now: now(),
      actor: { kind: 'human' as const, id: 'human:s6-local-audit' },
    }
    const settle = (request: Parameters<typeof resolveEffect>[2]) =>
      withTx(db, tx => resolveEffect(tx, TEST_SECRET, request))
    const weak = { ...legal, evidenceSource: 'tool_result' as const, operationId: uuidv7() }
    const outdated = { ...legal, expected: { revision: current.revision - 1 }, operationId: uuidv7() }
    const noStop = { ...legal, basis: 'verified_none' as const, evidenceId: null,
      stopEvidence: 'stopped_confirmed:' + effect.nodeRunId + ':1', operationId: uuidv7() }
    const rejected = [weak, outdated, noStop].map(input => resultOf(() => settle(input)))
    const stillPending = sample()
    checkpoint(db, directory, 'rejected.db')
    const applied = settle(legal)
    const replay = settle(legal)
    fixture.scan()
    const after = sample()
    const intactChain = withTx(db, tx => chainBreakOf(TEST_SECRET, readChain(tx, effect.nodeRunId)))

    const matchExecution = `SELECT t.execution_id FROM tool_executions t
      JOIN node_run_events e ON e.node_run_id=t.node_run_id AND e.type='tool_finished'
        AND json_extract(e.payload,'$.execution_id')=t.execution_id AND json_extract(e.payload,'$.attempt')=t.attempt
        AND json_extract(e.payload,'$.tool_seq')=t.tool_seq AND json_extract(e.payload,'$.tool')=t.tool
        AND json_extract(e.payload,'$.exit_code')=t.exit_code AND json_extract(e.payload,'$.stdout_hash')=t.stdout_hash
        AND json_extract(e.payload,'$.stderr_hash')=t.stderr_hash AND json_extract(e.payload,'$.command_hash')=t.command_hash
        AND json_extract(e.payload,'$.finished_at')=t.finished_at
      WHERE t.execution_id=? AND t.node_run_id=? AND t.attempt=1 AND t.exit_code=0
        AND json_extract(e.payload,'$.effect_proof.node_run_id')=t.node_run_id
        AND json_extract(e.payload,'$.effect_proof.attempt')=t.attempt
        AND json_extract(e.payload,'$.effect_proof.run_id')=?
        AND json_extract(e.payload,'$.effect_proof.workflow_definition_hash')=?
        AND json_extract(e.payload,'$.effect_proof.verdict')='applied'`
    const event = "SELECT * FROM events WHERE run_id=? AND node_run_id=? AND type='effect.resolved' AND json_extract(payload_redacted,'$.evidence_id')=?"
    const nodeEvent = NODE_EVENT.replace(' ORDER BY seq', " AND json_extract(payload,'$.evidence_id')=? ORDER BY seq")
    const inbox = 'SELECT * FROM inbox WHERE operation_id IN (?, ?, ?)'
    return {
      params: { phase: 'S6', host: 'trusted local side-effect simulator; worker channel closed before receipt', verifier: verifier.id },
      sampleIds: { effect_node_run_id: effect.nodeRunId, effect_run_id: effect.runId, pure_node_run_id: pure.nodeRunId,
        evidence_id: evidenceId, call_id: pureTool.request.callId, reference, operation_id: legal.operationId },
      boundary: { reached: true, host_committed: true, completion_response: lost, verifier_timing: 'after receipt loss, before lease expiry' },
      snapshots: { before, breakpoint: { ...breakpoint, leaseLost, pending }, after },
      artifacts: ['before.db', 'breakpoint.db', 'lease-lost.db', 'pending.db', 'rejected.db', DATABASE, HOST_DATABASE],
      queries: {
        half_rows: query(DATABASE, `SELECT u.node_run_id FROM unverified_resolutions u
          WHERE (SELECT count(*) FROM node_run_events n WHERE n.node_run_id=u.node_run_id AND n.type='effect.resolved')<>1
          OR (SELECT count(*) FROM events e WHERE e.run_id=u.run_id AND e.node_run_id=u.node_run_id AND e.type='effect.resolved')<>1`, 0),
        orphan_runs: query(DATABASE, ORPHAN_REFERENCES_SQL, 0),
        missing_events: missingPrefix(DATABASE, reportAtFault),
      },
      extraQueries: {
        independent_host_commit: query(HOST_DATABASE, HOST_QUERY, 1, reference),
        pure_completed_outbox: query(DATABASE, OUTBOX + " AND status='completed'", 1, ...pureTool.scope),
        pure_tool_executions: query(DATABASE, EXECUTION, 1, pure.nodeRunId),
        missing_action_receipt: query('breakpoint.db', EXECUTION, 0, effect.nodeRunId),
        no_effect_terminal_at_loss: query('breakpoint.db', RUN_TERMINAL, 0, effect.runId),
        no_effect_terminal_while_pending: query('pending.db', RUN_TERMINAL, 0, effect.runId),
        final_verification_only: query(DATABASE, EXECUTION, 1, effect.nodeRunId),
        expired_fence: query('lease-lost.db', NODE + " AND status='startup_unknown' AND lease_id IS NULL AND action_generation=?",
          1, effect.nodeRunId, effect.lease.action_generation),
        observed_uncertainty: query('pending.db', NODE + " AND status='indeterminate_side_effect' AND side_effect_verified_none=0 AND stop_evidence IS NULL",
          1, effect.nodeRunId),
        evidence_scope: query(DATABASE, matchExecution, 1, evidenceId, effect.nodeRunId, effect.runId, effect.workflowHash),
        pending_unverified: query('pending.db', UNVERIFIED, 1, effect.nodeRunId),
        rejected_unverified: query('rejected.db', UNVERIFIED, 1, effect.nodeRunId),
        rejected_no_receipts: query('rejected.db', inbox, 0, weak.operationId, outdated.operationId, noStop.operationId),
        rejected_no_resolutions: query('rejected.db', RESOLUTION, 0, effect.nodeRunId),
        settled_resolution: query(DATABASE, RESOLUTION + " AND evidence_id=? AND resolution_basis='evidence'", 1, effect.nodeRunId, evidenceId),
        settled_node_event: query(DATABASE, nodeEvent, 1, effect.nodeRunId, 'effect.resolved', evidenceId),
        settled_run_event: query(DATABASE, event, 1, effect.runId, effect.nodeRunId, evidenceId),
        settled_unverified: query(DATABASE, UNVERIFIED, 0, effect.nodeRunId),
        single_attempt: query(DATABASE, 'SELECT * FROM node_runs WHERE run_id=?', 1, effect.runId),
      },
      checks: {
        pure_result_replayed: {
          actual: [pureCalls, pureReplay, pureDeliveries.map(item => item.outcome), pureDeliveries[1]?.params],
          expected: [1, pureResult, ['connection_closed_before_delivery', 'delivered'], pureDeliveries[0]?.params],
        },
        verified_after_loss: { actual: [breakpoint.host.length, breakpoint.effect.toolExecutions.length, leaseLost.effect.node?.status,
          pending.effect.node?.status, pending.unverified, visible.item.evidence.map(row => row.evidence_id),
          expired.lease_expired, recovered.startup_unknown_expired, intactChain],
        expected: [1, 0, 'startup_unknown', 'indeterminate_side_effect', [effect.nodeRunId], [evidenceId], [effect.nodeRunId], [effect.nodeRunId], null] },
        rejected_no_effect: { actual: [rejected.map(result => result.code), stillPending],
          expected: [['VERIFICATION_TOO_WEAK', 'STALE_GENERATION', 'RESOLUTION_NOT_AVAILABLE'], pending] },
        original_replay: { actual: replay, expected: { ...applied, replayed: true } },
        applied_once: { actual: [applied.replayed, applied.resolution_basis, applied.evidence_id, after.unverified,
          after.host.length, after.effect.resolutions.length], expected: [false, 'evidence', evidenceId, [], 1, 1] },
      },
      extra: { pureDeliveries, expired, recovered, rejected, applied, replay, confirmed_stop_fact: null },
    }
  } finally {
    host.raw.close()
    db.raw.close()
    sealCheckpoint(hostFile)
    sealCheckpoint(fixture.file)
  }
}
