import { createHook } from 'node:async_hooks'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { createSseSubscribe } from '../src/client/api/sse-fetch.ts'
import { uuidv7 } from '../src/core/ids.ts'
import { BridgeClient, type BridgeTransport } from '../src/executor/bridge.ts'
import { ReadOnlyToolRunner, ToolRegistry } from '../src/executor/tools.ts'
import { serveOrchestra, type TrialOptions } from '../src/index.ts'
import { appendEvent } from '../src/infra/db/ledger.ts'
import { withTx, type Db, type observeSqlite } from '../src/infra/sqlite/driver.ts'
import { withReadTx } from '../src/service/queries/read-tx.ts'
import { fakeAgentBridge } from '../tests/fixtures/agent-bridge.ts'
import type { Counts, SoakEvent } from './soak-judge.ts'

const WORKFLOW = 's6_soak_read'
const TOOL = 'soak.fixture.read'
export const FIXTURE = 'sample.txt'
export const FIXTURE_CONTENT = 's6 synthetic read-only fixture v1\n'
export const DATABASE = 'ledger.db'
export const CONFIG = 'soak-config.json'

type Service = Awaited<ReturnType<typeof serveOrchestra>>
type Diagnostics = ReturnType<typeof observeSqlite>
type Received = Pick<SoakEvent, 'seq' | 'event_id' | 'type'> & { observedMs: number }

export function activeResources(): Record<string, number> {
  const handles: Record<string, number> = {}
  for (const name of process.getActiveResourcesInfo().sort()) handles[name] = (handles[name] ?? 0) + 1
  return handles
}

/** Including unref-ed maintenance and lock timers, whose IDs are released on destroy. */
export function observeTimers() {
  const timers = new Set<number>()
  const hook = createHook({ init(id, type) { if (type === 'Timeout') timers.add(id) }, destroy(id) { timers.delete(id) } })
  hook.enable()
  return { count: () => timers.size, stop: () => { hook.disable(); timers.clear() } }
}

export function diskBytes(path: string) {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0
}

export function spillBytes(directory: string) {
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) =>
    total + (entry.isFile() ? diskBytes(join(directory, entry.name)) : 0), 0)
}

