import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { BridgeClient, type ResidentAttemptBinding } from '../../src/executor/bridge.ts'
import { BridgeLedger } from '../../src/executor/bridge-ledger.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { serveOrchestra, sweepNow } from '../../src/index.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { acquireLease } from '../../src/service/commands/lease.ts'
import { applyObservedReport } from '../../src/service/commands/apply-report.ts'
import { recordOrdinaryHostStop } from '../../src/service/decision/ordinary-recovery.ts'
import { bindRunVersion } from '../fixtures/ledger.ts'

type Command = ReturnType<typeof command>
function command(card: { decision_id: string; revision: number }, resolution: string, payload?: object) {
  return { decisionId: card.decision_id, revision: card.revision, resolution, operation_id: uuidv7(), payload }
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orchestra-ordinary-live-'))
  const secret = 'ordinary-live-ledger'
  const registry = new ToolRegistry()
  const runner = new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true,
    run: async () => { throw new Error('Recovery choice must not run a tool') } }, directory)
  const host = { online: true, throws: false, hasToolCall: false, observedRunning: true, budget: 600_000, lastToolCallId: undefined as string | undefined }
  const monitors = new Map<string, ResidentAttemptBinding>()
  const bridge = new BridgeClient({
    async request() { throw new Error('Recovery choice must not call a bridge RPC') },
    fenceAttemptTools(binding) { monitors.set(binding.executorAgentId, binding); return true },
    observeAttempt(binding) {
      if (host.throws) throw new Error('Fixture host temporarily unavailable')
      if (host.online && monitors.get(binding.executorAgentId)?.nodeRunId === binding.nodeRunId) {
        return { hasToolCall: host.hasToolCall, observedRunning: host.observedRunning, lastToolCallId: host.lastToolCallId }
      }
    },
    async *listen() {},
  })
  const abort = new AbortController()
  const options = { dbFile: join(directory, 'service.db'), phase: 'S6' as const, secret, executor: { bridge, registry, runner },
    resolveHttpHuman: (req: import('node:http').IncomingMessage) => req.headers.authorization?.startsWith('Bearer operator')
      ? { id: req.headers.authorization.slice(7) } : null,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
  }
  const service = await serveOrchestra(options)
  const { db, runtime, catalog, commands } = service.orchestra
  const now = () => new Date().toISOString()
  const seed = (id: string, status: 'startup_unknown' | 'stopping', policy = 'pure') => {
    const at = now()
    withTx(db, tx => {
      tx.run("INSERT OR IGNORE INTO tasks (task_id,title,status,created_at,updated_at) VALUES ('task','F8','running',?,?)", [at, at])
      tx.run("INSERT OR IGNORE INTO runs (run_id,task_id,status,created_at,updated_at) VALUES ('run','task','running',?,?)", [at, at])
      tx.run(`INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,attempt,side_effect_policy,created_at,updated_at)
        VALUES (?,'run',?,(SELECT COUNT(*)+1 FROM node_runs),'agent','queued',2,?,?,?)`, [id, id, policy, at, at])
      const sample = runtime.clock.sample()
      acquireLease(tx, secret, { nodeRunId: id, ownerEpoch: db.epoch, leaseTtlMs: 90_000, now: at })
      tx.run(`UPDATE node_runs SET status=?,executor_agent_id=?,executor_session_id=?,
        startup_unknown_deadline_at=?,startup_unknown_boot_id=?,startup_unknown_monotonic_ns=?,startup_unknown_remaining_ns=? WHERE node_run_id=?`,
      [status, id + ':agent', id + ':session', new Date(sample.wallClockMs + 15_000).toISOString(), sample.bootId,
        sample.monotonicNs + 15e9, 15e9, id])
    })
    bridge.installAttemptMonitor({ binding: { nodeRunId: id, executorAgentId: id + ':agent', executorSessionId: id + ':session',
      attempt: 2, actionGeneration: 1 }, budget: (gr) => node(id).rearm_generation === gr ? host.budget : 0, actionTimeoutMs: 10_000 },
    () => false, abort.signal)
    if (status === 'stopping') expireAction(id)
    sweepNow(runtime, now())
  }
  function expireAction(id: string) {
    const sample = runtime.clock.sample()
    withTx(db, tx => tx.run('UPDATE node_runs SET deadline_at=?,deadline_boot_id=?,deadline_monotonic_ns=?,action_remaining_ns=0 WHERE node_run_id=?',
      [new Date(sample.wallClockMs - 1000).toISOString(), sample.bootId, sample.monotonicNs - 1e9, id]))
  }
  const node = (id: string) => db.raw.prepare('SELECT * FROM node_runs WHERE node_run_id=?').get(id) as Record<string, unknown>
  const card = (kind: string, id: string | null) => db.raw.prepare('SELECT decision_id,revision,status,closed_reason FROM decisions WHERE kind=? AND node_run_id IS ?')
    .get(kind, id) as { decision_id: string; revision: number; status: string; closed_reason: string | null }
  const call = async (path: string, body?: object, actor?: string | null) => {
    const res = await fetch(service.endpoint + path, { headers: {
      'x-orchestra-secret': secret, 'content-type': 'application/json', ...(actor !== null && { authorization: `Bearer ${actor ?? 'operator'}` }),
    }, ...(body && { method: 'POST', body: JSON.stringify(body) }) })
    return { status: res.status, body: await res.json() }
  }
  const choices = async (id: string): Promise<string[]> => (await call('/v1/decisions/get?decision_id=' + id)).body.data.allowed_resolutions
  const submit = (body: Command, actor?: string | null) => call('/v1/decisions/resolve', body, actor)
  const signedTool = (id: string, extra: Record<string, unknown> = {}) => {
    const sample = runtime.clock.sample()
    withTx(db, tx => appendNodeRunEvent(tx, secret, id, 'tool_started', { attempt: 2, action_generation: 1, call_id: 'tool1',
      started_at: new Date(sample.wallClockMs).toISOString(), started_boot_id: sample.bootId,
      started_monotonic_ns: sample.monotonicNs, timeout_ms: 4000, ...extra }))
    return sample
  }
  const event = (id: string, rule: string) => db.raw.prepare(`SELECT payload FROM node_run_events WHERE node_run_id=?
    AND type IN ('decision.recovery_rearmed','decision.recovery_resolved') AND json_extract(payload,'$.rule_id')=? ORDER BY seq DESC LIMIT 1`).get(id, rule)
  const close = async () => { abort.abort(); await service.close(); rmSync(directory, { recursive: true, force: true }) }
  return { db, runtime, catalog, commands, secret, host, seed, card, node, choices, submit, call, now, close, event, expireAction, signedTool }
}

