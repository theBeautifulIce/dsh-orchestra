import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'

it('S6 发布、重载并执行独立 policy，以版本固定的规则生成终态证据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-policy-node-'))
  const secret = 'fixture-policy-node'
  const boot = () => serveOrchestra({
    dbFile: join(dir, 'orchestra.db'), phase: 'S6', secret,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
  })
  let service = await boot()
  const post = async (path: string, body: unknown) => {
    const response = await fetch(service.endpoint + path, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-orchestra-secret': secret },
    })
    return { status: response.status, ...await response.json() }
  }
  const id = 'policy_workflow'
  const name = '独立策略'
  const workflow = (op: string) => ({
    name,
    nodes: [
      { node_id: 'start', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
      { node_id: 'check', type: 'policy', title: '判定', position: { x: 100, y: 0 },
        config: { condition: { path: 'score', op, value: 5 }, rule_id: 'quality.score' } },
    ],
    edges: [{ from: 'start', to: 'check' }],
  })
  try {
    const invalid = 'invalid_policy'
    expect(await post('/v1/workflows', { operation_id: uuidv7(), workflow_id: invalid, name, definition: workflow('script') }))
      .toMatchObject({ status: 200, data: { validation: { errors: [expect.objectContaining({ path: '/nodes/1/config', code: 'WORKFLOW_NODE_CONFIG_INVALID' })] } } })
    expect(await post('/v1/workflows/test', { workflow_id: invalid, revision: 1 })).toMatchObject({ status: 200, data: { passed: false } })
    expect(await post('/v1/workflows/publish', { operation_id: uuidv7(), workflow_id: invalid, revision: 1, base_version: 0, publish_note: '无效规则' }))
      .toMatchObject({ status: 422, error: { code: 'WORKFLOW_VALIDATION_FAILED' } })
    expect(service.orchestra.db.raw.prepare('SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id=?').get(invalid)?.n).toBe(0)

    expect(await post('/v1/workflows', { operation_id: uuidv7(), workflow_id: id, name, definition: workflow('gte') })).toMatchObject({ status: 200 })
    expect(await post('/v1/workflows/test', { workflow_id: id, revision: 1 })).toMatchObject({ status: 200, data: { passed: true, order: [
      expect.objectContaining({ type: 'trigger' }), expect.objectContaining({ type: 'policy' }),
    ] } })
    expect(await post('/v1/workflows/publish', { operation_id: uuidv7(), workflow_id: id, revision: 1, base_version: 0, publish_note: '固定质量规则' }))
      .toMatchObject({ status: 200 })
    await service.close()
    service = await boot()

    for (const [score, decision] of [[7, 'pass'], [3, 'fail'], [undefined, 'fail'], ['not a number', 'error']] as const) {
      const started = await post('/v1/runs/start', { taskTitle: name, workflowId: id, workflowVersion: '1', operationId: uuidv7() })
      expect(started).toMatchObject({ status: 200 })
      const runId = started.data.run_id as string
      const db = service.orchestra.db
      const nodeRunId = db.raw.prepare('SELECT node_run_id FROM node_runs WHERE run_id=?').get(runId)?.node_run_id as string
      expect(await post('/v1/node-runs/lease', { nodeRunId, ownerEpoch: db.epoch, leaseTtlMs: 30_000 }))
        .toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })
      const request = { runId, nodes: { check: { input: { score }, tools: [] } } }
      if (decision === 'error') {
        expect(await post('/v1/runs/dispatch', request)).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'failed', error_code: 'VERDICT_UNSUPPORTED', settlement: 'applied' })] })
        expect(await post('/v1/runs/dispatch', request)).toMatchObject({ status: 200, data: [] })
        expect(db.raw.prepare('SELECT status,lease_id FROM node_runs WHERE node_run_id=?').get(nodeRunId)).toMatchObject({ status: 'failed', lease_id: null })
        expect(db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(runId)?.status).toBe('failed')
        expect(db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id=? AND type='dispatch.failed'").get(nodeRunId)?.n).toBe(1)
        continue
      }
      expect(await post('/v1/runs/dispatch', request)).toMatchObject({ status: 200, data: [expect.objectContaining({ node_run_id: nodeRunId, status: 'done' })] })
      expect(await post('/v1/runs/dispatch', request)).toMatchObject({ status: 200, data: [] })
      expect(db.raw.prepare('SELECT status,lease_id,side_effect_policy,side_effect_verified_none FROM node_runs WHERE node_run_id=?').get(nodeRunId))
        .toMatchObject({ status: 'done', lease_id: null, side_effect_policy: 'pure', side_effect_verified_none: 1 })
      expect(db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(runId)?.status).toBe('succeeded')
      const events = db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id=? AND type='policy.evaluated'").all(nodeRunId)
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.payload as string)).toMatchObject({ schema_version: 1, matched: decision === 'pass', decision,
        must_pass_items: [{ id: 'quality.score', result: decision, evidence_ids: [] }] })
    }
  } finally {
    await service.close()
    await rm(dir, { recursive: true, force: true })
  }
})
