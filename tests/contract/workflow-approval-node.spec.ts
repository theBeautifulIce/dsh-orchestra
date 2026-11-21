import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra, sweepNow } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'

it('S6 独立审批经人工批准回队，拒绝或到期时写入失败终态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-approval-node-'))
  const secret = 'fixture-approval-node'
  const boot = () => serveOrchestra({
    dbFile: join(dir, 'orchestra.db'), phase: 'S6', secret,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    resolveHttpHuman: request => request.headers.authorization === 'Bearer approval-operator' ? { id: 'fixture:operator' } : null,
  })
  let service = await boot()
  const post = async (path: string, body: unknown, operator = false) => {
    const response = await fetch(service.endpoint + path, {
      method: 'POST', body: JSON.stringify(body), headers: {
        'content-type': 'application/json', 'x-orchestra-secret': secret,
        ...(operator ? { authorization: 'Bearer approval-operator' } : {}),
      },
    })
    return { status: response.status, ...await response.json() }
  }
  const id = 'independent_approval'
  const name = '独立人工审批'
  const definition = (onTimeout: string) => ({
    name,
    nodes: [
      { node_id: 'start', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
      { node_id: 'review', type: 'approval', title: '人工确认', position: { x: 100, y: 0 },
        config: { prompt: '请确认已读取候选结果。', on_timeout: onTimeout } },
    ], edges: [{ from: 'start', to: 'review' }],
  })
  try {
    const invalidId = 'invalid_approval'
    expect(await post('/v1/workflows', { operation_id: uuidv7(), workflow_id: invalidId, name, definition: definition('approve') }))
      .toMatchObject({ status: 200, data: { validation: { errors: [expect.objectContaining({ path: '/nodes/1/config', code: 'WORKFLOW_NODE_CONFIG_INVALID' })] } } })
    expect(await post('/v1/workflows/test', { workflow_id: invalidId, revision: 1 })).toMatchObject({ status: 200, data: { passed: false } })
    expect(await post('/v1/workflows/publish', { operation_id: uuidv7(), workflow_id: invalidId, revision: 1, base_version: 0, publish_note: '非法超时动作' }))
      .toMatchObject({ status: 422, error: { code: 'WORKFLOW_VALIDATION_FAILED' } })

    expect(await post('/v1/workflows', { operation_id: uuidv7(), workflow_id: id, name, definition: definition('fail') })).toMatchObject({ status: 200 })
    expect(await post('/v1/workflows/test', { workflow_id: id, revision: 1 })).toMatchObject({ status: 200, data: { passed: true } })
    expect(await post('/v1/workflows/publish', { operation_id: uuidv7(), workflow_id: id, revision: 1, base_version: 0, publish_note: '审批' }))
      .toMatchObject({ status: 200 })

    for (const action of ['approved', 'rejected', 'expired'] as const) {
      const started = await post('/v1/runs/start', { taskTitle: name, workflowId: id, workflowVersion: '1', operationId: uuidv7(), autonomy: 'supervised' })
      expect(started).toMatchObject({ status: 200 })
      const runId = started.data.run_id as string
      const request = { runId, nodes: { review: { tools: [] } } }
      const node = () => service.orchestra.db.raw.prepare('SELECT node_run_id,status,attempt,action_generation,lease_id FROM node_runs WHERE run_id=?').get(runId)!
      const run = () => service.orchestra.db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(runId)?.status
      const card = () => service.orchestra.db.raw.prepare('SELECT decision_id,status,revision,expires_at,approver,content_hash FROM decisions WHERE run_id=?').get(runId)!
      expect(await post('/v1/runs/dispatch', request)).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'waiting', reason: 'approval_required' })] })
      expect(await post('/v1/runs/dispatch', request)).toMatchObject({ status: 200, data: [] })
      expect(node()).toMatchObject({ status: 'blocked_pre', attempt: 1, action_generation: 0, lease_id: null })
      const first = card()
      expect(first).toMatchObject({ status: 'pending', approver: 'human', revision: 1 })
      expect(first.content_hash).toMatch(/^[0-9a-f]{64}$/)
      if (action === 'expired') {
        sweepNow(service.orchestra.runtime, String(first.expires_at))
        expect(card().status).toBe('resolved')
        expect(node().status).toBe('failed')
        expect(run()).toBe('failed')
        continue
      }
      if (action === 'approved') {
        await service.close()
        service = await boot()
        expect(node().status).toBe('blocked_pre')
      }
      const resolve = { operation_id: uuidv7(), decisionId: first.decision_id, revision: 1, resolution: action, contentHash: first.content_hash }
      expect(await post('/v1/decisions/resolve', { ...resolve, actor: { kind: 'human', id: 'spoofed' } }))
        .toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })
      expect(await post('/v1/decisions/resolve', { ...resolve, contentHash: 'wrong-content' }, true))
        .toMatchObject({ status: 409, error: { code: 'CONFIRMATION_MISMATCH' } })
      expect(node().status).toBe('blocked_pre')
      expect(card().status).toBe('pending')
      expect(await post('/v1/decisions/resolve', resolve, true)).toMatchObject({ status: 200 })
      if (action === 'rejected') {
        expect(node()).toMatchObject({ status: 'failed', attempt: 1, lease_id: null })
        expect(run()).toBe('failed')
        continue
      }
      expect(node()).toMatchObject({ status: 'queued', attempt: 1, lease_id: null })
      expect(await post('/v1/runs/dispatch', request)).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'done' })] })
      expect(node()).toMatchObject({ status: 'done', attempt: 1, action_generation: 1, lease_id: null })
      expect(run()).toBe('succeeded')
      const output = service.orchestra.db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id=? AND type='approval.completed'").get(node().node_run_id!)!
      expect(JSON.parse(String(output.payload))).toEqual({ decision_ref: first.decision_id, payload: {} })
    }
  } finally {
    await service.close()
    await rm(dir, { recursive: true, force: true })
  }
})
