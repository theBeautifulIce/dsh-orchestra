import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra } from '../../src/index.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { fakeAgentBridge } from '../fixtures/agent-bridge.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { applyTransition, createNodeRun } from '../../src/service/commands/nodes.ts'

const name = '并行组的不同出口'
const condition = { path: 'selected', op: 'eq', value: true }
const missing = { path: 'result', op: 'exists' }
const node = (node_id: string, type: string, config?: object) => ({ node_id, type, config, title: node_id, position: { x: 0, y: 0 } })
const wait = (id: string) => node(id, 'wait', { wait_kind: 'event', match: { type: id }, max_wait_ms: 600_000 })
const policy = (id: string) => node(id, 'policy', { condition: missing })
const edge = (from: string, to: string, route?: object) => ({ from, to, route })
const document = (nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[]) => ({
  name, nodes: [node('start', 'trigger'), ...nodes], edges: [edge('start', nodes[0]!.node_id), ...edges],
})

async function withService(run: (fixture: Awaited<ReturnType<typeof serviceFixture>>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-parallel-topology-'))
  try {
    const fixture = await serviceFixture(dir)
    try { await run(fixture) } finally { await fixture.close() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function serviceFixture(dir: string) {
  const secret = 'fixture-parallel-topology'
  const registry = new ToolRegistry()
  const runner = new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true,
    async run() { throw new Error('inactive test path invoked an executor') } }, dir)
  const bridge = new BridgeClient(fakeAgentBridge({ agentId: 'inactive-path', steps: [], at: new Date().toISOString() }))
  const boot = () => serveOrchestra({
    dbFile: join(dir, 'orchestra.db'), phase: 'S6', secret,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    executor: { registry, runner, bridge },
  })
  let service = await boot()
  const post = async (path: string, body: unknown) => {
    const response = await fetch(service.endpoint + path, {
      method: 'POST', signal: AbortSignal.timeout(5000), body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-orchestra-secret': secret },
    })
    return { status: response.status, ...await response.json() }
  }
  return {
    close: () => service.close(),
    restart: async () => { await service.close(); service = await boot() },
    async publish(workflowId: string, definition: ReturnType<typeof document>, valid = true) {
      const workflow_id = workflowId
      expect(await post('/v1/workflows', { operation_id: uuidv7(), workflow_id, name, definition })).toMatchObject({ status: 200 })
      const tested = await post('/v1/workflows/test', { workflow_id, revision: 1 })
      expect(tested, JSON.stringify(tested.data?.issues)).toMatchObject({ status: 200, data: { passed: valid } })
      if (!valid) expect(tested.data.issues.errors).toContainEqual(expect.objectContaining({
        path: '/nodes/1/config', message: 'parallel 需要显式允许不可逆成员',
      }))
      expect(await post('/v1/workflows/publish', {
        operation_id: uuidv7(), workflow_id, revision: 1, base_version: 0, publish_note: '验证并行组不同出口',
      })).toMatchObject(valid ? { status: 200 } : { status: 422, error: { code: 'WORKFLOW_VALIDATION_FAILED' } })
      if (!valid) expect(service.orchestra.db.raw.prepare('SELECT 1 FROM workflow_versions WHERE workflow_id=?').get(workflow_id)).toBeUndefined()
    },
    async start(workflowId: string, definition: ReturnType<typeof document>) {
      const started = await post('/v1/runs/start', { taskTitle: name, workflowId, workflowVersion: '1', operationId: uuidv7() })
      expect(started).toMatchObject({ status: 200 })
      const runId = started.data.run_id as string
      const specs = Object.fromEntries(definition.nodes.filter(({ type }) => type !== 'agent' && type !== 'trigger')
        .map(({ node_id }) => [node_id, { tools: [], input: { selected: true } }]))
      const read = (id: string) => service.orchestra.db.raw.prepare('SELECT * FROM node_runs WHERE run_id=? AND node_id=? ORDER BY attempt DESC LIMIT 1').get(runId,id)!
      const status = (id: string) => read(id).status
      return {
        read, status,
        run: () => service.orchestra.db.raw.prepare('SELECT * FROM runs WHERE run_id=?').get(runId)!,
        dispatch: (only?: readonly string[]) => post('/v1/runs/dispatch', {
          runId, nodes: only ? Object.fromEntries(Object.entries(specs).filter(([id]) => only.includes(id))) : specs,
        }),
        acquire: (id: string) => post('/v1/node-runs/lease', {
          nodeRunId: read(id).node_run_id, ownerEpoch: service.orchestra.db.epoch, leaseTtlMs: 60_000,
        }),
        projectOwner: (id: string, owner: string | null) => {
          service.orchestra.db.raw.prepare('UPDATE node_runs SET parent_node_run_id=? WHERE node_run_id=?')
            .run(owner === null ? null : read(owner).node_run_id!,read(id).node_run_id!)
        },
        replaceUnstarted: (id: string) => {
          const previous = read(id)
          const now = new Date().toISOString()
          withTx(service.orchestra.db, tx => {
            applyTransition(tx, secret, { nodeRunId: String(previous.node_run_id), from: ['queued'], to: 'superseded', ruleId: 'M-62',
              attempt: Number(previous.attempt), now, patch: { side_effect_verified_none: 1 } })
            createNodeRun(tx, { newNodeRunId: 'nrun_' + uuidv7(), originNodeRunId: String(previous.node_run_id),
              runId, nodeId: id, seq: Number(previous.seq), nodeType: String(previous.node_type), attempt: Number(previous.attempt) + 1, now })
          })
        },
        wake: (id: string) => post('/v1/wait/events', { runId, eventType: id, payload: { result: id }, idempotencyKey: uuidv7() }),
        receipt: (id: string, event: string) => {
          const row = service.orchestra.db.raw.prepare('SELECT payload FROM node_run_events WHERE node_run_id=? AND type=? ORDER BY seq DESC LIMIT 1')
            .get(read(id).node_run_id!,event)
          return row ? JSON.parse(String(row.payload)) : undefined
        },
        decision: (id: string) => service.orchestra.db.raw.prepare('SELECT status,closed_reason FROM decisions WHERE node_run_id=?')
          .get(read(id).node_run_id!),
        breakChain: (id: string, event: string) => {
          const db = service.orchestra.db.raw
          db.exec('DROP TRIGGER trg_node_run_events_no_update')
          expect(db.prepare("UPDATE node_run_events SET hash='tampered' WHERE node_run_id=? AND type=?").run(read(id).node_run_id!,event).changes).toBe(1)
        },
      }
    },
  }
}

it('publishes four-way quorum with individual exits and a reconvergent join', () => withService(async fixture => {
  const definition = document([
    node('race', 'parallel', { join: 'quorum', quorum: 2 }),
    ...['one', 'two', 'three', 'four'].map(wait), policy('one_exit'), policy('two_exit'),
    node('three_exit', 'agent', { side_effect_policy: 'irreversible' }), policy('deep_skip'), policy('merge'),
  ], [
    ...['one', 'two', 'three', 'four'].map(id => edge('race', id)), edge('one', 'one_exit'), edge('two', 'two_exit'),
    edge('three', 'three_exit'), edge('three_exit', 'deep_skip'),
    edge('one_exit', 'merge'), edge('two_exit', 'merge'), edge('deep_skip', 'merge'),
  ])
  await fixture.publish('quorum_exits', definition)
  const run = await fixture.start('quorum_exits', definition)
  const opened = await run.dispatch()
  expect(opened, JSON.stringify(opened)).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'race', status: 'waiting' })] })
  const members = await run.dispatch()
  expect(members, JSON.stringify(members)).toMatchObject({ status: 200, data: expect.arrayContaining([
    expect.objectContaining({ node_id: 'one', status: 'waiting' }),
  ]) })
  expect(await run.wake('one')).toMatchObject({ status: 200, data: { woken: 1 } })
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [] })
  expect(run.status('one_exit')).toBe('queued')
  await fixture.restart()
  expect(await run.wake('two')).toMatchObject({ status: 200, data: { woken: 1 } })
  expect(run.status('race')).toBe('done')
  expect(run.status('three')).toBe('superseded')
  expect(run.status('four')).toBe('superseded')
  expect(run.read('three_exit')).toMatchObject({ status: 'superseded', lease_id: null, side_effect_verified_none: 1 })
  expect(run.receipt('three_exit', 'parallel.path_skipped')).toMatchObject({
    inactive_predecessors: [run.read('three').node_run_id], previous_side_effect_policy: 'irreversible',
  })
  expect(run.receipt('deep_skip', 'parallel.path_skipped')).toMatchObject({ inactive_predecessors: [run.read('three_exit').node_run_id] })
  expect(await run.dispatch()).toMatchObject({ status: 200, data: expect.arrayContaining([
    expect.objectContaining({ node_id: 'one_exit', status: 'done' }),
    expect.objectContaining({ node_id: 'two_exit', status: 'done' }),
  ]) })
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'merge', status: 'done' })] })
  expect(run.run().status).toBe('succeeded')
}), 20_000)