it.each([['M-08', false], ['M-61', true]] as const)('uses same-attempt host observations for %s', async (rule, tool) => {
  const f = await fixture()
  try {
    f.seed('start', 'startup_unknown')
    const d = f.card('startup_unknown', 'start')
    const request = command(d, 'confirm_started')
    f.host.hasToolCall = tool
    let signedStartNs: number | undefined
    if (tool) {
      f.host.lastToolCallId = 'tool1'
      expect(await f.choices(d.decision_id)).not.toContain('confirm_started')
      expect((await f.submit(request)).body).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
      f.signedTool('start', { attempt: 1 })
      f.signedTool('start', { action_generation: 0 })
      f.signedTool('start', { started_boot_id: 'earlier-boot' })
      f.signedTool('start', { call_id: 'other-call' })
      expect(await f.choices(d.decision_id)).not.toContain('confirm_started')
      signedStartNs = f.signedTool('start').monotonicNs
    }
    expect(await f.choices(d.decision_id)).toContain('confirm_started')
    expect((await f.submit(request, null)).status).toBe(403)
    expect((await f.submit(request)).body).toMatchObject({ data: { revision: 2, replayed: false } })
    expect(f.node('start')).toMatchObject({ status: 'stopping', attempt: 2, action_generation: 1, rearm_generation: 1,
      startup_unknown_deadline_at: null, deadline_boot_id: f.runtime.clock.bootId, action_start_source: 'human_confirmed' })
    if (signedStartNs !== undefined) expect(f.node('start').deadline_monotonic_ns).toBe(signedStartNs + 4e9)
    expect(f.event('start', rule)).toBeDefined()
    expect(f.card('startup_unknown', 'start')).toMatchObject({ status: 'resolved', closed_reason: 'approved' })
    f.host.online = false
    expect((await f.submit(request)).body).toMatchObject({ data: { revision: 2, replayed: true } })
    expect((await f.submit(request, 'operator-other')).body).toMatchObject({ error: { code: 'OPERATION_ID_CONFLICT' } })
    expect((await f.submit({ ...request, operation_id: uuidv7() })).body).toMatchObject({ error: { code: 'DECISION_REVISION_CONFLICT' } })
  } finally { await f.close() }
})

