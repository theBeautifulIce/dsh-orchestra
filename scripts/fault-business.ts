import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson } from '../src/core/canonical.ts'
import { uuidv7 } from '../src/core/ids.ts'
import type { WorkflowDefinition } from '../src/core/workflow-def.ts'
import { openServiceOrchestra, serveOrchestra } from '../src/index.ts'
import { withTx, type Db } from '../src/infra/sqlite/driver.ts'
import { openDecision, resolveDecision } from '../src/service/commands/decisions.ts'
import { wakeOnEvent } from '../src/service/commands/wait.ts'
import { definitionHashOf } from '../src/service/workflows.ts'
import type { FaultCase } from './fault-report.ts'
import { ORPHAN_REFERENCES_SQL, sealCheckpoint } from './fault-reconcile.ts'
import { businessQuery, checkpoint, EVENT_PREFIX, faultRows, missingPrefix } from './fault-business-support.ts'

export { caseG11S6 } from './g11-memory.ts'

const NOW = '2026-11-20T00:00:00.000Z'
const SECRET = 's6-fault-business-fixture'
const ACTOR = 'human:s6-fault-business'
const SESSION = 'Bearer fixture-s6-fault-business'
const VERSIONS = 'SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version'
const RUN = 'SELECT * FROM runs WHERE run_id = ?'
const RUN_EVENTS = 'SELECT * FROM events WHERE run_id = ? ORDER BY seq'
const WAITS = 'SELECT * FROM wait_registrations WHERE run_id = ? ORDER BY registration_id'

function waitNode(nodeId: string, eventType: string) {
  return { node_id: nodeId, type: 'wait' as const, title: nodeId, position: { x: 1, y: 0 },
    config: { wait_kind: 'event', match: { type: eventType }, max_wait_ms: 60_000 } }
}

function pinDocument(resultEvent: string) {
  return {
    name: 'S6 G-10 version pin',
    nodes: [
      { node_id: 'start', type: 'trigger' as const, title: 'Start', position: { x: 0, y: 0 }, config: {} },
      waitNode('gate', 'g10.continue'), waitNode('result', resultEvent),
    ],
    edges: [{ from: 'start', to: 'gate' }, { from: 'gate', to: 'result' }],
  }
}

type Publication = {
  version: string
  definition_hash: string
  definition: WorkflowDefinition
  replayed: boolean
}

function publish(dbService: Awaited<ReturnType<typeof openServiceOrchestra>>, request: Parameters<typeof dbService.orchestra.commands.publishWorkflow>[0]) {
  const { commands } = dbService.orchestra
  assert.equal(commands.testWorkflowDraft(request).passed, true)
  return commands.publishWorkflow(request) as Publication
}

function workflowSnapshot(db: Db, workflowId: string, runIds: string[]) {
  return {
    versions: faultRows(db, VERSIONS, workflowId),
    runs: runIds.map((id) => ({
      run: faultRows(db, RUN, id),
      nodes: faultRows(db, 'SELECT * FROM node_runs WHERE run_id = ? ORDER BY seq, attempt', id),
      waits: faultRows(db, WAITS, id),
      events: faultRows(db, RUN_EVENTS, id),
    })),
  }
}

function commandError(fn: () => unknown) {
  try { fn() } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error
    return { code: error.code, message: error.message }
  }
  throw new Error('Expected command to fail')
}