export function localJson<T>(endpoint: string, route: string, secret: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const content = body === undefined ? undefined : JSON.stringify(body)
  const headers = { 'x-orchestra-secret': secret, connection: 'close',
    ...(content === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(content) }) }
  return new Promise<T>((resolve, reject) => {
    const req = request(endpoint + route, { agent: false, signal, headers, method: content === undefined ? 'GET' : 'POST' }, response => {
      let text = ''
      response.setEncoding('utf8').on('data', (chunk: string) => { text += chunk }).on('error', reject)
      response.on('end', () => {
        try {
          const value = JSON.parse(text) as { ok: boolean; data: T; error?: { code?: string, message?: string } }
          if (response.statusCode !== 200 || !value.ok) throw new Error(route + ' returned ' + response.statusCode
            + ' ' + (value.error?.code ?? '') + ' ' + (value.error?.message ?? ''))
          // Sample after the per-request HTTP socket has closed.
          if (req.socket && !req.socket.closed) req.socket.once('close', () => resolve(value.data))
          else resolve(value.data)
        } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(12_000, () => req.destroy(new Error(route + ' request timed out')))
    req.end(content)
  })
}

export async function startSoakService(directory: string, secret: string, signal: AbortSignal, fail: (error: Error) => void,
  options: { trial?: TrialOptions; serve?: typeof serveOrchestra } = {}) {
  const fixture = join(directory, 'workspace')
  const registry = new ToolRegistry()
  registry.register({ name: TOOL, capability: 'read_only', command: { bin: TOOL, args: [FIXTURE] } })
  const sessions = new Map<string, ReturnType<typeof fakeAgentBridge>>()
  const transport: BridgeTransport = {
    async request<T>(method: string, params: unknown): Promise<T> {
      if (method === 'executor.spawn') {
        const agentId = 'soak-' + (params as { nodeRunId: string }).nodeRunId
        const session = fakeAgentBridge({ agentId, steps: [{ tool: TOOL }], at: new Date().toISOString() })
        sessions.set(agentId, session)
        return session.request<T>(method, params)
      }
      const agentId = (params as { executorAgentId: string }).executorAgentId
      const session = sessions.get(agentId)
      if (!session) throw new Error('Unknown synthetic bridge session')
      const value = await session.request<T>(method, params)
      if (method === 'executor.dispose') sessions.delete(agentId)
      return value
    },
    listen(params, abort) {
      const session = sessions.get(params.executorAgentId)
      if (!session) throw new Error('Unknown synthetic bridge subscription')
      return session.listen(params, abort)
    },
  }
  const counts: Counts = { tasks: 0, runs: 0, nodes: 0, tools: 0, polls: 0 }
  const runner = new ReadOnlyToolRunner(registry, {
    readonlyAvailable: () => true,
    async run({ bin, args, cwd }) {
      if (bin !== TOOL || args.length !== 1 || args[0] !== FIXTURE || cwd !== fixture) throw new Error('Synthetic tool path escaped its fixture')
      const stdout = readFileSync(join(fixture, FIXTURE), 'utf8')
      if (stdout !== FIXTURE_CONTENT) throw new Error('Synthetic fixture changed')
      counts.tools++
      return { exitCode: 0, stdout, stderr: '' }
    },
  }, fixture)
  let service: Service | undefined
  let booted = false
  const role = 's6-soak-synthetic'
  service = await (options.serve ?? serveOrchestra)({
    dbFile: join(directory, DATABASE), phase: 'S6', secret,
    configPath: join(directory, CONFIG), spillDir: join(directory, 'spill'),
    ...(options.trial ? { trial: options.trial } : {}),
    executor: { registry, runner, bridge: new BridgeClient(transport) },
    asOfSeq: () => Number(service?.orchestra.db.raw.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()?.seq ?? 0),
    listTasks: () => { throw new Error('Production task query is unavailable') },
    listEvents: () => { throw new Error('Production event query is unavailable') },
    appendLedgerEvent: () => {
      if (!booted || signal.aborted) throw new Error('Soak probe writer is stopped')
      return withTx(service!.orchestra.db, tx => appendEvent(tx, { type: 's6.soak_probe', payload: { role } }))
    },
    log: { info() {}, warn() {}, error(message) { fail(new Error('Service error: ' + message)) } },
  })
  booted = true
  const endpoint = service.endpoint
  const json = <T>(route: string, body?: unknown) => localJson<T>(endpoint, route, secret, signal, body)
  async function run(index: number) {
    const started = await json<{ run_id: string; task_id: string; replayed: boolean }>('/v1/runs/start', {
      operationId: uuidv7(), taskTitle: 'S6 synthetic read ' + index, workflowId: WORKFLOW, workflowVersion: '1',
    })
    if (!started.task_id || !started.run_id || started.replayed) throw new Error('Synthetic task was not newly created')
    counts.tasks++
    counts.runs++
    const results = await json<{ node_run_id: string; status: string; reason?: string; error_code?: string }[]>('/v1/runs/dispatch', {
      runId: started.run_id,
      nodes: { read: { tools: [{ command: TOOL, args: [], cwd: '.', timeoutMs: 5_000 }], input: { sample: index }, outputSchema: {} } },
    })
    if (results.length !== 1 || results[0]?.status !== 'done') throw new Error('Synthetic node did not settle: ' + JSON.stringify(results))
    counts.nodes++
    return { runId: started.run_id, nodeRunId: results[0].node_run_id }
  }
  async function poll() {
    const result = await json<{ items: unknown[] }>('/v1/tasks?limit=5')
    if (!Array.isArray(result.items) || result.items.length < 1) throw new Error('Production panel task query is empty')
    counts.polls++
  }
  return {
    service, counts, sessions, role, run, poll,
    async finishInflight() {
      const pending = withReadTx(service!.orchestra.db, ({ tx }) => tx.all<{ runId: string }>(
        "SELECT run_id AS runId FROM runs WHERE status NOT IN ('succeeded','failed','succeeded_with_unverified',"
        + "'failed_with_unverified','orphaned','cancelled')"))
      for (const { runId } of pending) {
        await localJson(endpoint, '/v1/runs/cancel', secret, AbortSignal.timeout(5_000), { runId, cancelResult: 'unknown', graceMs: 0 })
      }
    },
    load: () => json('/v1/workflows/load', {
      workflow_id: WORKFLOW, workflow_version: '1',
      nodes: [{ node_id: 'read', type: 'agent', side_effect_policy: 'pure', tools: { allow: [TOOL], deny: [] } }],
    }),
    probe: () => json('/v1/ledger/events', {}),
  }
}

export async function startObserver(endpoint: string, secret: string, head: number, signal: AbortSignal,
  fail: (error: Error) => void) {
  const received = new Map<number, Received>()
  let lastSeq = head
  let active = 0
  const opened = Promise.withResolvers<void>()
  const subscribe = createSseSubscribe(fetch, endpoint, { headers: { 'x-orchestra-secret': secret } })
  const onLost = () => fail(new Error('Production SSE subscription was lost'))
  const unsubscribe = subscribe(head, event => {
    if (event.seq !== lastSeq + 1) { fail(new Error('Production SSE is not contiguous')); return }
    lastSeq = event.seq
    received.set(event.seq, { ...event, observedMs: performance.now() })
  }, onLost, onLost, () => { active = 1; opened.resolve() })
  const stop = () => { unsubscribe(); active = 0 }
  const timeout = new AbortController()
  const cancelled = AbortSignal.any([signal, timeout.signal])
  try {
    await Promise.race([opened.promise, sleep(10_000, undefined, { signal: cancelled, ref: false }).then(() => {
      throw new Error('Production SSE subscription did not open')
    })])
  } catch (error) { stop(); throw error } finally { timeout.abort() }
  async function rows(db: Db, from: number, through: number, diagnostics: Diagnostics, slot: number): Promise<SoakEvent[]> {
    const commitBySeq = new Map<number, number>()
    for (const commit of diagnostics.drainCommits()) {
      for (let seq = commit.from; seq <= commit.to; seq++) commitBySeq.set(seq, commit.atMs)
    }
    const events = withReadTx(db, ({ tx }) => tx.all<Pick<SoakEvent, 'seq' | 'type' | 'event_id'>>(
      'SELECT seq, type, event_id FROM events WHERE seq>? AND seq<=? ORDER BY seq', [from, through]))
    if (events.length !== through - from) throw new Error('Committed ledger sequence is not contiguous')
    return events.map(event => {
      const observed = received.get(event.seq)
      received.delete(event.seq)
      if (observed && (observed.event_id !== event.event_id || observed.type !== event.type)) {
        throw new Error('SSE disagrees with the ledger')
      }
      const committedMs = commitBySeq.get(event.seq)
      if (committedMs === undefined) throw new Error('Missing measured commit timestamp for sequence ' + event.seq)
      commitBySeq.delete(event.seq)
      return { ...event, slot, committedMs, observedMs: observed?.observedMs ?? null }
    })
  }
  return { active: () => active, stop, rows, unconsumed: () => received.size }
}

export async function assertPortReleased(endpoint: string) {
  try {
    await localJson(endpoint, '/v1/tasks', '', AbortSignal.timeout(1_000))
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ECONNREFUSED'
  }
}

export function sidecarsReleased(dbFile: string) {
  return ['-wal', '-shm', '-journal'].every(suffix => !existsSync(dbFile + suffix))
}
