import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import { canonicalJson, sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { appendEvent, appendNodeRunEvent, type EventInput } from '../../src/infra/db/ledger.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { escalateDecisions, openDecision, resolveDecision } from '../../src/service/commands/decisions.ts'
import { bindRunVersion } from '../fixtures/ledger.ts'

it.each(['done', 'failed', 'weak', 'keep-retry', 'keep-stop', 'untrusted-original'] as const)('WF-52 / F8 生产报告登记、人工审批与原子结算：%s', async (scenario) => {
  const dir = mkdtempSync(join(tmpdir(), 'wf52-report-review-'))
  const secret = 'test-wf52-service-secret'
  const operator = 'test:operator'
  const reportId = 'report-wf52'
  const nodeId = 'node-wf52'
  const executionId = 'execution-wf52'
  const product = { internal: 'PRIVATE_DIAGNOSTIC_TEXT' }
  const cmd = 'a'.repeat(64)
  const hash = 'b'.repeat(64)
  const exitCode = scenario === 'failed' ? 17 : 0
  const terminal = scenario === 'failed' ? 'failed' : 'done'
  const keepOriginal = scenario === 'keep-retry' || scenario === 'keep-stop'
  let eventDb: Db
  const opts = {
    dbFile: join(dir, 'orchestra.db'), phase: 'S6' as const, secret,
    resolveHttpHuman: (req: import('node:http').IncomingMessage) => req.headers.authorization === 'Bearer wf52-human'
      ? { id: operator } : null,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: (event: unknown) => withTx(eventDb, tx => appendEvent(tx, event as EventInput)),
  }
  let service = await serveOrchestra(opts)
  try {
    const response = (route: string, body?: object, human = true) => fetch(service.endpoint + route, {
      headers: { 'x-orchestra-secret': secret, 'content-type': 'application/json',
        ...(human ? { authorization: 'Bearer wf52-human' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    })
    const now = new Date().toISOString()
    const expiredLease = new Date(Date.parse(now) - 60_000).toISOString()
    const { db, catalog } = service.orchestra
    eventDb = db
    catalog.load({ workflow_version: '1', nodes: [{ node_id: 'check', type: 'agent' }],
      pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }], required_hashes: ['artifact'] })
    withTx(db, (tx) => {
      tx.run("INSERT INTO tasks(task_id,title,status,revision,created_at,updated_at) VALUES('t1','回报核对','running',1,?,?)", [now, now])
      tx.run("INSERT INTO runs(run_id,task_id,status,revision,created_at,updated_at) VALUES('r1','t1','running',1,?,?)", [now, now])
      tx.run("INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,revision,attempt,action_generation,"
        + "side_effect_policy,lease_expires_at,created_at,updated_at) VALUES (?,'r1','check',1,'agent','startup_unknown',8,2,7,?,?,?,?)",
      [nodeId, scenario === 'done' ? 'compensable' : scenario === 'keep-stop' ? 'irreversible' : 'pure', expiredLease, now, now])
      openDecision(tx, { decisionId: 'prior', kind: 'startup_unknown', runId: 'r1', nodeRunId: nodeId,
        approver: 'human', createdAt: now })
      if (scenario !== 'untrusted-original') {
        resolveDecision(tx, secret, { decisionId: 'prior', revision: 1, resolution: 'confirm_not_started', now,
          actor: { kind: 'human', id: operator } })
      }
      if (keepOriginal) {
        // Model a historical D1 that already recorded and closed its finding.
        tx.run("UPDATE decisions SET status='resolved',closed_reason='approved',decided_at=? WHERE decision_id='prior'", [now])
      }
      tx.run("INSERT INTO tool_executions (node_run_id,attempt,tool_seq,tool,execution_id,exit_code,stdout_hash,command_hash,started_at,finished_at)"
        + " VALUES (?,2,1,'ro.check',?,?,?,?,?,?)", [nodeId, executionId, exitCode, hash, cmd, now, now])
      appendNodeRunEvent(tx, secret, nodeId, 'tool_finished', {
        attempt: 2, tool_seq: 1, tool: 'ro.check', execution_id: executionId, exit_code: exitCode, stdout_hash: hash,
        command_hash: cmd, finished_at: now,
        ...(scenario === 'done' && { effect_proof: {
          verdict: 'applied', workflow_definition_hash: catalog.definitionHash('default', 1), node_id: 'check',
          node_run_id: nodeId, run_id: 'r1', attempt: 2, verifier_id: 'test:verifier', reference_hash: hash,
        } }),
      })
    })
    bindRunVersion(db, catalog)
    const report = {
      report_id: reportId, node_run_id: nodeId, attempt: 2, status: terminal,
      evidence: { source: scenario === 'weak' ? 'tool_result' : 'run_tool', exitCode, stdoutHash: hash, commandHash: cmd,
        tool: 'ro.check', producedAt: now, hashes: { artifact: sha256Hex(canonicalJson(product)) } },
      output: { artifact: product, diagnostics: product.internal, evidence_trace: [
        { executionId, toolSeq: 1, tool: 'ro.check', exitCode, stdoutHash: hash, commandHash: cmd },
      ] },
    }
    const submission = { nodeRunId: nodeId, attempt: 2, generation: 7, expectedStatus: 'verifying', report }
    if (scenario === 'untrusted-original') {
      const raw = await response('/v1/ledger/events', {
        type: 'decision.resolved', decisionId: 'prior', runId: 'r1', nodeRunId: nodeId,
        payload: { actorKind: 'human', resolvedBy: operator, revision: 1, attempt: 2, action_generation: 7, resolution: 'confirm_not_started' },
      }, false)
      expect(raw.status).toBe(200)
      expect(await (await response('/v1/node-runs/report', submission, false)).json())
        .toMatchObject({ data: { reason: 'status_mismatch' } })
      expect(db.raw.prepare("SELECT decision_id FROM decisions WHERE kind='report_contradicted'").get()).toBeUndefined()
      return
    }
    const received = await response('/v1/node-runs/report', submission, false)
    expect(await received.json()).toMatchObject({ data: { reason: 'report_contradicted', registry_state: 'rejected' } })
    const stored = db.raw.prepare("SELECT payload FROM node_run_events WHERE type='report.contradicted'").get()?.payload
    expect(JSON.parse(String(stored))).toMatchObject({ report_id: reportId, original_decision_id: 'prior',
      report_digest: sha256Hex(canonicalJson(report)), attempt: 2, action_generation: 7 })
    expect(String(stored)).not.toContain(product.internal)
    const decisionId = String(db.raw.prepare("SELECT contradiction_decision_id FROM node_runs WHERE node_run_id=?").get(nodeId)?.contradiction_decision_id)
    withTx(db, (tx) => {
      escalateDecisions(tx, secret, { now: new Date(Date.parse(now) + 86_400_100).toISOString() })
      tx.run('UPDATE decisions SET confirm_required=1 WHERE decision_id=?', [decisionId])
    })
    await service.close()
    service = await serveOrchestra(opts)
    const reloaded = service.orchestra.db
    const decision = () => reloaded.raw.prepare('SELECT status,revision,closed_reason,resolved_by FROM decisions WHERE decision_id=?').get(decisionId)
    const node = () => reloaded.raw.prepare('SELECT * FROM node_runs WHERE node_run_id=?').get(nodeId)
    const before = node()
    const prior = reloaded.raw.prepare('SELECT * FROM decisions WHERE decision_id=?').get('prior')
    const view = await (await response('/v1/decisions?inbox=human')).json()
    expect(view.data.items).toContainEqual(expect.objectContaining({ decision_id: decisionId, status: 'blocked_for_human',
      current_revision: 2, allowed_resolutions: keepOriginal ? ['uphold_report', 'uphold_decision'] : ['uphold_report'],
      payload: expect.objectContaining({ report_id: reportId, report_status: terminal, report_attempt: 2, report_generation: 7 }),
    }))
    expect(JSON.stringify(view)).not.toContain(product.internal)
    const request = { decisionId, revision: 2, resolution: keepOriginal ? 'uphold_decision' : 'uphold_report', operation_id: uuidv7(),
      contentHash: sha256Hex(canonicalJson(report)) }
    const approve = (patch: object = {}, human = true) => response('/v1/decisions/resolve', { ...request, ...patch }, human)
    expect((await approve({ actor: { kind: 'human', id: operator } }, false)).status).toBe(403)
    expect(await (await response('/v1/node-runs/report', { ...submission, decision: request }, false)).json())
      .toMatchObject({ error: { code: 'FORBIDDEN' } })
    const replacement = { ...report, output: { ...report.output, diagnostics: 'replaced' } }
    expect(await (await response('/v1/node-runs/report', { ...submission, report: replacement }, false)).json())
      .toMatchObject({ error: { code: 'STALE_HANG' } })
    expect(await (await approve({ revision: 1 })).json()).toMatchObject({ error: { code: 'DECISION_REVISION_CONFLICT' } })
    expect(await (await approve({ contentHash: '0'.repeat(64) })).json())
      .toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    expect(await (await approve({ payload: { report: replacement } })).json()).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    if (scenario === 'weak') {
      expect(await (await approve()).json()).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
      expect(decision()).toMatchObject({ status: 'blocked_for_human', revision: 2, closed_reason: null })
      expect(node()).toEqual(before)
      expect(reloaded.raw.prepare('SELECT 1 FROM inbox WHERE operation_id=?').get(request.operation_id)).toBeUndefined()
      return
    }
    const generationColumn = keepOriginal ? 'rearm_generation' : 'action_generation'
    const startingGeneration = keepOriginal ? 0 : 7
    if (keepOriginal) {
      reloaded.raw.prepare("UPDATE decisions SET closed_reason='rejected' WHERE decision_id='prior'").run()
      expect(await (await response('/v1/decisions/get?decision_id=' + decisionId)).json())
        .toMatchObject({ data: { allowed_resolutions: ['uphold_report'] } })
      expect(await (await approve()).json()).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
      expect(node()).toEqual(before)
      reloaded.raw.prepare("UPDATE decisions SET closed_reason='approved' WHERE decision_id='prior'").run()
    }
    reloaded.raw.prepare('UPDATE node_runs SET ' + generationColumn + '=? WHERE node_run_id=?').run(startingGeneration + 1, nodeId)
    expect(await (await approve()).json()).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    reloaded.raw.prepare('UPDATE node_runs SET ' + generationColumn + '=? WHERE node_run_id=?').run(startingGeneration, nodeId)
    const preflight = await (await approve()).json()
    expect(preflight).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED', details: { confirm_challenge: expect.any(String) } } })
    const confirm = { confirm_challenge: preflight.error.details.confirm_challenge, actor: { kind: 'agent', id: 'fake' } }
    expect(node()).toEqual(before)
    if (scenario === 'done') {
      reloaded.raw.exec("CREATE TRIGGER wf52_test_failure BEFORE UPDATE OF status ON node_runs WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'test failure'); END")
      expect((await approve(confirm)).status).toBe(503)
      expect(decision()).toMatchObject({ status: 'blocked_for_human', revision: 2, closed_reason: null, resolved_by: null })
      expect(node()).toEqual(before)
      expect(reloaded.raw.prepare('SELECT 1 FROM inbox WHERE operation_id=?').get(request.operation_id)).toBeUndefined()
      reloaded.raw.exec('DROP TRIGGER wf52_test_failure')
    }
    expect(await (await approve(confirm)).json()).toMatchObject({ data: { decisionId, revision: 3, replayed: false } })
    expect(await (await approve(confirm)).json()).toMatchObject({ data: { decisionId, revision: 3, replayed: true } })
    expect(decision()).toMatchObject({ status: 'resolved', revision: 3, closed_reason: keepOriginal ? 'rejected' : 'approved', resolved_by: operator })
    const settledStatus = scenario === 'keep-retry' ? 'superseded' : scenario === 'keep-stop' ? 'failed' : terminal
    expect(node()).toMatchObject({ status: settledStatus, action_generation: 7, rearm_generation: 0, attempt: 2, hang_reason: null,
      contradiction_decision_id: null, startup_unknown_deadline_at: null })
    expect(reloaded.raw.prepare('SELECT * FROM decisions WHERE decision_id=?').get('prior')).toEqual(prior)
    if (keepOriginal) {
      const replacements = reloaded.raw.prepare('SELECT node_run_id,attempt,status,action_generation FROM node_runs WHERE origin_node_run_id=?').all(nodeId)
      if (scenario === 'keep-retry') {
        expect(replacements).toEqual([{ node_run_id: node()?.replacement_node_run_id, attempt: 3, status: 'queued', action_generation: 7 }])
      } else {
        expect(replacements).toEqual([])
        expect(node()?.side_effect_verified_none).toBe(0)
        expect(reloaded.raw.prepare('SELECT 1 FROM unverified_resolutions WHERE node_run_id=?').get(nodeId)).toBeUndefined()
      }
      expect(reloaded.raw.prepare("SELECT 1 FROM node_run_events WHERE type='report_applied'").get()).toBeUndefined()
      const stale = reloaded.raw.prepare("SELECT payload FROM node_run_events WHERE type='report.stale'").all()
      expect(stale).toHaveLength(1)
      expect(JSON.parse(String(stale[0]?.payload))).toMatchObject({
        reason: 'uphold_decision', decision_id: decisionId, original_decision_id: 'prior', original_decision_revision: 2,
        report_id: reportId, report_digest: request.contentHash, next_status: settledStatus,
      })
      const commandAudit = reloaded.raw.prepare("SELECT payload_redacted FROM events WHERE type='decision.command_audited' AND decision_id=?").all(decisionId)
      expect(commandAudit).toHaveLength(1)
      expect(JSON.parse(String(commandAudit[0]?.payload_redacted))).toMatchObject({ actor_id: operator,
        operation_id: request.operation_id, resolution: 'uphold_decision' })
      expect(await (await response('/v1/node-runs/report', submission, false)).json()).toMatchObject({ data: { registry_state: 'stale' } })
      return
    }
    const applied = reloaded.raw.prepare("SELECT payload FROM node_run_events WHERE type='report_applied'").all()
    expect(applied).toHaveLength(1)
    expect(JSON.parse(String(applied[0]?.payload))).toMatchObject({ report_id: reportId, next_status: terminal,
      execution_id: executionId, evidence_digest: expect.any(String) })
    const audit = reloaded.raw.prepare("SELECT payload_redacted FROM events WHERE type='decision.command_audited' AND decision_id=?").get(decisionId)
    expect(JSON.parse(String(audit?.payload_redacted))).toMatchObject({ actor_id: operator, operation_id: request.operation_id,
      evidence_ids: [executionId], resolution: 'uphold_report' })
    if (scenario === 'done') {
      expect(reloaded.raw.prepare('SELECT resolution_basis,evidence_id,decision_id FROM unverified_resolutions WHERE node_run_id=?').get(nodeId))
        .toEqual({ resolution_basis: 'evidence', evidence_id: executionId, decision_id: null })
    }
    expect(reloaded.raw.prepare('SELECT state FROM report_registry WHERE report_id=?').get(reportId)).toEqual({ state: 'applied' })
  } finally {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
