// Run after pnpm build, passing the installed DSH CLI entry (dsh/lib/bin.js).
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { uuidv7 } from '../src/core/ids.ts'

const self = fileURLToPath(import.meta.url)
const PROVIDER = 'orchestra-collaboration-probe'
const PARENT = 'probe-lead'
const SOURCE = 'probe-source'
const TARGET = 'probe-verifier'
const FLOW = 'native-verification-probe'
const TOOL = 'ro.verify_fixture'

export const name = 'orchestra-collaboration-probe'
export const inject = ['agents', 'tools', 'llm', 'appExit']

export function apply(context) {
  void verifyInDsh(context).then((proof) => {
    console.log('ORCHESTRA_COLLABORATION_PROBE ' + JSON.stringify(proof))
    context.get('appExit')(0)
  }, (error) => {
    console.error(error?.stack ?? error)
    context.get('appExit')(1)
  })
}

async function verifyInDsh(context) {
  const { serveDshOrchestra, ToolRegistry, ReadOnlyToolRunner } = await import('../lib/index.js')
  const cwd = process.cwd()
  const parent = await context.agents.create({ sessionId: randomUUID(), meta: { cwd }, agentOptions: { provider: PROVIDER, model: PARENT } })
  const registry = new ToolRegistry()
  registry.register({ name: TOOL, capability: 'read_only',
    command: { bin: process.execPath, args: ['-e', 'process.stdout.write("fixture: index entry missing its attachment")'] } })
  const runner = new ReadOnlyToolRunner(registry, {
    readonlyAvailable: () => true,
    async run({ bin, args, cwd, timeoutMs }) {
      const result = await promisify(execFile)(bin, args, { cwd, timeout: timeoutMs, windowsHide: true })
      return { ...result, exitCode: 0 }
    },
  }, cwd)
  const secret = randomUUID()
  const headers = { 'x-orchestra-secret': secret, 'content-type': 'application/json' }
  const uses = []
  let service, sourceTaskId
  try {
    service = await serveDshOrchestra({
      dbFile: join(cwd, 'orchestra.sqlite'), secret, phase: 'S5', collaboration: true, tools: { registry, runner },
      dsh: {
        context, parentForNode: () => parent.agent,
        models: [
          { ref: 'approved/source', capacity: 'routine', provider: PROVIDER, model: SOURCE },
          { ref: 'approved/verifier', capacity: 'complex', provider: PROVIDER, model: TARGET },
        ],
        recommend: ({ taskId }) => ({ complexity: taskId === sourceTaskId ? 'routine' : 'complex', reason: '受控核验验收' }),
        onModelUse: (usage) => uses.push(usage),
      },
      asOfSeq: () => Number(service?.orchestra.db.raw.prepare('SELECT MAX(seq) AS seq FROM events').get().seq ?? 0),
      listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => {},
    })
    const call = async (path, body) => {
      const response = await fetch(new URL(path, service.endpoint),
        body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })
      const receipt = await response.json()
      assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? receipt))
      return receipt.data
    }
    const title = '真实 DSH 独立核验'
    const position = { x: 0, y: 0 }
    const draft = await call('/v1/workflows', { workflow_id: FLOW, name: title, operation_id: uuidv7(), definition: {
      name: title, nodes: [{ node_id: 'trigger', title: '发起', type: 'trigger', position }, {
        node_id: 'verify', title: '独立核对', type: 'agent', position,
        config: { tools: { allow: [TOOL] }, pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }] },
      }], edges: [{ from: 'trigger', to: 'verify' }],
    } })
    await call('/v1/workflows/publish', {
      workflow_id: FLOW, base_version: 0, revision: draft.revision, publish_note: '隔离验收', operation_id: uuidv7(),
    })
    const start = (taskTitle) => call('/v1/runs/start', { workflowId: FLOW, workflowVersion: '1', taskTitle, operationId: uuidv7() })
    const source = await start('来源任务')
    sourceTaskId = source.task_id
    const target = await start('独立核验任务')
    const node = async (runId) => (await call('/v1/node-runs?run_id=' + encodeURIComponent(runId))).items[0]
    const sourceNode = await node(source.run_id)
    const targetNode = await node(target.run_id)
    const scope = await call('/v1/collaboration/scopes', { operation_id: uuidv7(), title: '交叉核验',
      node_run_ids: [sourceNode.node_run_id, targetNode.node_run_id], ttl_minutes: 10 })
    const detail = () => call('/v1/collaboration/scopes/get?scope_id=' + encodeURIComponent(scope.scope_id))
    const run = (node) => call('/v1/node-runs/run', {
      nodeRunId: node.node_run_id, nodeId: node.node_id, attempt: 1,
      input: { sourceNode: sourceNode.node_run_id }, outputSchema: { type: 'object' },
      tools: [{ command: TOOL, args: [], cwd, timeoutMs: 15_000 }],
      ownerEpoch: service.orchestra.db.epoch, leaseTtlMs: 30_000,
    })
    assert.equal((await run(sourceNode)).final_status, 'done')
    const incoming = await detail()
    assert.equal(incoming.findings.length, 1)
    assert.equal(incoming.requests.length, 1)
    const proposed = incoming.requests[0]
    assert.equal(proposed.target_node_run_id, targetNode.node_run_id)
    assert.equal(proposed.status, 'proposed')
    const review = (request, action, note) => call('/v1/collaboration/review', {
      request_id: request.request_id, expected_revision: request.revision, action, note, operation_id: uuidv7(),
    })
    assert.equal((await review(proposed, 'authorize', '同意独立核对')).status, 'authorized')
    assert.equal((await run(targetNode)).final_status, 'done')
    const checked = (await detail()).requests[0]
    assert.equal(checked.status, 'completed')
    assert.equal(checked.verdict, 'confirmed')
    assert.equal((await review(checked, 'adopt', '采纳独立核验结论')).adoption, 'adopted')
    const sourceEvidence = await call('/v1/evidence/get?evidence_id=' + incoming.findings[0].evidence_id)
    const targetEvidence = await call('/v1/evidence/get?evidence_id=' + checked.evidence_id)
    assert.equal(sourceEvidence.node_run_id, sourceNode.node_run_id)
    assert.equal(targetEvidence.node_run_id, targetNode.node_run_id)
    assert.notEqual(sourceEvidence.evidence_id, targetEvidence.evidence_id)
    const events = service.orchestra.db.raw.prepare("SELECT type FROM events WHERE type LIKE 'collaboration.%' ORDER BY seq").all().map(({ type }) => type)
    assert.deepEqual(events, ['collaboration.scope_created', 'collaboration.finding_reported', 'collaboration.proposed',
      'collaboration.authorized', 'collaboration.delivered', 'collaboration.accepted', 'collaboration.completed', 'collaboration.adopted'])
    assert.deepEqual([...new Set(uses.map(({ model }) => model))], [SOURCE, TARGET])
    return { sourceRun: source.run_id, verifierRun: target.run_id, sourceEvidence: sourceEvidence.evidence_id,
      verifierEvidence: targetEvidence.evidence_id, requestId: checked.request_id, verdict: checked.verdict, events,
      dshSessions: new Set(uses.map(({ sessionId }) => sessionId)).size }
  } finally {
    try { await service?.close() } finally { await parent.dispose() }
  }
}

