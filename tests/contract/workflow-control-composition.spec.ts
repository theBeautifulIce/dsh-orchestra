import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra, sweepNow } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { fakeAgentBridge } from '../fixtures/agent-bridge.ts'

type Step = { node_id: string; type: string; config?: object }
type Edge = { from: string; to: string; route?: object }
const trigger = { node_id: 'trigger', type: 'trigger' }
const wait = (node_id: string): Step => ({ node_id, type: 'wait', config: { wait_kind: 'event', match: { type: node_id }, max_wait_ms: 600_000 } })
const policy = (node_id: string, path = 'child_status'): Step => ({ node_id, type: 'policy', config: { condition: { path, op: 'eq', value: 'succeeded' } } })
const branch = (node_id: string): Step => ({ node_id, type: 'branch' })
const parallel = (node_id: string, config: object): Step => ({ node_id, type: 'parallel', config })
const sub = { node_id: 'sub', type: 'subworkflow', config: { workflow_id: 'child', pinned_version: 1 } }
const edge = (from: string, to: string, route?: object): Edge => ({ from, to, ...(route ? { route } : {}) })

async function fixture(enableAgent = false) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-control-compose-'))
  const secret = 'fixture-composed-controls'
  const registry = new ToolRegistry()
  const host = fakeAgentBridge({ agentId: 'child-agent', steps: [] })
  const bridge = new BridgeClient({ request: (method, params) => host.request(method, params), async *listen(_params, signal) {
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  } })
  const boot = () => serveOrchestra({ dbFile: join(dir, 'orchestra.db'), phase: 'S6', secret,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    resolveHttpHuman: request => request.headers.authorization === 'Bearer fixture-human' ? { id: 'fixture:operator' } : null,
    ...(enableAgent ? { executor: { registry, bridge, runner: new ReadOnlyToolRunner(registry,
      { readonlyAvailable: () => false, async run() { throw new Error('unexpected tool call') } }, dir) } } : {}),
  })
  let service = await boot()
  const post = async (path: string, body: object, operator = false) => {
    const response = await fetch(service.endpoint + path, { method: 'POST', signal: AbortSignal.timeout(8000), body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-orchestra-secret': secret, ...(operator ? { authorization: 'Bearer fixture-human' } : {}) } })
    return { status: response.status, ...await response.json() }
  }
  const publish = async (workflow_id: string, nodes: Step[], edges: Edge[]) => {
    const name = workflow_id
    const definition = { name, nodes: nodes.map((node, index) => ({ ...node, title: node.node_id, position: { x: index * 90, y: 0 } })), edges }
    expect(await post('/v1/workflows', { operation_id: uuidv7(), workflow_id, name, definition })).toMatchObject({ status: 200 })
    expect(await post('/v1/workflows/test', { workflow_id, revision: 1 })).toMatchObject({ status: 200, data: { passed: true } })
    expect(await post('/v1/workflows/publish', { operation_id: uuidv7(), workflow_id, revision: 1, base_version: 0, publish_note: '控制节点组合' })).toMatchObject({ status: 200 })
  }
  const start = async (workflowId: string) => {
    const out = await post('/v1/runs/start', { taskTitle: workflowId, workflowId, workflowVersion: '1', operationId: uuidv7() })
    expect(out).toMatchObject({ status: 200 })
    return out.data.run_id as string
  }
  return { publish, start, host,
    publishChild: () => publish('child', [trigger, wait('child_event')], [edge('trigger','child_event')]),
    dispatch: (runId: string, ...nodes: string[]) => post('/v1/runs/dispatch', { runId, nodes: Object.fromEntries(nodes.map(node => [node, { tools: [] }])) }),
    wake: (runId: string, eventType: string) => post('/v1/wait/events', { runId, eventType, payload: { result: eventType }, idempotencyKey: uuidv7() }),
    approve: (runId: string) => {
      const card = service.orchestra.db.raw.prepare("SELECT decision_id,content_hash,revision FROM decisions WHERE run_id=? AND kind='pre_execution'").get(runId)!
      return post('/v1/decisions/resolve', { decisionId: card.decision_id, contentHash: card.content_hash, revision: card.revision,
        resolution: 'approved', operation_id: uuidv7() }, true)
    },
    node: (runId: string, nodeId: string) => service.orchestra.db.raw.prepare('SELECT node_run_id,status FROM node_runs WHERE run_id=? AND node_id=?').get(runId, nodeId)!,
    run: (runId: string) => service.orchestra.db.raw.prepare('SELECT status,cancel_requested_at FROM runs WHERE run_id=?').get(runId)!,
    subRun: (runId: string) => String(service.orchestra.db.raw.prepare('SELECT run_id FROM runs WHERE parent_run_id=?').get(runId)?.run_id),
    events: (nodeRunId: string, type: string) => service.orchestra.db.raw.prepare('SELECT payload FROM node_run_events WHERE node_run_id=? AND type=?').all(nodeRunId,type)
      .map(row => JSON.parse(String(row.payload))),
    breakChain(nodeRunId: string, event: string) {
      service.orchestra.db.raw.exec('DROP TRIGGER IF EXISTS trg_node_run_events_no_update')
      service.orchestra.db.raw.prepare("UPDATE node_run_events SET hash='tampered' WHERE node_run_id=? AND type=?").run(nodeRunId,event)
    },
    sweep: () => sweepNow(service.orchestra.runtime, new Date().toISOString()),
    async restart() { await service.close(); service = await boot() },
    async dispose() { await service.close(); await rm(dir, { recursive: true, force: true }) },
  }
}

it.each(['any','quorum'])('parallel %s 只在绑定子运行可信终止后结束等待成员', async mode => {
  const f = await fixture()
  try {
    await f.publishChild()
    await f.publish('parent', [trigger, parallel('group', { join: mode, ...(mode === 'quorum' ? { quorum: 1 } : {}) }), wait('winner'), sub, policy('after','result')],
      [edge('trigger','group'), edge('group','winner'), edge('group','sub'), edge('winner','after'), edge('sub','after')])
    const run = await f.start('parent')
    await f.dispatch(run,'group')
    await f.dispatch(run,'winner','sub')
    const child = f.subRun(run)
    await f.dispatch(child,'child_event')
    expect(f.node(child,'child_event').status).toBe('waiting')
    await f.restart()
    expect(await f.wake(run,'winner')).toMatchObject({ status: 200, data: { woken: 1 } })
    f.sweep()
    expect(f.run(child)).toMatchObject({ status: 'cancelled', cancel_requested_at: expect.any(String) })
    expect(f.node(run,'sub').status).toBe('superseded')
    expect(f.node(run,'group').status).toBe('done')
    expect(await f.wake(child,'child_event')).toMatchObject({ status: 200, data: { woken: 0 } })
    expect(await f.dispatch(run,'after')).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'done' })] })
    expect(f.run(run).status).toBe('succeeded')
    await f.restart()
    f.sweep()
    expect(f.events(String(f.node(run,'sub').node_run_id),'parallel.member_cancelled')).toHaveLength(1)
  } finally { await f.dispose() }
})

