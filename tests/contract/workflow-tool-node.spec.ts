import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { serveOrchestra, sweepNow } from '../../src/index.ts'
import { sha256Hex } from '../../src/core/canonical.ts'
import { uuidv7 } from '../../src/core/ids.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { EvidenceCollector } from '../../src/executor/evidence-collector.ts'
import { withTx } from '../../src/infra/sqlite/driver.ts'
import { acquireNodeRunInTx } from '../../src/service/commands/runtime.ts'
import { applyTransition } from '../../src/service/commands/nodes.ts'
import { startMemoryRun } from '../../src/service/commands/memory.ts'

it('S6 独立工具由只读宿主执行固定命令，并用可核对收据收口和恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-tool-node-'))
  const secret = 'fixture-tool-node'
  const registry = new ToolRegistry()
  registry.register({ name: 'fixture_read', capability: 'read_only', command: { bin: 'fixture:read', args: ['fixed-read'] } })
  registry.register({ name: 'fixture_write', capability: 'mutating', command: { bin: 'fixture:write', args: [] } })
  let available = false
  let code = 0
  let hostCalls = 0
  let loseResult = false
  let startedTool: (() => void) | undefined
  const runner = new ReadOnlyToolRunner(registry, {
    readonlyAvailable: () => available,
    async run(input) {
      expect(input).toMatchObject({ bin: 'fixture:read', args: ['fixed-read'], cwd: dir, timeoutMs: 1000 })
      hostCalls++
      if (startedTool) {
        startedTool()
        await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }))
      }
      if (loseResult) throw new Error('fixture lost tool result after start')
      return { exitCode: code, stdout: 'fixture evidence', stderr: '' }
    },
  }, dir)
  const boot = () => serveOrchestra({
    dbFile: join(dir, 'orchestra.db'), phase: 'S6', secret,
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [],
    appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    executor: { registry, runner, bridge: new BridgeClient({ async request() { throw new Error('unexpected agent call') }, async *listen() {} }) },
  })
  let service = await boot()
  const post = async (path: string, body: unknown) => {
    const response = await fetch(service.endpoint + path, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-orchestra-secret': secret },
    })
    return { status: response.status, ...await response.json() }
  }
  const id = 'independent_tool'
  const name = '独立只读工具'
  const def = (config: object) => ({ name, nodes: [
    { node_id: 'start', type: 'trigger', title: '开始', position: { x: 0, y: 0 } },
    { node_id: 'read', type: 'tool', title: '只读', position: { x: 100, y: 0 }, config },
  ], edges: [{ from: 'start', to: 'read' }] })
  const publish = async (workflow_id: string, config: object, error?: string) => {
    expect(await post('/v1/workflows', { operation_id: uuidv7(), workflow_id, name, definition: def(config) })).toMatchObject({ status: 200 })
    const rehearsal = await post('/v1/workflows/test', { workflow_id, revision: 1 })
    expect(rehearsal).toMatchObject({ status: 200, data: { passed: !error } })
    if (error) expect(rehearsal.data.issues.errors).toContainEqual(expect.objectContaining({ code: error }))
    expect(await post('/v1/workflows/publish', { operation_id: uuidv7(), workflow_id, revision: 1, base_version: 0, publish_note: '工具能力验证' }))
      .toMatchObject(error ? { status: 422, error: { code: 'WORKFLOW_VALIDATION_FAILED' } } : { status: 200 })
  }
  const start = async () => {
    const started = await post('/v1/runs/start', { taskTitle: name, workflowId: id, workflowVersion: '1', operationId: uuidv7() })
    expect(started).toMatchObject({ status: 200 })
    const runId = started.data.run_id as string
    const node = () => service.orchestra.db.raw.prepare('SELECT node_run_id,status,lease_id,attempt FROM node_runs WHERE run_id=?').get(runId)!
    const dispatch = () => post('/v1/runs/dispatch', { runId, nodes: { read: { tools: [] } } })
    return { runId, node, dispatch }
  }
  try {
    await publish('bad_cwd', { command: 'fixture_read', cwd: '../outside', timeout_ms: 1000 }, 'WORKFLOW_NODE_CONFIG_INVALID')
    await publish('bad_args', { command: 'fixture_read', cwd: '.', timeout_ms: 1000, args: ['override'] }, 'WORKFLOW_NODE_CONFIG_INVALID')
    await publish('mutating_command', { command: 'fixture_write', cwd: '.', timeout_ms: 1000 }, 'TOOL_UNAVAILABLE')
    await publish(id, { command: 'fixture_read', cwd: '.', timeout_ms: 1000 })
    const good = await start()
    expect(await good.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'waiting', reason: 'tool_host_unavailable' })] })
    expect(good.node()).toMatchObject({ status: 'queued', lease_id: null })
    expect(hostCalls).toBe(0)
    const unsafeSpec = { runId: good.runId, nodes: { read: { tools: [{ command: 'fixture_write', args: [], cwd: '.', timeoutMs: 1000 }] } } }
    expect(await post('/v1/runs/dispatch', unsafeSpec)).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'skipped', error_code: 'TOOL_NOT_ALLOWED' })] })
    expect(await post('/v1/node-runs/lease', { nodeRunId: good.node().node_run_id, ownerEpoch: service.orchestra.db.epoch, leaseTtlMs: 30_000 }))
      .toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })

    available = true
    expect(await good.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'done', evidence_source: 'run_tool' })] })
    expect(await good.dispatch()).toMatchObject({ status: 200, data: [] })
    expect(hostCalls).toBe(1)
    expect(good.node()).toMatchObject({ status: 'done', lease_id: null })
    const db = service.orchestra.db
    const receipt = db.raw.prepare('SELECT execution_id,tool,exit_code,stdout_hash,command_hash FROM tool_executions WHERE node_run_id=?').get(good.node().node_run_id!)!
    expect(receipt).toMatchObject({ tool: 'fixture_read', exit_code: 0, stdout_hash: sha256Hex('fixture evidence'), command_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const phases = db.raw.prepare("SELECT type FROM node_run_events WHERE node_run_id=? AND type IN ('tool.call','tool_started','tool_finished','tool.completed') ORDER BY seq").all(good.node().node_run_id!)
    expect(phases.map(event => event.type)).toEqual(['tool.call','tool_started','tool_finished','tool.completed'])
    const memory = startMemoryRun(db, { source_run_id: good.runId, reason: '隔离核对', request_key: 'fixture-memory', operation_id: uuidv7(), now: new Date().toISOString() })
    expect(await post('/v1/runs/dispatch', { runId: memory.memory_run_id, nodes: { mem_check: { tools: [] } } }))
      .toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })
    const memoryNode = db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='mem_prepare'").get(memory.memory_run_id)?.node_run_id
    expect(await post('/v1/node-runs/lease', { nodeRunId: memoryNode, ownerEpoch: db.epoch, leaseTtlMs: 30_000 }))
      .toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })

    code = 7
    const bad = await start()
    expect(await bad.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'failed', evidence_source: 'run_tool' })] })
    expect(db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(bad.runId)?.status).toBe('failed')
    expect(db.raw.prepare('SELECT exit_code FROM tool_executions WHERE node_run_id=?').get(bad.node().node_run_id!)?.exit_code).toBe(7)

    loseResult = true
    const interrupted = await start()
    expect(await interrupted.dispatch()).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'waiting' })] })
    expect(interrupted.node()).toMatchObject({ status: 'startup_unknown', lease_id: null })
    expect(await interrupted.dispatch()).toMatchObject({ status: 200, data: [] })
    expect(hostCalls).toBe(3)
    loseResult = false

    // Recreate the durable boundary after a real tool receipt, before the next outcome transaction.
    code = 0
    const restart = await start()
    const nodeRunId = String(restart.node().node_run_id)
    const nowAt = () => new Date().toISOString()
    const lease = withTx(db, tx => {
      const grant = acquireNodeRunInTx(tx, service.orchestra.runtime, { nodeRunId, ownerEpoch: db.epoch, leaseTtlMs: 30_000, now: nowAt() })
      applyTransition(tx, secret, { nodeRunId, from: ['dispatched'], to: 'started', attempt: 1, now: nowAt(), patch: { side_effect_policy: 'pure' } })
      return grant
    })
    const collector = new EvidenceCollector({ db, secret, registry, runner, policy: { allow: ['fixture_read'] }, allowedTools: ['fixture_read'],
      nodeRunId, attempt: 1, executorAgentId: 'standalone:' + nodeRunId, standalone: {}, lease, nowAt })
    await collector.collect({ callId: 'standalone', tool: 'fixture_read', args: ['fixed-read'], cwd: '.', timeoutMs: 1000 })
    expect(restart.node().status).toBe('started')
    expect(hostCalls).toBe(4)
    await service.close()
    service = await boot()
    sweepNow(service.orchestra.runtime, nowAt())
    expect(restart.node()).toMatchObject({ status: 'done', lease_id: null, attempt: 1 })
    expect(service.orchestra.db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(restart.runId)?.status).toBe('succeeded')
    expect(hostCalls).toBe(4)

    const cancelling = await start()
    const runningTool = new Promise<void>(resolve => { startedTool = resolve })
    const inFlight = cancelling.dispatch()
    await runningTool
    const cancellable = cancelling.node()
    expect(await post('/v1/node-runs/renew', { nodeRunId: cancellable.node_run_id, leaseTtlMs: 30_000 }))
      .toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })
    expect(await post('/v1/runs/cancel', { runId: cancelling.runId, cancelResult: 'interrupted', graceMs: 5000 })).toMatchObject({ status: 200 })
    expect(await inFlight).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'waiting' })] })
    expect(cancelling.node().status).toBe('timing_out')
    expect(service.orchestra.db.raw.prepare('SELECT COUNT(*) AS n FROM tool_executions WHERE node_run_id=?').get(cancellable.node_run_id!)?.n).toBe(0)
  } finally {
    await service.close()
    await rm(dir, { recursive: true, force: true })
  }
})
