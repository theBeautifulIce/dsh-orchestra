// Run with the installed DSH CLI entry, e.g. node scripts/dsh-model-routing-probe.mjs <dsh/lib/bin.js>.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { uuidv7 } from '../src/core/ids.ts'

const self = fileURLToPath(import.meta.url)
const ROUTINE = 'route-probe-fast'
const PREFERRED = 'route-probe-fast-custom'
const COMPLEX = 'route-probe-complex'
const PARENT = 'route-probe-parent'
const PROVIDER = 'orchestra-probe'
const PLANNER = 'route-probe-planner'
const FLOW = 'model-probe'
const NODES = ['organize', 'compare']
const modelFor = (node) => node === 'compare' ? COMPLEX : PREFERRED

export const name = 'orchestra-model-routing-probe'
export const inject = ['agents', 'tools', 'llm', 'appExit']

// DSH's profile loader calls this with the live Cordis context. Only the provider endpoint is a fixture.
export function apply(ctx) {
  void executeInDsh(ctx).then((evidence) => {
    process.stdout.write('ORCHESTRA_DSH_PROBE ' + JSON.stringify(evidence) + '\n')
    ctx.get('appExit')(0)
  }, (error) => {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    ctx.get('appExit')(1)
  })
}

async function executeInDsh(context) {
  const { serveDshOrchestra, ToolRegistry, ReadOnlyToolRunner } = await import('../lib/index.js')
  const cwd = process.cwd()
  const parent = await context.agents.create({
    sessionId: randomUUID(), meta: { cwd }, agentOptions: { provider: PROVIDER, model: PARENT },
  })
  const observed = []
  const registry = new ToolRegistry()
  registry.register({ name: 'ro.probe', capability: 'read_only',
    command: { bin: process.execPath, args: ['-e', 'process.stdout.write("verified")'] } })
  const runner = new ReadOnlyToolRunner(registry, {
    readonlyAvailable: () => true,
    async run({ bin, args, cwd, timeoutMs }) {
      const result = await promisify(execFile)(bin, args, { cwd, timeout: timeoutMs, windowsHide: true })
      return { ...result, exitCode: 0 }
    },
  }, cwd)
  const secret = randomUUID()
  let service
  try {
    service = await serveDshOrchestra({
      dbFile: join(cwd, 'orchestra.sqlite'), secret, phase: 'S5', tools: { registry, runner },
      dsh: {
        context, parentForNode: () => parent.agent,
        models: [
          { ref: 'approved/fast', capacity: 'routine', provider: PROVIDER, model: ROUTINE },
          { ref: 'approved/custom-fast', capacity: 'routine', provider: PROVIDER, model: PREFERRED },
          { ref: 'approved/complex', capacity: 'complex', provider: PROVIDER, model: COMPLEX },
        ],
        recommend: () => { throw new Error('This run must load the approved plan recommendation') },
        onModelUse: (usage) => observed.push(usage),
      },
      dshPlanner: { parent: () => parent.agent, model: { provider: PROVIDER, model: PLANNER } },
      asOfSeq: () => Number(service?.orchestra.db.raw.prepare('SELECT MAX(seq) AS seq FROM events').get().seq ?? 0),
      listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => {},
    })
    const call = async (path, body) => {
      const response = await fetch(new URL(path, service.endpoint), body === undefined
        ? { headers: { 'x-orchestra-secret': secret } }
        : { method: 'POST', headers: { 'x-orchestra-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const receipt = await response.json()
      assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? receipt))
      return receipt.data
    }
    const flowTitle = 'DSH 模型验收流程'
    const draft = await call('/v1/workflows', { workflow_id: FLOW, name: flowTitle, operation_id: uuidv7(), definition: {
      name: flowTitle,
      nodes: [{ node_id: 'trigger', title: '手工发起', type: 'trigger', position: { x: 0, y: 0 } },
        ...NODES.map((node_id, index) => ({ node_id, title: node_id, type: 'agent', position: { x: index + 1, y: 0 },
          config: { tools: { allow: ['ro.probe'] }, pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }] } }))],
      edges: [{ from: 'trigger', to: 'organize' }, { from: 'organize', to: 'compare' }],
    } })
    await call('/v1/workflows/publish', { workflow_id: FLOW, base_version: 0, revision: draft.revision,
      publish_note: '隔离验收流程', operation_id: uuidv7() })
    const mapping = { routine: 'approved/custom-fast', standard: null, complex: 'approved/complex' }
    await call('/v1/settings/model-routing', { expected_revision: 0, mapping, operation_id: uuidv7() })
    assert.deepEqual((await call('/v1/settings/model-routing')).mapping, mapping)
    const plan = await call('/v1/task-plans', { goal: '先整理条目，再独立复核', requirements: ['保留工具回执'] })
    assert.equal(plan.quality.ready, true, JSON.stringify(plan.quality))
    const task = await call('/v1/task-plans/confirm', { plan_id: plan.plan_id, content_hash: plan.content_hash, confirmed: true })
    let items = []
    for (let tick = 0; tick < 80; tick++) {
      items = (await call('/v1/node-runs?run_id=' + task.run_id)).items
      if (items.length === NODES.length && items.every((item) => item.status === 'done')) break
      await delay(200)
    }
    assert.deepEqual(items.map((item) => item.status), ['done', 'done'], JSON.stringify(items))
    const results = []
    for (const recorded of items) {
      assert.equal(recorded.execution_count, 1)
      assert.equal(recorded.model_assignment.model_ref, recorded.node_id === 'compare' ? 'approved/complex' : 'approved/custom-fast')
      assert.equal(recorded.model_assignment.usage?.model, modelFor(recorded.node_id))
      assert.equal(recorded.model_assignment.settings_revision, 1)
      const used = observed.find((item) => item.nodeRunId === recorded.node_run_id)
      assert.ok(used)
      results.push({ node: recorded.node_id, model: recorded.model_assignment.model_ref, status: recorded.status, sessionId: used.sessionId })
    }
    assert.deepEqual(observed.map((usage) => usage.model), [PREFERRED, COMPLEX])
    assert.deepEqual(observed.map((usage) => usage.sessionId), results.map((entry) => entry.sessionId))
    assert.equal(parent.agent.model.current().model, PARENT)
    return { results, requests: observed, parentModel: PARENT, plan: plan.quality.checks.map((check) => check.check) }
  } finally {
    try { await service?.close() } finally { await parent.dispose() }
  }
}