it('rearms the 120-second startup clock and records human attestation separately', async () => {
  const f = await fixture()
  try {
    f.seed('unknown', 'startup_unknown')
    const d = f.card('startup_unknown', 'unknown')
    f.host.observedRunning = false
    expect(await f.choices(d.decision_id)).toEqual(['confirm_started_attested', 'continue_tracking', 'abandon'])
    f.host.online = false
    expect(await f.choices(d.decision_id)).toEqual(['abandon'])
    const tracked = command(d, 'continue_tracking')
    expect((await f.submit(tracked)).body).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    f.host.online = true
    f.host.budget = 119_999
    expect(await f.choices(d.decision_id)).not.toContain('continue_tracking')
    f.host.budget = 600_000
    expect((await f.submit(tracked)).body).toMatchObject({ data: { revision: 2, replayed: false } })
    expect(f.node('unknown')).toMatchObject({ status: 'startup_unknown', attempt: 2, action_generation: 1, rearm_generation: 1,
      startup_unknown_remaining_ns: 120e9, startup_unknown_boot_id: f.runtime.clock.bootId, deadline_at: null, deadline_monotonic_ns: null })
    expect(f.event('unknown', 'M-57')).toBeDefined()
    const updated = f.card('startup_unknown', 'unknown')
    expect(updated).toMatchObject({ decision_id: d.decision_id, status: 'pending', revision: 2 })
    const attest = command(updated, 'confirm_started_attested', { attestation_id: 'att_fixture' })
    expect((await f.submit({ ...attest, payload: { attestation_id: 'att_fixture', evidence_ids: ['fake'] } })).body)
      .toMatchObject({ error: { code: 'PAYLOAD_SCHEMA_INVALID' } })
    expect((await f.submit(attest)).body).toMatchObject({ data: { revision: 3 } })
    expect(f.node('unknown')).toMatchObject({ status: 'stopping', action_generation: 1, rearm_generation: 2, action_start_source: 'human_attested' })
    expect(f.db.raw.prepare('SELECT attested_by,claim FROM attestations WHERE attestation_id=?').get('att_fixture'))
      .toEqual({ attested_by: 'operator', claim: 'action_started' })
    expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM unverified_resolutions').get()).toEqual({ n: 0 })
    const ledger = f.event('unknown', 'M-09') as { payload: string }
    expect(JSON.parse(ledger.payload)).toMatchObject({ attestation_id: 'att_fixture', action_start_source: 'human_attested' })
    expect(JSON.parse(ledger.payload)).not.toHaveProperty('evidence_id')
  } finally { await f.close() }
})

it('requires a current startup clock and a matching binding at approval time', async () => {
  const f = await fixture()
  try {
    f.seed('unknown', 'startup_unknown')
    const card = f.card('startup_unknown', 'unknown')
    const submit = () => f.submit(command(card, 'continue_tracking'))
    expect(await f.choices(card.decision_id)).toContain('continue_tracking')
    f.host.throws = true
    expect(await f.choices(card.decision_id)).toEqual(['abandon'])
    expect((await submit()).body).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    f.host.throws = false
    withTx(f.db, tx => tx.run("UPDATE node_runs SET executor_session_id='other' WHERE node_run_id='unknown'"))
    expect((await submit()).body).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    withTx(f.db, tx => tx.run("UPDATE node_runs SET executor_session_id='unknown:session',startup_unknown_monotonic_ns=0 WHERE node_run_id='unknown'"))
    expect((await submit()).body).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    sweepNow(f.runtime, f.now())
    expect(f.node('unknown').status).toBe('indeterminate_side_effect')
    expect(f.card('startup_unknown', 'unknown').closed_reason).toBe('expired_final')
  } finally { await f.close() }
})

it('allows three expired waits on the same acknowledged card and preserves the action generation', async () => {
  const f = await fixture()
  try {
    f.seed('stop', 'stopping')
    const initial = f.card('action_overrun', 'stop')
    f.host.hasToolCall = true
    f.host.lastToolCallId = 'tool1'
    expect(await f.choices(initial.decision_id)).not.toContain('continue_wait')
    f.signedTool('stop')
    await f.call('/v1/decisions/acknowledge', { decisionId: initial.decision_id, revision: initial.revision, operation_id: uuidv7() })
    for (let expected = 1; expected <= 3; expected += 1) {
      const card = f.card('action_overrun', 'stop')
      expect(card).toMatchObject({ decision_id: initial.decision_id, status: 'acknowledged', revision: expected + 1 })
      expect(await f.choices(card.decision_id)).toContain('continue_wait')
      expect((await f.submit(command(card, 'continue_wait'))).body).toMatchObject({ data: { revision: expected + 2 } })
      expect(f.node('stop')).toMatchObject({ status: 'stopping', action_generation: 1, rearm_generation: expected,
        wait_extensions: expected, action_remaining_ns: 4e9, hang_reason: null })
      expect((await f.submit(command(f.card('action_overrun', 'stop'), 'continue_wait'))).body)
        .toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
      f.expireAction('stop')
      sweepNow(f.runtime, f.now())
      expect(f.node('stop').hang_reason).toBe('action_overrun')
    }
    expect(await f.choices(initial.decision_id)).not.toContain('continue_wait')
    expect((await f.submit(command(f.card('action_overrun', 'stop'), 'continue_wait'))).body)
      .toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    expect(f.event('stop', 'M-34')).toBeDefined()
  } finally { await f.close() }
})

