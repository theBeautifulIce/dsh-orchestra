import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { acquireLease, loadNodeRun } from '../../src/service/commands/lease.ts'
import { createNodeRun } from '../../src/service/commands/nodes.ts'
import { createModelEscalationHost, getEscalatedModel, noteAgentStopped } from '../../src/service/model-escalation.ts'
import type { ModelAssignment, ModelProfile } from '../../src/executor/model-routing.ts'
import { freshLedger, seed, TEST_SECRET as secret } from '../fixtures/ledger.ts'
import { createReworkHost } from '../../src/service/rework-coordinator.ts'
import { createModelRoutingSettingsHost } from '../../src/service/model-routing-settings.ts'

const owner = 'service:' + sha256Hex(secret).slice(0, 8)
const now = '2026-11-20T12:00:00.000Z'
const startedAt = '2026-11-20T11:58:00.000Z'
const expiresAt = '2026-11-20T12:05:00.000Z'
const profiles = [{ ref: 'low', capacity: 'routine' }, { ref: 'high', capacity: 'advanced' }] as const satisfies readonly ModelProfile[]
const normal: ModelAssignment = { model_ref: 'low', reason: '计划选型', complexity: 'routine' }
let db: Db
let dir: string
let file: string

beforeEach(() => {
  ;({ db, dir, file } = freshLedger())
  seed(db)
  withTx(db, (tx) => {
    tx.run("UPDATE node_runs SET status='blocked_post',side_effect_policy='pure',action_generation=1,started_at=? WHERE node_run_id='nr1'", [startedAt])
    appendNodeRunEvent(tx, secret, 'nr1', 'executor.model_confirmed', { model_ref: 'low', attempt: 1, action_generation: 1 })
    appendNodeRunEvent(tx, secret, 'nr1', 'verify_human', { reason: 'verdict_unmet' })
  })
})
afterEach(() => { db.raw.close(); rmSync(dir, { recursive: true, force: true }) })

function input() {
  return { operation_id: uuidv7(), run_id: 'r1', node_run_id: 'nr1', expected_attempt: 1, expected_action_generation: 1 }
}
const classify = async () => ({ classification: 'model_capability', reason: '核验发现输出契约没有满足', evidence_ids: ['node:3'], model_ref: 'high' })
it('only includes saved model notes on eligible upgrades, outside the evidence list', async () => {
  createModelRoutingSettingsHost(db, profiles).save({ operation_id: uuidv7(), expected_revision: 0,
    mapping: { routine: null, standard: null, complex: null },
    model_notes: [{ ref: 'low', note: '快速整理' }, { ref: 'high', note: '交叉核算' }],
  }, owner, now)
  const host = createModelEscalationHost(db, secret, profiles, async (request) => {
    expect(request).toMatchObject({ available_upgrades: [{ ref: 'high', user_note: '交叉核算' }] })
    expect(JSON.stringify(request)).not.toContain('快速整理')
    return classify()
  }, undefined, () => now)
  expect((await host.assess(input(), owner, now)).model_ref).toBe('high')
})
function leaseSuccessor(confirmed = true, at = now) {
  withTx(db, (tx) => {
    if (confirmed) noteAgentStopped(tx, secret, loadNodeRun(tx, 'nr1'), 1, 1)
    tx.run("UPDATE node_runs SET status='superseded' WHERE node_run_id='nr1'")
    createNodeRun(tx, { newNodeRunId: 'nr2', runId: 'r1', nodeId: 'n1', seq: 1, nodeType: 'agent', attempt: 2, originNodeRunId: 'nr1', now })
    tx.run("UPDATE node_runs SET status='dispatched',side_effect_policy='pure',action_generation=2,lease_id='current-lease',lease_expires_at=? WHERE node_run_id='nr2'",
      [new Date(Date.parse(at) + 300_000).toISOString()])
  })
}
function routed(at = now, available: readonly (ModelProfile & { provider?: string })[] = profiles) {
  return withTx(db, (tx) => getEscalatedModel(tx, secret, loadNodeRun(tx, 'nr2'), available, normal, at))
}