async function main(binPath) {
  if (!binPath) throw new Error('Pass the installed dsh/lib/bin.js path.')
  const root = await mkdtemp(join(tmpdir(), 'orchestra-dsh-model-'))
  const received = []
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw)
    received.push(request.model)
    const base = { id: 'probe', object: 'chat.completion.chunk', created: 1, model: request.model }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const hasToolResult = request.messages.some((message) => message.role === 'tool')
    const available = request.tools?.map((tool) => tool.function.name) ?? []
    if (request.model !== PLANNER && !hasToolResult && !available.includes('orchestra_read_tool')) {
      res.end('data: [DONE]\n\n')
      return
    }
    const planner = request.model === PLANNER
    const plan = { title: '整理并独立复核', workflow_id: FLOW, workflow_version: '1',
      steps: NODES.map((node_id, index) => ({ node_id, description: index ? '独立复核' : '整理条目', goal_ids: ['goal', 'R1'],
        tools: ['ro.probe'], depends_on: index ? ['organize'] : [], complexity: index ? 'complex' : 'routine',
        model_reason: index ? '需要比较多项证据' : '仅整理已知条目' })),
      deliverables: [{ title: '已核对工具回执', node_id: 'compare', goal_ids: ['goal', 'R1'],
        acceptance: { kind: 'tool_evidence', tool: 'ro.probe', exit_code: 0 } }], risks: [] }
    const final = hasToolResult || planner
    const delta = final ? { role: 'assistant', content: planner ? JSON.stringify(plan) : '{"status":"done","output":{"ok":true}}' }
      : { role: 'assistant', tool_calls: [{ index: 0, id: 'call_probe', type: 'function',
        function: { name: 'orchestra_read_tool', arguments: '{"tool":"ro.probe","args":[]}' } }] }
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: final ? 'stop' : 'tool_calls' }]) {
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, ...choice }] }) + '\n\n')
    }
    res.end('data: [DONE]\n\n')
  })
  await new Promise((done) => provider.listen(0, '127.0.0.1', done))
  try {
    const patch = join(root, 'probe.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'headless-runner', disabled: true },
      { id: 'llm-pi-ai', config: { providers: { [PROVIDER]: {
        api: 'openai-completions', apiKeyEnv: 'ORCHESTRA_DSH_PROBE_KEY',
        baseURL: 'http://127.0.0.1:' + provider.address().port + '/v1',
        models: [ROUTINE, PREFERRED, COMPLEX, PARENT, PLANNER].map((id) => ({ id, contextWindow: 32768, maxTokens: 8192, input: ['text'] })),
      } } } },
      { insert: [{ id: name, name: self.replaceAll('\\', '/') }] },
    ]))
    const child = spawn(process.execPath, [resolve(binPath), '--profile', 'headless', '--patch', patch, 'Orchestra routing probe'], {
      cwd: root, windowsHide: true, env: { ...process.env, DSH_HOME: join(root, 'dsh'), ORCHESTRA_DSH_PROBE_KEY: 'loopback-fixture' },
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), 45_000)
    let status
    try {
      status = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    } finally { clearTimeout(timer) }
    assert.equal(status, 0, stderr + '\n' + stdout)
    const line = stdout.split(/\r?\n/).find((item) => item.startsWith('ORCHESTRA_DSH_PROBE '))
    assert.ok(line, stdout + '\n' + stderr)
    assert.deepEqual(received, [PLANNER, PREFERRED, PREFERRED, COMPLEX, COMPLEX])
    console.log(line)
    console.log('Provider HTTP requests: ' + received.join(', '))
  } finally {
    await new Promise((done) => provider.close(done))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === self) await main(process.argv[2])