it.each(['pure','irreversible'])('绑定子运行的 %s 子节点只有在确认停止时才释放外层组', async effect => {
  const f = await fixture(true)
  try {
    await f.publish('child', [trigger, { node_id: 'active', type: 'agent', config: { side_effect_policy: effect } }], [edge('trigger','active')])
    await f.publish('parent', [trigger, parallel('group', { join: 'any', allow_irreversible_children: true }), wait('winner'), sub, policy('after','result')],
      [edge('trigger','group'), edge('group','winner'), edge('group','sub'), edge('winner','after'), edge('sub','after')])
    const run = await f.start('parent')
    await f.dispatch(run,'group')
    if (effect === 'irreversible') expect(await f.approve(run)).toMatchObject({ status: 200 })
    await f.dispatch(run,'winner','sub')
    const child = f.subRun(run)
    if (effect === 'irreversible') {
      await f.wake(run,'winner')
      f.sweep()
      expect(f.run(child)).toMatchObject({ status: 'running', cancel_requested_at: null })
      expect(f.node(child,'active').status).toBe('queued')
      expect(f.node(run,'group').status).toBe('waiting')
      expect(f.host.cancelled).toBe(false)
      return
    }
    const active = f.dispatch(child,'active')
    await expect.poll(() => f.node(child,'active').status).toBe('started')
    await f.wake(run,'winner')
    await active
    f.sweep()
    expect(f.host.cancelled).toBe(true)
    expect(f.host.calls.some(call => call.method === 'executor.whenIdle')).toBe(true)
    expect(f.run(child)).toMatchObject({ status: 'cancelled' })
    expect(f.node(run,'group').status).toBe('done')
  } finally { await f.dispose() }
}, 10000)

it('外层 all 超时后取消等待中的内层组及其等待登记', async () => {
  const f = await fixture()
  try {
    await f.publish('nested', [trigger, parallel('outer', { join: 'all', timeout_ms: 500 }), parallel('inner',{ join: 'all' }), wait('outer_wait'), wait('inner_wait')],
      [edge('trigger','outer'), edge('outer','inner'), edge('outer','outer_wait'), edge('inner','inner_wait')])
    const run = await f.start('nested')
    await f.dispatch(run,'outer')
    await f.dispatch(run,'inner','outer_wait')
    await f.dispatch(run,'inner_wait')
    expect(f.node(run,'inner_wait').status).toBe('waiting')
    await new Promise(resolve => setTimeout(resolve, 550))
    f.sweep()
    f.sweep()
    expect(f.node(run,'inner_wait').status).toBe('superseded')
    expect(f.node(run,'inner').status).toBe('superseded')
    expect(f.node(run,'outer').status).toBe('timeout')
    expect(await f.wake(run,'inner_wait')).toMatchObject({ status: 200, data: { woken: 0 } })
  } finally { await f.dispose() }
})

