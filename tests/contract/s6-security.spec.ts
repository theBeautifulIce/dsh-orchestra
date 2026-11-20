import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readCommandAudit } from '../../scripts/export-command-audit.ts'
import { sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { serveOrchestra } from '../../src/index.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { createLogger } from '../../src/infra/logger.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { openDecision, resolveDecision } from '../../src/service/commands/decisions.ts'
import { fakeAgentBridge } from '../fixtures/agent-bridge.ts'
import { seed } from '../fixtures/ledger.ts'

const SECRET = 'fixture-local-service'
const FIRST_SESSION = 'fixture-owner-session'
const SECOND_SESSION = 'fixture-reviewer-session'
const FIRST = 'human:fixture-owner'
const SECOND = 'human:fixture-reviewer'
const SENTINEL = 'synthetic-private-field-not-for-default-records'
const DECISION = 'd_fixture'
const log: string[] = []

async function boot(bound = true) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-s6-roles-'))
  const dbFile = join(dir, 'ledger.db')
  const registry = new ToolRegistry()
  registry.register({ name: 'fixture.inspect', capability: 'read_only', command: { bin: 'uninvoked-fixture', args: [] } })
  registry.register({ name: 'fixture.mutating', capability: 'mutating', command: { bin: 'uninvoked-fixture', args: [] } })
  const service = await serveOrchestra({
    dbFile, secret: SECRET, phase: 'S6', collaboration: true,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    log: createLogger({ write: line => log.push(line) }),
    executor: { registry, bridge: new BridgeClient(fakeAgentBridge({ agentId: 'fixture', steps: [] })),
      runner: new ReadOnlyToolRunner(registry, { readonlyAvailable: () => false,
        async run() { throw new Error('Authorization checks leave the tool uninvoked') } }, dir) },
    resolveHttpHuman: bound ? req => {
      const value = req.headers.authorization
      if (value === 'Bearer ' + FIRST_SESSION) return { id: FIRST }
      if (value === 'Bearer ' + SECOND_SESSION) return { id: SECOND }
      return null
    } : undefined,
  })
  const db = service.orchestra.db
  seed(db)
  withTx(db, tx => {
    openDecision(tx, { decisionId: DECISION, runId: 'r1', nodeRunId: null, kind: 'audit_result',
      approver: 'human', confirmRequired: true, payload: { original: SENTINEL } })
  })
  const post = (route: string, body: unknown, session?: string, secret = true) => fetch(service.endpoint + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
      ...(secret ? { 'x-orchestra-secret': SECRET } : {}), ...(session ? { authorization: 'Bearer ' + session } : {}) },
    body: JSON.stringify(body),
  })
  return { post, dbFile, db, close: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }) } }
}

it('requires a trusted human binding for S6 review writes and preserves the service actor for ordinary writes', async () => {
  const fixture = await boot(false)
  try {
    const { post, db } = fixture
    const cmd = { decisionId: DECISION, revision: 1, resolution: 'approved', operation_id: uuidv7() }
    const head = () => db.raw.prepare('SELECT MAX(seq) AS n FROM events').get()?.n
    const before = head()
    const anonymous = await post('/v1/ledger/events', {}, FIRST_SESSION, false)
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })

    const service = await post('/v1/ledger/events', {}, FIRST_SESSION)
    expect(service.status).toBe(200)
    expect(await service.json()).toMatchObject({ data: { actor: 'service:' + sha256Hex(SECRET).slice(0, 8) } })

    for (const route of ['/v1/decisions/resolve', '/v1/decisions/acknowledge',
      '/v1/effects/resolve', '/v1/node-runs/confirm-start', '/v1/collaboration/review',
      '/v1/collaboration/reassign', '/v1/rework/review', '/v1/rework/hold', '/v1/rework/plan/approve']) {
      const reply = await post(route, cmd)
      expect(reply.status, route).toBe(403)
      expect(await reply.json(), route).toMatchObject({ error: { code: 'FORBIDDEN' } })
    }
    expect(head()).toBe(before)
    expect(db.raw.prepare('SELECT status, revision, resolved_by FROM decisions WHERE decision_id=?').get(DECISION))
      .toMatchObject({ status: 'pending', revision: 1, resolved_by: null })
  } finally { await fixture.close() }
})

it('checks fixed and verifier tool declarations against the S6 service registry before admitting a version', async () => {
  const fixture = await boot()
  try {
    const { post, db } = fixture
    const load = (node: Record<string, unknown>, verifier?: { toolPolicy: { allow: string[] } }) =>
      post('/v1/workflows/load', { workflow_id: 'registry-fixture', workflow_version: '1',
        nodes: [{ node_id: 'inspect', type: 'agent', side_effect_policy: 'pure', ...node }], verifier })
    const installed = () => db.raw.prepare("SELECT COUNT(*) AS count FROM workflow_versions WHERE workflow_id='registry-fixture'").get()?.count
    for (const [node, code] of [
      [{ tools: { allow: ['fixture.mutating'] } }, 'SIDE_EFFECT_UNDECLARED'],
      [{ tools: { allow: ['fixture.unauthorized'] } }, 'TOOL_NOT_REGISTERED'],
      [{ verifier: { toolPolicy: { allow: ['fixture.mutating'] } } }, 'VERIFIER_TOOL_POLICY_MUTATING'],
    ] as const) {
      const reply = await load(node)
      expect(reply.status, code).toBe(422)
      expect(await reply.json()).toMatchObject({ error: { code } })
      expect(installed()).toBe(0)
    }
    const accepted = await load({ tools: { allow: ['fixture.inspect', 'fixture.mutating'], deny: ['fixture.mutating'] } },
      { toolPolicy: { allow: ['fixture.inspect'] } })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ data: { workflow_id: 'registry-fixture', workflow_version: '1' } })
    expect(installed()).toBe(1)
  } finally { await fixture.close() }
})

