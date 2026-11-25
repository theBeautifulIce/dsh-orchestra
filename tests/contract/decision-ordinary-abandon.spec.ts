import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra, sweepNow } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { openDecision } from '../../src/service/commands/decisions.ts'
import { recordOrdinaryHostStop } from '../../src/service/decision/ordinary-recovery.ts'
import { EvidenceCollector } from '../../src/executor/evidence-collector.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'

it('recovers cancelled post-execution blockers on reopen and keeps uncertain effects actionable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestra-stopped-blocker-'))
  const secret = 'stopped-blocker-ledger'
  const options = { dbFile: join(directory, 'service.db'), secret, phase: 'S6' as const,
    resolveHttpHuman: () => ({ id: 'fixture:operator' }), asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }) }
  let service = await serveOrchestra(options)
  const at = new Date().toISOString()
  try {
    withTx(service.orchestra.db, tx => {
      for (const id of ['stopped', 'tool', 'unconfirmed', 'has-card', 'active']) {
        tx.run("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES (?,?,'running',?,?)", [id,id,at,at])
        tx.run("INSERT INTO runs(run_id,task_id,status,cancel_requested_at,created_at,updated_at) VALUES (?,?,'running',?,?,?)",
          [id,id,id === 'active' ? null : at,at,at])
        tx.run(`INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,attempt,action_generation,rearm_generation,
          side_effect_policy,executor_agent_id,created_at,updated_at) VALUES (?,?,?,1,'agent','blocked_post',1,2,1,'pure',?,?,?)`,
        [id,id,id,id,at,at])
        appendNodeRunEvent(tx, secret, id, 'verify_human', { reason: '缺少核算材料', missing: ['单价'], status: 'blocked_post' })
        if (id === 'tool') appendNodeRunEvent(tx, secret, id, 'bridge.tool.start', { attempt: 1, tool: 'worker_tool' })
        recordOrdinaryHostStop(tx, secret, { nodeRunId: id, attempt: id === 'unconfirmed' ? 0 : 1,
          generation: 2, agentId: id, stoppedAt: at })
      }
      openDecision(tx, { decisionId: 'existing-card', runId: 'has-card', nodeRunId: 'has-card', kind: 'audit_result', createdAt: at })
    })
    await service.close()
    service = await serveOrchestra(options)
    for (let i = 0; i < 2; i++) sweepNow(service.orchestra.runtime, new Date().toISOString())
    const db = service.orchestra.db.raw
    expect(db.prepare('SELECT node_run_id,status FROM node_runs ORDER BY node_run_id').all()).toEqual([
      { node_run_id: 'active', status: 'blocked_post' }, { node_run_id: 'has-card', status: 'blocked_post' },
      { node_run_id: 'stopped', status: 'failed' }, { node_run_id: 'tool', status: 'indeterminate_side_effect' },
      { node_run_id: 'unconfirmed', status: 'indeterminate_side_effect' },
    ])
    expect(db.prepare("SELECT status FROM runs WHERE run_id='stopped'").get()).toEqual({ status: 'cancelled' })
    const cards = db.prepare("SELECT decision_id,node_run_id FROM decisions WHERE kind='verify_human' ORDER BY node_run_id").all()
    expect(cards.map(card => card.node_run_id)).toEqual(['tool','unconfirmed'])
    for (const card of cards) {
      const response = await fetch(service.endpoint + '/v1/decisions/get?decision_id=' + card.decision_id, { headers: { 'x-orchestra-secret': secret } })
      expect(await response.json()).toMatchObject({ data: { allowed_resolutions: ['abandon'] } })
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM unverified_resolutions').get()).toEqual({ n: 0 })
  } finally {
    await service.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each(['signed', 'expired'] as const)('opens ordinary recovery cards from maintenance and handles an aggregated abandonment when %s', async (mode) => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestra-ordinary-abandon-'))
  const secret = 'ordinary-abandon-ledger'
  const options = { dbFile: join(directory, 'service.db'), secret, phase: 'S6' as const,
    resolveHttpHuman: (req: import('node:http').IncomingMessage) => req.headers.authorization === 'Bearer operator' ? { id: 'fixture:operator' } : null,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
  }
  let service = await serveOrchestra(options)
  const now = () => new Date().toISOString()
  const db = () => service.orchestra.db
  const node = (id: string) => db().raw.prepare('SELECT status,attempt,action_generation,rearm_generation,lease_id FROM node_runs WHERE node_run_id=?').get(id)
  const run = () => db().raw.prepare("SELECT status FROM runs WHERE run_id='run'").get()
  const card = (kind: string) => db().raw.prepare('SELECT decision_id,revision,payload_json FROM decisions WHERE run_id=? AND kind=? AND status<>?')
    .get('run', kind, 'resolved') as { decision_id: string; revision: number; payload_json: string }
  const call = async (path: string, body?: object, operator = true) => {
    const res = await fetch(service.endpoint + path, { headers: {
      'x-orchestra-secret': secret, 'content-type': 'application/json', ...(operator ? { authorization: 'Bearer operator' } : {}),
    }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json() }
  }
  const command = (d: ReturnType<typeof card>, resolution: string) => ({
    decisionId: d.decision_id, revision: d.revision, resolution, operation_id: uuidv7(),
  })
  const submit = (body: object, operator = true) => call('/v1/decisions/resolve', body, operator)
  const view = (id: string) => call('/v1/decisions/get?decision_id=' + id)
  try {
    const at = now()
    withTx(db(), (tx) => {
      tx.run("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES ('task','F8','running',?,?)", [at, at])
      tx.run("INSERT INTO runs (run_id,task_id,status,created_at,updated_at) VALUES ('run','task','running',?,?)", [at, at])
      for (const { id, status, seq } of [{ id: 'uncertain', status: 'startup_unknown', seq: 1 },
        { id: 'unverified', status: 'indeterminate_side_effect', seq: 2 }]) {
        tx.run(`INSERT INTO node_runs
          (node_run_id,run_id,node_id,seq,node_type,status,attempt,action_generation,rearm_generation,side_effect_policy,executor_agent_id,created_at,updated_at)
          VALUES (?,'run',?,?,'agent',?,2,7,3,'irreversible',?,?,?)`, [id, id, seq, status, id + ':executor', at, at])
      }
      const clock = service.orchestra.runtime.clock.sample()
      const remainingNs = 120_000 * 1e6
      tx.run("UPDATE node_runs SET startup_unknown_deadline_at=?,startup_unknown_boot_id=?,startup_unknown_monotonic_ns=?,"
        + "startup_unknown_remaining_ns=? WHERE node_run_id='uncertain'",
      [new Date(clock.wallClockMs + 120_000).toISOString(), clock.bootId, clock.monotonicNs + remainingNs, remainingNs])
    })
    sweepNow(service.orchestra.runtime, now())
    const first = card('startup_unknown')
    expect((await view(first.decision_id)).body).toMatchObject({ data: { allowed_resolutions: ['abandon'] } })
    const abandon = command(first, 'abandon')
    expect((await submit(abandon, false)).status).toBe(403)
    expect((await submit({ ...abandon, payload: { stopped_at: now() } })).body).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    const race = await Promise.all([submit(abandon), submit(abandon)])
    expect(race.map(reply => reply.body.data?.replayed).sort()).toEqual([false, true])
    expect(node('uncertain')).toMatchObject({ status: 'abandoned_unverified', attempt: 2, action_generation: 7, rearm_generation: 4, lease_id: null })
    const ack = card('abandon_ack')
    expect(run()).toEqual({ status: 'running' })

    const second = card('verify_human')
    expect((await submit(command(second, 'abandon'))).status).toBe(200)
    const combined = card('abandon_ack')
    expect(combined.decision_id).toEqual(ack.decision_id)
    expect(combined.revision).toEqual(ack.revision + 1)
    expect(JSON.parse(combined.payload_json).affected.map((entry: { node_run_id: string }) => entry.node_run_id)).toEqual(['uncertain', 'unverified'])
    expect((await submit(command(ack, 'approved'))).body).toMatchObject({ error: { code: 'DECISION_REVISION_CONFLICT' } })
    expect((await view(combined.decision_id)).body).toMatchObject({ data: { allowed_resolutions: ['approved'] } })
    const sign = command(combined, 'approved')
    if (mode === 'expired') {
      const expiresAt = db().raw.prepare('SELECT expires_at FROM decisions WHERE decision_id=?').get(combined.decision_id) as { expires_at: string }
      sweepNow(service.orchestra.runtime, expiresAt.expires_at)
      expect(run()).toEqual({ status: 'paused' })
      expect(db().raw.prepare('SELECT status,closed_reason FROM decisions WHERE decision_id=?').get(combined.decision_id))
        .toEqual({ status: 'resolved', closed_reason: 'expired_final' })
      expect((await submit(sign)).body).toMatchObject({ error: { code: 'DECISION_REVISION_CONFLICT' } })
      expect(db().raw.prepare('SELECT COUNT(*) AS n FROM unverified_resolutions').get()).toEqual({ n: 0 })
      return
    }
    expect((await submit(sign)).status).toBe(200)
    expect(run()).toEqual({ status: 'running' })
    expect(db().raw.prepare('SELECT COUNT(*) AS n FROM unverified_resolutions').get()).toEqual({ n: 0 })

    await service.close()
    service = await serveOrchestra(options)
    expect((await submit(sign)).body).toMatchObject({ data: { replayed: true } })
    withTx(db(), (tx) => {
      recordOrdinaryHostStop(tx, secret, { nodeRunId: 'uncertain', attempt: 1, generation: 7, agentId: 'uncertain:executor', stoppedAt: now() })
      recordOrdinaryHostStop(tx, secret, { nodeRunId: 'unverified', attempt: 2, generation: 7, agentId: 'unverified:executor', stoppedAt: now() })
    })
    sweepNow(service.orchestra.runtime, now())
    expect(run()).toEqual({ status: 'running' })
    withTx(db(), (tx) => recordOrdinaryHostStop(tx, secret, {
      nodeRunId: 'uncertain', attempt: 2, generation: 7, agentId: 'uncertain:executor', stoppedAt: now(),
    }))
    sweepNow(service.orchestra.runtime, now())
    expect(run()).toEqual({ status: 'succeeded_with_unverified' })
    expect(db().raw.prepare("SELECT count(*) AS n FROM node_run_events WHERE type='decision.abandon_signed'").get()).toEqual({ n: 2 })
    expect(db().raw.prepare('SELECT COUNT(*) AS n FROM unverified_resolutions').get()).toEqual({ n: 0 })
  } finally {
    await service.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([
  ['stopping', 'applied', 'done', 'action_overrun'],
  ['indeterminate_side_effect', 'applied', 'done', 'verify_human'],
  ['indeterminate_side_effect', 'not_applied', 'failed', 'verify_human'],
] as const)('reconciles an ordinary %s node with a verified %s effect', async (source, verdict, target, kind) => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestra-ordinary-effect-'))
  const secret = 'ordinary-effect-ledger'
  const workflow = 'a'.repeat(64)
  const service = await serveOrchestra({ dbFile: join(directory, 'service.db'), secret, phase: 'S6',
    resolveHttpHuman: (req) => req.headers.authorization === 'Bearer operator' ? { id: 'fixture:operator' } : null,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
  })
  const db = service.orchestra.db
  const request = async (path: string, body?: object) => (await fetch(service.endpoint + path, {
    headers: { authorization: 'Bearer operator', 'x-orchestra-secret': secret, 'content-type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  })).json()
  const at = new Date().toISOString()
  const nodeId = 'effect-node'
  const agentId = 'effect-agent'
  const generation = 7
  const attempt = 2
  const hostStop = (actionGeneration: number) => withTx(db, (tx) => recordOrdinaryHostStop(tx, secret, {
    nodeRunId: nodeId, attempt, generation: actionGeneration, agentId, stoppedAt: at,
  }))
  try {
    withTx(db, (tx) => {
      tx.run("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES ('task','F8','running',?,?)", [at, at])
      tx.run("INSERT INTO runs (run_id,task_id,status,workflow_definition_hash,created_at,updated_at) VALUES ('run','task','running',?,?,?)",
        [workflow, at, at])
      tx.run(`INSERT INTO node_runs
        (node_run_id,run_id,node_id,seq,node_type,status,attempt,action_generation,rearm_generation,side_effect_policy,executor_agent_id,created_at,updated_at)
        VALUES (?,'run','receipt',1,'agent','started',?,?,3,'irreversible',?,?,?)`, [nodeId, attempt, generation, agentId, at, at])
    })
    const registry = new ToolRegistry()
    registry.register({ name: 'read-receipt', capability: 'read_only', command: { bin: 'receipt-check', args: [] },
      effectVerifier: { id: 'receipt/v1', workflowDefinitionHash: workflow, nodeId: 'receipt',
        verify: (target, { stdout }) => stdout === `${target.node_run_id}/${target.attempt}` ? { verdict, reference: stdout } : null },
    })
    const runner = new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true,
      run: async () => ({ exitCode: 0, stdout: `${nodeId}/${attempt}`, stderr: '' }) }, '.')
    const collector = new EvidenceCollector({ db, secret, registry, runner, policy: { allow: ['read-receipt'] },
      allowedTools: ['read-receipt'], nodeRunId: nodeId, attempt, executorAgentId: agentId, nowAt: () => at })
    const toolResult = await collector.collect({ callId: 'read', tool: 'read-receipt', args: [], cwd: '.', timeoutMs: 100 })
    const evidenceId = toolResult.trace!.executionId
    const sample = service.orchestra.runtime.clock.sample()
    withTx(db, (tx) => tx.run('UPDATE node_runs SET status=?,deadline_at=?,deadline_boot_id=?,deadline_monotonic_ns=? WHERE node_run_id=?',
      [source, new Date(sample.wallClockMs - 1000).toISOString(), sample.bootId, sample.monotonicNs - 1_000_000_000, nodeId]))
    sweepNow(service.orchestra.runtime, at)
    const decision = db.raw.prepare('SELECT decision_id FROM decisions WHERE kind=? AND node_run_id=?').get(kind, nodeId) as { decision_id: string }
    expect(decision).toBeDefined()
    const decisionId = decision.decision_id
    const resolution = verdict === 'applied' ? 'confirm_applied' : 'confirm_not_applied'
    const command = { decisionId, revision: 1, operation_id: uuidv7(), resolution }
    const submit = (payload?: object) => request('/v1/decisions/resolve', { ...command, payload })
    const view = () => request('/v1/decisions/get?decision_id=' + decisionId)

    hostStop(generation - 1)
    expect((await view()).data.allowed_resolutions).toEqual(['abandon'])
    expect(await submit({ evidence_ids: [evidenceId] })).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    hostStop(generation)
    expect((await view()).data).toMatchObject({
      available_effect_evidence: { [verdict]: evidenceId }, allowed_resolutions: [resolution, 'abandon'],
    })
    expect(await submit()).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    expect(await submit({ evidence_ids: ['tex_other_attempt'] })).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    expect(await submit({ evidence_ids: [evidenceId], stopped_at: at })).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    expect(db.raw.prepare('SELECT * FROM unverified_resolutions').get()).toBeUndefined()
    expect(await submit({ evidence_ids: [evidenceId] })).toMatchObject({ data: { replayed: false, revision: 2 } })
    expect(db.raw.prepare('SELECT status,attempt,action_generation,replacement_node_run_id FROM node_runs WHERE node_run_id=?').get(nodeId))
      .toEqual({ status: target, attempt, action_generation: generation, replacement_node_run_id: null })
    expect(db.raw.prepare('SELECT resolution_basis FROM unverified_resolutions WHERE node_run_id=?').get(nodeId))
      .toEqual({ resolution_basis: verdict === 'applied' ? 'decision' : 'verified_none' })
    expect(db.raw.prepare("SELECT status FROM runs WHERE run_id='run'").get()).toEqual({ status: target === 'done' ? 'succeeded' : 'failed' })
  } finally {
    await service.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
