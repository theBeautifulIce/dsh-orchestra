import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'

it('S6 branch 读取上游结果，持久选路与人工续行使未选路径无法派发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-branch-node-'))
  const secret = 'fixture-branch-node'
  const registry = new ToolRegistry()
  const boot = () => serveOrchestra({
    dbFile: join(dir, 'orchestra.db'), phase: 'S6', secret,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    resolveHttpHuman: request => request.headers.authorization === 'Bearer branch-operator' ? { id: 'fixture:operator' } : null,
    executor: { registry, bridge: new BridgeClient({ async request() { throw new Error('unexpected agent call') }, async *listen() {} }),
      runner: new ReadOnlyToolRunner(registry, { readonlyAvailable: () => false, async run() { throw new Error('unexpected tool call') } }, dir) },
  })
  let service = await boot()
  const post = async (path: string, body: unknown, operator = false) => {
    const response = await fetch(service.endpoint + path, {
      method: 'POST', body: JSON.stringify(body), headers: {
        'content-type': 'application/json', 'x-orchestra-secret': secret,
        ...(operator ? { authorization: 'Bearer branch-operator' } : {}),
      },
    })
    return { status: response.status, ...await response.json() }
  }
  const name = '独立分支'
  const condition = { path: 'decision', op: 'eq', value: 'pass' }
  const doc = (otherRoute: object) => ({
    name,
    nodes: [
      { node_id: 'start', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
      { node_id: 'evaluate', type: 'policy', title: '计算', position: { x: 100, y: 0 }, config: { condition } },
      { node_id: 'choose', type: 'branch', title: '分流', position: { x: 200, y: 0 } },
      ...['left', 'right', 'merge'].map((id, index) => ({
        node_id: id, type: 'policy', title: id, position: { x: 300 + index * 100, y: 0 },
        config: { condition: { path: 'ignored', op: 'exists' } },
      })),
    ],
    edges: [
      { from: 'start', to: 'evaluate' }, { from: 'evaluate', to: 'choose' },
      { from: 'choose', to: 'left', route: { priority: 1, when: condition } },
      { from: 'choose', to: 'right', route: otherRoute },
      { from: 'left', to: 'merge' }, { from: 'right', to: 'merge' },
    ],
  })
  const publish = async (workflow_id: string, otherRoute: object, valid = true) => {
    expect(await post('/v1/workflows', { operation_id: uuidv7(), workflow_id, name, definition: doc(otherRoute) })).toMatchObject({ status: 200 })
    const rehearsal = await post('/v1/workflows/test', { workflow_id, revision: 1 })
    expect(rehearsal).toMatchObject({ status: 200, data: { passed: valid } })
    if (!valid) expect(rehearsal.data.issues.errors).toContainEqual(expect.objectContaining({ path: '/edges/3/route/when', code: 'WORKFLOW_BRANCH_ROUTE_INVALID' }))
    expect(await post('/v1/workflows/publish', { operation_id: uuidv7(), workflow_id, revision: 1, base_version: 0, publish_note: '分支验证' }))
      .toMatchObject(valid ? { status: 200 } : { status: 422, error: { code: 'WORKFLOW_VALIDATION_FAILED' } })
  }
  const start = async (workflowId: string, input: string) => {
    const started = await post('/v1/runs/start', { taskTitle: name, workflowId, workflowVersion: '1', operationId: uuidv7() })
    expect(started).toMatchObject({ status: 200 })
    const runId = started.data.run_id as string
    const node = (id: string) => service.orchestra.db.raw.prepare('SELECT node_run_id,status,lease_id FROM node_runs WHERE run_id=? AND node_id=?').get(runId, id)!
    const request = { runId, nodes: {
      evaluate: { tools: [], input: { decision: input } }, choose: { tools: [], input: { decision: input === 'pass' ? 'fail' : 'pass' } },
      left: { tools: [] }, right: { tools: [] }, merge: { tools: [] },
    } }
    const dispatch = () => post('/v1/runs/dispatch', request)
    expect(await dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'evaluate', status: 'done' })] })
    return { runId, node, dispatch }
  }
  try {
    await publish('invalid_branch', { priority: 2 }, false)
    await publish('default_branch', { default: true })
    await publish('overlap_branch', { priority: 2, when: condition })
    for (const [input, picked] of [['pass', 'left'], ['fail', 'right']] as const) {
      const { runId, node, dispatch } = await start('default_branch', input)
      expect(await dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'choose', status: 'done' })] })
      const skipped = picked === 'left' ? 'right' : 'left'
      expect(node(skipped)).toMatchObject({ status: 'superseded', lease_id: null })
      expect(await dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: picked, status: 'done' })] })
      expect(await dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'merge', status: 'done' })] })
      const db = service.orchestra.db
      expect(db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(runId)?.status).toBe('succeeded')
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id=? AND type='branch.skipped'").get(node(skipped).node_run_id!)?.n).toBe(1)
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id=? AND type='lease_acquired'").get(node(skipped).node_run_id!)?.n).toBe(0)
    }
    const overlap = await start('overlap_branch', 'pass')
    expect(await overlap.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'choose', status: 'failed', error_code: 'BRANCH_AMBIGUOUS' })] })
    expect(overlap.node('choose')).toMatchObject({ status: 'failed', lease_id: null })

    const waiting = await start('overlap_branch', 'fail')
    expect(await waiting.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'choose', status: 'waiting', reason: 'rule_ambiguous' })] })
    expect(waiting.node('choose')).toMatchObject({ status: 'blocked_post', lease_id: null })
    const decision = service.orchestra.db.raw.prepare('SELECT decision_id,approver,status FROM decisions WHERE run_id=?').get(waiting.runId)!
    expect(decision).toMatchObject({ approver: 'human', status: 'pending' })
    await service.close()
    service = await boot()
    const base = { decisionId: decision.decision_id, revision: 1, resolution: 'approved' }
    const resolve = (selected_node_id: string, operator: boolean) => post('/v1/decisions/resolve', {
      ...base, operation_id: uuidv7(), payload: { selected_node_id },
    }, operator)
    expect(await resolve('left', false)).toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })
    expect(await resolve('merge', true)).toMatchObject({ status: 422, error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
    expect(waiting.node('choose').status).toBe('blocked_post')
    expect(await resolve('left', true)).toMatchObject({ status: 200 })
    expect(waiting.node('right').status).toBe('superseded')
    expect(await waiting.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'left', status: 'done' })] })
    expect(await waiting.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'merge', status: 'done' })] })
    expect(service.orchestra.db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(waiting.runId)?.status).toBe('succeeded')

    const corruptId = 'corrupt_route_authority'
    const corrupt = doc({ default: true })
    corrupt.nodes = corrupt.nodes.filter(node => node.node_id !== 'right').map(node => node.node_id === 'merge' ? { ...node, type: 'agent' } : node)
    corrupt.edges = corrupt.edges.filter(edge => edge.from !== 'right' && edge.to !== 'right')
    expect(await post('/v1/workflows', { operation_id: uuidv7(), workflow_id: corruptId, name, definition: corrupt })).toMatchObject({ status: 200 })
    expect(await post('/v1/workflows/test', { workflow_id: corruptId, revision: 1 })).toMatchObject({ status: 200, data: { passed: true } })
    expect(await post('/v1/workflows/publish', { operation_id: uuidv7(), workflow_id: corruptId, revision: 1, base_version: 0, publish_note: '断链反例' })).toMatchObject({ status: 200 })
    const guarded = await start(corruptId, 'pass')
    expect(await guarded.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'choose', status: 'done' })] })
    expect(await guarded.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'left', status: 'done' })] })
    const db = service.orchestra.db
    db.raw.exec('DROP TRIGGER trg_node_run_events_no_update')
    db.raw.prepare("UPDATE node_run_events SET hash='tampered' WHERE node_run_id=? AND type='branch.selected'").run(guarded.node('choose').node_run_id!)
    expect(await post('/v1/node-runs/lease', { nodeRunId: guarded.node('merge').node_run_id, ownerEpoch: db.epoch, leaseTtlMs: 30_000 }))
      .toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })
    expect(guarded.node('merge')).toMatchObject({ status: 'queued', lease_id: null })
  } finally {
    await service.close()
    await rm(dir, { recursive: true, force: true })
  }
})
