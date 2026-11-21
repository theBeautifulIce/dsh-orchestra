// Run with Node and the rc.5 Desktop installation directory. Only a loopback model is used.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'

const self = fileURLToPath(import.meta.url)
const providerId = 'wf23-local-fixture'
const plannerModel = 'wf23-brain-model'
const executorModel = 'wf23-executor-model'
const operator = 'human:wf23-fixture'
const shared = 'Fixture visible to this run'
const downstream = 'Fixture only visible to direct successor'
const toolName = 'wf23_fixture'
const privateReview = '审阅主脑专属便条'
const plainReview = '查看运行便条'
export const name = 'orchestra-wf23-proof'
export const inject = ['appExit', 'agents', 'tools', 'llm', 'systemPrompt', 'sessionQuery', 'sessionPersistence', 'attachments', 'sessions']

export function apply(ctx) {
  void verify(ctx).then((proof) => {
    console.log('ORCHESTRA_WF23_PROOF ' + JSON.stringify(proof))
    ctx.get('appExit')(0)
  }, (error) => {
    console.error(error?.stack ?? error)
    ctx.get('appExit')(1)
  })
}

function zipContents(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert(end >= 0, 'native ZIP has an end-of-directory record')
  let position = zip.readUInt32LE(end + 16)
  return Array.from({ length: zip.readUInt16LE(end + 10) }, () => {
    assert.equal(zip.readUInt32LE(position), 0x02014b50)
    const method = zip.readUInt16LE(position + 10)
    const size = zip.readUInt32LE(position + 20)
    const nameLength = zip.readUInt16LE(position + 28)
    const entry = zip.subarray(position + 46, position + 46 + nameLength).toString()
    const local = zip.readUInt32LE(position + 42)
    assert.equal(zip.readUInt32LE(local), 0x04034b50)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const payload = zip.subarray(start, start + size)
    assert([0, 8].includes(method))
    position += 46 + nameLength + zip.readUInt16LE(position + 30) + zip.readUInt16LE(position + 32)
    return { entry, body: (method === 8 ? inflateRawSync(payload) : payload).toString() }
  })
}