it('persists an owned explicit diagnosis without starting work and applies it only to the leased successor after restart', async () => {
  const planner = vi.fn(classify)
  const host = createModelEscalationHost(db, secret, profiles, planner, undefined, () => now)
  const body = input()
  const opinion = await host.assess(body, owner, now)
  expect(opinion).toMatchObject({ outcome: 'recommended', model_ref: 'high', trigger: 'execution_blocked' })
  await expect(host.assess(body, owner, now)).resolves.toEqual(opinion)
  expect(planner).toHaveBeenCalledOnce()
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM node_runs').get()?.n).toBe(1)
  expect(host.get('r1', 'nr1', owner).dispatch).toBeNull()
  await expect(host.assess(input(), 'wrong-owner', now)).rejects.toMatchObject({ code: 'FORBIDDEN' })

  db.raw.close()
  db = openDb(file)
  leaseSuccessor()
  expect(routed()).toMatchObject({ model_ref: 'high', reason: opinion.reason, escalation_from: 'nr1' })
  expect(routed(now, [profiles[0]])).toEqual(normal)
  expect(routed(now, [profiles[0], { ...profiles[1], provider: 'different' }])).toEqual(normal)
  withTx(db, (tx) => {
    tx.run("UPDATE node_runs SET lease_id='old-lease',lease_expires_at=? WHERE node_run_id='nr1'", [expiresAt])
  })
  expect(routed()).toEqual(normal)
  await expect(createModelEscalationHost(db, secret, profiles, planner).assess(input(), owner, now))
    .rejects.toMatchObject({ code: 'STALE_GENERATION' })
})

