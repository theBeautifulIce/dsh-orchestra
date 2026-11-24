import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { uuidv7 } from '../../src/core/ids.ts'
import { BridgeClient } from '../../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../../src/executor/tools.ts'
import { registerRunArtifact, serveOrchestra } from '../../src/index.ts'
import { fakeAgentBridge } from '../fixtures/agent-bridge.ts'

const secret = 'local-review-service'
const primary = 'human:primary'
const other = 'human:other'
const primarySession = 'fixture-primary'
const otherSession = 'fixture-other'
const workflowId = 'direct_review_owner'
const tool = 'fixture.read'

type Reply<T> = { status: number; data?: T; error?: { code: string; message: string } }

async function boot(dir: string, phase: 'S5' | 'S6') {
  const registry = new ToolRegistry()
  registry.register({ name: tool, capability: 'read_only', command: { bin: 'fixture-read', args: [] } })
  const service = await serveOrchestra({
    dbFile: join(dir, 'ledger.db'), phase, secret,
    asOfSeq: () => 0, listEvents: () => [], listTasks: () => [], appendLedgerEvent: () => ({ seq: 0, event_id: 'fixture' }),
    resolveHttpHuman: (req) => {
      if (req.headers.authorization === 'Bearer ' + primarySession) return { id: primary }
      if (req.headers.authorization === 'Bearer ' + otherSession) return { id: other }
      return null
    },
    executor: {
      registry,
      bridge: new BridgeClient(fakeAgentBridge({ agentId: 'fixture-runner', steps: [{ tool }], at: new Date().toISOString() })),
      runner: new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true,
        async run() { return { exitCode: 0, stdout: 'fixture bytes', stderr: '' } } }, dir),
    },
  })
  async function post<T = unknown>(path: string, body: unknown, session?: string): Promise<Reply<T>> {
    const response = await fetch(service.endpoint + path, { method: 'POST', headers: {
      'x-orchestra-secret': secret, 'content-type': 'application/json',
      ...(session ? { authorization: 'Bearer ' + session } : {}),
    }, body: JSON.stringify(body) })
    return { status: response.status, ...await response.json() as Omit<Reply<T>, 'status'> }
  }
  return { service, post, db: service.orchestra.db }
}

async function install(fixture: Awaited<ReturnType<typeof boot>>) {
  const response = await fixture.post('/v1/workflows/load', { workflow_id: workflowId, workflow_version: '1',
    nodes: ['source', 'dependent'].map(node_id => ({ node_id, type: 'agent', side_effect_policy: 'pure', tools: { allow: [tool] } })),
    edges: [{ from: 'source', to: 'dependent' }],
  })
  expect(response.status).toBe(200)
}

function startInput(operationId = uuidv7()) {
  return { workflowId, workflowVersion: '1', taskTitle: 'S6 direct review fixture', operationId,
    startedBy: other, actor: { kind: 'human', id: other } }
}

function hold(run: string, node: string) {
  return { operation_id: uuidv7(), action: 'hold', run_id: run, node_run_id: node }
}

