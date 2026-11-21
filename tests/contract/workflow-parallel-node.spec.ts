import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra, sweepNow } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { fakeAgentBridge, type FakeAgentBridge } from '../fixtures/agent-bridge.ts'

it('S6 专用 parallel 经发布后按 all、any、quorum 汇合，重启恢复并保留不可逆成员', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-parallel-node-'))
  const secret = 'fixture-parallel-node'
  const registry = new ToolRegistry()
  registry.register({ name: 'fixture_read', capability: 'read_only', command: { bin: 'fixture:read', args: [] } })
  const runner = new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true,
    async run() { return { exitCode: 0, stdout: 'synthetic receipt', stderr: '' } } }, dir)
  let holdAgent = false
  let transport: FakeAgentBridge | undefined
  const boot = () => {
    const host = fakeAgentBridge({ agentId: 'tool-fixture', steps: [{ tool: 'fixture_read' }], at: new Date().toISOString() })
    transport = host
    const bridge = new BridgeClient({ request: (method, params) => host.request(method, params), listen(params, signal) {
      if (!holdAgent) return host.listen(params, signal)
      return (async function* () {
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      })()
    } })
    return serveOrchestra({
    dbFile: join(dir, 'orchestra.db'), phase: 'S6', secret,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    resolveHttpHuman: request => request.headers.authorization === 'Bearer parallel-operator' ? { id: 'fixture:operator' } : null,
      executor: { registry, runner, bridge },
    })
  }
  let service = await boot()
  const post = async (path: string, body: unknown, operator = false) => {
    const response = await fetch(service.endpoint + path, {
      method: 'POST', signal: AbortSignal.timeout(5000), body: JSON.stringify(body), headers: {
        'content-type': 'application/json', 'x-orchestra-secret': secret,
        ...(operator ? { authorization: 'Bearer parallel-operator' } : {}),
      },
    })
    return { status: response.status, ...await response.json() }
  }
  const name = '并行组'
  const doc = (config: Record<string, unknown>, count: number, lastAgent: 'pure' | 'irreversible' | false = false, expiredWait = false) => {
    const ids = Array.from({ length: count }, (_, index) => `member_${index + 1}`)
    const nodes = [
      { node_id: 'start', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
      { node_id: 'group', type: 'parallel', title: '并行', position: { x: 100, y: 0 }, config },
      ...ids.map((node_id, index) => ({ node_id, title: node_id, position: { x: 200, y: index * 100 },
        ...(lastAgent && index === count - 1 ? { type: 'agent', config: { side_effect_policy: lastAgent, tools: { allow: ['fixture_read'] } } }
          : { type: 'wait', config: { wait_kind: 'event', match: { type: node_id }, max_wait_ms: expiredWait && index > 0 ? 1 : 600_000 } }),
      })),
      { node_id: 'merge', type: 'policy', title: '汇合', position: { x: 400, y: 0 }, config: { condition: { path: 'result', op: 'exists' } } },
    ]
    return { name, nodes, edges: [{ from: 'start', to: 'group' }, ...ids.map(to => ({ from: 'group', to })), ...ids.map(from => ({ from, to: 'merge' }))] }
  }
  const publish = async (workflow_id: string, config: Record<string, unknown>, count: number, lastAgent: 'pure' | 'irreversible' | false = false,
    valid = true, expiredWait = false) => {
    const definition = doc(config, count, lastAgent, expiredWait)
    expect(await post('/v1/workflows', { operation_id: uuidv7(), workflow_id, name, definition })).toMatchObject({ status: 200 })
    const rehearsal = await post('/v1/workflows/test', { workflow_id, revision: 1 })
    expect(rehearsal).toMatchObject({ status: 200, data: { passed: valid } })
    if (!valid) expect(rehearsal.data.issues.errors).toContainEqual(expect.objectContaining({ path: '/nodes/1/config', code: 'WORKFLOW_NODE_CONFIG_INVALID' }))
    expect(await post('/v1/workflows/publish', { operation_id: uuidv7(), workflow_id, revision: 1, base_version: 0, publish_note: '并行合同' }))
      .toMatchObject(valid ? { status: 200 } : { status: 422, error: { code: 'WORKFLOW_VALIDATION_FAILED' } })
  }
  const start = async (workflowId: string, count: number) => {
    const out = await post('/v1/runs/start', { taskTitle: name, workflowId, workflowVersion: '1', operationId: uuidv7() })
    expect(out).toMatchObject({ status: 200 })
    const runId = out.data.run_id as string
    const node = (id: string) => service.orchestra.db.raw.prepare('SELECT node_run_id,status,lease_id,parent_node_run_id FROM node_runs WHERE run_id=? AND node_id=?').get(runId, id)!
    const run = () => service.orchestra.db.raw.prepare('SELECT status,settling,pending_irreversible_children_json FROM runs WHERE run_id=?').get(runId)!
    const specs = Object.fromEntries(['group','merge', ...Array.from({ length: count }, (_, index) => `member_${index + 1}`)].map(id => [id, { tools: [] }]))
    const dispatch = () => post('/v1/runs/dispatch', { runId, nodes: specs })
    const wake = (id: string) => post('/v1/wait/events', { runId, eventType: id, payload: { result: id }, idempotencyKey: uuidv7() })
    const result = () => service.orchestra.db.raw.prepare("SELECT payload FROM node_run_events WHERE node_run_id=? AND type='parallel.result'").get(node('group').node_run_id!)
    expect(await dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'waiting', reason: 'parallel_members_pending' })] })
    expect(node('group')).toMatchObject({ status: 'waiting', lease_id: null })
    return { runId, run, node, dispatch, wake, result }
  }
  try {
    await publish('bad_quorum', { join: 'quorum', quorum: 3 }, 2, false, false)
    await publish('bad_irreversible', { join: 'any' }, 2, 'irreversible', false)
    for (const [mode, count, needed] of [['all', 2, 2], ['any', 3, 1], ['quorum', 4, 2]] as const) {
      const workflowId = `group_${mode}`
      await publish(workflowId, { join: mode, ...(mode === 'quorum' ? { quorum: needed } : {}) }, count)
      const execution = await start(workflowId, count)
      const members = await execution.dispatch()
      expect(members).toMatchObject({ status: 200 })
      expect(members.data).toHaveLength(count)
      expect(execution.node('member_1')).toMatchObject({ status: 'waiting', parent_node_run_id: execution.node('group').node_run_id })
      if (mode === 'quorum') { await service.close(); service = await boot() }
      for (let position = 1; position <= needed; position++) {
        expect(await execution.wake(`member_${position}`)).toMatchObject({ status: 200, data: { woken: 1 } })
        expect(execution.node('group').status).toBe(position === needed ? 'done' : 'waiting')
        expect(execution.node('merge').status).toBe('queued')
      }
      for (let position = needed + 1; position <= count; position++) {
        expect(execution.node(`member_${position}`).status).toBe('superseded')
        expect(await execution.wake(`member_${position}`)).toMatchObject({ status: 200, data: { woken: 0 } })
      }
      expect(await execution.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'merge', status: 'done' })] })
      expect(execution.run().status).toBe('succeeded')
      const result = JSON.parse(String(execution.result()!.payload))
      expect(result).toMatchObject({ status: 'done', join: mode, pending_children: [] })
      expect(result.children).toHaveLength(count)
      expect(result.children.filter((child: { cancel_reason: string | null }) => child.cancel_reason === 'join_satisfied')).toHaveLength(count - needed)
    }

    await publish('hold_irreversible', { join: 'any', allow_irreversible_children: true }, 2, 'irreversible')
    const held = await start('hold_irreversible', 2)
    expect(await held.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'member_1', status: 'waiting' })] })
    expect(await held.wake('member_1')).toMatchObject({ status: 200, data: { woken: 1 } })
    const irreversible = held.node('member_2')
    expect(irreversible).toMatchObject({ status: 'blocked_pre', lease_id: null })
    expect(held.node('group').status).toBe('waiting')
    expect(held.run()).toMatchObject({ status: 'running', settling: 1, pending_irreversible_children_json: JSON.stringify([irreversible.node_run_id]) })
    expect(await held.dispatch()).toMatchObject({ status: 200, data: [] })
    expect(held.node('merge').status).toBe('queued')
    const db = service.orchestra.db
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM node_run_events WHERE node_run_id=? AND type GLOB 'parallel.*cancel*'").get(irreversible.node_run_id!)?.n).toBe(0)
    const card = db.raw.prepare('SELECT decision_id,content_hash FROM decisions WHERE node_run_id=?').get(irreversible.node_run_id!)!
    const resolve = { decisionId: card.decision_id, contentHash: card.content_hash, resolution: 'approved', revision: 1, operation_id: uuidv7() }
    expect(await post('/v1/decisions/resolve', resolve)).toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })
    expect(await post('/v1/decisions/resolve', resolve, true)).toMatchObject({ status: 200 })
    const completed = await post('/v1/runs/dispatch', { runId: held.runId, nodes: { member_2: { tools: [{ command: 'fixture_read', args: [], cwd: '.', timeoutMs: 1000 }] } } })
    expect(completed).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'member_2', status: 'done' })] })
    expect(held.node('group').status).toBe('done')
    expect(held.run()).toMatchObject({ settling: 0, pending_irreversible_children_json: '[]' })
    expect(await held.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'merge', status: 'done' })] })
    expect(held.run().status).toBe('succeeded_with_unverified')

    await publish('active_loser', { join: 'any' }, 2, 'pure')
    holdAgent = true
    const active = await start('active_loser', 2)
    const activeDispatch = active.dispatch()
    await expect.poll(() => active.node('member_2').status).toBe('started')
    expect(await active.wake('member_1')).toMatchObject({ status: 200, data: { woken: 1 } })
    await expect(activeDispatch).resolves.toMatchObject({ status: 200 })
    expect(active.node('member_2').status).toBe('timeout')
    expect(transport?.calls.some(call => call.method === 'executor.whenIdle')).toBe(true)
    expect(JSON.parse(String(active.result()!.payload))).toMatchObject({ status: 'done', children: expect.arrayContaining([
      expect.objectContaining({ node_id: 'member_2', cancel_reason: 'host_stopped' }),
    ]) })
    expect(await active.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'merge', status: 'done' })] })
    expect(active.run().status).toBe('succeeded')
    holdAgent = false

    await publish('insufficient_quorum', { join: 'quorum', quorum: 2 }, 3, false, true, true)
    const insufficient = await start('insufficient_quorum', 3)
    await insufficient.dispatch()
    expect(await insufficient.wake('member_1')).toMatchObject({ status: 200, data: { woken: 1 } })
    await new Promise(resolve => setTimeout(resolve, 10))
    sweepNow(service.orchestra.runtime, new Date().toISOString())
    expect(insufficient.node('group').status).toBe('failed')
    expect(await insufficient.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'merge', status: 'failed' })] })
    expect(insufficient.run().status).toBe('failed')

    await publish('timed_group', { join: 'all', timeout_ms: 1 }, 2)
    const timed = await start('timed_group', 2)
    await new Promise(resolve => setTimeout(resolve, 10))
    sweepNow(service.orchestra.runtime, new Date().toISOString())
    expect(timed.node('group').status).toBe('timeout')
    expect(timed.node('member_1').status).toBe('superseded')
    expect(JSON.parse(String(timed.result()!.payload))).toMatchObject({ status: 'timeout', pending_children: [] })
  } finally {
    await service.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 10000)
