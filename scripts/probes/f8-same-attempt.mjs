// Node runner for the installed Desktop rc.5 CLI. Provider and profile are isolated.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { uuidv7 } from '../../src/core/ids.ts'

const self = fileURLToPath(import.meta.url)
const provider = 'f8-local-fixture'
const model = 'f8-local-model'
const tool = 'f8_fixture_tool'
const initialTimeoutMs = 3000
export const name = 'orchestra-f8-proof'
export const inject = ['appExit', 'agents', 'tools', 'llm']

export function apply(ctx) {
  void verify(ctx).then((proof) => {
    console.log('ORCHESTRA_F8_PROOF ' + JSON.stringify(proof))
    ctx.get('appExit')(0)
  }, (error) => {
    console.error(error?.stack ?? error)
    ctx.get('appExit')(1)
  })
}

async function until(read) {
  for (let attempts = 0; attempts < 300; attempts += 1) {
    const value = await read()
    if (value) return value
    await delay(50)
  }
  throw new Error('Timed out while waiting for the native execution checkpoint')
}

async function verify(ctx) {
  const entry = process.env.ORCHESTRA_F8_ENTRY
  const { serveDshOrchestra, ToolRegistry, ReadOnlyToolRunner, sweepNow } = await import(entry
    ? pathToFileURL(entry).href : '../../lib/index.js')
  const { version } = JSON.parse(await readFile(join(process.env.ORCHESTRA_F8_SDK, 'dsh/package.json'), 'utf8'))
  assert.equal(version, '0.2.2-rc.5')
  const cwd = process.cwd()
  const secret = randomUUID()
  const parent = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd }, agentOptions: { provider, model } })
  let toolRuns = 0
  const registry = new ToolRegistry()
  registry.register({ name: tool, capability: 'read_only', command: { bin: 'fixture', args: [] } })
  const runner = new ReadOnlyToolRunner(registry, { readonlyAvailable: () => true, async run() {
    toolRuns += 1
    return { exitCode: 0, stdout: 'synthetic measurement', stderr: '' }
  } }, cwd)
  const service = await serveDshOrchestra({
    dbFile: join(cwd, 'orchestra.sqlite'), secret, phase: 'S6', tools: { registry, runner },
    resolveHttpHuman: (req) => req.headers['x-f8-operator'] === 'yes' ? { id: 'human:f8-fixture' } : null,
    dsh: { context: ctx, parentForNode: () => parent.agent,
      models: [{ ref: 'f8/model', capacity: 'routine', provider, model }],
      recommend: () => ({ complexity: 'routine', reason: 'Approved fixture' }) },
    asOfSeq: () => 0, listTasks: () => [], listEvents: () => [], appendLedgerEvent: () => {},
  })
  const db = service.orchestra.db
  const call = async (path, body) => {
    const response = await fetch(new URL(path, service.endpoint), { headers: { 'x-orchestra-secret': secret,
      'x-f8-operator': 'yes', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
    const envelope = await response.json()
    if (!envelope.ok) throw Object.assign(new Error(path + ' ' + JSON.stringify(envelope.error)), envelope.error)
    return envelope.data
  }
  const card = (runId, kind) => db.raw.prepare(`SELECT decision_id,revision FROM decisions WHERE run_id=?
    AND kind=? AND status IN ('pending','acknowledged','blocked_for_human')`).get(runId, kind)
  const choice = async (runId, kind, resolution) => until(async () => {
    sweepNow(service.orchestra.runtime, new Date().toISOString())
    const current = card(runId, kind)
    if (!current) return
    const view = await call('/v1/decisions/get?decision_id=' + current.decision_id)
    if (view.allowed_resolutions.includes(resolution)) return current
  })
  const resolveCard = (current, resolution, payload) => call('/v1/decisions/resolve', {
    decisionId: current.decision_id, revision: current.revision, operation_id: uuidv7(), resolution, payload,
  })
  const state = (nodeId) => db.raw.prepare(`SELECT node_run_id,status,lease_id,executor_agent_id,executor_session_id,
    action_generation,rearm_generation,attempt,wait_extensions,action_start_source FROM node_runs WHERE node_run_id=?`).get(nodeId)
  const release = (mode) => fetch(process.env.ORCHESTRA_F8_PROVIDER + '/release/' + mode)
  try {
    await call('/v1/settings/execution-capacity', { operation_id: uuidv7(), expected_revision: 0,
      values: { concurrency: 1, max_waiting: 8, action_timeout_ms: initialTimeoutMs } })
    const workflowId = 'f8_native'
    const title = 'F8 same-attempt native verification'
    const draft = await call('/v1/workflows', { workflow_id: workflowId, name: title, operation_id: uuidv7(), definition: {
      name: title, nodes: [{ node_id: 'start', type: 'trigger', title: 'Start', position: { x: 0, y: 0 } },
        { node_id: 'work', type: 'agent', title: 'Work', position: { x: 200, y: 0 },
          config: { side_effect_policy: 'pure', tools: { allow: [tool] }, pass_conditions: [{ path: 'evidence.exitCode', op: 'eq', value: 0 }] } },
        { node_id: 'after', type: 'agent', title: 'After', position: { x: 400, y: 0 }, config: { tools: { allow: [tool] } } }],
      edges: [{ from: 'start', to: 'work' }, { from: 'work', to: 'after' }],
    } })
    assert.equal((await call('/v1/workflows/test', { workflow_id: workflowId, revision: draft.revision })).passed, true)
    await call('/v1/workflows/publish', { workflow_id: workflowId, base_version: 0, revision: draft.revision,
      publish_note: 'Native observation proof', operation_id: uuidv7() })
    const launch = async (mode, { leaseTtlMs } = {}) => {
      const { run_id } = await call('/v1/runs/start', { workflowId, workflowVersion: '1', taskTitle: title, operationId: uuidv7() })
      const { node_run_id } = (await call('/v1/node-runs?run_id=' + run_id)).items.find(({ node_id }) => node_id === 'work')
      const execution = call('/v1/node-runs/run', { nodeRunId: node_run_id, nodeId: 'work', attempt: 1,
        ownerEpoch: db.epoch, leaseTtlMs, input: { f8_mode: mode }, outputSchema: { type: 'object' },
        tools: [{ command: tool, args: [], cwd, timeoutMs: 5000 }],
      }).then((result) => ({ result }), (error) => ({ error: error.code }))
      await until(async () => {
        const response = await fetch(process.env.ORCHESTRA_F8_PROVIDER + '/held/' + mode)
        return response.ok
      })
      return { nodeRunId: node_run_id, runId: run_id, execution }
    }
    const tracked = await launch('tracked')
    const original = state(tracked.nodeRunId)
    assert.equal(original.status, 'started')
    const overrun = await choice(tracked.runId, 'action_overrun', 'continue_wait')
    assert.equal(state(tracked.nodeRunId).lease_id, null)
    await resolveCard(overrun, 'continue_wait')
    assert.equal(state(tracked.nodeRunId).wait_extensions, 1)
    const renewed = await choice(tracked.runId, 'action_overrun', 'continue_wait')
    assert.equal(renewed.decision_id, overrun.decision_id)
    assert.equal(renewed.revision, overrun.revision + 1)
    await resolveCard(renewed, 'abandon')
    assert.equal(state(tracked.nodeRunId).status, 'abandoned_unverified')
    const ack = await choice(tracked.runId, 'abandon_ack', 'rejected')
    await resolveCard(ack, 'rejected')
    const resumed = state(tracked.nodeRunId)
    assert.equal(resumed.status, 'stopping')
    assert.equal(resumed.lease_id, null)
    assert.equal(resumed.executor_session_id, original.executor_session_id)
    assert.equal(resumed.attempt, original.attempt)
    assert.equal(resumed.action_generation, original.action_generation)
    const finalOverrun = await choice(tracked.runId, 'action_overrun', 'continue_wait')
    assert.equal((await release('tracked')).status, 200)
    const completed = await tracked.execution
    assert.equal(completed.result?.final_status, 'done', JSON.stringify(completed))
    assert.equal(db.raw.prepare('SELECT status FROM node_runs WHERE run_id=? AND node_id=?').get(tracked.runId, 'after').status, 'queued')
    assert.equal(db.raw.prepare('SELECT status FROM decisions WHERE decision_id=?').get(finalOverrun.decision_id).status, 'resolved')
    assert.equal(db.raw.prepare(`SELECT count(*) AS n FROM node_run_events WHERE node_run_id=? AND type='recovery.host_stopped'`)
      .get(tracked.nodeRunId).n, 1)
    assert.equal(toolRuns, 1)

    const fenced = await launch('fenced')
    const unknown = await choice(fenced.runId, 'startup_unknown', 'continue_tracking')
    await resolveCard(unknown, 'continue_tracking')
    const confirmed = await choice(fenced.runId, 'startup_unknown', 'confirm_started')
    await resolveCard(confirmed, 'confirm_started')
    assert.equal(state(fenced.nodeRunId).action_start_source, 'human_confirmed')
    assert.equal(state(fenced.nodeRunId).lease_id, null)
    assert.equal((await release('fenced')).status, 200)
    assert.notEqual((await fenced.execution).result?.final_status, 'done')
    assert.notEqual(state(fenced.nodeRunId).status, 'done')
    assert.equal(toolRuns, 1)

    const attested = await launch('attested')
    const attestation = await choice(attested.runId, 'startup_unknown', 'confirm_started_attested')
    await resolveCard(attestation, 'confirm_started_attested', { attestation_id: 'att_f8_native' })
    assert.equal(state(attested.nodeRunId).action_start_source, 'human_attested')
    const attestationRow = db.raw.prepare('SELECT action_start_source,attempt FROM attestations WHERE attestation_id=?').get('att_f8_native')
    assert.equal(attestationRow.action_start_source, 'human_attested')
    assert.equal(attestationRow.attempt, 1)
    assert.equal((await release('attested')).status, 200)
    assert.notEqual((await attested.execution).result?.final_status, 'done')
    assert.equal(toolRuns, 1)

    const toolConfirmed = await launch('tool_confirmed', { leaseTtlMs: 1500 })
    const startCard = await choice(toolConfirmed.runId, 'startup_unknown', 'confirm_started')
    await resolveCard(startCard, 'confirm_started')
    assert.equal(state(toolConfirmed.nodeRunId).action_start_source, 'human_confirmed')
    const rule = db.raw.prepare(`SELECT json_extract(payload,'$.rule_id') AS rule_id FROM node_run_events
      WHERE node_run_id=? AND type='decision.recovery_resolved'`).get(toolConfirmed.nodeRunId)
    assert.equal(rule.rule_id, 'M-61')
    assert.equal((await release('tool_confirmed')).status, 200)
    assert.equal((await toolConfirmed.execution).result?.final_status, 'done')
    assert.equal(toolRuns, 2)
    return { version, rules: ['M-08', 'M-09', 'M-34', 'M-36', 'M-37', 'M-57', 'M-61'], same_session: true,
      original_tool_executions: toolRuns, post_deadline_tool_executions: 0, tracked_final_status: 'done' }
  } finally {
    await Promise.all(['tracked', 'fenced', 'attested', 'tool_confirmed'].map((mode) => release(mode).catch(() => undefined)))
    await service.close()
    await parent.dispose()
  }
}

async function main(desktop, output, entry) {
  assert(desktop && output, 'Pass the DSH Desktop install directory and an empty proof output directory.')
  const sdk = join(resolve(desktop), 'resources/app.asar/dsh/node_modules/@deepseek-ai')
  const cwd = resolve(output)
  await mkdir(cwd, { recursive: true })
  assert.deepEqual(await readdir(cwd), [])
  const received = []
  const held = new Map()
  const server = createServer(async (req, res) => {
    const route = /^\/(held|release)\/(tracked|fenced|attested|tool_confirmed)$/.exec(req.url)
    if (route) {
      const release = held.get(route[2])
      if (!release) { res.writeHead(404).end(); return }
      if (route[1] === 'release') { held.delete(route[2]); release() }
      res.writeHead(200).end()
      return
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const mode = /"f8_mode"\s*:\s*"(tracked|fenced|attested|tool_confirmed)"/u.exec(body.messages.map(({ content }) => content).join('\n'))?.[1]
    const calls = received.filter((item) => item === mode).length
    received.push(mode)
    const askTool = calls === 0
    const send = () => {
      const id = randomUUID()
      const delta = askTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'f8_tool_call', type: 'function',
        function: { name: 'orchestra_read_tool', arguments: JSON.stringify({ tool, args: [] }) } }] }
        : { role: 'assistant', content: '{"status":"done","output":{"verified":true}}' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: askTool ? 'tool_calls' : 'stop' }]) {
        res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, ...choice }] }) + '\n\n')
      }
      res.end('data: [DONE]\n\n')
    }
    const holdAfterTool = mode === 'tracked' || mode === 'tool_confirmed'
    if (calls === (holdAfterTool ? 1 : 0)) held.set(mode, send)
    else send()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port
    const patch = join(cwd, 'probe.patch.yml')
    await writeFile(patch, JSON.stringify([{ id: 'headless-runner', disabled: true },
      { id: 'llm-pi-ai', config: { providers: { [provider]: { api: 'openai-completions', apiKeyEnv: 'ORCHESTRA_F8_KEY',
        baseURL: endpoint + '/v1', models: [{ id: model, contextWindow: 32768, maxTokens: 8192, input: ['text'] }] } } } },
      { insert: [{ id: name, name: self.replaceAll('\\', '/') }] },
    ]))
    const run = await promisify(execFile)(join(resolve(desktop), 'DeepSeek Harness.exe'),
      ['--expose-internals', join(sdk, 'dsh/lib/bin.js'), '--profile', 'headless', '--patch', patch, 'F8 native fixture'], {
        cwd, timeout: 70000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: join(cwd, 'profile'),
          ORCHESTRA_F8_KEY: 'loopback-fixture', ORCHESTRA_F8_PROVIDER: endpoint, ORCHESTRA_F8_SDK: sdk,
          ...(entry ? { ORCHESTRA_F8_ENTRY: resolve(entry) } : {}) },
      }).catch((error) => { throw new Error([error.message, error.stdout, error.stderr].join('\n'), { cause: error }) })
    await writeFile(join(cwd, 'native.log'), run.stdout + '\n' + run.stderr)
    const line = run.stdout.split(/\r?\n/u).find((value) => value.startsWith('ORCHESTRA_F8_PROOF '))
    assert(line, run.stdout + '\n' + run.stderr)
    assert.deepEqual(received, ['tracked', 'tracked', 'fenced', 'fenced', 'attested', 'attested', 'tool_confirmed', 'tool_confirmed'])
    console.log(line)
  } finally {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === self) await main(...process.argv.slice(2))