async function verify(ctx) {
  const { serveDshOrchestra, ToolRegistry, ReadOnlyToolRunner } = await import('../../src/index.ts')
  const { installNativeChat } = await import('../../src/service/chat-native.ts')
  const { uuidv7 } = await import('../../src/core/ids.ts')
  const sdk = process.env.ORCHESTRA_WF23_SDK
  const archive = await import(pathToFileURL(join(sdk, 'dsh-session-log-export/lib/index.js')).href)
  const { version } = JSON.parse(await readFile(join(sdk, 'dsh/package.json'), 'utf8'))
  assert.equal(version, '0.2.2-rc.5')
  const cwd = process.cwd()
  const canary = process.env.ORCHESTRA_WF23_CANARY
  const secret = randomUUID()
  const clean = (input) => assert(!JSON.stringify(input).includes(canary), 'private canary leaked to an ordinary surface')
  const root = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd }, agentOptions: { provider: providerId, model: plannerModel } })
  const otherRoot = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd }, agentOptions: { provider: providerId, model: plannerModel } })
  const sessions = new Map()
  const directCalls = []
  ctx.on('llm/stream', (request, next) => {
    const marker = request.system?.match(/ORCHESTRA_PRIVATE_NOTE_(CAPTURE|REVIEW)/u)?.[1]
    if (marker) {
      assert.equal(request.sessionId, undefined)
      assert.deepEqual(request.tools, [])
      directCalls.push({ marker, model: request.model, session_id: null, tool_count: 0 })
    }
    return next()
  })
  const registry = new ToolRegistry()
  registry.register({ name: toolName, capability: 'read_only', command: { bin: 'fixture', args: [] } })
  const runner = new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true, async run() {
    return { exitCode: 0, stdout: 'synthetic measurement', stderr: '' }
  } }, cwd)
  const stop = new AbortController()
  let service
  try {
    service = await serveDshOrchestra({
      dbFile: join(cwd, 'orchestra.sqlite'), secret, phase: 'S6', tools: { registry, runner },
      resolveHttpHuman: (req) => ({ id: req.headers['x-wf23-operator'] === 'yes' ? operator : 'human:wf23-other' }),
      dshPlanner: { parent: () => root.agent, model: { provider: providerId, model: plannerModel } },
      dsh: { context: ctx, parentForNode: () => root.agent, onModelUse: (use) => sessions.set(use.nodeRunId, use.sessionId),
        models: [{ ref: 'wf23/executor', capacity: 'routine', provider: providerId, model: executorModel }],
        recommend: () => ({ complexity: 'routine', reason: 'Approved fixture' }) },
      asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => {},
    })
    assert.equal(typeof service.reviewBrainNotes, 'function')
    installNativeChat(ctx, {
      operator, signal: stop.signal, autoRouteEnabled: () => false, hasService: () => true,
      bindingFor(agent) {
        return agent === root.agent ? { identity: 'wf23-root', workspaceId: 'wf23-workspace', sessionId: agent.session.id } : undefined
      },
      async serviceFor() { return service },
    })
    async function call(path, body, owner = true) {
      const response = await fetch(new URL(path, service.endpoint), { headers: { 'x-orchestra-secret': secret,
        'x-wf23-operator': owner ? 'yes' : 'no', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
      const envelope = await response.json()
      clean(envelope)
      if (!envelope.ok) throw Object.assign(new Error(path + ' ' + JSON.stringify(envelope.error)), envelope.error)
      return envelope.data
    }
    const wf = 'wf23_native'
    const nodeIds = ['source', 'direct', 'indirect', 'sibling']
    const title = 'WF23 native verification'
    const draft = await call('/v1/workflows', { workflow_id: wf, name: title, operation_id: uuidv7(), definition: {
      name: title, nodes: [{ node_id: 'start', type: 'trigger', title: 'Start', position: { x: 0, y: 0 } },
        ...nodeIds.map((node_id, i) => ({ node_id, type: 'agent', title: node_id, position: { x: 200 * i, y: 100 },
          config: { side_effect_policy: 'pure', tools: { allow: [toolName] }, pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }] } }))],
      edges: [{ from: 'start', to: 'source' }, { from: 'source', to: 'direct' }, { from: 'direct', to: 'indirect' }, { from: 'start', to: 'sibling' }],
    } })
    assert.equal((await call('/v1/workflows/test', { workflow_id: wf, revision: draft.revision })).passed, true)
    await call('/v1/workflows/publish', { workflow_id: wf, base_version: 0, revision: draft.revision,
      publish_note: 'WF23 privacy fixture', operation_id: uuidv7() })
    const db = service.orchestra.db.raw
    const start = async (taskTitle) => {
      const operationId = uuidv7()
      const { run_id } = await call('/v1/runs/start', { workflowId: wf, workflowVersion: '1', taskTitle, operationId })
      return { run_id, operationId }
    }
    const first = await start(title)
    const other = await start('WF23 cross-run fixture')
    const runNode = async (run, nodeId, probe_phase = nodeId) => {
      const node = (await call('/v1/node-runs?run_id=' + run.run_id)).items.find(({ node_id }) => node_id === nodeId)
      const result = await call('/v1/node-runs/run', { nodeRunId: node.node_run_id, nodeId, attempt: node.attempt,
        input: { probe_phase }, outputSchema: { type: 'object' }, tools: [{ command: toolName, args: [], cwd, timeoutMs: 5000 }],
        ownerEpoch: service.orchestra.db.epoch, leaseTtlMs: 30000 })
      assert.equal(result.final_status, 'done', JSON.stringify(result))
      return node.node_run_id
    }
    const writerNode = await runNode(first, 'source')
    for (const nodeId of nodeIds.slice(1)) await runNode(first, nodeId)
    await runNode(other, 'source', 'cross_run')
    assert.deepEqual(db.prepare('SELECT b.body FROM run_note_bodies b JOIN events e ON e.seq=b.event_seq WHERE e.run_id=? ORDER BY e.seq')
      .all(first.run_id).map(({ body }) => body), [shared, downstream, canary])
    assert.deepEqual((await call('/v1/run-notes?run_id=' + first.run_id)).items.map(({ body }) => body), [shared])
    await assert.rejects(call('/v1/run-notes?run_id=' + first.run_id, undefined, false), { code: 'FORBIDDEN' })
    await call('/v1/events?limit=200')
    clean(db.prepare('SELECT payload_redacted FROM events WHERE run_id=?').all(first.run_id))
    const attach = ({ operationId }) => {
      const plan = 'wf23:' + operationId
      const now = new Date().toISOString()
      db.prepare("INSERT INTO task_plans(plan_id,created_by,input_json,proposal_json,quality_json,workflow_hash,content_hash,launch_operation_id,created_at) VALUES (?,?,'{}','{}','{}',NULL,?,?,?)")
        .run(plan, operator, 'synthetic', operationId, now)
      db.prepare("INSERT INTO chat_task_receipts(message_key,request_key,input_hash,plan_id,reported_key) VALUES (?,?,?,?,'terminal:fixture')")
        .run('message:' + plan, 'request:' + plan, 'synthetic', plan)
    }
    attach(first)
    attach(other)
    await assert.rejects(service.reviewBrainNotes(otherRoot.agent, first.run_id, operator, stop.signal, () => {}), { code: 'FORBIDDEN' })
    await assert.rejects(service.reviewBrainNotes(root.agent, first.run_id, 'human:wf23-other', stop.signal, () => {}), { code: 'FORBIDDEN' })
    assert.deepEqual(await service.reviewBrainNotes(root.agent, other.run_id, operator, stop.signal, () => {}),
      { classification: 'insufficient', evidence_strength: 'none' })
    const messages = [plainReview + ' ' + title, privateReview + ' ' + title, privateReview + ' ' + title, privateReview + ' ' + title]
    for (const text of messages) {
      root.agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: randomUUID() },
        content: [{ type: 'text', text }] })
      await root.agent.whenIdle()
    }
    const parentEvents = root.agent.session.snapshotEvents()
    const rootTools = parentEvents.filter(({ type }) => type === 'tool/result')
    const resultText = rootTools.flatMap(({ data }) => data.message.content.map(({ text }) => text)).join('\n')
    assert.match(resultText, /专属便条建议人工关注/)
    assert.equal((resultText.match(/Orchestra 暂时无法完成这项操作/gu) ?? []).length, 2)
    assert.match(resultText, /Fixture visible to this run/)
    clean(parentEvents)
    const writerSession = sessions.get(writerNode)
    assert(writerSession)
    const exportDeps = archive.sessionLogExportDeps(ctx)
    const exports = []
    for (const [kind, sessionId, descendants] of [['main_brain', root.agent.session.id, true], ['writer', writerSession, false]]) {
      await archive.flushLiveSessionLog(exportDeps, sessionId, stop.signal)
      const persisted = await archive.readSessionLogText(exportDeps.sessionPersistence, sessionId, stop.signal)
      clean(persisted)
      const action = kind === 'writer' ? 'capture_brain' : 'review_brain_notes'
      const privateCalls = persisted.trim().split('\n').map((entry) => JSON.parse(entry)).flatMap(({ type, data }) =>
        type === 'tool/call' && ['orchestra_task', 'orchestra_run_notes'].includes(data.name)
          && JSON.parse(data.arguments).action === action ? [JSON.parse(data.arguments)] : [])
      assert.deepEqual(privateCalls, Array.from({ length: kind === 'writer' ? 1 : 3 }, () => ({ action })))
      await writeFile(join(cwd, `${kind}.session.jsonl`), persisted)
      const stream = archive.streamSessionLogZip(exportDeps, persisted, sessionId, descendants, 6, stop.signal)
      const zip = Buffer.from(await new Response(stream).arrayBuffer())
      const entries = zipContents(zip)
      clean(entries)
      await writeFile(join(cwd, `${kind}.zip`), zip)
      exports.push({ kind, session_id: sessionId, entries: entries.map(({ entry }) => entry) })
    }
    assert.equal(exports[0].entries.filter((entry) => entry.startsWith('subagents/')).length, sessions.size)
    assert.deepEqual(directCalls, [{ marker: 'CAPTURE', model: executorModel, session_id: null, tool_count: 0 },
      ...Array.from({ length: 3 }, () => ({ marker: 'REVIEW', model: plannerModel, session_id: null, tool_count: 0 }))])
    const workflowStatus = (await call('/v1/runs/get?run_id=' + first.run_id)).status
    assert.equal(workflowStatus, 'succeeded')
    return { version, run_id: first.run_id, workflow_status: workflowStatus,
      scopes: { operator: ['run'], direct: ['downstream', 'run'], indirect: ['run'], sibling: ['run'], other_run: [] },
      direct_calls: directCalls, independent_root_denied: true, other_operator_denied: true, capture_recorded_without_body: true,
      normal_chat_model_received_private_body: false, raw_ledger_received_private_body: false,
      persisted_private_body: false, native_zip_private_body: false, model_echo_and_provider_failure_rejected: true, exports }
  } finally {
    stop.abort()
    await service?.close()
    await Promise.all([root.dispose(), otherRoot.dispose()])
  }
}

