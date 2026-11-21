import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { EvidenceCollector } from '../../src/executor/evidence-collector.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { serveOrchestra, sweepNow } from '../../src/index.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { recordOrdinaryHostStop } from '../../src/service/decision/ordinary-recovery.ts'
import { publishRecoveryWorkflow, recoveryWorkflowDoc, recoveryWorkflowId } from '../fixtures/recovery-workflow.ts'

it.each(['authorized', 'legacy', 'denied', 'parallel', 'conflicted', 'irreversible', 'upstream-rework'] as const)(
  'settles verified non-application against the run-pinned retry policy (%s)', async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestra-recovery-retry-'))
    const secret = 'ordinary-recovery-retry'
    const options = { dbFile: join(directory, 'service.db'), secret, phase: 'S6' as const,
      resolveHttpHuman: (req: import('node:http').IncomingMessage) => req.headers.authorization === 'Bearer operator' ? { id: 'fixture:operator' } : null,
      asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    }
    let service = await serveOrchestra(options)
    const db = () => service.orchestra.db
    const request = async (path: string, body?: object) => (await fetch(service.endpoint + path, {
      headers: { authorization: 'Bearer operator', 'x-orchestra-secret': secret, 'content-type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    })).json()
    const role = 'receipt'
    try {
      const doc = recoveryWorkflowDoc(role, mode === 'legacy' ? undefined : mode !== 'denied')
      if (mode === 'parallel') {
        doc.nodes.push({ node_id: 'group', type: 'parallel', title: '并行', position: { x: 320, y: 0 }, config: { join: 'all' } })
        doc.edges = [{ from: 'trigger', to: 'group' }, { from: 'group', to: role }]
        doc.nodes.push({ node_id: 'other', type: 'agent', title: '第二个步骤', position: { x: 320, y: 180 } })
        doc.edges.push({ from: 'group', to: 'other' })
      }
      if (mode === 'upstream-rework') {
        doc.nodes.push({ node_id: 'upstream', type: 'agent', title: '前置步骤', position: { x: 100, y: 0 },
          config: { side_effect_policy: 'pure' } })
        doc.edges = [{ from: 'trigger', to: 'upstream' }, { from: 'upstream', to: role }]
      }
      const workflowHash = await publishRecoveryWorkflow(request, doc)
      const started = await request('/v1/runs/start', {
        operationId: uuidv7(), taskTitle: '核对业务效果', workflowId: recoveryWorkflowId, workflowVersion: '1',
      })
      expect(started).toMatchObject({ ok: true, data: { workflow_version: '1' } })
      const runId = started.data.run_id
      const at = new Date().toISOString()
      const nodes = () => db().raw.prepare(`SELECT node_run_id,node_id,status,attempt,action_generation,lease_id,
        replacement_node_run_id,origin_node_run_id FROM node_runs WHERE run_id=? AND node_id=? ORDER BY attempt`).all(runId, role)
      const origin = String(nodes()[0]!.node_run_id)
      const upstream = mode === 'upstream-rework' ? String(db().raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='upstream'")
        .get(runId)!.node_run_id) : undefined
      if (upstream) withTx(db(), tx => {
        tx.run("UPDATE node_runs SET status='done' WHERE node_run_id=?", [upstream])
        appendNodeRunEvent(tx, secret, upstream, 'status_changed', { from: 'started', to: 'done' })
      })
      if (mode === 'authorized' || mode === 'legacy') {
        const latestHash = await publishRecoveryWorkflow(request, recoveryWorkflowDoc(role, mode === 'legacy'), 1)
        expect(workflowHash).not.toBe(latestHash)
        expect(db().raw.prepare('SELECT workflow_definition_hash FROM runs WHERE run_id=?').get(runId))
          .toEqual({ workflow_definition_hash: workflowHash })
      }
      if (mode !== 'parallel') {
        expect(await request('/v1/node-runs/lease', { nodeRunId: origin, ownerEpoch: db().epoch, leaseTtlMs: 30_000 }))
          .toMatchObject({ ok: true })
      }
      const agentId = 'effect-agent'
      const attempt = 1
      const generation = 1
      const hostStop = (actionGeneration: number) => withTx(db(), tx => recordOrdinaryHostStop(tx, secret, {
        nodeRunId: origin, attempt, generation: actionGeneration, agentId, stoppedAt: at,
      }))
      withTx(db(), tx => tx.run("UPDATE node_runs SET status='started',side_effect_policy=?,executor_agent_id=?,action_generation=? WHERE node_run_id=?",
        [mode === 'irreversible' ? 'irreversible' : 'compensable', agentId, generation, origin]))
      const registry = new ToolRegistry()
      registry.register({ name: 'read-receipt', capability: 'read_only', command: { bin: 'receipt-check', args: [] },
        effectVerifier: { id: 'receipt/v1', workflowDefinitionHash: workflowHash, nodeId: role,
          verify: (target, { stdout }) => stdout === `${target.node_run_id}/${target.attempt}`
            ? { verdict: 'not_applied', reference: stdout } : null } })
      const runner = new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true,
        run: async () => ({ exitCode: 0, stdout: `${origin}/${attempt}`, stderr: '' }) }, '.')
      const collector = new EvidenceCollector({ db: db(), secret, registry, runner, policy: { allow: ['read-receipt'] },
        allowedTools: ['read-receipt'], nodeRunId: origin, attempt, executorAgentId: agentId, nowAt: () => at })
      const evidence = await collector.collect({ callId: 'read', tool: 'read-receipt', args: [], cwd: '.', timeoutMs: 100 })
      const evidenceId = evidence.trace!.executionId
      withTx(db(), tx => tx.run("UPDATE node_runs SET status='indeterminate_side_effect' WHERE node_run_id=?", [origin]))
      sweepNow(service.orchestra.runtime, at)
      const decision = db().raw.prepare("SELECT decision_id,revision FROM decisions WHERE node_run_id=? AND kind='verify_human'")
        .get(origin) as { decision_id: string; revision: number }
      const command = { decisionId: decision.decision_id, revision: decision.revision, operation_id: uuidv7(),
        resolution: 'confirm_not_applied', payload: { evidence_ids: [evidenceId] } }
      const submit = (body = command) => request('/v1/decisions/resolve', body)
      hostStop(generation - 1)
      expect(await submit()).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
      hostStop(generation)
      expect(await submit({ ...command, payload: { evidence_ids: ['tex_wrong'] } }))
        .toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
      if (mode === 'conflicted') {
        withTx(db(), tx => tx.run("UPDATE node_runs SET hang_reason='report_contradicted' WHERE node_run_id=?", [origin]))
      }
      if (upstream) withTx(db(), tx => {
        tx.run("INSERT INTO artifacts(artifact_id,run_id,uri,sha256,created_at) VALUES('source',?,'result.txt','hash',?)", [runId, at])
        tx.run(`INSERT INTO rework_requests(request_id,run_id,requester_actor,owner_actor,target_node_run_id,target_attempt,
          source_artifact_id,source_artifact_hash,reason,expected_result,preserve_requirements_json,suggested_scope,status,evidence_ids_json,expires_at,created_at,updated_at)
          VALUES('open-upstream',?,'human','owner',?,1,'source','hash','更正','修正结果','[]','targeted_revision','proposed','[]','2099-01-01',?,?)`,
        [runId, upstream, at, at])
      })
      if (mode === 'parallel' || mode === 'conflicted' || mode === 'upstream-rework') {
        expect((await request('/v1/decisions/get?decision_id=' + decision.decision_id)).data.allowed_resolutions).not.toContain('confirm_not_applied')
        expect(await submit()).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
        expect(nodes()).toMatchObject([{ status: 'indeterminate_side_effect', attempt, action_generation: generation,
          replacement_node_run_id: null }])
        expect(db().raw.prepare('SELECT status,revision FROM decisions WHERE decision_id=?').get(decision.decision_id))
          .toMatchObject({ status: 'pending', revision: decision.revision })
        expect(db().raw.prepare('SELECT * FROM unverified_resolutions').get()).toBeUndefined()
        return
      }
      await service.close()
      service = await serveOrchestra(options)
      expect(await submit()).toMatchObject({ data: { replayed: false, revision: 2 } })
      expect(db().raw.prepare('SELECT resolution_basis FROM unverified_resolutions WHERE node_run_id=?').get(origin))
        .toEqual({ resolution_basis: 'verified_none' })
      if (mode !== 'authorized') {
        expect(nodes()).toMatchObject([{ status: 'failed', attempt, action_generation: generation, replacement_node_run_id: null }])
        return
      }
      const replacement = String(nodes()[1]!.node_run_id)
      expect(nodes()).toMatchObject([
        { status: 'superseded', attempt, action_generation: generation, lease_id: null, replacement_node_run_id: replacement },
        { status: 'queued', attempt: attempt + 1, action_generation: generation, lease_id: null, origin_node_run_id: origin },
      ])
      expect(db().raw.prepare('SELECT status FROM runs WHERE run_id=?').get(runId)).toEqual({ status: 'running' })
      expect(await submit()).toMatchObject({ data: { replayed: true, revision: 2 } })
      expect(await submit({ ...command, operation_id: uuidv7() })).toMatchObject({ error: { code: 'DECISION_REVISION_CONFLICT' } })
      expect(db().raw.prepare("SELECT count(*) AS n FROM node_run_events WHERE type='decision.retry_scheduled'").get())
        .toEqual({ n: 1 })
      expect(await request('/v1/node-runs/report', { nodeRunId: origin, attempt, generation,
        expectedStatus: 'indeterminate_side_effect', report: { report_id: 'late-negative', node_run_id: origin, status: 'failed', attempt },
      })).toMatchObject({ data: { accepted: false, reason: 'status_mismatch' } })
      expect(await request('/v1/node-runs/lease', { nodeRunId: replacement, ownerEpoch: db().epoch, leaseTtlMs: 30_000 }))
        .toMatchObject({ data: { action_generation: generation + 1 } })
      expect(await submit()).toMatchObject({ data: { replayed: true } })
      expect(nodes()).toMatchObject([
        { status: 'superseded', attempt, action_generation: generation, replacement_node_run_id: replacement },
        { status: 'dispatched', attempt: attempt + 1, action_generation: generation + 1, origin_node_run_id: origin },
      ])
    } finally {
      await service.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
