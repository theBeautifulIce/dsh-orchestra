import { rmSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { canonicalJson, sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import type { ModelCatalogProfile, ModelComplexity, ModelRouting } from '../../src/executor/model-routing.ts'
import { resolveModelAssignment } from '../../src/executor/run-node.ts'
import { appendNodeRunEvent } from '../../src/infra/db/ledger.ts'
import { withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { recoverChatModelAssignment, type ChatModelRecoveryChecks } from '../../src/service/chat-model-recovery.ts'
import { loadNodeRun } from '../../src/service/commands/lease.ts'
import { createModelRoutingSettingsHost } from '../../src/service/model-routing-settings.ts'
import { freshLedger, TEST_SECRET } from '../fixtures/ledger.ts'

const now = '2026-11-01T00:00:00.000Z'
const sessionModel = { ref: 'selected/model', provider: 'selected', model: 'model', capacity: null } satisfies ModelCatalogProfile
const strongerModel = { ref: 'approved/reasoner', provider: 'approved', model: 'reasoner', capacity: 'advanced' } satisfies ModelCatalogProfile

function seedChat(db: Db, options: { level?: ModelComplexity; generation?: number; reason?: string } = {}) {
  withTx(db, (tx) => {
    tx.run("INSERT INTO tasks (task_id,title,status,revision,created_at,updated_at) VALUES ('task','汇总','running',1,?,?)", [now, now])
    tx.run("INSERT INTO runs (run_id,task_id,status,revision,workflow_id,workflow_version,created_at,updated_at) VALUES ('run','task','running',1,'wf',1,?,?)", [now, now])
    tx.run(`INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,revision,side_effect_policy,action_generation,created_at,updated_at)
      VALUES ('first','run','first',1,'agent','done',1,'pure',1,?,?),('review','run','review',2,'agent','blocked_pre',3,'pure',1,?,?)`, [now, now, now, now])
    const brief = { goal: '汇总证据', requirements: [] }
    const proposal = { title: '汇总', workflow_id: 'wf', workflow_version: '1',
      steps: [{ node_id: 'review', description: '合并前置结果', goal_ids: ['goal'], depends_on: ['first'], tools: [],
        complexity: options.level ?? 'advanced', model_reason: '汇总多份结果' }],
      deliverables: [{ title: '汇总', node_id: 'review', goal_ids: ['goal'],
        acceptance: { kind: 'artifact', file_name: 'summary.md', minimum_bytes: 8 } }], risks: [] }
    const quality = { ready: true, checks: [] }
    const hash = sha256Hex(canonicalJson({ schema: 1, brief, proposal, quality, workflow_hash: null }))
    tx.run(`INSERT INTO task_plans (plan_id,created_by,input_json,proposal_json,quality_json,workflow_hash,content_hash,launch_operation_id,created_at)
      VALUES ('plan','owner',?,?,?,NULL,?,'operation',?)`, [JSON.stringify(brief), JSON.stringify(proposal), JSON.stringify(quality), hash, now])
    tx.run("INSERT INTO start_run_operations (operation_id,task_id,run_id,created_at) VALUES ('operation','task','run',?)", [now])
    tx.run("INSERT INTO chat_task_receipts (message_key,request_key,input_hash,plan_id) VALUES ('message','request','hash','plan')")
    appendNodeRunEvent(tx, TEST_SECRET, 'first', 'status_changed', { to: 'done', attempt: 1, action_generation: 1 })
    appendNodeRunEvent(tx, TEST_SECRET, 'review', 'lease_acquired', { action_generation: 1 })
    appendNodeRunEvent(tx, TEST_SECRET, 'review', 'status_changed', { from: 'dispatched', to: 'blocked_pre', attempt: 1,
      action_generation: options.generation, reason: options.reason ?? 'model_assignment_unavailable' })
    appendNodeRunEvent(tx, TEST_SECRET, 'review', 'verify_human', { reason: options.reason ?? 'model_assignment_unavailable', status: 'blocked_pre' })
  })
}

function fixtureCatalog() {
  let profiles: ModelCatalogProfile[] = [sessionModel, { ...sessionModel, ref: 'other/model', provider: 'other' }]
  const catalog = () => ({ profiles, session_execution_model_ref: sessionModel.ref })
  const routing: ModelRouting = { catalog, refresh: vi.fn(async () => {}), profiles: [],
    recommend: () => { throw new Error('Expected approved plan recommendation') } }
  return { routing, catalog, setProfiles(replacement: ModelCatalogProfile[]) { profiles = replacement } }
}

function dbFixture() {
  const { db, dir } = freshLedger()
  return { db, close() { db.raw.close(); rmSync(dir, { force: true, recursive: true }) } }
}

it('uses the live session model only as an unassessed fallback and respects explicit classification and binding', () => {
  const { db, close } = dbFixture()
  try {
    seedChat(db)
    const { routing, catalog, setProfiles } = fixtureCatalog()
    const choose = () => withTx(db, (tx) => resolveModelAssignment(tx, db, loadNodeRun(tx, 'review'), routing))
    expect(choose()).toMatchObject({ model_ref: sessionModel.ref, complexity: 'advanced', session_model_fallback: true,
      reason: expect.stringContaining('能力未评估') })
    setProfiles([strongerModel, sessionModel])
    expect(choose()).toMatchObject({ model_ref: strongerModel.ref, complexity: 'advanced' })
    expect(choose().session_model_fallback).toBeUndefined()
    const settings = createModelRoutingSettingsHost(db, catalog)
    const auto = { routine: null, standard: null, advanced: null, complex: null }
    settings.save({ operation_id: uuidv7(), expected_revision: 0, mapping: auto,
      model_capacities: [{ ref: sessionModel.ref, capacity: 'standard' }] }, 'owner', now)
    setProfiles([sessionModel])
    expect(choose).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    setProfiles([strongerModel, sessionModel])
    settings.save({ operation_id: uuidv7(), expected_revision: 1, mapping: { ...auto, advanced: strongerModel.ref },
      model_capacities: [{ ref: sessionModel.ref, capacity: null }] }, 'owner', now)
    setProfiles([sessionModel])
    expect(choose).toThrow('指定模型已从 DSH 目录移除或能力不足')
  } finally { close() }
})

it('does not send expert work to an unassessed model or route to a removed session model', async () => {
  const { db, close } = dbFixture()
  try {
    seedChat(db, { level: 'expert' })
    const { routing, setProfiles } = fixtureCatalog()
    const input = { actor: 'owner', runId: 'run', signal: new AbortController().signal, checked: new Map() as ChatModelRecoveryChecks, isCurrent: () => true }
    expect(await recoverChatModelAssignment(db, TEST_SECRET, routing, input)).toEqual({ resumed: 0, retrying: [] })
    expect(await recoverChatModelAssignment(db, TEST_SECRET, routing, input)).toEqual({ resumed: 0, retrying: [] })
    expect(routing.refresh).toHaveBeenCalledTimes(1)
    setProfiles([])
    expect(withTx(db, (tx) => loadNodeRun(tx, 'review').status)).toBe('blocked_pre')
  } finally { close() }
})

it.each([undefined, 1])('requeues a signed, still-unstarted chat node once with generation field %s', async (generation) => {
  const { db, close } = dbFixture()
  try {
    seedChat(db, { generation })
    const { routing } = fixtureCatalog()
    const input = { actor: 'owner', runId: 'run', signal: new AbortController().signal, checked: new Map() as ChatModelRecoveryChecks, isCurrent: () => true }
    expect(await recoverChatModelAssignment(db, TEST_SECRET, routing, { ...input, actor: 'different-actor' })).toEqual({ resumed: 0, retrying: [] })
    withTx(db, (tx) => tx.run(`INSERT INTO decisions (decision_id,run_id,node_run_id,kind,status,revision,payload_json,created_at)
      VALUES ('approval','run','review','pre_execution','pending',1,'{}',?)`, [now]))
    expect(await recoverChatModelAssignment(db, TEST_SECRET, routing, input)).toEqual({ resumed: 0, retrying: [] })
    expect(routing.refresh).not.toHaveBeenCalled()
    withTx(db, (tx) => tx.run("UPDATE decisions SET status='resolved' WHERE decision_id='approval'"))
    expect(await recoverChatModelAssignment(db, TEST_SECRET, routing, input)).toEqual({ resumed: 1, retrying: [] })
    expect(withTx(db, (tx) => loadNodeRun(tx, 'first'))).toMatchObject({ status: 'done', action_generation: 1 })
    expect(withTx(db, (tx) => loadNodeRun(tx, 'review'))).toMatchObject({ status: 'queued', attempt: 1, action_generation: 1 })
    withTx(db, (tx) => {
      tx.run("UPDATE node_runs SET status='blocked_pre',action_generation=2 WHERE node_run_id='review'")
      appendNodeRunEvent(tx, TEST_SECRET, 'review', 'lease_acquired', { action_generation: 2 })
      appendNodeRunEvent(tx, TEST_SECRET, 'review', 'status_changed', { from: 'dispatched', to: 'blocked_pre',
        attempt: 1, action_generation: 2, reason: 'model_assignment_unavailable' })
      appendNodeRunEvent(tx, TEST_SECRET, 'review', 'verify_human', { reason: 'model_assignment_unavailable', status: 'blocked_pre' })
    })
    expect(await recoverChatModelAssignment(db, TEST_SECRET, routing, { ...input, checked: new Map() })).toEqual({ resumed: 0, retrying: [] })
    expect(routing.refresh).toHaveBeenCalledTimes(1)
  } finally { close() }
})


it('isolates malformed node events so the other blocked node can be recovered', async () => {
  const { db, close } = dbFixture()
  try {
    seedChat(db)
    withTx(db, (tx) => {
      tx.run(`INSERT INTO node_runs (node_run_id,run_id,node_id,seq,node_type,status,revision,side_effect_policy,action_generation,created_at,updated_at)
        VALUES ('bad','run','bad',3,'agent','blocked_pre',3,'pure',1,?,?)`, [now, now])
      appendNodeRunEvent(tx, TEST_SECRET, 'bad', 'lease_acquired', { action_generation: 1 })
      const { hash } = appendNodeRunEvent(tx, TEST_SECRET, 'bad', 'status_changed',
        { from:'dispatched',to:'blocked_pre',attempt:1,reason:'model_assignment_unavailable' })
      tx.run(`INSERT INTO node_run_events (node_run_id,seq,type,prev_hash,hash,payload,created_at)
        VALUES ('bad',3,'verify_human',?,?,'damaged json',?)`, [hash, 'invalid hash', now])
    })
    const { routing } = fixtureCatalog()
    const input = { actor: 'owner', runId: 'run', signal: new AbortController().signal,
      checked: new Map() as ChatModelRecoveryChecks, isCurrent: () => true }
    expect(await recoverChatModelAssignment(db, TEST_SECRET, routing, input)).toEqual({ resumed: 1, retrying: [] })
    expect(withTx(db, (tx) => loadNodeRun(tx, 'bad').status)).toBe('blocked_pre')
    expect(withTx(db, (tx) => loadNodeRun(tx, 'review').status)).toBe('queued')
  } finally { close() }
})

it.each([true, false])('bounds catalog failures and can recover on the next probe if available %s', async (recovers) => {
  const { db, close } = dbFixture()
  try {
    seedChat(db)
    const { routing } = fixtureCatalog()
    let clock = Date.parse(now)
    let available = false
    const refresh = vi.fn(async () => {
      if (!available) throw new Error('temporary catalog outage')
    })
    routing.refresh = refresh
    const input = { actor: 'owner', runId: 'run', signal: new AbortController().signal,
      checked: new Map() as ChatModelRecoveryChecks, isCurrent: () => true, clock: () => clock }
    const recover = () => recoverChatModelAssignment(db, TEST_SECRET, routing, input)
    expect(await recover()).toEqual({ resumed: 0, retrying: ['review'] })
    clock += 1_000
    expect(await recover()).toEqual({ resumed: 0, retrying: ['review'] })
    expect(refresh).toHaveBeenCalledTimes(1)
    clock += 1_000
    available = recovers
    expect(await recover()).toEqual({ resumed: recovers ? 1 : 0, retrying: recovers ? [] : ['review'] })
    clock += 4_000
    expect(await recover()).toEqual({ resumed: 0, retrying: [] })
    clock += 40_000
    expect(await recover()).toEqual({ resumed: 0, retrying: [] })
    expect(refresh).toHaveBeenCalledTimes(recovers ? 2 : 3)
  } finally { close() }
})