export const caseG10S6: FaultCase = async ({ directory }) => {
  const database = 'after.db'
  const file = join(directory, database)
  const workflowId = 'wf_s6_g10'
  const oldMatch = 'g10.result.v1'
  const newMatch = 'g10.result.v2'
  const boot = () => openServiceOrchestra({ dbFile: file, secret: SECRET, phase: 'S6' })
  let service = await boot()
  try {
    const { commands, db } = service.orchestra
    const common = { workflowId, actor: ACTOR, now: NOW }
    commands.createWorkflow({ ...common, name: pinDocument(oldMatch).name, definition: pinDocument(oldMatch), operationId: uuidv7() })
    const v1 = publish(service, { ...common, revision: 1, baseVersion: 0, note: 'v1', operationId: uuidv7() })
    const start = (title: string, version: string) => service.orchestra.commands.startRun({
      ...common, taskTitle: title, workflowVersion: version, operationId: uuidv7(),
    })
    const oldRun = start('S6 G-10 old run', '1').run_id
    const dispatch = (runId: string) => service.orchestra.commands.dispatch({
      runId, now: NOW, nodes: { gate: { tools: [] }, result: { tools: [] } },
    })
    const wake = (runId: string, eventType: string) => withTx(service.orchestra.db,
      (tx) => wakeOnEvent(tx, SECRET, { runId, eventType, now: NOW }))
    const oldGate = await dispatch(oldRun)
    assert.deepEqual(oldGate.map(row => [row.node_id, row.status]), [['gate', 'waiting']])
    const before = workflowSnapshot(db, workflowId, [oldRun])
    checkpoint(db, directory, 'before.db')
    const prefix = faultRows(db, EVENT_PREFIX)

    const draft = commands.openWorkflowDraft({ ...common, baseVersion: 1, operationId: uuidv7() }) as { revision: number }
    const update = commands.updateWorkflowDraft({ ...common, revision: draft.revision, definition: pinDocument(newMatch),
      operationId: uuidv7() }) as { revision: number }
    const request = { ...common, revision: update.revision, baseVersion: 1, note: 'v2', operationId: uuidv7() }
    const v2 = publish(service, request)
    assert.notEqual(v1.definition_hash, v2.definition_hash)
    const breakpoint = workflowSnapshot(db, workflowId, [oldRun])
    checkpoint(db, directory, 'breakpoint.db')
    const publicationEvents = faultRows(db, EVENT_PREFIX)
    const replay = commands.publishWorkflow(request) as Publication
    assert.equal(canonicalJson(replay), canonicalJson({ ...v2, replayed: true }))
    assert.deepEqual(faultRows(db, EVENT_PREFIX), publicationEvents)

    const replacement = { ...v2.definition, workflow_version: '1' }
    const immutable = commandError(() => commands.loadWorkflow(replacement))
    assert.equal(immutable.code, 'WORKFLOW_VERSION_IMMUTABLE')

    await service.release()
    service = await boot()
    const hashes = () => ['1', '2'].map(version => definitionHashOf(service.orchestra.catalog.get(workflowId, version)))
    const preDispatchHydratedHashes = hashes()
    assert.deepEqual(preDispatchHydratedHashes, [v1.definition_hash, v2.definition_hash])
    const [oldResult, fresh] = await Promise.all([
      Promise.resolve().then(() => {
        assert.equal(wake(oldRun, 'g10.continue').woken, 1)
        return dispatch(oldRun)
      }),
      Promise.resolve().then(async () => {
        const id = start('S6 G-10 new run', '2').run_id
        const gate = await dispatch(id)
        assert.deepEqual(gate.map(row => [row.node_id, row.status]), [['gate', 'waiting']])
        assert.equal(wake(id, 'g10.continue').woken, 1)
        return { id, gate, result: await dispatch(id) }
      }),
    ])
    for (const outcome of [oldResult, fresh.result]) {
      assert.deepEqual(outcome.map(row => [row.node_id, row.status]), [['result', 'waiting']])
    }
    const dispatched = workflowSnapshot(service.orchestra.db, workflowId, [oldRun, fresh.id])
    checkpoint(service.orchestra.db, directory, 'dispatched.db')

    await service.release()
    service = await boot()
    const hydrated = service.orchestra
    const hydratedHashes = hashes()
    assert.deepEqual(hydratedHashes, preDispatchHydratedHashes)
    const misses = [wake(oldRun, newMatch), wake(fresh.id, oldMatch)]
    const hits = [wake(oldRun, oldMatch), wake(fresh.id, newMatch)]
    assert.deepEqual(misses.map(row => row.woken), [0, 0])
    assert.deepEqual(hits.map(row => row.woken), [1, 1])
    const after = workflowSnapshot(hydrated.db, workflowId, [oldRun, fresh.id])
    assert.deepEqual(after.runs.map(row => row.run[0]?.status), ['succeeded', 'succeeded'])
    assert.deepEqual(after.runs.map(row => [String(row.run[0]?.workflow_version), row.run[0]?.workflow_definition_hash]),
      [['1', v1.definition_hash], ['2', v2.definition_hash]])
    assert.deepEqual(after.versions[0], before.versions[0])
    assert.deepEqual(faultRows(hydrated.db, EVENT_PREFIX).slice(0, prefix.length), prefix)
    const extra = { v1, v2, replay, immutable, oldGate, oldResult, fresh, dispatched, preDispatchHydratedHashes, hydratedHashes, misses, hits }
    writeFileSync(join(directory, 'dispatch.json'), JSON.stringify(extra, null, 2) + '\n')
    return {
      params: { phase: 'S6', pinned_rule: 'result wait event type' },
      sampleIds: { workflow_id: workflowId, old_run_id: oldRun, new_run_id: fresh.id, publish_operation_id: request.operationId },
      boundary: { reached: true, old_run_status: breakpoint.runs[0]?.run[0]?.status, v2_published: v2.version },
      snapshots: { before, breakpoint, after },
      queries: {
        half_rows: businessQuery(database, `SELECT r.* FROM runs r LEFT JOIN workflow_versions v
          ON v.workflow_id=r.workflow_id AND v.version=r.workflow_version AND v.content_hash=r.workflow_definition_hash
          WHERE r.run_id IN (?, ?) AND v.version IS NULL`, 0, oldRun, fresh.id),
        orphan_runs: businessQuery(database, ORPHAN_REFERENCES_SQL, 0),
        missing_events: missingPrefix(database, publicationEvents),
      },
      extraQueries: {
        published_versions: businessQuery(database, VERSIONS, 2, workflowId),
        old_waiting_at_publish: businessQuery('breakpoint.db', "SELECT * FROM node_runs WHERE run_id=? AND node_id='gate' AND status='waiting'", 1, oldRun),
        original_publication_receipt: businessQuery(database, "SELECT * FROM inbox WHERE operation_id=? AND status='applied' AND receipt_json IS NOT NULL", 1, request.operationId),
        both_published_events: businessQuery(database, "SELECT * FROM events WHERE type='workflow.published' AND json_extract(payload_redacted,'$.workflow_id')=? ORDER BY seq", 2, workflowId),
        old_run_v1_dispatch: pinnedWait('dispatched.db', oldRun, oldMatch),
        new_run_v2_dispatch: pinnedWait('dispatched.db', fresh.id, newMatch),
        old_run_v1_wake: wakeEvent(database, oldRun, oldMatch),
        new_run_v2_wake: wakeEvent(database, fresh.id, newMatch),
        terminal_events: businessQuery(database, "SELECT * FROM events WHERE run_id IN (?, ?) AND type='run.terminal' AND json_extract(payload_redacted,'$.status')='succeeded' ORDER BY seq", 2, oldRun, fresh.id),
      },
      artifacts: ['before.db', 'breakpoint.db', 'dispatched.db', database, 'dispatch.json'],
      extra,
    }
  } finally {
    await service.release()
    sealCheckpoint(file)
  }
}

