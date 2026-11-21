import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import { canonicalJson, sha256Hex } from '../../src/core/canonical.ts'
import { appendNodeRunEvent, chainIsIntact, readChain, readChainHead } from '../../src/infra/db/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { sweep } from '../../src/service/sweep.ts'
import type { RunTerminal } from '../../src/service/commands/run-close.ts'

type Case = {
  name: string
  report?: 'done' | 'failed' | 'timeout'
  action?: 'orphan' | 'cancel'
  irreversible?: boolean
  verifiedEffect?: boolean
  terminal: RunTerminal
  node: string
}

const cases: readonly Case[] = [
  { name: 'verified-done', report: 'done', irreversible: true, verifiedEffect: true, terminal: 'succeeded', node: 'done' },
  { name: 'unknown-done', report: 'done', irreversible: true, terminal: 'succeeded_with_unverified', node: 'done' },
  { name: 'pure-failure', report: 'failed', terminal: 'failed', node: 'failed' },
  { name: 'unknown-failure', report: 'failed', irreversible: true, terminal: 'failed_with_unverified', node: 'failed' },
  { name: 'unknown-timeout', report: 'timeout', irreversible: true, terminal: 'failed_with_unverified', node: 'timeout' },
  { name: 'executor-lost', action: 'orphan', terminal: 'orphaned', node: 'orphaned' },
  { name: 'operator-cancel', action: 'cancel', terminal: 'cancelled', node: 'superseded' },
]