it('composes a branch and a multi-member nested group while keeping its outer quorum barrier', () => withService(async fixture => {
  const definition = document([
    node('outer', 'parallel', { join: 'quorum', quorum: 2 }),
    node('inner', 'parallel', { join: 'any' }), wait('guard'), wait('outer_loser'),
    node('choose', 'branch'), wait('inner_loser'), policy('chosen'), policy('unchosen'), policy('merge'),
  ], [
    edge('outer', 'inner'), edge('outer', 'guard'), edge('outer', 'outer_loser'),
    edge('inner', 'choose'), edge('inner', 'inner_loser'),
    edge('choose', 'chosen', { default: true }), edge('choose', 'unchosen', { priority: 1, when: { ...condition, value: false } }),
    edge('chosen', 'merge'), edge('unchosen', 'merge'), edge('inner_loser', 'merge'), edge('outer_loser', 'merge'),
  ])
  await fixture.publish('nested_branch', definition)
  const run = await fixture.start('nested_branch', definition)
  await run.dispatch()
  await run.dispatch()
  run.projectOwner('inner', null)
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [] })
  expect(run.status('choose')).toBe('queued')
  run.projectOwner('inner', 'outer')
  expect(await run.dispatch()).toMatchObject({ status: 200, data: expect.arrayContaining([
    expect.objectContaining({ node_id: 'choose', status: 'done' }),
  ]) })
  expect(run.status('inner')).toBe('done')
  expect(run.status('outer')).toBe('waiting')
  expect(run.receipt('choose', 'branch.selected')).toMatchObject({ target_node_id: 'chosen' })
  expect(run.status('chosen')).toBe('queued')
  expect(run.status('unchosen')).toBe('superseded')
  run.projectOwner('inner', null)
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [] })
  await fixture.restart()
  expect(await run.wake('guard')).toMatchObject({ status: 200, data: { woken: 1 } })
  expect(run.status('outer')).toBe('waiting')
  expect(run.status('chosen')).toBe('queued')
  run.projectOwner('inner', 'outer')
  await run.dispatch()
  expect(run.status('outer')).toBe('done')
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'chosen', status: 'done' })] })
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'merge', status: 'done' })] })
  expect(run.run().status).toBe('succeeded')
}), 20_000)