it('rejects time or timeout alone, preserves external-wait conclusions, and reports lack of a higher model', async () => {
  withTx(db, (tx) => tx.run("UPDATE node_runs SET status='started' WHERE node_run_id='nr1'"))
  const weak = createModelEscalationHost(db, secret, profiles,
    async () => ({ classification: 'model_efficiency', reason: '耗时较长', evidence_ids: ['clock'], model_ref: 'high' }), undefined, () => now)
  await expect(weak.assess(input(), owner, now)).rejects.toMatchObject({ code: 'PAYLOAD_SCHEMA_INVALID' })
  const external = createModelEscalationHost(db, secret, profiles,
    async () => ({ classification: 'waiting_external', reason: '依赖尚待回应', evidence_ids: ['clock'] }), undefined, () => now)
  await expect(external.assess(input(), owner, now)).resolves.toMatchObject({ outcome: 'kept', trigger: 'prolonged_runtime' })

  withTx(db, (tx) => tx.run("UPDATE node_runs SET status='waiting' WHERE node_run_id='nr1'"))
  await expect(external.assess(input(), owner, now)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  withTx(db, (tx) => tx.run("UPDATE node_runs SET status='blocked_post' WHERE node_run_id='nr1'"))
  const capped = createModelEscalationHost(db, secret, [profiles[0]],
    async () => ({ classification: 'model_capability', reason: '核验发现输出契约没有满足', evidence_ids: ['node:3'] }), undefined, () => now)
  await expect(capped.assess(input(), owner, now)).resolves.toMatchObject({ outcome: 'no_higher_model' })
  leaseSuccessor()
  expect(routed()).toEqual(normal)
})

it('rechecks facts changed by a concurrent action and can diagnose a preleased legal retry', async () => {
  const host = createModelEscalationHost(db, secret, profiles, async () => {
    withTx(db, (tx) => tx.run("UPDATE node_runs SET recovery_uncertain='unknown' WHERE node_run_id='nr1'"))
    return classify()
  }, undefined, () => now)
  await expect(host.assess(input(), owner, now)).rejects.toMatchObject({ code: 'STALE_GENERATION' })
  withTx(db, (tx) => tx.run("UPDATE node_runs SET recovery_uncertain=NULL WHERE node_run_id='nr1'"))
  leaseSuccessor()
  const restored = createModelEscalationHost(db, secret, profiles, classify, undefined, () => now)
  await restored.prepare('nr2', 2, now)
  expect(routed()).toMatchObject({ model_ref: 'high' })
})

it('keeps the normal model when the predecessor has no stop confirmation', async () => {
  const host = createModelEscalationHost(db, secret, profiles, classify, undefined, () => now)
  await host.assess(input(), owner, now)
  leaseSuccessor(false)
  expect(routed()).toEqual(normal)
})

it('uses a diagnosis committed within the dispatch second without admitting future or expired opinions', async () => {
  leaseSuccessor()
  let assessmentAt = now
  const committedAt = '2026-11-20T12:00:00.080Z'
  const host = createModelEscalationHost(db, secret, profiles, async () => {
    assessmentAt = committedAt
    return classify()
  }, undefined, () => assessmentAt)
  await host.prepare('nr2', 2, now)
  const opinion = host.get('r1', 'nr1', owner).item!
  expect(opinion.decided_at).toBe(committedAt)
  const select = () => withTx(db, (tx) => host.select(tx, loadNodeRun(tx, 'nr2'), profiles, normal, now))
  expect(select()).toMatchObject({ model_ref: 'high', escalation_from: 'nr1' })
  assessmentAt = '2026-11-20T12:00:00.079Z'
  expect(select()).toEqual(normal)
  assessmentAt = opinion.expires_at
  expect(select()).toEqual(normal)
})

it('refreshes an expired opinion against the same facts at the next authorized dispatch', async () => {
  let at = now
  const planner = vi.fn(classify)
  const host = createModelEscalationHost(db, secret, profiles, planner, undefined, () => at)
  const first = await host.assess(input(), owner, now)
  at = '2026-11-20T12:45:00.000Z'
  leaseSuccessor(true, at)
  expect(routed(at)).toEqual(normal)
  await host.prepare('nr2', 2, at)
  const refreshed = host.get('r1', 'nr1', owner).item
  expect(planner).toHaveBeenCalledTimes(2)
  expect(refreshed?.fingerprint).toBe(first.fingerprint)
  expect(refreshed?.decided_at).toBe(at)
  expect(routed(at)).toMatchObject({ model_ref: 'high' })
})

it('reuses a current diagnosis for a new operation and refreshes it after the host clock moves backwards', async () => {
  let at = '2026-11-20T12:00:00.080Z'
  const planner = vi.fn(classify)
  const host = createModelEscalationHost(db, secret, profiles, planner, undefined, () => at)
  const original = input()
  const first = await host.assess(original, owner, at)
  at = '2026-11-20T12:00:00.081Z'
  await expect(host.assess(input(), owner, at)).resolves.toEqual(first)
  expect(planner).toHaveBeenCalledOnce()

  at = '2026-11-20T12:00:00.079Z'
  await expect(host.assess(original, owner, at)).resolves.toEqual(first)
  expect(planner).toHaveBeenCalledOnce()
  const refreshed = await host.assess(input(), owner, at)
  expect(refreshed).toMatchObject({ fingerprint: first.fingerprint, decided_at: at })
  expect(planner).toHaveBeenCalledTimes(2)
})

it('rotates the maintenance cursor past a page of nodes that lack model evidence', async () => {
  withTx(db, (tx) => {
    tx.run("UPDATE node_runs SET updated_at=? WHERE node_run_id='nr1'", [now])
    for (let index = 0; index < 20; index++) {
      tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,started_at,created_at,updated_at)"
        + " VALUES(?,'r1',?,?,'agent','started','pure',?,?,?)", ['unevidenced-' + index, 'role-' + index, index + 10, startedAt, startedAt, startedAt])
    }
  })
  let at = now
  const planner = vi.fn(classify)
  const host = createModelEscalationHost(db, secret, profiles, planner, undefined, () => at)
  host.tick(now)
  expect(planner).not.toHaveBeenCalled()
  at = '2026-11-20T12:00:05.000Z'
  host.tick(at)
  await expect.poll(() => host.get('r1', 'nr1', owner).item?.outcome).toBe('recommended')
})

