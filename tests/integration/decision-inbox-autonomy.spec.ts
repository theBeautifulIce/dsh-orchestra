import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import { applySteps, defaultMigrationsDir, loadSteps, type SchemaStep } from '../../src/infra/db/migrate.ts'
import { openDb, withTx, type Db } from '../../src/infra/sqlite/driver.ts'
import { acknowledgeDecision, ensurePreExecutionDecision, openDecision, sweepDecisions } from '../../src/service/commands/decisions.ts'
import { setTaskAutonomy, startRun } from '../../src/service/commands/start-run.ts'
import { listDecisions, type DecisionView } from '../../src/service/queries/decisions.ts'
import { getTaskSummary, listTaskSummaries } from '../../src/service/queries/tasks.ts'
import { catalogFor, TEST_SECRET } from '../fixtures/ledger.ts'

const NOW = '2026-11-20T00:00:00.000Z'
const INBOX_MIGRATION = 62

function applyInboxAndLaterMigrations(db: Db, migrations: SchemaStep[]) {
  expect(applySteps(db, migrations.filter((step) => step.version <= INBOX_MIGRATION))).toEqual([INBOX_MIGRATION])
  expect(applySteps(db, migrations)).toEqual(migrations.filter((step) => step.version > INBOX_MIGRATION).map((step) => step.version))
}