it.each(['branch','policy','parallel'])('已核验子运行的历史完成收据进入 %s 输入', async type => {
  const f = await fixture()
  try {
    await f.publishChild()
    const parentNodes: Step[] = [trigger, sub, type === 'policy' ? policy('after') : type === 'branch' ? branch('after') : parallel('after', { join: 'all' })]
    const parentEdges = [edge('trigger','sub'), edge('sub','after')]
    if (type === 'branch') {
      parentNodes.push(policy('accepted'), policy('fallback'))
      parentEdges.push(edge('after','accepted',{ priority: 0, when: { path: 'child_status', op: 'eq', value: 'succeeded' } }), edge('after','fallback',{ default: true }))
    }
    if (type === 'parallel') {
      parentNodes.push(policy('member'))
      parentEdges.push(edge('after','member'))
    }
    await f.publish('parent', parentNodes, parentEdges)
    const run = await f.start('parent')
    await f.dispatch(run,'sub')
    const child = f.subRun(run)
    await f.dispatch(child,'child_event')
    await f.wake(child,'child_event')
    f.sweep()
    expect(f.node(run,'sub').status).toBe('done')
    expect(await f.dispatch(run,'after')).toMatchObject({ status: 200, data: [expect.objectContaining({ status: type === 'parallel' ? 'waiting' : 'done' })] })
    if (type === 'policy') expect(f.events(String(f.node(run,'after').node_run_id),'policy.evaluated')).toMatchObject([{ decision: 'pass' }])
    if (type === 'branch') expect(f.events(String(f.node(run,'after').node_run_id),'branch.selected')).toMatchObject([{ target_node_id: 'accepted' }])
    if (type === 'parallel') {
      expect(f.events(String(f.node(run,'after').node_run_id),'parallel.opened')).toMatchObject([{ input: { child_run_id: child, child_status: 'succeeded' } }])
      await f.dispatch(run,'member')
      expect(f.events(String(f.node(run,'member').node_run_id),'policy.evaluated')).toMatchObject([{ decision: 'pass' }])
    }
  } finally { await f.dispose() }
})

it('子运行收口后发生断链时，父规则不会把历史完成记录当成可信输入', async () => {
  const f = await fixture()
  try {
    await f.publishChild()
    await f.publish('parent', [trigger, sub, policy('after')], [edge('trigger','sub'), edge('sub','after')])
    const run = await f.start('parent')
    await f.dispatch(run,'sub')
    const child = f.subRun(run)
    await f.dispatch(child,'child_event')
    await f.wake(child,'child_event')
    f.sweep()
    expect(f.node(run,'sub').status).toBe('done')
    f.breakChain(String(f.node(child,'child_event').node_run_id),'wait.woken')
    expect(await f.dispatch(run,'after')).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'failed', error_code: 'VERDICT_UNSUPPORTED' })] })
    expect(f.events(String(f.node(run,'after').node_run_id),'policy.evaluated')).toHaveLength(0)
  } finally { await f.dispose() }
})

it.each([false,true])('分支只对相交选路验链（相交=%s）', async intersects => {
  const f = await fixture()
  try {
    await f.publish('branches', [trigger, parallel('group',{ join: 'all' }), wait('first'), wait('second'), branch('left'), branch('right'),
      policy('left_skip'), policy('right_skip'), policy('left_default'), ...(intersects ? [] : [policy('right_default')])],
    [edge('trigger','group'),edge('group','first'),edge('group','second'),edge('first','left'),edge('second','right'),
      edge('left','left_default',{ default:true }),edge('left','left_skip',{ priority:1, when:{ path:'result',op:'eq',value:'other' }}),
      edge('right',intersects ? 'left_default' : 'right_default',{ default:true }),edge('right','right_skip',{ priority:1, when:{ path:'result',op:'eq',value:'other' }})])
    const run = await f.start('branches')
    await f.dispatch(run,'group')
    await f.dispatch(run,'first','second')
    await f.wake(run,'first')
    await f.wake(run,'second')
    expect(await f.dispatch(run,'left')).toMatchObject({ status: 200, data: expect.arrayContaining([expect.objectContaining({ node_id: 'left', status: 'done' })]) })
    f.breakChain(String(f.node(run,'left').node_run_id),'branch.selected')
    expect(await f.dispatch(run,'right')).toMatchObject({ status: 200, data: expect.arrayContaining([
      expect.objectContaining(intersects ? { node_id:'right', status:'failed', error_code:'FORBIDDEN' } : { node_id:'right', status:'done' }),
    ]) })
    if (!intersects) expect(await f.dispatch(run,'right_default')).toMatchObject({ status: 200, data: expect.arrayContaining([expect.objectContaining({ node_id:'right_default', status:'done' })]) })
  } finally { await f.dispose() }
})