it('requires the published owner and the exact opened attempt while another path may run', () => withService(async fixture => {
  const definition = document([
    node('setup', 'parallel', { join: 'all' }), policy('left_seed'), policy('right_seed'),
    node('group', 'parallel', { join: 'all' }), wait('member'), wait('gate'), wait('healthy'),
    node('protected', 'agent'), policy('healthy_exit'),
  ], [
    edge('setup', 'left_seed'), edge('setup', 'right_seed'), edge('left_seed', 'group'), edge('right_seed', 'healthy'),
    edge('group', 'member'), edge('group', 'gate'), edge('member', 'protected'), edge('healthy', 'healthy_exit'),
  ])
  await fixture.publish('exact_membership', definition)
  const run = await fixture.start('exact_membership', definition)
  run.replaceUnstarted('member')
  await run.dispatch()
  await run.dispatch()
  await run.dispatch()
  expect(run.receipt('group', 'parallel.opened')).toMatchObject({ members: expect.arrayContaining([
    expect.objectContaining({ node_id: 'member', node_run_id: run.read('member').node_run_id, attempt: 2 }),
  ]) })
  await run.dispatch()
  expect(await run.wake('member')).toMatchObject({ status: 200, data: { woken: 1 } })
  expect(run.status('group')).toBe('waiting')
  run.projectOwner('member', null)
  expect(await run.acquire('protected')).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
  expect(run.read('protected')).toMatchObject({ status: 'queued', lease_id: null })
  expect(await run.wake('healthy')).toMatchObject({ status: 200, data: { woken: 1 } })
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'healthy_exit', status: 'done' })] })
  run.projectOwner('member', 'setup')
  expect(await run.acquire('protected')).toMatchObject({ error: { code: 'RESOLUTION_NOT_AVAILABLE' } })
  expect(await run.wake('gate')).toMatchObject({ status: 200, data: { woken: 1 } })
  expect(run.status('group')).toBe('waiting')
  run.projectOwner('member', 'group')
  await run.dispatch()
  expect(run.status('group')).toBe('done')
  expect(await run.acquire('protected')).toMatchObject({ status: 200, data: expect.objectContaining({ lease_id: expect.any(String) }) })
}), 20_000)