it('derives the producer from the decision scope before an eligible reviewer may resolve it', async () => {
  const fixture = await boot()
  try {
    const { db } = fixture
    withTx(db, tx => {
      tx.run("UPDATE node_runs SET executor_agent_id='fixture-producer' WHERE node_run_id='nr1'")
      openDecision(tx, { decisionId: 'd_provenance', runId: 'r1', nodeRunId: 'nr1', kind: 'audit_result',
        approver: 'either', confirmRequired: false })
    })
    const choose = (id: string) => withTx(db, tx => resolveDecision(tx, SECRET, {
      decisionId: 'd_provenance', revision: 1, resolution: 'rejected', now: new Date().toISOString(),
      actor: { kind: 'agent', id, capabilities: ['orchestra.audit'] },
    }))
    expect(() => choose('agent:fixture-producer')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(choose('fixture-independent')).toMatchObject({ status: 'resolved' })
  } finally { await fixture.close() }
})

it('binds confirmation and replay to the host actor and exports only the applied decision references', async () => {
  log.length = 0
  const fixture = await boot()
  try {
    const { post, db, dbFile } = fixture
    const operationId = uuidv7()
    const input = { decisionId: DECISION, revision: 1, resolution: 'approved', operation_id: operationId,
      actor: { kind: 'human', id: SECOND }, role: 'untrusted-fixture-role', payload: { transcript: SENTINEL } }
    const state = () => db.raw.prepare('SELECT status, revision, resolved_by FROM decisions WHERE decision_id=?').get(DECISION)
    const head = () => db.raw.prepare('SELECT MAX(seq) AS n FROM events').get()?.n
    const initial = head()
    const malformed = await post('/v1/decisions/resolve', { ...input, actor: SECOND }, FIRST_SESSION)
    expect((await malformed.json() as { error: { code: string } }).error.code).toBe('PAYLOAD_SCHEMA_INVALID')
    expect(head()).toBe(initial)
    const preflight = await post('/v1/decisions/resolve', input, FIRST_SESSION)
    expect(preflight.status).toBe(409)
    const confirmation = await preflight.json() as { error: { code: string; details: { confirm_challenge: string } } }
    expect(confirmation.error.code).toBe('CONFIRMATION_REQUIRED')
    expect(head()).toBe(initial)
    expect(readCommandAudit(dbFile).items).toEqual([])
    const confirmed = { ...input, confirm_challenge: confirmation.error.details.confirm_challenge }
    const wrongPrincipal = await post('/v1/decisions/resolve', confirmed, SECOND_SESSION)
    expect(wrongPrincipal.status).toBe(409)
    expect(await wrongPrincipal.json()).toMatchObject({ error: { code: 'CONFIRMATION_MISMATCH' } })
    expect(head()).toBe(initial)

    const applied = await post('/v1/decisions/resolve', confirmed, FIRST_SESSION)
    expect(applied.status).toBe(200)
    expect(await applied.json()).toMatchObject({ data: { replayed: false, revision: 2 } })
    expect(state()).toMatchObject({ resolved_by: FIRST, revision: 2, status: 'resolved' })
    const after = head()
    const replay = await post('/v1/decisions/resolve', input, FIRST_SESSION)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ data: { replayed: true, revision: 2 } })
    const wrongReplay = await post('/v1/decisions/resolve', input, SECOND_SESSION)
    expect(wrongReplay.status).toBe(409)
    expect(await wrongReplay.json()).toMatchObject({ error: { code: 'OPERATION_ID_CONFLICT' } })
    expect(head()).toBe(after)

    const audit = readCommandAudit(dbFile)
    expect(audit.items).toEqual([expect.objectContaining({ operation_id: operationId, decision_id: DECISION,
      actor_id: FIRST, actor_kind: 'human', result: 'applied', resolution: 'approved', run_id: 'r1', evidence_ids: [],
      occurred_at: expect.any(String) })])
    const audits = log.map(line => JSON.parse(line)).filter(item => item.msg === '裁决命令审计')
    expect(audits.map(item => [item.outcome, item.code])).toEqual([
      ['rejected', 'CONFIRMATION_MISMATCH'], ['replayed', undefined], ['rejected', 'OPERATION_ID_CONFLICT'],
    ])
    expect(audits.every(item => item.operation_id === operationId)).toBe(true)
    expect(JSON.stringify({ audit, auditLog: audits })).not.toContain(SENTINEL)
    expect(readCommandAudit(dbFile, audit.items[0]!.seq).items).toEqual([])
  } finally { await fixture.close() }
})