function pinnedWait(database: string, runId: string, eventType: string) {
  return businessQuery(database, `SELECT w.* FROM wait_registrations w JOIN node_runs n ON n.node_run_id=w.node_run_id
    WHERE w.run_id=? AND n.node_id='result' AND w.state='active' AND json_extract(w.match_json,'$.type')=?`, 1, runId, eventType)
}

function wakeEvent(database: string, runId: string, eventType: string) {
  return businessQuery(database, `SELECT e.* FROM events e JOIN node_runs n ON n.node_run_id=e.node_run_id
    WHERE e.run_id=? AND n.node_id='result' AND e.type='wait.woken' AND json_extract(e.payload_redacted,'$.event_type')=?`, 1, runId, eventType)
}

type DecisionBody = { decisionId: string; revision: number; operation_id: string; resolution: 'approved' | 'rejected'; confirm_challenge?: string }
type HttpBody = { ok?: boolean; data?: { decisionId?: string; revision?: number; replayed?: boolean; status?: string; receipt_json?: string }; error?: { code: string; details?: { confirm_challenge?: string } } }
type ApprovalService = Awaited<ReturnType<typeof serveOrchestra>>

async function request(service: ApprovalService, path: string, body?: DecisionBody) {
  const response = await fetch(service.endpoint + path, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(6_000),
    headers: { 'x-orchestra-secret': SECRET, 'content-type': 'application/json', authorization: SESSION },
    ...(body && { body: JSON.stringify(body) }),
  })
  return { status: response.status, envelope: await response.json() as HttpBody }
}