it('prunes members of a nested group cancelled before opening', () => withService(async fixture => {
  const definition = document([
    node('outer', 'parallel', { join: 'any' }), wait('winner'),
    node('inner', 'parallel', { join: 'all' }), wait('first'), wait('second'), policy('merge'),
  ], [
    edge('outer', 'winner'), edge('outer', 'inner'), edge('inner', 'first'), edge('inner', 'second'),
    edge('winner', 'merge'), edge('first', 'merge'), edge('second', 'merge'),
  ])
  await fixture.publish('unopened_nested', definition)
  const run = await fixture.start('unopened_nested', definition)
  await run.dispatch()
  await run.dispatch(['winner'])
  expect(await run.wake('winner')).toMatchObject({ status: 200, data: { woken: 1 } })
  expect(run.status('outer')).toBe('done')
  expect(run.receipt('inner', 'parallel.opened')).toBeUndefined()
  for (const id of ['first', 'second']) {
    expect(run.read(id)).toMatchObject({ status: 'superseded', parent_node_run_id: null })
    expect(run.receipt(id, 'parallel.path_skipped')).toMatchObject({ inactive_predecessors: [run.read('inner').node_run_id] })
  }
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'merge', status: 'done' })] })
  expect(run.run().status).toBe('succeeded')
}), 20_000)

it('cancels a waiting nested group and keeps a damaged skipped path from releasing its join', () => withService(async fixture => {
  const definition = document([
    node('race', 'parallel', { join: 'any' }), wait('winner'),
    node('nested', 'parallel', { join: 'all' }), wait('inner_one'), wait('inner_two'),
    policy('good'), policy('unused'), policy('merge'),
  ], [
    edge('race', 'winner'), edge('race', 'nested'), edge('nested', 'inner_one'), edge('nested', 'inner_two'),
    edge('winner', 'good'), edge('inner_one', 'unused'), edge('inner_two', 'unused'), edge('good', 'merge'), edge('unused', 'merge'),
  ])
  await fixture.publish('cancel_nested', definition)
  const run = await fixture.start('cancel_nested', definition)
  await run.dispatch()
  await run.dispatch()
  await run.dispatch()
  expect(run.status('inner_two')).toBe('waiting')
  expect(await run.wake('winner')).toMatchObject({ status: 200, data: { woken: 1 } })
  expect(run.status('race')).toBe('done')
  expect(run.receipt('nested', 'parallel.member_cancelled')).toMatchObject({ reason: 'join_satisfied', to: 'superseded' })
  expect(run.status('inner_one')).toBe('superseded')
  expect(run.status('inner_two')).toBe('superseded')
  expect(run.status('unused')).toBe('superseded')
  run.breakChain('unused', 'parallel.path_skipped')
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'good', status: 'done' })] })
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [] })
  expect(run.status('merge')).toBe('queued')
  expect(run.run().status).toBe('running')
}), 20_000)

it('rejects an outer race with a nested irreversible member before persisting a version', () => withService(async fixture => {
  const definition = document([
    node('outer', 'parallel', { join: 'any' }), node('inner', 'parallel', { join: 'all', allow_irreversible_children: true }),
    wait('outer_wait'), wait('inner_wait'), node('irreversible', 'agent', { side_effect_policy: 'irreversible' }),
  ], [
    edge('outer', 'inner'), edge('outer', 'outer_wait'), edge('inner', 'inner_wait'), edge('inner', 'irreversible'),
  ])
  await fixture.publish('unsafe_nested', definition, false)
}), 20_000)

it('cancels a losing branch decision with no authority to select either of its paths', () => withService(async fixture => {
  const unmatched = { ...condition, value: false }
  const definition = document([
    node('race', 'parallel', { join: 'any' }), wait('winner'), node('choose', 'branch'),
    policy('win'), policy('left'), policy('right'), policy('merge'),
  ], [
    edge('race', 'winner'), edge('race', 'choose'), edge('winner', 'win'),
    edge('choose', 'left', { priority: 1, when: unmatched }), edge('choose', 'right', { priority: 2, when: unmatched }),
    edge('win', 'merge'), edge('left', 'merge'), edge('right', 'merge'),
  ])
  await fixture.publish('cancel_branch', definition)
  const run = await fixture.start('cancel_branch', definition)
  await run.dispatch()
  await run.dispatch()
  expect(run.status('choose')).toBe('blocked_post')
  expect(run.decision('choose')).toMatchObject({ status: 'pending', closed_reason: null })
  await fixture.restart()
  expect(await run.wake('winner')).toMatchObject({ status: 200, data: { woken: 1 } })
  expect(run.status('race')).toBe('done')
  expect(run.decision('choose')).toMatchObject({ status: 'resolved', closed_reason: 'cancelled' })
  expect(run.receipt('choose', 'branch.selected')).toBeUndefined()
  expect(run.status('left')).toBe('superseded')
  expect(run.status('right')).toBe('superseded')
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'win', status: 'done' })] })
  expect(await run.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ node_id: 'merge', status: 'done' })] })
  expect(run.run().status).toBe('succeeded')
}), 20_000)