it('extends native observation only when the current host call has a handled signed start', async () => {
  const f = await fixture()
  try {
    f.seed('stop', 'stopping')
    f.host.hasToolCall = true
    f.host.lastToolCallId = 'native_read'
    const card = f.card('action_overrun', 'stop')
    expect(await f.choices(card.decision_id)).not.toContain('continue_wait')
    const ledger = new BridgeLedger(f.db, f.secret, { nodeRunId: 'stop', attempt: 2, executorAgentId: 'stop:agent' })
    ledger.ingest({ seq: 1, type: 'tool.start', at: f.now(), toolStartAt: null, attempt: 2, executorAgentId: 'stop:agent',
      payload: { kind: 'native_tool', call_id: 'native_read', tool: 'read', arguments_hash: 'a'.repeat(64) } })
    expect(await f.choices(card.decision_id)).not.toContain('continue_wait')
    ledger.markHandled(1)
    f.host.lastToolCallId = 'unconfirmed_call'
    expect(await f.choices(card.decision_id)).not.toContain('continue_wait')
    f.host.lastToolCallId = 'native_read'
    expect(await f.choices(card.decision_id)).toContain('continue_wait')
    expect((await f.submit(command(card, 'continue_wait'))).body).toMatchObject({ data: { revision: 2 } })
    expect(f.node('stop')).toMatchObject({ status: 'stopping', action_generation: 1, rearm_generation: 1,
      action_remaining_ns: 10e9, wait_extensions: 1, hang_reason: null })
    expect(f.event('stop', 'M-34')).toBeDefined()
  } finally { await f.close() }
})

it.each(['pure', 'irreversible'])('restores only observation after abandoning a %s node', async (policy) => {
  const f = await fixture()
  try {
    f.seed('stop', 'stopping', policy)
    expect((await f.submit(command(f.card('action_overrun', 'stop'), 'abandon'))).status).toBe(200)
    const ack = f.card('abandon_ack', null)
    f.host.online = false
    expect(await f.choices(ack.decision_id)).toEqual(['approved'])
    expect((await f.submit(command(ack, 'rejected'))).body).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    f.host.online = true
    expect(await f.choices(ack.decision_id)).toEqual(['approved', 'rejected'])
    const reject = command(ack, 'rejected')
    expect((await f.submit(reject)).body).toMatchObject({ data: { revision: 2, replayed: false } })
    expect(f.node('stop')).toMatchObject({ status: 'stopping', lease_id: null, action_generation: 1, rearm_generation: 2,
      deadline_boot_id: f.runtime.clock.bootId, executor_agent_id: 'stop:agent' })
    expect(f.event('stop', 'M-37')).toBeDefined()
    expect((await f.submit(reject)).body).toMatchObject({ data: { replayed: true } })
    if (policy === 'irreversible') {
      f.commands.loadWorkflow({ workflow_version: '1', pass_conditions: [], nodes: [{ node_id: 'stop', type: 'agent', side_effect_policy: 'pure' }] })
      bindRunVersion(f.db, f.catalog, 1, 'run')
      const ledger = new BridgeLedger(f.db, f.secret, { nodeRunId: 'stop', attempt: 2, executorAgentId: 'stop:agent' })
      ledger.ingest({ seq: 1, type: 'turn', at: f.now(), toolStartAt: null, attempt: 2, executorAgentId: 'stop:agent',
        payload: { kind: 'report', report: { status: 'done', output: { effect: 'claimed' } } } })
      ledger.markHandled(1)
      const result = withTx(f.db, tx => {
        recordOrdinaryHostStop(tx, f.secret, { nodeRunId: 'stop', attempt: 2, generation: 1, agentId: 'stop:agent', stoppedAt: f.now() })
        return applyObservedReport(tx, f.secret, { nodeRunId: 'stop', attempt: 2, expectedStatus: 'stopping', generation: 1, now: f.now(),
          report: { report_id: 'rep_stop_2_done', node_run_id: 'stop', attempt: 2, status: 'done', output: { effect: 'claimed', evidence_trace: [] } } },
        f.catalog, { executorAgentId: 'stop:agent', executorSessionId: 'stop:session', rearmGeneration: 2, bridgeSeq: 1 }, true)
      })
      expect(result).toMatchObject({ accepted: false, reason: 'evidence_missing' })
      expect(f.node('stop').status).toBe('stopping')
    }
  } finally { await f.close() }
})