it('counts two verified changes on the same node and uses the diagnosis on the next authorized rework dispatch', async () => {
  function artifact(nodeRunId: string, id: string) {
    const bytes = Buffer.from('valid test artifact ' + id)
    const hash = sha256Hex(bytes)
    withTx(db, (tx) => {
      tx.run("INSERT INTO artifacts(artifact_id,run_id,uri,sha256,created_at) VALUES(?,'r1',?,?,?)", [id, 'artifact://' + id, hash, now])
      tx.run('INSERT INTO artifact_contents VALUES(?,?,?,?)', [id, id + '.txt', nodeRunId, bytes])
    })
    return hash
  }
  withTx(db, (tx) => {
    tx.run("UPDATE runs SET workflow_id='wf',workflow_version='1' WHERE run_id='r1'")
    tx.run('INSERT INTO workflow_versions(workflow_id,version,content_hash,definition_json,created_at) VALUES(?,?,?,?,?)',
      ['wf', '1', 'test-hash', JSON.stringify({ nodes: [{ node_id: 'n1', type: 'agent' }] }), now])
    tx.run("UPDATE node_runs SET status='done' WHERE node_run_id='nr1'")
  })
  const feedback = createReworkHost(db, secret)
  let request = feedback.request({ operation_id: uuidv7(), run_id: 'r1', target_node_run_id: 'nr1', expected_revision: 1,
    source_artifact_id: 'source', source_artifact_hash: artifact('nr1', 'source'), reason: '完善核验', expected_result: '逐项列出依据',
    suggested_scope: 'targeted_revision' }, owner, now)
  const planner = vi.fn(async (input: unknown) => {
    const facts = (input as { facts: Array<{ id: string; kind: string }> }).facts.filter((fact) => fact.kind === 'artifact_rejected')
    expect(facts).toHaveLength(2)
    return { classification: 'model_capability', reason: '两个成果均遗漏关键依据', evidence_ids: facts.map((fact) => fact.id), model_ref: 'high' }
  })
  const escalation = createModelEscalationHost(db, secret, profiles, planner, undefined, () => now)
  for (let round = 1; round <= 2; round++) {
    const nodeRunId = request.new_node_run_id!
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status='done',revision=revision+1 WHERE node_run_id=?", [nodeRunId])
      const node = loadNodeRun(tx, nodeRunId)
      appendNodeRunEvent(tx, secret, nodeRunId, 'executor.model_used',
        { model_ref: 'low', attempt: node.attempt, action_generation: node.action_generation })
      noteAgentStopped(tx, secret, node, node.attempt, node.action_generation)
    })
    const artifactId = 'round-' + round
    const hash = artifact(nodeRunId, artifactId)
    feedback.recover(now)
    request = feedback.get(request.request_id, owner).item.request
    request = feedback.review({ operation_id: uuidv7(), request_id: request.request_id, expected_revision: request.revision, action: 'request_changes',
      note: '本轮交付遗漏支撑结论的对应依据', artifact_id: artifactId, artifact_hash: hash }, owner, now)
    if (round === 1) expect(escalation.get('r1', nodeRunId, owner).precondition).toBeNull()
    request = feedback.review({ operation_id: uuidv7(), request_id: request.request_id, expected_revision: request.revision,
      action: 'authorize', note: '授权下一轮' }, owner, now)
  }
  const nextId = request.new_node_run_id!
  const lease = withTx(db, (tx) => acquireLease(tx, secret, { nodeRunId: nextId, ownerEpoch: db.epoch, leaseTtlMs: 30_000, now }))
  await escalation.prepare(nextId, lease.actionGeneration, now)
  const selected = withTx(db, (tx) => getEscalatedModel(tx, secret, loadNodeRun(tx, nextId), profiles, normal, now))
  expect(planner).toHaveBeenCalledOnce()
  expect(selected).toMatchObject({ model_ref: 'high', reason: '两个成果均遗漏关键依据' })
})