function parseTool(message) {
  const text = Array.isArray(message.content) ? message.content.map(({ text }) => text ?? '').join('') : message.content
  const result = JSON.parse(text)
  return typeof result.text === 'string' && result.text.startsWith('{') ? JSON.parse(result.text) : result
}

async function main(desktop, output) {
  assert(desktop && output, 'Pass the DSH Desktop install directory and an empty proof output directory.')
  const sdk = join(resolve(desktop), 'resources/app.asar/dsh/node_modules/@deepseek-ai')
  const cli = join(sdk, 'dsh/lib/bin.js')
  const cwd = resolve(output)
  await mkdir(cwd, { recursive: true })
  assert.deepEqual(await readdir(cwd), [], 'Use an empty proof directory')
  const canary = 'WF23-DISTINCT-' + randomUUID()
  const providerInputs = []
  const failures = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const request = JSON.parse(raw)
      const texts = request.messages.map(({ content }) => content)
      const isCapture = texts.some((msg) => typeof msg === 'string' && msg.startsWith('ORCHESTRA_PRIVATE_NOTE_CAPTURE'))
      const isReview = texts.some((msg) => typeof msg === 'string' && msg.startsWith('ORCHESTRA_PRIVATE_NOTE_REVIEW'))
      const phase = /"probe_phase"\s*:\s*"(source|direct|indirect|sibling|cross_run)"/u.exec(texts.join('\n'))?.[1]
      const marker = isCapture ? 'capture' : isReview ? 'review' : phase ?? 'main_brain'
      providerInputs.push({ marker, request })
      let tool, value
      if (isCapture || isReview) {
        assert.equal(request.tools?.length ?? 0, 0)
        assert.equal(request.model, isCapture ? executorModel : plannerModel)
        assert.equal(raw.includes(canary), isReview)
        if (isCapture) {
          const material = JSON.parse(request.messages.at(-1).content)
          assert.match(material.instruction, /"probe_phase"\s*:\s*"source"/u)
          assert.doesNotMatch(material.instruction, /cross_run|"probe_phase"\s*:\s*"sibling"/u)
          value = { body: canary }
        }
        else {
          assert.deepEqual(JSON.parse(request.messages.at(-1).content), [canary])
          const reviewNumber = providerInputs.filter(({ marker }) => marker === 'review').length
          if (reviewNumber === 3) { res.writeHead(400).end(JSON.stringify({ error: { message: canary } })); return }
          value = reviewNumber === 1 ? { classification: 'follow_up' } : { classification: 'follow_up', echo: canary }
        }
      } else if (phase) {
        assert(!raw.includes(canary))
        const replies = request.messages.filter(({ role }) => role === 'tool').map(parseTool)
        const capture = ['orchestra_run_notes', { action: 'capture_brain' }]
        const measure = ['orchestra_read_tool', { tool: toolName, args: [] }]
        const steps = phase === 'source' ? [['orchestra_run_notes', { action: 'add', scope: 'run', body: shared }],
          ['orchestra_run_notes', { action: 'add', scope: 'downstream', body: downstream }], capture, measure]
          : [['orchestra_run_notes', { action: 'list' }], measure]
        if (phase === 'source' && replies.length >= 3) assert.equal(replies[2].captured, true)
        if (phase !== 'source' && replies.length) assert.deepEqual(replies[0].items.map(({ body }) => body),
          phase === 'direct' ? [downstream, shared] : phase === 'cross_run' ? [] : [shared])
        tool = steps[replies.length]
        value = { status: 'done', output: { ok: true } }
      } else {
        assert(!raw.includes(canary))
        const start = request.messages.findLastIndex(({ role, content }) => role === 'user' && typeof content === 'string'
          && (content.startsWith(privateReview) || content.startsWith(plainReview)))
        if (start !== -1) {
          const replies = request.messages.slice(start + 1).filter(({ role }) => role === 'tool')
          if (!replies.length) tool = ['orchestra_task', { action: 'status', task_title: 'WF23 native verification' }]
          else if (replies.length === 1) tool = ['orchestra_task', { action: request.messages[start].content.startsWith(privateReview) ? 'review_brain_notes' : 'notes' }]
        }
        value = '已完成便条查询。'
      }
      if (tool) assert(request.tools?.some(({ function: fn }) => fn.name === tool[0]), 'expected native tool ' + tool[0])
      const id = randomUUID()
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
        function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] } : { role: 'assistant', content: JSON.stringify(value) }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }]) {
        res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, ...choice }] }) + '\n\n')
      }
      res.end('data: [DONE]\n\n')
    } catch (error) {
      failures.push(String(error))
      res.writeHead(400).end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const patch = join(cwd, 'probe.patch.yml')
    await writeFile(patch, JSON.stringify([{ id: 'headless-runner', disabled: true }, { id: 'llm-pi-ai', config: { providers: {
      [providerId]: { api: 'openai-completions', apiKeyEnv: 'ORCHESTRA_WF23_KEY', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1',
        models: [plannerModel, executorModel].map((id) => ({ id, contextWindow: 32768, maxTokens: 8192, input: ['text'] })) },
    } } }, { insert: [{ id: name, name: self.replaceAll('\\', '/') }] }]))
    const run = await promisify(execFile)(join(resolve(desktop), 'DeepSeek Harness.exe'), ['--expose-internals', cli, '--profile', 'headless', '--patch', patch, 'WF23 fixture'], {
      cwd, timeout: 95000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: join(cwd, 'profile'),
        ORCHESTRA_WF23_KEY: 'loopback-fixture', ORCHESTRA_WF23_CANARY: canary, ORCHESTRA_WF23_SDK: sdk },
    }).catch((error) => { throw new Error([error.message, error.stdout, error.stderr, ...failures].join('\n'), { cause: error }) })
    await writeFile(join(cwd, 'native.log'), run.stdout + '\n' + run.stderr)
    const line = run.stdout.split(/\r?\n/u).find((line) => line.startsWith('ORCHESTRA_WF23_PROOF '))
    assert(line, run.stdout + '\n' + run.stderr)
    assert.deepEqual(failures, [])
    console.log(line)
  } finally {
    await writeFile(join(cwd, 'provider-wire.json'), JSON.stringify({ synthetic: true, canary, requests: providerInputs, failures }, null, 2))
    await new Promise((done) => server.close(done))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === self) await main(process.argv[2], process.argv[3])
