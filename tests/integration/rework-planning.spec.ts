import { expect, it } from 'vitest'
import { sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { registerRunArtifact } from '../../src/service/artifact-store.ts'
import { createDeliveryReviewHost } from '../../src/service/delivery-review.ts'
import { createReworkHost } from '../../src/service/rework-coordinator.ts'
import { executionFeedbackContext } from '../../src/service/rework-execution.ts'
import { createReworkPlanningHost } from '../../src/service/rework-planning.ts'
import { WorkflowCatalog } from '../../src/service/workflows.ts'
import { closeRun } from '../../src/service/commands/run-close.ts'
import { TEST_SECRET, freshLedger, seed } from '../fixtures/ledger.ts'

const operator = 'service:' + sha256Hex(TEST_SECRET).slice(0, 8)
function setup(parallel = false) {
  const { db } = freshLedger()
  seed(db)
  const now = new Date().toISOString()
  const catalog = new WorkflowCatalog('S5', db, () => true)
  const ids = parallel ? ['n1','n2','n3'] : ['n1','n2']
  catalog.load({ workflow_id: 'feedback', workflow_version: '1', nodes: ids.map(node_id => ({ node_id, type: 'agent', side_effect_policy: 'pure' })),
    edges: ids.slice(1).map(to => ({ from: 'n1', to })) })
  withTx(db, tx => {
    tx.run("UPDATE runs SET workflow_id='feedback',workflow_version='1',workflow_definition_hash=? WHERE run_id='r1'", [catalog.definitionHash('feedback','1')])
    tx.run("UPDATE node_runs SET status='done',side_effect_policy='pure' WHERE node_run_id='nr1'")
    tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,created_at,updated_at) VALUES('nr2','r1','n2',2,'agent','queued','pure',?,?)", [now, now])
    if (parallel) tx.run("INSERT INTO node_runs(node_run_id,run_id,node_id,seq,node_type,status,side_effect_policy,created_at,updated_at) VALUES('nr3','r1','n3',3,'agent','queued','pure',?,?)", [now, now])
  })
  registerRunArtifact(db, { artifactId: 'old', runId: 'r1', nodeRunId: 'nr1', bytes: Buffer.from('draft'), fileName: 'report.md' })
  const feedback = createReworkHost(db, TEST_SECRET)
  const request = () => feedback.request({ operation_id: uuidv7(), run_id: 'r1', target_node_run_id: 'nr1',
    expected_revision: 1, source_artifact_id: 'old', source_artifact_hash: sha256Hex('draft'), reason: '缺少样本', expected_result: '附真实样本',
    suggested_scope: 'replan_subgraph' }, operator, now)
  return { db, catalog, now, request }
}

it('validates the local planner scope before writes, pins approval, and injects only the approved instructions', async () => {
  const { db, catalog, now, request } = setup()
  try {
    const row = request()
    const body = { request_id: row.request_id, expected_revision: row.revision, operation_id: uuidv7() }
    const proposal = { reason: '校正数据收集及分析方法', changes: [{ node_id: 'n1', instruction: '收集实测时间' },
      { node_id: 'n2', instruction: '按采样时间重算均值' }], preserved_node_ids: [] }
    let output: unknown = { ...proposal, tools: ['write'] }
    let calls = 0
    const planning = createReworkPlanningHost(db, TEST_SECRET, async () => { calls++; return output })
    const events = db.raw.prepare('SELECT COUNT(*) AS n FROM events').get()?.n
    await expect(planning.propose(body, operator, now)).rejects.toThrow()
    output = { ...proposal, changes: [{ node_id: 'unrelated', instruction: '改动其他节点' }] }
    await expect(planning.propose(body, operator, now)).rejects.toThrow()
    expect(planning.get(row.request_id, operator).plan).toBeNull()
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(events)
    output = proposal
    const plan = await planning.propose(body, operator, now)
    expect(await planning.propose(body, operator, now)).toEqual(plan)
    expect(calls).toBe(3)
    const approval = { ...body, operation_id: uuidv7(), plan_hash: plan.plan_hash }
    expect(() => planning.approve({ ...approval, plan_hash: '0'.repeat(64) }, operator, now)).toThrow()
    expect(() => planning.approve(approval, 'other', now)).toThrow()
    const revised = planning.approve(approval, operator, now)
    expect(planning.approve(approval, operator, now)).toEqual(revised)
    expect(revised.approved_scope).toBe('replan_subgraph')
    expect(executionFeedbackContext(db, catalog, revised.new_node_run_id!, now).plan_instruction)
      .toEqual({ plan_hash: plan.plan_hash, instruction: proposal.changes[0]!.instruction })
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM node_runs WHERE node_id='n1'").get()?.n).toBe(2)
  } finally { db.raw.close() }
})