function parseToolReply(message) {
  const content = message.content
  const text = Array.isArray(content) ? content.map((block) => block.text ?? '').join('') : content
  const value = JSON.parse(text)
  return typeof value?.text === 'string' ? JSON.parse(value.text) : value
}

const read = () => ['orchestra_read_tool', { tool: TOOL, args: [] }]
const verification = (action, args = {}) => ['orchestra_verification', { ...args, action }]
const sourceSteps = [
  read,
  () => verification('inbox'),
  ([proof, inbox]) => verification('finding', { scope_id: inbox.memberships[0].scope_id, evidence_id: proof.evidenceId,
    title: '附件缺失', summary: '在来源保存的索引中发现这一条记录缺少附件。' }),
  ([, inbox, finding]) => {
    const target = inbox.memberships[0].members.find(({ node_run_id }) => node_run_id !== finding.source_node_run_id)
    return verification('request', { finding_id: finding.finding_id, target_node_run_id: target.node_run_id, question: '请独立核对附件索引。', ttl_minutes: 5 })
  },
]
const targetSteps = [
  () => verification('inbox'),
  ([inbox]) => verification('delivered', { request_id: inbox.items[0].request.request_id, expected_revision: inbox.items[0].request.revision }),
  ([, delivered]) => verification('accept', { request_id: delivered.request_id, expected_revision: delivered.revision }),
  read,
  ([, , accepted, proof]) => verification('complete', { request_id: accepted.request_id, expected_revision: accepted.revision,
    result: '独立读取索引，确认这条记录没有附件。', verdict: 'confirmed', evidence_id: proof.evidenceId }),
]