const decisionRows = (db: Db, id: string) => faultRows(db, 'SELECT * FROM decisions WHERE decision_id=?', id)
const receiptRows = (db: Db, id: string) => faultRows(db, 'SELECT * FROM inbox WHERE operation_id=?', id)
const resolvePath = '/v1/decisions/resolve'
const operationPath = (id: string) => '/v1/operations/get?operation_id=' + id
const approvalInput = (decisionId: string): DecisionBody => ({ decisionId, revision: 1, operation_id: uuidv7(), resolution: 'approved' })

function race(operations: (() => Promise<Awaited<ReturnType<typeof request>>>)[]) {
  return Promise.all(operations.map(operation => Promise.resolve().then(operation)))
}

export const caseG12S6: FaultCase = async ({ directory }) => {
  const database = 'after.db'
  const file = join(directory, database)
  const boot = async () => {
    let db: Db
    const service = await serveOrchestra({
      dbFile: file, secret: SECRET, phase: 'S6',
      resolveHttpHuman: req => req.headers.authorization === SESSION ? { id: ACTOR } : null,
      asOfSeq: () => Number(db.raw.prepare('SELECT coalesce(max(seq), 0) AS seq FROM events').get()?.seq),
      listTasks: () => { throw new Error('Unexpected legacy task listing') },
      listEvents: () => { throw new Error('Unexpected legacy event listing') },
      appendLedgerEvent: () => { throw new Error('Unexpected legacy event ingress') },
    })
    db = service.orchestra.db
    return service
  }
  let service = await boot()
  try {
    const { commands, db } = service.orchestra
    const workflowId = 'wf_s6_g12'
    commands.loadWorkflow({ workflow_id: workflowId, workflow_version: '1', nodes: [{ node_id: 'wait', type: 'wait',
      wait: { wait_kind: 'event', match: { type: 'g12.pending' }, max_wait_ms: 60_000 } }] })
    const createCard = (suffix: string, confirmRequired = false) => {
      const runId = commands.startRun({ workflowId, workflowVersion: '1', taskTitle: 'S6 G-12 ' + suffix,
        now: NOW, operationId: uuidv7() }).run_id
      const id = 'dec_g12_' + suffix
      withTx(db, (tx) => openDecision(tx, { decisionId: id, runId, nodeRunId: null,
        kind: confirmRequired ? 'audit_result' : 'pre_execution', approver: 'human', confirmRequired, createdAt: NOW }))
      return id
    }
    const sameId = createCard('same')
    const distinctId = createCard('distinct')
    const confirmedId = createCard('confirmed', true)
    const controlId = createCard('core')
    withTx(db, (tx) => resolveDecision(tx, SECRET, { decisionId: controlId, revision: 1, resolution: 'approved',
      now: NOW, actor: { kind: 'human', id: ACTOR } }))
    const core = commandError(() => withTx(db, (tx) => resolveDecision(tx, SECRET, { decisionId: controlId,
      revision: 1, resolution: 'approved', now: NOW, actor: { kind: 'human', id: ACTOR } })))
    assert.equal(core.code, 'DECISION_REVISION_CONFLICT')

    const same = approvalInput(sameId)
    const distinct = [approvalInput(distinctId), approvalInput(distinctId)]
    const confirmed = [approvalInput(confirmedId), approvalInput(confirmedId)]
    const operationIds = [same, ...distinct, ...confirmed].map(body => body.operation_id)
    const cardIds = [sameId, distinctId, confirmedId, controlId]
    const snapshot = (db: Db) => ({
      decisions: cardIds.flatMap(id => decisionRows(db, id)),
      receipts: operationIds.flatMap(id => receiptRows(db, id)),
      events: faultRows(db, EVENT_PREFIX),
    })
    const prefix = faultRows(db, EVENT_PREFIX)
    const before = snapshot(db)
    checkpoint(db, directory, 'before.db')
    const preflight = await race(confirmed.map(body => () => request(service, resolvePath, body)))
    const challenged = confirmed.map((body, i) => {
      const verdict = preflight[i]!
      assert.equal(verdict.status, 409, JSON.stringify(verdict.envelope))
      assert.equal(verdict.envelope.error?.code, 'CONFIRMATION_REQUIRED')
      const token = verdict.envelope.error.details?.confirm_challenge
      assert.ok(token)
      return { ...body, confirm_challenge: token }
    })
    assert.notEqual(challenged[0]?.confirm_challenge, challenged[1]?.confirm_challenge)
    const breakpoint = snapshot(db)
    assert.deepEqual(breakpoint, before)
    checkpoint(db, directory, 'breakpoint.db')

    const sameResponses = await race([() => request(service, resolvePath, same), () => request(service, resolvePath, same)])
    const sameData = sameResponses.map(result => {
      assert.equal(result.status, 200)
      const data = result.envelope.data!
      assert.equal(data.decisionId, sameId)
      assert.equal(data.revision, 2)
      return data
    })
    assert.deepEqual(sameData.map(row => row.replayed).sort(), [false, true])
    const payloadConflict = await request(service, resolvePath, { ...same, resolution: 'rejected' })
    assert.equal(payloadConflict.status, 409)
    assert.equal(payloadConflict.envelope.error?.code, 'OPERATION_ID_CONFLICT')

    async function compete(bodies: DecisionBody[]) {
      const responses = await race(bodies.map(body => () => request(service, resolvePath, body)))
      assert.deepEqual(responses.map(row => row.status).sort(), [200, 409])
      const winnerIndex = responses.findIndex(row => row.status === 200)
      const winner = bodies[winnerIndex]!
      const loser = bodies[1 - winnerIndex]!
      assert.deepEqual(responses[winnerIndex]!.envelope.data, { decisionId: winner.decisionId, revision: 2, replayed: false })
      assert.equal(responses[1 - winnerIndex]!.envelope.error?.code, 'DECISION_REVISION_CONFLICT')
      return { winner, loser, responses }
    }
    const basic = await compete(distinct)
    const challenge = await compete(challenged)
    const winners = [same, basic.winner, challenge.winner]
    const losers = [basic.loser, challenge.loser]
    const receipt = (body: DecisionBody) => request(service, operationPath(body.operation_id))
    const [receipts, absent] = await Promise.all([Promise.all(winners.map(receipt)), Promise.all(losers.map(receipt))])
    for (const [i, result] of receipts.entries()) {
      const winner = winners[i]!
      const stored = receiptRows(db, winner.operation_id)[0]
      assert.equal(result.status, 200)
      assert.equal(result.envelope.data?.status, 'applied')
      assert.equal(result.envelope.data.receipt_json, stored?.receipt_json)
      assert.deepEqual(JSON.parse(result.envelope.data.receipt_json!).result, { decisionId: winner.decisionId, revision: 2 })
    }
    for (const [i, result] of absent.entries()) {
      assert.equal(result.status, 404)
      assert.equal(result.envelope.error?.code, 'NOT_FOUND')
      assert.deepEqual(receiptRows(db, losers[i]!.operation_id), [])
    }
    const resolved = snapshot(db)
    checkpoint(db, directory, 'resolved.db')
    await service.close()
    service = await boot()
    const restarted = await race(winners.map(body => () => request(service, resolvePath, {
      ...body, confirm_challenge: undefined,
    })))
    const after = snapshot(service.orchestra.db)
    assert.deepEqual(after, resolved)
    assert.deepEqual(restarted.map(row => row.status), [200, 200, 200])
    assert.deepEqual(restarted.map(row => row.envelope.data), winners.map(row => ({
      decisionId: row.decisionId, revision: 2, replayed: true,
    })))
    const extra = { core, same, sameResponses, payloadConflict, confirmed, preflight, basic, challenge, receipts, absent, restarted }
    writeFileSync(join(directory, 'http.json'), JSON.stringify(extra, null, 2) + '\n')
    return {
      params: { phase: 'S6', route: 'POST ' + resolvePath, fixture_cards: ['pre_execution', 'audit_result'] },
      sampleIds: { same_decision_id: sameId, distinct_decision_id: distinctId, challenge_decision_id: confirmedId,
        same_operation_id: same.operation_id, distinct_winner: basic.winner.operation_id, challenge_winner: challenge.winner.operation_id },
      boundary: { reached: true, revision: 1, same_operation_requests: 2, distinct_operation_requests: 2, preflight_challenges: 2 },
      snapshots: { before, breakpoint, after },
      queries: {
        half_rows: businessQuery(database, `SELECT * FROM inbox WHERE operation_id IN (SELECT value FROM json_each(?))
          AND (status!='applied' OR receipt_json IS NULL OR completed_at IS NULL)`, 0, JSON.stringify(operationIds)),
        orphan_runs: businessQuery(database, ORPHAN_REFERENCES_SQL, 0),
        missing_events: missingPrefix(database, prefix),
      },
      extraQueries: {
        decision_resolved_once_each: businessQuery(database,
          "SELECT * FROM decisions d WHERE decision_id IN (?, ?, ?) AND status='resolved' AND revision=2 AND (SELECT COUNT(*) FROM events e WHERE e.decision_id=d.decision_id AND e.type='decision.resolved')=1 ORDER BY decision_id",
          3, sameId, distinctId, confirmedId),
        resolved_events: businessQuery(database, "SELECT * FROM events WHERE decision_id IN (?, ?, ?) AND type='decision.resolved' ORDER BY seq",
          3, sameId, distinctId, confirmedId),
        applied_receipts: businessQuery(database, "SELECT * FROM inbox WHERE operation_id IN (?, ?, ?) AND status='applied' ORDER BY operation_id",
          3, ...winners.map(body => body.operation_id)),
        rolled_back_receipts: businessQuery(database, 'SELECT * FROM inbox WHERE operation_id IN (?, ?)', 0,
          ...losers.map(body => body.operation_id)),
        preflight_receipts: businessQuery('breakpoint.db', 'SELECT * FROM inbox WHERE operation_id IN (?, ?)', 0,
          ...confirmed.map(body => body.operation_id)),
      },
      artifacts: ['before.db', 'breakpoint.db', 'resolved.db', database, 'http.json'],
      extra,
    }
  } finally {
    await service.close()
    sealCheckpoint(file)
  }
}
