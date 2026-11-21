import type { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { createDshExecutor } from '../../src/executor/dsh-host.ts'
import type { HostAgentFactory } from '../../src/executor/session.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { serveOrchestra, sweepNow } from '../../src/index.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { bindRunVersion } from '../fixtures/ledger.ts'
import { publishRecoveryWorkflow, recoveryWorkflowDoc, recoveryWorkflowId } from '../fixtures/recovery-workflow.ts'

it.each(['durable', 'retry', 'retry-compensable', 'uncorrelated', 'unsupported', 'cancelled', 'watchdog', 'uncertain-clock'] as const)(
  'accepts only positively retired startup attempts (%s)', async (mode) => {
  const retrying = mode === 'retry' || mode === 'retry-compensable'
  const policy = mode === 'retry' ? 'pure' : 'compensable'
  const directory = mkdtempSync(join(tmpdir(), 'orchestra-startup-'))
  const configPath = join(directory, 'orchestra.config.json')
  const config = JSON.parse(readFileSync('orchestra.config.json', 'utf8'))
  config.execution.startup_timeout_ms = 80
  config.bridge.spill_dir = join(directory, 'spill')
  writeFileSync(configPath, JSON.stringify(config))
  const secret = 'ordinary-unsent-ledger'
  let nodeRunId = 'startup-node'
  let runId = 'run'
  const readyToSpawn = Promise.withResolvers<void>()
  const allowDispose = Promise.withResolvers<void>()
  const disposalStarted = Promise.withResolvers<void>()
  const prompt = vi.fn()
  const route = { ref: 'fixture/model', provider: 'fixture', model: 'model', capacity: 'standard' as const }
  let agentId: string | undefined
  const parent = {
    session: { id: 'fixture-parent', header: { cwd: directory } },
    ctx: { agents: { async create({ sessionId }: { sessionId: string }) {
      await readyToSpawn.promise
      agentId = sessionId
      return {
        agent: { status: 'idle', model: { current: () => route }, followup: prompt,
          session: { id: sessionId, snapshotEvents: () => [] }, whenIdle: async () => {} },
        async dispose() { disposalStarted.resolve(); await allowDispose.promise },
      }
    } } },
  }
  const host = createDshExecutor({
    parentForNode: () => parent as unknown as ReturnType<Parameters<typeof createDshExecutor>[0]['parentForNode']>,
    context: { agents: { get: () => parent }, llm: { listModels: async () => [{ id: 'model' }] } } as unknown as Context,
    models: [route], recommend: () => ({ complexity: 'standard', reason: 'fixture' }),
  })
  const bridge = mode === 'unsupported' ? new BridgeClient({
    async request<T>(method: string) {
      switch (method) {
        case 'executor.cancel': return 'already_stopped' as T
        case 'executor.whenIdle': return { idle: true, timedOut: false } as T
        case 'executor.state': return { state: 'idle', toolCallSeq: 0, hasToolCall: false } as T
        case 'executor.dispose': disposalStarted.resolve(); return undefined as T
        default: throw new Error(method)
      }
    },
    async *listen() {},
  }) : host.bridge
  const agents: HostAgentFactory = { create: params => host.bridge.spawn({ ...params, modelRef: route.ref }) }
  const registry = new ToolRegistry()
  const runner = new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true,
    run: async () => { throw new Error('Unsent attempt cannot invoke a tool') } }, directory)
  const options = { dbFile: join(directory, 'service.db'), configPath, phase: 'S6' as const, secret,
    resolveHttpHuman: (req: import('node:http').IncomingMessage) => req.headers.authorization === 'Bearer operator' ? { id: 'fixture:operator' } : null,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
  }
  let service = await serveOrchestra({ ...options, executor: { bridge, agents, registry, runner } })
  const db = () => service.orchestra.db
  const call = async (path: string, body?: object) => (await fetch(service.endpoint + path, {
    headers: { 'x-orchestra-secret': secret, 'content-type': 'application/json', authorization: 'Bearer operator' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  })).json()
  const row = () => db().raw.prepare('SELECT status, attempt, action_generation, rearm_generation, replacement_node_run_id, '
    + 'startup_unknown_deadline_at FROM node_runs WHERE node_run_id=?').get(nodeRunId)
  const receipt = () => db().raw.prepare("SELECT seq,payload FROM node_run_events WHERE node_run_id=? AND type='recovery.host_retired_unsent_attempt'").get(nodeRunId)
  try {
    const now = new Date().toISOString()
    if (retrying) {
      const definition = recoveryWorkflowDoc('start', true)
      const step = definition.nodes.find(node => node.node_id === 'start')!
      step.config = { ...step.config, side_effect_policy: policy }
      await publishRecoveryWorkflow(call, definition)
      const started = await call('/v1/runs/start', {
        operationId: uuidv7(), taskTitle: 'F8 启动恢复', workflowId: recoveryWorkflowId, workflowVersion: '1',
      })
      expect(started).toMatchObject({ ok: true })
      runId = started.data.run_id
      nodeRunId = String(db().raw.prepare('SELECT node_run_id FROM node_runs WHERE run_id=?').get(runId)!.node_run_id)
    } else {
      withTx(db(), tx => {
        tx.run("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES ('task','F8','running',?,?)", [now, now])
        tx.run("INSERT INTO runs (run_id,task_id,status,created_at,updated_at) VALUES ('run','task','running',?,?)", [now, now])
        tx.run("INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,attempt,created_at,updated_at)"
          + " VALUES (?,'run','start',1,'agent','queued',1,?,?)", [nodeRunId, now, now])
      })
      service.orchestra.commands.loadWorkflow({ workflow_version: '1', pass_conditions: [], nodes: [{ node_id: 'start', type: 'agent' }] })
      bindRunVersion(db(), service.orchestra.catalog, 1, 'run')
    }
    const dispatched = await call('/v1/node-runs/run', { nodeRunId, nodeId: 'start', attempt: 1, tools: [] })
    expect(dispatched).toMatchObject({ error: { code: 'OPERATION_TIMEOUT' } })
    const waiting = row()
    expect(waiting).toMatchObject({ status: 'startup_unknown', attempt: 1, action_generation: 1, rearm_generation: 0 })
    sweepNow(service.orchestra.runtime, new Date().toISOString())
    const decision = db().raw.prepare("SELECT decision_id,revision FROM decisions WHERE kind='startup_unknown' AND node_run_id=?")
      .get(nodeRunId) as { decision_id: string; revision: number }
    const command = { decisionId: decision.decision_id, revision: decision.revision, operation_id: uuidv7(), resolution: 'confirm_not_started' }
    const submit = (body: object = command) => call('/v1/decisions/resolve', body)
    const choices = async () => (await call('/v1/decisions/get?decision_id=' + decision.decision_id)).data.allowed_resolutions
    expect(await choices()).toEqual(['abandon'])
    for (const resolution of ['confirm_started', 'continue_tracking', 'confirm_not_started']) {
      expect(await submit({ ...command, resolution })).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    }
    expect(await call('/v1/node-runs/confirm-start', { nodeRunId, attempt: 1, attested: true }))
      .toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    expect(row()).toEqual(waiting)

    if (mode === 'cancelled') {
      const cancellation = await call('/v1/runs/cancel', { runId: 'run', cancelResult: 'unknown', graceMs: 0 })
      expect(cancellation).toMatchObject({ ok: true })
    }
    if (mode === 'uncertain-clock') {
      withTx(db(), tx => tx.run('UPDATE node_runs SET startup_unknown_remaining_ns=NULL WHERE node_run_id=?', [nodeRunId]))
    }
    if (mode === 'uncorrelated' || mode === 'uncertain-clock') {
      await service.close()
      service = await serveOrchestra(options)
    }
    if (mode === 'uncertain-clock') {
      sweepNow(service.orchestra.runtime, new Date().toISOString())
      const uncertain = await call('/v1/recovery/uncertain')
      expect(uncertain.data.items).toMatchObject([{ node_run_id: nodeRunId, status: 'startup_unknown', channel: 'startup_unknown' }])
      const recover = { nodeRunId, revision: uncertain.data.items[0].revision, resolution: 'mark_indeterminate_side_effect' }
      expect(await call('/v1/recovery/resolve', { ...recover, revision: recover.revision + 1 }))
        .toMatchObject({ error: { code: 'STALE_GENERATION' } })
      const decisionState = () => db().raw.prepare('SELECT status,closed_reason FROM decisions WHERE decision_id=?').get(decision.decision_id)
      expect(decisionState()).toMatchObject({ status: 'pending' })
      expect(await call('/v1/recovery/resolve', recover)).toMatchObject({
        data: { node_run_id: nodeRunId, from: 'startup_unknown', to: 'indeterminate_side_effect', channel: 'startup_unknown' },
      })
      expect(row()).toMatchObject({ status: 'indeterminate_side_effect', attempt: 1, action_generation: 1, rearm_generation: 1,
        startup_unknown_deadline_at: null })
      expect(decisionState()).toEqual({ status: 'resolved', closed_reason: 'cancelled' })
      expect(await call('/v1/recovery/resolve', recover)).toMatchObject({ error: { code: 'STALE_GENERATION' } })
    }
    if (mode === 'watchdog') {
      const sample = service.orchestra.runtime.clock.sample()
      withTx(db(), tx => tx.run('UPDATE node_runs SET startup_unknown_deadline_at=?,startup_unknown_monotonic_ns=? WHERE node_run_id=?',
        [new Date(sample.wallClockMs - 1000).toISOString(), sample.monotonicNs - 1_000_000_000, nodeRunId]))
      sweepNow(service.orchestra.runtime, new Date().toISOString())
      expect(row()).toMatchObject({ status: 'indeterminate_side_effect', startup_unknown_deadline_at: null })
      expect(db().raw.prepare('SELECT status,closed_reason FROM decisions WHERE decision_id=?').get(decision.decision_id))
        .toEqual({ status: 'resolved', closed_reason: 'expired_final' })
    }
    readyToSpawn.resolve()
    await disposalStarted.promise
    if (mode !== 'unsupported') {
      expect(agentId).toBeDefined()
      await expect(host.bridge.send({ executorAgentId: agentId!, attempt: 1, attemptId: nodeRunId + ':1', instruction: 'late' }))
        .rejects.toMatchObject({ code: 'STALE_GENERATION' })
    }
    allowDispose.resolve()
    if (mode === 'durable' || retrying) {
      await vi.waitFor(() => expect(receipt()).toBeDefined())
      expect(await choices()).toEqual(['confirm_not_started', 'abandon'])
      await service.close()
      service = await serveOrchestra(retrying ? { ...options, executor: { bridge, agents, registry, runner } } : options)
      expect(await choices()).toEqual(['confirm_not_started', 'abandon'])
      expect(await submit({ ...command, payload: { stopped_at: now } })).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
      expect(await submit()).toMatchObject({ data: { revision: 2, replayed: false } })
      const nextStatus = retrying ? 'superseded' : 'failed'
      const original = row()!
      expect(original).toEqual({ status: nextStatus, attempt: 1, action_generation: 1, rearm_generation: 0,
        replacement_node_run_id: retrying ? expect.any(String) : null, startup_unknown_deadline_at: null })
      const stopEvidence = `no_tool_started:${nodeRunId}:1:${receipt()!.seq}`
      expect(db().raw.prepare('SELECT side_effect_policy,side_effect_verified_none,stop_evidence FROM node_runs WHERE node_run_id=?').get(nodeRunId))
        .toEqual({ side_effect_policy: policy, side_effect_verified_none: 1, stop_evidence: stopEvidence })
      expect(db().raw.prepare('SELECT resolution_basis,stop_evidence FROM unverified_resolutions WHERE node_run_id=?').get(nodeRunId))
        .toEqual({ resolution_basis: 'verified_none', stop_evidence: stopEvidence })
      const remaining = await call('/v1/effects/unverified?run_id=' + runId)
      expect(remaining.data.items.map((item: { node_run_id: string }) => item.node_run_id)).not.toContain(nodeRunId)
      expect(await submit()).toMatchObject({ data: { revision: 2, replayed: true } })
      expect(await submit({ ...command, operation_id: uuidv7() })).toMatchObject({ error: { code: 'DECISION_REVISION_CONFLICT' } })
      expect(await call('/v1/node-runs/report', { nodeRunId, attempt: 1, generation: 1, expectedStatus: 'startup_unknown',
        report: { report_id: 'late', node_run_id: nodeRunId, attempt: 1, status: 'failed' } }))
        .toMatchObject({ data: { accepted: false } })
      expect(row()).toMatchObject({ status: nextStatus, attempt: 1, action_generation: 1 })
      if (retrying) {
        expect(prompt).not.toHaveBeenCalled()
        const replacement = String(original.replacement_node_run_id)
        const fresh = () => db().raw.prepare(`SELECT status,attempt,action_generation,origin_node_run_id,side_effect_policy
          FROM node_runs WHERE node_run_id=?`).get(replacement)
        expect(fresh()).toEqual({ status: 'queued', attempt: 2, action_generation: 1, origin_node_run_id: nodeRunId, side_effect_policy: policy })
        expect(db().raw.prepare('SELECT count(*) AS n FROM node_runs WHERE run_id=?').get(runId)).toEqual({ n: 2 })
        const dispatch = call('/v1/runs/dispatch', { runId, nodes: { start: { tools: [] } } })
        await vi.waitFor(() => expect(fresh()).toMatchObject({ attempt: 2, action_generation: 2, side_effect_policy: policy }))
        await dispatch
        expect(await submit()).toMatchObject({ data: { revision: 2, replayed: true } })
        expect(row()).toMatchObject({ status: 'superseded', attempt: 1, action_generation: 1, replacement_node_run_id: replacement })
        return
      }
    } else if (mode === 'watchdog' || mode === 'uncertain-clock') {
      expect(await choices()).toEqual([])
      expect(await submit()).toMatchObject({ error: { code: 'DECISION_REVISION_CONFLICT' } })
      expect(receipt()).toBeUndefined()
    } else {
      expect(await choices()).toEqual(['abandon'])
      expect(await submit()).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
      expect(receipt()).toBeUndefined()
    }
    expect(prompt).not.toHaveBeenCalled()
  } finally {
    readyToSpawn.resolve()
    allowDispose.resolve()
    await service.close()
    await host.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