it('only routes required autonomous decisions to the approval center and task workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-decision-inbox-'))
  const service = await serveOrchestra({
    dbFile: join(dir, 'db.sqlite'), secret: TEST_SECRET, phase: 'S5',
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'e' }),
  })
  try {
    const { db } = service.orchestra
    const catalog = catalogFor(['n1', 'n2'])
    const start = (operationId: string, autonomy: 'autonomous' | 'assisted' | 'supervised') =>
      startRun(db, catalog, { workflowVersion: '1', taskTitle: operationId, operationId, now: NOW, autonomy })
    const auto = start('op-auto', 'autonomous')
    const assisted = start('op-assisted', 'assisted')
    const supervised = start('op-supervised', 'supervised')
    const required = start('op-required', 'autonomous')
    const nominated = startRun(db, catalog, { workflowVersion: '1', taskTitle: '点名决定', operationId: 'op-nominated',
      now: NOW, escalations: [{ kind: 'action_category', value: 'review' }] })
    withTx(db, (tx) => {
      const node = (runId: string, nodeId: string) => tx.get<{ node_run_id: string }>(
        'SELECT node_run_id FROM node_runs WHERE run_id = ? AND node_id = ?', [runId, nodeId],
      )!.node_run_id
      for (const run of [auto, assisted, supervised]) {
        tx.run("UPDATE node_runs SET side_effect_policy = 'pure' WHERE run_id = ?", [run.run_id])
        openDecision(tx, { decisionId: run.autonomy, runId: run.run_id, nodeRunId: node(run.run_id, 'n1'),
          kind: 'audit_result', createdAt: NOW })
      }
      openDecision(tx, { decisionId: 'audit-role', runId: assisted.run_id, nodeRunId: node(assisted.run_id, 'n2'),
        kind: 'audit_result', approver: 'agent:auditor', createdAt: NOW })
      ensurePreExecutionDecision(tx, { decisionId: 'irreversible', runId: required.run_id, nodeRunId: node(required.run_id, 'n1'),
        kind: 'pre_execution', policy: 'irreversible', createdAt: NOW })
      openDecision(tx, { decisionId: 'human-only', runId: required.run_id, nodeRunId: null,
        kind: 'audit_result', approver: 'human', createdAt: NOW })
      openDecision(tx, { decisionId: 'report-conflict', runId: required.run_id, nodeRunId: node(required.run_id, 'n2'),
        kind: 'report_contradicted', createdAt: NOW })
      openDecision(tx, { decisionId: 'nominated', runId: nominated.run_id, nodeRunId: null,
        kind: 'audit_result', payload: { action_category: 'review' }, createdAt: NOW })
    })

    const get = async (path: string) => {
      const response = await fetch(service.endpoint + path, { headers: { 'x-orchestra-secret': TEST_SECRET } })
      expect(response.status).toBe(200)
      return (await response.json() as { data: unknown }).data
    }
    const inboxIds = async () => ((await get('/v1/decisions?inbox=human')) as { items: DecisionView[] })
      .items.map((item) => item.decision_id).sort()
    const expectedInbox = ['assisted', 'human-only', 'irreversible', 'nominated', 'report-conflict', 'supervised']
    expect(await inboxIds()).toEqual(expectedInbox)
    const first = await get('/v1/decisions?inbox=human&limit=2') as { items: DecisionView[]; next_cursor: string }
    const rest = await get('/v1/decisions?inbox=human&cursor=' + encodeURIComponent(first.next_cursor)) as { items: DecisionView[] }
    expect([...first.items, ...rest.items].map((item) => item.decision_id).sort()).toEqual(expectedInbox)
    expect((await fetch(service.endpoint + '/v1/decisions?cursor=' + encodeURIComponent(first.next_cursor),
      { headers: { 'x-orchestra-secret': TEST_SECRET } })).status).toBe(409)
    expect(await get('/v1/tasks/get?task_id=' + auto.task_id)).toMatchObject({ attention: 'running', open_decision_count: 0 })
    expect(await get('/v1/tasks/get?task_id=' + assisted.task_id)).toMatchObject({ attention: 'decision', lane: 'attention', open_decision_count: 1 })
    expect(await get('/v1/tasks/get?task_id=' + nominated.task_id)).toMatchObject({ open_decision_count: 1 })
    expect(await get('/v1/workspace/overview')).toMatchObject({ open_decisions: expectedInbox.length })
    expect(await get('/v1/decisions?run_id=' + auto.run_id)).toMatchObject({ items: [{ decision_id: 'autonomous', status: 'pending' }] })
    expect(await get('/v1/decisions?run_id=' + assisted.run_id)).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ decision_id: 'audit-role', status: 'pending' })]),
    })
    expect(await get('/v1/decisions/get?decision_id=autonomous')).toMatchObject({ allowed_resolutions: ['approved', 'rejected'] })
    expect(await get('/v1/decisions/get?decision_id=nominated')).toMatchObject({ confirm_required: true })
    expect(await get('/v1/decisions/get?decision_id=audit-role')).toMatchObject({ allowed_resolutions: [] })
    expect(() => withTx(db, (tx) => acknowledgeDecision(tx, {
      decisionId: 'audit-role', revision: 1, operationId: 'wrong-approver', actor: { kind: 'human', id: 'owner' }, now: NOW,
    }))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))

    setTaskAutonomy(db, { taskId: auto.task_id, autonomy: 'supervised', expectedRevision: 0, now: NOW })
    expect(await inboxIds()).toEqual(expectedInbox)
    withTx(db, (tx) => sweepDecisions(tx, TEST_SECRET, { now: '2026-11-20T03:00:00.000Z' }))
    expect(await get('/v1/decisions/get?decision_id=autonomous')).toMatchObject({ status: 'pending' })
    expect(await get('/v1/decisions/get?decision_id=assisted')).toMatchObject({ status: 'blocked_for_human' })
    expect(await get('/v1/decisions/get?decision_id=audit-role')).toMatchObject({ status: 'blocked_for_human', allowed_resolutions: [] })
    expect(await inboxIds()).toEqual(expectedInbox)
    withTx(db, (tx) => sweepDecisions(tx, TEST_SECRET, { now: '2026-11-21T01:00:00.000Z' }))
    expect(await get('/v1/decisions?status=resolved&run_id=' + auto.run_id))
      .toMatchObject({ items: [{ decision_id: 'autonomous', closed_reason: 'expired_final' }] })
    expect(await get('/v1/decisions/get?decision_id=supervised')).toMatchObject({ status: 'blocked_for_human' })
    expect(await get('/v1/decisions?status=resolved&run_id=' + assisted.run_id)).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ decision_id: 'audit-role', closed_reason: 'expired_final' })]),
    })
  } finally {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps pending and historical decisions created before the inbox migration', () => {
  const db = openDb(':memory:')
  try {
    const migrations = loadSteps(defaultMigrationsDir())
    applySteps(db, migrations.filter((step) => step.version < INBOX_MIGRATION))
    const run = startRun(db, catalogFor(['n1']), { workflowVersion: '1', taskTitle: '既有任务', operationId: 'op-old', now: NOW })
    withTx(db, (tx) => {
      for (const status of ['pending', 'resolved']) {
        tx.run("INSERT INTO decisions (decision_id, run_id, kind, status, revision, created_at, payload_json) VALUES (?, ?, ?, ?, 1, ?, '{}')",
          [status, run.run_id, 'audit_result', status, NOW])
      }
      tx.run(`INSERT INTO decisions (decision_id, run_id, kind, status, revision, created_at, payload_json, approver)
        VALUES ('legacy-audit-role', ?, 'rule_ambiguous', 'blocked_for_human', 1, ?, '{}', 'agent:auditor')`, [run.run_id, NOW])
    })

    applyInboxAndLaterMigrations(db, migrations)
    expect(listDecisions(db, { humanInbox: true }).items.map((item) => item.decision_id)).toEqual(['pending'])
    expect(listDecisions(db).items.map((item) => item.decision_id).sort()).toEqual(['legacy-audit-role', 'pending'])
    expect(listDecisions(db, { status: 'resolved' }).items.map((item) => item.decision_id)).toEqual(['resolved'])
    expect(getTaskSummary(db, run.task_id)).toMatchObject({ attention: 'decision', lane: 'attention', open_decision_count: 1 })
  } finally {
    db.raw.close()
  }
})