it('adds a scoped check before an affected step, preserves pinned topology and rejects cyclic or privileged changes', async () => {
  const { db, catalog, now, request } = setup(true)
  try {
    const row = request()
    const body = { request_id: row.request_id, expected_revision: row.revision, operation_id: uuidv7() }
    const proposal = { reason: '先核验数据，再生成最终报告', changes: [
      { node_id: 'n1', instruction: '补采样时间' }, { node_id: 'n3', instruction: '引用核验结果' }],
      preserved_node_ids: ['n2'], additional_edges: [{ from:'n2', to:'n3' }],
      insert_steps: [{ node_id: 'rw_check', before_node_id: 'n3', instruction: '核验采样记录' }] }
    let output: unknown = { ...proposal, additional_edges: [{ from:'n3',to:'n1' }] }
    const host = createReworkPlanningHost(db, TEST_SECRET, async () => output)
    await expect(host.propose(body, operator, now)).rejects.toThrow()
    output = { ...proposal, insert_steps: [{ ...proposal.insert_steps[0], tools: ['write'] }] }
    await expect(host.propose(body, operator, now)).rejects.toThrow()
    output = proposal
    const plan = await host.propose(body, operator, now)
    expect(host.topology('r1', operator).steps).toEqual([])
    const accept = { ...body, operation_id: uuidv7(), plan_hash: plan.plan_hash }
    const approved = host.approve(accept, operator, now)
    expect(approved.budget_remaining).toBe(row.budget_remaining - 3)
    expect(host.approve(accept, operator, now)).toEqual(approved)
    expect(catalog.get('feedback', '1').nodes).toHaveLength(3)
    const actual = host.topology('r1', operator)
    expect(actual.steps).toEqual(proposal.insert_steps)
    expect(actual.edges).toEqual(expect.arrayContaining([{from:'n2',to:'n3'}, {from:'n1',to:'rw_check'},
      {from:'n2',to:'rw_check'}, {from:'rw_check',to:'n3'}]))
    expect(actual.held_node_ids).toContain('n3')
  } finally { db.raw.close() }
})

it('holds a final delivery before close, rejects stale bytes and closes on explicit acceptance', () => {
  const { db, now } = setup()
  try {
    const delivery = createDeliveryReviewHost(db, TEST_SECRET)
    const hold = { run_id: 'r1', node_run_id: 'nr1', action: 'hold' as const, operation_id: uuidv7() }
    delivery.change(hold, operator, now)
    withTx(db, tx => tx.run("UPDATE node_runs SET status='done' WHERE node_run_id='nr2'"))
    expect(withTx(db, tx => closeRun(tx, TEST_SECRET, 'r1', now))).toBeNull()
    const accept = { ...hold, operation_id: uuidv7(), action: 'accept' as const, artifact_id: 'old', sha256: sha256Hex('draft') }
    expect(() => delivery.change({ ...accept, sha256: '0'.repeat(64) }, operator, now)).toThrow()
    expect(() => delivery.change(accept, 'other', now)).toThrow()
    delivery.change(accept, operator, now)
    expect(db.raw.prepare("SELECT status FROM runs WHERE run_id='r1'").get()?.status).toBe('succeeded')
    expect(delivery.list(operator, 'r1').items[0]).toMatchObject({ status: 'accepted', sha256: accept.sha256 })
  } finally { db.raw.close() }
})