it('uses the host starter for direct S6 review and rework, survives reopening and keeps replay scoped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-review-owner-'))
  let fixture: Awaited<ReturnType<typeof boot>> | undefined
  try {
    fixture = await boot(dir, 'S6')
    await install(fixture)
    const input = startInput()
    const first = await fixture.post<{ run_id: string }>('/v1/runs/start', input, primarySession)
    expect(first.status).toBe(200)
    const runId = first.data!.run_id
    expect(fixture.db.raw.prepare('SELECT started_by FROM start_run_operations WHERE operation_id=?').get(input.operationId)?.started_by).toBe(primary)
    expect(await fixture.post('/v1/runs/start', input, otherSession)).toMatchObject({ status: 409, error: { code: 'OPERATION_ID_CONFLICT' } })
    expect(await fixture.post('/v1/runs/start', input)).toMatchObject({ status: 409, error: { code: 'OPERATION_ID_CONFLICT' } })
    await fixture.service.close()
    fixture = undefined

    fixture = await boot(dir, 'S6')
    expect(await fixture.post('/v1/runs/start', input, primarySession)).toMatchObject({ status: 200, data: { run_id: runId, replayed: true } })
    const node = fixture.db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='source'").get(runId)!
    const nodeId = String(node.node_run_id)
    const request = hold(runId, nodeId)
    expect(await fixture.post('/v1/rework/hold', request, otherSession)).toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })
    expect(await fixture.post('/v1/rework/hold', request)).toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })
    expect(await fixture.post('/v1/rework/hold', request, primarySession)).toMatchObject({ status: 200 })
    expect(await fixture.post('/v1/rework/hold', request, primarySession)).toMatchObject({ status: 200 })
    expect(fixture.db.raw.prepare("SELECT owner_actor FROM delivery_review_holds WHERE run_id=?").get(runId)?.owner_actor).toBe(primary)

    const dispatch = await fixture.post('/v1/runs/dispatch', { runId, nodes: {
      source: { tools: [{ command: tool, args: [], cwd: '.', timeoutMs: 5_000 }], input: {}, outputSchema: {} },
    } })
    expect(dispatch).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'done' })] })
    const artifactId = 'source-review-artifact'
    const artifact = registerRunArtifact(fixture.db, { artifactId, runId, nodeRunId: nodeId, fileName: 'source.txt', bytes: Buffer.from('fixture bytes') })
    const revision = Number(fixture.db.raw.prepare('SELECT revision FROM node_runs WHERE node_run_id=?').get(nodeId)?.revision)
    const feedback = { operation_id: uuidv7(), run_id: runId, target_node_run_id: nodeId, source_artifact_id: artifactId,
      source_artifact_hash: artifact.sha256, expected_revision: revision, reason: 'Adjust the fixture text',
      expected_result: 'Updated text', preserve_requirements: [], suggested_scope: 'replan_subgraph', evidence_ids: [] }
    expect(await fixture.post('/v1/rework/request', feedback, otherSession)).toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })
    const filed = await fixture.post<{ request_id: string; revision: number }>('/v1/rework/request', feedback, primarySession)
    expect(filed).toMatchObject({ status: 200, data: { owner_actor: primary } })
    const review = { operation_id: uuidv7(), request_id: filed.data!.request_id, expected_revision: filed.data!.revision,
      action: 'reject', note: 'Refine the proposal first' }
    expect(await fixture.post('/v1/rework/review', review, otherSession)).toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } })
    expect(await fixture.post('/v1/rework/review', review, primarySession)).toMatchObject({ status: 200, data: { status: 'declined' } })
    expect(fixture.db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=? AND type='rework.hold_hold'").get(runId)?.n).toBe(1)
  } finally {
    await fixture?.service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('leaves service and historical starts unowned in S6 and preserves their S5 compatibility', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-review-unowned-'))
  let fixture: Awaited<ReturnType<typeof boot>> | undefined
  try {
    fixture = await boot(dir, 'S5')
    await install(fixture)
    const historical = startInput()
    const started = await fixture.post<{ run_id: string }>('/v1/runs/start', historical, primarySession)
    const runId = started.data!.run_id
    const nodeId = String(fixture.db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='source'").get(runId)?.node_run_id)
    expect(await fixture.post('/v1/rework/hold', hold(runId, nodeId))).toMatchObject({ status: 200 })
    await fixture.service.close()
    fixture = undefined

    fixture = await boot(dir, 'S6')
    expect(await fixture.post('/v1/runs/start', historical, primarySession)).toMatchObject({ status: 200, data: { run_id: runId, replayed: true } })
    expect(await fixture.post('/v1/rework/hold', hold(runId, nodeId), primarySession))
      .toMatchObject({ status: 403, error: { code: 'FORBIDDEN', message: expect.stringContaining('未记录可信的人工负责人') } })
    const newServiceInput = startInput()
    const newServiceRun = await fixture.post<{ run_id: string }>('/v1/runs/start', newServiceInput)
    expect(newServiceRun.status).toBe(200)
    const newNode = String(fixture.db.raw.prepare('SELECT node_run_id FROM node_runs WHERE run_id=? ORDER BY seq LIMIT 1').get(newServiceRun.data!.run_id)?.node_run_id)
    expect(await fixture.post('/v1/rework/hold', hold(newServiceRun.data!.run_id, newNode), otherSession))
      .toMatchObject({ status: 403, error: { code: 'FORBIDDEN', message: expect.stringContaining('未记录可信的人工负责人') } })
    expect(fixture.db.raw.prepare('SELECT started_by FROM start_run_operations ORDER BY operation_id').all())
      .toEqual([{ started_by: null }, { started_by: null }])
  } finally {
    await fixture?.service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('accepts one review generation only, so a second page cannot overwrite a submitted conclusion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-review-cas-'))
  let fixture: Awaited<ReturnType<typeof boot>> | undefined
  try {
    fixture = await boot(dir, 'S6')
    await install(fixture)
    const started = await fixture.post<{ run_id: string }>('/v1/runs/start', startInput(), primarySession)
    const runId = started.data!.run_id
    const nodeRunId = String(fixture.db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='source'").get(runId)?.node_run_id)
    expect(await fixture.post('/v1/rework/hold', hold(runId, nodeRunId), primarySession)).toMatchObject({ status: 200 })
    const dispatch = await fixture.post('/v1/runs/dispatch', { runId, nodes: {
      source: { tools: [{ command: tool, args: [], cwd: '.', timeoutMs: 5_000 }], input: {}, outputSchema: {} },
    } })
    expect(dispatch).toMatchObject({ status: 200, data: [expect.objectContaining({ status: 'done' })] })
    const first = registerRunArtifact(fixture.db, { artifactId: 'review-a', runId, nodeRunId, fileName: 'review.md', bytes: Buffer.from('first version') })
    const second = registerRunArtifact(fixture.db, { artifactId: 'review-b', runId, nodeRunId, fileName: 'review.md', bytes: Buffer.from('second version') })
    const accept = (artifact: typeof first) => ({ operation_id: uuidv7(), run_id: runId, node_run_id: nodeRunId,
      action: 'accept' as const, artifact_id: artifact.artifact_id, sha256: artifact.sha256 })
    expect(await fixture.post('/v1/rework/hold', accept(first), primarySession)).toMatchObject({ status: 200 })
    // 另一个页面拿着不同操作号提交第二个版本：代次已不是 held，必须拒绝而不是覆盖。
    expect(await fixture.post('/v1/rework/hold', accept(second), primarySession)).toMatchObject({
      status: 409, error: { code: 'STALE_GENERATION' },
    })
    expect(fixture.db.raw.prepare('SELECT status,artifact_id,sha256 FROM delivery_review_holds WHERE run_id=?').get(runId))
      .toMatchObject({ status: 'accepted', artifact_id: 'review-a', sha256: first.sha256 })
    // 已提交结论也不能被旧页面的撤销静默清掉。
    expect(await fixture.post('/v1/rework/hold', { operation_id: uuidv7(), run_id: runId, node_run_id: nodeRunId, action: 'withdraw' },
      primarySession)).toMatchObject({ status: 409, error: { code: 'STALE_GENERATION' } })
  } finally {
    await fixture?.service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('confirms a multi-file step against the review set captured at hold time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-review-set-'))
  let fixture: Awaited<ReturnType<typeof boot>> | undefined
  try {
    fixture = await boot(dir, 'S6')
    await install(fixture)
    const started = await fixture.post<{ run_id: string }>('/v1/runs/start', startInput(), primarySession)
    const runId = started.data!.run_id
    const nodeRunId = String(fixture.db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='source'").get(runId)?.node_run_id)
    const dispatch = await fixture.post('/v1/runs/dispatch', { runId, nodes: {
      source: { tools: [{ command: tool, args: [], cwd: '.', timeoutMs: 5_000 }], input: {}, outputSchema: {} },
    } })
    expect(dispatch).toMatchObject({ status: 200 })
    const report = registerRunArtifact(fixture.db, { artifactId: 'set-report', runId, nodeRunId, fileName: 'report.md', bytes: Buffer.from('report body') })
    const detail = registerRunArtifact(fixture.db, { artifactId: 'set-detail', runId, nodeRunId, fileName: 'data.csv', bytes: Buffer.from('a,b') })
    // 留验在成果登记之后：这一轮的应审清单就固定为这两份。
    expect(await fixture.post('/v1/rework/hold', hold(runId, nodeRunId), primarySession)).toMatchObject({ status: 200 })
    const accept = (artifact: { artifact_id: string; sha256: string }) => ({ operation_id: uuidv7(), run_id: runId,
      node_run_id: nodeRunId, action: 'accept' as const, artifact_id: artifact.artifact_id, sha256: artifact.sha256 })
    const first = await fixture.post<{ status: string; pending?: string[] }>('/v1/rework/hold', accept(report), primarySession)
    expect(first).toMatchObject({ status: 200, data: { status: 'held', pending: ['data.csv'] } })
    expect(fixture.db.raw.prepare('SELECT status FROM delivery_review_holds WHERE run_id=?').get(runId)).toMatchObject({ status: 'held' })
    expect(fixture.db.raw.prepare("SELECT status FROM runs WHERE run_id=?").get(runId)).toMatchObject({ status: 'running' })
    // 留验之后才登记的版本不在这一轮清单里，不能混进来。
    const late = registerRunArtifact(fixture.db, { artifactId: 'set-late', runId, nodeRunId, fileName: 'late.md', bytes: Buffer.from('late') })
    expect(await fixture.post('/v1/rework/hold', accept(late), primarySession))
      .toMatchObject({ status: 409, error: { code: 'CONFIRMATION_MISMATCH' } })
    expect(await fixture.post('/v1/rework/hold', accept(detail), primarySession))
      .toMatchObject({ status: 200, data: { status: 'accepted' } })
    expect(fixture.db.raw.prepare('SELECT status FROM delivery_review_holds WHERE run_id=?').get(runId)).toMatchObject({ status: 'accepted' })
  } finally {
    await fixture?.service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('waits for every file when the hold was taken before anything was delivered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-review-early-hold-'))
  let fixture: Awaited<ReturnType<typeof boot>> | undefined
  try {
    fixture = await boot(dir, 'S6')
    await install(fixture)
    const started = await fixture.post<{ run_id: string }>('/v1/runs/start', startInput(), primarySession)
    const runId = started.data!.run_id
    const nodeRunId = String(fixture.db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='source'").get(runId)?.node_run_id)
    // 先点留验、后交文件：留验时清单为空，不能把它当成「无需核对」（D03）。
    const held = await fixture.post<{ hold_id: string; revision: number }>('/v1/rework/hold', hold(runId, nodeRunId), primarySession)
    expect(held).toMatchObject({ status: 200, data: { status: 'held' } })
    const dispatch = await fixture.post('/v1/runs/dispatch', { runId, nodes: {
      source: { tools: [{ command: tool, args: [], cwd: '.', timeoutMs: 5_000 }], input: {}, outputSchema: {} },
    } })
    expect(dispatch).toMatchObject({ status: 200 })
    const report = registerRunArtifact(fixture.db, { artifactId: 'early-report', runId, nodeRunId, fileName: 'report.md', bytes: Buffer.from('report body') })
    const detail = registerRunArtifact(fixture.db, { artifactId: 'early-detail', runId, nodeRunId, fileName: 'data.csv', bytes: Buffer.from('a,b') })
    const accept = (artifact: { artifact_id: string; sha256: string }) => ({ operation_id: uuidv7(), run_id: runId,
      node_run_id: nodeRunId, action: 'accept' as const, artifact_id: artifact.artifact_id, sha256: artifact.sha256 })
    const first = await fixture.post<{ status: string; pending?: string[] }>('/v1/rework/hold', accept(report), primarySession)
    expect(first).toMatchObject({ status: 200, data: { status: 'held', pending: ['data.csv'] } })
    expect(fixture.db.raw.prepare('SELECT status FROM runs WHERE run_id=?').get(runId)).toMatchObject({ status: 'running' })
    expect(await fixture.post('/v1/rework/hold', accept(detail), primarySession))
      .toMatchObject({ status: 200, data: { status: 'accepted' } })
    expect(fixture.db.raw.prepare('SELECT status FROM delivery_review_holds WHERE run_id=?').get(runId)).toMatchObject({ status: 'accepted' })
  } finally {
    await fixture?.service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('rejects a conclusion from an old page after the hold was withdrawn and taken again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-review-hold-cas-'))
  let fixture: Awaited<ReturnType<typeof boot>> | undefined
  try {
    fixture = await boot(dir, 'S6')
    await install(fixture)
    const started = await fixture.post<{ run_id: string }>('/v1/runs/start', startInput(), primarySession)
    const runId = started.data!.run_id
    const nodeRunId = String(fixture.db.raw.prepare("SELECT node_run_id FROM node_runs WHERE run_id=? AND node_id='source'").get(runId)?.node_run_id)
    const dispatch = await fixture.post('/v1/runs/dispatch', { runId, nodes: {
      source: { tools: [{ command: tool, args: [], cwd: '.', timeoutMs: 5_000 }], input: {}, outputSchema: {} },
    } })
    expect(dispatch).toMatchObject({ status: 200 })
    const report = registerRunArtifact(fixture.db, { artifactId: 'cas-report', runId, nodeRunId, fileName: 'report.md', bytes: Buffer.from('report body') })
    const detail = registerRunArtifact(fixture.db, { artifactId: 'cas-detail', runId, nodeRunId, fileName: 'data.csv', bytes: Buffer.from('a,b') })
    const pageA = await fixture.post<{ hold_id: string; revision: number }>('/v1/rework/hold', hold(runId, nodeRunId), primarySession)
    expect(pageA).toMatchObject({ status: 200 })
    const seenA = { hold_id: pageA.data!.hold_id, expected_revision: pageA.data!.revision }
    const accept = (artifact: { artifact_id: string; sha256: string }) => ({ operation_id: uuidv7(), run_id: runId,
      node_run_id: nodeRunId, action: 'accept' as const, artifact_id: artifact.artifact_id, sha256: artifact.sha256 })
    expect(await fixture.post('/v1/rework/hold', { ...accept(report), ...seenA }, primarySession))
      .toMatchObject({ status: 200, data: { status: 'held' } })
    // B 页撤销并以同一节点重建留验：新一轮有自己的身份，A 页手上的旧身份随即失效。
    expect(await fixture.post('/v1/rework/hold', { operation_id: uuidv7(), run_id: runId, node_run_id: nodeRunId,
      action: 'withdraw' as const, ...seenA, expected_revision: seenA.expected_revision + 1 }, primarySession))
      .toMatchObject({ status: 200, data: { status: 'withdrawn' } })
    const pageB = await fixture.post<{ hold_id: string; revision: number }>('/v1/rework/hold', hold(runId, nodeRunId), primarySession)
    expect(pageB).toMatchObject({ status: 200, data: { status: 'held' } })
    expect(pageB.data!.hold_id).not.toBe(seenA.hold_id)
    expect(await fixture.post('/v1/rework/hold', { ...accept(report), ...seenA }, primarySession))
      .toMatchObject({ status: 409, error: { code: 'STALE_GENERATION' } })
    expect(await fixture.post('/v1/rework/hold', { ...accept(detail), ...seenA }, primarySession))
      .toMatchObject({ status: 409, error: { code: 'STALE_GENERATION' } })
    expect(await fixture.post('/v1/rework/hold', { ...accept(detail), hold_id: pageB.data!.hold_id,
      expected_revision: pageB.data!.revision }, primarySession))
      .toMatchObject({ status: 200, data: { status: 'held' } })
  } finally {
    await fixture?.service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