it.each(cases)('I4 $name emits the matching terminal evidence and separates unresolved effects', async (item) => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-i4-terminal-'))
  const secret = 'i4-fixture-service-key'
  const service = await serveOrchestra({
    dbFile: join(dir, 'ledger.db'), phase: 'S6', secret,
    resolveHttpHuman: req => req.headers.authorization === 'Bearer i4-operator' ? { id: 'fixture:reviewer' } : null,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
  })
  try {
    const { db, catalog, runtime } = service.orchestra
    const runId = 'run'
    const nodeRunId = 'node'
    const now = new Date().toISOString()
    const heartbeat = new Date(Date.parse(now) - 1_000).toISOString()
    const deadline = new Date(Date.parse(now) - 20).toISOString()
    const terminalRun = () => db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(runId)?.status
    const nodeRow = () => db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id=?').get(nodeRunId)
    const terminalEvents = () => db.raw.prepare("SELECT payload_redacted FROM events WHERE run_id=? AND type='run.terminal'").all(runId)
    const nodeEvents = (type: string) => db.raw.prepare('SELECT payload FROM node_run_events WHERE node_run_id=? AND type=?').all(nodeRunId, type)
      .map(row => JSON.parse(String(row.payload)))
    const post = async (path: string, body: object) => {
      const response = await fetch(service.endpoint + path, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orchestra-secret': secret, authorization: 'Bearer i4-operator' },
        body: JSON.stringify(body) })
      const value = await response.json()
      expect(response.status, JSON.stringify(value)).toBe(200)
      return value.data
    }
    const policy = item.irreversible ? 'irreversible' : 'pure'
    catalog.load({ workflow_version: '1', required_hashes: ['artifact'],
      nodes: [{ node_id: 'step', type: 'agent', side_effect_policy: policy }] })
    const versionHash = catalog.definitionHash('default', '1')
    const initial = item.report === 'timeout' ? 'timing_out' : item.action === 'cancel' ? 'queued'
      : item.action === 'orphan' ? 'started' : 'verifying'
    withTx(db, tx => {
      tx.run("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES ('task','I4','running',?,?)", [now, now])
      tx.run("INSERT INTO runs (run_id,task_id,workflow_id,workflow_version,workflow_definition_hash,status,created_at,updated_at)"
        + " VALUES (?,'task','default',1,?,'running',?,?)", [runId, versionHash, now, now])
      tx.run("INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,attempt,action_generation,side_effect_policy,"
        + " heartbeat_at,executor_agent_id,executor_session_id,created_at,updated_at) VALUES (?,?,'step',1,'agent',?,1,1,?,?,?,?,?,?)",
      [nodeRunId, runId, initial, policy, item.action === 'cancel' ? null : heartbeat,
        item.action === 'cancel' ? null : 'fixture-executor', item.action === 'cancel' ? null : 'fixture-session', now, now])
      if (item.report === 'timeout') {
        tx.run("UPDATE node_runs SET deadline_at=?,cancel_result='interrupted',cancel_requested_at=? WHERE node_run_id=?",
          [deadline, now, nodeRunId])
        appendNodeRunEvent(tx, secret, nodeRunId, 'deadline_rearmed', { deadline_at: deadline, rearm_generation: 1 })
        appendNodeRunEvent(tx, secret, nodeRunId, 'fence_armed', { cancel_result: 'interrupted', deadline_at: deadline })
      }
    })

    if (item.report) {
      const executionId = 'tool-execution'
      const commandHash = 'c'.repeat(64)
      const artifact = { result: item.name }
      const bytes = Buffer.from(canonicalJson(artifact))
      const contentHash = sha256Hex(bytes)
      const stdoutHash = sha256Hex('synthetic output ' + item.name)
      const exitCode = item.report === 'done' ? 0 : item.report === 'failed' ? 2 : 124
      withTx(db, tx => {
        tx.run("INSERT INTO tool_executions (node_run_id,attempt,tool_seq,tool,execution_id,exit_code,stdout_hash,command_hash,started_at,finished_at)"
          + " VALUES (?,1,1,'fixture.tool',?,?,?,?,?,?)", [nodeRunId, executionId, exitCode, stdoutHash, commandHash, heartbeat, now])
        appendNodeRunEvent(tx, secret, nodeRunId, 'tool_finished', {
          attempt: 1, tool_seq: 1, tool: 'fixture.tool', execution_id: executionId, exit_code: exitCode,
          stdout_hash: stdoutHash, command_hash: commandHash, finished_at: now,
          ...(item.verifiedEffect && { effect_proof: { verdict: 'applied', workflow_definition_hash: versionHash,
            node_id: 'step', node_run_id: nodeRunId, run_id: runId, attempt: 1, verifier_id: 'fixture-verifier', reference_hash: contentHash } }),
        })
      })
      const managed = registerRunArtifact(db, { artifactId: 'result-artifact', runId, nodeRunId, fileName: 'result.json', bytes }, now)
      expect(managed.sha256).toBe(contentHash)
      const evidence = { source: 'run_tool', tool: 'fixture.tool', exitCode, stdoutHash, commandHash,
        hashes: { artifact: contentHash }, producedAt: now }
      const report = { report_id: 'report-strong', node_run_id: nodeRunId, attempt: 1, status: item.report, evidence,
        output: { artifact, evidence_trace: [{ executionId, tool: 'fixture.tool', toolSeq: 1, stdoutHash, exitCode, commandHash }] } }
      const send = (value: object) => post('/v1/node-runs/report',
        { nodeRunId, attempt: 1, generation: 1, expectedStatus: initial, report: value })
      const negatives = [
        { value: { ...report, report_id: 'report-empty', evidence: undefined }, reason: 'evidence_missing' },
        { value: { ...report, report_id: 'report-weak', evidence: { ...evidence, source: 'tool_result' } }, reason: 'verification_too_weak' },
        { value: { ...report, report_id: 'report-fabricated', evidence: { ...evidence, commandHash: 'f'.repeat(64) } }, reason: 'evidence_unverifiable' },
        ...(item.report === 'done' ? [{ value: { ...report, report_id: 'report-wrong-content',
          output: { ...report.output, artifact: { changed: true } } }, reason: 'verification_too_weak' }] : []),
      ]
      for (const { value, reason } of negatives) {
        expect(await send(value)).toMatchObject({ accepted: false, reason, registry_state: 'rejected' })
        expect(nodeRow()?.status).toBe(initial)
        expect(nodeEvents('report_applied')).toHaveLength(0)
      }
      await post('/v1/runs/dispatch', { runId, nodes: {} })
      expect(terminalRun()).toBe('running')
      expect(terminalEvents()).toHaveLength(0)
      expect(await send(report)).toMatchObject({ accepted: true, next_status: item.report, registry_state: 'applied' })
      expect(nodeEvents('tool_finished')).toMatchObject([{ execution_id: executionId, attempt: 1, exit_code: exitCode }])
      expect(nodeEvents('report_applied')).toMatchObject([{ report_id: report.report_id, next_status: item.report }])
      if (item.verifiedEffect) {
        expect(db.raw.prepare('SELECT resolution_basis,evidence_id FROM unverified_resolutions WHERE node_run_id=?').get(nodeRunId))
          .toEqual({ resolution_basis: 'evidence', evidence_id: executionId })
      }
      if (item.report === 'timeout') {
        expect(nodeRow()).toMatchObject({ heartbeat_at: heartbeat, deadline_at: deadline, cancel_result: 'interrupted' })
        expect(nodeEvents('deadline_rearmed')).toMatchObject([{ deadline_at: deadline }])
      }
    } else if (item.action === 'orphan') {
      const result = sweep(db, secret, { now, clock: runtime.clock, catalog, executorLost: [nodeRunId] })
      expect(result.executor_orphaned).toEqual([nodeRunId])
      expect(nodeEvents('recovery.executor_lost')).toMatchObject([{ from: 'started', to: 'orphaned' }])
      expect(nodeRow()).toMatchObject({ heartbeat_at: heartbeat, executor_agent_id: 'fixture-executor', executor_session_id: 'fixture-session' })
    } else {
      expect(await post('/v1/runs/cancel', { runId, cancelResult: 'interrupted', graceMs: 1000 }))
        .toMatchObject({ terminalStatus: 'cancelled', outcome: 'succeeded' })
    }
    await post('/v1/runs/dispatch', { runId, nodes: {} })
    expect(nodeRow()?.status).toBe(item.node)
    expect(terminalRun()).toBe(item.terminal)
    const record = terminalEvents()
    expect(record).toHaveLength(1)
    expect(JSON.parse(String(record[0]?.payload_redacted))).toMatchObject({
      status: item.terminal, outcome: item.terminal === 'cancelled' ? 'succeeded' : item.terminal,
      failed_nodes: ['failed', 'timeout'].includes(item.node) ? [nodeRunId] : [],
      unverified_nodes: item.terminal.endsWith('_with_unverified') ? [nodeRunId] : [],
      orphaned_nodes: item.node === 'orphaned' ? [nodeRunId] : [],
    })
    expect(withTx(db, tx => chainIsIntact(secret, readChain(tx, nodeRunId), readChainHead(tx, nodeRunId), true))).toBe(true)
    await post('/v1/runs/dispatch', { runId, nodes: {} })
    expect(terminalEvents()).toEqual(record)
  } finally {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