it.each([
  { case: 'pure incomplete', policy: 'pure', stopped: true, allowed: true, outcome: 'blocked', altered: false, expected: 'failed' },
  { case: 'unverified effects', policy: 'irreversible', stopped: true, allowed: true, outcome: 'blocked', altered: false, expected: 'evidence_missing' },
  { case: 'command evidence required', policy: 'pure', stopped: true, allowed: false, outcome: 'blocked', altered: false, expected: 'evidence_missing' },
  { case: 'success claimed as failure', policy: 'pure', stopped: true, allowed: true, outcome: 'completed', altered: false, expected: 'evidence_missing' },
  { case: 'host stop missing', policy: 'pure', stopped: false, allowed: true, outcome: 'blocked', altered: false, expected: 'STALE_GENERATION' },
  { case: 'final output altered', policy: 'pure', stopped: true, allowed: true, outcome: 'blocked', altered: true, expected: 'STALE_GENERATION' },
])('settles observed incomplete work only with matching pure-execution facts: $case', async (scenario) => {
  const f = await fixture()
  try {
    f.seed('stop', 'stopping', scenario.policy)
    f.commands.loadWorkflow({ workflow_version: '1', pass_conditions: [], nodes: [{ node_id: 'stop', type: 'agent', side_effect_policy: 'pure' }] })
    bindRunVersion(f.db, f.catalog, 1, 'run')
    const completion = scenario.outcome === 'completed' ? { outcome: 'completed' }
      : { outcome: 'blocked', reason: '工具授权已结束，剩余检查未执行。', next_action: '调整本步时限后重试。', missing: ['剩余检查'] }
    const output = { completion, summary: '已保留检查进度。' }
    const ledger = new BridgeLedger(f.db, f.secret, { nodeRunId: 'stop', attempt: 2, executorAgentId: 'stop:agent' })
    ledger.ingest({ seq: 1, type: 'turn', at: f.now(), toolStartAt: null, attempt: 2, executorAgentId: 'stop:agent',
      payload: { kind: 'report', report: { status: 'failed', output } } })
    ledger.markHandled(1)
    const apply = () => withTx(f.db, tx => {
      if (scenario.stopped) recordOrdinaryHostStop(tx, f.secret, {
        nodeRunId: 'stop', attempt: 2, generation: 1, agentId: 'stop:agent', stoppedAt: f.now(),
      })
      return applyObservedReport(tx, f.secret, { nodeRunId: 'stop', attempt: 2, expectedStatus: 'stopping', generation: 1, now: f.now(),
        report: { report_id: 'rep_stop_2_failed', node_run_id: 'stop', attempt: 2, status: 'failed',
          output: { ...output, ...(scenario.altered && { summary: 'different output' }), evidence_trace: [] } } }, f.catalog,
      { executorAgentId: 'stop:agent', executorSessionId: 'stop:session', rearmGeneration: 0, bridgeSeq: 1 }, scenario.allowed)
    })
    if (scenario.expected === 'STALE_GENERATION') expect(apply).toThrowError(expect.objectContaining({ code: 'STALE_GENERATION' }))
    else if (scenario.expected === 'failed') {
      expect(apply()).toMatchObject({ accepted: true, next_status: 'failed' })
      expect(f.card('action_overrun', 'stop')).toMatchObject({ status: 'resolved', closed_reason: 'cancelled' })
      sweepNow(f.runtime, f.now())
      expect(f.db.raw.prepare("SELECT status FROM runs WHERE run_id='run'").get()).toEqual({ status: 'failed' })
    } else expect(apply()).toMatchObject({ accepted: false, reason: scenario.expected })
    expect(f.node('stop').status).toBe(scenario.expected === 'failed' ? 'failed' : 'stopping')
  } finally { await f.close() }
})