async function main(bin) {
  if (!bin) throw new Error('Pass the installed DSH CLI entry path.')
  const root = await mkdtemp(join(tmpdir(), 'orchestra-dsh-collaboration-'))
  const trace = []
  const failures = []
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const request = JSON.parse(raw)
      const steps = request.model === SOURCE ? sourceSteps : targetSteps
      assert.ok([SOURCE, TARGET].includes(request.model))
      const replies = request.messages.filter((item) => item.role === 'tool').map(parseToolReply)
      const call = steps[replies.length]?.(replies)
      if (call) assert.ok(request.tools?.some((tool) => tool.function.name === call[0]), 'expected registered tool')
      trace.push([request.model, call?.[1].action ?? call?.[0] ?? 'done'])
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'probe_step_' + replies.length, type: 'function',
        function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
        : { role: 'assistant', content: '{"status":"done","output":{"ok":true}}' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }]) {
        res.write('data: ' + JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, ...choice }] }) + '\n\n')
      }
      res.end('data: [DONE]\n\n')
    } catch (error) {
      failures.push(String(error))
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise((done) => provider.listen(0, '127.0.0.1', done))
  try {
    const patch = join(root, 'probe.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'headless-runner', disabled: true },
      { id: 'llm-pi-ai', config: { providers: { [PROVIDER]: {
        api: 'openai-completions', apiKeyEnv: 'ORCHESTRA_DSH_PROBE_KEY', baseURL: 'http://127.0.0.1:' + provider.address().port + '/v1',
        models: [PARENT, SOURCE, TARGET].map((id) => ({ id, contextWindow: 32768, maxTokens: 8192, input: ['text'] })),
      } } } },
      { insert: [{ id: name, name: self.replaceAll('\\', '/') }] },
    ]))
    const result = await promisify(execFile)(process.execPath, [resolve(bin), '--profile', 'headless', '--patch', patch, 'Orchestra collaboration probe'], {
      cwd: root, timeout: 75_000, windowsHide: true, env: { ...process.env, DSH_HOME: join(root, 'dsh'), ORCHESTRA_DSH_PROBE_KEY: 'loopback-fixture' },
    }).catch((error) => {
      throw new Error(String(error.stderr) + '\n' + String(error.stdout) + '\n' + failures.join('\n'), { cause: error })
    })
    const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith('ORCHESTRA_COLLABORATION_PROBE '))
    assert.ok(line, result.stdout + '\n' + result.stderr)
    assert.deepEqual(trace.map((entry) => entry[1]), [
      'orchestra_read_tool', 'inbox', 'finding', 'request', 'done', 'inbox', 'delivered', 'accept', 'orchestra_read_tool', 'complete', 'done',
    ])
    console.log(line)
    console.log('Native DSH tool actions: ' + JSON.stringify(trace))
  } finally {
    await new Promise((done) => provider.close(done))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === self) await main(process.argv[2])