it('moves a legacy running task with only audit-role decisions back to the running lane after migration and reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-legacy-decision-lane-'))
  const file = join(dir, 'db.sqlite')
  const migrations = loadSteps(defaultMigrationsDir())
  let db = openDb(file)
  try {
    applySteps(db, migrations.filter((step) => step.version < INBOX_MIGRATION))
    const run = startRun(db, catalogFor(['n1']), { workflowVersion: '1', taskTitle: '进行中的审计', operationId: 'op-legacy-audit', now: NOW })
    withTx(db, (tx) => {
      tx.run("UPDATE tasks SET status = 'running' WHERE task_id = ?", [run.task_id])
      tx.run("UPDATE runs SET status = 'running' WHERE run_id = ?", [run.run_id])
      tx.run("UPDATE node_runs SET side_effect_policy = 'pure' WHERE run_id = ?", [run.run_id])
      tx.run(`INSERT INTO decisions (decision_id, run_id, kind, status, revision, created_at, payload_json, approver)
        VALUES ('legacy-audit', ?, 'audit_result', 'pending', 1, ?, '{}', 'agent:auditor')`, [run.run_id, NOW])
    })
    const taskIds = (params: Parameters<typeof listTaskSummaries>[1]) =>
      listTaskSummaries(db, params).items.map((item) => item.task_id)
    expect(db.raw.prepare('SELECT lane, attention_weight FROM task_attention_order WHERE task_id = ?').get(run.task_id))
      .toEqual({ lane: 'attention', attention_weight: 6 })

    function expectMigratedLane() {
      expect(getTaskSummary(db, run.task_id)).toMatchObject({ open_decision_count: 0, attention: 'running', lane: 'running' })
      expect(taskIds({ lane: 'running', attention: 'running' })).toEqual([run.task_id])
      expect(taskIds({ lane: 'attention' })).toEqual([])
      expect(taskIds({ attention: 'decision' })).toEqual([])
      expect(listDecisions(db, { humanInbox: true }).items).toEqual([])
      expect(listDecisions(db, { run_id: run.run_id }).items).toMatchObject([{ decision_id: 'legacy-audit', status: 'pending' }])
    }

    applyInboxAndLaterMigrations(db, migrations)
    expectMigratedLane()
    db.raw.close()
    db = openDb(file)
    expect(applySteps(db, migrations)).toEqual([])
    expectMigratedLane()
  } finally {
    db.raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
